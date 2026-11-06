// @vitest-environment node
/*
 * Pins which sites check-program-output.js finds writing past writeFd in a
 * program that calls process.exit, over the whole tree, and that each refusal
 * names writeFd and its exemplar (#4018, #3454).
 *
 * Fabricated programs in a throwaway directory, never this checkout, so a
 * case's sites are only its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next program whose output dies at process.exit on a pipe land.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-program-output.js");

let root: string;

const program = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const EXIT = "process.exit(1);\n";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "program-output-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-program-output", () => {
	it("FAILs console.log then process.exit, naming writeFd and its exemplar", () => {
		program("scripts/measure-a.js", `console.log("x");\n${EXIT}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 write(s) past writeFd");
		expect(r.out).toContain(
			"scripts/measure-a.js:1 writes past writeFd before process.exit (`console.log(`). Fix: write through writeFd in scripts/lib/write-fd.js, as scripts/check-plugin-gap.js does",
		);
	});

	it("FAILs a std stream's write, an alias and a bracket access, in a skill's program too", () => {
		program(
			".claude/skills/s/scripts/gen.js",
			`process.stdout.write("x");\nconst log = console.log;\nconsole["error"]("y");\nprocess.stderr.write ("z");\n${EXIT}`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 4 write(s) past writeFd");
		for (const [line, text] of [
			[1, "process.stdout.write("],
			[2, "console."],
			[3, "console["],
			[4, "process.stderr.write ("],
		])
			expect(r.out).toContain(
				`.claude/skills/s/scripts/gen.js:${line} writes past writeFd before process.exit (\`${text}\`)`,
			);
	});

	it("FAILs a report-* with no process.exit, and one marked console-kept", () => {
		program("scripts/report-a.js", 'console.log("x");\n');
		program(
			"scripts/report-b.js",
			'// console-kept: terminal only\nconsole.log("x");\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 2 write(s) past writeFd");
		expect(r.out).toContain("scripts/report-a.js:1 writes past writeFd");
		expect(r.out).toContain("scripts/report-b.js:2 writes past writeFd");
	});

	it("passes writeFd, a console-kept site, tests, test support, and a program that never exits", () => {
		program(
			"scripts/clean.js",
			`const { writeFd } = require("./lib/write-fd.js");\nwriteFd(1, "x\\n");\n${EXIT}`,
		);
		program(
			"scripts/kept.js",
			`// console-kept: only a human runs --watch, at a terminal\nconsole.log("x");\nconsole.error("y"); // console-kept: same path\n${EXIT}`,
		);
		program("scripts/clean.test.js", `console.log("x");\n${EXIT}`);
		program("scripts/clean.test.ts", `console.log("x");\n${EXIT}`);
		program("scripts/lib/gh-stub.js", `console.log("x");\n${EXIT}`);
		program("scripts/no-exit.js", 'console.log("x");\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 3 program(s), none ending in process.exit writing past writeFd.",
		);
	});

	it("reads neither a write nor an exit inside a comment or a string", () => {
		program(
			"scripts/emits.js",
			'// console.log("x");\nconst body = `console.log("x");\nprocess.exit(1);`;\n' +
				`const s = "process.stdout.write(x)";\n${EXIT}`,
		);
		program("scripts/says.js", 'console.log("process.exit(1)");\n');
		program(
			"scripts/bare-marker.js",
			`// console-kept:\nconsole.log("x");\n${EXIT}`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 write(s) past writeFd");
		expect(r.out).toContain("scripts/bare-marker.js:2 writes past writeFd");
	});
});
