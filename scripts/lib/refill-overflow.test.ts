// @vitest-environment node
/*
 * The refill loop's overflow seats (#2611, spec #2570) past their reading:
 * an overflow seat on a plan seat's dir picked as its own seat (#3693), and
 * the dry run's line naming the key a launch bills. The readings themselves
 * are seat-reading.test.ts's.
 *
 * Loosen one and a launch bills the wrong key, or a shared dir's two seats
 * are taken as one.
 */
import { describe, expect, it } from "vitest";
import { batchesOf, buildWouldRunLine, dispatchCall } from "./refill-batch.js";
import { FULL, pickSeat } from "./refill-decide.js";
import { seat } from "./refill-loop-fixture";

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
