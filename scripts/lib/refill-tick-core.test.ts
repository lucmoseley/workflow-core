// @vitest-environment node
/*
 * The refill tick's core (#4212, #4231) against a fake adapter: the order of
 * its steps, what a kill between two of them leaves the next tick, its
 * dry-run policy, and how it carries a restart's killed launches and a
 * limit-held launch into the state, the idle reason and the tick's record
 * (#4315); the sessions it launched into that record, the room a paused or
 * stopping tick leaves unread, which checkout it sizes the seats and a
 * parker's seat in, away mode's return, a paused tick, a full week's wait and
 * the hold notices' agent read (#4282). Every port records its call, so a case
 * reads the order off one list; the state file is held in memory
 * (stateFileFake), and the control file under its lock (controlFileFake). The
 * fake answers in the ports' shapes but no contract test pins it to the
 * adapter, bar ADMISSION_VERDICT, which admission-verdict.contract.test.ts
 * holds: scripts/refill-loop-run.test.ts runs the real one.
 *
 * Loosen one and a tick can judge launches a kill left out of the state, list
 * before the relief steps, dispatch a batch not yet on record, or a dry run can
 * stop on an absent or damaged control, or write, launch or drop a marker; or a
 * tick can miss the founder's return, read slots, seats or a probe while paused
 * or stopping, start a Console read then, stop on a full week, or miss the
 * quiet an empty registry shows a hold's notice.
 */
import { describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./admission-verdict-fake";
import { buildHeldStopText } from "./refill-blocks.js";
import { controlInMode } from "./refill-loop.js";
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
		expect(calls).toContain("dropManagerRestart");
	});
});

describe("a limit-held launch through the tick (#3735)", () => {
	const held = record({
		seat: SEAT,
		parked: true,
		block: { cause: "LIMIT", since: NOW - 60 * MIN },
		limitHeld: {
			at: NOW - 60 * MIN,
			sessionId: "s-job42",
			cwd: "/home/u/design-vault",
			limit: { bar: "weekly", resets: "2026-11-01T00:00:00.000Z" },
			ledgerHeldUntil: NOW + 60 * MIN,
		},
	}) as Launch;
	const spent = {
		readSeats: () => ({
			seats: [{ ...sized, week: 100, weekFull: true, fits: null }],
			probes: [],
		}),
	};

	it("waits named on its seat while every seat is spent, and a stop names it (#3785)", async () => {
		const idle = await tickOf(fakeIo(stateOf({ launches: [held] }), spent).io);
		expect(idle.decision).toMatchObject({
			idle: expect.stringContaining(
				"every seat is spent; a limit-held session waits on one",
			),
		});
		const stopped = await tickOf(
			fakeIo(stateOf({ launches: [held] }), spent).io,
			control({ stopRequested: true }),
		);
		expect(stopped.decision).toMatchObject({
			stop: "explicit",
			detail: expect.stringContaining(buildHeldStopText(held as never)),
		});
	});

	it("nets the limit acts' working change into the tick's record (#3778)", async () => {
		const records: { working: number | null }[] = [];
		const { io } = fakeIo(
			stateOf(),
			{
				readFreeSlots: () => ({
					slots: 1,
					/* The run test's fake carries only the fields concurrency.js reads. */
					admission: ADMISSION_VERDICT as never,
				}),
				actOnLimits: (_b, judged, _m, { slots }) => ({
					launches: judged,
					slots,
					workingChange: -1,
				}),
				appendTick: (r) => {
					records.push(r);
				},
			},
			{ frontier: [] },
		);
		await tickOf(io);
		expect(records).toEqual([
			expect.objectContaining({
				working: ADMISSION_VERDICT.memory.working.count - 1,
			}),
		]);
	});
});

describe("the tick's concurrency row (#3770)", () => {
	it("counts the sessions the tick launched into its working figure", async () => {
		const records: { working: number | null; ceiling: number | null }[] = [];
		const { io } = fakeIo(stateOf(), {
			readFreeSlots: () => ({
				slots: 1,
				/* The run test's fake carries only the fields concurrency.js reads. */
				admission: { ...ADMISSION_VERDICT, slots: 1 } as never,
			}),
			appendTick: (tickRecord) => {
				records.push(tickRecord);
			},
		});
		const r = await tickOf(io);
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		const { count } = ADMISSION_VERDICT.memory.working;
		expect(records).toEqual([
			expect.objectContaining({ working: count + 1, ceiling: count + 1 }),
		]);
	});
});

describe("the room a stopping tick reads (#4071)", () => {
	it("starts no Console read on a stopping tick, which reads admission all the same", async () => {
		const stopping = fakeIo(stateOf());
		await tickOf(stopping.io, control({ stopRequested: true }));
		expect(stopping.calls).toContain("readFreeSlots");
		expect(stopping.calls).not.toContain("startDueConsoleReads");
		const live = fakeIo(stateOf());
		await tickOf(live.io);
		expect(live.calls).toContain("startDueConsoleReads");
	});
});

describe("the seats a tick sizes, in its first served checkout (#2937, #3669, #4147)", () => {
	const Seat2 = "/home/u/.claude4";
	const parkedRow = { ...row(5), labels: ["takes:implement", "parked"] };
	/** A parker of #5 on Seat2, its marker naming `keyVar` where given. */
	const parker = (keyVar?: string) => ({
		root: WFC,
		number: 5,
		sessionId: "s-job5",
		job: {
			seat: Seat2,
			jobId: "job5",
			cwd: WFC,
			...(keyVar ? { keyVar } : {}),
		},
		resumeCwd: WFC,
	});
	/** A tick over SEAT, sized, and Seat2 with room and no cap sized yet; each
	 * checkout the seats were read in, and each cap sized, fitting 1. */
	const tickOver = async (
		parkers: ReturnType<typeof parker>[],
		c = control(),
	) => {
		const roots: (string | undefined)[] = [];
		const capped: string[] = [];
		const { io } = fakeIo(
			stateOf(),
			{
				readSeats: (_seats, _slots, root) => {
					roots.push(root);
					return {
						seats: [sized, { ...sized, seat: Seat2, fits: null }],
						probes: [],
					};
				},
				capSizer: (root) => (seat, members) => {
					capped.push(`${root} ${seat}/${members}`);
					return 1;
				},
				readParkers: () => parkers,
			},
			{ frontier: [parkedRow] },
		);
		const r = await tickOf(io, c);
		const routes =
			"launches" in r.decision
				? r.decision.launches.map((l) => l.parkedRoute)
				: [];
		return { roots, capped, routes };
	};

	it("sizes a parker's seat for one resume in the first served checkout, so its ticket resumes there (#3669)", async () => {
		const { capped, routes } = await tickOver([parker()]);
		expect(capped).toEqual([`${WFC} ${Seat2}/1`]);
		expect(routes).toEqual([
			expect.objectContaining({
				resume: expect.objectContaining({ seat: Seat2, sessionId: "s-job5" }),
			}),
		]);
	});

	it("sizes none of a plan seat's cap for a marker naming an overflow key on its dir, and launches it afresh (#4147)", async () => {
		const { capped, routes } = await tickOver([parker("K2")]);
		expect(capped).toEqual([]);
		expect(routes).toEqual([
			{ afresh: "its session ran on overflow seat key=K2" },
		]);
	});

	it("reads the seats in the first served checkout, and in none where the loop serves no checkout (#2937)", async () => {
		expect((await tickOver([])).roots).toEqual([WFC]);
		const none = await tickOver([], control({ scope: normal([]) }));
		expect(none.roots).toEqual([undefined]);
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
		expect(live.calls).not.toContain("launchBatch");
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
		expect(live.disk().stopped).toMatchObject({
			reason: "control-damaged",
			detail: expect.stringContaining(damaged),
		});
		expect(live.calls).not.toContain("launchBatch");
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

/**
 * The control file under its lock, each change made on its fresh read. No
 * contract test holds it to refill-tick.js's changeControl; the sandbox case
 * "leaves the return to the next tick while another writer holds the lock"
 * crosses the real lock (#4356).
 */
const controlFileFake = (initial: Control) => {
	let onDisk = initial;
	const changeControl: TickIo["changeControl"] = (change) => {
		const fresh = onDisk;
		const write = change(fresh);
		if (!write) return { control: fresh, wrote: null };
		onDisk = write;
		return { control: write, wrote: { write, fresh } };
	};
	return {
		read: () => onDisk,
		write: (c: Control) => {
			onDisk = c;
		},
		changeControl,
	};
};

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
			changeControl: controlFileFake(away).changeControl,
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

describe("away mode's return through the tick (#3870)", () => {
	const tickAt = (
		io: TickIo,
		file: ReturnType<typeof controlFileFake>,
		now: number,
		typedAt: number | null,
	) =>
		runTick(io, {
			dryRun: false,
			now,
			opening: { ...opening(file.read()), typed: { at: typedAt, seat: null } },
		});
	const returns = (lines: string[]) =>
		lines.filter((l) => l.startsWith("mode normal: the founder is back"));

	it("returns and logs it, then a manual --away holds until the next absent read and present one", async () => {
		const file = controlFileFake(awayControl());
		const { io, lines } = fakeIo(stateOf(), {
			changeControl: file.changeControl,
		});
		const typed = NOW - MIN;
		await tickAt(io, file, NOW, typed);
		expect(file.read().scope.mode).toBe("normal");
		expect(file.read()).not.toHaveProperty("away");
		expect(returns(lines)).toHaveLength(1);

		/* What `set --away` writes (refill-commands.test.ts's "a set's switch to
		 * away"): a switch after the prompt just read. */
		const switchedAt = NOW + MIN;
		file.write(controlInMode(file.read(), "away", switchedAt));
		await tickAt(io, file, switchedAt + MIN, typed);
		expect(file.read().scope.mode).toBe("away");
		expect(file.read().away).toEqual({ since: switchedAt, absentSeen: false });

		/* The switch reads as presence for its first window (#4184): two hours on,
		 * neither it nor the prompt does. */
		const absentAt = switchedAt + 120 * MIN;
		await tickAt(io, file, absentAt, typed);
		expect(file.read().scope.mode).toBe("away");
		expect(file.read().away?.absentSeen).toBe(true);
		expect(returns(lines)).toHaveLength(1);

		await tickAt(io, file, absentAt + MIN, absentAt);
		expect(file.read().scope.mode).toBe("normal");
		expect(returns(lines)).toHaveLength(2);
	});

	it("records an absent read and stays away", async () => {
		const since = NOW - 60 * MIN;
		const file = controlFileFake(
			control({
				scope: { ...normal([WFC]), mode: "away" },
				away: { since, absentSeen: false },
			}),
		);
		const { io, lines } = fakeIo(stateOf(), {
			changeControl: file.changeControl,
		});
		await tickAt(io, file, NOW, null);
		expect(file.read().scope.mode).toBe("away");
		expect(file.read().away).toEqual({ since, absentSeen: true });
		expect(lines.join("\n")).not.toContain("the founder is back");
	});
});

describe("a paused tick (#3856)", () => {
	const paused = control({ paused: { by: "founder", at: 7 } });

	it("keeps the housekeeping, launches nothing and makes no slot, usage or cap read", async () => {
		/* Past any listing grace, and listed nowhere, so judged finished. */
		const gone = record({
			root: WFC,
			seat: SEAT,
			jobId: "gone",
			launchedAt: NOW - 60 * MIN,
		});
		const capReads: string[] = [];
		const { io, calls, lines, disk } = fakeIo(stateOf({ launches: [gone] }), {
			capSizer: () => () => {
				capReads.push("cap");
				return null;
			},
		});
		await tickOf(io, paused);

		const said = lines.join("\n");
		expect(said).toContain(
			`idle: paused by founder at ${new Date(7).toISOString()}`,
		);
		expect(said).not.toContain("free slots");
		expect(said).not.toContain("resumed 0 of");
		expect(calls).toEqual(
			expect.arrayContaining(["reap", "tendCheckouts", "releaseEndedHolds"]),
		);
		expect(disk().launches[0].finishedAt).not.toBeNull();
		for (const port of [
			"readFreeSlots",
			"actOnLimits",
			"readSeats",
			"probeDueSeats",
			"startDueConsoleReads",
			"readFrontier",
			"launchBatch",
		])
			expect(calls).not.toContain(port);
		expect(capReads).toEqual([]);
	});
});

describe("the loop's wait on a full week (#3859)", () => {
	it("idles on the plan's reset with its wait on record, then launches once the bar resets", async () => {
		const full = fakeIo(stateOf(), {
			readSeats: () => ({
				seats: [{ ...sized, week: 100, weekFull: true, fits: null }],
				probes: [],
			}),
		});
		const waited = await tickOf(full.io);
		expect(waited.decision).toMatchObject({
			idle: expect.stringMatching(/^a plan resets/),
			planWait: expect.any(Object),
		});
		expect(full.disk().stopped).toBeNull();
		expect(full.disk().lastTick?.planWait).toEqual(
			"planWait" in waited.decision && waited.decision.planWait,
		);
		expect(full.calls).not.toContain("launchBatch");

		const reset = fakeIo(full.disk());
		const launched = await tickOf(reset.io);
		expect(
			"launches" in launched.decision && launched.decision.launches,
		).toHaveLength(1);
		expect(reset.calls).toContain("launchBatch");
	});
});

describe("the hold notices' agent read (#3871)", () => {
	const noticedAgents = async (registry: object) => {
		const seen: unknown[] = [];
		const { io } = fakeIo(stateOf(), {
			/* An empty listing reads as unread, as the CLI's does. */
			readListing: () => ({ agents: null, why: "unread" }),
			readRegistry: () => registry as never,
			sendHoldNotices: (_roots, s) => {
				seen.push(s.agents);
			},
		});
		await tickOf(io);
		return seen;
	};

	it("counts a registry and listing holding nobody as no slot working", async () => {
		expect(
			await noticedAgents({ seats: [SEAT], faults: [], agents: [] }),
		).toEqual([[]]);
	});

	it("counts nothing off a registry that faulted or read no seat", async () => {
		expect(
			await noticedAgents({ seats: [SEAT], faults: ["x"], agents: [] }),
		).toEqual([null]);
		expect(await noticedAgents({ seats: [], faults: [], agents: [] })).toEqual([
			null,
		]);
	});
});
