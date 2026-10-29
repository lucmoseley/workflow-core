// @vitest-environment node
/*
 * Pins which test-file spawns check-test-spawn.js counts as spawning the
 * program under test, which stated reasons it honours, and that `--against
 * HEAD` refuses only a spawn the commit adds.
 *
 * check-test-spawn.js (#3458) against fabricated tests in a throwaway
 * directory, never this one.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets a
 * new test spawn node unrefused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-test-spawn.js");

let root: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const test = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const SPAWN = 'const r = spawnSync("node", [SCRIPT, "--json"]);\n';
const IN_PROCESS = "const r = runInProcess(SCRIPT, []);\n";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "test-spawn-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-test-spawn", () => {
	it("FAILs a spawn of node in either spelling, naming the line, run-in-process.js and its exemplar", () => {
		test("scripts/a.test.ts", `// @vitest-environment node\n${SPAWN}`);
		test(
			".claude/skills/x/b.test.ts",
			"execFileSync(process.execPath, [SCRIPT]);\n",
		);
		test("scripts/lib/c.test.js", 'execSync("node scripts/c.js --x");\n');
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"3 spawn(s) of node on the program under test: scripts/a.test.ts:2, scripts/lib/c.test.js:1, .claude/skills/x/b.test.ts:1.",
		);
		expect(r.out).toContain(
			"Fix: run it through `runInProcess` in the plugin's scripts/lib/run-in-process.js, as its scripts/check-cli-args.test.ts does",
		);
		expect(r.out).toContain("FAIL: 3 spawn(s) of node");
	});

	it("FAILs fork and a spawn whose flags precede its script", () => {
		test("scripts/a.test.ts", "const c = fork(SCRIPT);\n");
		test(
			"scripts/b.test.ts",
			'spawnSync(process.execPath, ["--no-warnings", SCRIPT]);\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(": scripts/a.test.ts:1, scripts/b.test.ts:1.");
	});

	it("passes runInProcess, inline code, a spawn named in a comment or a string, and a non-test file", () => {
		test("scripts/a.test.ts", IN_PROCESS);
		test(
			"scripts/b.test.ts",
			'spawnSync("node", ["-e", CODE]);\nexecFileSync(process.execPath, ["--no-warnings", "--eval", CODE]);\nexecSync("node --eval=1");\nexecSync("node -p 1");\n',
		);
		test(
			"scripts/c.test.ts",
			`/* ${SPAWN} */\n// ${SPAWN}const s = '${SPAWN.trim()}';\n`,
		);
		test("scripts/d.js", SPAWN);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 3 test file(s), none spawning node on the program under test without a stated reason.",
		);
	});

	it("passes a spawn with a stated reason on its line, directly above it, or in the file's header", () => {
		test("scripts/a.test.ts", `${SPAWN.trim()} // spawn-kept: a real fd\n`);
		test(
			"scripts/b.test.ts",
			`const x = 1;\n// spawn-kept: a timeout kills it\n// mid-write\n${SPAWN}`,
		);
		test(
			"scripts/c.test.ts",
			`// @vitest-environment node\n/*\n * spawn-kept: the child needs a real fd\n */\n\nimport x from "y";\n${SPAWN}${SPAWN}`,
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 3 test file(s), none spawning node");
	});

	// The --against re-exec's report reaches the hook's stderr, not this
	// process, so the index side is reached by the var lib/check.js sets.
	it("lists no spawn on an --against side, only the count", () => {
		test("scripts/old.test.ts", SPAWN);
		const r = runInProcess(SCRIPT, [], {
			cwd: root,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				WFC_CHECK_SIDE: "index",
			},
		});
		expect(`${r.stdout}${r.stderr}`).toContain(
			"  1 spawn(s) of node on the program under test.\n  Fix: ",
		);
	});

	it("credits a marker on a formatted call's later lines to that call alone", () => {
		test(
			"scripts/a.test.ts",
			`const x = 0;\nconst a = spawnSync("node", [SCRIPT], {\n\tcwd: root,\n}); // spawn-kept: a timeout kills it\nconst b = spawnSync("node", [SCRIPT]);\n`,
		);
		test(
			"scripts/b.test.ts",
			`const x = 0;\nconst r = spawnSync(\n\t// spawn-kept: two processes contend\n\t"node",\n\t[SCRIPT],\n);\n`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(": scripts/a.test.ts:5.");
	});

	it("refuses a marker with no reason, one a line of code separates from the call, and one below the header", () => {
		test("scripts/a.test.ts", `// spawn-kept:\n${SPAWN}`);
		test(
			"scripts/b.test.ts",
			`const w = 0;\n// spawn-kept: two processes\nconst x = 1;\n${SPAWN}`,
		);
		test(
			"scripts/c.test.ts",
			`const x = 1;\n${SPAWN}// spawn-kept: a signal\nconst y = 2;\n${SPAWN}`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			": scripts/a.test.ts:2, scripts/b.test.ts:4, scripts/c.test.ts:2, scripts/c.test.ts:5.",
		);
		expect(r.out).toContain("Fix: run it through `runInProcess`");
	});

	describe("--against HEAD, the direction-gated form", () => {
		let hooks: string;
		beforeEach(() => {
			/* An empty hooks dir, so the scratch repo never runs this checkout's
			 * Husky gates through its absolute core.hooksPath. */
			hooks = fs.mkdtempSync(path.join(os.tmpdir(), "test-spawn-hooks-"));
			git("init", "-q", "-b", "main");
			git("config", "user.email", "test@example.com");
			git("config", "user.name", "test");
			git("config", "core.hooksPath", hooks);
		});
		afterEach(() => fs.rmSync(hooks, { recursive: true, force: true }));

		const seed = () => {
			test("scripts/old.test.ts", `const x = 1;\n${SPAWN}`);
			git("add", ".");
			git("commit", "-qm", "seed");
		};

		it("refuses a spawn the commit adds, in a new file or beside an inherited one, naming it", () => {
			seed();
			test("scripts/new.test.ts", SPAWN);
			test(
				"scripts/old.test.ts",
				`const x = 1;\n${SPAWN}spawn(process.execPath, [OTHER]);\n`,
			);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("this commit adds them");
			expect(r.out).toContain("scripts/new.test.ts:1 spawns node");
			expect(r.out).toContain("scripts/old.test.ts:3 spawns node");
			expect(r.out).toContain("scripts/lib/run-in-process.js");
			expect(r.out).not.toContain("scripts/old.test.ts:2 spawns node");
		});

		it("refuses an edit to an inherited spawn's first line", () => {
			seed();
			test(
				"scripts/old.test.ts",
				`const x = 1;\n${SPAWN.replace("--json", "--quiet")}`,
			);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("scripts/old.test.ts:2 spawns node");
		});

		it("passes an inherited spawn the commit moves down the file, warning of it", () => {
			seed();
			test(
				"scripts/old.test.ts",
				`const x = 1;\nconst y = 2;\n// a comment\n${SPAWN}`,
			);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN: 1 inherited fault(s)");
		});

		it("passes an added spawn carrying a stated reason", () => {
			seed();
			test(
				"scripts/new.test.ts",
				`// spawn-kept: two processes contend for one lock\n${SPAWN}`,
			);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN: 1 inherited fault(s)");
		});

		it("judges the index, not the worktree", () => {
			seed();
			test("scripts/new.test.ts", SPAWN);
			const r = run("--against", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN: 1 inherited fault(s)");
		});
	});
});
