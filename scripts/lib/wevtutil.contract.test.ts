// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStallNow } from "./kernel-stall-fixture";
import { runInProcessAsync } from "./run-in-process.js";
import { writeWevtutil } from "./wevtutil-fake";

const WEVTUTIL_PROBE_MS = 5000;
// #4081 guess
const REAL_CASE_MS = 15_000;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wevtutil-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const AWAY_LOAD = path.join(__dirname, "..", "away-load.js");

const hasRealWevtutil = () =>
	!process.env.GITHUB_ACTIONS &&
	spawnSync("wevtutil.exe", ["el"], {
		stdio: "ignore",
		timeout: WEVTUTIL_PROBE_MS,
	}).status === 0;

describe.each([
	{
		side: "the fake",
		bin: () =>
			writeWevtutil(path.join(dir, "fake"), [Date.now() - 3_600_000], {
				resets: [Date.now() - 7_200_000],
			}),
		present: () => true,
	},
	{
		side: "the real wevtutil.exe",
		bin: () => "wevtutil.exe",
		present: hasRealWevtutil,
	},
])("$side", ({ side, bin, present }) => {
	it(
		"gives check-kernel-stall.js a Windows uptime from Event 12",
		({ skip }) => {
			if (!present()) return skip("no answering wevtutil.exe here");
			const { windowsUptimeS } = readStallNow(dir, { WFC_WEVTUTIL: bin() });
			expect(windowsUptimeS).toBeGreaterThan(0);
		},
		REAL_CASE_MS,
	);

	it(
		"gives away-load.js recover the newest Kernel-Power 41's stamp",
		async ({ skip }) => {
			if (!present()) return skip("no answering wevtutil.exe here");
			const wevtutil = bin();
			const hasReset = () =>
				spawnSync(
					wevtutil,
					["qe", "System", "/q:*[System[(EventID=41)]]", "/c:1", "/f:xml"],
					{ encoding: "utf8", timeout: WEVTUTIL_PROBE_MS },
				).stdout?.trim();
			if (side !== "the fake" && !hasReset())
				return skip("no Kernel-Power 41 in this event log");
			const state = path.join(dir, "state");
			const r = await runInProcessAsync(AWAY_LOAD, ["recover"], {
				env: {
					...process.env,
					WFC_WEVTUTIL: wevtutil,
					WFC_AWAY_LOAD_STATE_DIR: state,
					WFC_AWAY_LOAD_LOG: path.join(dir, "away-load.jsonl"),
				},
			});
			expect(r.status).toBe(0);
			expect(fs.readFileSync(path.join(state, "seen-reset"), "utf8")).toMatch(
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/,
			);
		},
		REAL_CASE_MS,
	);
});
