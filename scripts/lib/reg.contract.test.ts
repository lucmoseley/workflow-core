// @vitest-environment node

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
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* A degraded bridge's slowest measured call was 7.4 s (#3564). */
const CALL_MS = 10_000;
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
