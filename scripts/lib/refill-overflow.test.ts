// @vitest-environment node
/*
 * The refill loop's overflow seats (#2611, spec #2570): each seat's budget
 * read for the decision core only once every plan seat is weekly-full, a key
 * spent for its cycle told from one held by running sessions, and the dry
 * run's line naming the key a launch bills.
 *
 * The readings and the line are module cases with the budget gate injected,
 * since its settling is overflow-budget.test.ts's.
 *
 * Loosen one and the loop spends credits while plan allowance remains, or
 * stops while a key's running sessions are about to reopen it.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { batchesOf, buildWouldRunLine, dispatchCall } from "./refill-batch.js";
import { FULL, pickSeat } from "./refill-decide.js";
import { overflowReadings } from "./refill-loop.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");

const planSeat = (seat: string, weekFull: boolean) => ({
	seat,
	week: weekFull ? FULL : 50,
	session: 10,
	weekFull,
	sessionFull: false,
	sessionResets: null,
	weekResets: null,
	readAt: NOW,
	weekRead: { percent: null, atMs: null },
});

const overflowSeat = (dir: string) => ({
	dir,
	kind: "overflow" as const,
	keyVar: `KEY_${path.basename(dir)}`,
	grantUsd: 200,
	cycleDay: 20,
});

const budget = (over: Record<string, unknown> = {}) => ({
	fit: 5,
	headroomUsd: 20,
	settledUsd: 100,
	reservedUsd: 80,
	creditUsd: 200,
	grantUsd: 200,
	readAt: null,
	qUsd: 4,
	running: 2,
	cycleStart: new Date(2026, 9, 20).getTime(),
	nextCycleStart: new Date(2026, 10, 20).getTime(),
	exhausted: false,
	...over,
});

describe("each overflow seat's reading", () => {
	const list = (...overflow: ReturnType<typeof overflowSeat>[]) => ({
		seats: [{ dir: "/s/plan", kind: "plan" as const }, ...overflow],
		errors: [],
	});
	const both = list(overflowSeat("/s/x"), overflowSeat("/s/y"));
	const first = list(overflowSeat("/s/x"));

	it("reads no budget while a plan seat is not weekly-full", () => {
		const read: string[] = [];
		const out = overflowReadings(
			both,
			[planSeat("a", true), planSeat("b", false)],
			(s) => {
				read.push(s.dir);
				return budget();
			},
		);
		expect(read).toEqual([]);
		expect(out.map((o) => o.fits)).toEqual([null, null]);
	});

	it("gives each seat's fit once every plan seat is weekly-full", () => {
		const fits = [3, 0];
		const out = overflowReadings(both, [planSeat("a", true)], () =>
			budget({ fit: fits.shift() }),
		);
		expect(out).toEqual([
			{ seat: "/s/x", keyVar: "KEY_x", fits: 3, spentUntil: null, why: null },
			{ seat: "/s/y", keyVar: "KEY_y", fits: 0, spentUntil: null, why: null },
		]);
	});

	it("marks a key spent until its cycle ends where refused for credit or settled past one reservation", () => {
		const until = "2026-11-20";
		for (const b of [
			budget({ fit: 0, exhausted: true }),
			budget({ fit: 0, settledUsd: 197, reservedUsd: 0, headroomUsd: 3 }),
		])
			expect(
				overflowReadings(first, [planSeat("a", true)], () => b)[0],
			).toMatchObject({ fits: 0, spentUntil: until });
	});

	it("passes an unread budget's reason on", () => {
		expect(
			overflowReadings(first, [planSeat("a", true)], () => ({
				why: "the session cost table is unreadable",
			})),
		).toEqual([
			{
				seat: "/s/x",
				keyVar: "KEY_x",
				fits: null,
				spentUntil: null,
				why: "the session cost table is unreadable",
			},
		]);
	});

	it("reads a seat file that refuses as one unread seat, so the tick waits on it", () => {
		const out = overflowReadings(
			{ seats: [], errors: ["refill-seats:2: missing cycle-day="] },
			[planSeat("a", true)],
			() => budget(),
		);
		expect(out).toEqual([
			{
				seat: "the seat file",
				fits: null,
				spentUntil: null,
				why: "it refuses: refill-seats:2: missing cycle-day=",
			},
		]);
	});
});

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

describe("a spent key anchored to a Console reading", () => {
	it("waits on a newer reading, not on the cycle day", () => {
		const dir = "/h/.claude3";
		const [reading] = overflowReadings(
			{ seats: [overflowSeat(dir)], errors: [] },
			[{ weekFull: true } as never],
			() => budget({ readAt: 1, creditUsd: 2, settledUsd: 0 }) as never,
		);
		expect(reading.spentUntil).toBe("a newer Console reading");
	});
});
