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
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildListedRow,
} from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import {
	declareOverflowSeat,
	writeOverflowCheckout,
	writeUnreadableLedgerCheckout,
} from "./lib/overflow-launch-fake";
import { runInProcess } from "./lib/run-in-process";
import {
	type Bars,
	buildUsageCache,
	buildUsageText,
} from "./lib/usage-probe-fake";

const SCRIPT = path.resolve(__dirname, "allowance.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fresh seat cache of `bars`; an absent `sessionResetsAt` resets the
 * session bar one window after the stamp. */
const writeCache = (
	configDir: string,
	bars: Bars,
	sessionResetsAt?: string,
) => {
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify(
			buildUsageCache(bars, Date.now(), {
				resetsAt: { session: sessionResetsAt },
			}),
		),
	);
};

describe("the allowance CLI's trust-drives-exit-code contract (#293, #294)", () => {
	it("exits 0 and prints both bars where the JSON reading is fresh", () => {
		writeCache(dir, { session: 23, week: 7 });
		const r = runInProcess(SCRIPT, ["--json", "--config-dir", dir], {
			stdin: "",
		});
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.session.percent).toBe(23);
		expect(json.weekly_all.percent).toBe(7);
	});

	it("exits 1 where the cached session bar is stale and the transcript names the weekly bar alone, recording it stale", () => {
		fs.writeFileSync(
			path.join(dir, ".claude.json"),
			JSON.stringify(
				buildUsageCache({ session: 23 }, Date.now() - 10 * 60 * 1000),
			),
		);
		const r = runInProcess(SCRIPT, ["--json", "--config-dir", dir], {
			stdin: buildUsageText({ week: 7 }),
		});
		expect(r.status).toBe(1);
		const json = JSON.parse(r.stdout);
		expect(json.session.trust).toBe("stale");
		expect(json.weekly_all.trust).toBe("fresh");
		expect(json.trustworthy).toBe(false);
	});

	it("exits 1 where neither source reads, recording both bars absent", () => {
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", path.join(dir, "nope")],
			{ stdin: "" },
		);
		expect(r.status).toBe(1);
		const json = JSON.parse(r.stdout);
		expect(json.session.trust).toBe("absent");
		expect(json.weekly_all.trust).toBe("absent");
		expect(json.trustworthy).toBe(false);
	});

	it("exits 0 and sizes the cap on a fresh weekly bar where the account reports no session bar (#3758)", () => {
		writeCache(dir, { week: 0 });
		const r = runInProcess(
			SCRIPT,
			[
				"--json",
				"--config-dir",
				dir,
				"--cap",
				"3",
				"--session-threshold",
				"90",
				"--week-threshold",
				"97",
			],
			{ stdin: "" },
		);
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.session.trust).toBe("unreported");
		expect(json.trustworthy).toBe(true);
		expect(json.cap.launch).toBe(3);
	});

	it("falls back to a piped usage transcript on stdin", () => {
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", path.join(dir, "nope")],
			{
				stdin: buildUsageText({ session: 12, week: 3 }),
			},
		);
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		expect(json.session.percent).toBe(12);
		expect(json.weekly_all.percent).toBe(3);
	});

	it("prints readable text, not JSON, without --json", () => {
		writeCache(dir, { session: 23, week: 7 });
		const r = runInProcess(SCRIPT, ["--config-dir", dir], { stdin: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/session\s+23% \(fresh\)/);
		expect(r.stdout).toMatch(/weekly_all\s+7% \(fresh\)/);
	});

	it("prints an unreported bar as not reported, without --json", () => {
		writeCache(dir, { week: 7 });
		const r = runInProcess(SCRIPT, ["--config-dir", dir], { stdin: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/session\s+not reported \(unreported\)/);
	});
});

describe("--cap (#371)", () => {
	/** A `claude` whose `agents --json` answers `listing`, and a $10-mean
	 * cost table: 4.7 points of the 5-hour bar a session, all of it landing
	 * within an hour. */
	const capEnv = (listing: AgentsAnswer) => {
		const bin = writeClaudeStub(path.join(dir, "claude"), [
			buildAgentsBranch(listing),
		]);
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
			HOME: dir,
		};
	};
	/** `--cap` over a 94% session, 7% week cache, its session bar resetting
	 * at `sessionResetsAt`, else one window out. */
	const capRun = (
		args: string[],
		listing: AgentsAnswer,
		sessionResetsAt?: string,
	) => {
		writeCache(dir, { session: 94, week: 7 }, sessionResetsAt);
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", dir, "--cap", "3", ...args],
			{ stdin: "", env: capEnv(listing) },
		);
		return JSON.parse(r.stdout).cap;
	};
	const thresholds = ["--session-threshold", "90", "--week-threshold", "97"];

	it("projects only the plan session where a seat's dir also holds an overflow one (#3696)", () => {
		const plan = "bbbbbbbb-0000-4000-8000-000000000000";
		const overflow = "aaaaaaaa-0000-4000-8000-000000000000";
		writeOverflowCheckout(dir, "other-checkout", [overflow]);
		for (const sessionId of [plan, overflow]) {
			const project = path.join(dir, "projects", "p1");
			fs.mkdirSync(project, { recursive: true });
			fs.writeFileSync(
				path.join(project, `${sessionId}.jsonl`),
				JSON.stringify({
					type: "assistant",
					requestId: "r1",
					message: {
						model: "claude-sonnet-5",
						usage: { output_tokens: 1_000_000 },
					},
				}),
			);
		}
		const listing = [plan, overflow].map((sessionId) =>
			buildListedRow({ sessionId, startedAt: Date.now() }),
		);
		const cap = capRun(thresholds, listing);
		expect(cap.error).toBeUndefined();
		expect(
			cap.running.map((r: { sessionId: string; spentUsd: number }) => [
				r.sessionId,
				r.spentUsd,
			]),
		).toEqual([[plan, 10]]);
	});

	it("refuses the launch where an overflow seat is declared and the launch record will not read", () => {
		declareOverflowSeat(dir);
		writeUnreadableLedgerCheckout(dir, "broken-checkout");
		const cap = capRun(thresholds, []);
		expect(cap.launch).toBe(0);
		expect(cap.error).toContain(path.join(dir, "broken-checkout"));
		expect(cap.error).toContain("fix that read and re-run");
	});

	it("caps as before where no overflow seat is declared, however the launch record reads (#4393)", () => {
		const readable = capRun(thresholds, []);
		writeUnreadableLedgerCheckout(dir, "broken-checkout");
		const unreadable = capRun(thresholds, []);
		expect(readable.error).toBeUndefined();
		expect(unreadable).toEqual(readable);
	});

	it("reads an empty listing as nothing running, not as unreadable", () => {
		// Headroom 100 − 94 = 6: two 4.7-point members reach it.
		const cap = capRun(thresholds, []);
		expect(cap.error).toBeUndefined();
		expect(cap).toMatchObject({ launch: 2, running: [] });
	});

	it("counts only the spend projected to land before the bar resets (#2925)", () => {
		// Half an hour to the reset: half of each $10 lands before it, 2.35
		// points. Headroom 6 − 2.35 for the running session leaves room for two.
		const resetsAt = new Date(Date.now() + 1_800_000).toISOString();
		const listing = [
			buildListedRow({ sessionId: "s1", startedAt: Date.now() }),
		];
		const soon = capRun(thresholds, listing, resetsAt);
		expect(soon.error).toBeUndefined();
		expect(soon.binding.runningPoints).toBeCloseTo(2.35, 1);
		expect(soon.binding.perSessionPoints).toBeCloseTo(2.35, 1);
		expect(soon.launch).toBe(2);
		// A reset that does not parse counts all of it: 6 − 4.7 leaves one.
		const unparsed = capRun(thresholds, listing, "soon");
		expect(unparsed.binding.runningPoints).toBeCloseTo(4.7, 1);
		expect(unparsed.launch).toBe(1);
	});

	it("refuses to size the cap on a listing that is not JSON", () => {
		const cap = capRun(thresholds, { malformed: "garbage" });
		expect(cap).toMatchObject({ launch: 0 });
		expect(cap.error).toMatch(/running sessions unreadable/);
	});

	it("names the plugin's own copy of the table builder where the table is missing in an install (#1734)", () => {
		const install = path.join(dir, "install");
		fs.mkdirSync(install);
		writeCache(dir, { session: 94, week: 7 });
		const r = runInProcess(
			SCRIPT,
			["--json", "--config-dir", dir, "--cap", "3", ...thresholds],
			{
				stdin: "",
				env: {
					...capEnv([]),
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
		const cap = capRun(["--session-threshold", "90"], []);
		expect(cap).toMatchObject({ launch: 0 });
		expect(cap.error).toMatch(/need numbers/);
	});

	it("launches the whole set below both thresholds without reading the listing", () => {
		const cap = capRun(
			["--session-threshold", "95", "--week-threshold", "97"],
			{ malformed: "garbage" },
		);
		expect(cap).toMatchObject({ launch: 3, binding: null });
	});
});
