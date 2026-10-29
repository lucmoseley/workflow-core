// @vitest-environment node
/*
 * Holds lib/reg-fake.ts to the real reg.exe (§G7, #2207, #3564): each case
 * runs against the fake and the machine's own reg.exe over the interop bridge
 * and checks shape, never values. Loosened, every check-interop-latency.js
 * test stays green on the fake while the real query answers in a way the
 * check reads as a bridge that cannot be probed.
 *
 * The real side runs where reg.exe is reachable, never in CI (§G7 item 2): a
 * query of an absent key is a free read with no side effect.
 *
 * Red on the real side: run the case's query by hand, then fix the fake.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REG_ABSENT, writeReg } from "./reg-fake";

const REAL = "/mnt/c/Windows/System32/reg.exe";
const reachable = (() => {
	try {
		fs.accessSync(REAL, fs.constants.X_OK);
		return !process.env.CI;
	} catch {
		// Not WSL: the real side skips.
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* A degraded bridge's slowest measured call was 7.4 s (#3564). */
const CALL_MS = 10_000;
/* The call's budget, plus a margin for vitest's own start under load. */
const CASE_MS = CALL_MS + 5000;

const CASES = [
	{
		name: "the policy query of an absent key exits 1, its error on stderr and nothing on stdout",
		check(bin: string) {
			const r = spawnSync(
				bin,
				[
					"query",
					"HKCU\\SOFTWARE\\Policies\\ClaudeCode\\NoSuchContractKey",
					"/v",
					"Settings",
				],
				{ encoding: "utf8", timeout: CALL_MS },
			);
			if (r.error) throw r.error;
			expect(r.status).toBe(1);
			expect(r.stdout).toBe("");
			expect(r.stderr.trim()).toBe(REG_ABSENT);
		},
	},
];

describe("the fake", () => {
	for (const c of CASES)
		it(c.name, () => c.check(writeReg(path.join(dir, "fake"), [0])));
});

describe("the real reg.exe", () => {
	for (const c of CASES)
		it.skipIf(!reachable)(c.name, { timeout: CASE_MS }, () => c.check(REAL));
});
