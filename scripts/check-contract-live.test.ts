// @vitest-environment node
/*
 * Pins check-contract-live.js (#5408). Loosened, a live contract case can
 * skip on every sweep for weeks and `npm run status` still reads OK.
 *
 * A PLAIN TEMP DIR, NOT A TEMP GIT REPO: the script reads JSON files and asks
 * git nothing of the temp dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhHandler } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-contract-live.js");
const { hostRoot } = require("./lib/host-root.js");
const { DAY_MS, fold, judge, readLedger } =
	require("./lib/contract-live.js") as typeof import("./lib/contract-live.js");

const ROOT = hostRoot();
const PYPI = "scripts/lib/pypi-registry.contract.test.ts";
const NOT_CONTRACT = "scripts/check-file-ci-time.test.ts";
const T0 = Date.UTC(2026, 10, 1);
const ADVICE = "Re-run the case's URL or command by hand";

let dir: string;
let ledger: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-contract-live-"));
	ledger = path.join(dir, "ledger.json");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** One sweep's shard report, started `day` days after T0. */
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
		expect(r.out).toContain(ADVICE);
	});

	it("is OK on a week of skips that ends in a live run, and ignores a non-contract file", () => {
		writeSweep(1, 0, {
			[PYPI]: { "made-up name": "passed" },
			[NOT_CONTRACT]: { a: "skipped" },
		});
		writeSweep(2, 8, { [PYPI]: { "made-up name": "failed" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:.*0 case\(s\) never ran live/m);
	});

	it("counts a case that never ran live, naming it for a week only where it is new", () => {
		writeSweep(1, 0, { [PYPI]: { "on windows": "skipped" } });
		writeSweep(2, 2, {
			[PYPI]: { "on windows": "skipped", "new, silent": "skipped" },
		});
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:.*2 case\(s\) never ran live/m);
		expect(r.out).toContain(`first seen 2026-11-03  ${PYPI} > new, silent`);
		expect(r.out).not.toContain("on windows");
	});

	it("reads each sweep once, judging later sweeps against the ledger", () => {
		writeSweep(1, 0, { [PYPI]: { c: "passed" } });
		writeSweep(2, 1, { [PYPI]: { c: "skipped" } });
		expect(run().out).toMatch(/^OK:/m);
		fs.rmSync(path.join(dir, "runs", "1"), { recursive: true });
		writeSweep(3, 8, { [PYPI]: { c: "skipped" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^WARN/m);
		expect(readLedger(ledger).ledger.newestRun).toBe(3);
	});

	it("judges no case from before a gap of unread sweeps", () => {
		writeSweep(1, 0, { [PYPI]: { c: "passed" } });
		expect(run().out).toMatch(/^OK:/m);
		fs.rmSync(path.join(dir, "runs", "1"), { recursive: true });
		writeSweep(5, 6, { [PYPI]: { c: "skipped" } });
		writeSweep(6, 9, { [PYPI]: { c: "skipped" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:/m);
	});

	it("warns on a ledger that is not one, and begins it again", () => {
		fs.writeFileSync(ledger, "{}");
		writeSweep(1, 0, { [PYPI]: { c: "passed" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(`${ledger}: not a ledger`);
		expect(readLedger(ledger).ledger.newestRun).toBe(1);
	});

	it("skips, judging nothing, where no sweep holds a report", () => {
		fs.mkdirSync(path.join(dir, "runs", "1"), { recursive: true });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^SKIP:.*nothing judged/m);
	});

	it("through gh, folds finished sweeps up to the first unfinished one", () => {
		writeSweep(1, 0, { [PYPI]: { c: "passed" } });
		writeSweep(2, 8, { [PYPI]: { c: "skipped" } });
		writeSweep(3, 9, { [PYPI]: { c: "passed" } });
		const listed = [
			{ databaseId: 3, status: "completed" },
			{ databaseId: 2, status: "in_progress" },
			{ databaseId: 1, status: "completed" },
		];
		const runs = path.join(dir, "runs");
		const stub = stubGhHandler(
			dir,
			`const fs = require("node:fs");
const at = (flag) => argv[argv.indexOf(flag) + 1];
if (argv[0] === "run" && argv[1] === "list") {
	out(${JSON.stringify(JSON.stringify(listed))});
	exit(0);
}
if (argv[0] === "run" && argv[1] === "download") {
	fs.cpSync(${JSON.stringify(runs)} + "/" + argv[2], at("-D"), { recursive: true });
	exit(0);
}
err("unrouted: " + argv.join(" "));
exit(1);`,
		);
		const r = runInProcess(SCRIPT, ["--ledger", ledger], {
			env: { ...process.env, ...stub.env },
		});
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toMatch(/^OK:/m);
		expect(readLedger(ledger).ledger.newestRun).toBe(1);
	});
});

describe("contract-live judge", () => {
	const sweep = (day: number, seen: [string, boolean][]) => ({
		at: T0 + day * DAY_MS,
		seen: seen.map(([key, live]) => ({ key, live })),
	});
	const empty = { firstAt: 0, newestRun: 0, newestAt: 0, gapAt: 0, cases: {} };

	it("leaves out a case absent from the newest sweep, and forgets one unseen two weeks", () => {
		let l = fold(empty, 1, sweep(0, [["gone", true]]), false);
		l = fold(l, 2, sweep(8, [["kept", true]]), false);
		expect(judge(l).silent).toEqual([]);
		l = fold(l, 3, sweep(15, [["kept", true]]), false);
		expect(Object.keys(l.cases)).toEqual(["kept"]);
	});
});
