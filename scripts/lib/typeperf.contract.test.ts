// @vitest-environment node
/*
 * Holds lib/typeperf-fake.ts to the real typeperf.exe (§G7, #2207, #3564):
 * each case runs against the fake and the machine's own typeperf over the
 * interop bridge and checks shape and verdict, never values. Loosened, every
 * check-interop-latency.js test stays green on the fake while a Windows update
 * changes typeperf's CSV and production records every counter as null.
 *
 * The real side runs where typeperf is reachable, never in CI (§G7 item 2):
 * one sample is a free read with no side effect.
 *
 * Red on the real side: run the case's command by hand, then fix
 * lib/interop-latency.js's parseTypeperf or the fake's builder.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeTypeperf } from "./typeperf-fake";

const { COUNTERS, parseTypeperf } = require("./interop-latency.js") as {
	COUNTERS: string[];
	parseTypeperf: (stdout: string) => Record<string, number | null>;
};

const REAL = "/mnt/c/Windows/System32/typeperf.exe";
const reachable = (() => {
	try {
		fs.accessSync(REAL, fs.constants.X_OK);
		return !process.env.CI;
	} catch {
		// Not WSL: the real side skips.
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typeperf-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* check-interop-latency.js's TYPEPERF_BUDGET_MS, for its reason. */
const CALL_MS = 15_000;
/* The call's budget, plus a margin for vitest's own start under load. */
const CASE_MS = CALL_MS + 5000;

const CASES = [
	{
		name: "one sample is one CSV row whose every named counter parseTypeperf reads",
		check(bin: string) {
			const r = spawnSync(bin, [...COUNTERS, "-sc", "1"], {
				encoding: "utf8",
				timeout: CALL_MS,
			});
			if (r.error) throw r.error;
			expect(r.status).toBe(0);
			const header = r.stdout.split(/\r?\n/).find((l) => l.startsWith('"('));
			// typeperf has twice dropped one column under load (#3564), which
			// parseTypeperf reads as that counter alone missing: so every column
			// the header names must be one asked for, and must parse.
			const named = COUNTERS.filter((c) => header?.includes(c));
			expect(named.length, r.stdout).toBeGreaterThan(0);
			expect(header?.split('","'), r.stdout).toHaveLength(named.length + 1);
			const parsed = parseTypeperf(r.stdout);
			const keys = ["cpuPct", "availableMb", "vmmemMb"];
			for (const [i, c] of COUNTERS.entries())
				if (named.includes(c))
					expect(parsed[keys[i] ?? ""], r.stdout).toBeGreaterThanOrEqual(0);
		},
	},
];

describe("the fake", () => {
	for (const c of CASES)
		it(c.name, () =>
			c.check(
				writeTypeperf(path.join(dir, "fake"), {
					cpuPct: 15.5,
					availableMb: 2431,
					vmmemBytes: 4 * 2 ** 30,
				}),
			),
		);
});

describe("the real typeperf.exe", () => {
	for (const c of CASES)
		it.skipIf(!reachable)(c.name, { timeout: CASE_MS }, () => c.check(REAL));
});
