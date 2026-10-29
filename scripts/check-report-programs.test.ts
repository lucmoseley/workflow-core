// @vitest-environment node
/*
 * Pins which report-* sites check-report-programs.js finds writing past
 * writeFd or filing past createIssue, over the whole tree, and that each
 * refusal names the primitive and its exemplar (#3454).
 *
 * Fabricated programs in a throwaway directory, never this checkout, so a
 * case's sites are only its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next report-* whose output dies at process.exit on a pipe, or that files by a
 * second route, land.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-report-programs.js");

let root: string;

const program = (rel: string, body: string) => {
	const at = path.join(root, "scripts", rel);
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

const CLEAN =
	'const { writeFd } = require("./lib/write-fd.js");\n' +
	'const { createIssue } = require("./lib/tracking-issue");\n' +
	"// console.log(x) and gh issue create, in a comment\n" +
	'const url = createIssue({ title: "t", labels: [], body: "b" });\n' +
	"writeFd(1, url);\n";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "report-programs-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-report-programs", () => {
	it("FAILs console and process.std*.write in a report-*, naming writeFd and its exemplar", () => {
		program("report-a.js", 'console.log("x");\nconsole.error("y");\n');
		program("report-b.js", 'process.stdout.write("x\\n");\n');
		program("report-c.cjs", '\nprocess.stderr.write ("y\\n");\n');
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 4 report-program breach(es)");
		expect(r.out).toContain(
			"scripts/report-a.js:1 writes past writeFd (`console.log(`). Fix: write through writeFd in scripts/lib/write-fd.js, as scripts/report-new-shared-faults.js does (§N6).",
		);
		expect(r.out).toContain("scripts/report-a.js:2 writes past writeFd");
		expect(r.out).toContain(
			"scripts/report-b.js:1 writes past writeFd (`process.stdout.write(`)",
		);
		expect(r.out).toContain(
			"scripts/report-c.cjs:2 writes past writeFd (`process.stderr.write (`)",
		);
	});

	it("FAILs an alias of console or a std stream, and a bracket access", () => {
		program(
			"report-alias.js",
			'const log = console.log;\nconsole["error"]("x");\nconst w = process.stdout.write;\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 3 report-program breach(es)");
		expect(r.out).toContain(
			"scripts/report-alias.js:1 writes past writeFd (`console.`)",
		);
		expect(r.out).toContain(
			"scripts/report-alias.js:2 writes past writeFd (`console[`)",
		);
		expect(r.out).toContain(
			"scripts/report-alias.js:3 writes past writeFd (`process.stdout.write`)",
		);
	});

	it.each([
		[
			"an argument pair",
			'gh([\n\t"issue",\n\t"create",\n\t"--title", t]);\n',
			2,
		],
		["a single-quoted pair", "gh(['issue', 'create']);\n", 1],
		["a command string", 'execSync("gh issue create --title t");\n', 1],
	])(
		"FAILs a create built as %s, naming createIssue and its exemplar",
		(_, body, line) => {
			program("report-file.js", body);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain("FAIL: 1 report-program breach(es)");
			expect(r.out).toContain(
				`scripts/report-file.js:${line} files past createIssue`,
			);
			expect(r.out).toContain(
				"Fix: file through createIssue in scripts/lib/tracking-issue.js, as scripts/report-remeasure-due.js does, or its fileOrRefresh (§N3).",
			);
		},
	);

	it("passes a report-* on writeFd and createIssue, and leaves tests, libraries and other programs alone", () => {
		program("report-clean.js", CLEAN);
		program("report-clean.test.js", 'console.log("x");\n');
		program("report-clean.spec.js", 'console.log("x");\n'); // #3618
		program("lib/report-lib.js", 'console.log("x");\n');
		program("check-other.js", 'gh(["issue", "create"]);\nconsole.log("x");\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 1 report program(s), each writing through writeFd and filing through createIssue.",
		);
	});
});
