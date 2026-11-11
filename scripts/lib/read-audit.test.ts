// @vitest-environment node
/*
 * The read audit (#4916): real Node processes under the preload, on a
 * throwaway checkout, and the logs they leave read back into each test
 * file's reads. Loosen a case and the pass store caches a file whose verdict
 * rests on a read nobody recorded.
 *
 * Cost: every case runs one to three real Node processes under the preload,
 * and a traced one its tracer; some spawn real git, tar or systemctl too.
 * The spawn hooks, the links a hand goes through and what those programs
 * run are what is under test, which no seeded log reaches.
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
const { parseJsonl } = require("./jsonl.js");

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

	it("doubts a checkout script a shell child no tracer followed ran from outside the checkout, which reads off its own directory, and one run in the checkout (#4790 pass 3)", () => {
		const root = checkout();
		write(root, "scripts/data.txt", "x\n");
		write(root, "scripts/run.sh", 'cat "$(dirname "$0")/data.txt"\n');
		const spawn = (cwd: string) =>
			`require("node:child_process").execFileSync("bash", [${JSON.stringify(path.join(root, "scripts/run.sh"))}], { cwd: ${JSON.stringify(cwd)} });`;
		const outside = audited(root, T, spawn(os.tmpdir()), { trace: false });
		expect(readAudits(outside, root).get(T).doubt).toMatch(
			/a shell child \(bash .*run\.sh\) ran a checkout script that no tracer followed/,
		);
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
			dirs.push(scratch);
			fs.copyFileSync(
				path.join(root, "bin/sleep"),
				path.join(scratch, "sleep"),
			);
			fs.chmodSync(path.join(scratch, "sleep"), 0o755);
			expect(sleepOn(scratch)).toMatch(/ran in the checkout/);

			const relinked = fs.mkdtempSync(path.join(os.tmpdir(), "rda-link-"));
			dirs.push(relinked);
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
				 * under the tracer; the 30 s sleep, one far past it. */
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

	it.each([
		["by its path", "#!/bin/sh", (sh: string) => `${quoted(sh)}, []`, ""],
		[
			"through env, by its name off PATH",
			"#!/usr/bin/env bash",
			() => `"run.sh", []`,
			"scripts",
		],
	])(
		"holds what a shell script of the checkout run as the program itself, %s, reads off its own directory, where a tracer followed it (#4790 pass 3, #4982)",
		(_how, line, program, onPath) => {
			const root = checkout();
			write(root, "scripts/data.txt", "x\n");
			const sh = path.join(root, "scripts/run.sh");
			write(
				root,
				"scripts/run.sh",
				`${line}\ncat "$(dirname "$0")/data.txt"\n`,
			);
			fs.chmodSync(sh, 0o755);
			/* The checkout stands outside the child's temporary directory, so
			 * the script is no stub a test wrote. */
			const tmp = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "rda-tmp-")),
			);
			dirs.push(tmp);
			const dir = quoted(path.join(root, onPath) + path.delimiter);
			const log = audited(
				root,
				T,
				`require("node:child_process").execFileSync(${program(sh)}, { cwd: ${quoted(tmp)}, env: { ...process.env, PATH: ${dir} + process.env.PATH } });`,
				{ env: { TMPDIR: tmp } },
			);
			const audit = readAudits(log, root).get(T);
			expect(audit.doubt).toBeUndefined();
			expect(audit.reads.files).toEqual(
				expect.arrayContaining(["scripts/data.txt", "scripts/run.sh"]),
			);
		},
	);

	it("holds what a checkout script a shell was handed from outside the checkout reads off its own directory, where a tracer followed it", () => {
		const root = checkout();
		write(root, "scripts/data.txt", "x\n");
		write(root, "scripts/run.sh", 'cat "$(dirname "$0")/data.txt"\n');
		const audit = reads(
			root,
			`require("node:child_process").execFileSync("sh", [${quoted(path.join(root, "scripts/run.sh"))}], { cwd: ${quoted(os.tmpdir())} });`,
		);
		expect(audit.reads.files).toEqual(
			expect.arrayContaining(["scripts/data.txt", "scripts/run.sh"]),
		);
	});

	it("holds what a shell script of the checkout reads off its own directory where a tracer followed it, as a stub", () => {
		const root = checkout();
		write(root, "scripts/data.txt", "x\n");
		const sh = path.join(root, "scripts/run.sh");
		write(
			root,
			"scripts/run.sh",
			'#!/bin/sh\ncat "$(dirname "$0")/data.txt"\n',
		);
		fs.chmodSync(sh, 0o755);
		const audit = reads(
			root,
			`require("node:child_process").execFileSync(${quoted(sh)}, [], { cwd: ${quoted(os.tmpdir())} });`,
		);
		expect(audit.reads.files).toEqual(
			expect.arrayContaining(["scripts/data.txt", "scripts/run.sh"]),
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

	it("runs untraced, and doubts, a stub whose environment asks for no tracer", () => {
		const root = checkout();
		const body = runsTool(root, stubTool("#!/bin/sh\necho '{}'\n")).replace(
			"...process.env,",
			'...process.env, WFC_READ_AUDIT_UNTRACED: "1",',
		);
		expect(reads(root, body).doubt).toMatch(
			/a child \(tool api user\) ran in the checkout/,
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

describe("a child outside the checkout that is handed it (#4982)", () => {
	const outsideDir = () => {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rda-out-")),
		);
		dirs.push(dir);
		return dir;
	};
	const spawns = (
		program: string,
		args: string[],
		cwd: string,
		{ env = {} as Record<string, string>, input = "" } = {},
	) =>
		`try { require("node:child_process").execFileSync(${quoted(program)}, ${quoted(args)}, { cwd: ${quoted(cwd)}, env: { ...process.env, ...${quoted(env)} }, input: ${quoted(input)}, stdio: ["pipe", "ignore", "ignore"] }); } catch {}`;
	const untraced = (root: string, body: string) =>
		readAudits(audited(root, T, body, { trace: false }), root).get(T);
	const settingsFile = ".claude/settings.json";

	describe("with no tracer", () => {
		it("doubts a child whose environment names a checkout path", () => {
			const root = checkout();
			const body = spawns("cat", [], outsideDir(), {
				env: { RULES: path.join(root, ".claude") },
			});
			expect(untraced(root, body).doubt).toMatch(
				/a child \(cat \) was handed a path in the checkout by its environment \(RULES\)/,
			);
		});

		it("doubts a child whose sync input names a checkout path", () => {
			const root = checkout();
			const body = spawns("cat", [], outsideDir(), {
				input: `{"file_path":${quoted(path.join(root, settingsFile))}}`,
			});
			expect(untraced(root, body).doubt).toMatch(
				/was handed a path in the checkout on its standard input/,
			);
		});

		it("doubts a child handed a checkout path spelt relatively, as a word or an option's value", () => {
			const root = checkout();
			const cwd = outsideDir();
			const spelt = path.relative(cwd, path.join(root, settingsFile));
			expect(spelt.startsWith("..")).toBe(true);
			for (const word of [spelt, `--from=${spelt}`])
				expect(untraced(root, spawns("cat", [word], cwd)).doubt).toMatch(
					/a child \(cat .*\) was handed a path in the checkout$/,
				);
		});

		it("doubts a child handed a checkout path through a link, in an argument or a variable", () => {
			const root = checkout();
			const cwd = outsideDir();
			fs.symlinkSync(root, path.join(cwd, "in"));
			const byArg = spawns("cat", [`in/${settingsFile}`], cwd);
			expect(untraced(root, byArg).doubt).toMatch(
				/was handed a path in the checkout$/,
			);
			const bare = spawns("ls", ["in"], cwd);
			expect(untraced(root, bare).doubt).toMatch(
				/was handed a path in the checkout$/,
			);
			const byEnv = spawns("cat", [], cwd, {
				env: { RULES: path.join(cwd, "in/.claude") },
			});
			expect(untraced(root, byEnv).doubt).toMatch(/by its environment/);
		});

		it("doubts a child handed a link's bare name in a variable, a link glued to an option, one on its input, or a link to stand in", () => {
			const root = checkout();
			const cwd = outsideDir();
			fs.symlinkSync(root, path.join(cwd, "in"));
			const doubtOf = (body: string) => untraced(root, body).doubt;
			expect(doubtOf(spawns("cat", [], cwd, { env: { RULES: "in" } }))).toMatch(
				/by its environment \(RULES\)/,
			);
			expect(doubtOf(spawns("ls", [`-I${path.join(cwd, "in")}`], cwd))).toMatch(
				/was handed a path in the checkout$/,
			);
			expect(
				doubtOf(
					spawns("cat", [], cwd, { input: path.join(cwd, "in", settingsFile) }),
				),
			).toMatch(/on its standard input/);
			expect(doubtOf(spawns("ls", [], path.join(cwd, "in")))).toMatch(
				/ran in the checkout/,
			);
		});

		it("passes a variable the setup settled to a program traced to read none, and to no other, a Node child's included", () => {
			const root = checkout();
			const cwd = outsideDir();
			const settled = {
				env: { RULES: path.join(root, ".claude") },
				trace: false,
			};
			const audit = (body: string) =>
				readAudits(
					audited(
						root,
						T,
						`globalThis.__wfcReadAudit.settle();\n${body}`,
						settled,
					),
					root,
				).get(T);
			expect(audit(spawns("grep", ["x", "/dev/null"], cwd))).toHaveProperty(
				"reads",
			);
			expect(audit(spawns("awk", ["BEGIN{}"], cwd)).doubt).toMatch(
				/a child \(awk BEGIN\{\}\) was handed a path in the checkout by its environment \(RULES\)/,
			);
			const below = `require("node:child_process").execFileSync(process.execPath, ["-e", ${quoted(spawns("grep", ["x", "/dev/null"], cwd, { env: { MINE: root } }))}], { cwd: ${quoted(cwd)} });`;
			expect(audit(below).doubt).toMatch(/by its environment \(MINE\)/);
			const unsettled = readAudits(
				audited(root, T, spawns("grep", ["x", "/dev/null"], cwd), settled),
				root,
			).get(T);
			expect(unsettled.doubt).toMatch(/by its environment \(RULES\)/);
		});

		it("doubts a git the guard runs for with the audit stripped, which logs nothing", () => {
			const root = checkout();
			const body = `const env = { ...process.env, PATH: ${quoted(GUARD_DIR + path.delimiter)} + process.env.PATH }; delete env.WFC_READ_AUDIT; try { require("node:child_process").execFileSync("git", ["-C", ${quoted(root)}, "status"], { cwd: ${quoted(outsideDir())}, env, stdio: "ignore" }); } catch {}`;
			expect(untraced(root, body).doubt).toMatch(
				/a child \(git -C .* status\) was handed a path in the checkout$/,
			);
		});

		it("doubts a shell whose PATH holds a checkout directory, from outside", () => {
			const root = checkout();
			const body = spawns("sh", ["-c", "tool"], outsideDir(), {
				env: {
					PATH: `${path.join(root, "scripts")}${path.delimiter}${process.env.PATH}`,
				},
			});
			expect(untraced(root, body).doubt).toMatch(/by its environment \(PATH\)/);
		});

		it("doubts a git with the audit stripped in a scratch directory under the root that is no repository, or steered by GIT_DIR", () => {
			const root = checkout();
			const stripped = (args: string[], cwd: string, env = {}) =>
				`const env = { ...process.env, ...${quoted(env)}, PATH: ${quoted(GUARD_DIR + path.delimiter)} + process.env.PATH }; delete env.WFC_READ_AUDIT; try { require("node:child_process").execFileSync("git", ${quoted(args)}, { cwd: ${cwd}, env, stdio: "ignore" }); } catch {}`;
			const inScratch = [
				`const scratch = require("node:fs").mkdtempSync(${quoted(path.join(root, "tmp-"))});`,
				stripped(["rev-parse", "--show-toplevel"], "scratch"),
			].join("\n");
			expect(untraced(root, inScratch).doubt).toMatch(
				/by the repository it finds from its directory/,
			);
			const own = inScratch.replace(
				"const env",
				'require("node:fs").mkdirSync(scratch + "/.git"); const env',
			);
			expect(untraced(root, own)).toHaveProperty("reads");
			const steered = stripped(["status"], quoted(outsideDir()), {
				GIT_DIR: path.join(root, ".git"),
				GIT_WORK_TREE: root,
			});
			expect(untraced(root, steered).doubt).toMatch(
				/by its environment \(GIT_/,
			);
		});

		it("keeps the reads of a file whose child is handed only its own scratch, the audit's own variables or a node_modules on PATH", () => {
			const root = checkout();
			const cwd = outsideDir();
			const bin = path.join(root, "node_modules/.bin");
			const body = [
				`const scratch = require("node:fs").mkdtempSync(${quoted(path.join(root, "tmp-"))});`,
				spawns("cat", [], cwd, {
					env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
				}).replace("...process.env,", "...process.env, SCRATCH: scratch,"),
				spawns("cat", ["no-such-file", "../also-none"], cwd),
			].join("\n");
			expect(untraced(root, body)).toHaveProperty("reads");
		});

		it("keeps the reads of a file whose sleep inherits a variable naming the checkout, as it reads none", () => {
			const root = checkout();
			const body = spawns("sleep", ["0"], outsideDir(), {
				env: { RULES: root },
			});
			expect(untraced(root, body)).toHaveProperty("reads");
		});

		it("weighs only git's own variables on a real git outside the checkout", () => {
			const root = checkout();
			const real = execFileSync("sh", ["-c", "command -v git"], {
				encoding: "utf8",
			}).trim();
			const cwd = outsideDir();
			const other = spawns(real, ["--version"], cwd, { env: { RULES: root } });
			expect(untraced(root, other)).toHaveProperty("reads");
			const steered = spawns(real, ["--version"], cwd, {
				env: { GIT_DIR: path.join(root, ".git") },
			});
			expect(untraced(root, steered).doubt).toMatch(
				/by its environment \(GIT_DIR\)/,
			);
		});
	});

	describe.skipIf(!STRACE)("under the tracer", () => {
		const traced = (root: string, body: string) =>
			readAudits(audited(root, T, body), root).get(T);

		it("holds the file a stub read by a variable's name, and voids nothing for one it did not", () => {
			const root = checkout();
			const stub = stubTool('#!/bin/sh\ncat "$RULES/settings.json"\n');
			const body = spawns(path.join(stub, "tool"), [], outsideDir(), {
				env: { RULES: path.join(root, ".claude") },
			});
			const audit = traced(root, body);
			expect(audit.reads.files).toContain(settingsFile);
			expect(audit.reads.files).not.toContain("scripts/lib/hooks.js");
		});

		it("holds what a program file of the checkout's own read, run from outside by a variable every child inherits", () => {
			const root = checkout();
			write(root, "scripts/hook.sh", '#!/bin/sh\ncat "$RULES/settings.json"\n');
			fs.chmodSync(path.join(root, "scripts/hook.sh"), 0o755);
			const body = spawns(path.join(root, "scripts/hook.sh"), [], outsideDir());
			const log = audited(root, T, body, {
				env: { RULES: path.join(root, ".claude") },
			});
			expect(readAudits(log, root).get(T).reads.files).toContain(settingsFile);
		});

		it("holds what a checkout script read that a shell found through PATH, from outside", () => {
			const root = checkout();
			write(
				root,
				"scripts/tool",
				`#!/bin/sh\ncat ${path.join(root, settingsFile)}\n`,
			);
			fs.chmodSync(path.join(root, "scripts/tool"), 0o755);
			const body = spawns("sh", ["-c", "tool"], outsideDir(), {
				env: {
					PATH: `${path.join(root, "scripts")}${path.delimiter}${process.env.PATH}`,
				},
			});
			const files = traced(root, body).reads.files;
			expect(files).toContain(settingsFile);
			expect(files).toContain("scripts/tool");
		});

		it("holds the file a shell read off its sync input", () => {
			const root = checkout();
			const body = spawns("sh", ["-c", 'cat "$(cat)"'], outsideDir(), {
				input: path.join(root, settingsFile),
			});
			expect(traced(root, body).reads.files).toContain(settingsFile);
		});

		it("holds the file a shell read by a relative spelling from outside", () => {
			const root = checkout();
			const cwd = outsideDir();
			const spelt = path.relative(cwd, path.join(root, settingsFile));
			const body = spawns("sh", ["-c", `cat ${spelt}`], cwd);
			expect(traced(root, body).reads.files).toContain(settingsFile);
		});
	});
});

describe("the routes still open after #4982 (#4997)", () => {
	const outsideDir = () => {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rda-out-")),
		);
		dirs.push(dir);
		return dir;
	};
	const untraced = (root: string, body: string) =>
		readAudits(audited(root, T, body, { trace: false }), root).get(T);
	const settingsFile = ".claude/settings.json";
	const realGit = execFileSync("sh", ["-c", "command -v git"], {
		encoding: "utf8",
	}).trim();

	describe("input written to a child's pipe once it runs", () => {
		/** A body that starts `cat` and writes `chunks` down its input. */
		const writes = (cwd: string, chunks: string[]) =>
			[
				`const c = require("node:child_process").spawn("cat", [], { cwd: ${quoted(cwd)}, stdio: ["pipe", "ignore", "ignore"] });`,
				...chunks.map((chunk) => `c.stdin.write(${quoted(chunk)});`),
				"c.stdin.end();",
			].join("\n");

		it("doubts a checkout path written whole, as a buffer, or split across two writes", () => {
			const root = checkout();
			const cwd = outsideDir();
			const file = path.join(root, settingsFile);
			const cut = Math.floor(file.length / 2);
			for (const chunks of [[file], [file.slice(0, cut), file.slice(cut)]])
				expect(untraced(root, writes(cwd, chunks)).doubt).toMatch(
					/a child \(cat \) was written a path in the checkout down a pipe/,
				);
			const asBuffer = writes(cwd, []).replace(
				"c.stdin.end();",
				`c.stdin.end(Buffer.from(${quoted(file)}));`,
			);
			expect(untraced(root, asBuffer).doubt).toMatch(/down a pipe/);
		});

		it("doubts a checkout path written down a pipe on a descriptor past the standard three", () => {
			const root = checkout();
			const file = path.join(root, settingsFile);
			const body = `const c = require("node:child_process").spawn("cat", [], { cwd: ${quoted(outsideDir())}, stdio: ["ignore", "ignore", "ignore", "pipe"] });\nc.stdio[3].on("error", () => {});\nc.stdio[3].end(${quoted(file)});`;
			expect(untraced(root, body).doubt).toMatch(
				/a child \(cat \) was written a path in the checkout down a pipe/,
			);
		});

		it("keeps the reads of a file that writes a child only its own scratch, or nothing of the checkout", () => {
			const root = checkout();
			const cwd = outsideDir();
			const body = [
				`const scratch = require("node:fs").mkdtempSync(${quoted(path.join(root, "tmp-"))});`,
				writes(cwd, ["plain text\n"]).replace(
					"c.stdin.end();",
					"c.stdin.end(scratch);",
				),
			].join("\n");
			expect(untraced(root, body)).toHaveProperty("reads");
		});
	});

	describe("what real git runs", () => {
		/** A fixture repository outside the checkout, with a hook if asked. */
		const fixture = (hook?: string) => {
			const dir = outsideDir();
			git(dir, "init", "-q");
			if (hook !== undefined) {
				write(dir, "hooks/pre-commit", hook);
				fs.chmodSync(path.join(dir, "hooks/pre-commit"), 0o755);
				git(dir, "config", "core.hooksPath", "hooks");
			}
			return dir;
		};
		const runsGit = (
			cwd: string,
			args: string[],
			env: Record<string, string> = {},
		) =>
			`require("node:child_process").execFileSync(${quoted(realGit)}, ${quoted(args)}, { cwd: ${quoted(cwd)}, env: { ...process.env, ...${quoted(env)} }, stdio: "ignore" });`;
		const commit = ["-c", "user.email=t@t", "-c", "user.name=t"];

		it("doubts a git that ran a hook, which inherits every variable unweighed", () => {
			const root = checkout();
			const repo = fixture(
				`#!/bin/sh\ncat "$RULES/settings.json" >/dev/null\n`,
			);
			const body = runsGit(
				repo,
				[...commit, "commit", "-q", "--allow-empty", "-m", "x"],
				{
					RULES: path.join(root, ".claude"),
				},
			);
			expect(untraced(root, body).doubt).toMatch(
				/a git call \(git .*commit.*\) ran hooks\/pre-commit \(hook\), whose reads no log holds/,
			);
		});

		it("doubts a git that ran a shell alias, and keeps one that ran only git", () => {
			const root = checkout();
			const repo = fixture();
			const shell = runsGit(repo, ["-c", "alias.zz=!true", "zz"]);
			expect(untraced(root, shell).doubt).toMatch(/ran true \(shell_alias\)/);
			const own = runsGit(repo, ["-c", "alias.st=status", "st"]);
			expect(untraced(root, own)).toHaveProperty("reads");
			const plain = runsGit(repo, [
				...commit,
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"x",
			]);
			expect(untraced(root, plain)).toHaveProperty("reads");
		});

		/** A body that starts git on `args` and, once it first answers, ends it
		 * by `stop`. */
		const stopped = (repo: string, args: string[], stop: string) =>
			[
				`const c = require("node:child_process").spawn(${quoted(realGit)}, ${quoted(args)}, { cwd: ${quoted(repo)}, stdio: ["pipe", "pipe", "ignore"] });`,
				`c.stdout.once("data", () => ${stop});`,
				'c.stdin.write("HEAD\\n");',
			].join("\n");

		it("keeps a git the test kills through its handle, which logs no end of its own", () => {
			const root = checkout();
			const body = stopped(fixture(), ["cat-file", "--batch"], "c.kill()");
			expect(untraced(root, body)).toHaveProperty("reads");
		});

		it("doubts a git killed past its handle, or once `git help` put a viewer in its place", () => {
			const root = checkout();
			const repo = fixture();
			const byPid = stopped(
				repo,
				["cat-file", "--batch"],
				"process.kill(c.pid)",
			);
			expect(untraced(root, byPid).doubt).toMatch(/logged no end/);
			const viewer = [
				"-c",
				"man.viewer=x",
				"-c",
				"man.x.cmd=echo up; sleep 30",
			];
			const help = stopped(repo, [...viewer, "help", "git"], "c.kill()");
			expect(untraced(root, help).doubt).toMatch(/logged no end/);
		});

		it("doubts a git handed an event target of its own, which leaves what it ran unlogged", () => {
			const root = checkout();
			const repo = fixture();
			const body = runsGit(repo, ["status"], {
				GIT_TRACE2_EVENT: path.join(repo, "events.json"),
			});
			expect(untraced(root, body).doubt).toMatch(
				/named an event target of its own/,
			);
		});
	});

	describe("a relative path glued behind a prefix", () => {
		it("doubts a link glued to an option with no slash before it, with or without a path after", () => {
			const root = checkout();
			const cwd = outsideDir();
			fs.symlinkSync(root, path.join(cwd, "in"));
			const spawns = (args: string[]) =>
				`try { require("node:child_process").execFileSync("ls", ${quoted(args)}, { cwd: ${quoted(cwd)}, stdio: "ignore" }); } catch {}`;
			for (const word of ["-Iin/.claude", "-Iin"])
				expect(untraced(root, spawns([word])).doubt).toMatch(
					/a child \(ls .*\) was handed a path in the checkout$/,
				);
			expect(untraced(root, spawns(["-Ino-such/x"]))).toHaveProperty("reads");
		});

		it("doubts `..` stuck to a short-option cluster from a scratch directory, which names the checkout", () => {
			const root = checkout();
			const body = [
				`const scratch = require("node:fs").mkdtempSync(${quoted(path.join(root, "tmp-"))});`,
				'try { require("node:child_process").execFileSync("ls", ["-dI.."], { cwd: scratch, stdio: "ignore" }); } catch {}',
			].join("\n");
			expect(untraced(root, body).doubt).toMatch(
				/a child \(ls -dI\.\.\) was handed a path in the checkout$/,
			);
		});
	});

	describe("the repository a git looks for", () => {
		const stripped = (args: string[], cwd: string) =>
			`const env = { ...process.env, PATH: ${quoted(GUARD_DIR + path.delimiter)} + process.env.PATH }; delete env.WFC_READ_AUDIT; try { require("node:child_process").execFileSync("git", ${quoted(args)}, { cwd: ${cwd}, env, stdio: "ignore" }); } catch {}`;
		const minting = (root: string) =>
			`const scratch = require("node:fs").mkdtempSync(${quoted(path.join(root, "tmp-"))});`;

		it("doubts a git moved by -C into a scratch directory under the root that is no repository, from outside", () => {
			const root = checkout();
			const body = [
				minting(root),
				stripped(
					["-C", "PLACE", "rev-parse", "--show-toplevel"],
					quoted(outsideDir()),
				),
			]
				.join("\n")
				.replace('"PLACE"', "scratch");
			expect(untraced(root, body).doubt).toMatch(
				/by the repository it finds from its directory/,
			);
		});

		it("keeps a git moved by -C out of the checkout from a directory under it", () => {
			const root = checkout();
			const away = outsideDir();
			git(away, "init", "-q");
			const body = [
				minting(root),
				stripped(["-C", away, "status"], "scratch"),
			].join("\n");
			expect(untraced(root, body)).toHaveProperty("reads");
		});

		it("keeps an init or a clone, which looks for none, and doubts one asked for --help, which does", () => {
			const root = checkout();
			const inScratch = (args: string[]) =>
				[minting(root), stripped(args, "scratch")].join("\n");
			expect(untraced(root, inScratch(["init", "-q", "made"]))).toHaveProperty(
				"reads",
			);
			expect(
				untraced(
					root,
					inScratch(["-c", "init.defaultBranch=x", "init", "-q", "made"]),
				),
			).toHaveProperty("reads");
			const source = outsideDir();
			git(source, "init", "-q");
			expect(
				untraced(root, inScratch(["clone", "-q", source, "made"])),
			).toHaveProperty("reads");
			/* `git help` runs `man`, which the call's event log doubts first. */
			const log = audited(root, T, inScratch(["init", "--help"]), {
				trace: false,
			});
			const hands = fs
				.readdirSync(log)
				.filter((f) => f.endsWith(".jsonl"))
				.flatMap(
					(f) => parseJsonl(fs.readFileSync(path.join(log, f), "utf8")).rows,
				)
				.filter((e) => e.k === "child" && e.args?.includes("--help"))
				.flatMap((e) => e.hands ?? []);
			expect(hands).toContainEqual({ by: "repo", p: ["."] });
		});

		it("doubts a bare git whose -C words walked out of a scratch directory into the checkout before --bare, and keeps one left in it", () => {
			const root = checkout();
			const walked = [
				minting(root),
				stripped(
					["-C", "PLACE", "-C", "..", "--bare", "rev-parse", "--git-dir"],
					quoted(outsideDir()),
				),
			]
				.join("\n")
				.replace('"PLACE"', "scratch");
			expect(untraced(root, walked).doubt).toMatch(
				/by the repository it finds from its directory/,
			);
			const inScratch = [
				minting(root),
				stripped(["--bare", "rev-parse", "--git-dir"], "scratch"),
			].join("\n");
			expect(untraced(root, inScratch)).toHaveProperty("reads");
			/* git takes the repository where `--bare` is read: -C words after
			 * it move only the work tree. */
			const after = [
				minting(root),
				stripped(
					["--bare", "-C", "PLACE", "-C", "..", "rev-parse", "--git-dir"],
					quoted(outsideDir()),
				),
			]
				.join("\n")
				.replace('"PLACE"', "scratch");
			expect(untraced(root, after).doubt ?? "").not.toMatch(
				/by the repository/,
			);
		});
	});

	describe("a program measured to read no variable, run on a settled one", () => {
		const settled = (root: string, body: string) =>
			readAudits(
				audited(root, T, `globalThis.__wfcReadAudit.settle();\n${body}`, {
					env: { RULES: path.join(root, ".claude") },
					trace: false,
				}),
				root,
			).get(T);
		const tar = (cwd: string, args: string[], env = {}) =>
			`try { require("node:child_process").execFileSync("tar", ${quoted(args)}, { cwd: ${quoted(cwd)}, env: { ...process.env, ...${quoted(env)} }, stdio: "ignore" }); } catch {}`;

		it("keeps a plain tar, and doubts one asked to run a command, by a long option, its prefix or a short one", () => {
			const root = checkout();
			const cwd = outsideDir();
			fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
			execFileSync("tar", ["-cf", "a.tar", "a.txt"], { cwd });
			expect(settled(root, tar(cwd, ["-tf", "a.tar"]))).toHaveProperty("reads");
			for (const args of [
				["--to-command=cat", "-xf", "a.tar"],
				["--to-com=cat", "-xf", "a.tar"],
				["-I", "cat", "-xf", "a.tar"],
				["xIf", "cat", "a.tar"],
			])
				expect(settled(root, tar(cwd, args)).doubt).toMatch(
					/a child \(tar .*\) was handed a path in the checkout by its environment \(RULES\)/,
				);
		});

		it("doubts one whose PATH or TAR_OPTIONS the test changed, which steers what it runs", () => {
			const root = checkout();
			const cwd = outsideDir();
			fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
			execFileSync("tar", ["-cf", "a.tar", "a.txt"], { cwd });
			const stub = stubTool("#!/bin/sh\nexit 0\n");
			for (const env of [
				{ PATH: `${stub}${path.delimiter}${process.env.PATH}` },
				{ TAR_OPTIONS: "--to-command=cat" },
			])
				expect(settled(root, tar(cwd, ["-tf", "a.tar"], env)).doubt).toMatch(
					/by its environment \(RULES\)/,
				);
		});

		/* The timeout bounds a systemctl that waits on a user bus, or a host,
		 * this machine may not reach: 10 s, a guess far past the second or so
		 * one that answers takes. */
		const systemctl = (cwd: string, args: string[], env = {}) =>
			`try { require("node:child_process").execFileSync("systemctl", ${quoted(["--user", ...args, "--no-ask-password", "no-such.service"])}, { cwd: ${quoted(cwd)}, env: { ...process.env, EDITOR: "true", SYSTEMD_EDITOR: "true", ...${quoted(env)} }, stdio: "ignore", timeout: 10000 }); } catch {}`;

		it("keeps a plain systemctl, and one whose TAR_OPTIONS alone changed", () => {
			const root = checkout();
			const cwd = outsideDir();
			for (const env of [{}, { TAR_OPTIONS: "--to-command=cat" }])
				expect(
					settled(root, systemctl(cwd, ["is-active"], env)),
				).toHaveProperty("reads");
		});

		it("doubts a systemctl asked to edit, which runs an editor, or to reach a host, which runs ssh", () => {
			const root = checkout();
			const cwd = outsideDir();
			for (const args of [
				["edit"],
				["-H", "nowhere.invalid", "is-active"],
				["-Hnowhere.invalid", "is-active"],
				["--ho=nowhere.invalid", "is-active"],
			])
				expect(settled(root, systemctl(cwd, args)).doubt).toMatch(
					/a child \(systemctl .*\) was handed a path in the checkout by its environment/,
				);
		});
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
			[
				"left a trace no process ended in (#4790 pass 3)",
				"",
				/left an empty trace/,
			],
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

describe("the reads a row must not rest on unseen (#4790 pass 3)", () => {
	const Claim = { k: "claim", file: "a.test.ts" };
	const Self = { k: "self", owner: "100", pid: 100 };

	/** The guard's record of one git call: its field count, then each field. */
	const gitRecord = (dir: string, words: string[]) =>
		[String(words.length + 2), "", dir, ...words].map((f) => `${f}\0`).join("");

	/**
	 * The audit of a.test.ts off a log of `lines` and the guard's record of
	 * `calls`, each a directory and a git call's words.
	 */
	function judged(root: string, lines: object[], calls: [string, string[]][]) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rda-log-"));
		dirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "100.100.jsonl"),
			[Self, Claim, ...lines].map((l) => `${JSON.stringify(l)}\n`).join(""),
		);
		fs.writeFileSync(
			path.join(dir, "100.git"),
			calls.map(([at, words]) => gitRecord(at, words)).join(""),
		);
		return readAudits(dir, root).get("a.test.ts");
	}

	/** The audit of a real process running `body` as T under the preload. */
	const ran = (root: string, body: string) =>
		readAudits(audited(root, T, body, { trace: false }), root).get(T);

	it("judges a git call on this repository made from a test's own scratch as any other", () => {
		const root = checkout();
		const minted = [{ k: "minted", p: "scratch" }];
		const scratch = path.join(root, "scratch");
		expect(judged(root, minted, [[scratch, ["status"]]]).doubt).toMatch(
			/a git call \(git status\) read this repository/,
		);
		expect(judged(root, minted, [[scratch, ["ls-files"]]]).reads.git).toEqual([
			{ cwd: "scratch", args: ["ls-files"] },
		]);
	});

	it("doubts a guarded git handed a checkout path from outside, which no record holds", () => {
		const root = checkout();
		const call = (args: string[]) => ({
			k: "child",
			file: "git",
			args,
			cwd: os.tmpdir(),
			audited: true,
			guarded: true,
			pid: 101,
		});
		expect(judged(root, [call(["clone", root, "copy"])], []).doubt).toMatch(
			/a git call \(git clone .*\) was handed a path in the checkout/,
		);
		const compared = ["diff", "--no-index", "x", path.join(root, "scripts/x")];
		expect(judged(root, [call(compared)], []).doubt).toMatch(
			/was handed a path in the checkout/,
		);
		expect(judged(root, [call(["status"])], [])).toHaveProperty("reads");
	});

	it.each([
		[["cat-file", "--batch"]],
		[["cat-file", "--batch-check=%(objectname)"]],
		[["check-ignore", "--stdin"]],
		[["rev-list", "--stdin"]],
		[["diff", "--no-index", "-", "scripts/lib/hooks.js"]],
		[["grep", "-l", "-f-"]],
		[["ls-files", "-o", "--exclude-from=-"]],
		[["check-ignore", "--stdi", "-v"]],
		[["rev-list", "--std"]],
		[["name-rev", "--annotate-std"]],
		[["show-ref", "--exclude-e"]],
		[["show-ref", "--exclude-e=refs/heads/"]],
		[["cat-file", "--b"]],
		[["grep", "-l", "-f", "/dev/stdin"]],
		[["grep", "-lf/dev/stdin"]],
		[["grep", "-f", "/proc/self/fd/0"]],
		[["grep", "-f", "/proc/4242/fd/0"]],
		[["grep", "-l", "-f", "/dev/fd/3"]],
		[["ls-files", "-o", "--exclude-from=/dev/stdin"]],
		[["ls-files", "-o", "--exclude-from=/dev/./fd//0"]],
		[["diff", "--no-index", "/dev/stdin", "scripts/lib/hooks.js"]],
		[["diff", "--no-index", "../../dev/fd/0", "scripts/lib/hooks.js"]],
		[["grep", "-l", "--file=/../dev/stdin"]],
		[["grep", "-l", "-F/../dev/stdin"]],
		[["grep", "-l", "--file=/dev/stdout"]],
		[["grep", "-lf/dev/stderr"]],
	])(
		"doubts a git call fed by standard input, which a run again never has: %j",
		(words) => {
			const root = checkout();
			expect(judged(root, [], [[root, words]]).doubt).toMatch(
				/a git call \(git .*\) read its standard input/,
			);
			expect(
				judged(root, [], [[root, ["cat-file", "-p", "HEAD"]]]).reads.git,
			).toEqual([{ cwd: ".", args: ["cat-file", "-p", "HEAD"] }]);
		},
	);

	it.each([
		[["diff", "--no-index", "/dev/null", "scripts/lib/hooks.js"]],
		[["ls-files", "-o", "--exclude-from=dev/stdin.txt"]],
		[["ls-files", "--stage", "--exclude-standard"]],
		[["log", "--stat", "--all", "--branches", "--parents"]],
		[["rev-parse", "--abbrev-ref", "HEAD", "--"]],
	])(
		"keeps a git call whose options only resemble one fed by standard input: %j",
		(words) => {
			const root = checkout();
			expect(judged(root, [], [[root, words]]).reads.git).toEqual([
				{ cwd: ".", args: words },
			]);
		},
	);

	it("doubts a `git` a test wrote in a directory of the guard's name, which is not the guard (#4790 pass 3)", () => {
		const root = checkout();
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "rda-spoof-"));
		dirs.push(stub);
		const named = path.join(stub, "host-git-guard");
		fs.mkdirSync(named);
		fs.writeFileSync(path.join(named, "git"), READS_SETTINGS, { mode: 0o755 });
		expect(
			ran(
				root,
				`require("node:child_process").execFileSync("git", [], { cwd: ${quoted(root)}, env: { ...process.env, PATH: ${quoted(named + path.delimiter)} + process.env.PATH } });`,
			).doubt,
		).toMatch(/a child \(git \) ran in the checkout/);
	});

	it("doubts a shell script of the checkout run as the program itself that no tracer followed, and any other program there (#4790 pass 3)", () => {
		const root = checkout();
		const program = (file: string, text: string) => {
			write(root, file, text);
			fs.chmodSync(path.join(root, file), 0o755);
			return path.join(root, file);
		};
		const sh = program("scripts/run.sh", "#!/bin/sh\ntrue\n");
		const outside = quoted(os.tmpdir());
		expect(
			ran(
				root,
				`require("node:child_process").execFileSync(${quoted(sh)}, [], { cwd: ${outside} });`,
			).doubt,
		).toMatch(
			/a child \(run\.sh \) ran a shell script of the checkout that no tracer followed/,
		);

		const child = (abs: string, real = abs) => ({
			k: "child",
			file: abs,
			bin: [abs, real],
			args: [],
			cwd: os.tmpdir(),
		});
		const unread = /a child \(.*\) ran a program of the checkout/;
		const py = program("scripts/run.py", "#!/usr/bin/env python3\nprint(1)\n");
		expect(judged(root, [child(py)], []).doubt).toMatch(unread);
		const elf = program("scripts/tool", "\x7fELF");
		expect(judged(root, [child(elf)], []).doubt).toMatch(unread);
		/* A shell runs it, and the reach reads it by its name, as Python. */
		const misnamed = program("scripts/sh.py", "#!/bin/sh\ntrue\n");
		expect(judged(root, [child(misnamed)], []).doubt).toMatch(unread);
		const link = path.join(os.tmpdir(), "elsewhere", "run");
		expect(judged(root, [child(link, py)], []).doubt).toMatch(unread);
	});

	it("names the git guard a git call ran through, wherever it stands on PATH, and a shell script a tracer already followed", () => {
		const core = path.resolve(__dirname, "../..");
		const guard = path.join(GUARD_DIR, "git");
		const child = (file: string, bin: string[], how: object) => ({
			k: "child",
			file,
			bin,
			args: [],
			cwd: os.tmpdir(),
			...how,
		});
		const named = [path.relative(core, guard)];
		expect(
			judged(core, [child("git", [guard, guard], {})], []).reads.scripts,
		).toEqual(named);
		/* Through a link, it finds itself by another path. */
		const link = path.join(core, "scripts/lib/elsewhere/git");
		expect(judged(core, [child("git", [link, guard], {})], []).doubt).toMatch(
			/ran a program of the checkout/,
		);

		const root = checkout();
		write(root, "scripts/run.sh", "#!/bin/bash\ntrue\n");
		const run = path.join(root, "scripts/run.sh");
		fs.chmodSync(run, 0o755);
		expect(
			judged(root, [child(run, [run, run], { within: true })], []).reads
				.scripts,
		).toEqual(["scripts/run.sh"]);
	});

	it("holds a node script of the checkout run as the program itself by the log it left, and doubts one that left none", () => {
		const root = checkout();
		write(
			root,
			"scripts/tool.js",
			'#!/usr/bin/env node\nrequire("./lib/hooks.js")();\n',
		);
		const tool = path.join(root, "scripts/tool.js");
		fs.chmodSync(tool, 0o755);
		const reads = ran(
			root,
			`require("node:child_process").execFileSync(${quoted(tool)}, [], { cwd: ${quoted(os.tmpdir())} });`,
		).reads;
		expect(reads.scripts).toEqual(["scripts/tool.js"]);
		expect(reads.files).toContain(".claude/settings.json");

		const child = (isAudited: boolean) => ({
			k: "child",
			file: tool,
			bin: [tool, tool],
			args: [],
			cwd: os.tmpdir(),
			audited: isAudited,
			pid: 101,
		});
		expect(judged(root, [child(true)], []).doubt).toMatch(/left no audit log/);
		expect(judged(root, [child(false)], []).doubt).toMatch(/without the audit/);
	});

	it("doubts a Python or a shell child handed a checkout script from outside that no tracer followed, and names a shell's that one did (#4790 pass 3)", () => {
		const root = checkout();
		write(root, "scripts/run.py", "print(1)\n");
		write(root, "scripts/run.sh", "true\n");
		const child = (file: string, script: string, how = {}) => ({
			k: "child",
			file,
			args: [path.join(root, script)],
			cwd: os.tmpdir(),
			...how,
		});
		expect(
			judged(root, [child("python3", "scripts/run.py")], []).doubt,
		).toMatch(/a Python child \(python3 .*run\.py\) ran a checkout script/);
		for (const shell of ["bash", "sh"])
			expect(judged(root, [child(shell, "scripts/run.sh")], []).doubt).toMatch(
				/a shell child \(.*run\.sh\) ran a checkout script that no tracer followed/,
			);
		const followed = child("bash", "scripts/run.sh", { within: true });
		expect(judged(root, [followed], []).reads.scripts).toEqual([
			"scripts/run.sh",
		]);
	});

	it("holds a file read as a blob", () => {
		const root = checkout();
		const audit = ran(
			root,
			`require("node:fs").openAsBlob(${quoted(path.join(root, ".claude/settings.json"))}).then((b) => b.text());`,
		);
		expect(audit.reads.files).toContain(".claude/settings.json");
	});

	it("doubts a file that started a worker thread, and keeps the reads of one that started none", () => {
		const root = checkout();
		const audit = ran(
			root,
			`new (require("node:worker_threads").Worker)(${quoted(`require("node:fs").readFileSync(${quoted(path.join(root, ".claude/settings.json"))});`)}, { eval: true });`,
		);
		expect(audit.doubt).toMatch(/started a worker thread/);
		expect(ran(root, 'require("node:worker_threads");')).toHaveProperty(
			"reads",
		);
	});

	it("holds a checkout file a Node process read through a link standing outside the checkout", () => {
		const root = checkout();
		const outside = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "rda-link-")),
		);
		dirs.push(outside);
		fs.symlinkSync(
			path.join(root, ".claude/settings.json"),
			path.join(outside, "file"),
		);
		fs.symlinkSync(path.join(root, "scripts"), path.join(outside, "dir"));
		const audit = ran(
			root,
			[
				'const fs = require("node:fs");',
				`fs.readFileSync(${quoted(path.join(outside, "file"))});`,
				`fs.readFileSync(${quoted(path.join(outside, "dir/lib/hooks.js"))});`,
				`fs.existsSync(${quoted(path.join(outside, "dir/nope.js"))});`,
				`fs.existsSync(${quoted(path.join(outside, "nowhere"))});`,
			].join("\n"),
		);
		expect(audit.reads.files).toEqual(
			expect.arrayContaining([".claude/settings.json", "scripts/lib/hooks.js"]),
		);
		expect(audit.reads.absent).toEqual(["scripts/nope.js"]);
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
