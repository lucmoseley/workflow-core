// @vitest-environment node
/*
 * Pins which report-* sites check-report-programs.js finds filing past
 * createIssue, over the whole tree, and that each refusal names the primitive
 * and its exemplar (#3454).
 *
 * Fabricated programs in a throwaway directory, never this checkout, so a
 * case's sites are only its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next report-* that files by a second route land.
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
	'const { createIssue } = require("./lib/tracking-issue");\n' +
	"// gh issue create, in a comment\n" +
	'createIssue({ title: "t", labels: [], body: "b" });\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "report-programs-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-report-programs", () => {
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

	it("passes a report-* on createIssue, and leaves tests, libraries and other programs alone", () => {
		const create = 'gh(["issue", "create"]);\n';
		program("report-clean.js", CLEAN);
		program("report-clean.test.js", create);
		program("report-clean.spec.js", create); // #3618
		program("lib/report-lib.js", create);
		program("check-other.js", create);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 1 report program(s), each filing through createIssue.",
		);
	});
});
