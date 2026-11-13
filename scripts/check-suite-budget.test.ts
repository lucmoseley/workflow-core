// @vitest-environment node
/*
 * Pins check-suite-budget.js end to end over `--reports`, sweeps already on
 * disk as `gh run download` leaves them. The sum and the arming are
 * scripts/lib/suite-budget.test.ts's: the armed record is a committed
 * constant, so a refusal is pinned there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-suite-budget.js");
const { hostRoot } = require("./lib/host-root.js");

const ROOT = hostRoot();
const A = "scripts/check-suite-budget.test.ts";
const B = "scripts/lib/suite-budget.test.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-suite-budget-"));
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

describe("check-suite-budget.js", () => {
	it("prints OK for a sum inside the budget", () => {
		for (const r of ["3", "2", "1"]) writeSweep(r, { [A]: 300, [B]: 200 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain(
			"OK: 2 test files' median CI times over their last 3 sweeps (latest 3, 2, 1) sum to 500 s, inside the 786 s budget",
		);
	});

	it("reports a sum over the budget, slowest first, while unarmed, and exits 0", () => {
		for (const r of ["3", "2", "1"]) writeSweep(r, { [A]: 700, [B]: 200 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain("sum to 900 s, 114 s over the 786 s budget");
		expect(out).toContain(`700 s  ${A}\n  200 s  ${B}`);
		expect(out).toContain("Reported only: no cold lone whole suite");
		expect(out).toContain("WARN: 1 suite over its budget");
	});

	it("skips, judging nothing, on fewer than three sweeps", () => {
		writeSweep("1", { [A]: 1 });
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toContain("judged nothing: 1 sweep(s)");
		expect(out).not.toContain("OK:");
	});
});
