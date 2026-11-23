// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	core,
	freshSandbox,
	live,
	registerSession,
	store,
} from "./arbiter-testkit";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";
import { runCore, splitCheckout } from "./guard-core-testkit";
import { REAL_RUFF } from "./ruff-testkit";

const { readRuleText } = require("./rule-text") as {
	readRuleText: (id: string) => string;
};

const sb = freshSandbox();
const REL = "scripts/demo.js";

function fakeBiome(
	sandbox: { repo: string },
	body = '#!/bin/sh\nf="$4"\nprintf \'formatted\\n\' > "$f"\n',
) {
	const bin = path.join(sandbox.repo, "node_modules", ".bin", "biome");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, body);
	fs.chmodSync(bin, 0o755);
	return bin;
}

const run = (
	sessionId: string,
	file = path.join(sb.repo, REL),
	input: Record<string, unknown> = { file_path: file },
) =>
	runCore(
		"post-write",
		{ session_id: sessionId, tool_name: "Edit", tool_input: input },
		{ root: sb.repo, event: "PostToolUse" },
	);

const context = (r: ReturnType<typeof run>) =>
	r.output?.additionalContext ?? null;

describe("post-write — format, then record, in that order", () => {
	const seeded = defineTemplate((dir) => {
		fs.mkdirSync(path.join(dir, "docs"));
		emptyRepoTemplate(dir);
		fs.mkdirSync(path.join(dir, "scripts"));
	});

	beforeEach(() => {
		seeded.instantiate(sb.repo);
		registerSession(sb, "alice", process.pid);
	});

	const readLock = () => core.readRecord(store.paths.lock(REL));

	it("records what the FORMATTER left, not what the tool wrote", () => {
		const me = live(sb, "alice");
		fakeBiome(sb);
		fs.writeFileSync(path.join(sb.repo, REL), "const  x=1\n");
		store.acquire(REL, me);

		run("alice");

		expect(fs.readFileSync(path.join(sb.repo, REL), "utf8")).toBe(
			"formatted\n",
		);
		expect(store.contentState(REL, readLock()).state).toBe("same");
	});

	it("logs a written path that will not read for its digest, rather than swallowing it (#4132)", () => {
		fs.mkdirSync(path.join(sb.repo, "scripts", "dir.js"));
		const r = run("alice", path.join(sb.repo, "scripts", "dir.js"));
		expect(r.logs.join("\n")).toContain(
			"the written file did not read for its digest",
		);
	});

	it("formats a shell script with shfmt before recording it (#1332)", () => {
		const rel = "scripts/demo.sh";
		const me = live(sb, "alice");
		fs.writeFileSync(path.join(sb.repo, rel), "if true; then\n\techo x\nfi\n");
		store.acquire(rel, me);

		run("alice", path.join(sb.repo, rel));

		expect(fs.readFileSync(path.join(sb.repo, rel), "utf8")).toBe(
			"if true; then\n  echo x\nfi\n",
		);
		expect(
			store.contentState(rel, core.readRecord(store.paths.lock(rel))).state,
		).toBe("same");
	});

	it("still records the write in the ledger", () => {
		store.acquire(REL, live(sb, "alice"));
		fs.writeFileSync(path.join(sb.repo, REL), "x\n");
		run("alice");
		expect(store.readWritesBy("alice")).toContain(REL);
	});

	it("records nothing for a path outside the repo", () => {
		run("alice", "/etc/hosts");
		expect(store.readWritesBy("alice")).toEqual([]);
	});

	it("records even where there is no formatter to run", () => {
		store.acquire(REL, live(sb, "alice"));
		fs.writeFileSync(path.join(sb.repo, REL), "unformatted\n");

		run("alice");
		expect(fs.readFileSync(path.join(sb.repo, REL), "utf8")).toBe(
			"unformatted\n",
		);
		expect(store.contentState(REL, readLock()).state).toBe("same");
	});

	describe("says when it reformatted, and what a shell file's lint misses", () => {
		const writeAndRun = (rel: string, body: string, sid = "alice") => {
			fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
			fs.writeFileSync(path.join(sb.repo, rel), body);
			return run(sid, path.join(sb.repo, rel));
		};

		it("names the file and prints rule:write-reformatted on a reformat", () => {
			fakeBiome(sb);
			const r = writeAndRun(REL, "const  x=1\n");
			expect(context(r)).toContain(`reformatted ${REL}`);
			expect(context(r)).toContain(readRuleText("write-reformatted"));
		});

		it("prints the rule once a session, the notice on every reformat", () => {
			fakeBiome(sb);
			writeAndRun(REL, "const  x=1\n");
			const again = context(writeAndRun(REL, "const  y=2\n"));
			expect(again).toContain(`reformatted ${REL}`);
			expect(again).not.toContain(readRuleText("write-reformatted"));
			expect(context(writeAndRun(REL, "z\n", "bob"))).toContain(
				readRuleText("write-reformatted"),
			);
		});

		it("says nothing where the formatter left the bytes alone", () => {
			fakeBiome(sb);
			expect(writeAndRun(REL, "formatted\n").output).toBeNull();
		});

		it("prints rule:shell-lint-blind on a shell file, reformatted or not", () => {
			const r = writeAndRun("scripts/demo.sh", "if true; then\n  echo x\nfi\n");
			expect(context(r)).toBe(readRuleText("shell-lint-blind"));

			const hook = context(
				writeAndRun(".husky/pre-push", "#!/bin/sh\nexit 0\n", "carol"),
			);
			expect(hook).toBe(readRuleText("shell-lint-blind"));

			const bad = context(
				writeAndRun("scripts/other.sh", "if true; then\n\techo x\nfi\n", "bob"),
			);
			expect(bad).toContain("reformatted scripts/other.sh");
			expect(bad).toContain(readRuleText("write-reformatted"));
			expect(bad).toContain(readRuleText("shell-lint-blind"));
		});

		it("says Biome did not run where the checkout has none, as a worktree", () => {
			const r = context(writeAndRun(REL, "const  x=1\n"));
			expect(r).toContain(`ran no Biome on ${REL}`);
			expect(r).toContain(readRuleText("write-reformatted"));
			expect(writeAndRun("notes.md", "x\n", "bob").output).toBeNull();
		});

		it("carries a scan fault in the same envelope as the notice", () => {
			fakeBiome(sb, '#!/bin/sh\nprintf "\\n" >> "$4"\n');
			fs.mkdirSync(path.join(sb.repo, ".claude-plugin"), { recursive: true });
			fs.writeFileSync(
				path.join(sb.repo, ".claude-plugin", "plugin.json"),
				'{"name":"demo"}\n',
			);
			const r = writeAndRun(REL, 'console.log("see #12 for why");\n');
			expect(context(r)).toContain(`reformatted ${REL}`);
			expect(context(r)).toMatch(/scripts\/demo\.js:1 prints #12/);
		});
	});

	describe("a file outside the repo root is left unformatted", () => {
		const foreignJson = '{\n  "a": 1\n}\n';
		const foreignFile = (dir: string) => {
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, "settings.json");
			fs.writeFileSync(file, foreignJson);
			return file;
		};

		it.each([
			["another directory", () => path.join(sb.dir, "elsewhere")],
			[
				"a sibling sharing the root's name as a prefix",
				() => `${sb.repo}-other`,
			],
		])("in %s", (_label, dirOf) => {
			fakeBiome(sb);
			const file = foreignFile(dirOf());

			run("alice", file);
			expect(fs.readFileSync(file, "utf8")).toBe(foreignJson);
		});

		it("reached through a symlink inside the root", () => {
			fakeBiome(sb);
			const target = foreignFile(path.join(sb.dir, "elsewhere"));
			const link = path.join(sb.repo, "linked.json");
			fs.symlinkSync(target, link);

			run("alice", link);
			expect(fs.readFileSync(target, "utf8")).toBe(foreignJson);
		});

		it("while a relative path still resolves against the root", () => {
			fakeBiome(sb);
			fs.writeFileSync(path.join(sb.repo, REL), "const  x=1\n");
			run("alice", REL);
			expect(fs.readFileSync(path.join(sb.repo, REL), "utf8")).toBe(
				"formatted\n",
			);
		});
	});

	describe("scans the written file for a host-root or bare-citation fault (#1151)", () => {
		const shipPlugin = () => {
			fs.mkdirSync(path.join(sb.repo, ".claude-plugin"), { recursive: true });
			fs.writeFileSync(
				path.join(sb.repo, ".claude-plugin", "plugin.json"),
				'{"name":"demo"}\n',
			);
		};
		const write = (body: string, rel = REL) => {
			fakeBiome(sb, "#!/bin/sh\n");
			const file = path.join(sb.repo, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return run("alice", file);
		};
		const walkToDocs = (ups: string) =>
			`const path = require("node:path");\nmodule.exports = path.join(__dirname, ${ups}, "docs");\n`;

		it("names a __dirname walk into docs/, as the commit gate would", () => {
			shipPlugin();
			const r = write(walkToDocs('".."'));
			expect(context(r)).toMatch(
				/scripts\/demo\.js:2 .*outside scripts\/\. Use hostRoot\(\)/,
			);
		});

		it("names a #N a shipped code line prints bare, as the release would", () => {
			shipPlugin();
			const r = write('console.log("see #12 for why");\n');
			expect(context(r)).toMatch(
				/scripts\/demo\.js:1 prints #12 outside .* bracket it/,
			);
		});

		it("says nothing of a clean file", () => {
			shipPlugin();
			expect(write('console.log("see (#12) for why");\n').output).toBeNull();
		});

		it("says nothing of a test file, which neither gate judges", () => {
			shipPlugin();
			const r = write(
				`console.log("see #12");\n${walkToDocs('".."')}`,
				"scripts/demo.test.js",
			);
			expect(r.output).toBeNull();
		});

		it("says nothing of a #N printed bare by a file the release leaves behind", () => {
			shipPlugin();
			const r = write(
				'console.log("see #12");\n',
				"scripts/release-contains.js",
			);
			expect(r.output).toBeNull();
		});

		it("says nothing of a __dirname walk check-host-root.js allowlists, naming the same walk beside it", () => {
			shipPlugin();
			const walk = walkToDocs('"..", ".."');
			expect(write(walk, "scripts/lib/rule-text.js").output).toBeNull();
			expect(context(write(walk, "scripts/lib/other.js"))).toMatch(
				/scripts\/lib\/other\.js:2 .*outside scripts\//,
			);
		});

		it("says nothing where the repo ships no plugin, which neither rule binds", () => {
			const r = write('console.log("see #12 for why");\n');
			expect(r.output).toBeNull();
		});
	});

	it("records a notebook under its notebook_path, formatting nothing", () => {
		const rel = "nb/demo.ipynb";
		store.acquire(rel, live(sb, "alice"));
		fs.mkdirSync(path.join(sb.repo, "nb"));
		fs.writeFileSync(path.join(sb.repo, rel), "{}\n");
		expect(
			run("alice", "", { notebook_path: path.join(sb.repo, rel) }).output,
		).toBeNull();
		expect(store.readWritesBy("alice")).toContain(rel);
	});

	it("falls back to CLAUDE_CODE_SESSION_ID where the payload carries no session", () => {
		store.acquire(REL, live(sb, "alice"));
		fs.writeFileSync(path.join(sb.repo, REL), "x\n");
		runCore(
			"post-write",
			{ tool_name: "Edit", tool_input: { file_path: path.join(sb.repo, REL) } },
			{
				root: sb.repo,
				event: "PostToolUse",
				env: { CLAUDE_CODE_SESSION_ID: "alice" },
			},
		);
		expect(store.readWritesBy("alice")).toContain(REL);
	});

	describe("the shell and Python format (#1332), from the root as Biome is", () => {
		const ShBad = "if true; then\n\techo x\nfi\n";
		const ShOk = "if true; then\n  echo x\nfi\n";
		const formatted = (rel: string, body: string) => {
			fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
			fs.writeFileSync(path.join(sb.repo, rel), body);
			const said = context(run("alice", path.join(sb.repo, rel)));
			return {
				out: fs.readFileSync(path.join(sb.repo, rel), "utf8"),
				shell: said?.includes(readRuleText("shell-lint-blind")) ?? false,
			};
		};

		it("formats a husky hook, which has no .sh extension", () => {
			expect(formatted(".husky/pre-push", ShBad).out).toBe(ShOk);
		});

		it("formats a .sh outside scripts/ and an extensionless file with a shell shebang (#1828)", () => {
			expect(formatted("tools/a.sh", ShBad).out).toBe(ShOk);
			const shebang = `#!/usr/bin/env bash\n${ShBad}`;
			expect(formatted("bin/run", shebang).out).toBe(
				`#!/usr/bin/env bash\n${ShOk}`,
			);
		});

		it("leaves an extensionless file with no shell shebang as written, and calls it no shell file", () => {
			expect(formatted("bin/notes", ShBad)).toEqual({
				out: ShBad,
				shell: false,
			});
		});

		it("leaves an unparseable script as written, still calling it a shell file", () => {
			expect(formatted("scripts/a.sh", "if then fi (\n")).toEqual({
				out: "if then fi (\n",
				shell: true,
			});
		});

		it.skipIf(!REAL_RUFF)("formats a .py with ruff", () => {
			vi.stubEnv("WFC_RUFF", REAL_RUFF ?? "");
			expect(formatted("pkg/a.py", "print( 'x' )\n").out).toBe('print("x")\n');
		});

		it("leaves a .py as written where ruff is not installed, still recording it", () => {
			vi.stubEnv("WFC_RUFF", "/nonexistent/ruff");
			store.acquire("pkg/b.py", live(sb, "alice"));
			expect(formatted("pkg/b.py", "print( 'x' )\n").out).toBe(
				"print( 'x' )\n",
			);
			expect(store.readWritesBy("alice")).toContain("pkg/b.py");
		});

		it("formats from the root whatever the hook's own directory", () => {
			const back = process.cwd();
			process.chdir(path.dirname(sb.repo));
			try {
				expect(formatted("tools/c.sh", ShBad).out).toBe(ShOk);
				expect(process.cwd()).toBe(path.dirname(sb.repo));
			} finally {
				process.chdir(back);
			}
		});
	});
});

describe("a write from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((fresh) => {
		at = splitCheckout(path.join(fresh.dir, "split"));
		vi.stubEnv("CLAUDE_PROJECT_DIR", at.worktree);
		vi.stubEnv("WFC_REPO_ROOT", at.main);
		vi.stubEnv("WFC_DISPATCH_ROOT", at.main);
	});

	const biomeWriting = (root: string, mark: string) =>
		fakeBiome({ repo: root }, `#!/bin/sh\nprintf '${mark}\\n' > "$4"\n`);

	const written = () => {
		const file = path.join(at.worktree, "demo.js");
		fs.writeFileSync(file, "const  x=1\n");
		const r = runCore(
			"post-write",
			{
				session_id: "alice",
				tool_name: "Edit",
				tool_input: { file_path: file },
			},
			{ root: at.main, worktree: at.worktree, event: "PostToolUse" },
		);
		return { text: fs.readFileSync(file, "utf8"), said: context(r) ?? "" };
	};

	it("formats with the worktree's Biome, not the main checkout's", () => {
		biomeWriting(at.main, "main");
		biomeWriting(at.worktree, "worktree");
		const { text, said } = written();
		expect(text).toBe("worktree\n");
		expect(said).toContain("post-write reformatted demo.js");
	});

	it("leaves the file as written where only the main checkout has a Biome", () => {
		biomeWriting(at.main, "main");
		const { text, said } = written();
		expect(text).toBe("const  x=1\n");
		expect(said).toContain("post-write ran no Biome on demo.js");
	});
});
