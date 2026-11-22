// @vitest-environment node
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

const SUITE = "npm run test";

const gateRun = (minutesAgo: number, session = "s-job42"): GateRun => ({
	at: new Date(NOW - minutesAgo * MIN).toISOString(),
	repo: "design-vault",
	tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	command: SUITE,
	session,
	ticket: 42,
	waitS: 0,
	runS: 60,
	wallS: 60,
	outcome: "red",
	peakTreeMb: 0,
});

const live = (over: Partial<Launch> = {}) =>
	({
		...record({ sessionId: "s-job42", launchedAt: LAUNCHED }),
		...over,
	}) as Launch;

const rootOf = (
	gateRuns: GateRun[] | null,
	over: Partial<ThroughputRead["byRoot"][string]> = {},
) => ({
	commits: [],
	gateRuns,
	suiteCommand: SUITE,
	sessions: [],
	timelinesUnread: [],
	...over,
});

const readOf = (
	gateRuns: GateRun[] | null,
	over: Partial<ThroughputRead> = {},
): ThroughputRead => ({
	byRoot: { [DV]: rootOf(gateRuns) },
	commitsOf: () => [],
	queueOf: () => ({ state: "gone" }),
	record: [],
	...over,
});

const runsAgo = (n: number, from = 10, over: Partial<GateRun> = {}) =>
	Array.from({ length: n }, (_, i) => ({ ...gateRun(from + i), ...over }));

const pass = (minutesAgo: number): GateRun => ({
	...gateRun(minutesAgo),
	outcome: "pass",
});

const passedAgo = (minutes: number) => [
	pass(minutes),
	...runsAgo(9, minutes + 1, { outcome: "pass" }),
];

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

describe("the gate-run budget (#5275, #5471)", () => {
	it("leaves a session at its 3rd failed whole-suite run in a row running", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(3)));
		expect(launches[0]?.finishedAt).toBeNull();
		expect(events).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("parks one at its 4th: stopped, handed off, labelled parked and told why, the park recorded", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(4)));
		expect(launches[0]).toMatchObject({ finishedAt: NOW, budgetParked: NOW });
		expect(calls[0]).toBe("stop job42");
		expect(calls).toContain("hand-off job42");
		expect(calls.find((c) => c.startsWith("comment"))).toContain(
			"its 4 failed whole-suite gate runs in a row since its last landing",
		);
		expect(events).toEqual([
			{
				at: new Date(NOW).toISOString(),
				repo: DV,
				event: "budget-park",
				rate: null,
				workingHours: 0,
				session: "s-job42",
				sessions: ["s-job42"],
				launchedAt: new Date(LAUNCHED).toISOString(),
				ticket: 42,
			},
		]);
	});

	it("restarts the streak at a pass, and counts a ceiling of its own as a failure", () => {
		expect(
			tick([live()], readOf([...runsAgo(3), pass(13), ...runsAgo(3, 14)]))
				.events,
		).toEqual([]);
		expect(
			tick([live()], readOf(runsAgo(4, 10, { outcome: "ceiling" }))).events,
		).toHaveLength(1);
	});

	it("never counts a one-file run or a script run through the gate, which neither fail nor reset the streak", () => {
		const oneFile = { command: `${SUITE} -- scripts/a.test.ts` };
		const nested = { command: "sh .claude/tmp/s-job42-nest.sh" };
		expect(
			tick(
				[live()],
				readOf([
					...runsAgo(3, 10, oneFile),
					...runsAgo(3, 13, nested),
					...runsAgo(3, 16),
				]),
			).events,
		).toEqual([]);
		const between = [
			...runsAgo(2),
			{ ...pass(12), ...oneFile },
			{ ...pass(13), ...nested },
			...runsAgo(2, 14),
		];
		expect(tick([live()], readOf(between)).events).toHaveLength(1);
	});

	it("skips a memory kill and a run that spanned a host sleep: neither fails nor resets the streak", () => {
		const skipped = [
			{ ...pass(12), outcome: "killed" as const },
			{ ...pass(13), wallS: 60 + 61 },
		];
		expect(tick([live()], readOf([...runsAgo(3), ...skipped])).events).toEqual(
			[],
		);
		expect(
			tick([live()], readOf([...runsAgo(2), ...skipped, ...runsAgo(2, 14)]))
				.events,
		).toHaveLength(1);
		expect(
			tick(
				[live()],
				readOf([...runsAgo(3), { ...gateRun(13), wallS: 60 + 60 }]),
			).events,
		).toHaveLength(1);
	});

	it("skips a ceiling 2 other sessions hit in the 2 hours before it, the repo's fault, and counts one only 1 did", () => {
		const ceilings = runsAgo(4, 10, { outcome: "ceiling" });
		const otherAt = (minutesAgo: number, session: string): GateRun => ({
			...gateRun(minutesAgo, session),
			outcome: "ceiling",
		});
		const systemic = [otherAt(100, "s-a"), otherAt(120, "s-b")];
		expect(tick([live()], readOf([...ceilings, ...systemic])).events).toEqual(
			[],
		);
		const oneOther = [otherAt(100, "s-a"), otherAt(100, "s-a")];
		expect(
			tick([live()], readOf([...ceilings, ...oneOther])).events,
		).toHaveLength(1);
		const stale = [otherAt(100, "s-a"), otherAt(134, "s-b")];
		expect(tick([live()], readOf([...ceilings, ...stale])).events).toHaveLength(
			1,
		);
	});

	it("counts only from the second after its last landing, so the run that let it through, ending in that second, counts before it", () => {
		const landedSecond = Math.floor((NOW - 13 * MIN) / 1000) * 1000;
		const landed = (gateRuns: GateRun[]) =>
			readOf(gateRuns, {
				byRoot: {
					[DV]: rootOf(gateRuns, {
						commits: [{ sha: "landed", at: landedSecond }],
					}),
				},
				commitsOf: () => ["landed"],
			});
		const sameSecond = {
			...gateRun(0),
			at: new Date(landedSecond + 287).toISOString(),
		};
		expect(tick([live()], landed([...runsAgo(3), sameSecond])).events).toEqual(
			[],
		);
		const nextSecond = {
			...sameSecond,
			at: new Date(landedSecond + 1000).toISOString(),
		};
		expect(
			tick([live()], landed([...runsAgo(3), nextSecond])).events,
		).toHaveLength(1);
	});

	it("counts its past sessions' runs, and no other session's or any before its launch", () => {
		const mine = [...runsAgo(2), ...[20, 21].map((m) => gateRun(m, "s-old"))];
		const others = [gateRun(30, "s-else"), gateRun(400)];
		const relaunched = live({ pastSessionIds: ["s-old"] });
		expect(
			tick([relaunched], readOf([...mine, ...others])).events,
		).toHaveLength(1);
		expect(tick([live()], readOf([...mine, ...others])).events).toEqual([]);
	});

	it("records every session of a resumed launch, and its start, on its park (#5514)", () => {
		const relaunched = live({ pastSessionIds: ["s-old"] });
		expect(tick([relaunched], readOf(runsAgo(4))).events[0]).toMatchObject({
			session: "s-job42",
			sessions: ["s-old", "s-job42"],
			launchedAt: new Date(LAUNCHED).toISOString(),
		});
	});

	it("parks at its 10th whole-suite run of any outcome since its last landing, its newest red", () => {
		const nine = runsAgo(9, 11, { outcome: "pass" });
		expect(tick([live()], readOf(nine)).events).toEqual([]);
		const { events, calls } = tick([live()], readOf([gateRun(10), ...nine]));
		expect(events).toHaveLength(1);
		expect(calls.find((c) => c.startsWith("comment"))).toContain(
			"its 10 whole-suite gate runs since its last landing, at the backstop of 10",
		);
	});

	it("parks nothing off an unread gate-run record, or a finished launch", () => {
		expect(tick([live()], readOf(null)).events).toEqual([]);
		expect(
			tick([live({ finishedAt: NOW - MIN })], readOf(runsAgo(9))).events,
		).toEqual([]);
	});

	it('parks nothing where its landing or its checkout\'s declared commands.test will not read, and logs why, where "parks one at its 4th" parks it (#5273)', () => {
		const unreadMain = readOf(runsAgo(8), {
			byRoot: { [DV]: rootOf(runsAgo(8), { commits: null }) },
		});
		const unreadLedger = readOf(runsAgo(8), { commitsOf: () => null });
		const undeclared = readOf(runsAgo(8), {
			byRoot: { [DV]: rootOf(runsAgo(8), { suiteCommand: null }) },
		});
		for (const [read, why] of [
			[unreadMain, "origin/main will not read"],
			[unreadLedger, "its commit ledger will not read"],
			[undeclared, "its checkout declares no commands.test"],
		] as const) {
			const { events, calls } = tick([live()], read);
			expect(events).toEqual([]);
			expect(logs(calls)).toEqual([
				expect.stringMatching(
					new RegExp(`^gate-run budget of .+ not judged: ${why}$`),
				),
			]);
		}
		const othersOnly = [gateRun(10, "s-else")];
		const quiet = readOf(othersOnly, {
			byRoot: { [DV]: rootOf(othersOnly, { suiteCommand: null }) },
		});
		expect(tick([live()], quiet).calls).toEqual([]);
	});

	it("holds a session at its backstop whose newest run passed and whose commit waits on the lander, or has landed there ahead of origin/main, and logs why (#5438)", () => {
		const passed = passedAgo(5);
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

	it("holds none whose newest run failed, its commit waiting on the lander, nor one whose passed commit left the queue (#5438)", () => {
		const waiting = { queueOf: () => ({ state: "waiting" as const }) };
		expect(tick([live()], readOf(runsAgo(4), waiting)).events).toHaveLength(1);
		expect(tick([live()], readOf(passedAgo(11))).events).toHaveLength(1);
	});

	it("holds one at its backstop whose passed commit is not on its queue ref while its push is due, and parks it once 11 minutes pass (#5441)", () => {
		const { launches, events, calls } = tick([live()], readOf(passedAgo(10.9)));
		expect(launches[0]?.finishedAt).toBeNull();
		expect(events).toEqual([]);
		expect(logs(calls)).toEqual([
			expect.stringMatching(
				/^gate-run budget of .+ held: its push of its passed commit is still due$/,
			),
		]);
		expect(tick([live()], readOf(passedAgo(11))).events).toHaveLength(1);
	});

	it("logs a stop that fails and parks nothing, for the next tick to try again", () => {
		const { launches, events, calls } = tick([live()], readOf(runsAgo(4)), {
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
