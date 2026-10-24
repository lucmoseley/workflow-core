// @vitest-environment node
/*
 * Pins which scripts check-cli-args.js finds reading argv by hand rather than
 * through a strict parser, and that `--against HEAD` refuses only a script the
 * commit adds or edits, warning on an untouched one.
 *
 * check-cli-args.js (#920) against fabricated scripts in a throwaway git
 * repo, never this one: the live scripts/ changes with every commit.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here loosens
 * that gate — and a script that runs on `--help` or an unknown flag, the shape
 * that stopped five live sessions at #920, lands unrefused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-cli-args.js");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const script = (name: string, body: string) => {
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "scripts", name), body);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const HAND_ROLLED = 'const dry = process.argv.includes("--dry-run");\n';
const ON_HELPER =
	'const { parseOrExit } = require("./lib/cli-args");\nparseOrExit(process.argv.slice(2), SPEC);\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-args-"));
	/* An empty hooks dir, so the scratch repo never runs this checkout's
	 * Husky gates through its absolute core.hooksPath. */
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "cli-args-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-cli-args", () => {
	it("FAILs a script reading argv by hand, naming it and the fix", () => {
		script("reap.js", HAND_ROLLED);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 script(s) read(s) the command line without a strict parser, so --help and an unknown flag fall through to the default action: reap.js.",
		);
		expect(r.out).toContain("Fix: parse it with node:util's parseArgs");
	});

	it("passes a script on the helper, one reading only its own path, and one citing argv in a comment", () => {
		script("on.js", ON_HELPER);
		script("self.js", "spawn(process.execPath, [process.argv[1]]);\n");
		script("cites.js", "/* reads process.argv.slice(2) */\n// process.argv\n");
		script("lib-less.js", "module.exports = 1;\n");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 4 script(s), every argv reader on a strict parser.",
		);
	});

	it("passes node:util's parseArgs in each import spelling, and commander", () => {
		const parse = "parseArgs({ args: process.argv.slice(2), options: {} });\n";
		script("cjs.js", `const { parseArgs } = require("node:util");\n${parse}`);
		script("esm.js", `import { parseArgs } from "util";\n${parse}`);
		script(
			"ns.js",
			'const util = require("node:util");\nutil.parseArgs({ args: process.argv.slice(2) });\n',
		);
		script(
			"cmd.js",
			'const { program } = require("commander");\nprogram.option("--dry-run").parse(process.argv);\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 4 script(s)");
	});

	it("FAILs a lax parse, even one never naming process.argv", () => {
		script(
			"lax.js",
			'const { parseArgs } = require("node:util");\nparseArgs({ options: {}, strict: false });\n',
		);
		script(
			"loose.js",
			'const { program } = require("commander");\nprogram.allowUnknownOption().parse();\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(": lax.js, loose.js.");
		expect(r.out).toContain("Fix: ");
	});

	it("FAILs a hand-rolled parseArgs, declared or imported from a local util, naming each", () => {
		script(
			"own.js",
			`const { promisify } = require("node:util");\nfunction parseArgs(a) { return a; }\nparseArgs(process.argv.slice(2));\n`,
		);
		script(
			"local.js",
			'const util = require("./util");\nutil.parseArgs(process.argv.slice(2));\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(": local.js, own.js.");
		expect(r.out).toContain("Fix: ");
	});

	// A naive strip ran from the string's slash-star to the next star-slash.
	it("sees a read after a string holding a comment opener", () => {
		script(
			"glob.js",
			`const g = "scripts/*.js";\n${HAND_ROLLED}/* a later comment */\n`,
		);
		expect(run().status).toBe(1);
	});

	it("honours the opt-out marker only where it gives a reason", () => {
		script(
			"wrap.js",
			`/* cli-args-exempt: passes argv through to vitest untouched */\n${HAND_ROLLED}`,
		);
		expect(run().status).toBe(0);
		script("bare.js", `/* cli-args-exempt: */\n${HAND_ROLLED}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(": bare.js.");
	});

	it("skips scripts/lib and non-.js files", () => {
		fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "lib", "x.js"), HAND_ROLLED);
		script("x.test.ts", HAND_ROLLED);
		expect(run().status).toBe(0);
	});

	it("emits a --json envelope carrying each fault's file and content hash", () => {
		script("reap.js", HAND_ROLLED);
		const r = runInProcess(SCRIPT, ["--json"], {
			cwd: root,
			env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
		});
		const envelope = JSON.parse(r.stdout);
		expect(envelope).toMatchObject({
			checker: "cli-args",
			outcome: "FAIL",
			scanned: 1,
		});
		expect(envelope.findings).toEqual([
			expect.objectContaining({
				severity: "FAIL",
				tag: "CLI-ARGS",
				file: "scripts/reap.js",
				content: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		]);
	});

	describe("--against HEAD, the pre-commit form", () => {
		const seed = () => {
			script("old.js", HAND_ROLLED);
			git("add", ".");
			git("commit", "-qm", "seed");
		};

		it("refuses a new script reading argv by hand, naming it", () => {
			seed();
			script("new.js", HAND_ROLLED);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("this commit adds them");
			expect(r.out).toContain("scripts/new.js read(s) the command line");
			expect(r.out).not.toContain("scripts/old.js read(s)");
		});

		it("warns and passes on an inherited script the commit leaves alone", () => {
			seed();
			script("on.js", ON_HELPER);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN: 1 inherited fault(s)");
		});

		it("refuses an edit to an inherited script still on no strict parser, naming the script", () => {
			seed();
			script("old.js", `${HAND_ROLLED}// an unrelated edit\n`);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("scripts/old.js read(s) the command line");
		});

		it("passes the edit that moves an inherited script onto the helper", () => {
			seed();
			script("old.js", ON_HELPER);
			git("add", ".");
			expect(run("--against", "HEAD").status).toBe(0);
		});

		it("judges the index, not the worktree", () => {
			seed();
			script("new.js", HAND_ROLLED);
			expect(run("--against", "HEAD").status).toBe(0);
		});
	});
});
