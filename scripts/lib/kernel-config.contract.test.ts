// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStallNow, writeKernelConfig } from "./kernel-stall-fixture";

const REAL = "/proc/config.gz";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-config-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([
	{
		side: "the fixture",
		config: () => writeKernelConfig(path.join(dir, "fake.gz"), 100),
		present: () => true,
	},
	{
		side: "the real config",
		config: () => REAL,
		present: () => fs.existsSync(REAL),
	},
])("$side", ({ config, present }) => {
	it("converts a stall's t to seconds", ({ skip }) => {
		if (!present()) return skip(`no ${REAL} here`);
		const { tS } = readStallNow(dir, { WFC_KERNEL_CONFIG: config() });
		expect(tS).toBeGreaterThan(0);
	});
});
