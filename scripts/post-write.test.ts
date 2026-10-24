// @vitest-environment node
/*
 * post-write.sh's own suite: the ORDER of the two things that follow a tool
 * write, which is the only reason the script exists.
 *
 * Claude Code runs every matching hook in parallel, so while the formatter and
 * the write recorder were two registrations the recorder often stored the
 * pre-format bytes — and the session's next write to that file then reported its
 * own formatter as a clobber by an unwatched route (mantahostels#295).
 *
 * The hook is spawned on a real payload in an arbiter sandbox repo, with a
 * stand-in biome under `node_modules/.bin` that really rewrites the file.
 *
 * It also pins what the hook says of its step 1 (#2019).
 *
 * Loosen a case and every formatted write reads as a clobber at the next one,
 * or a hook failure fails the tool call itself.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	core,
	freshSandbox,
	live,
	registerSession,
	store,
} from "./lib/arbiter-testkit";

/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

const sb = freshSandbox();
const HOOK = path.join(__dirname, "post-write.sh");
const REL = "scripts/demo.js";

/** A Biome stand-in that really rewrites the file; `body` replaces what it does. */
function fakeBiome(
	sandbox: { repo: string },
	// It takes biome's own argv shape: format --write -- <file>.
	body = '#!/bin/sh\nf="$4"\nprintf \'formatted\\n\' > "$f"\n',
) {
	const bin = path.join(sandbox.repo, "node_modules", ".bin", "biome");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, body);
	fs.chmodSync(bin, 0o755);
	return bin;
}

/* The hook sources guard-parse.sh, which logs a fail-open under
 * CLAUDE_CONFIG_DIR: the sandbox's own, off the live guard-errors.log. */
const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: sb.home });

const run = (sessionId: string, file = path.join(sb.repo, REL)) =>
	spawnSync(HOOK, [], {
		encoding: "utf8",
		cwd: sb.repo,
		input: JSON.stringify({
			session_id: sessionId,
			tool_name: "Edit",
			tool_input: { file_path: file },
		}),
		env: env(),
	});

describe("post-write.sh — format, then record, in that order", () => {
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		registerSession(sb, "alice", process.pid);
	});

	const lockOf = () => core.readRecord(store.paths.lock(REL));

	it("records what the FORMATTER left, not what the tool wrote", () => {
		const me = live(sb, "alice");
		fakeBiome(sb);
		fs.writeFileSync(path.join(sb.repo, REL), "const  x=1\n");
		store.acquire(REL, me); // the PreToolUse claim

		expect(run("alice").status).toBe(0);

		expect(fs.readFileSync(path.join(sb.repo, REL), "utf8")).toBe(
			"formatted\n",
		);
		expect(store.contentState(REL, lockOf()).state).toBe("same");
	});

	it("formats a shell script with shfmt before recording it (#1332)", () => {
		const rel = "scripts/demo.sh";
		const me = live(sb, "alice");
		fs.writeFileSync(path.join(sb.repo, rel), "if true; then\n\techo x\nfi\n");
		store.acquire(rel, me);

		expect(run("alice", path.join(sb.repo, rel)).status).toBe(0);

		expect(fs.readFileSync(path.join(sb.repo, rel), "utf8")).toBe(
			"if true; then\n  echo x\nfi\n",
		);
		expect(
			store.contentState(rel, core.readRecord(store.paths.lock(rel))).state,
		).toBe("same");
	});

	it("still records the write in the ledger", () => {
		// The recorder's original job (mantahostels#114).
		store.acquire(REL, live(sb, "alice"));
		fs.writeFileSync(path.join(sb.repo, REL), "x\n");
		run("alice");
		expect(store.writesBy("alice")).toContain(REL);
	});

	it("records even where there is no formatter to run", () => {
		// A worktree has no node_modules. The old inline hook called `npx biome`
		// there, which fetches an unrelated package that prints nothing and exits 0;
		// this one skips the format rather than corrupting anything, and the record
		// must still land.
		store.acquire(REL, live(sb, "alice"));
		fs.writeFileSync(path.join(sb.repo, REL), "unformatted\n");

		expect(run("alice").status).toBe(0);
		expect(fs.readFileSync(path.join(sb.repo, REL), "utf8")).toBe(
			"unformatted\n",
		);
		expect(store.contentState(REL, lockOf()).state).toBe("same");
	});

	describe("says when it reformatted, and what a shell file's lint misses", () => {
		const context = (r: { stdout: string }) =>
			r.stdout
				? JSON.parse(r.stdout).hookSpecificOutput.additionalContext
				: null;
		const writeAndRun = (rel: string, body: string, sid = "alice") => {
			fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
			fs.writeFileSync(path.join(sb.repo, rel), body);
			return run(sid, path.join(sb.repo, rel));
		};

		it("names the file and prints rule:write-reformatted on a reformat", () => {
			fakeBiome(sb);
			const r = writeAndRun(REL, "const  x=1\n");
			expect(r.status).toBe(0);
			expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
				"PostToolUse",
			);
			expect(context(r)).toContain(`reformatted ${REL}`);
			expect(context(r)).toContain(ruleText("write-reformatted"));
		});

		it("prints the rule once a session, the notice on every reformat", () => {
			fakeBiome(sb);
			writeAndRun(REL, "const  x=1\n");
			const again = context(writeAndRun(REL, "const  y=2\n"));
			expect(again).toContain(`reformatted ${REL}`);
			expect(again).not.toContain(ruleText("write-reformatted"));
			expect(context(writeAndRun(REL, "z\n", "bob"))).toContain(
				ruleText("write-reformatted"),
			);
		});

		it("says nothing where the formatter left the bytes alone", () => {
			fakeBiome(sb);
			expect(writeAndRun(REL, "formatted\n").stdout).toBe("");
		});

		it("prints rule:shell-lint-blind on a shell file, reformatted or not", () => {
			const r = writeAndRun("scripts/demo.sh", "if true; then\n  echo x\nfi\n");
			expect(context(r)).toBe(ruleText("shell-lint-blind"));

			const hook = context(
				writeAndRun(".husky/pre-push", "#!/bin/sh\nexit 0\n", "carol"),
			);
			expect(hook).toBe(ruleText("shell-lint-blind"));

			const bad = context(
				writeAndRun("scripts/other.sh", "if true; then\n\techo x\nfi\n", "bob"),
			);
			expect(bad).toContain("reformatted scripts/other.sh");
			expect(bad).toContain(ruleText("write-reformatted"));
			expect(bad).toContain(ruleText("shell-lint-blind"));
		});

		it("says Biome did not run where the checkout has none, as a worktree", () => {
			const r = context(writeAndRun(REL, "const  x=1\n"));
			expect(r).toContain(`ran no Biome on ${REL}`);
			expect(r).toContain(ruleText("write-reformatted"));
			expect(writeAndRun("notes.md", "x\n", "bob").stdout).toBe("");
		});

		it("carries a scan fault in the same envelope as the notice", () => {
			// A biome that reformats by appending, so the fault survives it.
			fakeBiome(sb, '#!/bin/sh\nprintf "\\n" >> "$4"\n');
			fs.mkdirSync(path.join(sb.repo, ".claude-plugin"), { recursive: true });
			fs.writeFileSync(
				path.join(sb.repo, ".claude-plugin", "plugin.json"),
				'{"name":"demo"}\n',
			);
			const r = writeAndRun(REL, 'console.log("see #12 for why");\n');
			expect(r.stdout.trim().split("\n")).toHaveLength(1);
			expect(context(r)).toContain(`reformatted ${REL}`);
			expect(context(r)).toMatch(/scripts\/demo\.js:1 prints #12/);
		});
	});

	// A session rooted here can write into another repo, which has its own
	// formatter or none (#96). What the record step makes of a foreign path is
	// record-write.sh's own.
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
			// A bare string-prefix test would call this one inside.
			[
				"a sibling sharing the root's name as a prefix",
				() => `${sb.repo}-other`,
			],
		])("in %s", (_label, dirOf) => {
			fakeBiome(sb);
			const file = foreignFile(dirOf());

			expect(run("alice", file).status).toBe(0);
			expect(fs.readFileSync(file, "utf8")).toBe(foreignJson);
		});

		it("reached through a symlink inside the root", () => {
			// Biome writes through the link, so the leaf is what must be judged.
			fakeBiome(sb);
			const target = foreignFile(path.join(sb.dir, "elsewhere"));
			const link = path.join(sb.repo, "linked.json");
			fs.symlinkSync(target, link);

			expect(run("alice", link).status).toBe(0);
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
		const context = (r: { stdout: string }) =>
			r.stdout
				? JSON.parse(r.stdout).hookSpecificOutput.additionalContext
				: null;
		const write = (body: string) => {
			fakeBiome(sb, "#!/bin/sh\n");
			fs.writeFileSync(path.join(sb.repo, REL), body);
			return run("alice");
		};

		it("names a __dirname walk into docs/, as the commit gate would", () => {
			shipPlugin();
			const r = write(
				'const path = require("node:path");\nmodule.exports = path.join(__dirname, "..", "docs", "x.json");\n',
			);
			expect(r.status).toBe(0);
			expect(context(r)).toMatch(
				/scripts\/demo\.js:2 .*outside scripts\/\. Use hostRoot\(\)/,
			);
		});

		it("names a #N a shipped code line prints bare, as the release would", () => {
			shipPlugin();
			const r = write('console.log("see #12 for why");\n');
			expect(r.status).toBe(0);
			expect(context(r)).toMatch(
				/scripts\/demo\.js:1 prints #12 outside .* bracket it/,
			);
		});

		it("says nothing of a clean file", () => {
			shipPlugin();
			expect(write('console.log("see (#12) for why");\n').stdout).toBe("");
		});

		it.each([
			"scripts/demo.test.js",
			// The release leaves it behind, and check-host-root.js allowlists it.
			"scripts/cut-mantahostels.js",
		])("says nothing of %s, which neither gate judges", (rel) => {
			shipPlugin();
			fakeBiome(sb, "#!/bin/sh\n");
			const file = path.join(sb.repo, rel);
			fs.writeFileSync(
				file,
				'const path = require("node:path");\nconsole.log("see #12");\nmodule.exports = path.join(__dirname, "..", "docs");\n',
			);
			expect(run("alice", file).stdout).toBe("");
		});

		it("says nothing where the repo ships no plugin, which neither rule binds", () => {
			const r = write('console.log("see #12 for why");\n');
			expect(r.stdout).toBe("");
		});
	});

	it("exits 0 on a payload it cannot read, so a tool call never fails over it", () => {
		const r = spawnSync(HOOK, [], {
			encoding: "utf8",
			cwd: sb.repo,
			input: "not json",
			env: env(),
		});
		expect(r.status).toBe(0);
	});
});
