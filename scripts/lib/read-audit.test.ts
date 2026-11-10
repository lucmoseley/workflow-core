// @vitest-environment node
/*
 * The read audit (#4916): real Node processes under the preload, on a
 * throwaway checkout, and the logs they leave read back into each test
 * file's reads. Loosen a case and the pass store caches a file whose verdict
 * rests on a read nobody recorded.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { install, readAudits, remove } = require("./read-audit.js");
const { findStrace } = require("./read-audit-trace.js");
const { listingId } = require("./listing-id.js");
const { lookup, record } = require("./pass-store.js");
const { EDGES_FILE } = require("./test-pass-marker.js");

const GUARD_DIR = path.join(__dirname, "host-git-guard");

const STRACE = (() => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rda-")));
	try {
		return findStrace(dir, process.env);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})();
const quoted = JSON.stringify;

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function write(dir: string, file: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
}

function checkout() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rda-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	write(dir, ".claude/settings.json", '{"hooks":{}}\n');
	write(dir, ".claude/skills/one/SKILL.md", "one\n");
	write(dir, ".claude/skills/two/SKILL.md", "two\n");
	write(
		dir,
		"scripts/lib/hooks.js",
		[
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const coreRoot = () => path.resolve(__dirname, "../..");',
			"module.exports = (root = coreRoot()) =>",
			'\tfs.readFileSync(path.join(root, ".claude/settings.json"), "utf8");',
			"",
		].join("\n"),
	);
	return dir;
}

/**
 * Run `body` as the test file `file` in a process under the audit armed over
 * `root`; returns the audit's log dir. `trace: false` arms it as on a machine
 * with no tracer.
 */
function audited(
	root: string,
	file: string,
	body: string,
	{ env = {} as Record<string, string>, trace = true } = {},
) {
	const scope: NodeJS.ProcessEnv = { ...process.env, ...env };
	delete scope.WFC_READ_AUDIT_OWNER;
	delete scope.NODE_OPTIONS;
	const log = install(root, scope, { write: () => true });
	if (!trace) delete scope.WFC_READ_AUDIT_STRACE;
	dirs.push(log);
	write(
		root,
		file,
		`globalThis.__wfcReadAudit.claim(${JSON.stringify(path.join(root, file))});\n${body}\n`,
	);
	// spawn-kept: the preload arms only through NODE_OPTIONS in a fresh process.
	const r = spawnSync(process.execPath, [path.join(root, file)], {
		cwd: os.tmpdir(),
		env: scope,
		encoding: "utf8",
	});
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return log as string;
}

const T = "scripts/x.test.js";

describe("what a test file reads, as the audit sees it", () => {
	it("holds a file a helper read through its default root", () => {
		const root = checkout();
		const log = audited(root, T, 'require("./lib/hooks.js")();');
		const audit = readAudits(log, root).get(T);
		expect(audit.reads.files).toEqual(
			expect.arrayContaining([".claude/settings.json", "scripts/lib/hooks.js"]),
		);
	});

	it("holds a listing with the names it returned, and an absent path as absent", () => {
		const root = checkout();
		const log = audited(
			root,
			T,
			[
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				'const r = path.resolve(__dirname, "..");',
				'fs.readdirSync(path.join(r, ".claude/skills"));',
				'fs.existsSync(path.join(r, "docs/agents/rules/review-a.txt"));',
				'fs.statSync(path.join(r, ".claude"));',
			].join("\n"),
		);
		const { reads } = readAudits(log, root).get(T);
		expect(reads.lists).toEqual({
			".claude/skills": listingId(["one", "two"]),
		});
		expect(reads.absent).toEqual(["docs/agents/rules/review-a.txt"]);
		expect(reads.dirs).toEqual([".claude"]);
	});

	it("charges a Node child's reads to the file that spawned it", () => {
		const root = checkout();
		write(root, "scripts/child.js", 'require("./lib/hooks.js")();\n');
		const log = audited(
			root,
			T,
			`require("node:child_process").execFileSync(process.execPath, [${JSON.stringify(path.join(root, "scripts/child.js"))}]);`,
		);
		const { reads } = readAudits(log, root).get(T);
		expect(reads.files).toEqual(
			expect.arrayContaining([".claude/settings.json", "scripts/child.js"]),
		);
	});

	it("names a script an untraced shell child ran, and doubts one run in the checkout", () => {
		const root = checkout();
		write(root, "scripts/run.sh", "true\n");
		const spawn = (cwd: string) =>
			`require("node:child_process").execFileSync("bash", [${JSON.stringify(path.join(root, "scripts/run.sh"))}], { cwd: ${JSON.stringify(cwd)} });`;
		const outside = audited(root, T, spawn(os.tmpdir()), { trace: false });
		expect(readAudits(outside, root).get(T).reads.scripts).toEqual([
			"scripts/run.sh",
		]);
		const inside = audited(root, T, spawn(root), { trace: false });
		expect(readAudits(inside, root).get(T).doubt).toMatch(
			/ran in the checkout/,
		);
	});

	describe("a program run in the checkout that no tracer follows (#4932)", () => {
		const run = (
			root: string,
			program: string,
			args: string[],
			env: Record<string, string> = {},
		) =>
			readAudits(
				audited(
					root,
					T,
					`try { require("node:child_process").execFileSync(${JSON.stringify(program)}, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(root)}, stdio: "ignore" }); } catch {}`,
					{ env, trace: false },
				),
				root,
			).get(T);

		it("keeps the reads of a file that only sleeps, or asks bash its version", () => {
			const root = checkout();
			expect(run(root, "sleep", ["0"])).toHaveProperty("reads");
			expect(run(root, "bash", ["--version"])).toHaveProperty("reads");
		});

		it("doubts a program that reads what a word names, whose reads stay unbounded", () => {
			const root = checkout();
			expect(run(root, "cat", ["scripts/lib/hooks.js"]).doubt).toMatch(
				/a child \(cat scripts\/lib\/hooks\.js\) ran in the checkout/,
			);
		});

		it("doubts a version asked of a program not named, and bash asked anything else", () => {
			const root = checkout();
			expect(run(root, "cat", ["--version"]).doubt).toMatch(
				/ran in the checkout/,
			);
			expect(run(root, "bash", ["-c", "true"]).doubt).toMatch(
				/ran in the checkout/,
			);
		});

		it("doubts a sleep a test could have written: in the checkout, in the temporary directory, or linked to from elsewhere", () => {
			const root = checkout();
			const sleepOn = (dir: string) =>
				run(root, "sleep", ["0"], {
					PATH: `${dir}${path.delimiter}${process.env.PATH}`,
				}).doubt;
			write(root, "bin/sleep", "#!/bin/sh\ncat .claude/settings.json\n");
			fs.chmodSync(path.join(root, "bin/sleep"), 0o755);
			expect(sleepOn(path.join(root, "bin"))).toMatch(/ran in the checkout/);

			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rda-stub-"));
			fs.copyFileSync(
				path.join(root, "bin/sleep"),
				path.join(scratch, "sleep"),
			);
			fs.chmodSync(path.join(scratch, "sleep"), 0o755);
			expect(sleepOn(scratch)).toMatch(/ran in the checkout/);

			const relinked = fs.mkdtempSync(path.join(os.tmpdir(), "rda-link-"));
			fs.symlinkSync("/usr/bin/cat", path.join(relinked, "sleep"));
			expect(sleepOn(relinked)).toMatch(/ran in the checkout/);

			const linked = fs.mkdtempSync(path.join(os.homedir(), ".rda-link-"));
			try {
				fs.symlinkSync(
					path.join(root, "bin/sleep"),
					path.join(linked, "sleep"),
				);
				expect(sleepOn(linked)).toMatch(/ran in the checkout/);
			} finally {
				fs.rmSync(linked, { recursive: true, force: true });
			}
		});

		it("skips a file of the program's name that cannot be run, as the exec does", () => {
			const root = checkout();
			write(root, "bin/sleep", "not a program\n");
			expect(
				run(root, "sleep", ["0"], {
					PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
				}),
			).toHaveProperty("reads");
		});
	});

	it("runs a node-shebang child whose name has an extension node does not know", () => {
		const root = checkout();
		const stub = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "rda-exe-")),
			"typeperf.exe",
		);
		dirs.push(path.dirname(stub));
		fs.writeFileSync(stub, "#!/usr/bin/env node\nprocess.exit(0);\n", {
			mode: 0o755,
		});
		audited(
			root,
			T,
			`require("node:child_process").execFileSync(${JSON.stringify(stub)});`,
		);
	});

	it("doubts an untraced Node child spawned without the audit on", () => {
		const root = checkout();
		write(root, "scripts/child.js", 'require("./lib/hooks.js")();\n');
		const log = audited(
			root,
			T,
			`require("node:child_process").execFileSync(process.execPath, [${JSON.stringify(path.join(root, "scripts/child.js"))}], { env: { PATH: process.env.PATH } });`,
			{ trace: false },
		);
		expect(readAudits(log, root).get(T).doubt).toMatch(/without the audit/);
	});

	it("keeps a read-only git call on the checkout's repository to run again, and doubts any other", () => {
		const root = checkout();
		const env = {
			PATH: `${GUARD_DIR}${path.delimiter}${process.env.PATH}`,
			WFC_HOST_GIT_DIR: git(
				root,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			),
		};
		const call = (cwd: string, args: string[]) =>
			`require("node:child_process").execFileSync("git", ${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)} });`;
		const fixture = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rda-own-")),
		);
		dirs.push(fixture);
		git(fixture, "init", "-q");
		const own = audited(root, T, call(fixture, ["status"]), { env });
		expect(readAudits(own, root).get(T).reads.git).toEqual([]);
		const listed = audited(
			root,
			T,
			call(path.join(root, "scripts"), ["ls-files", "-z"]),
			{ env },
		);
		expect(readAudits(listed, root).get(T).reads.git).toEqual([
			{ cwd: "scripts", args: ["ls-files", "-z"] },
		]);
		const status = audited(root, T, call(root, ["status"]), { env });
		expect(readAudits(status, root).get(T).doubt).toMatch(
			/git call \(git status\) read this repository/,
		);
		const steered = audited(root, T, call(fixture, ["-C", root, "ls-files"]), {
			env,
		});
		expect(readAudits(steered, root).get(T).doubt).toMatch(
			/^a git call \(git -C /,
		);
	});

	it("doubts an untraced git run by absolute path in the checkout, which no guard logs", () => {
		const root = checkout();
		const real = execFileSync("sh", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		const log = audited(
			root,
			T,
			`require("node:child_process").execFileSync(${JSON.stringify(real)}, ["status"], { cwd: ${JSON.stringify(root)} });`,
			{
				env: { PATH: `${GUARD_DIR}${path.delimiter}${process.env.PATH}` },
				trace: false,
			},
		);
		expect(readAudits(log, root).get(T).doubt).toMatch(/ran in the checkout/);
	});
});

/** A program `tool` a test wrote, as `text`, in a scratch directory to put on PATH. */
function stubTool(text: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rda-stub-"));
	dirs.push(dir);
	fs.writeFileSync(path.join(dir, "tool"), text, { mode: 0o755 });
	return dir;
}

/** A test body running the `tool` on `stub` in the checkout `root`. */
const runsTool = (root: string, stub: string) =>
	`require("node:child_process").execFileSync("tool", ["api", "user"], { cwd: ${quoted(root)}, env: { ...process.env, PATH: ${quoted(stub + path.delimiter)} + process.env.PATH } });`;

const READS_SETTINGS = "#!/bin/sh\ncat .claude/settings.json\n";

describe.skipIf(!STRACE)("a child run under the tracer (#4966)", () => {
	const reads = (root: string, body: string) =>
		readAudits(audited(root, T, body), root).get(T);

	it("keeps the reads of a file whose stub reads nothing of the checkout, and holds the file a stub does read", () => {
		const root = checkout();
		const quiet = reads(
			root,
			runsTool(root, stubTool("#!/bin/sh\necho '{}'\n")),
		);
		expect(quiet.reads.files).not.toContain(".claude/settings.json");
		const loud = reads(root, runsTool(root, stubTool(READS_SETTINGS)));
		expect(loud.reads.files).toContain(".claude/settings.json");
	});

	it("holds what an inline shell reads from a directory it moved to, finds absent, and lists", () => {
		const root = checkout();
		const script =
			"cd scripts && cat lib/hooks.js >/dev/null; test -e nope.txt; ls ../.claude/skills >/dev/null";
		const audit = reads(
			root,
			`require("node:child_process").execSync(${quoted(script)}, { cwd: ${quoted(root)} });`,
		);
		expect(audit.reads.files).toContain("scripts/lib/hooks.js");
		expect(audit.reads.absent).toContain("scripts/nope.txt");
		expect(audit.reads.trees).toEqual([".claude/skills"]);
	});

	it("holds a checkout file read through a link from outside it", () => {
		const root = checkout();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rda-link-"));
		dirs.push(outside);
		fs.symlinkSync(root, path.join(outside, "in"));
		const audit = reads(
			root,
			`require("node:child_process").execSync(${quoted(`cat ${path.join(outside, "in/.claude/settings.json")}`)}, { cwd: ${quoted(root)} });`,
		);
		expect(audit.reads.files).toContain(".claude/settings.json");
	});

	it("doubts a file a child read and then removed, which nothing is left to key", () => {
		const root = checkout();
		const audit = reads(
			root,
			`require("node:child_process").execSync("cat scripts/lib/hooks.js >/dev/null; rm scripts/lib/hooks.js", { cwd: ${quoted(root)} });`,
		);
		expect(audit.doubt).toMatch(/it read scripts\/lib\/hooks\.js/);
	});

	it("leaves the child the pid, exit status and signal the test would have seen", () => {
		const root = checkout();
		const audit = reads(
			root,
			[
				'const cp = require("node:child_process");',
				`const at = { cwd: ${quoted(root)}, encoding: "utf8" };`,
				'const r = cp.spawnSync("sh", ["-c", "echo $$; exit 3"], at);',
				"if (r.status !== 3 || Number(r.stdout) !== r.pid) throw new Error(JSON.stringify(r));",
				/* Crosses the real clock: the kill Node sends at its timeout is
				 * what the case tests. 300 ms is a guess above a shell's start
				 * under the tracer (~20 ms); the 30 s sleep, one far past it. */
				'const k = cp.spawnSync("sh", ["-c", "exec sleep 30"], { ...at, timeout: 300 });',
				'if (k.signal !== "SIGTERM") throw new Error(JSON.stringify(k));',
			].join("\n"),
		);
		expect(audit).toHaveProperty("reads");
	});

	it("returns from a shell that left a detached process running, while it runs", () => {
		const root = checkout();
		const audit = reads(
			root,
			[
				'const cp = require("node:child_process");',
				`const at = { cwd: ${quoted(root)}, encoding: "utf8" };`,
				/* The 30 s sleep is one far past the case: the spawn returning
				 * while it lives is what the case tests. */
				`const r = cp.spawnSync("sh", ["-c", "setsid sh -c 'echo $$; exec sleep 30 </dev/null >/dev/null 2>&1' </dev/null 2>/dev/null &"], at);`,
				"const pid = Number(r.stdout);",
				"process.kill(pid, 0);",
				'process.kill(pid, "SIGKILL");',
			].join("\n"),
		);
		expect(audit).toHaveProperty("reads");
	});

	it("follows a Node child of a traced shell, and what that child spawns", () => {
		const root = checkout();
		write(
			root,
			"scripts/child.js",
			`require("node:child_process").execFileSync("cat", [".claude/settings.json"], { cwd: ${quoted(root)} });\n`,
		);
		const audit = reads(
			root,
			`require("node:child_process").execFileSync("sh", ["-c", '"$0" scripts/child.js', process.execPath], { cwd: ${quoted(root)} });`,
		);
		expect(audit.doubt).toBeUndefined();
		expect(audit.reads.files).toEqual(
			expect.arrayContaining([".claude/settings.json", "scripts/child.js"]),
		);
	});

	it("doubts a traced child that reads the repository's own state", () => {
		const root = checkout();
		const audit = reads(
			root,
			`require("node:child_process").execSync("git status", { cwd: ${quoted(root)} });`,
		);
		expect(audit.doubt).toMatch(
			/a traced child \(sh -c git status\) read this repository's git directory/,
		);
	});

	it("runs untraced, and doubts, a program that is no stub and no shell", () => {
		const root = checkout();
		const audit = reads(
			root,
			`require("node:child_process").execFileSync("cat", ["scripts/lib/hooks.js"], { cwd: ${quoted(root)} });`,
		);
		expect(audit.doubt).toMatch(
			/a child \(cat scripts\/lib\/hooks\.js\) ran in the checkout/,
		);
	});

	it("runs untraced, and doubts, a file the kernel will not run without a shell", () => {
		const root = checkout();
		const audit = reads(root, runsTool(root, stubTool("echo '{}'\n")));
		expect(audit.doubt).toMatch(
			/a child \(tool api user\) ran in the checkout/,
		);
	});
});

describe("a stub run in the checkout with no tracer (#4966)", () => {
	it("doubts the file, whatever the stub reads", () => {
		const root = checkout();
		const log = audited(root, T, runsTool(root, stubTool(READS_SETTINGS)), {
			trace: false,
		});
		expect(readAudits(log, root).get(T).doubt).toMatch(
			/a child \(tool api user\) ran in the checkout/,
		);
	});
});

describe("from a real audited run to a cached row (#4916)", () => {
	const Values = { node: "v22.0.0", arch: "arm64" };

	/** Record `log`'s run of T at `root`, as the suite's teardown does. */
	const recordRun = (root: string, log: string) =>
		record(
			{
				sha: git(root, "rev-parse", "HEAD"),
				at: new Date().toISOString(),
				tree: null,
				root,
				files: [{ file: T, outcome: "pass", imports: [] }],
				shared: ["vitest.config.ts", "vitest.setup.ts"],
				clean: true,
				drifted: [],
				audits: readAudits(log, root),
			},
			{ storeRoot: root, lander: false, values: Values },
		);
	const isCached = (root: string) =>
		lookup([T], { root, storeRoot: root, values: Values, lander: false }).cached
			.length === 1;

	/** A checkout holding what a row keys on; `commit` once the run is in. */
	const keyed = () => {
		const root = checkout();
		for (const f of ["vitest.config.ts", "vitest.setup.ts", "package.json"])
			write(root, f, "{}\n");
		write(root, ".gitignore", ".claude/tmp/\n");
		write(root, EDGES_FILE, JSON.stringify({ edges: {} }));
		return root;
	};
	const commit = (root: string) => {
		git(root, "add", "-A");
		git(
			root,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=T",
			"commit",
			"-q",
			"-m",
			"base",
		);
	};

	it.skipIf(!STRACE)(
		"voids the row on a file only a stub the test wrote read (#4966)",
		() => {
			const root = keyed();
			const log = audited(root, T, runsTool(root, stubTool(READS_SETTINGS)));
			commit(root);
			expect(recordRun(root, log)).toBe(1);
			expect(isCached(root)).toBe(true);

			write(root, ".claude/settings.json", '{"hooks":{"Stop":[]}}\n');
			expect(isCached(root)).toBe(false);
		},
	);

	it("voids the row on a skill dir added, and on a settings file read through a helper's default root", () => {
		const root = keyed();
		const log = audited(
			root,
			T,
			[
				'require("./lib/hooks.js")();',
				'require("node:fs").readdirSync(require("node:path").join(__dirname, "../.claude/skills"));',
			].join("\n"),
		);
		commit(root);
		expect(recordRun(root, log)).toBe(1);
		expect(isCached(root)).toBe(true);

		write(root, ".claude/skills/three/SKILL.md", "three\n");
		expect(isCached(root)).toBe(false);
		fs.rmSync(path.join(root, ".claude/skills/three"), { recursive: true });
		expect(isCached(root)).toBe(true);

		write(root, ".claude/settings.json", '{"hooks":{"Stop":[]}}\n');
		expect(isCached(root)).toBe(false);
	});
});

describe("a read it cannot charge to one test file records no row for it", () => {
	function logs(files: Record<string, object[]>) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rda-log-"));
		dirs.push(dir);
		for (const [name, lines] of Object.entries(files))
			fs.writeFileSync(
				path.join(dir, name),
				lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
			);
		return dir;
	}
	const self = (pid: number) => ({ k: "self", owner: "100", pid });

	it("doubts every file a process ran where it ran two", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [
				self(100),
				{ k: "claim", file: "a.test.ts" },
				{ k: "claim", file: "b.test.ts" },
			],
		});
		const found = readAudits(dir, root);
		expect(found.get("a.test.ts").doubt).toMatch(/more than one/);
		expect(found.get("b.test.ts").doubt).toMatch(/more than one/);
	});

	it("doubts a file whose Node child left no log", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [
				self(100),
				{ k: "claim", file: "a.test.ts" },
				{
					k: "child",
					file: process.execPath,
					args: ["x.js"],
					cwd: os.tmpdir(),
					audited: true,
					pid: 101,
				},
			],
		});
		expect(readAudits(dir, root).get("a.test.ts").doubt).toMatch(
			/left no audit log/,
		);
	});

	describe("off a child's trace (#4966)", () => {
		const Exit = "7 +++ exited with 0 +++\n";
		/** The audit of a file whose one child left `trace`, null for none. */
		const traced = (root: string, trace: string | null) => {
			const dir = logs({
				"100.100.jsonl": [
					self(100),
					{ k: "claim", file: "a.test.ts" },
					{ k: "child", file: "tool", args: ["api"], cwd: root, trace: "t" },
				],
			});
			if (trace !== null) fs.writeFileSync(path.join(dir, "t"), trace);
			let now = 0;
			const clock = {
				now: () => now,
				sleep: (ms: number) => {
					now += ms;
				},
			};
			return readAudits(dir, root, clock).get("a.test.ts");
		};

		it("holds the link a child read, and nothing for where it points", () => {
			const root = checkout();
			const audit = traced(
				root,
				[
					'7 readlink("/usr/bin/cat", "../lib/cargo/bin/coreutils/cat", 4095) = 30',
					`7 readlinkat(AT_FDCWD<${root}>, "scripts/lib/hooks.js", "elsewhere/gone", 4095) = 14`,
					Exit,
				].join("\n"),
			);
			expect(audit.doubt).toBeUndefined();
			expect(audit.reads.files).toContain("scripts/lib/hooks.js");
		});

		it("holds a path named with no directory beside it under each directory a process stood in", () => {
			const root = checkout();
			const audit = traced(
				root,
				[
					'7 chdir("scripts") = 0',
					'7 open("lib/hooks.js", O_RDONLY <unfinished ...>',
					'8 stat("nope", 0x7ffd) = -1 ENOENT (No such file or directory)',
					"7 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=8} ---",
					"7 <... open resumed>) = 3",
					"8 +++ exited with 0 +++",
					Exit,
				].join("\n"),
			);
			expect(audit.reads.files).toEqual(["scripts/lib/hooks.js"]);
			expect(audit.reads.absent).toEqual([
				"lib/hooks.js",
				"nope",
				"scripts/nope",
			]);
		});

		it.each([
			[
				"connected to a socket",
				`7 connect(3<socket:[9]>, {sa_family=AF_UNIX, sun_path="/run/bus"}, 21) = 0\n${Exit}`,
				/a traced child \(tool api\) reached a socket/,
			],
			[
				"addressed a datagram",
				`7 sendto(3<socket:[9]>, "x", 1, 0, {sa_family=AF_UNIX, sun_path="/run/log"}, 17) = 1\n${Exit}`,
				/reached a socket/,
			],
			[
				"signalled a process its trace does not follow",
				`7 kill(7, 0) = 0\n7 kill(999, SIGTERM) = 0\n${Exit}`,
				/signalled a process outside its trace/,
			],
			["left no trace", null, /left no trace/],
			["left a line cut short", `openat(AT_FD\n${Exit}`, /will not parse/],
			[
				"outlived the run",
				'7 openat(AT_FDCWD</x>, "a", O_RDONLY) = 3\n',
				/was still running/,
			],
		])("doubts a file whose child %s", (_what, trace, doubt) => {
			expect(traced(checkout(), trace).doubt).toMatch(doubt);
		});

		it("holds a file under a directory whose name the trace escaped", () => {
			const root = checkout();
			write(root, "d\u00e9/f", "x\n");
			const dir = `${root}/d\\303\\251`;
			const audit = traced(
				root,
				`7 openat(AT_FDCWD<${dir}>, "f", O_RDONLY) = 3<${dir}/f>\n${Exit}`,
			);
			expect(audit.reads.files).toEqual(["d\u00e9/f"]);
		});

		it("keeps the reads of a file whose child's connect reached nobody", () => {
			const refused = `7 connect(3<socket:[9]>, {sa_family=AF_UNIX, sun_path="/run/nscd"}, 110) = -1 ENOENT (No such file or directory)\n${Exit}`;
			expect(traced(checkout(), refused)).toHaveProperty("reads");
		});
	});

	it("keeps the reads of a file whose child a tracer already followed", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [
				self(100),
				{ k: "claim", file: "a.test.ts" },
				{ k: "child", file: "cat", args: ["x"], cwd: root, within: true },
			],
		});
		expect(readAudits(dir, root).get("a.test.ts")).toHaveProperty("reads");
	});

	it("doubts a file whose process faulted in its audit", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [self(100), { k: "claim", file: "a.test.ts" }],
			"100.101.jsonl": [self(101), { k: "fault" }],
		});
		expect(readAudits(dir, root).get("a.test.ts").doubt).toMatch(/faulted/);
	});

	it("doubts a sleep in the checkout whose log names its program as no list of paths", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [
				self(100),
				{ k: "claim", file: "a.test.ts" },
				{
					k: "child",
					file: "sleep",
					bin: "/usr/bin/sleep",
					args: ["0"],
					cwd: root,
				},
			],
		});
		expect(readAudits(dir, root).get("a.test.ts").doubt).toMatch(
			/ran in the checkout/,
		);
	});

	it("doubts a file whose log holds a line that will not parse", () => {
		const root = checkout();
		const dir = logs({
			"100.100.jsonl": [self(100), { k: "claim", file: "a.test.ts" }],
		});
		fs.appendFileSync(path.join(dir, "100.100.jsonl"), '{"k":"probe","p":');
		expect(readAudits(dir, root).get("a.test.ts").doubt).toMatch(/faulted/);
	});
});

describe("arming", () => {
	it("puts the preload on NODE_OPTIONS beside what was there, and arms no nested run", () => {
		const root = checkout();
		const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=99" };
		const dir = install(root, env);
		dirs.push(dir);
		const preload = path.join(__dirname, "read-audit-preload.js");
		expect(env.NODE_OPTIONS).toBe(
			`--max-old-space-size=99 --import=${JSON.stringify(pathToFileURL(preload).href)}`,
		);
		expect(install(root, { WFC_READ_AUDIT_OWNER: "1" })).toBeNull();
		remove(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("names no tracer where the run's PATH holds none", () => {
		const env: NodeJS.ProcessEnv = {
			PATH: os.tmpdir(),
			WFC_READ_AUDIT_STRACE: "/usr/bin/strace",
		};
		const said: string[] = [];
		dirs.push(install(checkout(), env, { write: (s: string) => said.push(s) }));
		expect(env.WFC_READ_AUDIT_STRACE).toBeUndefined();
		expect(said.join("")).toMatch(
			/no working strace .* records no pass-store row/,
		);
	});
});
