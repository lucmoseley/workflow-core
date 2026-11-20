// @vitest-environment node
/*
 * lib/refill-budget.js — the per-session gate-run budget (#5275). Broken, a
 * session that reruns the commit gate all night with nothing landing, as
 * design-vault #415 did, runs on.
 */
import { describe, expect, it } from "vitest";
import { fakeIo, logs } from "./refill-blocks-fixture";
import { parkOverBudget } from "./refill-budget.js";
import { NOW, record } from "./refill-loop-fixture";

type Launch = import("./refill-loop.js").LoopLaunch;
type ThroughputRead = import("./refill-breaker.js").ThroughputRead;
type GateRun = import("./gate-seat.js").GateRun;
type BlockIo = import("./refill-blocks.js").BlockIo;

const MIN = 60_000;
const DV = "/home/u/design-vault";
const LAUNCHED = NOW - 300 * MIN;

const gateRun = (minutesAgo: number, session = "s-job42"): GateRun => ({
	at: new Date(NOW - minutesAgo * MIN).toISOString(),
	repo: "design-vault",
	command: "npm run test",
	session,
	ticket: 42,
	waitS: 0,
	runS: 60,
	outcome: "red",
	peakTreeMb: 0,
});

const live = (over: Partial<Launch> = {}) =>
	({
		...record({ sessionId: "s-job42", launchedAt: LAUNCHED }),
		...over,
	}) as Launch;

const readOf = (
	gateRuns: GateRun[] | null,
	over: Partial<ThroughputRead> = {},
): ThroughputRead => ({
	byRoot: {
		[DV]: { commits: [], gateRuns, sessions: [], timelinesUnread: [] },
	},
	commitsOf: () => [],
	queueOf: () => ({ state: "gone" }),
	record: [],
	...over,
});

const runsAgo = (n: number, from = 10) =>
	Array.from({ length: n }, (_, i) => gateRun(from + i));

const tick = (
	launches: Launch[],
	read: ThroughputRead,
	over: Partial<BlockIo> = {},
) => {
	const { io, calls } = fakeIo(over);
	return {
		...parkOverBudget(launches, read, { now: NOW, io } as never),
		calls,
	};
};

describe("the gate-run budget (#5275)", () => {
	it("leaves a session at its 5th run since its launch running", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(5)));
		expect(launches[0]?.finishedAt).toBeNull();
		expect(events).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("parks one at its 6th: stopped, handed off, labelled parked and told why, the park recorded", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(6)));
		expect(launches[0]).toMatchObject({ finishedAt: NOW, budgetParked: NOW });
		expect(calls[0]).toBe("stop job42");
		expect(calls).toContain("hand-off job42");
		expect(calls.find((c) => c.startsWith("comment"))).toContain(
			"6th commit-gate run since its last landing",
		);
		expect(events).toEqual([
			{
				at: new Date(NOW).toISOString(),
				repo: DV,
				event: "budget-park",
				rate: null,
				workingHours: 0,
				session: "s-job42",
				ticket: 42,
			},
		]);
	});

	it("counts only from its last landing", () => {
		const read = readOf(runsAgo(8), {
			byRoot: {
				[DV]: {
					commits: [{ sha: "landed", at: NOW - 13.5 * MIN }],
					gateRuns: runsAgo(8),
					timelinesUnread: [],
					sessions: [],
				},
			},
			commitsOf: () => ["landed"],
		});
		/* Runs 10–13 minutes ago follow the landing; 14–17 precede it. */
		expect(tick([live()], read).events).toEqual([]);
	});

	it("counts its past sessions' runs, and no other session's or any before its launch", () => {
		const mine = [
			...runsAgo(3),
			...[20, 21, 22].map((m) => gateRun(m, "s-old")),
		];
		const others = [gateRun(30, "s-else"), gateRun(400)];
		const relaunched = live({ pastSessionIds: ["s-old"] });
		expect(
			tick([relaunched], readOf([...mine, ...others])).events,
		).toHaveLength(1);
		expect(tick([live()], readOf([...mine, ...others])).events).toEqual([]);
	});

	it("parks nothing off an unread gate-run record, or a finished launch", () => {
		expect(tick([live()], readOf(null)).events).toEqual([]);
		expect(
			tick([live({ finishedAt: NOW - MIN })], readOf(runsAgo(9))).events,
		).toEqual([]);
	});

	it("parks at its 6th run where its landing reads, and where it will not parks nothing and logs why (#5273)", () => {
		expect(tick([live()], readOf(runsAgo(8))).events).toHaveLength(1);
		const unreadMain = readOf(runsAgo(8), {
			byRoot: {
				[DV]: {
					commits: null,
					gateRuns: runsAgo(8),
					sessions: [],
					timelinesUnread: [],
				},
			},
		});
		const unreadLedger = readOf(runsAgo(8), { commitsOf: () => null });
		for (const [read, why] of [
			[unreadMain, "origin/main will not read"],
			[unreadLedger, "its commit ledger will not read"],
		] as const) {
			const { events, calls } = tick([live()], read);
			expect(events).toEqual([]);
			expect(logs(calls)).toEqual([
				expect.stringMatching(
					new RegExp(`^gate-run budget of .+ not judged: ${why}$`),
				),
			]);
		}
	});

	it("holds a session whose newest run passed and whose commit waits on the lander, or has landed there ahead of origin/main, and logs why (#5438)", () => {
		const passed = [{ ...gateRun(5), outcome: "pass" as const }, ...runsAgo(6)];
		for (const state of ["waiting", "landed"] as const) {
			const { launches, events, calls } = tick(
				[live()],
				readOf(passed, { queueOf: () => ({ state }) }),
			);
			expect(launches[0]?.finishedAt).toBeNull();
			expect(events).toEqual([]);
			expect(logs(calls)).toEqual([
				expect.stringMatching(
					/^gate-run budget of .+ held: its passed commit waits on the lander$/,
				),
			]);
		}
		const unread = readOf(passed, {
			queueOf: () => ({ state: "unread", why: "the remote is down" }),
		});
		const { events, calls } = tick([live()], unread);
		expect(events).toEqual([]);
		expect(logs(calls)).toEqual([
			expect.stringMatching(
				/^gate-run budget of .+ not judged: the remote is down$/,
			),
		]);
	});

	it("parks one whose commit waits on the lander but whose newest run is red, or whose passed commit left the queue (#5438)", () => {
		const waiting = { queueOf: () => ({ state: "waiting" as const }) };
		const newestRed = [
			...runsAgo(6),
			{ ...gateRun(20), outcome: "pass" as const },
		];
		expect(tick([live()], readOf(newestRed, waiting)).events).toHaveLength(1);
		const passed = [{ ...gateRun(5), outcome: "pass" as const }, ...runsAgo(6)];
		expect(tick([live()], readOf(passed)).events).toHaveLength(1);
	});

	it("logs a stop that fails and parks nothing, for the next tick to try again", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(6)), {
			stop: () => ({
				ok: false,
				why: "no",
				said: null,
				timedOut: false,
				noJob: false,
			}),
		});
		expect(launches[0]?.finishedAt).toBeNull();
		expect(events).toEqual([]);
		expect(calls.join("\n")).toContain("could not stop");
	});
});
