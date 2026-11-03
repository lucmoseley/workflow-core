// @vitest-environment node
/*
 * Holds lib/wevtutil-fake.ts to the real wevtutil.exe (#4081): each side runs
 * check-kernel-stall.js's Windows reader on a large `t` and checks shape and
 * verdict, never values. Loosened, a Windows that prints another stamp reads
 * as uptime unknown and no leap is counted, with the fake's tests still green.
 *
 * The real side runs where wevtutil.exe answers, never in CI: the event log is
 * the founder's machine's.
 *
 * Red on the real side after a Windows update: run readWindowsBoots's query by
 * hand, then fix it or the fake.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStallNow } from "./kernel-stall-fixture";
import { writeWevtutil } from "./wevtutil-fake";

/** check-kernel-stall.js's own read budget. */
const WEVTUTIL_PROBE_MS = 5000;
/** The probe and the read in full, with margin on a loaded machine. Untraced. */
const REAL_CASE_MS = 15_000;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wevtutil-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const hasRealWevtutil = () =>
	!process.env.GITHUB_ACTIONS &&
	spawnSync("wevtutil.exe", ["el"], {
		stdio: "ignore",
		timeout: WEVTUTIL_PROBE_MS,
	}).status === 0;

describe.each([
	{
		side: "the fake",
		bin: () => writeWevtutil(path.join(dir, "fake"), [Date.now() - 3_600_000]),
		present: () => true,
	},
	{
		side: "the real wevtutil.exe",
		bin: () => "wevtutil.exe",
		present: hasRealWevtutil,
	},
])("$side", ({ bin, present }) => {
	it(
		"gives check-kernel-stall.js a Windows uptime from Event 12",
		({ skip }) => {
			if (!present()) return skip("no answering wevtutil.exe here");
			const { windowsUptimeS } = readStallNow(dir, { WFC_WEVTUTIL: bin() });
			expect(windowsUptimeS).toBeGreaterThan(0);
		},
		REAL_CASE_MS,
	);
});
