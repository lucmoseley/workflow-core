// @vitest-environment node
/*
 * Pins check-contract-live.js end to end over `--reports` and `--ledger`,
 * and lib/contract-live.js's fold and judge on the cases between.
 *
 * A PLAIN TEMP DIR, NOT A TEMP GIT REPO: the script reads JSON files and asks
 * git nothing of the temp dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-contract-live.js");
const { hostRoot } = require("./lib/host-root.js");
const { DAY_MS, emptyLedger, fold, judge, readLedger } =
	require("./lib/contract-live.js") as typeof import("./lib/contract-live.js");

const ROOT = hostRoot();
const PYPI = "scripts/lib/pypi-registry.contract.test.ts";
const NOT_CONTRACT = "scripts/check-file-ci-time.test.ts";
const T0 = Date.UTC(2026, 10, 1);

let dir: string;
let ledger: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-contract-live-"));
	ledger = path.join(dir, "ledger.json");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** One sweep's shard report, started `day` days after T0, each test's status as given. */
function writeSweep(
	runId: number,
	day: number,
	files: Record<string, Record<string, string>>,
) {
	const shard = path.join(dir, "runs", String(runId), "vitest-report-1");
	fs.mkdirSync(shard, { recursive: true });
	const testResults = Object.entries(files).map(([file, tests]) => ({
		name: path.join(ROOT, file),
		assertionResults: Object.entries(tests).map(([fullName, status]) => ({
			fullName,
			status,
		})),
	}));
	fs.writeFileSync(
		path.join(shard, "vitest-1.json"),
		JSON.stringify({ startTime: T0 + day * DAY_MS, testResults }),
	);
}

const run = () => {
	const r = runInProcess(SCRIPT, [
		"--reports",
		path.join(dir, "runs"),
		"--ledger",
		ledger,
	]);
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

describe("check-contract-live.js", () => {
	it("warns on a case skipped in every sweep for over a week since it ran live", () => {
		writeSweep(1, 0, { [PYPI]: { "made-up name": "passed" } });
		writeSweep(2, 3, { [PYPI]: { "made-up name": "skipped" } });
		writeSweep(3, 8, { [PYPI]: { "made-up name": "skipped" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^WARN/m);
		expect(r.out).toContain(`last live 2026-11-01  ${PYPI} > made-up name`);
	});

	it("is OK on a week of skips that ends in a live run, and ignores a non-contract file", () => {
		writeSweep(1, 0, {
			[PYPI]: { "made-up name": "passed" },
			[NOT_CONTRACT]: { a: "skipped" },
		});
		writeSweep(2, 8, { [PYPI]: { "made-up name": "failed" } });
		const r = run();
		expect(r.out).toMatch(/^OK:.*0 case\(s\) never ran live/m);
	});

	it("counts a case that never ran live rather than reporting it", () => {
		writeSweep(1, 0, { [PYPI]: { "on windows": "skipped" } });
		writeSweep(2, 9, { [PYPI]: { "on windows": "skipped" } });
		expect(run().out).toMatch(/^OK:.*1 case\(s\) never ran live/m);
	});

	it("reads each sweep once, judging later sweeps against the ledger", () => {
		writeSweep(1, 0, { [PYPI]: { c: "passed" } });
		expect(run().out).toMatch(/^OK:/m);
		fs.rmSync(path.join(dir, "runs", "1"), { recursive: true });
		writeSweep(2, 8, { [PYPI]: { c: "skipped" } });
		expect(run().out).toMatch(/^WARN/m);
		expect(readLedger(ledger).newestRun).toBe(2);
	});

	it("skips, judging nothing, where no sweep holds a report", () => {
		fs.mkdirSync(path.join(dir, "runs", "1"), { recursive: true });
		expect(run().out).toMatch(/^SKIP:.*nothing judged/m);
	});
});

describe("contract-live judge", () => {
	const sweep = (day: number, seen: [string, boolean][]) => ({
		at: T0 + day * DAY_MS,
		seen: seen.map(([key, live]) => ({ key, live })),
	});

	it("leaves out a case absent from the newest sweep, and forgets one unseen two weeks", () => {
		let l = fold(emptyLedger(), 1, sweep(0, [["gone", true]]));
		l = fold(l, 2, sweep(8, [["kept", true]]));
		expect(judge(l).silent).toEqual([]);
		l = fold(l, 3, sweep(15, [["kept", true]]));
		expect(Object.keys(l.cases)).toEqual(["kept"]);
	});
});
