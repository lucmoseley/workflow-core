// @vitest-environment node
/*
 * Pins which test-file spawns check-test-spawn.js counts as spawning the
 * program under test, and which stated reasons it honours.
 *
 * check-test-spawn.js (#3458) against fabricated tests in a throwaway
 * directory, never this one.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets a
 * new test spawn node unrefused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-test-spawn.js");

let root: string;

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
			"Fix: run it through `runInProcess` in the plugin's scripts/lib/run-in-process.js, `runInProcessAsync` for an async entry, as its scripts/check-cli-args.test.ts does",
		);
		expect(r.out).toContain("FAIL: 3 spawn(s) of node");
	});

	it("FAILs spawn, execFile, exec and execFileSync on node in any quoting, naming each", () => {
		test("scripts/a.test.ts", "spawn('node', [SCRIPT]);\n");
		test("scripts/b.test.ts", "execFile(`node`, [SCRIPT], cb);\n");
		test("scripts/c.test.ts", 'exec("node scripts/c.js", cb);\n');
		test("scripts/d.test.ts", 'execFileSync("node", [SCRIPT]);\n');
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			": scripts/a.test.ts:1, scripts/b.test.ts:1, scripts/c.test.ts:1, scripts/d.test.ts:1.",
		);
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
			`const x = 1;\n// spawn-kept: a signal stops it\n// mid-write\n${SPAWN}`,
		);
		test(
			"scripts/c.test.ts",
			`// @vitest-environment node\n/*\n * spawn-kept: the script has no require.main guard\n */\n\nimport x from "y";\n${SPAWN}${SPAWN}`,
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 3 test file(s), none spawning node");
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

	it("identifies a spawn by its first line, whitespace collapsed, and its count among identical lines", () => {
		test(
			"scripts/a.test.ts",
			`${SPAWN}const x = 1;\n${SPAWN}const r2 = spawnSync(\n\t"node",\n\t[SCRIPT],\n);\n`,
		);
		const r = run("--json");
		const { findings } = JSON.parse(r.out.slice(r.out.indexOf("{")));
		expect(
			findings.map((f: { line: number; call: string; nth: number }) => [
				f.line,
				f.call,
				f.nth,
			]),
		).toEqual([
			[1, SPAWN.trim(), 1],
			[3, SPAWN.trim(), 2],
			[4, "const r2 = spawnSync(", 1],
		]);
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
});
