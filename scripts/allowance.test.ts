// @vitest-environment node
/*
 * The thin CLI over lib/allowance.js — argv parsing, the stdin fallback and
 * the exit-code contract `dispatch-sessions.sh` reads. The reader's own
 * arithmetic (staleness, kind matching, JSON-vs-text priority) is
 * lib/allowance.test.ts's. The contract is #293's and #294's; `--cap` is
 * #371's.
 *
 * Run in process through runInProcess (§X3), with `--config-dir` at a temp
 * directory holding a fabricated usage cache, so the founder's live allowance
 * is never read and the bars are figures this suite chose.
 *
 * Loosen a case and dispatch-sessions.sh can size a launch off an
 * untrustworthy bar, starting sessions the allowance cannot carry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "allowance.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeCache = (configDir: string, limits: Record<string, unknown>[]) => {
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: {
				fetchedAtMs: Date.now(),
				utilization: { limits },
			},
		}),
	);
};

describe("the allowance CLI's trust-drives-exit-code contract (#293, #294)", () => {
	it("exits 0 and prints both bars where the JSON reading is fresh", () => {
		writeCache(dir, [
			{ kind: "session", percent: 23 },
			{ kind: "weekly_all", percent: 7 },
		]);
		const r = runInProcess(SCRIPT, ["--json", "--config-dir", dir], {
			stdin: "",
		});
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.session.percent).toBe(23);
		expect(json.weekly_all.percent).toBe(7);
	});

	it("exits 1 where either bar is not trustworthy, recording the missing bar as absent", () => {
		writeCache(dir, [{ kind: "session", percent: 23 }]);
		const r = runInProcess(SCRIPT, ["--json", "--config-dir", dir], {
			stdin: "",
		});
		expect(r.status).toBe(1);
		const json = JSON.parse(r.stdout);
		expect(json.weekly_all.trust).toBe("absent");
	});

	it("falls back to a piped usage transcript on stdin", () => {
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", path.join(dir, "nope")],
			{
				stdin:
					"Current session: 12% used · resets Aug 23, 11:49pm\n" +
					"Current week (all models): 3% used · resets Aug 30, 7:59pm\n",
			},
		);
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.session.percent).toBe(12);
		expect(json.weekly_all.percent).toBe(3);
	});

	it("prints readable text, not JSON, without --json", () => {
		writeCache(dir, [
			{ kind: "session", percent: 23 },
			{ kind: "weekly_all", percent: 7 },
		]);
		const r = runInProcess(SCRIPT, ["--config-dir", dir], { stdin: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/session\s+23% \(fresh\)/);
		expect(r.stdout).toMatch(/weekly_all\s+7% \(fresh\)/);
	});
});

describe("--cap (#371)", () => {
	/** A `claude` whose `agents --json` answers `listing`, and a $10-mean
	 * cost table: 4.7 points of the 5-hour bar a session, all of it landing
	 * within an hour. */
	const capEnv = (listing: string) => {
		const bin = path.join(dir, "claude");
		fs.writeFileSync(bin, `#!/bin/bash\nprintf '%s\\n' '${listing}'\n`, {
			mode: 0o755,
		});
		const table = path.join(dir, "table.json");
		fs.writeFileSync(
			table,
			JSON.stringify({
				n: 1,
				meanUsd: 10,
				quantilesUsd: [1, 10, 30],
				tailRemainderUsd: 5,
				landedByHours: [[1, 1]],
			}),
		);
		return {
			...process.env,
			WFC_CLAUDE_BIN: bin,
			WFC_SESSION_COST_TABLE: table,
			CLAUDE_CONFIG_DIR: dir,
		};
	};
	const capRun = (
		args: string[],
		listing: string,
		session: Record<string, unknown> = {},
	) => {
		writeCache(dir, [
			{ kind: "session", percent: 94, ...session },
			{ kind: "weekly_all", percent: 7 },
		]);
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", dir, "--cap", "3", ...args],
			{ stdin: "", env: capEnv(listing) },
		);
		return JSON.parse(r.stdout).cap;
	};
	const thresholds = ["--session-threshold", "90", "--week-threshold", "97"];

	it("reads an empty listing as nothing running, not as unreadable", () => {
		// Headroom 100 − 94 = 6: two 4.7-point members reach it.
		const cap = capRun(thresholds, "[]");
		expect(cap.error).toBeUndefined();
		expect(cap).toMatchObject({ launch: 2, running: [] });
	});

	it("counts only the spend projected to land before the bar resets (#2925)", () => {
		// Half an hour to the reset: half of each $10 lands before it, 2.35
		// points. Headroom 6 − 2.35 for the running session leaves room for two.
		const resetsAt = new Date(Date.now() + 1_800_000).toISOString();
		const listing = '[{"sessionId":"s1","state":"working"}]';
		const soon = capRun(thresholds, listing, { resets_at: resetsAt });
		expect(soon.error).toBeUndefined();
		expect(soon.binding.runningPoints).toBeCloseTo(2.35, 1);
		expect(soon.binding.perSessionPoints).toBeCloseTo(2.35, 1);
		expect(soon.launch).toBe(2);
		// A reset that does not parse counts all of it: 6 − 4.7 leaves one.
		const unparsed = capRun(thresholds, listing, { resets_at: "soon" });
		expect(unparsed.binding.runningPoints).toBeCloseTo(4.7, 1);
		expect(unparsed.launch).toBe(1);
	});

	it("refuses to size the cap on a listing that is not JSON", () => {
		const cap = capRun(thresholds, "garbage");
		expect(cap).toMatchObject({ launch: 0 });
		expect(cap.error).toMatch(/running sessions unreadable/);
	});

	it("names the plugin's own copy of the table builder where the table is missing in an install (#1734)", () => {
		const install = path.join(dir, "install");
		fs.mkdirSync(install);
		writeCache(dir, [
			{ kind: "session", percent: 94 },
			{ kind: "weekly_all", percent: 7 },
		]);
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", dir, "--cap", "3", ...thresholds],
			{
				stdin: "",
				env: {
					...capEnv("[]"),
					WFC_SESSION_COST_TABLE: path.join(dir, "no-such-table.json"),
					WFC_SCRIPT_ROOT: install,
				},
			},
		);
		expect(JSON.parse(r.stdout).cap).toEqual({
			launch: 0,
			error: `the session cost table is unreadable — build it: node ${install}/scripts/measure-session-cost.js --write`,
		});
	});

	it("refuses a missing threshold, launching none and asking for numbers, rather than reading it as NaN and launching all", () => {
		const cap = capRun(["--session-threshold", "90"], "[]");
		expect(cap).toMatchObject({ launch: 0 });
		expect(cap.error).toMatch(/need numbers/);
	});

	it("launches the whole set below both thresholds without reading the listing", () => {
		const cap = capRun(
			["--session-threshold", "95", "--week-threshold", "97"],
			"garbage",
		);
		expect(cap).toMatchObject({ launch: 3, binding: null });
	});
});
