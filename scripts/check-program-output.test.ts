// @vitest-environment node

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
			"scripts/measure-a.js:1 writes past writeFd before process.exit (`console.log(`). Fix: write through writeFd in scripts/lib/write-fd.js, as scripts/upgrade.js does",
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

	it("FAILs a report-* with no process.exit, a bare alias in a .cjs and a write in a template's placeholder", () => {
		program("scripts/report-a.js", 'console.log("x");\n');
		program("scripts/report-c.cjs", "const w = process.stdout.write;\n");
		const dollar = "$";
		program(
			"scripts/report-d.js",
			`const s = \`${dollar}{console.log(1)}\`;\n`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 3 write(s) past writeFd");
		expect(r.out).toContain("scripts/report-a.js:1 writes past writeFd");
		expect(r.out).toContain(
			"scripts/report-c.cjs:1 writes past writeFd before process.exit (`process.stdout.write`)",
		);
		expect(r.out).toContain("scripts/report-d.js:1 writes past writeFd");
	});

	const passes = (scanned: number) => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			`OK: ${scanned} program(s), none ending in process.exit writing past writeFd.`,
		);
	};

	it.each(["writeFd", "writeTerminal"])(
		"passes a program writing through %s",
		(writer) => {
			program(
				"scripts/clean.js",
				`const { ${writer} } = require("./lib/write-fd.js");\n${writer}(1, "x\\n");\n${EXIT}`,
			);
			passes(1);
		},
	);

	it.each([
		["a test file", "scripts/clean.test.js"],
		["a TS test file", "scripts/clean.test.ts"],
		["test support", "scripts/lib/gh-stub.js"],
		["a template", "scripts/templates/t.js"],
	])("leaves %s out of the population", (_, rel) => {
		program(rel, `console.log("x");\n${EXIT}`);
		passes(0);
	});

	it("passes a program that never calls process.exit", () => {
		program("scripts/no-exit.js", 'console.log("x");\n');
		passes(1);
	});

	it("reads neither a write nor an exit inside a comment or a string", () => {
		program(
			"scripts/emits.js",
			'// console.log("x");\nconst body = `console.log("x");\nprocess.exit(1);`;\n' +
				`const s = "process.stdout.write(x)";\n${EXIT}`,
		);
		program("scripts/says.js", 'console.log("process.exit(1)");\n');
		program("scripts/writes.js", `console.log("x");\n${EXIT}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 write(s) past writeFd");
		expect(r.out).toContain("scripts/writes.js:1 writes past writeFd");
	});
});
