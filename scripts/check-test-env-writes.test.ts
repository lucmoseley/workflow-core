// @vitest-environment node
/*
 * Pins that check-test-env-writes.js fails a JS test file or `scripts/` `.ts`
 * helper writing `process.env` directly, by any assignment operator or a
 * whole-object write or a delete, and passes `vi.stubEnv`, reads, comparisons
 * and a line an `env-write-kept:` comment keeps (#4019).
 *
 * The checker reads tracked files, so a throwaway git repo holding one test
 * file is the whole fixture. Fixture text names `process.env` through `ENV`,
 * so this file's own lines never read as the assignment they quote.
 *
 * It is a hard gate in .husky/pre-commit and a step in roadmap-digest.yml:
 * loosen a case and a write that outlives its case lands green.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-test-env-writes.js");
const ENV = "process.env";

let dir: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const track = (rel: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
	git("add", "--", rel);
};

const run = (...args: string[]) => {
	// Off, not inherited: runCheck's ::error:: annotation, added off this
	// flag, would otherwise leak into `out` on an Actions run (mantahostels#2427).
	const r = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-env-writes-"));
	git("init", "-q");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a direct process.env assignment in a test file", () => {
	it.each([
		["a dotted name", `${ENV}.FOO = "x";`, "FOO"],
		["a quoted key", `${ENV}["FOO"] = "x";`, "FOO"],
		["a computed key", `${ENV}[name] = "x";`, "[name]"],
		["??=", `${ENV}.FOO ??= "x";`, "FOO"],
		["||=", `${ENV}.FOO ||= "x";`, "FOO"],
		["+=", `${ENV}.FOO += "x";`, "FOO"],
		["&&=", `${ENV}.FOO &&= "x";`, "FOO"],
		["a whole-object replace", `${ENV} = { ...saved };`, "(whole object)"],
		[
			"an Object.assign into it",
			`Object.assign(${ENV}, { FOO: "x" });`,
			"(whole object)",
		],
		["a delete", `delete ${ENV}.FOO;`, "FOO"],
		["a computed delete", `delete ${ENV}[name];`, "[name]"],
	])(
		"fails on %s, naming the file, line, variable and fix",
		(kind, line, name) => {
			track("scripts/x.test.ts", `const a = 1;\n${line}\n`);
			const r = run();
			expect(r.status).toBe(1);
			const verb = kind.includes("delete") ? "deletes" : "assigns";
			expect(r.out).toContain(
				`scripts/x.test.ts:2 ${verb} process.env ${name}`,
			);
			expect(r.out).toContain("vi.stubEnv");
		},
	);

	it("reads every file vitest collects, not scripts/ alone", () => {
		track(".claude/skills/s/scripts/y.test.ts", `${ENV}.FOO = "x";\n`);
		track("root.test.js", `${ENV}.BAR = "x";\n`);
		const r = run("--json");
		expect(r.status).toBe(1);
		expect(r.json().findings.map((f: { file: string }) => f.file)).toEqual([
			".claude/skills/s/scripts/y.test.ts",
			"root.test.js",
		]);
	});

	it("fails on a scripts/ .ts helper a test imports", () => {
		track("scripts/lib/x-testkit.ts", `${ENV}.FOO = "x";\n`);
		expect(run().status).toBe(1);
	});
});

describe("what is no direct write", () => {
	it.each([
		["vi.stubEnv", 'vi.stubEnv("FOO", "x");'],
		["a read", `const v = ${ENV}.FOO;`],
		["a comparison", `if (${ENV}.FOO === "x") {}`],
		["a child env copy", `env.FOO = "x";`],
		["a kept line", `${ENV}.FOO = "x"; // env-write-kept: read at import`],
	])("passes %s", (_, line) => {
		track("scripts/x.test.ts", `${line}\n`);
		expect(run().status).toBe(0);
	});

	it("passes a line kept by the comment above it", () => {
		track(
			"scripts/x.test.ts",
			`// env-write-kept: the module reads it at import\n${ENV}.FOO = "x";\n`,
		);
		expect(run().status).toBe(0);
	});

	it("keeps no line on a bare marker with no reason", () => {
		track("scripts/x.test.ts", `${ENV}.FOO = "x"; // env-write-kept:\n`);
		expect(run().status).toBe(1);
	});

	it("leaves a shipped script and a .ts file outside scripts/ alone", () => {
		track("scripts/x.js", `${ENV}.FOO = "x";\n`);
		track("hooks/register.ts", `${ENV}.FOO = "x";\n`);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 0 test files and helpers read");
	});
});

describe("output shape", () => {
	it("--warn caps a FAIL to WARN and exit 0", () => {
		track("scripts/x.test.ts", `${ENV}.FOO = "x";\n`);
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	it("reports JSON with each finding's file, variable and line", () => {
		track("scripts/x.test.ts", `${ENV}.FOO = "x";\n`);
		const f = run("--json").json().findings[0];
		expect(f).toMatchObject({
			file: "scripts/x.test.ts",
			name: "FOO",
			line: 1,
		});
	});
});
