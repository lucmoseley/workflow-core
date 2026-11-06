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

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stubGhHandler } from "./lib/gh-stub";

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
			duration: ms,
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

/* The script relativises against the tree it runs in, so that is this
 * checkout the reports are named under (#3334). */
const run = (...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: REPO,
		env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
	});

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

	it("merges every report under a directory, each named from its own checkout (#2413)", () => {
		const reports = join(dir, "reports");
		mkdirSync(join(reports, "vitest-report-1"), { recursive: true });
		mkdirSync(join(reports, "vitest-report-2"), { recursive: true });
		writeFileSync(
			join(reports, "vitest-report-1", "vitest-1.json"),
			report([["package.json", 3000]]),
		);
		writeFileSync(
			join(reports, "vitest-report-2", "vitest-2.json"),
			report([["scripts/suite-timings.js", 1000]]).replaceAll(
				REPO,
				"/runner/isolated-2",
			),
		);
		const target = join(dir, "out.csv");
		const r = run("extract", reports, target);
		expect(r.status).toBe(0);
		expect(readFileSync(target, "utf8")).toBe(
			"file,seconds,tests,status\npackage.json,3.00,1,passed\nscripts/suite-timings.js,1.00,1,passed\n",
		);
	});

	it("names files relative to the checkout the run used, not this one (#2413)", () => {
		const runner = "/home/runner/work/wc/wc";
		const source = join(dir, "runner.json");
		writeFileSync(
			source,
			report([
				["package.json", 3000],
				["scripts/suite-timings.test.ts", 1000],
			]).replaceAll(REPO, runner),
		);
		const target = join(dir, "out.csv");
		expect(run("extract", source, target).status).toBe(0);
		expect(readFileSync(target, "utf8")).toBe(
			"file,seconds,tests,status\npackage.json,3.00,1,passed\nscripts/suite-timings.test.ts,1.00,1,passed\n",
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

describe("latest (#4574)", () => {
	const Planning = "900";
	const Created = "2026-11-06T10:00:00Z";
	const Record = readFileSync(
		join(REPO, "docs/data/ci-shard-timings.csv"),
		"utf8",
	);

	/* A run listing, each run's reports and the planning run's creation, as
	 * the API and `gh run download` answer them. `reports` maps a run id to
	 * its files and seconds; a run absent from it has no artefacts. */
	const stub = (
		runs: { id: number; created_at: string; updated_at: string }[],
		reports: Record<string, [string, number][]>,
		failing = false,
	) => {
		for (const [id, files] of Object.entries(reports)) {
			mkdirSync(join(dir, "runs", id, "vitest-report-1"), { recursive: true });
			writeFileSync(
				join(dir, "runs", id, "vitest-report-1", "vitest-1.json"),
				report(files),
			);
		}
		const listing = runs.map((r) => ({
			...r,
			status: "completed",
			conclusion: "success",
			head_sha: `sha${r.id}`,
		}));
		return stubGhHandler(
			dir,
			`const fs = require("node:fs");
if (${failing}) { err("HTTP 502: Bad Gateway"); exit(1); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
if (argv[0] === "api" && argv[1].endsWith("/actions/runs/${Planning}")) {
	out(JSON.stringify({ id: ${Planning}, created_at: "${Created}" }));
	exit(0);
}
if (argv[0] === "api" && argv[1].includes("/workflows/scheduled-checks.yml/runs?")) {
	out(JSON.stringify({ workflow_runs: ${JSON.stringify(listing)} }));
	exit(0);
}
if (argv[0] === "run" && argv[1] === "download") {
	const from = ${JSON.stringify(join(dir, "runs"))} + "/" + argv[2];
	if (!fs.existsSync(from)) { err("no valid artifacts found to download"); exit(1); }
	fs.cpSync(from, at("-D"), { recursive: true });
	exit(0);
}
err("unrouted: " + argv.join(" "));
exit(1);`,
		);
	};

	const latest = (gh: { env: Record<string, string> }, target: string) =>
		runInProcess(SCRIPT, ["latest", target, "--before-run", Planning], {
			cwd: REPO,
			env: { ...process.env, CLAUDE_PROJECT_DIR: REPO, ...gh.env },
		});

	it("writes the newest green run finished before the planning run, naming it", () => {
		const gh = stub(
			[
				{
					id: 3,
					created_at: "2026-11-06T09:59:00Z",
					updated_at: "2026-11-06T09:59:50Z",
				},
				{
					id: 2,
					created_at: "2026-11-06T09:50:00Z",
					updated_at: "2026-11-06T09:53:00Z",
				},
				{
					id: 1,
					created_at: "2026-11-06T09:40:00Z",
					updated_at: "2026-11-06T09:43:00Z",
				},
			],
			{ "2": [["package.json", 2000]], "1": [["package.json", 9000]] },
		);
		const target = join(dir, "out.csv");
		const r = latest(gh, target);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("1 files from run 2 → ");
		expect(readFileSync(target, "utf8")).toBe(
			"# run: 2\n# sha: sha2\nfile,seconds,tests,status\npackage.json,2.00,1,passed\n",
		);
	});

	it("passes over a run whose reports are gone to the next one", () => {
		const gh = stub(
			[
				{
					id: 2,
					created_at: "2026-11-06T09:50:00Z",
					updated_at: "2026-11-06T09:53:00Z",
				},
				{
					id: 1,
					created_at: "2026-11-06T09:40:00Z",
					updated_at: "2026-11-06T09:43:00Z",
				},
			],
			{ "1": [["package.json", 9000]] },
		);
		const target = join(dir, "out.csv");
		const r = latest(gh, target);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("1 files from run 1 → ");
		expect(readFileSync(target, "utf8")).toContain("# run: 1\n");
	});

	it("writes the committed record where GitHub fails, saying so", () => {
		const gh = stub([], {}, true);
		const target = join(dir, "out.csv");
		const r = latest(gh, target);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no run read (HTTP 502: Bad Gateway)");
		expect(readFileSync(target, "utf8")).toBe(Record);
	});

	it("writes the committed record where no green run holds reports", () => {
		const gh = stub(
			[
				{
					id: 1,
					created_at: "2026-11-06T09:40:00Z",
					updated_at: "2026-11-06T09:43:00Z",
				},
			],
			{},
		);
		const target = join(dir, "out.csv");
		const r = latest(gh, target);
		expect(r.status).toBe(0);
		expect(readFileSync(target, "utf8")).toBe(Record);
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
