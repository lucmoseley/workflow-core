// @vitest-environment node
/*
 * Pins suite-timings.js's command line: `extract` writes a dataset of every
 * file and reports its count and shares, `shares` recomputes them from a
 * dataset already written, and a bad argument prints usage rather than a file.
 *
 * The CLI's own suite, black-box (§X3): the real script is loaded end to end
 * through scripts/lib/run-in-process.js, and every case asserts the exit code
 * AND what the output says. The arithmetic behind the numbers is
 * scripts/lib/suite-timings.test.ts's, not this file's.
 *
 * A PLAIN TEMP DIR, NOT A TEMP GIT REPO. This script reads a JSON file and
 * writes a CSV; it never asks git anything — the same reason
 * `validate.test.ts` mints a plain directory.
 *
 * WHAT BREAKING THIS COSTS. `extract` is how a per-file timing dataset is made
 * at all (mantahostels#2039), and its output is a dated record — a run written
 * wrongly is superseded only by another full suite run.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { runInProcess } = require("./lib/run-in-process.js");

const SCRIPT = resolve(__dirname, "suite-timings.js");
const REPO = resolve(__dirname, "..");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "suite-timings-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A vitest JSON report naming files under the real repo root, in ms. */
const report = (files: [string, number][]) =>
	JSON.stringify({
		testResults: files.map(([name, ms]) => ({
			name: `${REPO}/${name}`,
			startTime: 0,
			endTime: ms,
			status: "passed",
			assertionResults: [{}],
		})),
	});

/** Writes the report and returns the path the CLI should read. */
const writeGivenReport = (files: [string, number][]) => {
	const path = join(dir, "run.json");
	writeFileSync(path, report(files));
	return path;
};

const run = (...args: string[]) =>
	runInProcess(SCRIPT, args, { cwd: REPO, env: { ...process.env } });

describe("extract", () => {
	it("writes a dataset of every file and reports the count and the shares", () => {
		const target = join(dir, "out.csv");
		const r = run(
			"extract",
			writeGivenReport([
				["a.test.ts", 3000],
				["b.test.ts", 1000],
			]),
			target,
			"sha=abc",
		);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("2 files → ");
		expect(`${r.stdout}${r.stderr}`).toContain("file-seconds: 4");
		expect(readFileSync(target, "utf8")).toBe(
			"# sha: abc\nfile,seconds,tests,status\na.test.ts,3.00,1,passed\nb.test.ts,1.00,1,passed\n",
		);
	});

	it("names the offending argument and how metadata is spelled when one is not key=value", () => {
		const r = run("extract", writeGivenReport([]), join(dir, "o.csv"), "nope");
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain('"nope" is not key=value');
		expect(`${r.stdout}${r.stderr}`).toContain("run=... sha=...");
	});

	it("prints the usage rather than writing a file when the output path is missing", () => {
		const r = run("extract", writeGivenReport([]));
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"node scripts/suite-timings.js extract",
		);
	});
});

describe("shares", () => {
	it("recomputes the table from a dataset already written", () => {
		const target = join(dir, "out.csv");
		run(
			"extract",
			writeGivenReport([
				["a.test.ts", 3000],
				["b.test.ts", 1000],
			]),
			target,
		);
		const r = run("shares", target);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("file-seconds: 4");
		expect(`${r.stdout}${r.stderr}`).toContain("median file: 2 s");
	});

	it("prints the usage rather than a table when no dataset is named", () => {
		const r = run("shares");
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"node scripts/suite-timings.js shares",
		);
	});
});

describe("an unknown command", () => {
	it("prints the usage and fails, naming both subcommands", () => {
		const r = run("wat");
		expect(r.status).toBe(1);
		const text = `${r.stdout}${r.stderr}`;
		expect(text).toContain("extract");
		expect(text).toContain("shares");
	});

	it("never exits 2, which would read as a check-* BROKEN from a script in no family", () => {
		expect(run("wat").status).toBe(1);
	});
});
