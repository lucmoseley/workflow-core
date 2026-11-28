// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./admission-verdict-fake";
import { syntheticStopAt } from "./block-cause.js";
import { fakeIo as blockFake } from "./refill-blocks-fixture";
import { buildHeldStopText } from "./refill-limits.js";
import {
	type Launch,
	MIN,
	NOW,
	normal,
	record,
	stateFileFake,
	WFC,
} from "./refill-loop-fixture";
import { actOnOutside } from "./refill-outside.js";
import { loopStateOf } from "./refill-state-testkit";
import {
	admissionRoot,
	billingStopsOf,
	buildFinishLine,
	runTick,
} from "./refill-tick-core.js";
import {
	doneJob,
	founderRow,
	replyRow,
	stoppedRows,
} from "./synthetic-stop-fixture";

type TickIo = import("./refill-tick-core.js").TickIo;
type TickActs = import("./refill-tick-core.js").TickActs;
type BlockIo = import("./refill-blocks.js").BlockIo;
type LoopState = import("./refill-state.js").LoopState;
type Control = import("./refill-loop.js").Control;

const DV = "/home/u/design-vault";

const NO_THROUGHPUT = {
	byRoot: {},
	commitsOf: () => [],
	queueOf: () => ({ state: "gone" as const }),
	record: [],
};

const actedAt = (launches: { root: string }[], at: number) =>
	Object.fromEntries(launches.map((l) => [l.root, at]));

const ACTS = {
	changeControl: true,
	reap: true,
	adoptKilledLaunches: true,
	stopNeverStarted: true,
	superviseLanding: true,
	levelMain: true,
	startWarmPass: true,
	startReapPass: true,
	runMachineChild: true,
	tendHolds: true,
	recordListedOverflowSessions: true,
	stopOverAllowance: true,
	sendHoldNotices: true,
	tendClosedParks: true,
	actOnOutside: true,
	releaseAwayParks: true,
	attachProbeParks: true,
	probeDueSeats: true,
	startDueConsoleReads: true,
	launchBatch: true,
	runReview: true,
	updateState: true,
	dropSettledLifted: true,
	dropManagerRestart: true,
	appendTick: true,
	appendBreakerEvents: true,
} satisfies Record<keyof TickActs, true>;

const SEAT = "/home/u/.claude3";

const control = (over: Partial<Control> = {}): Control => ({
	runFrom: NOW - 60 * MIN,
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

class Killed extends Error {}

function fakeIo(
	initial: LoopState,
	over: Partial<TickIo> = {},
	{
		frontier = [row(1)],
		block = {},
	}: { frontier?: ReturnType<typeof row>[]; block?: Partial<BlockIo> } = {},
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
		changeControl: recorded("changeControl", (change) =>
			controlFileFake(control()).changeControl(change),
		),
		isOptedOut: () => false,
		readConfiguredSeats: () => [SEAT],
		readIncluded: () => [WFC],
		servedRoots: (scope) => ({ roots: scope.repos, dropped: [] }),
		previewReap: recorded("previewReap", () => undefined),
		reap: recorded("reap", () => undefined),
		readManagerRestart: recorded("readManagerRestart", () => null),
		readCurrentBootId: () => null,
		readState: recorded("readState", () => onDisk((s) => s)),
		adoptKilledLaunches: recorded("adoptKilledLaunches", (read) => read),
		readRegistry: recorded("readRegistry", () => ({
			seats: [SEAT],
			faults: [],
			agents: [],
		})),
		stopNeverStarted: recorded("stopNeverStarted", () => []),
		hasConfig: () => true,
		superviseLanding: recorded("superviseLanding", () => undefined),
		levelMain: recorded("levelMain", () => undefined),
		startWarmPass: recorded("startWarmPass", () => undefined),
		startReapPass: recorded("startReapPass", () => undefined),
		runMachineChild: recorded("runMachineChild", () => undefined),
		tendHolds: recorded("tendHolds", () => []),
		readListing: recorded("readListing", () => ({ agents: [], why: null })),
		recordListedOverflowSessions: recorded(
			"recordListedOverflowSessions",
			() => undefined,
		),
		stopOverAllowance: recorded("stopOverAllowance", () => []),
		blockIo: () => {
			const { io: base } = blockFake({
				log: (line) => lines.push(line),
				...block,
			});
			return Object.fromEntries(
				Object.entries(base).map(([name, port]) => [
					name,
					name === "log"
						? port
						: recorded(
								`blockIo.${name}`,
								port as (...args: unknown[]) => unknown,
							),
				]),
			) as unknown as BlockIo;
		},
		readSwapHold: () =>
			({ held: false }) as unknown as ReturnType<TickIo["readSwapHold"]>,
		sendHoldNotices: recorded("sendHoldNotices", () => undefined),
		readProgress: recorded("readProgress", () => ({ acts: {} })),
		readLoopLastActAt: () => ({}),
		readThroughput: () => NO_THROUGHPUT,
		readCause: () => null as never,
		tendClosedParks: recorded("tendClosedParks", () => undefined),
		actOnOutside: recorded("actOnOutside", () => undefined),
		releaseAwayParks: recorded("releaseAwayParks", (launches) => launches),
		attachProbeParks: recorded("attachProbeParks", () => undefined),
		readLiftedHolds: recorded("readLiftedHolds", () => []),
		typecheckPeakMb: () => 0,
		readFreeSlots: recorded("readFreeSlots", () => ({
			slots: 1,
			admission: null,
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
			bumpsUnread: [],
			held: [],
			goal: null,
		})) as unknown as TickIo["readFrontier"],
		readParkMarkers: () => [],
		launchBatch: recorded("launchBatch", (batch) => ({
			launched: batch.map((l) => ({
				...l,
				jobId: `job${l.issues[0]}`,
				launchedAt: NOW,
				finishedAt: null,
			})),
			refused: [],
		})),
		runReview: recorded("runReview", (lastRunOn) => lastRunOn),
		updateState: recorded("updateState", onDisk),
		readOmittedDirs: () => [],
		dropSettledLifted: recorded("dropSettledLifted", () => undefined),
		dropManagerRestart: recorded("dropManagerRestart", () => undefined),
		appendTick: recorded("appendTick", () => undefined),
		appendBreakerEvents: recorded("appendBreakerEvents", () => undefined),
		...(Object.fromEntries(
			Object.entries(over).map(([name, port]) => [
				name,
				typeof port === "function"
					? recorded(name, port as (...args: unknown[]) => unknown)
					: port,
			]),
		) as Partial<TickIo>),
	};
	return { io, calls, writes, lines, disk: () => onDisk((s) => s) };
}

const opening = (c: Control | null, damaged: string | null = null) => ({
	control: { control: c, damaged },
	declared: { seats: [], errors: [] } as never,
	typedSeat: null,
});

const tickOf = (io: TickIo, c: Control | null = control(), dryRun = false) =>
	runTick(io, { dryRun, now: NOW, opening: opening(c) });

const stateOf = (over: Record<string, unknown> = {}) => loopStateOf(over);

const awayControl = () =>
	control({
		scope: { ...normal([WFC]), mode: "away" },
		away: { since: NOW - 60 * MIN },
	});

const expectOrder = (calls: string[], a: string, b: string) => {
	expect(calls).toContain(a);
	expect(calls).toContain(b);
	expect(calls.indexOf(a)).toBeLessThan(calls.indexOf(b));
};

const expectSequence = (calls: string[], steps: string[]) => {
	let from = 0;
	for (const [i, step] of steps.entries()) {
		const at = calls.indexOf(step, from);
		expect(at, `${step} after ${steps.slice(0, i).join(", ")}`).not.toBe(-1);
		from = at + 1;
	}
};

const blockCalls = (calls: string[]) =>
	calls.filter(
		(port) => port.startsWith("blockIo.") && port !== "blockIo.syntheticStopOf",
	);

const LIMIT_HOLD = {
	at: NOW - 60 * MIN,
	sessionId: "s-held",
	cwd: WFC,
	limit: { bar: "5-hour", resets: "2026-10-18T11:00:00Z" },
	ledgerHeldUntil: NOW + 60 * MIN,
};

const HELD_LAUNCH = record({
	jobId: "held",
	issues: [6],
	seat: SEAT,
	sessionId: "s-held",
	parked: true,
	block: { cause: "LIMIT", since: NOW - 60 * MIN },
	limitHeld: LIMIT_HOLD,
}) as Launch;

const ENDED_HOLD = record({
	jobId: "ended",
	issues: [4],
	seat: SEAT,
	limitHeld: { ...LIMIT_HOLD, resumedAt: NOW - 30 * MIN },
}) as Launch;

const KILLED_RESUME = record({
	jobId: "left",
	issues: [7],
	resumeStarted: {
		at: NOW - MIN,
		sessionId: "s-left",
		cwd: WFC,
		act: { kind: "api", route: "stop and --bg --resume", again: false },
	},
}) as Launch;

const ANSWERED_PARK = {
	read: {
		readParkMarkers: () =>
			[
				{
					sessionId: "s-parked",
					issues: [9],
					job: null,
					writtenAt: NOW - 5 * MIN,
				},
			] as never,
		findParkTranscript: () => ({ file: "/t", mtimeMs: NOW }),
		readMainChain: () => [
			{
				type: "assistant",
				timestamp: new Date(NOW - MIN).toISOString(),
				message: {
					model: "claude-opus-5-5",
					content: [{ type: "text", text: "result: done" }],
				},
			},
		],
	} satisfies Partial<BlockIo>,
};

const API_BLOCKED = record({
	jobId: "api",
	issues: [5],
	parked: true,
	block: { cause: "API_ERROR", sub: "transient", since: NOW - 2 * MIN },
	resumes: { tries: 1, triedAt: NOW - 10 * MIN, nextAt: NOW - 1000 },
}) as Launch;

const RESUMED_IDLE = record({
	jobId: "idle",
	issues: [8],
	launchedAt: NOW - 60 * MIN,
	relaunchedAt: NOW - 30 * MIN,
}) as Launch;

const listedAs = (...rows: [string, string][]) => ({
	agents: rows.map(([id, state]) => ({
		sessionId: `s-${id}`,
		id,
		kind: "background",
		state,
	})) as never,
	why: null,
});

const LISTED_BLOCKS: Partial<TickIo> = {
	readCause: () => ({ cause: "API_ERROR", sub: "transient" }) as never,
	readListing: () =>
		listedAs(["api", "blocked"], ["idle", "idle"], ["ended", "working"]),
};

const actingTick = (over: Partial<TickIo> = {}) =>
	fakeIo(
		stateOf({
			launches: [
				KILLED_RESUME,
				API_BLOCKED,
				HELD_LAUNCH,
				RESUMED_IDLE,
				ENDED_HOLD,
			],
		}),
		{
			...LISTED_BLOCKS,
			readLoopLastActAt: (launches) => actedAt(launches, NOW),
			readFreeSlots: () => ({ slots: 2, admission: null }),
			...over,
		},
		{
			block: {
				...ANSWERED_PARK.read,
				idleSince: (l) => (l.jobId === "idle" ? NOW - 20 * MIN : null),
			},
		},
	);

describe("the tick's step order (#4212)", () => {
	it("settles what a kill left before reading the registry, and the relief before the listing (#4180, #2665)", async () => {
		const optedOut = "/opted-out";
		const { io, calls } = actingTick({
			isOptedOut: (root) => root === optedOut,
		});
		await tickOf(io, control({ scope: normal([WFC, optedOut]) }));
		expectOrder(calls, "changeControl", "reap");
		expectOrder(calls, "reap", "readState");
		expectOrder(calls, "readState", "adoptKilledLaunches");
		expectOrder(calls, "adoptKilledLaunches", "blockIo.adoptResumed");
		expectOrder(calls, "blockIo.adoptResumed", "readRegistry");
		expectOrder(calls, "stopNeverStarted", "readListing");
		expectOrder(calls, "tendHolds", "readListing");
	});

	it("judges and acts on the launches only after the listing, and reads the room after them", async () => {
		const { io, calls } = actingTick();
		await tickOf(io);
		expectSequence(calls, [
			"readListing",
			"blockIo.unparkSession",
			"tendClosedParks",
			"blockIo.type",
			"blockIo.idleSince",
			"blockIo.type",
			"releaseAwayParks",
			"readLiftedHolds",
			"readFreeSlots",
			"blockIo.resumeStopped",
			"blockIo.release",
			"readSeats",
			"readFrontier",
		]);
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

describe("what a kill left, settled ahead of the judging (#4180, #4323)", () => {
	it("settles the resumes over the adopted launches, then writes both at once", async () => {
		const adopted = { ...KILLED_RESUME, jobId: "adopted" };
		const handed: (string | null)[] = [];
		const { io, calls, writes } = fakeIo(
			stateOf({ launching: { at: NOW, batch: [] } }),
			{
				adoptKilledLaunches: (read) => ({
					...read,
					launching: undefined,
					launches: [adopted],
				}),
			},
			{
				frontier: [],
				block: {
					adoptResumed: (l) => {
						handed.push(l.jobId);
						return {
							failed: null,
							jobId: "resumed",
							sessionId: "s-resumed",
							copy: false,
						};
					},
				},
			},
		);
		await tickOf(io);
		expect(handed).toEqual(["adopted"]);
		expectOrder(calls, "blockIo.adoptResumed", "updateState");
		expectOrder(calls, "updateState", "readRegistry");
		expect(writes[0].launches).toMatchObject([{ jobId: "resumed" }]);
	});

	it("writes nothing where neither the adoption nor the resumes changed the state", async () => {
		const { io, calls } = fakeIo(stateOf(), {}, { frontier: [] });
		await tickOf(io);
		expect(calls.slice(0, calls.indexOf("readRegistry"))).not.toContain(
			"updateState",
		);
	});
});

describe("the limit acts' holds (#3735, #4323)", () => {
	it("releases the holds the limit acts ended, against the launches they left", async () => {
		const released: string[] = [];
		const rows: (string | null)[] = [];
		const { io, calls } = fakeIo(
			stateOf({ launches: [HELD_LAUNCH, ENDED_HOLD] }),
			{
				...LISTED_BLOCKS,
				readLoopLastActAt: (launches) => actedAt(launches, NOW),
			},
			{
				block: {
					release: ({ jobId }) => {
						released.push(jobId);
						return true;
					},
					writeLedgerHold: (l) => {
						rows.push(l.jobId);
						return true;
					},
				},
			},
		);
		await tickOf(io);
		expectSequence(calls, [
			"blockIo.resumeStopped",
			"blockIo.release",
			"readSeats",
		]);
		expect(released).toEqual(["held", "ended"]);
		expect(rows).toEqual(["held-copy", "ended"]);
	});
});

describe("a kill between two steps (#4157, #4180)", () => {
	it("leaves the batch in flight on record where the kill lands in the launcher, and the next tick adopts it before judging", async () => {
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
			adoptKilledLaunches: (read) => {
				seenBySettle.push(read);
				return { ...read, launching: undefined, launches: [adopted] };
			},
		});
		const r = await tickOf(second.io);
		expect(seenBySettle[0].launching?.batch).toMatchObject([{ issues: [1] }]);
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
	const bootPorts = (lines: string[]): Partial<BlockIo> => ({
		log: (line) => lines.push(line),
		jobStateOf: () => null,
		resumeTargetOf: (l) => ({ sessionId: l.sessionId ?? null, cwd: l.root }),
	});

	it("waits for a read listing, the launches and the wait kept and spared the never-started stop", async () => {
		const blockLines: string[] = [];
		const spared: string[][] = [];
		const trusted: boolean[] = [];
		const { io, lines, disk } = fakeIo(
			stateOf({ launches: [killed], bootedAt: NOW - MIN }),
			{
				stopNeverStarted: (_registry, jobs) => {
					spared.push([...jobs]);
					return [];
				},
				readListing: (isTrusted) => {
					trusted.push(isTrusted);
					return { agents: null, why: "the listing failed" };
				},
			},
			{ block: bootPorts(blockLines) },
		);
		await tickOf(io);
		expect(trusted).toEqual([true]);
		expect(spared).toEqual([["job42"]]);
		expect(lines).toContain(
			"a restart's killed launches wait on the listing: the listing failed",
		);
		expect(disk().bootedAt).toBe(NOW - MIN);
		expect(disk().launches[0]).not.toHaveProperty("stepResume");
		expect(disk().launches[0]?.finishedAt).toBeNull();
	});

	it("queues what a surviving loop's marker says the restart killed, a batch in flight beside it, and drops the marker (#4232)", async () => {
		const blockLines: string[] = [];
		const initial = stateOf({
			launches: [killed],
			launching: { at: NOW, batch: [] },
		});
		const marker = { bootId: "b", at: NOW - MIN };
		const { io, calls, disk } = fakeIo(
			initial,
			{
				readManagerRestart: () => marker,
				readCurrentBootId: () => "b",
				adoptKilledLaunches: () => {
					const { launching: _, ...settled } = initial;
					return settled;
				},
			},
			{ block: bootPorts(blockLines) },
		);
		await tickOf(io);
		expect(blockLines).toContain(
			"design-vault /implement 42, killed by a restart: due back through the resume step",
		);
		expect(calls).toContain("blockIo.resumeOwnId");
		expect(disk().launches[0]).toMatchObject({ bootResumedAt: NOW });
		expect(disk().bootedAt).toBeUndefined();
		expect(disk().sameBootRestart).toBeUndefined();
		expect(calls).toContain("dropManagerRestart");
	});

	it("reopens what the tick before the marker finished for leaving the listing, holding it over a refused listing until one reads (#4145)", async () => {
		const blockLines: string[] = [];
		const marker = { bootId: "b", at: NOW - MIN };
		const before = stateOf({
			launches: [{ ...killed, finishedAt: NOW - 2 * MIN, leftListing: true }],
			lastTick: { at: NOW - 2 * MIN, summary: "" },
		});
		const refused = fakeIo(
			before,
			{
				readManagerRestart: () => marker,
				readCurrentBootId: () => "b",
				readListing: () => ({ agents: null, why: "the listing failed" }),
			},
			{ block: bootPorts(blockLines) },
		);
		await tickOf(refused.io);
		expect(blockLines).toContain(
			"design-vault /implement 42, finished just before a manager restart: reopened",
		);
		expect(refused.disk().launches[0]?.finishedAt).toBeNull();
		expect(refused.disk().bootedAt).toBe(NOW - MIN);
		expect(refused.calls).toContain("dropManagerRestart");
		const read = fakeIo(refused.disk(), {}, { block: bootPorts(blockLines) });
		await tickOf(read.io);
		expect(blockLines).toContain(
			"design-vault /implement 42, killed by a restart: due back through the resume step",
		);
		expect(read.disk().launches[0]).toMatchObject({ bootResumedAt: NOW });
		expect(read.disk().bootedAt).toBeUndefined();
	});
});

describe("the unproven cap through the tick (#4223)", () => {
	const running = [1, 2, 3].map((n) =>
		record({ jobId: `job${n}`, launchedAt: NOW - 30_000 }),
	);
	const seats = [
		SEAT,
		"/home/u/.claude4",
		"/home/u/.claude5",
		"/home/u/.claude6",
	];
	const holds = seats.map((seat, n) => ({
		...HELD_LAUNCH,
		jobId: `held${n}`,
		issues: [10 + n],
		seat,
		sessionId: `s-held${n}`,
		limitHeld: { ...LIMIT_HOLD, sessionId: `s-held${n}` },
	}));
	const limitSlotsOf = async (
		lastActAt: number,
		held = holds,
		over: Partial<TickIo> = {},
	) => {
		const { io, calls, lines } = fakeIo(
			stateOf({ launches: [...running, ...held] }),
			{
				readLoopLastActAt: (launches) => actedAt(launches, lastActAt),
				readFreeSlots: () => ({ slots: 5, admission: null }),
				readSeats: () => ({
					seats: seats.map((seat) => ({ ...sized, seat })),
					probes: [],
				}),
				...over,
			},
			{ frontier: [{ ...row(1), root: HELD_LAUNCH.root }] },
		);
		const { decision } = await tickOf(io);
		return {
			resumed: calls.filter((c) => c === "blockIo.resumeStopped").length,
			lines,
			decision,
		};
	};

	it("holds the limit resumes and the launches where three run since the last act", async () => {
		const { resumed, lines, decision } = await limitSlotsOf(NOW - MIN);
		expect(resumed).toBe(0);
		expect(lines).toContain(
			`design-vault /implement 42 on ${SEAT} reads open, and waits on a free slot`,
		);
		expect(decision).toMatchObject({
			launches: [],
			idle: {
				reason: "3 launches since the last act are running",
				detail: ` (design-vault last act ${new Date(NOW - MIN).toISOString()})`,
			},
		});
	});

	it("frees the cap once an act follows them", async () => {
		expect((await limitSlotsOf(NOW - 1000)).resumed).toBe(3);
		const { decision } = await limitSlotsOf(NOW - 1000, []);
		expect(decision).toMatchObject({ idle: null });
	});

	it("resumes none from held into a probe-held checkout, as it launches none there (#5290)", async () => {
		const { resumed } = await limitSlotsOf(NOW - 1000, holds, {
			readTickHolds: () => ({
				holds: [
					{
						root: HELD_LAUNCH.root,
						kind: "probe",
						issue: null,
						raisedAt: null,
					},
				],
			}),
		});
		expect(resumed).toBe(0);
	});
});

describe("a copy's unretired original through the tick (#4646)", () => {
	it("tries it again and writes the launch without it once retired", async () => {
		const unretired = {
			seat: SEAT,
			sessionId: "s-original",
			cwd: WFC,
			copyJobId: "job42",
			tries: 1,
		};
		const { io, calls, disk } = fakeIo(
			stateOf({
				launches: [record({ unretired: [unretired] }), API_BLOCKED],
			}),
			LISTED_BLOCKS,
		);
		await tickOf(io);
		expectOrder(calls, "blockIo.retireJob", "blockIo.type");
		expect(disk().launches[0]).not.toHaveProperty("unretired");
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
			idle: {
				reason: "a plan resets",
				detail: expect.stringContaining(
					"every seat is spent; a limit-held session waits on one",
				),
			},
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

	it("nets the limit acts' live change into the tick's record (#3778)", async () => {
		const records: { live: number | null }[] = [];
		const { io } = fakeIo(
			stateOf({ launches: [HELD_LAUNCH] }),
			{
				readLoopLastActAt: (launches) => actedAt(launches, NOW),
				readFreeSlots: () => ({
					slots: 1,
					admission: ADMISSION_VERDICT as never,
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
				live: ADMISSION_VERDICT.memory.live.count + 1,
			}),
		]);
	});
});

describe("the checkout the free-slot count is read in (#4962)", () => {
	const peaks: Record<string, number> = {
		"/no-tsc": 0,
		"/ts6": 1497,
		"/ts7": 1938,
	};
	const peakMbOf = (root: string) => peaks[root] ?? 0;

	it("is the served checkout whose type-check is charged most", () => {
		expect(admissionRoot(["/no-tsc", "/ts7", "/ts6"], peakMbOf)).toBe("/ts7");
	});

	it("is a served checkout even where none holds a compiler", () => {
		expect(admissionRoot(["/no-tsc"], peakMbOf)).toBe("/no-tsc");
	});

	it("is none where nothing is served", () => {
		expect(admissionRoot([], peakMbOf)).toBeUndefined();
	});

	it("reads the tick's free slots in the checkout it picks", async () => {
		const readIn: (string | undefined)[] = [];
		const { io } = fakeIo(stateOf(), {
			typecheckPeakMb: peakMbOf,
			readFreeSlots: (root) => {
				readIn.push(root);
				return { slots: 0, admission: null };
			},
		});
		await tickOf(io, control({ scope: normal(["/no-tsc", "/ts7", "/ts6"]) }));
		expect(readIn).toEqual(["/ts7"]);
	});
});

describe("the tick's concurrency row (#3770)", () => {
	it("counts the sessions the tick launched into its live figure", async () => {
		const records: { live: number | null; ceiling: number | null }[] = [];
		const { io } = fakeIo(stateOf(), {
			readFreeSlots: () => ({
				slots: 1,
				admission: { ...ADMISSION_VERDICT, slots: 1 } as never,
			}),
			appendTick: (tickRecord) => {
				records.push(tickRecord);
			},
		});
		const r = await tickOf(io);
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		const { count } = ADMISSION_VERDICT.memory.live;
		expect(records).toEqual([
			expect.objectContaining({ live: count + 1, ceiling: count + 1 }),
		]);
	});

	it("counts the tick's listing in state working, the agents view's figure (#4747)", async () => {
		const records: { working: number | null }[] = [];
		const agents = ["working", "idle", "working", "blocked"].map(
			(state, i) => ({
				sessionId: `s${i}`,
				state,
			}),
		);
		const { io } = fakeIo(stateOf(), {
			readListing: () => ({ agents, why: null }),
			appendTick: (tickRecord) => {
				records.push(tickRecord);
			},
		});
		await tickOf(io);
		expect(records).toEqual([expect.objectContaining({ working: 2 })]);
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
	const parker = (keyVar?: string) => ({
		issues: [5],
		sessionId: "s-job5",
		writtenAt: 1,
		job: {
			seat: Seat2,
			jobId: "job5",
			cwd: WFC,
			...(keyVar ? { keyVar } : {}),
		},
	});
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
				readParkMarkers: () => parkers,
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

	it("sizes a parker's seat for one resume in the first served checkout, its ticket going to the first seat with a fit (#3669, #5293)", async () => {
		const { capped, routes } = await tickOver([parker()]);
		expect(capped).toEqual([`${WFC} ${Seat2}/1`]);
		expect(routes).toEqual([
			expect.objectContaining({
				resume: expect.objectContaining({
					seat: SEAT,
					from: Seat2,
					sessionId: "s-job5",
				}),
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

	it("calls none of the adapter's acts, previewing the reap (#4356, #4323)", async () => {
		const { io, calls } = fakeIo(stateOf({ launches: [record()] }));
		await runTick(io, {
			dryRun: true,
			now: NOW,
			opening: opening(awayControl()),
		});
		expect(calls).toContain("previewReap");
		expect(calls.filter((port) => Object.hasOwn(ACTS, port))).toEqual([]);
	});

	it("calls no block act through the tick's BlockIo, which a live tick reaches (#4569)", async () => {
		const tick = async (dryRun: boolean) => {
			const { io, calls } = actingTick();
			await runTick(io, {
				dryRun,
				now: NOW,
				opening: opening(awayControl()),
			});
			return blockCalls(calls);
		};
		expect(await tick(false)).toEqual(
			expect.arrayContaining([
				"blockIo.adoptResumed",
				"blockIo.unparkSession",
				"blockIo.type",
				"blockIo.resumeStopped",
				"blockIo.release",
			]),
		);
		expect(await tick(true)).toEqual([]);
	});

	it("skips the block and limit acts, judging the launches as read rather than as the dry BlockIo would leave them (#4913)", async () => {
		const { io, calls, lines } = actingTick();
		const { decision } = await tickOf(io, control(), true);
		expect(blockCalls(calls)).toEqual([]);
		expect(lines.join("\n")).not.toContain("a dry run acts on nothing");
		expect(decision).toMatchObject({ idle: null });
	});

	it("releases no ended launch's hold on a paused dry run (#4356)", async () => {
		const paused = control({ paused: { by: "founder", at: 7 } });
		const live = actingTick();
		await tickOf(live.io, paused);
		expect(live.calls).toContain("blockIo.release");
		const dry = actingTick();
		await tickOf(dry.io, paused, true);
		expect(blockCalls(dry.calls)).toEqual([]);
		expect(dry.lines.join("\n")).not.toContain("could not release");
	});

	it("returns at its decision, reading no manager restart or lifted hold and settling nothing", async () => {
		const { io, calls } = fakeIo(stateOf());
		const r = await tickOf(io, control(), true);
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		expect(calls.filter((port) => Object.hasOwn(ACTS, port))).toEqual([]);
		expect(calls).not.toContain("readManagerRestart");
		expect(calls).not.toContain("readLiftedHolds");
	});
});

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

describe("a control change under the lock (#4846, #4188)", () => {
	const ticked = () => control({ scope: normal([WFC]) });
	const optedOut = { isOptedOut: (root: string) => root === WFC };

	it("goes on over the change a dry run previews, writing and logging none", async () => {
		const served: string[][] = [];
		const { io, calls, lines } = fakeIo(stateOf(), {
			...optedOut,
			servedRoots: (scope) => {
				served.push(scope.repos);
				return { roots: scope.repos, dropped: [] };
			},
		});
		await runTick(io, { dryRun: true, now: NOW, opening: opening(ticked()) });
		expect(served[0]).toEqual([]);
		expect(calls).not.toContain("changeControl");
		expect(lines.join("\n")).not.toContain("unticked:");
	});

	it("leaves a change to the next tick where the lock stays held", async () => {
		const { io, lines } = fakeIo(stateOf(), {
			...optedOut,
			changeControl: () => ({ busy: "pid 7" }),
		});
		await tickOf(io, ticked());
		expect(lines).toContain(
			"the opt-out untick waits for the next tick: pid 7",
		);
	});
});

describe("away mode through the tick (#4846, #4976)", () => {
	it("leaves the mode and its switch as they stand", async () => {
		const file = controlFileFake(awayControl());
		const { io } = fakeIo(stateOf(), { changeControl: file.changeControl });
		for (const now of [NOW, NOW + MIN])
			await runTick(io, { dryRun: false, now, opening: opening(file.read()) });
		expect(file.read()).toEqual(awayControl());
	});
});

describe("a paused tick (#3856)", () => {
	const paused = control({ paused: { by: "founder", at: 7 } });

	it("keeps the housekeeping, launches nothing and makes no slot, usage or cap read", async () => {
		const gone = record({
			root: WFC,
			seat: SEAT,
			jobId: "gone",
			launchedAt: NOW - 60 * MIN,
		});
		const capReads: string[] = [];
		const { io, calls, lines, disk } = fakeIo(
			stateOf({ launches: [gone, ENDED_HOLD, HELD_LAUNCH] }),
			{
				...LISTED_BLOCKS,
				readLoopLastActAt: (launches) => actedAt(launches, NOW),
				capSizer: () => () => {
					capReads.push("cap");
					return null;
				},
			},
		);
		await tickOf(io, paused);

		const said = lines.join("\n");
		expect(said).toContain(
			`idle: paused by founder at ${new Date(7).toISOString()}`,
		);
		expect(said).not.toContain("free slots");
		expect(said).not.toContain("resumed 0 of");
		expect(calls).toEqual(
			expect.arrayContaining(["reap", "tendHolds", "blockIo.release"]),
		);
		expect(disk().launches[0].finishedAt).not.toBeNull();
		for (const port of [
			"readFreeSlots",
			"blockIo.resumeStopped",
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

describe("a launch hold through the tick (#4354)", () => {
	const hold = (until: number) => ({
		holder: "0f6c2a9e-3b1d-4e57-9a28-7c4d1e5b6f30",
		until,
	});

	it("keeps the housekeeping, launches nothing and logs the hold as its idle reason", async () => {
		const gone = record({
			root: WFC,
			seat: SEAT,
			jobId: "gone",
			launchedAt: NOW - 60 * MIN,
		});
		const { io, calls, lines, disk } = fakeIo(
			stateOf({ launches: [gone, ENDED_HOLD] }),
			LISTED_BLOCKS,
		);
		const r = await tickOf(io, control({ launchHold: hold(NOW + 20 * MIN) }));

		expect("launches" in r.decision && r.decision.idle?.reason).toBe(
			"launches held by",
		);
		expect(lines.join("\n")).toContain(
			`idle: launches held by a manual /pick-next until ${new Date(NOW + 20 * MIN).toISOString()}`,
		);
		expect(calls).toEqual(
			expect.arrayContaining(["reap", "tendHolds", "blockIo.release"]),
		);
		expect(disk().launches[0].finishedAt).not.toBeNull();
		for (const port of ["readFrontier", "launchBatch"])
			expect(calls).not.toContain(port);
	});

	it("names a script's hold by the script, not a /pick-next (#5905)", async () => {
		const { io, lines } = fakeIo(stateOf());
		await tickOf(
			io,
			control({
				launchHold: { holder: "page-combining-trial", until: NOW + 20 * MIN },
			}),
		);
		expect(lines.join("\n")).toContain(
			`idle: launches held by page-combining-trial until ${new Date(NOW + 20 * MIN).toISOString()}`,
		);
	});

	it("records the live, ceiling and working counts while held, launching nothing (#5905)", async () => {
		const records: object[] = [];
		const agents = [{ sessionId: "s0", state: "working" }];
		const { io, calls } = fakeIo(stateOf(), {
			readListing: () => ({ agents, why: null }),
			readFreeSlots: () => ({
				slots: 3,
				admission: { ...ADMISSION_VERDICT, slots: 3 } as never,
			}),
			appendTick: (tickRecord) => {
				records.push(tickRecord);
			},
		});
		const r = await tickOf(io, control({ launchHold: hold(NOW + 20 * MIN) }));
		expect("launches" in r.decision && r.decision.launches).toEqual([]);
		expect(calls).not.toContain("launchBatch");
		const { count } = ADMISSION_VERDICT.memory.live;
		expect(records).toEqual([
			expect.objectContaining({
				live: count,
				ceiling: count + 3,
				working: 1,
				binding: expect.objectContaining({ limit: "launch hold" }),
			}),
		]);
	});

	it("ignores a hold past its expiry, as a /pick-next that died before its §8 release leaves one, launching as with none", async () => {
		const { io, calls } = fakeIo(stateOf());
		const r = await tickOf(io, control({ launchHold: hold(NOW) }));
		expect("launches" in r.decision && r.decision.launches).toHaveLength(1);
		expect(calls).toContain("launchBatch");
	});

	it("names the founder's pause, not the hold, where both stand", async () => {
		const { io, lines } = fakeIo(stateOf());
		await tickOf(
			io,
			control({
				paused: { by: "founder", at: 7 },
				launchHold: hold(NOW + 20 * MIN),
			}),
		);
		expect(lines.join("\n")).toContain("idle: paused by founder");
	});
});

describe("the launch walk's seat tries (#4074)", () => {
	it("hands each walk the state file's tries, the launch walk the move walk's this tick too", async () => {
		const Other = "/home/u/.claude4";
		const tried: Record<string, number>[] = [];
		const { io } = fakeIo(
			stateOf({ launches: [HELD_LAUNCH], seatTriedAt: { [Other]: 5 } }),
			{
				readSeats: (_seats, _slots, _root, how) => {
					tried.push(how.tries.triedAt);
					return {
						seats: [sized],
						probes: how.sizeAll ? [{ seat: SEAT, outcome: "failed" }] : [],
					};
				},
			},
		);
		await tickOf(io);
		expect(tried).toEqual([{ [Other]: 5 }, { [Other]: 5, [SEAT]: NOW }]);
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
			idle: { reason: "a plan resets", detail: expect.any(String) },
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

describe("the sessions parked on a lifted repo hold (#3863)", () => {
	const keptLifted = async (c: Control) => {
		const dropped: unknown[] = [];
		const { io, calls } = fakeIo(stateOf(), {
			dropSettledLifted: (settled) => {
				dropped.push(settled);
			},
		});
		await tickOf(io, c);
		return { calls, dropped };
	};

	it("reads the lifted holds on a live tick", async () => {
		const { calls } = await keptLifted(control());
		expect(calls).toContain("readLiftedHolds");
	});

	it("keeps them through a tick that stops, reading and dropping none", async () => {
		const { calls, dropped } = await keptLifted(
			control({ stopRequested: true }),
		);
		expect(calls).not.toContain("readLiftedHolds");
		expect(dropped).toEqual([[]]);
	});

	it("keeps them through a paused tick, reading and dropping none", async () => {
		const { calls, dropped } = await keptLifted(
			control({ paused: { by: "founder", at: 7 } }),
		);
		expect(calls).not.toContain("readLiftedHolds");
		expect(dropped).toEqual([[]]);
	});
});

describe("the checkouts a live tick tends (#3284, #4247, #4248, #4318)", () => {
	it("supervises, levels, warms and reaps each landing root with a config, skipping a gone one, and tends every root's holds", async () => {
		const gone = "/home/u/gone";
		const acts: string[] = [];
		const holdRoots: string[][] = [];
		const { io } = fakeIo(
			stateOf({ launches: [record({ root: gone, jobId: "j9" })] }),
			{
				hasConfig: (root) => root !== gone,
				superviseLanding: (root) => acts.push(`supervise ${root}`),
				levelMain: (root) => acts.push(`level ${root}`),
				startWarmPass: (root) => acts.push(`warm ${root}`),
				startReapPass: (root) => acts.push(`reap ${root}`),
				runMachineChild: (script) => acts.push(`run ${script}`),
				tendHolds: (roots) => {
					holdRoots.push(roots);
					return [];
				},
			},
		);
		await tickOf(io);
		expect(acts).toEqual([
			`supervise ${WFC}`,
			`level ${WFC}`,
			`warm ${WFC}`,
			`reap ${WFC}`,
			"run file-memory-kill-tickets.js",
			"run file-process-runaway-tickets.js",
			"run repair-sweep-slot.js",
		]);
		expect(holdRoots).toEqual([[WFC, gone]]);
	});
});

describe("an overflow session's listed id (#3701)", () => {
	const overflow = { kind: "overflow", dir: "/k", keyVar: "K2" };
	const recordedWith = async (
		declared: { seats: object[]; errors: string[] },
		agents: object[] | null,
	) => {
		const recorded: unknown[] = [];
		const { io } = fakeIo(stateOf(), {
			readListing: () => ({ agents: agents as never, why: null }),
			recordListedOverflowSessions: (a) => {
				recorded.push(a);
			},
		});
		await runTick(io, {
			dryRun: false,
			now: NOW,
			opening: { ...opening(control()), declared: declared as never },
		});
		return recorded;
	};
	const listed = [{ id: "j", sessionId: "s", kind: "background" }];

	it("records the ids the listing shows where an overflow seat is declared soundly", async () => {
		expect(
			await recordedWith({ seats: [overflow], errors: [] }, listed),
		).toEqual([listed]);
	});

	it("records none off an unread listing, no overflow seat, or a faulted seat file", async () => {
		expect(await recordedWith({ seats: [overflow], errors: [] }, null)).toEqual(
			[],
		);
		expect(await recordedWith({ seats: [], errors: [] }, listed)).toEqual([]);
		expect(
			await recordedWith({ seats: [overflow], errors: ["bad"] }, listed),
		).toEqual([]);
	});
});

describe("the parks a tick sweeps (#3950, #3872)", () => {
	const Other = "/home/u/other";

	const sweep = () => {
		const swept: string[] = [];
		const block: Partial<BlockIo> = {
			...ANSWERED_PARK.read,
			unparkSession: (root) => {
				swept.push(root);
				return null;
			},
		};
		return { swept, block };
	};

	it("takes answered parks off in every checkout it could serve, not only the served", async () => {
		const { swept, block } = sweep();
		const { io } = fakeIo(
			stateOf(),
			{ readIncluded: () => [WFC, Other] },
			{ block },
		);
		await tickOf(io);
		expect(swept).toEqual([WFC, Other]);
	});

	it("sweeps the served alone, logged, where discovery will not read", async () => {
		const { swept, block } = sweep();
		const { io, lines } = fakeIo(
			stateOf(),
			{
				readIncluded: () => {
					throw new Error("EACCES");
				},
			},
			{ block },
		);
		await tickOf(io);
		expect(swept).toEqual([WFC]);
		expect(lines.join("\n")).toContain("unserved parks unread: ");
	});

	it("releases the away parks' ledger rows before it reads the shortlist", async () => {
		const { io, calls } = fakeIo(stateOf());
		await tickOf(io);
		expectOrder(calls, "releaseAwayParks", "readFrontier");
	});
});

describe("the throughput acts through the tick (#5275)", () => {
	type BreakerEvent = import("./refill-breaker.js").BreakerEvent;
	const openedAt = NOW - 10_000;
	const opened: BreakerEvent = {
		at: new Date(openedAt).toISOString(),
		repo: WFC,
		event: "open",
		rate: 0.1,
		workingHours: 14,
	};
	const throughputOf = (events: BreakerEvent[]) => ({
		...NO_THROUGHPUT,
		byRoot: {
			[WFC]: {
				commits: [],
				gateRuns: [],
				suiteCommand: null,
				sessions: [],
				timelinesUnread: [],
			},
		},
		record: events,
	});
	const runningFrom = (launchedAt: number) =>
		record({ root: WFC, jobId: "w1", sessionId: "s-w1", launchedAt });
	const tickWith = async (running: Launch[]) => {
		const appended: BreakerEvent[] = [];
		const { io } = fakeIo(stateOf({ launches: running }), {
			readThroughput: () => throughputOf([opened]),
			appendBreakerEvents: (events) => {
				appended.push(...events);
			},
		});
		const { decision } = await tickOf(io);
		const launches = "launches" in decision ? decision.launches : [];
		return { launches, appended };
	};

	it("launches nothing into an open breaker's checkout while a session from before it runs", async () => {
		const { launches, appended } = await tickWith([
			runningFrom(openedAt - 20_000) as Launch,
		]);
		expect(launches).toEqual([]);
		expect(appended).toEqual([]);
	});

	it("admits the trial once none runs there", async () => {
		const { launches } = await tickWith([]);
		expect(launches).toHaveLength(1);
	});

	it("records the trial the next tick finds launched", async () => {
		const { appended } = await tickWith([runningFrom(NOW - 5000) as Launch]);
		expect(appended).toEqual([
			expect.objectContaining({ event: "trial-start", session: "s-w1" }),
		]);
	});
});

describe("a launch the harness ended on a synthetic reply, through the tick (#5324)", () => {
	const stopAt = (minutesAgo: number) =>
		new Date(NOW - minutesAgo * MIN).toISOString();
	const Syn = record({
		jobId: "syn",
		issues: [9],
		launchedAt: NOW - 60 * MIN,
	}) as Launch;
	const synTick = (
		launch: Launch,
		{
			job = doneJob(),
			rows = stoppedRows(stopAt(6)),
			replied = false,
		}: { job?: unknown; rows?: unknown; replied?: boolean } = {},
	) =>
		fakeIo(
			stateOf({ launches: [launch] }),
			{ readListing: () => listedAs(["syn", "done"]) },
			{
				frontier: [],
				block: {
					syntheticStopOf: () => syntheticStopAt({ job, rows }),
					jobStateOf: () => job as never,
					hasRepliedSince: () => replied,
				},
			},
		);
	const synOf = (disk: () => LoopState) =>
		disk().launches.find((l) => l.issues[0] === 9);
	const typedAt = (minutesAgo: number) =>
		record({
			...Syn,
			synthetic: {
				at: Date.parse(stopAt(minutesAgo)),
				tries: 1,
				resumed: 1,
				triedAt: NOW - 2 * MIN,
				attachAt: NOW - 2 * MIN,
			},
		}) as Launch;

	it("types the resume into a loop launch once the quiet window passes, keeping it unfinished", async () => {
		const { io, calls, lines, disk } = synTick(Syn);
		await tickOf(io);
		expect(calls).toContain("blockIo.type");
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^resumed .*synthetic reply at .* by typing into the live session, try 1 of 2$/,
			),
		);
		expect(synOf(disk)).toMatchObject({
			finishedAt: null,
			synthetic: { tries: 1, resumed: 1, attachAt: NOW },
		});
	});

	it("waits inside the quiet window, the launch unfinished", async () => {
		const { io, calls, disk } = synTick(Syn, { rows: stoppedRows(stopAt(2)) });
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
		expect(synOf(disk)?.finishedAt).toBeNull();
	});

	it("stands down where the founder typed after the stop, and the launch finishes", async () => {
		const { io, calls, disk } = synTick(Syn, {
			rows: [...stoppedRows(stopAt(6)), founderRow("go on", stopAt(1))],
		});
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
		expect(calls).not.toContain("blockIo.stop");
		expect(synOf(disk)?.finishedAt).toBe(NOW);
	});

	it("stands down where a later turn row follows the stop", async () => {
		const { io, calls } = synTick(Syn, {
			rows: [...stoppedRows(stopAt(6)), replyRow("result: done", stopAt(1))],
		});
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
	});

	it("relaunches a typed resume the transcript never shows, by stop and --bg --resume", async () => {
		const { io, calls } = synTick(typedAt(8), { rows: stoppedRows(stopAt(8)) });
		await tickOf(io);
		expectOrder(calls, "blockIo.stop", "blockIo.resumeStopped");
		expect(calls).not.toContain("blockIo.type");
	});

	it("takes a typed resume the transcript shows as arrived, stopping nothing", async () => {
		const { io, calls, disk } = synTick(typedAt(8), {
			job: doneJob({ state: "working" }),
			rows: [
				...stoppedRows(stopAt(8)),
				founderRow("[refill loop] resume", stopAt(2)),
			],
		});
		await tickOf(io);
		expect(calls).not.toContain("blockIo.stop");
		expect(synOf(disk)?.synthetic).not.toHaveProperty("attachAt");
	});

	it("resumes a job the reaper already stopped straight by --bg --resume", async () => {
		const { io, calls, lines } = synTick(Syn, {
			job: doneJob({ state: "stopped" }),
		});
		await tickOf(io);
		expect(calls).toContain("blockIo.resumeStopped");
		expect(calls).not.toContain("blockIo.stop");
		expect(calls).not.toContain("blockIo.type");
		expect(lines).toContainEqual(
			expect.stringContaining("by --bg --resume, the reaper having stopped it"),
		);
	});

	it.each([
		[
			"a launch hold stands",
			{ launchHold: { holder: "s1", until: NOW + 20 * MIN } },
		],
		["the loop is paused", { paused: { by: "founder", at: 7 } }],
	])("types nothing into a launch while %s", async (_why, over) => {
		const { io, calls } = synTick(Syn);
		await tickOf(io, control(over));
		for (const act of ["blockIo.type", "blockIo.stop", "blockIo.resumeStopped"])
			expect(calls).not.toContain(act);
	});

	it("holds a launch's due resume while the API host is unreachable, no try spent", async () => {
		const { io, calls, lines, disk } = fakeIo(
			stateOf({ launches: [Syn] }),
			{ readListing: () => listedAs(["syn", "done"]) },
			{
				frontier: [],
				block: {
					syntheticStopOf: () =>
						syntheticStopAt({ job: doneJob(), rows: stoppedRows(stopAt(6)) }),
					jobStateOf: () => doneJob() as never,
					probeNetwork: () => "offline",
				},
			},
		);
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
		expect(lines.join("\n")).toContain(
			"these due resumes wait for the next tick",
		);
		expect(synOf(disk)?.synthetic?.tries ?? 0).toBe(0);
	});

	it("logs the give-up at the cap, then lets the launch finish", async () => {
		const capped = record({
			...Syn,
			synthetic: {
				at: Date.parse(stopAt(20)),
				tries: 2,
				resumed: 2,
				triedAt: NOW - 10 * MIN,
			},
		}) as Launch;
		const { io, calls, lines, disk } = synTick(capped, {
			rows: stoppedRows(stopAt(20)),
		});
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^stopped trying to resume .* after 2 resumes of its synthetic stop/,
			),
		);
		expect(synOf(disk)).toMatchObject({
			finishedAt: null,
			synthetic: { spent: true },
		});
		await runTick(io, {
			dryRun: false,
			now: NOW + MIN,
			opening: opening(control()),
		});
		expect(synOf(disk)?.finishedAt).toBe(NOW + MIN);
	});

	it("starts a fresh count on a later, separate stop, a reply having come between", async () => {
		const was = record({
			...Syn,
			synthetic: {
				at: Date.parse(stopAt(60)),
				tries: 2,
				resumed: 2,
				triedAt: NOW - 50 * MIN,
				spent: true,
			},
		}) as Launch;
		const { io, lines } = synTick(was, { replied: true });
		await tickOf(io);
		expect(lines).toContainEqual(expect.stringMatching(/try 1 of 2$/));
	});

	it("carries the count to a stop a resume ran straight into, with no reply between", async () => {
		const was = record({
			...Syn,
			synthetic: {
				at: Date.parse(stopAt(30)),
				tries: 2,
				resumed: 2,
				triedAt: NOW - 25 * MIN,
			},
		}) as Launch;
		const { io, calls } = synTick(was, { replied: false });
		await tickOf(io);
		expect(calls).not.toContain("blockIo.type");
	});

	it.each([
		["transcript", { rows: null }],
		["job record", { job: null }],
	])("acts on nothing where the %s is unread", async (_what, unread) => {
		const { io, calls } = synTick(Syn, unread);
		await tickOf(io);
		for (const act of ["blockIo.type", "blockIo.stop", "blockIo.resumeStopped"])
			expect(calls).not.toContain(act);
	});

	it("types the resume into a session it did not launch, off the job store whatever the listing's state reads", async () => {
		const outside = {
			sessionId: "s-out",
			id: "out1",
			name: "founder-session",
			kind: "background",
			state: "working",
			seat: SEAT,
			cwd: "/home/u/work",
		};
		const { io, calls, lines } = fakeIo(
			stateOf({ launches: [] }),
			{
				readListing: () => ({ agents: [outside] as never, why: null }),
				readRegistry: () =>
					({ seats: [SEAT], faults: [], agents: [outside] }) as never,
				actOnOutside: (launches, registry, seen) =>
					actOnOutside(launches, registry, () => null as never, seen),
			},
			{
				frontier: [],
				block: {
					syntheticStopOf: () =>
						syntheticStopAt({ job: doneJob(), rows: stoppedRows(stopAt(6)) }),
					jobStateOf: () => doneJob() as never,
				},
			},
		);
		await tickOf(io);
		expect(calls).toContain("blockIo.type");
		expect(lines.join("\n")).toMatch(
			/resumed founder-session .*whose last turn the harness ended on a synthetic reply.* try 1 of 2/,
		);
	});

	it("resumes a session it did not launch that the reaper stopped before the loop read its stop, off the reaper's journal (#5331)", async () => {
		const stopped = doneJob({ state: "stopped" });
		const { io, calls, lines } = fakeIo(
			stateOf({ launches: [] }),
			{
				readListing: () => ({ agents: [], why: null }),
				readRegistry: () =>
					({ seats: [SEAT], faults: [], agents: [] }) as never,
				actOnOutside: (launches, registry, seen) =>
					actOnOutside(launches, registry, () => null as never, seen),
			},
			{
				frontier: [],
				block: {
					readReaped: () => ({
						jobs: [
							{
								at: NOW - MIN,
								seat: SEAT,
								jobId: "out1",
								sessionId: "s-out",
								name: "founder-session",
								cwd: "/home/u/work",
							},
						],
						read: [],
					}),
					syntheticStopOf: () =>
						syntheticStopAt({ job: stopped, rows: stoppedRows(stopAt(20)) }),
					jobStateOf: () => stopped as never,
				},
			},
		);
		await tickOf(io);
		expect(calls).toContain("blockIo.resumeStopped");
		expect(calls).not.toContain("blockIo.stop");
		expect(lines.join("\n")).toMatch(
			/resumed founder-session .*synthetic reply.* by --bg --resume, the reaper having stopped it.* try 1 of 2/,
		);
	});

	it("names the cause on the finished-launch line", () => {
		const line = buildFinishLine({
			...Syn,
			synthetic: { at: NOW, tries: 1, resumed: 3 },
		});
		expect(line).toMatch(
			/resumed 3 time\(s\) after the harness ended its turn on a synthetic reply$/,
		);
	});
});

describe("billingStopsOf (#5479)", () => {
	const billing = (over: Record<string, unknown> = {}) =>
		record({
			seat: "/home/u/.claude2",
			block: {
				cause: "API_ERROR",
				sub: "transient",
				billing: true,
				since: NOW - 20 * MIN,
			},
			...over,
		});

	it("names a running plan-seat launch's billing stop, timed from its latest try", () => {
		expect(billingStopsOf([billing()])).toEqual([
			{ seat: "/home/u/.claude2", since: NOW - 20 * MIN },
		]);
		expect(
			billingStopsOf([
				billing({ resumes: { tries: 2, triedAt: NOW - 5 * MIN, nextAt: NOW } }),
			]),
		).toEqual([{ seat: "/home/u/.claude2", since: NOW - 5 * MIN }]);
	});

	it("leaves out a finished launch, an overflow one and a stop that is not billing", () => {
		expect(
			billingStopsOf([
				billing({ finishedAt: NOW }),
				billing({ keyVar: "KEY_A" }),
				record({ block: { cause: "API_ERROR", sub: "auth", since: NOW } }),
			]),
		).toEqual([]);
	});
});

describe("a held checkout's gate judgement through the tick (#5766)", () => {
	const judgement = { root: DV, number: 532, prompt: "/triage 532" };
	const held: [string, Partial<Control>, Partial<TickIo>][] = [
		[
			"probe-held",
			{},
			{
				readTickHolds: () => ({
					holds: [{ root: DV, kind: "probe", issue: null, raisedAt: null }],
				}),
			},
		],
	];

	it.each(held)(
		"reads the frontier past a %s checkout's judgement and launches the other's row",
		async (_, controlOver, ioOver) => {
			const c = control({ scope: normal([WFC, DV]), ...controlOver });
			const { io, calls } = fakeIo(stateOf(), {
				readControl: () => ({ control: c, damaged: null }),
				readGateJudgements: () => [judgement],
				...ioOver,
			});
			const { decision } = await tickOf(io, c);
			expect(calls).toContain("readFrontier");
			expect(decision).toMatchObject({
				idle: null,
				launches: [expect.objectContaining({ root: WFC, issues: [1] })],
			});
		},
	);
});
