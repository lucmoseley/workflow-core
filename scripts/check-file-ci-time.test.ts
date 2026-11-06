// @vitest-environment node
/*
 * Pins check-file-ci-time.js end to end over `--reports`, sweeps already on
 * disk as `gh run download` leaves them. The judging arithmetic is
 * scripts/lib/file-ci-time.test.ts's.
 *
 * The gh route is crossed through WFC_GH: once on a failing gh, and once on a
 * stub serving a busy lander's run list and the sweeps' reports.
 *
 * A PLAIN TEMP DIR, NOT A TEMP GIT REPO: the script reads JSON files and asks
 * git nothing of the temp dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_FAILING_SCRIPT, stubGhHandler } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-file-ci-time.js");
const { hostRoot } = require("./lib/host-root.js");

const ROOT = hostRoot();
const SLOW = "scripts/check-file-ci-time.test.ts";
const FAST = "scripts/lib/file-ci-time.test.ts";
const SPOTTY = "scripts/lib/suite-timings.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-file-ci-time-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** One sweep's shard report, each file `seconds` long. */
function writeSweep(runId: string, files: Record<string, number>) {
	const shard = path.join(dir, runId, "vitest-report-1");
	fs.mkdirSync(shard, { recursive: true });
	const testResults = Object.entries(files).map(([file, seconds]) => ({
		name: path.join(ROOT, file),
		duration: seconds * 1000,
		status: "passed",
		assertionResults: [],
	}));
	fs.writeFileSync(
		path.join(shard, "vitest-1.json"),
		JSON.stringify({ testResults }),
	);
}

const run = () => {
	const r = runInProcess(SCRIPT, ["--reports", dir]);
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

describe("check-file-ci-time.js", () => {
	it("names each file over the limit with its median and three times, and exits 0", () => {
		writeSweep("103", { [SLOW]: 340, [FAST]: 1 });
		writeSweep("102", { [SLOW]: 61, [FAST]: 90 });
		writeSweep("101", { [SLOW]: 89, [FAST]: 2 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			`89 s  ${SLOW} — 340 s (run 103), 61 s (run 102), 89 s (run 101)`,
		);
		expect(out).not.toContain(`${FAST} —`);
		expect(out).toContain("WARN: 1 file(s) over 60 s");
		expect(out).toContain("Cut each by measured cost (#4290).");
	});

	it("judges a file missing from a sweep on the latest three it ran in", () => {
		writeSweep("104", { [SLOW]: 1, [SPOTTY]: 70 });
		writeSweep("103", { [SLOW]: 1 });
		writeSweep("102", { [SLOW]: 1, [SPOTTY]: 80 });
		writeSweep("101", { [SLOW]: 1, [SPOTTY]: 5 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			`70 s  ${SPOTTY} — 70 s (run 104), 80 s (run 102), 5 s (run 101)`,
		);
	});

	it("prints OK with no file over, naming the sweeps judged", () => {
		for (const r of ["3", "2", "1"]) writeSweep(r, { [SLOW]: 60 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			"OK: no test file's median CI time over its last 3 sweeps (latest 3, 2, 1) is over 60 s.",
		);
	});

	it("warns on an unjudged file that was over the limit in a sweep, never OK", () => {
		writeSweep("3", { [SLOW]: 1, [SPOTTY]: 200 });
		writeSweep("2", { [SLOW]: 1 });
		writeSweep("1", { [SLOW]: 1 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			`1 file(s) timed in fewer than 3 of the 3 sweeps read, unjudged; over 60 s in a sweep:\n  ${SPOTTY} — 200 s (run 3)`,
		);
		expect(out).toContain("WARN: 1 file(s) over 60 s");
		expect(out).not.toContain("OK:");
	});

	it("says in its OK line how many files went unjudged", () => {
		writeSweep("3", { [SLOW]: 1, [SPOTTY]: 2 });
		writeSweep("2", { [SLOW]: 1 });
		writeSweep("1", { [SLOW]: 1 });
		expect(run().out).toContain(
			"1 file(s) timed in fewer than 3 of the 3 sweeps read are unjudged, none over 60 s in any.",
		);
	});

	it("names a run with no reports it passed over", () => {
		for (const r of ["4", "2", "1"]) writeSweep(r, { [SLOW]: 1 });
		fs.mkdirSync(path.join(dir, "3"));
		expect(run().out).toContain(
			"Passed over 1 run(s) with no vitest reports: 3.",
		);
	});

	it("skips, naming GitHub, where gh cannot list the runs", () => {
		const gh = path.join(dir, "gh");
		fs.writeFileSync(gh, GH_FAILING_SCRIPT, { mode: 0o755 });
		const r = runInProcess(SCRIPT, [], { env: { ...process.env, WFC_GH: gh } });
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"SKIP: GitHub unreachable listing scheduled-checks.yml runs",
		);
	});

	it("judges the last three sweeps on main while a full list of lander runs is newer, listing each sweep branch by --branch (#4559)", () => {
		const sweeps = { "103": 340, "102": 61, "101": 89 };
		for (const [id, seconds] of Object.entries(sweeps))
			writeSweep(id, { [SLOW]: seconds });
		const log = path.join(dir, "gh.log");
		const main = Object.keys(sweeps).map((id) => ({
			databaseId: Number(id),
			headBranch: "main",
		}));
		/* A handler, not stubGhRoutes: `run download` must write the reports
		 * into its -D directory, which a route's printed answer cannot. The
		 * lander rows fill whatever --limit asks, so an unfiltered list never
		 * reaches a sweep however RUNS_LISTED moves. */
		const stub = stubGhHandler(
			dir,
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const at = (flag) => argv[argv.indexOf(flag) + 1];
if (argv[0] === "run" && argv[1] === "list") {
	const limit = Number(at("--limit"));
	const lander = Array.from({ length: limit }, (_, i) => ({ databaseId: 200 + i, headBranch: "lander/batch" }));
	const all = [...lander, ...${JSON.stringify(main)}];
	const branch = argv.includes("--branch") ? at("--branch") : null;
	out(JSON.stringify((branch ? all.filter((r) => r.headBranch === branch) : all).slice(0, limit)));
	exit(0);
}
if (argv[0] === "run" && argv[1] === "download") {
	fs.cpSync(${JSON.stringify(dir)} + "/" + argv[2], at("-D"), { recursive: true });
	exit(0);
}
err("unrouted: " + argv.join(" "));
exit(1);`,
		);
		const r = runInProcess(SCRIPT, [], {
			env: { ...process.env, ...stub.env },
		});
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain(
			`89 s  ${SLOW} — 340 s (run 103), 61 s (run 102), 89 s (run 101)`,
		);
		const lists = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[])
			.filter((a) => a[1] === "list");
		expect(lists.map((a) => a[a.indexOf("--branch") + 1]).sort()).toEqual([
			"landing",
			"main",
		]);
	});

	it("is BROKEN on a bad invocation", () => {
		const r = runInProcess(SCRIPT, ["--bogus"]);
		expect(r.status).toBe(2);
	});

	it("says it judged nothing, and never OK, with fewer than three sweeps readable", () => {
		writeSweep("2", { [SLOW]: 500 });
		writeSweep("1", { [SLOW]: 500 });
		fs.mkdirSync(path.join(dir, "3"));
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			"SKIP: judged nothing: 2 sweep(s) with vitest reports readable (2, 1), 3 needed for a median.",
		);
		expect(out).not.toContain("OK");
	});
});
