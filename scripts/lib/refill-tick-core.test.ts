// @vitest-environment node
/*
 * The refill tick's core (#4212, #4231) against a fake adapter: the order of
 * its steps, what a kill between two of them leaves the next tick, and its
 * dry-run policy. Every port records its call, so a case reads the order off
 * one list; the state file is held in memory (stateFileFake). The fake
 * answers in the ports' shapes but no contract test pins it to the adapter:
 * scripts/refill-loop-run.test.ts runs the real one.
 *
 * Loosen one and a tick can judge launches a kill left out of the state, list
 * before the relief steps, dispatch a batch not yet on record, or a dry run can
 * stop on an absent or damaged control, or write, launch or drop a marker.
 */
import { describe, expect, it } from "vitest";
import {
	type Launch,
	MIN,
	NOW,
	normal,
	record,
	stateFileFake,
	WFC,
} from "./refill-loop-fixture";
import { loopStateOf } from "./refill-state-testkit";
import { runTick } from "./refill-tick-core.js";

type TickIo = import("./refill-tick-core.js").TickIo;
type LoopState = import("./refill-state.js").LoopState;
type Control = import("./refill-loop.js").Control;

const SEAT = "/home/u/.claude3";

const control = (over: Partial<Control> = {}): Control => ({
	noProgressFrom: NOW - 60 * MIN,
	stopRequested: false,
	seats: [SEAT],
	scope: normal([WFC]),
	...over,
});

const sized = {
	seat: SEAT,
	week: 10,
	session: 10,
	weekFull: false,
	sessionFull: false,
	sessionResets: null,
	weekResets: null,
	readAt: NOW,
	weekRead: { percent: null, atMs: null },
	fits: 9,
};

const row = (number: number) => ({
	root: WFC,
	number,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	reach: 0,
	collision: "comment-only",
	takes: ["implement"],
	labels: ["takes:implement"],
});

/** Thrown by a port to stand for a SIGKILL landing on that step. */
class Killed extends Error {}

/** A fake adapter; `over` replaces any port. */
function fakeIo(
	initial: LoopState,
	over: Partial<TickIo> = {},
	{ frontier = [row(1)] }: { frontier?: ReturnType<typeof row>[] } = {},
) {
	const calls: string[] = [];
	const writes: LoopState[] = [];
	const lines: string[] = [];
	const onDisk = stateFileFake(initial, writes);
	const recorded =
		<A extends unknown[], R>(name: string, f: (...args: A) => R) =>
		(...args: A) => {
			calls.push(name);
			return f(...args);
		};
	const io: TickIo = {
		now: () => NOW,
		log: (line) => lines.push(line),
		readControl: recorded("readControl", () => ({
			control: control(),
			damaged: null,
		})),
		changeControl: recorded("changeControl", () => null),
		isOptedOut: () => false,
		readConfiguredSeats: () => [SEAT],
		readIncluded: () => [WFC],
		servedRoots: (scope) => ({ roots: scope.repos, dropped: [] }),
		reap: recorded("reap", () => undefined),
		tendQuietBench: recorded("tendQuietBench", (c) => c),
		readManagerRestart: recorded("readManagerRestart", () => null),
		readCurrentBootId: () => null,
		readState: recorded("readState", () => onDisk((s) => s)),
		settleKilled: recorded("settleKilled", (read) => read),
		readRegistry: recorded("readRegistry", () => ({
			seats: [SEAT],
			faults: [],
			agents: [],
		})),
		stopNeverStarted: recorded("stopNeverStarted", () => []),
		tendCheckouts: recorded("tendCheckouts", () => []),
		readListing: recorded("readListing", () => ({ agents: [], why: null })),
		capOverflowSessions: recorded("capOverflowSessions", () => undefined),
		blockIo: () =>
			({ log: (line: string) => lines.push(line) }) as unknown as ReturnType<
				TickIo["blockIo"]
			>,
		readSwapHold: () =>
			({ held: false }) as unknown as ReturnType<TickIo["readSwapHold"]>,
		sendHoldNotices: recorded("sendHoldNotices", () => undefined),
		readProgress: recorded("readProgress", () => ({ acts: {} })),
		readCause: () => null as never,
		actOnLaunches: recorded("actOnLaunches", (listed) => listed),
		attachProbeParks: recorded("attachProbeParks", () => undefined),
		readLiftedHolds: recorded("readLiftedHolds", () => []),
		releaseEndedHolds: recorded("releaseEndedHolds", () => undefined),
		readFreeSlots: recorded("readFreeSlots", () => ({
			slots: 1,
			admission: null,
		})),
		actOnLimits: recorded("actOnLimits", (_b, judged, _m, { slots }) => ({
			launches: judged,
			slots,
			workingChange: 0,
		})),
		readSeats: recorded("readSeats", () => ({ seats: [sized], probes: [] })),
		probeDueSeats: recorded("probeDueSeats", () => []),
		seatBudget: () => ({ why: "none" }) as never,
		startDueConsoleReads: recorded("startDueConsoleReads", () => undefined),
		capSizer: () => () => null,
		readGateJudgements: () => [],
		readTickHolds: () => ({ holds: [] }),
		readFrontier: recorded("readFrontier", async () => ({
			frontier,
			retroBundles: [],
			failed: [],
			held: [],
			goal: null,
		})) as unknown as TickIo["readFrontier"],
		readParkers: () => [],
		sizeParkerSeats: (seats) => seats,
		launchBatch: recorded("launchBatch", (batch) => ({
			launched: batch.map((l) => ({
				...l,
				jobId: `job${l.issues[0]}`,
				launchedAt: NOW,
				finishedAt: null,
			})),
			refused: [],
		})),
		resumeHeld: recorded("resumeHeld", (_r, held) => ({
			launches: held,
			started: 0,
			waiting: false,
		})),
		writePause: recorded("writePause", () => undefined),
		runReview: recorded("runReview", (lastRunOn) => lastRunOn),
		updateState: recorded("updateState", onDisk),
		readOmittedDirs: () => [],
		dropSettledLifted: recorded("dropSettledLifted", () => undefined),
		dropManagerRestart: recorded("dropManagerRestart", () => undefined),
		appendTick: recorded("appendTick", () => undefined),
		...over,
	};
	return { io, calls, writes, lines, disk: () => onDisk((s) => s) };
}

const opening = (c: Control | null, damaged: string | null = null) => ({
	control: { control: c, damaged },
	declared: { seats: [], errors: [] } as never,
	typed: { at: null, seat: null },
});

const tickOf = (io: TickIo, c: Control | null = control(), dryRun = false) =>
	runTick(io, { dryRun, now: NOW, opening: opening(c) });

const stateOf = (over: Record<string, unknown> = {}) => loopStateOf(over);

/** An away control a prompt typed a minute ago brings back to normal. */
const awayControl = () =>
	control({
		scope: { ...normal([WFC]), mode: "away" },
		away: { since: NOW - 60 * MIN, absentSeen: true },
	});

const expectOrder = (calls: string[], a: string, b: string) => {
	expect(calls).toContain(a);
	expect(calls).toContain(b);
	expect(calls.indexOf(a)).toBeLessThan(calls.indexOf(b));
};

describe("the tick's step order (#4212)", () => {
	it("settles what a kill left before reading the registry, and the relief before the listing (#4180, #2665)", async () => {
		const { io, calls } = fakeIo(stateOf());
		await runTick(io, {
			dryRun: false,
			now: NOW,
			opening: {
				...opening(awayControl()),
				typed: { at: NOW - MIN, seat: null },
			},
		});
		expectOrder(calls, "changeControl", "reap");
		expectOrder(calls, "reap", "readState");
		expectOrder(calls, "readState", "settleKilled");
		expectOrder(calls, "settleKilled", "readRegistry");
		expectOrder(calls, "stopNeverStarted", "readListing");
		expectOrder(calls, "tendCheckouts", "readListing");
	});

	it("judges and acts on the launches only after the listing, and reads the room after them", async () => {
		const { io, calls } = fakeIo(stateOf({ launches: [record()] }));
		await tickOf(io);
		expectOrder(calls, "readListing", "actOnLaunches");
		expectOrder(calls, "actOnLaunches", "readLiftedHolds");
		expectOrder(calls, "readLiftedHolds", "readFreeSlots");
		expectOrder(calls, "readFreeSlots", "actOnLimits");
		expectOrder(calls, "actOnLimits", "readSeats");
		expectOrder(calls, "readSeats", "readFrontier");
	});

	it("puts the batch on record before its launcher, then drops the markers and appends the row after the tick's write", async () => {
		const marker = { at: NOW - MIN, bootId: "b" } as never;
		const { io, calls, writes } = fakeIo(stateOf(), {
			readManagerRestart: () => marker,
		});
		const r = await tickOf(io);
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		expectOrder(calls, "updateState", "launchBatch");
		expect(writes[0].launching?.batch).toMatchObject([{ issues: [1] }]);
		const lastWrite = calls.lastIndexOf("updateState");
		expect(calls.slice(lastWrite + 1)).toEqual(
			expect.arrayContaining([
				"dropSettledLifted",
				"dropManagerRestart",
				"appendTick",
			]),
		);
		expect(calls.at(-1)).toBe("appendTick");
		expect(writes.at(-1)).not.toHaveProperty("launching");
	});
});

describe("a kill between two steps (#4157, #4180)", () => {
	it("leaves the batch in flight on record where the kill lands in the launcher, and the next tick hands it to settleKilled before judging", async () => {
		const first = fakeIo(stateOf(), {
			launchBatch: () => {
				throw new Killed();
			},
		});
		await expect(tickOf(first.io)).rejects.toThrow(Killed);
		const left = first.disk();
		expect(left.launches).toEqual([]);
		expect(left.launching?.batch).toMatchObject([{ issues: [1] }]);

		const adopted: Launch = {
			...record({ root: WFC, issues: [1], jobId: "job1" }),
			launchedAt: NOW - MIN,
		} as Launch;
		const seenBySettle: LoopState[] = [];
		const second = fakeIo(left, {
			settleKilled: (read) => {
				seenBySettle.push(read);
				return { ...read, launching: undefined, launches: [adopted] };
			},
		});
		const r = await tickOf(second.io);
		expect(seenBySettle[0].launching?.batch).toMatchObject([{ issues: [1] }]);
		/* The adopted launch holds #1, so the tick launches no second copy. */
		expect(second.calls).not.toContain("launchBatch");
		expect("idle" in r.decision).toBe(true);
	});

	it("leaves the state as the last tick wrote it where the kill lands before the tick's own write", async () => {
		const prior = stateOf({ launches: [record({ jobId: "old" })] });
		const { io, writes } = fakeIo(prior, {
			readFrontier: async () => {
				throw new Killed();
			},
		});
		await expect(tickOf(io)).rejects.toThrow(Killed);
		expect(writes).toEqual([]);
	});
});

describe("a restart's killed launches on the tick (#3880, #3971)", () => {
	const killed = record({ sessionId: "s-job42", seat: SEAT }) as Launch;
	/** The block port queueBootKilled reads: no job record, its lines kept. */
	const bootPorts = (lines: string[]) =>
		({
			log: (line: string) => lines.push(line),
			jobStateOf: () => null,
			resumeTargetOf: (l: Launch) => ({ sessionId: l.sessionId, cwd: l.root }),
		}) as unknown as ReturnType<TickIo["blockIo"]>;

	it("waits for a read listing, the launches and the wait kept and spared the never-started stop", async () => {
		const blockLines: string[] = [];
		const spared: string[][] = [];
		const trusted: boolean[] = [];
		const { io, lines, disk } = fakeIo(
			stateOf({ launches: [killed], bootedAt: NOW - MIN }),
			{
				blockIo: () => bootPorts(blockLines),
				stopNeverStarted: (_registry, jobs) => {
					spared.push([...jobs]);
					return [];
				},
				readListing: (isTrusted) => {
					trusted.push(isTrusted);
					return { agents: null, why: "the listing failed" };
				},
			},
		);
		await tickOf(io);
		expect(trusted).toEqual([true]);
		expect(spared).toEqual([["job42"]]);
		expect(lines).toContain(
			"a restart's killed launches wait on the listing: the listing failed",
		);
		expect(disk().bootedAt).toBe(NOW - MIN);
		expect(disk().launches[0]).not.toHaveProperty("bootKilled");
		expect(disk().launches[0]?.finishedAt).toBeNull();
	});

	it("queues what a surviving loop's marker says the restart killed, a batch in flight beside it, and drops the marker (#4232)", async () => {
		const blockLines: string[] = [];
		const initial = stateOf({
			launches: [killed],
			launching: { at: NOW, batch: [] },
		});
		const marker = { bootId: "b", at: NOW - MIN };
		const { io, calls, disk } = fakeIo(initial, {
			blockIo: () => bootPorts(blockLines),
			readManagerRestart: () => marker,
			readCurrentBootId: () => "b",
			/* The adapter hands on the state it wrote, which holds no restart. */
			settleKilled: () => {
				const { launching: _, ...settled } = initial;
				return settled;
			},
		});
		await tickOf(io);
		expect(blockLines).toContain(
			"design-vault /implement 42, killed by a restart: due back through the resume step",
		);
		expect(disk().launches[0]).toHaveProperty("bootKilled");
		expect(disk().bootedAt).toBeUndefined();
		expect(disk().sameBootRestart).toBeUndefined();
		expect(disk().launching).toBeUndefined();
		expect(calls).toContain("dropManagerRestart");
	});
});

describe("the dry-run policy (#4212)", () => {
	it("previews a loop with no control file without stopping, and stops a real tick on it", async () => {
		const dry = fakeIo(stateOf());
		const preview = await tickOf(dry.io, null, true);
		expect("stop" in preview.decision).toBe(false);
		const live = fakeIo(stateOf());
		const real = await tickOf(live.io, null);
		expect(real.decision).toMatchObject({ stop: "explicit" });
		expect(live.disk().stopped).toMatchObject({ reason: "explicit" });
	});

	it("previews over a damaged control, which stops a real tick recorded control-damaged", async () => {
		const damaged = "/c is damaged (bad json)";
		const dry = fakeIo(stateOf());
		const preview = await runTick(dry.io, {
			dryRun: true,
			now: NOW,
			opening: opening(null, damaged),
		});
		expect("stop" in preview.decision).toBe(false);
		const live = fakeIo(stateOf());
		const real = await runTick(live.io, {
			dryRun: false,
			now: NOW,
			opening: opening(null, damaged),
		});
		expect(real.decision).toMatchObject({
			stop: "control-damaged",
			detail: expect.stringContaining(damaged),
		});
	});

	it("returns at its decision, reading no manager restart and settling nothing", async () => {
		const { io, calls } = fakeIo(stateOf());
		const r = await tickOf(io, control(), true);
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		for (const port of [
			"readManagerRestart",
			"readLiftedHolds",
			"launchBatch",
			"resumeHeld",
			"updateState",
			"writePause",
			"runReview",
			"dropSettledLifted",
			"dropManagerRestart",
			"appendTick",
		])
			expect(calls).not.toContain(port);
	});
});

describe("a control change under the lock (#2522)", () => {
	it("goes on over a change the adapter answers no write for, logging none", async () => {
		const away = awayControl();
		const { io, lines } = fakeIo(stateOf());
		const r = await runTick(io, {
			dryRun: true,
			now: NOW,
			opening: {
				...opening(away),
				typed: { at: NOW - MIN, seat: null },
			},
		});
		expect(lines.join("\n")).not.toContain("the founder is back");
		expect(r.decision).not.toHaveProperty("stop");
	});

	it("logs the write a live tick's control change made", async () => {
		const away = awayControl();
		const { io, lines } = fakeIo(stateOf(), {
			changeControl: (change) => {
				const write = change(away);
				return write
					? { control: write, wrote: { write, fresh: away } }
					: { control: away, wrote: null };
			},
		});
		await runTick(io, {
			dryRun: false,
			now: NOW,
			opening: {
				...opening(away),
				typed: { at: NOW - MIN, seat: null },
			},
		});
		expect(lines.join("\n")).toContain("mode normal: the founder is back");
	});

	it("leaves a change to the next tick where the lock stays held", async () => {
		const away = awayControl();
		const { io, lines } = fakeIo(stateOf(), {
			changeControl: () => ({ busy: "pid 7" }),
		});
		await runTick(io, {
			dryRun: false,
			now: NOW,
			opening: {
				...opening(away),
				typed: { at: NOW - MIN, seat: null },
			},
		});
		expect(lines).toContain(
			"away mode's change waits for the next tick: pid 7",
		);
	});
});
