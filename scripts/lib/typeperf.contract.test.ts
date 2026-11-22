// @vitest-environment node

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
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typeperf-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const CALL_MS = 15_000;
const CASE_MS = CALL_MS + 5000;

const CASES = [
	{
		name: "one sample is one CSV row whose every named counter parseTypeperf reads",
		check(bin: string, complete: boolean) {
			const r = spawnSync(bin, [...COUNTERS, "-sc", "1"], {
				encoding: "utf8",
				timeout: CALL_MS,
			});
			if (r.error) throw r.error;
			expect(r.status).toBe(0);
			const lines = r.stdout.split(/\r?\n/);
			const header = lines.find((l) => l.startsWith('"(')) ?? "";
			const row = lines.find((l) => /^"\d/.test(l)) ?? "";
			const named = COUNTERS.filter((c) => header.includes(`${c}"`));
			if (complete) expect(named, r.stdout).toEqual(COUNTERS);
			else expect(named.length, r.stdout).toBeGreaterThan(0);
			expect(header.split('","'), r.stdout).toHaveLength(named.length + 1);
			expect(row.split('","'), r.stdout).toHaveLength(named.length + 1);
			const read = Object.values(parseTypeperf(r.stdout)).filter(
				(v) => v !== null,
			);
			expect(read, r.stdout).toHaveLength(named.length);
			for (const v of read) expect(v).toBeGreaterThanOrEqual(0);
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
				true,
			),
		);
});

describe("the real typeperf.exe", () => {
	for (const c of CASES)
		it.skipIf(!reachable)(c.name, { timeout: CASE_MS }, () =>
			c.check(REAL, false),
		);
});
