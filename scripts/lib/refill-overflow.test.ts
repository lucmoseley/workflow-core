// @vitest-environment node
/*
 * The refill loop's overflow seats (#2611, spec #2570) past their reading:
 * an overflow seat on a plan seat's dir picked as its own seat (#3693), and
 * the dry run's line naming the key a launch bills, and a headless launch
 * judged finished by its absence from the listing, its acts read by the
 * session id it carried from launch. The readings themselves are
 * seat-reading.test.ts's; the finish reads the real headless store under the
 * setup's WFC_REFILL_DIR.
 *
 * Loosen one and a launch bills the wrong key, a shared dir's two seats are
 * taken as one, or an overflow launch never counts toward the no-progress
 * pause.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readLiveAgents } from "./headless-runs.js";
import { headlessStore, writeHeadlessRun } from "./headless-runs-testkit";
import { batchesOf, buildWouldRunLine, dispatchCall } from "./refill-batch.js";
import { decideTick, FULL, pickSeat } from "./refill-decide.js";
import { actsOf, judgedLaunches } from "./refill-loop.js";
import { seat } from "./refill-loop-fixture";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60 * 1000;

const planSeat = (name: string, weekFull: boolean) =>
	seat(name, weekFull ? FULL : 50, 10);

describe("an overflow seat on a plan seat's dir (#3693)", () => {
	const launch = (over: {
		keyVar?: string;
		reason: "overflow" | "soonest reset";
	}) => ({
		root: "/r",
		issues: [7],
		prompt: "/implement 7",
		model: "opus" as const,
		seat: "/h/.claude2",
		...over,
	});

	it("is picked with its key once the plan seat is weekly-full", () => {
		const pick = pickSeat({
			seats: [{ ...planSeat("/h/.claude2", true), fits: 0 } as never],
			overflow: [
				{
					seat: "/h/.claude2",
					keyVar: "K2",
					fits: 2,
					spentUntil: null,
					why: null,
				},
			],
		});
		expect(pick).toMatchObject({
			seat: "/h/.claude2",
			keyVar: "K2",
			reason: "overflow",
		});
	});

	it("gets a dispatcher call of its own, which alone names the key", () => {
		const batches = batchesOf([
			launch({ reason: "soonest reset" }),
			launch({ keyVar: "K2", reason: "overflow" }),
			launch({ keyVar: "K2", reason: "overflow" }),
		]);
		expect(batches.map((b) => b.length)).toEqual([1, 2]);
		const [plan, overflow] = batches.map(
			(b) => dispatchCall(b, "/d.sh", { PATH: "/usr/bin" }).env,
		);
		expect(plan?.WFC_SEAT_KEY).toBeUndefined();
		expect(overflow?.WFC_SEAT_KEY).toBe("K2");
		expect(overflow?.CLAUDE_CONFIG_DIR).toBe("/h/.claude2");
	});
});

describe("the dry run's dispatch line", () => {
	const call = dispatchCall(
		[
			{
				root: "/home/u/wfc",
				issues: [7],
				prompt: "/implement 7",
				model: "opus",
				seat: "/home/u/.claude2",
				keyVar: "WFC_KEY",
				reason: "overflow",
			},
		],
		"/core/dispatch-sessions.sh",
		{ PATH: "/usr/bin" },
	);
	const { WFC_SEAT_KEY: _key, ...planEnv } = call.env;

	it("names the key an overflow seat bills, and only there", () => {
		expect(buildWouldRunLine(call)).toBe(
			"would run in /home/u/wfc on overflow seat /home/u/.claude2, each member billed to key=WFC_KEY: bash /core/dispatch-sessions.sh opus /implement 7",
		);
		expect(buildWouldRunLine({ ...call, env: planEnv })).toBe(
			"would run in /home/u/wfc on /home/u/.claude2: bash /core/dispatch-sessions.sh opus /implement 7",
		);
	});
});

describe("a headless launch's finish (#2611)", () => {
	const refill = String(process.env.WFC_REFILL_DIR);
	afterEach(() =>
		fs.rmSync(headlessStore(refill), { recursive: true, force: true }),
	);

	const launch = (jobId: string, launchedAt = NOW - 10 * MIN) => ({
		root: "/home/u/wfc",
		issues: [Number.parseInt(jobId, 16) % 1000],
		prompt: `/implement ${jobId}`,
		seat: "/home/u/.claude2",
		jobId,
		sessionId: `session-${jobId}`,
		launchedAt,
		finishedAt: null,
	});
	const judge = (launches: ReturnType<typeof launch>[]) =>
		judgedLaunches(launches, readLiveAgents(), NOW, {
			progressOf: (l) =>
				actsOf(l, ["/home/u/wfc"], (sessionId) => ({
					acts: sessionId === "session-0000000a" ? ["claim #10"] : [],
					unreadable: [],
				})),
			causeOf: () => ({ cause: "QUESTION" }) as never,
		});

	it("is judged by its absence from the listing, its acts read by its launch-time session id", () => {
		writeHeadlessRun(refill, "0000000b", "session-0000000b");
		writeHeadlessRun(refill, "0000000a", "session-0000000a", { live: false });
		const [ended, live] = judge([launch("0000000a"), launch("0000000b")]);
		expect(ended).toMatchObject({ finishedAt: NOW, acts: { claim: 1 } });
		expect(live).toMatchObject({ finishedAt: null });
	});

	it("counts toward the no-progress pause", () => {
		const history = judge(
			["0000000c", "0000000d", "0000000e"].map((id) => launch(id)),
		);
		expect(history.map((l) => l.acts)).toEqual([{}, {}, {}]);
		expect(
			decideTick({
				now: NOW,
				mode: "normal" as const,
				noProgressFrom: NOW - 60 * MIN,
				stopRequested: false,
				frontier: [],
				retroBundles: [],
				running: [],
				freeSlots: 2,
				seats: [{ ...planSeat("a", true), fits: null }],
				overflow: [
					{
						seat: "/home/u/.claude2",
						fits: 5,
						spentUntil: null,
						why: null,
					},
				],
				history,
				lastActAt: null,
			}),
		).toHaveProperty("pause.by", "no-progress");
	});
});
