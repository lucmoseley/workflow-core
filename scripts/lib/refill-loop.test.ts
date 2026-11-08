// @vitest-environment node
/*
 * The refill loop's pure readings (#2012) and the repos a tick serves
 * (#2123); a seat's reading and sizing are seat-reading.test.ts's. No fixture
 * touches disk but the read of dispatch-sessions.sh that pins the free-slot
 * count's admission flags to the script's, and the acts ledgers the progress
 * cases write in arbiter-testkit's sandbox.
 *
 * Loosen one and a working session can be judged finished and stop the run
 * for no progress, a stop written mid-tick let the rest
 * of the tick's picks launch or one written during the review go unrecorded,
 * or a launch be judged without the session id its listing gave, or by
 * anything but what its own session did, or a job that never started stay
 * listed for good, or a live one be stopped, or an API-error session be judged finished between resumes, resumed twice
 * for one try, or resumed off a listing that would not read, or a gate
 * judgement's record lose the flag that keeps it out of the no-progress run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AS_ROOT, freshSandbox, store } from "./arbiter-testkit";
import { buildStatusLines } from "./refill-commands.js";
import { decideTick } from "./refill-decide.js";
import {
	actsOf,
	controlWithoutOptedOut,
	isRestartedSince,
	isReviewRunDue,
	judgedLaunches,
	landingRoots,
	lastActOf,
	limitHoldsOf,
	parseControl,
	readActsSoFar,
	reviewStep,
	runningOf,
	scopeRoots,
	summaryOf,
	workingOf,
} from "./refill-loop.js";
import {
	away,
	DV,
	type Launch,
	MH,
	MIN,
	NOW,
	normal,
	record,
	seat,
	stateFileFake,
	WFC,
} from "./refill-loop-fixture";
import { buildSeatName } from "./refill-seats.js";
import { launchRecorded } from "./refill-state.js";
import { loopStateOf } from "./refill-state-testkit";
import {
	buildFinishLine,
	buildReviewSkip,
	FREE_SLOT_ARGS,
	parseProbeOutcome,
	settleLaunching,
	stopNeverStarted,
} from "./refill-tick-core.js";
import { settleTick } from "./refill-tick-settle.js";

const agent = (id: string, state: string) => ({
	sessionId: `s-${id}`,
	id,
	kind: "background",
	state,
});

type Reading = import("./block-cause.js").Reading;

/** The launches after one listing, every finished one judged with no progress
 * fields unless `progressOf` gives some, every parked one read as `cause`, or
 * as an API_ERROR of kind `sub`. */
const judged = (
	launches: Launch[],
	agents: ReturnType<typeof agent>[] | null,
	{
		progressOf = () => ({}),
		cause = "QUESTION",
		sub,
	}: {
		progressOf?: (l: Launch) => object;
		cause?: Reading["cause"];
		sub?: import("./block-cause.js").ApiErrorKind;
	} = {},
) =>
	judgedLaunches(launches, agents, NOW, {
		progressOf,
		causeOf: () => (sub ? { cause: "API_ERROR", sub } : { cause }) as Reading,
	});

const finished = (
	launches: Launch[],
	agents: ReturnType<typeof agent>[] | null,
) =>
	judged(launches, agents)
		.filter((l) => l.finishedAt === NOW)
		.map((l) => l.jobId);

describe("which launches have finished", () => {
	it("counts a launch whose job left the listing or ended any way", () => {
		const gone = record({ jobId: "gone" });
		const ended = ["done", "failed", "stopped"].map((state) =>
			record({ jobId: state }),
		);
		const working = record({ jobId: "work1" });
		const agents = [
			...["done", "failed", "stopped"].map((state) => agent(state, state)),
			agent("work1", "working"),
		];
		expect(finished([gone, ...ended, working], agents)).toEqual([
			"gone",
			"done",
			"failed",
			"stopped",
		]);
	});

	it("judges nothing off an unread listing", () => {
		expect(finished([record({ jobId: "gone" })], null)).toEqual([]);
	});

	it("waits out a launch too young to be listed yet", () => {
		expect(finished([record({ launchedAt: NOW - MIN })], [])).toEqual([]);
	});

	it("never judges a launch with no job id, or one already judged", () => {
		const blind = record({ jobId: null });
		const done = record({ finishedAt: NOW - MIN });
		expect(judged([blind, done], [])).toEqual([blind, done]);
	});

	it("never judges a session parked on a question finished (#2118)", () => {
		expect(
			finished([record({ jobId: "park1" })], [agent("park1", "blocked")]),
		).toEqual([]);
	});

	it("holds the unfinished launches with a job id as running", () => {
		expect(
			runningOf([
				record(),
				record({ issues: [7], finishedAt: NOW }),
				record({ issues: [8], jobId: null }),
			]),
		).toEqual([{ root: "/home/u/design-vault", issues: [42] }]);
	});

	it("keeps a parked launch's issues from being launched again (#2118)", () => {
		expect(runningOf([record({ parked: true })])).toEqual([
			{ root: "/home/u/design-vault", issues: [42] },
		]);
	});
});

describe("the idle alarm's reading of a limit hold (#3838)", () => {
	const limitHeld = {
		at: NOW - 3 * 24 * 60 * MIN,
		sessionId: "s",
		cwd: "/c",
		limit: { bar: "weekly", resets: "Fri" },
	};
	const stopped = record({ issues: [7, 8], limitHeld });

	it("reads a launch stopped on its limit as held from the stop, one row per issue, and not as working", () => {
		const why = "stopped on its weekly limit (reset Fri)";
		expect(limitHoldsOf([stopped])).toEqual([
			{
				root: stopped.root,
				number: 7,
				why,
				since: limitHeld.at,
				onLimit: true,
			},
			{
				root: stopped.root,
				number: 8,
				why,
				since: limitHeld.at,
				onLimit: true,
			},
		]);
		expect(workingOf([stopped])).toEqual([]);
	});

	it("reads a limit-blocked launch the loop could not stop as held from the block, as no bound parks it", () => {
		const since = NOW - 5 * 24 * 60 * MIN;
		const blocked = record({ issues: [9], block: { cause: "LIMIT", since } });
		expect(limitHoldsOf([blocked])).toEqual([
			{
				root: blocked.root,
				number: 9,
				why: "blocked on its limit, its session not stopped",
				since,
				onLimit: true,
			},
		]);
		expect(workingOf([blocked])).toEqual([]);
	});

	it("reads a working launch, a question-held one and one resumed from its hold as working, not held", () => {
		const live = [
			record({ issues: [1] }),
			record({
				issues: [2],
				parked: true,
				block: { cause: "QUESTION", since: NOW - MIN },
			}),
			record({ issues: [3], limitHeld: { ...limitHeld, resumedAt: NOW } }),
		];
		expect(limitHoldsOf(live)).toEqual([]);
		expect(workingOf(live).flatMap((l) => l.issues)).toEqual([1, 2, 3]);
	});

	it("reads a finished launch's stale hold as neither", () => {
		const done = record({ limitHeld, finishedAt: NOW });
		expect(limitHoldsOf([done])).toEqual([]);
		expect(workingOf([done])).toEqual([]);
	});
});

describe("which launches are parked on a question (#2118)", () => {
	it("marks a listed blocked session parked, and clears it once it works again", () => {
		const out = judged(
			[record({ jobId: "p" }), record({ jobId: "w", parked: true })],
			[agent("p", "blocked"), agent("w", "working")],
		);
		expect(out.map((l) => l.parked)).toEqual([true, false]);
	});

	it("keeps the last word off an unread listing or for an unlisted launch", () => {
		const was = record({ parked: true, launchedAt: NOW - MIN });
		expect(judged([was], null)).toEqual([was]);
		expect(judged([was], [])).toEqual([was]);
	});

	it("leaves finished launches and ones with no job id unmarked", () => {
		const done = record({ jobId: "p", finishedAt: NOW });
		const blind = record({ jobId: null });
		expect(judged([done, blind], [agent("p", "blocked")])).toEqual([
			{ ...done, sessionId: "s-p" },
			blind,
		]);
	});
});

describe("a parked launch's block record (#2699)", () => {
	const blocked = [agent("p", "blocked")];

	it("records the cause read and the tick that first read it", () => {
		const [out] = judged([record({ jobId: "p" })], blocked, {
			cause: "PERMISSION",
		});
		expect(out?.block).toEqual({ cause: "PERMISSION", since: NOW });
	});

	it("keeps its start while it stays parked, across a change of cause", () => {
		const was = record({
			jobId: "p",
			parked: true,
			block: { cause: "QUESTION", since: NOW - 30 * MIN },
		});
		expect(judged([was], blocked, { cause: "PERMISSION" })[0]?.block).toEqual({
			cause: "PERMISSION",
			since: NOW - 30 * MIN,
		});
	});

	it("drops it once the session works again", () => {
		const was = record({
			jobId: "p",
			parked: true,
			block: { cause: "QUESTION", since: NOW - MIN },
		});
		const [out] = judged([was], [agent("p", "working")]);
		expect(out?.parked).toBe(false);
		expect(out).not.toHaveProperty("block");
	});
});

describe("the launched session's id (#2311)", () => {
	it("takes it from the first listing that shows the job", () => {
		const out = judged([record({ jobId: "a" })], [agent("a", "working")]);
		expect(out[0]).toMatchObject({ sessionId: "s-a", finishedAt: null });
	});

	it("is on the launch its progress is judged for, where the first listing already shows it ended", () => {
		const seen: (string | undefined)[] = [];
		const out = judged([record({ jobId: "a" })], [agent("a", "done")], {
			progressOf: (l) => {
				seen.push(l.sessionId);
				return {};
			},
		});
		expect(seen).toEqual(["s-a"]);
		expect(out[0]).toMatchObject({ sessionId: "s-a", finishedAt: NOW });
	});

	it("leaves a launch unchanged off an unread listing, for an unlisted job or with no job id", () => {
		const young = record({ jobId: "gone", launchedAt: NOW - MIN });
		const blind = record({ jobId: null });
		expect(judged([young], null)).toEqual([young]);
		expect(judged([young, blind], [agent("a", "working")])).toEqual([
			young,
			blind,
		]);
		expect(young).not.toHaveProperty("sessionId");
	});

	it("keeps the id first captured", () => {
		const had = record({ jobId: "a", sessionId: "first" });
		expect(judged([had], [agent("a", "working")])[0].sessionId).toBe("first");
	});
});

describe("the loop's last act, for the unproven cap (#4223)", () => {
	const at: Record<string, number> = { old: 100, mid: 300, now: 200 };
	const read = (id: string, roots: string[]) => ({
		at: at[id] ?? null,
		unreadable: id === "bad" ? roots : [],
	});

	it("takes the latest act across every launch and each session it ran under", () => {
		const launches = [
			record({ sessionId: "now", pastSessionIds: ["mid"] }),
			record({ sessionId: "old" }),
			record({}),
		] as Launch[];
		expect(lastActOf(launches, () => ["r"], read)).toEqual({
			at: 300,
			unread: [],
		});
	});

	it("names each store that would not read, reading no act there", () => {
		const launches = [record({ sessionId: "bad" })] as Launch[];
		expect(lastActOf(launches, () => ["r1", "r2"], read)).toEqual({
			at: null,
			unread: [
				{ sessionId: "bad", root: "r1" },
				{ sessionId: "bad", root: "r2" },
			],
		});
	});
});

describe("a finished launch's progress, from its session's acts ledger (#2312)", () => {
	const sb = freshSandbox();
	const other = () => path.join(sb.dir, "other-repo");

	/** The launches after a listing where each has ended, judged by the acts
	 * ledger across the sandbox's two repos. A job in `idless` is listed with no
	 * session id. */
	const judgedByLedger = (launches: Launch[], idless: string[] = []) =>
		judgedLaunches(
			launches,
			launches.map((l) => {
				const id = String(l.jobId);
				return idless.includes(id)
					? { ...agent(id, "done"), sessionId: "" }
					: agent(id, "done");
			}),
			NOW,
			{
				progressOf: (l) => actsOf(l, [sb.repo, other()], store.readActsBy),
				causeOf: () => ({ cause: "QUESTION" }),
			},
		);

	const ended = (job: string) =>
		record({
			jobId: job,
			issues: [Number(job.slice(1))],
			prompt: `/implement ${job.slice(1)}`,
		});

	it("counts each act kind, in any served repo's store", () => {
		fs.mkdirSync(other(), { recursive: true });
		store.recordAct("file owner/repo#5", "s-j1", sb.repo);
		store.recordAct("file owner/repo#6", "s-j1", sb.repo);
		store.recordAct("close other/repo#7", "s-j1", other());
		store.recordCommit("c".repeat(40), "s-j1");
		const [l] = judgedByLedger([ended("j1")]);
		expect(l).toMatchObject({
			finishedAt: NOW,
			acts: { file: 2, close: 1, commit: 1 },
		});
		expect(buildFinishLine(l)).toBe(
			"finished design-vault /implement 1: file 2, commit 1, close 1",
		);
	});

	describe("a parked session resumed in place as a new launch (#3942)", () => {
		const readBefore = () => readActsSoFar("s-j3", [sb.repo], store.readActsBy);
		const resumed = (
			job: string,
			actsBefore: Launch["actsBefore"],
			over: Partial<Launch> = {},
		) => ({ ...ended(job), sessionId: "s-j3", actsBefore, ...over });

		it("counts only what it did since its resume", () => {
			store.recordAct("file owner/repo#3", "s-j3", sb.repo);
			store.recordCommit("d".repeat(40), "s-j3");
			const before = readBefore();
			expect(before).toEqual({ file: 1, commit: 1 });
			store.recordAct("close owner/repo#3", "s-j3", sb.repo);
			store.recordAct("file owner/repo#4", "s-j3", sb.repo);
			const [l] = judgedByLedger([resumed("j3", before)]);
			expect(l.acts).toEqual({ file: 1, close: 1 });
		});

		it("reads as no acts where it did nothing, and counts towards the no-progress pause", () => {
			store.recordAct("file owner/repo#3", "s-j3", sb.repo);
			const before = readBefore();
			const history = judgedByLedger(
				["j3", "j4", "j5"].map((job) => resumed(job, before)),
			);
			expect(history.map((r) => r.acts)).toEqual([{}, {}, {}]);
			expect(buildFinishLine(history[0])).toBe(
				"finished design-vault /implement 3: no acts",
			);
			expect(decideOn(history)).toHaveProperty("pause.by", "no-progress");
		});

		it("still sums its past sessions where a limit then moved it to a copy (#2969)", () => {
			store.recordAct("file owner/repo#3", "s-j3", sb.repo);
			store.recordAct("close owner/repo#3", "s-j3", sb.repo);
			store.recordAct("round owner/repo#3", "s-copy", sb.repo);
			const [l] = judgedByLedger([
				resumed(
					"j3",
					{ file: 1 },
					{ sessionId: "s-copy", pastSessionIds: ["s-j3"] },
				),
			]);
			expect(l.acts).toEqual({ close: 1, round: 1 });
		});

		it("is unread where its count at the resume was, not read as progress", () => {
			store.recordAct("file owner/repo#3", "s-j3", sb.repo);
			const [l] = judgedByLedger([resumed("j3", "unread")]);
			expect(l.acts).toBe("unread");
		});

		it("is unread where a store would not read at its finish, not read as having done nothing", () => {
			expect(
				actsOf(
					{ ...resumed("j3", { file: 1, close: 1 }) },
					[sb.repo, other()],
					() => ({ acts: ["file owner/repo#3"], unreadable: [other()] }),
				),
			).toEqual({ acts: "unread" });
		});

		it("takes no count from a store that would not read, as a part count passes its acts off as new", () => {
			expect(
				readActsSoFar("s-j3", [sb.repo], () => ({
					acts: ["file owner/repo#3"],
					unreadable: [sb.repo],
				})),
			).toBe("unread");
		});
	});

	it("sums the acts of a launch's first session and the copy a resume moved it to (#2969)", () => {
		store.recordAct("file owner/repo#8", "s-first", sb.repo);
		store.recordAct("close owner/repo#8", "s-j8", sb.repo);
		store.recordAct("file owner/repo#9", "s-j8", sb.repo);
		const [l] = judgedByLedger([
			{ ...ended("j8"), sessionId: "s-j8", pastSessionIds: ["s-first"] },
		]);
		expect(l.acts).toEqual({ file: 2, close: 1 });
	});

	it("counts a session listed both past and current once (#2969)", () => {
		store.recordAct("file owner/repo#9", "s-j9", sb.repo);
		const [l] = judgedByLedger([
			{ ...ended("j9"), sessionId: "s-j9", pastSessionIds: ["s-j9"] },
		]);
		expect(l.acts).toEqual({ file: 1 });
	});

	it("reads a session with an empty ledger as no progress, not unread", () => {
		const [l] = judgedByLedger([ended("j2")]);
		expect(l.acts).toEqual({});
		expect(buildFinishLine(l)).toBe(
			"finished design-vault /implement 2: no acts",
		);
	});

	it("judges a launch unread where its session id was never captured", () => {
		const [l] = judgedByLedger([ended("j3")], ["j3"]);
		expect(l).toMatchObject({ finishedAt: NOW, acts: "unread" });
		expect(buildFinishLine(l)).toBe(
			"finished design-vault /implement 3: unread",
		);
	});

	it.skipIf(AS_ROOT)(
		"judges a launch unread where no act read and a store would not",
		() => {
			store.recordAct("file owner/repo#5", "s-j4", sb.repo);
			const ledger = store.paths.actLedger("s-j4", sb.repo);
			fs.chmodSync(ledger, 0o000);
			try {
				const [l] = judgedByLedger([ended("j4")]);
				expect(l.acts).toBe("unread");
			} finally {
				fs.chmodSync(ledger, 0o644);
			}
		},
	);

	const decideOn = (history: Launch[]) =>
		decideTick({
			now: NOW,
			mode: "normal" as const,
			noProgressFrom: NOW - 60 * MIN,
			stopRequested: false,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 0,
			seats: [
				{
					seat: "s",
					week: 10,
					session: 10,
					weekFull: false,
					sessionFull: false,
					sessionResets: null,
					weekResets: null,
					readAt: NOW,
					weekRead: { percent: null, atMs: null },
					fits: 1,
				},
			],
			history,
			lastActAt: null,
		});

	/** Finishes in order, `j<n>` finishing at NOW - 10 + n, those in `idless`
	 * listed with no session id. */
	const finishes = (jobs: string[], idless: string[] = []) =>
		judgedByLedger(
			jobs.map((j) => ended(j)),
			idless,
		).map((l) => ({
			...l,
			finishedAt: NOW - 10 + Number(l.jobId?.slice(1)),
		}));

	it("pauses on three finishes with no act, an unread one between them passed over", () => {
		const history = finishes(["j1", "j2", "j3", "j4"], ["j2"]);
		expect(history.map((l) => l.acts)).toEqual([{}, "unread", {}, {}]);
		expect(decideOn(history)).toHaveProperty("pause.by", "no-progress");
	});

	it("does not pause on two finishes with no act beside an unread one", () => {
		const history = finishes(["j1", "j2", "j3"], ["j2"]);
		expect(history.map((l) => l.acts)).toEqual([{}, "unread", {}]);
		expect(decideOn(history)).not.toHaveProperty("pause");
	});

	it("does not stop where one of the three made an act", () => {
		store.recordAct("relabel owner/repo#3 takes:implement", "s-j3", sb.repo);
		expect(decideOn(finishes(["j1", "j2", "j3"]))).not.toHaveProperty("pause");
	});
});

describe("a seat's name (#3732)", () => {
	it("is a tilde path under the home, else the dir as it is", () => {
		expect(buildSeatName("/home/u/.claude2", "/home/u")).toBe("~/.claude2");
		expect(buildSeatName("/srv/seat", "/home/u")).toBe("/srv/seat");
	});
});

type Tick = Parameters<typeof settleTick>[0];
type Io = Parameters<typeof settleTick>[1];
const idle = (reason: string, detail = "") => ({
	launches: [],
	skipped: [],
	idle: { reason, detail },
	held: [],
	resumes: [],
});
function settleOnce(
	decision: Tick["decision"],
	freeSlots: number,
	probes: Tick["probes"],
	{
		dispatch = (batch) => ({
			launched: batch.map((l) => ({
				...l,
				jobId: "job",
				launchedAt: NOW,
				finishedAt: null,
			})),
			refused: [],
		}),
		readControl = () => ({
			control: {
				noProgressFrom: NOW,
				stopRequested: false,
				seats: [],
				scope: away([]),
			},
			damaged: null,
		}),
		read = null,
		writes = [],
		state = loopStateOf(null),
		past = [],
		seats = [],
		overflow = [],
		omitted = [],
		readOmitted,
		mode = "normal",
		updateState = stateFileFake(state, writes),
		awaySwitch,
	}: Partial<{
		updateState: Io["updateState"];
		dispatch: Io["launchBatch"];
		readControl: Io["readControl"];
		read: Tick["read"];
		writes: Tick["state"][];
		state: Tick["state"];
		past: Tick["judged"];
		seats: Tick["input"]["seats"];
		overflow: NonNullable<Tick["input"]["overflow"]>;
		omitted: string[];
		readOmitted: () => string[];
		mode: Tick["input"]["mode"];
		awaySwitch: Tick["away"];
	}> = {},
) {
	const lines: string[] = [];
	settleTick(
		{
			input: {
				now: NOW,
				mode,
				noProgressFrom: NOW,
				stopRequested: false,
				frontier: [],
				retroBundles: [],
				running: [],
				freeSlots,
				seats,
				overflow,
				history: past,
				lastActAt: null,
			},
			decision,
			state,
			judged: past,
			probes,
			read,
			probeBrokenRoots: [],
			...(awaySwitch ? { away: awaySwitch } : {}),
		},
		{
			readControl,
			launchBatch: dispatch,
			writePause: () => undefined,
			resumeHeld: (_resumes, launches) => ({
				launches,
				started: 0,
				waiting: false,
			}),
			runReview: (lastRunOn) => lastRunOn,
			updateState,
			readOmittedDirs: readOmitted ?? (() => omitted),
			log: (line) => lines.push(line),
			now: () => NOW,
		},
	);
	return { line: lines[0], lines, writes };
}
const logged = (...args: Parameters<typeof settleOnce>) =>
	settleOnce(...args).line;
/** The tick's own state write, past each batch it put on record first (#4180). */
const tickWrite = (writes: Tick["state"][]) => {
	const written = writes.find((w) => !w.launching && w.lastTick?.at === NOW);
	if (!written) throw new Error("the tick wrote no state of its own");
	return written;
};

it("refuses every batch behind a parked resume the re-read made wait, naming why (#3872)", () => {
	const member = (root: string, n: number) => ({
		root,
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: "/s",
		reason: "parked session's seat" as const,
	});
	const called: string[] = [];
	const reason = "admission's re-read finds no free slot";
	const { line } = settleOnce(
		{
			launches: [member("/a", 1), member("/b", 9)],
			skipped: [],
			idle: null,
			held: [],
			resumes: [],
		},
		2,
		[],
		{
			dispatch: ([l]) => {
				called.push(l.root);
				return {
					launched: [],
					refused: [{ launch: l, reason }],
					resumeRefused: reason,
				};
			},
		},
	);
	expect(called).toEqual(["/a"]);
	expect(line).toContain(`refused b /implement 9: ${reason}`);
});

describe("a batch on record before its dispatch (#4180)", () => {
	const member = (root: string, n: number) => ({
		root,
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: "/s",
		reason: "soonest reset" as const,
	});
	const decision = {
		launches: [member("/a", 1), member("/b", 9)],
		skipped: [],
		idle: null,
		held: [],
		resumes: [],
	};

	it("writes each batch in flight, with the launches before it, before the dispatcher runs, and none once the tick is written", () => {
		const writes: Tick["state"][] = [];
		const seenAtDispatch: number[] = [];
		settleOnce(decision, 2, [], {
			writes,
			dispatch: (batch) => {
				seenAtDispatch.push(writes.length);
				return {
					launched: batch.map((l) => ({
						...l,
						jobId: `job${l.issues[0]}`,
						launchedAt: NOW,
						finishedAt: null,
					})),
					refused: [],
				};
			},
		});
		expect(seenAtDispatch).toEqual([1, 2]);
		expect(writes[0].launching).toEqual({ at: NOW, batch: [member("/a", 1)] });
		expect(writes[0].launches).toEqual([]);
		expect(writes[1].launching).toEqual({ at: NOW, batch: [member("/b", 9)] });
		expect(writes[1].launches.map((l) => l.jobId)).toEqual(["job1"]);
		expect(writes[1].launchCount).toEqual({ from: NOW, count: 1 });
		expect(writes.at(-1)).not.toHaveProperty("launching");
		expect(writes.at(-1)?.launches.map((l) => l.jobId)).toEqual([
			"job1",
			"job9",
		]);
	});

	it("keeps a launch a launcher recorded mid-tick that the tick does not carry (#4232)", () => {
		const writes: Tick["state"][] = [];
		const updateState = stateFileFake(loopStateOf(null), writes);
		const adopted = loopStateOf({ launches: [record({ jobId: "adopted" })] })
			.launches[0];
		settleOnce(decision, 2, [], {
			writes,
			updateState,
			dispatch: (batch) => {
				updateState(launchRecorded(adopted));
				return {
					launched: batch.map((l) => ({
						...l,
						jobId: `job${l.issues[0]}`,
						launchedAt: NOW,
						finishedAt: null,
					})),
					refused: [],
				};
			},
		});
		expect(tickWrite(writes).launches.map((l) => l.jobId)).toEqual([
			"job1",
			"job9",
			"adopted",
		]);
	});

	it("reads a batch in flight back, and drops a malformed one", () => {
		const launching = { at: NOW, batch: [member("/a", 1)] };
		expect(loopStateOf({ launches: [], launching }).launching).toEqual(
			launching,
		);
		expect(
			loopStateOf({ launches: [], launching: { at: "x" } }),
		).not.toHaveProperty("launching");
	});

	it("tracks and counts the members a kill cut off that the adopter finds started, the batch gone", () => {
		const state = {
			...loopStateOf(null),
			launches: [],
			launchCount: { from: NOW - 1000, count: 2 },
			launching: { at: NOW, batch: [member("/a", 1)] },
		};
		const found = {
			...member("/a", 1),
			jobId: "j1",
			launchedAt: NOW,
			finishedAt: null,
		};
		const batches: unknown[] = [];
		const next = settleLaunching(state, (l) => {
			batches.push(l);
			return [found];
		});
		expect(batches).toEqual([state.launching]);
		expect(next.launches).toEqual([found]);
		expect(next.launchCount).toEqual({ from: NOW - 1000, count: 3 });
		expect(next).not.toHaveProperty("launching");
		const quiet = loopStateOf(null);
		expect(settleLaunching(quiet, () => [found])).toBe(quiet);
	});
});

describe("the first overflow launch's record (#3767)", () => {
	/* The overflow seat on the plan seat's dir, told apart by its key. */
	const key = "K2";
	/** When a past launch launched, unless it says otherwise. */
	const pastAt = NOW - 3_600_000;
	const planSeat = (dir: string, percent: number, weekFull: boolean) => ({
		seat: dir,
		week: percent,
		session: 0,
		weekFull,
		sessionFull: false,
		sessionResets: null,
		weekResets: null,
		readAt: NOW,
		weekRead: { percent, atMs: NOW - 120_000 },
		fits: null,
	});
	const settleOverflowLaunch = (
		launch: "overflow" | "plan" | null,
		past: {
			seat: string;
			reason?: string;
			keyVar?: string;
			launchedAt?: number;
			relaunchedAt?: number;
			movedAt?: number;
		}[],
		readOmitted?: () => string[],
		recordedAt?: number,
	) => {
		const writes: Tick["state"][] = [];
		const launches =
			launch === null
				? []
				: [
						{
							root: "/r/repo",
							issues: [1],
							prompt: "/implement 1",
							model: "opus" as const,
							seat: "/h/.claude2",
							...(launch === "overflow"
								? { keyVar: key, reason: "overflow" as const }
								: { reason: "soonest reset" as const }),
						},
					];
		const { lines } = settleOnce(
			{
				launches,
				skipped: [],
				idle: null,
				held: [],
				resumes: [],
			},
			1,
			[],
			{
				dispatch: ([l]) => ({
					launched: [
						{
							...l,
							jobId: "job",
							launchedAt: NOW,
							finishedAt: null,
						},
					],
					refused: [],
				}),
				past: past.map((l) => ({
					issues: [],
					launchedAt: pastAt,
					...l,
				})) as unknown as Tick["judged"],
				...(recordedAt === undefined
					? {}
					: {
							state: {
								...loopStateOf(null),
								overflowStart: {
									at: recordedAt,
									seat: "/h/.claude2",
									planSeats: [],
									omitted: [],
								},
							},
						}),
				writes,
				seats: [planSeat("/h/.claude2", 100, true)],
				overflow: [
					{
						seat: "/h/.claude2",
						keyVar: key,
						fits: 3,
						spentUntil: null,
						why: null,
					},
				],
				omitted: ["/h/.claude3"],
				readOmitted,
			},
		);
		return { start: tickWrite(writes)?.overflowStart, lines };
	};

	it("records each plan seat's reading and the omitted dirs", () => {
		expect(
			settleOverflowLaunch("overflow", [{ seat: "/h/.claude2" }]).start,
		).toEqual({
			at: NOW,
			seat: "/h/.claude2",
			keyVar: key,
			planSeats: [
				{
					seat: "/h/.claude2",
					percent: 100,
					weekReadAt: NOW - 120_000,
					weekFull: true,
				},
			],
			omitted: ["/h/.claude3"],
		});
	});

	it("records nothing on a second overflow launch or a plan-seat launch", () => {
		const second = settleOverflowLaunch(
			"overflow",
			[{ seat: "/h/.claude2", keyVar: key, reason: "overflow" }],
			undefined,
			pastAt,
		);
		expect(second.start?.at).toBe(pastAt);
		expect(second.lines.join("\n")).not.toContain("first overflow launch");
		expect(
			settleOverflowLaunch("plan", [{ seat: "/h/.claude2" }]).start,
		).toBeNull();
	});

	const movedAt = NOW - 600_000;
	const moved = {
		seat: "/h/.claude2",
		keyVar: key,
		reason: "moved from ~/.claude2",
		movedAt,
	};

	it("records a move onto a key a kill kept out of the tick that made it, dated at the move (#4257)", () => {
		expect(settleOverflowLaunch(null, [moved]).start).toMatchObject({
			at: movedAt,
			seat: "/h/.claude2",
		});
	});

	it("records nothing new on a move after a recorded start on a key (#4257)", () => {
		const { start, lines } = settleOverflowLaunch(
			null,
			[moved],
			undefined,
			pastAt,
		);
		expect(start?.at).toBe(pastAt);
		expect(lines.join("\n")).not.toContain("first overflow launch");
	});

	it("records nothing on an overflow launch after a move onto a key, though a plan-seat launch since holds a later place (#4257)", () => {
		const plan = { seat: "/h/.claude2", launchedAt: NOW - 1_800_000 };
		const { start, lines } = settleOverflowLaunch(
			"overflow",
			[moved, plan],
			undefined,
			movedAt,
		);
		expect(start?.at).toBe(movedAt);
		expect(lines.join("\n")).not.toContain("first overflow launch");
	});

	it("records nothing where a session already on a key resumes after a plan-seat launch (#4257)", () => {
		const plan = { seat: "/h/.claude2", launchedAt: pastAt + 60_000 };
		const resumed = {
			seat: "/h/.claude2",
			keyVar: key,
			reason: "overflow",
			relaunchedAt: NOW - 60_000,
		};
		const { lines } = settleOverflowLaunch(
			null,
			[resumed, plan],
			undefined,
			pastAt,
		);
		expect(lines.join("\n")).not.toContain("first overflow launch");
	});

	it("records nothing on an overflow launch whose recorded predecessor on a key has left the state (#4257)", () => {
		const plan = { seat: "/h/.claude2", launchedAt: pastAt - 60_000 };
		const { lines } = settleOverflowLaunch(
			"overflow",
			[plan],
			undefined,
			pastAt,
		);
		expect(lines.join("\n")).not.toContain("first overflow launch");
	});

	it("still writes the state where the credentials scan throws", () => {
		const { start, lines } = settleOverflowLaunch("overflow", [], () => {
			throw new Error("EACCES");
		});
		expect(start?.omitted).toEqual([]);
		expect(lines.join("\n")).toContain("credentials scan failed");
	});

	it("survives the state file's round trip", () => {
		const { start } = settleOverflowLaunch("overflow", []);
		expect(loopStateOf({ overflowStart: start }).overflowStart).toEqual(start);
		expect(
			loopStateOf({ overflowStart: { at: "x" } }).overflowStart,
		).toBeNull();
	});
});

describe("a tick's log line (#2362)", () => {
	it("names the free slots on an idle tick and each probed seat's outcome", () => {
		expect(logged(idle("no free slot"), 0, [])).toBe(
			"idle: no free slot (free slots: 0)",
		);
		expect(
			logged(idle("no plan has room right now"), 2, [
				{ seat: "/s2", outcome: "finished" },
				{ seat: "/s3", outcome: "failed (spawn claude ENOENT)" },
			]),
		).toBe(
			"idle: no plan has room right now (free slots: 2; probed /s2: finished, /s3: failed (spawn claude ENOENT))",
		);
	});

	it("names the 5-hour wait on an idle tick and in a dry run's summary (#2606)", () => {
		const d = decideTick({
			now: NOW,
			mode: "normal" as const,
			noProgressFrom: NOW - 60 * MIN,
			stopRequested: false,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 2,
			seats: [
				{
					...seat("/s1", 40, 100),
					sessionResets: "2026-10-18T14:00:00Z",
					fits: null,
				},
			],
			history: [],
			lastActAt: null,
		});
		const wait =
			"idle: the 5-hour bar is full on /s1 until its 5-hour reset 2026-10-18T14:00:00Z";
		expect(summaryOf(d)).toBe(wait);
		expect(logged(d, 2, [])).toBe(`${wait} (free slots: 2)`);
	});

	const skip = (number: number, why: string) => ({
		root: "/r/wfc",
		number,
		why,
	});

	it("names an idle tick's frontier read, its skips per reason and the first few (#2561)", () => {
		const decision = {
			launches: [],
			skipped: [
				skip(2463, "already running"),
				skip(2469, "parked"),
				skip(2470, "already running"),
				skip(2471, "takes:triage+implement"),
			],
			idle: { reason: "nothing launchable", detail: "" },
			held: [],
			resumes: [],
		};
		const writes: Parameters<typeof settleTick>[0]["state"][] = [];
		expect(
			logged(decision, 3, [], {
				read: { rows: 67, ms: 78_240, goal: null },
				writes,
			}),
		).toBe(
			"idle: nothing launchable (free slots: 3; frontier: 67 rows in 78.2 s; skipped 2 already running, 1 parked, 1 takes:triage+implement; first wfc #2463 already running, wfc #2469 parked, wfc #2470 already running)",
		);
		expect(writes[0].lastTick?.skipped).toEqual(decision.skipped);
	});

	it("keeps a frontier read's goal progress, finishes it, revives it, and holds it through a tick with no read (#3866)", () => {
		const member = { repo: "o/r", number: 2, title: "t" };
		const settled = (
			read: Tick["read"],
			goalProgress: Tick["state"]["goalProgress"],
		) => {
			const writes: Tick["state"][] = [];
			logged(idle("nothing launchable"), 3, [], {
				read,
				writes,
				state: { ...loopStateOf(null), goalProgress },
			});
			return writes[0].goalProgress;
		};
		const goal = (set: (typeof member)[]) => ({
			rows: 1,
			ms: 1,
			goal: { setAt: 7, set, takeable: 0, running: 0, complete: true },
		});
		const done = settled(goal([]), null);
		expect(done).toMatchObject({ setAt: 7, set: [], doneAt: NOW, readAt: NOW });
		expect(settled(null, done)).toEqual(done);
		expect(settled(goal([member]), done)).toMatchObject({
			set: [member],
			doneAt: null,
		});
		expect(settled({ rows: 1, ms: 1, goal: null }, done)).toBeNull();
	});

	describe("the tick's idle reason, the idle alarm's source (#3920)", () => {
		it("carries any reason decideTick gives through a state round trip", () => {
			const writes: Tick["state"][] = [];
			logged(idle("a stop no list names", "; and why"), 3, [], { writes });
			const { lastTick } = loopStateOf(JSON.parse(JSON.stringify(writes[0])));
			expect(lastTick?.idle).toEqual({
				reason: "a stop no list names",
				detail: "; and why",
			});
		});

		it("reads none where the tick launched", () => {
			const writes: Tick["state"][] = [];
			logged(
				{
					launches: [
						{
							root: "/r",
							issues: [1],
							prompt: "/implement 1",
							model: "opus",
							seat: "a",
							reason: "overflow" as const,
						},
					],
					skipped: [],
					idle: null,
					held: [],
					resumes: [],
				},
				3,
				[],
				{ writes },
			);
			expect(loopStateOf(tickWrite(writes)).lastTick?.idle).toBeNull();
		});

		it.each([
			["a state file written before it", undefined],
			["a bare string", "nothing launchable"],
			["a reason with no detail", { reason: "nothing launchable" }],
		])("reads none from %s", (_case, value) => {
			expect(
				loopStateOf({ lastTick: { at: NOW, summary: "s", idle: value } })
					.lastTick?.idle,
			).toBeNull();
		});
	});

	const held = skip(2469, "parked: its session's seat /s2 is full");
	const kept = { ...held, since: NOW - 60_000 };

	it("records a frontier-reading tick's holds, keeping the start of one held before and stamping a new one now (#3680)", () => {
		const fresh = skip(2470, "parked: its session's seat /s2 is full");
		const decision = {
			...idle("nothing launchable"),
			held: [held, fresh],
		};
		const writes: Tick["state"][] = [];
		const state = { ...loopStateOf(null), held: [kept] };
		logged(decision, 3, [], {
			read: { rows: 2, ms: 900, goal: null },
			writes,
			state,
		});
		expect(writes[0].held).toEqual([kept, { ...fresh, since: NOW }]);
	});

	const heldDecision = { ...idle("nothing launchable"), held: [held] };

	it("keeps a full-seat hold's start across an away tick, so its 2 days do not restart (#3850)", () => {
		const writes: Tick["state"][] = [];
		const state = { ...loopStateOf(null), held: [kept] };
		logged(heldDecision, 1, [], {
			mode: "away",
			read: { rows: 1, ms: 900, goal: null },
			writes,
			state,
		});
		expect(writes[0].held).toEqual([kept]);
	});

	it("counts a park this away tick stopped in the stored handed-off count (#3870)", () => {
		const writes: Tick["state"][] = [];
		const parked = {
			root: "/r",
			issues: [7],
			prompt: "/implement 7",
			seat: "/s",
			jobId: "job7",
			launchedAt: NOW - 60_000,
			finishedAt: null,
			parkStopped: NOW,
			parkedAway: true,
		};
		settleOnce(idle("nothing launchable"), 1, [], {
			mode: "away",
			awaySwitch: { since: 7, absentSeen: false },
			past: [parked, { ...parked, jobId: "job8", parkStopped: NOW - 1 }],
			writes,
		});
		expect(tickWrite(writes).handedOff).toEqual({ from: 7, count: 1 });
	});

	it("opens no hold on an away tick, as a seat's reset would launch nothing there (#2355)", () => {
		const writes: Tick["state"][] = [];
		logged(heldDecision, 1, [], {
			mode: "away",
			read: { rows: 1, ms: 900, goal: null },
			writes,
		});
		expect(writes[0].held).toEqual([]);
	});

	it("keeps the last holds across a tick that reads no frontier", () => {
		const writes: Tick["state"][] = [];
		const state = { ...loopStateOf(null), held: [kept] };
		logged(idle("no free slot"), 0, [], { state, writes });
		expect(writes[0].held).toEqual([kept]);
	});

	it("reads a stored hold with no start, or no skip, as none", () => {
		expect(
			loopStateOf({ held: [kept, held, { root: "/r/wfc", since: NOW }] }).held,
		).toEqual([kept]);
	});

	it("counts an idle tick's clash skips as one reason, and holds each from its first deferral (#4355)", () => {
		const decision = {
			launches: [],
			skipped: [
				skip(1, "clashes on a.js held by Implement 9"),
				skip(2, "clashes on b.js held by Implement 8"),
				skip(3, "parked"),
			],
			idle: { reason: "nothing launchable", detail: "" },
			held: [],
			resumes: [],
		};
		const writes: Parameters<typeof settleTick>[0]["state"][] = [];
		expect(
			logged(decision, 1, [], {
				read: { rows: 3, ms: 1000, goal: null },
				writes,
				state: {
					...loopStateOf(null),
					held: [
						{
							...skip(1, "clashes on a.js held by Implement 9"),
							since: NOW - 3_600_000,
						},
					],
				},
			}),
		).toBe(
			"idle: nothing launchable (free slots: 1; frontier: 3 rows in 1.0 s; skipped 2 on a clash, 1 parked; first wfc #1 clashes on a.js held by Implement 9, wfc #2 clashes on b.js held by Implement 8, wfc #3 parked)",
		);
		expect(tickWrite(writes).held).toEqual([
			{
				...skip(1, "clashes on a.js held by Implement 9"),
				since: NOW - 3_600_000,
			},
			{ ...skip(2, "clashes on b.js held by Implement 8"), since: NOW },
		]);
	});

	it("names a launching tick's clash deferrals (#4355)", () => {
		const decision = {
			launches: [
				{
					root: "/r/wfc",
					issues: [1],
					prompt: "/implement 1",
					model: "opus" as const,
					seat: "/s2",
					reason: "soonest reset" as const,
				},
			],
			skipped: [
				skip(4, "already running"),
				skip(2, "clashes on a.js with #1 launched this tick"),
			],
			idle: null,
			held: [],
			resumes: [],
		};
		expect(logged(decision, 2, [])).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset) (deferred 1 on a clash: wfc #2 clashes on a.js with #1 launched this tick)",
		);
	});

	it("names an empty frontier's read", () => {
		const none = {
			launches: [],
			skipped: [],
			idle: { reason: "nothing launchable", detail: "" },
			held: [],
			resumes: [],
		};
		expect(
			logged(none, 3, [], { read: { rows: 0, ms: 9100, goal: null } }),
		).toBe(
			"idle: nothing launchable (free slots: 3; frontier: 0 rows in 9.1 s)",
		);
	});

	it("leaves the slots off a launch, keeps its frontier read (#2677), and adds nothing to a stop", () => {
		const decision = {
			launches: [
				{
					root: "/r/wfc",
					issues: [1],
					prompt: "/implement 1",
					model: "opus" as const,
					seat: "/s2",
					reason: "soonest reset" as const,
				},
			],
			skipped: [],
			idle: null,
			held: [],
			resumes: [],
		};
		expect(logged(decision, 2, [])).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset)",
		);
		expect(logged(decision, 2, [{ seat: "/s2", outcome: "stopped" }])).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset) (probed /s2: stopped)",
		);
		expect(
			logged(decision, 2, [], { read: { rows: 4, ms: 212_400, goal: null } }),
		).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset) (frontier: 4 rows in 212.4 s)",
		);
		expect(
			logged({ stop: "explicit", detail: "stop was requested" }, 0, [
				{ seat: "/s2", outcome: "cached" },
			]),
		).toBe("stop: explicit — stop was requested");
	});

	const wfc = (n: number) => ({
		root: "/r/wfc",
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: "/s2",
		reason: "soonest reset" as const,
	});

	it("logs a member the dispatcher refused as refused, with its reason, never as a launch (#2500)", () => {
		const decision = {
			launches: [wfc(1), wfc(2)],
			skipped: [],
			idle: null,
			held: [],
			resumes: [],
		};
		const line = logged(decision, 2, [], {
			dispatch: ([a, b]) => ({
				launched: [{ ...a, jobId: "job1", launchedAt: NOW, finishedAt: null }],
				refused: [{ launch: b, reason: "slots 0 — HOLD: 1840 MB available" }],
			}),
		});
		expect(line).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset); refused wfc /implement 2: slots 0 — HOLD: 1840 MB available",
		);
		const none = logged({ ...decision, launches: [wfc(2)] }, 1, [], {
			dispatch: ([b]) => ({
				launched: [],
				refused: [{ launch: b, reason: "slots 0 — HOLD: x" }],
			}),
		});
		expect(none).toBe("refused wfc /implement 2: slots 0 — HOLD: x");
	});

	it("names the members a stop left undispatched, not as launches", () => {
		const decision = {
			launches: [wfc(1), { ...wfc(2), root: "/r/mh" }],
			skipped: [],
			idle: null,
			held: [],
			resumes: [],
		};
		let reads = 0;
		const line = logged(decision, 2, [], {
			readControl: () => ({
				control: {
					noProgressFrom: NOW,
					stopRequested: reads++ > 0,
					seats: [],
					scope: away([]),
				},
				damaged: null,
			}),
		});
		expect(line).toBe(
			"launch wfc /implement 1 on /s2 (soonest reset); not dispatched mh /implement 2: a stop or a pause landed first",
		);
	});

	it("reads the probe's stderr line, else names how its run failed", () => {
		expect(parseProbeOutcome("usage probe: stopped\n", null)).toBe("stopped");
		expect(
			parseProbeOutcome("noise\nusage probe: timed-out (120 s)\n", "exit 1"),
		).toBe("timed-out (120 s)");
		expect(parseProbeOutcome("", "exit null (spawnSync node ETIMEDOUT)")).toBe(
			"no outcome line, exit null (spawnSync node ETIMEDOUT)",
		);
	});
});

describe("the launches a tick keeps (#3621)", () => {
	const at = (n: number, over: Record<string, unknown> = {}) =>
		({
			root: WFC,
			issues: [n],
			prompt: `/implement ${n}`,
			seat: "/s",
			jobId: `job${n}`,
			launchedAt: n,
			finishedAt: n + 1,
			...over,
		}) as Launch;
	const history = (extra: Launch[]) => [
		...extra,
		...Array.from({ length: 50 }, (_, i) => at(100 + i)),
	];
	const kept = (past: Launch[]) =>
		settleOnce(idle("no free slot"), 0, [], { past }).writes[0].launches;

	describe("the launches-since-start count (#3889)", () => {
		const since = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				at(i, { launchedAt: NOW + i, finishedAt: NOW + i + 1 }),
			);
		const printed = (state: Tick["state"], noProgressFrom = NOW) =>
			buildStatusLines({
				seats: {
					readings: [],
					next: null,
					wait: "every seat is spent",
					passedOver: [],
					callerSeat: null,
				},
				now: NOW,
				control: {
					noProgressFrom,
					stopRequested: false,
					seats: [],
					scope: away([]),
				},
				state,
				pid: 123,
				served: [],
			}).find((line) => line.startsWith("launches:"));
		const settled = (
			state: Tick["state"],
			decision: Tick["decision"] = idle("no free slot"),
		) =>
			tickWrite(
				settleOnce(decision, 1, [], { state, past: state.launches }).writes,
			);

		it("prints the true count past what the trim keeps, across ticks and a launch", () => {
			const uncounted = loopStateOf({ launches: since(60) });
			const first = settled(uncounted);
			expect(first.launches).toHaveLength(50);
			expect(printed(first)).toContain("launches:  60 since");
			const second = settled(loopStateOf(JSON.parse(JSON.stringify(first))));
			expect(printed(second)).toContain("launches:  60 since");
			const launched = settled(second, {
				launches: [
					{
						root: "/r/wfc",
						issues: [5],
						prompt: "/implement 5",
						model: "opus" as const,
						seat: "/s",
						reason: "overflow" as const,
					},
				],
				skipped: [],
				idle: null,
				held: [],
				resumes: [],
			});
			expect(printed(launched)).toContain("launches:  61 since");
		});

		it("reads a state with no counter from its kept rows", () => {
			expect(printed(loopStateOf({ launches: since(3) }))).toContain(
				"launches:  3 since",
			);
		});

		it("counts from the kept rows again once the start moves", () => {
			const moved = settled(loopStateOf({ launches: since(60) }));
			expect(printed(moved, NOW + 55)).toContain("launches:  5 since");
		});
	});

	it("keeps the last 50 finished launches, an older park the loop stopped among those dropped (#3709)", () => {
		const parked = at(1, { parkStopped: 2 });
		const out = kept(history([parked, at(3)]));
		expect(out).toHaveLength(50);
		expect(out).not.toContain(parked);
	});

	it("keeps a live launch older than the last 50, in its place, and caps the finished at 50 (#3775)", () => {
		const live = at(1, { finishedAt: null });
		const out = kept(history([live, at(3)]));
		expect(out).toHaveLength(51);
		expect(out[0]).toBe(live);
		expect(out.filter((l) => l.finishedAt !== null)).toHaveLength(50);
	});

	it("ranks the finished by when they finished, so a long-held launch just finished stays (#3775)", () => {
		const late = at(1, { finishedAt: 1000 });
		const out = kept(history([late]));
		expect(out).toHaveLength(50);
		expect(out[0]).toBe(late);
	});

	it("keeps a ticket's unclosed launch past the 50, until a later launch of it supersedes it (#3782)", () => {
		const unclosed = at(1, { acts: { commit: 1 } });
		expect(kept(history([unclosed]))).toContain(unclosed);
		const superseded = kept(history([unclosed, at(1)]));
		expect(superseded).not.toContain(unclosed);
	});

	it("caps an unfinished launch with no job, which no tick can finish", () => {
		const jobless = at(1, { finishedAt: null, jobId: null });
		const out = kept(history([jobless]));
		expect(out).toHaveLength(50);
		expect(out).not.toContain(jobless);
	});
});

describe("the seats' probe stamps on the state file (#4060)", () => {
	it("parses the stamps off the state file, dropping what is no time", () => {
		expect(loopStateOf({ seatTriedAt: { a: 5, b: "x" } }).seatTriedAt).toEqual({
			a: 5,
		});
		expect(loopStateOf(null).seatTriedAt).toEqual({});
	});
});

describe("the free-slot count (#2500)", () => {
	it("charges what dispatch-sessions.sh's per-member re-read charges", () => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const reread = sh.match(/admission_args=\(([^)]*)\)/);
		expect(reread).not.toBeNull();
		expect(FREE_SLOT_ARGS).toEqual([
			"--json",
			...String(reread?.[1]).split(/\s+/),
			"--skip-allowance",
		]);
	});
});

describe("the control file", () => {
	it("reads a malformed file as no start", () => {
		expect(parseControl(null)).toBeNull();
		expect(parseControl({ noProgressFrom: "soon" })).toBeNull();
	});

	it("keeps only string seats and a literal true stop", () => {
		expect(
			parseControl({
				noProgressFrom: 5,
				stopRequested: "yes",
				seats: ["/a", 3],
			}),
		).toEqual({
			noProgressFrom: 5,
			stopRequested: false,
			seats: ["/a"],
			scope: away([]),
		});
	});

	it("reads a control from before pauses as a loop to carry on from (#3856)", () => {
		const raw = {
			noProgressFrom: 5,
			stopRequested: false,
			seats: ["/a"],
			scope: { mode: "normal", repos: ["/r"] },
		};
		const control = parseControl(raw);
		expect(control).toEqual({
			noProgressFrom: 5,
			stopRequested: false,
			seats: ["/a"],
			scope: normal(["/r"]),
		});
		expect(control).not.toHaveProperty("paused");
	});

	it("reads who paused and when, and a garbled pause as paused (#3856)", () => {
		const read = (paused: unknown) =>
			parseControl({ noProgressFrom: 5, paused })?.paused;
		expect(read({ by: "founder", at: 9 })).toEqual({ by: "founder", at: 9 });
		expect(read(null)).toBeUndefined();
		expect(read(true)).toEqual({ by: "an unreadable record", at: 0 });
	});

	it("reads a no-progress pause's issues, dropping a garbled one (#3859)", () => {
		const issue = { root: WFC, number: 9 };
		expect(
			parseControl({
				noProgressFrom: 5,
				paused: { by: "no-progress", at: 9, issues: [issue, "garbled"] },
			})?.paused,
		).toEqual({ by: "no-progress", at: 9, issues: [issue] });
	});

	it("reads a control with no scope as away mode serving nothing", () => {
		expect(parseControl({ noProgressFrom: 5 })?.scope).toEqual(away([]));
	});

	const goalOf = (goal: unknown) =>
		parseControl({
			noProgressFrom: 5,
			scope: { mode: "normal", repos: [], goal },
		})?.scope.goal;

	it("reads a goal as stored, a missing text and setAt defaulting (#3864)", () => {
		const refs = [{ repo: "a", number: 1 }];
		const goal = { form: "drain", text: "x", refs, setAt: 9 };
		expect(goalOf(goal)).toEqual(goal);
		expect(goalOf({ form: "issues", refs })).toEqual({
			form: "issues",
			text: "",
			refs,
			setAt: 0,
		});
	});

	it("reads a garbled goal as none, so the loop runs bare (#3864)", () => {
		for (const goal of [
			"soon",
			null,
			{ form: "wish", text: "x", refs: [{ repo: "a", number: 1 }] },
			{ form: "issues", text: "x", refs: [{ repo: "a" }] },
			{
				form: "issues",
				text: "x",
				refs: [{ repo: "a", number: 1 }, { repo: "a" }],
			},
		])
			expect(goalOf(goal)).toBeNull();
	});

	it("reads a control with no noProgressFrom as none", () => {
		expect(parseControl({ startedAt: 5 })).toBeNull();
	});

	it("lets a restart after the tick's read overtake its stop", () => {
		const restarted = {
			noProgressFrom: 20,
			stopRequested: false,
			seats: [],
			scope: away([]),
		};
		expect(isRestartedSince(restarted, 10)).toBe(true);
		expect(isRestartedSince({ ...restarted, stopRequested: true }, 10)).toBe(
			false,
		);
		expect(isRestartedSince(restarted, 20)).toBe(false);
		expect(isRestartedSince(null, 10)).toBe(false);
	});
});

describe("a stop landing mid-tick (#2126, #2286)", () => {
	const input = {
		now: 100,
		mode: "normal" as const,
		noProgressFrom: 10,
		stopRequested: false,
		frontier: [],
		retroBundles: [],
		running: [],
		freeSlots: 2,
		typedSeat: null,
		seats: [],
		history: [],
		lastActAt: null,
	} as Tick["input"];
	/* One repo per pick, so each is its own dispatcher call. */
	const pick = (n: number) => ({
		root: `/r/repo${n}`,
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: "/s",
		reason: "soonest reset" as const,
	});
	/**
	 * `stop` writes the stop to the control the tick re-reads; a `refused` pick
	 * is one the dispatcher launched nothing for.
	 */
	function settle({
		stopFirst = false,
		gone = false,
		damaged = false,
		refused = [] as number[],
		onLaunch = (_n: number, _stop: () => void, _pause: () => void): unknown =>
			undefined,
		onReview = (_stop: () => void): unknown => undefined,
	} = {}) {
		let stopWritten = stopFirst;
		const stop = () => {
			stopWritten = true;
		};
		let pauseWritten = false;
		const pause = () => {
			pauseWritten = true;
		};
		const dispatched: string[] = [];
		const writes: Tick["state"][] = [];
		const decision = {
			launches: [pick(1), pick(2)],
			skipped: [],
			idle: null,
			held: [],
			resumes: [],
		};
		const settled = settleTick(
			{
				input,
				decision,
				state: loopStateOf(null),
				judged: [],
				probes: [],
				read: null,
				probeBrokenRoots: [],
			},
			{
				readControl: () =>
					gone || damaged
						? {
								control: null,
								damaged: damaged ? "/r/control.json is damaged (bad)" : null,
							}
						: {
								control: {
									noProgressFrom: 10,
									stopRequested: stopWritten,
									...(pauseWritten
										? { paused: { by: "founder", at: 60 } }
										: {}),
									seats: [],
									scope: away([]),
								},
								damaged: null,
							},
				launchBatch: ([l]) => {
					const [n] = l.issues;
					dispatched.push(l.prompt);
					onLaunch(n, stop, pause);
					return refused.includes(n)
						? { launched: [], refused: [{ launch: l, reason: "refused" }] }
						: {
								launched: [
									{ ...l, jobId: `job${n}`, launchedAt: 50, finishedAt: null },
								],
								refused: [],
							};
				},
				writePause: () => undefined,
				resumeHeld: (_resumes, launches) => ({
					launches,
					started: 0,
					waiting: false,
				}),
				readOmittedDirs: () => [],
				runReview: (lastRunOn) => {
					onReview(stop);
					return lastRunOn;
				},
				updateState: stateFileFake(loopStateOf(null), writes),
				log: () => undefined,
				now: () => NOW,
			},
		);
		return {
			result: settled.decision,
			launched: settled.launched,
			decision,
			dispatched,
			state: writes.at(-1),
		};
	}
	const prompts = (state: Tick["state"] | undefined) =>
		state?.launches.map((l) => l.prompt);

	it("makes no further dispatch call once a stop lands during the first of two, and records the stop", () => {
		const r = settle({ onLaunch: (n, stop) => n === 1 && stop() });
		expect(r.dispatched).toEqual(["/implement 1"]);
		expect(prompts(r.state)).toEqual(["/implement 1"]);
		expect(r.state?.stopped).toMatchObject({ reason: "explicit" });
		expect(r.result).toMatchObject({ stop: "explicit" });
	});

	it("makes no further dispatch call once a pause lands during the first of two, and records no stop (#3856)", () => {
		const r = settle({ onLaunch: (n, _stop, pause) => n === 1 && pause() });
		expect(r.dispatched).toEqual(["/implement 1"]);
		expect(prompts(r.state)).toEqual(["/implement 1"]);
		expect(r.state?.stopped).toBeNull();
		expect(r.state?.lastTick?.summary).toContain(
			"not dispatched repo2 /implement 2: a stop or a pause landed first",
		);
		expect(r.result).toBe(r.decision);
	});

	it("still takes the morning review's step on a tick with no launch (#3856)", () => {
		const reviews: unknown[] = [];
		const paused = settleTick(
			{
				input: { ...input, paused: { by: "founder", at: 60 } },
				decision: {
					launches: [],
					skipped: [],
					idle: { reason: "paused by", detail: " founder" },
					held: [],
					resumes: [],
				},
				state: loopStateOf(null),
				judged: [],
				probes: [],
				read: null,
				probeBrokenRoots: [],
			},
			{
				readControl: () => ({ control: null, damaged: null }),
				launchBatch: () => ({ launched: [], refused: [] }),
				writePause: () => undefined,
				resumeHeld: (_resumes, launches) => ({
					launches,
					started: 0,
					waiting: false,
				}),
				readOmittedDirs: () => [],
				runReview: (lastRunOn) => {
					reviews.push(lastRunOn);
					return lastRunOn;
				},
				updateState: stateFileFake(loopStateOf(null), []),
				log: (line) => {
					expect(line).not.toContain("free slots");
				},
				now: () => NOW,
			},
		);
		expect(reviews).toHaveLength(1);
		expect(paused.launched).toBe(0);
	});

	it("records a stop written during the morning review the same way", () => {
		const r = settle({ onReview: (stop) => stop() });
		expect(r.dispatched).toEqual(["/implement 1", "/implement 2"]);
		expect(r.state?.stopped).toMatchObject({ reason: "explicit" });
		expect(r.result).toMatchObject({ stop: "explicit" });
	});

	it("launches every pick and records no stop where none is written, keeping only real launches", () => {
		const r = settle({ refused: [1] });
		expect(r.dispatched).toEqual(["/implement 1", "/implement 2"]);
		expect(prompts(r.state)).toEqual(["/implement 2"]);
		expect(r.state?.stopped).toBeNull();
		expect(r.result).toBe(r.decision);
		expect(r.launched).toBe(1);
	});

	it("launches nothing once a stop is written between the decision and the first launch", () => {
		const r = settle({ stopFirst: true });
		expect(r.dispatched).toEqual([]);
		expect(r.result).toMatchObject({ stop: "explicit" });
	});

	it("reads a control file gone missing mid-tick as a stop", () => {
		const r = settle({ gone: true });
		expect(r.dispatched).toEqual([]);
		expect(r.state?.stopped).toMatchObject({ reason: "explicit" });
	});

	it("records a control file damaged mid-tick as its own stop (#3389)", () => {
		const r = settle({ damaged: true });
		expect(r.dispatched).toEqual([]);
		expect(r.state?.stopped).toEqual({
			at: NOW,
			reason: "control-damaged",
			detail: "/r/control.json is damaged (bad)",
		});
	});
});

describe("the repos a tick serves", () => {
	it("serves exactly the ticked repos in either mode, dropping one that opted out", () => {
		const optedOut = (root: string) =>
			root === MH ? "refillLoop: false" : null;
		for (const scope of [normal([WFC, MH]), away([WFC, MH])])
			expect(scopeRoots(scope, optedOut)).toEqual({
				roots: [WFC],
				dropped: [{ root: MH, why: "refillLoop: false" }],
			});
	});
});

describe("unticking a repo its owner opted out (#4188)", () => {
	const control = {
		noProgressFrom: 1,
		stopRequested: false,
		seats: ["/s"],
		scope: normal([WFC, MH]),
	};

	it("drops the opted-out repo from the ticked set, keeping the rest", () => {
		expect(controlWithoutOptedOut(control, (r) => r === MH)).toEqual({
			control: { ...control, scope: normal([WFC]) },
			dropped: [MH],
		});
	});

	it("changes nothing where none opted out", () => {
		expect(controlWithoutOptedOut(control, () => false)).toBeNull();
	});
});

describe("the checkouts whose landing a tick supervises (#3284)", () => {
	it("adds each foreign root a launch ran in, finished or not, once", () => {
		const launches = [
			record({ root: DV }),
			record({ root: WFC }),
			record({ root: DV, finishedAt: NOW }),
		];
		expect(landingRoots([WFC, MH], launches)).toEqual([WFC, MH, DV]);
	});
});

describe("when a tick files the morning review (#2017)", () => {
	/* Local time, as isReviewRunDue reads the hour and date locally. */
	const at = (hour: number, minute = 0) => new Date(2026, 9, 19, hour, minute);

	it("runs on the first tick at or after 07:00, once that day", () => {
		expect(isReviewRunDue(at(6, 59), null)).toBe(false);
		expect(isReviewRunDue(at(7, 0), null)).toBe(true);
		expect(isReviewRunDue(at(7, 1), "2026-10-18")).toBe(true);
		expect(isReviewRunDue(at(7, 1), "2026-10-19")).toBe(false);
		expect(isReviewRunDue(at(23, 59), "2026-10-19")).toBe(false);
	});

	it("runs a loop started after 07:00 on its first tick", () => {
		expect(isReviewRunDue(at(15), "2026-10-18")).toBe(true);
	});

	const filing = {
		due: true,
		script: "file-morning-review.js",
		label: "morning review",
	};
	const answering = {
		due: false,
		script: "answer-review-reversals.js",
		label: "morning review reversals",
	};
	it.each([
		["on a due tick", at(12), null, filing],
		["once today's review is filed", at(12), "2026-10-19", answering],
		["before REVIEW_HOUR", at(3), null, answering],
	])("picks the review child %s (#3405, #3478)", (_, now, lastRunOn, run) => {
		expect(
			reviewStep({ lastRunOn, now, running: false, finished: null }).start,
		).toEqual({ ...run, today: "2026-10-19" });
	});

	it("records the day off a due run's status, never past a timeout or off a run not due", () => {
		const runOn = (status: number | null, due = true) =>
			reviewStep({
				lastRunOn: "2026-10-18",
				now: at(12),
				running: true,
				finished: {
					...(due ? filing : answering),
					today: "2026-10-19",
					status,
					out: "",
					failed: null,
				},
			}).runOn;
		expect(runOn(0)).toBe("2026-10-19");
		expect(runOn(2)).toBe("2026-10-19");
		expect(runOn(1)).toBe("2026-10-18");
		expect(runOn(null)).toBe("2026-10-18");
		expect(runOn(0, false)).toBe("2026-10-18");
	});

	it("logs a missing config once, on the due tick, and records it (#3604)", () => {
		const skip = (due: boolean) =>
			buildReviewSkip({
				due,
				root: "/repo",
				lastRunOn: "2026-10-18",
				today: "2026-10-19",
			});
		expect(skip(true)).toEqual({
			lines: ["morning review: not run, /repo has no workflow-core config"],
			runOn: "2026-10-19",
		});
		expect(skip(false)).toEqual({ lines: [], runOn: "2026-10-18" });
	});

	it.each([
		["a due run, quiet", true, { out: "" }, ["morning review: exit 0\n  "]],
		[
			"a not-due run with output",
			false,
			{ out: "answered #9\nanswered #10" },
			["morning review reversals: exit 0\n  answered #9\n  answered #10"],
		],
		[
			"a not-due run that failed",
			false,
			{ out: "", failed: "exit 1" },
			["morning review reversals: exit 1\n  "],
		],
		["a quiet not-due run", false, { out: "" }, []],
	])(
		"logs a finished run's line only where due, printed or failed: %s (#3604)",
		(_, due, ran, lines) => {
			expect(
				reviewStep({
					lastRunOn: null,
					now: at(12),
					running: true,
					finished: {
						...(due ? filing : answering),
						today: "2026-10-19",
						status: "failed" in ran ? 1 : 0,
						failed: null,
						...ran,
					},
				}).lines,
			).toEqual(lines);
		},
	);

	describe("the step a tick takes, its child detached (#3765)", () => {
		const today = "2026-10-19";
		const ran = (status: number | null) => ({
			...filing,
			today,
			status,
			out: "filed #900",
			failed: status === 0 ? null : `exit ${status}`,
		});

		it("starts no second run while one is running", () => {
			expect(
				reviewStep({
					lastRunOn: null,
					now: at(8),
					running: true,
					finished: null,
				}),
			).toEqual({ runOn: null, lines: [], start: null });
		});

		it("starts the filing on a due tick with none running", () => {
			expect(
				reviewStep({
					lastRunOn: "2026-10-18",
					now: at(8),
					running: false,
					finished: null,
				}),
			).toEqual({
				runOn: "2026-10-18",
				lines: [],
				start: { ...filing, today },
			});
		});

		it("records a finished filing's day, logs it, and starts only the reversals after it", () => {
			expect(
				reviewStep({
					lastRunOn: "2026-10-18",
					now: at(9),
					running: false,
					finished: ran(0),
				}),
			).toEqual({
				runOn: today,
				lines: ["morning review: exit 0\n  filed #900"],
				start: { ...answering, today },
			});
		});

		it("files again after a run that was killed, recording no day", () => {
			const step = reviewStep({
				lastRunOn: "2026-10-18",
				now: at(9),
				running: false,
				finished: ran(null),
			});
			expect(step.runOn).toBe("2026-10-18");
			expect(step.lines).toEqual(["morning review: exit null\n  filed #900"]);
			expect(step.start).toEqual({ ...filing, today });
		});
	});

	it("keeps the last run's date across a state round trip", () => {
		expect(loopStateOf({ reviewRunOn: "2026-10-19" }).reviewRunOn).toBe(
			"2026-10-19",
		);
		expect(loopStateOf({}).reviewRunOn).toBeNull();
	});
});

describe("a job that never started (#2467)", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-ghost-"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	const job = (id: string, sessionId: string, agedMinutes: number) => ({
		seat: path.join(home, ".claude2"),
		job: id,
		rec: {
			state: "working",
			sessionId,
			intent: "Reply with the single word ok.",
			createdAt: new Date(Date.now() - agedMinutes * MIN).toISOString(),
		},
	});

	function run(
		agents: Parameters<typeof stopNeverStarted>[0],
		jobs: Parameters<typeof stopNeverStarted>[1],
		failed: string | null = null,
	) {
		const stopped: string[] = [];
		const lines = stopNeverStarted(agents, jobs, (j) => {
			stopped.push(`${j.job} ${j.seat}`);
			return failed;
		});
		return { stopped, lines };
	}

	const live = { sessionId: "s-live", id: "live0001", pid: 4242 };
	const registry = (...agents: { sessionId: string; pid?: number }[]) => ({
		agents,
		faults: [],
		seats: [path.join(home, ".claude2")],
	});

	it("stops a working job with no live process and no transcript past the grace, and logs it", () => {
		const r = run(registry(live), [job("a02186db", "s-ghost", 31)]);
		expect(r.stopped).toEqual([`a02186db ${path.join(home, ".claude2")}`]);
		expect(r.lines).toEqual([
			expect.stringMatching(
				/^stopped never-started job a02186db on .*\.claude2 \(Reply with the single word ok\.; 31m, no pid, no transcript\)$/,
			),
		]);
	});

	it("logs a stop that failed with why", () => {
		const r = run(
			registry(live),
			[job("a02186db", "s-ghost", 31)],
			"exit 1, No job matching",
		);
		expect(r.lines[0]).toMatch(/^could not stop .*: exit 1, No job matching$/);
	});

	it("stops nothing while a seat's registry would not read, saying so (#2665)", () => {
		const r = run(
			{
				agents: [live],
				faults: ["/x/sessions would not read (EACCES)"],
				seats: [],
			},
			[job("a02186db", "s-ghost", 31)],
		);
		expect(r).toEqual({
			stopped: [],
			lines: [
				"never-started jobs unjudged: /x/sessions would not read (EACCES)",
			],
		});
	});

	it("never stops a job whose session is a live headless run (#2608)", () => {
		const headless = { sessionId: "s-ghost", pid: 4343, kind: "headless" };
		const r = run(registry(live, headless), [job("a02186db", "s-ghost", 31)]);
		expect(r.stopped).toEqual([]);
	});

	it("never judges a job on a seat with no registry to read", () => {
		const r = run({ ...registry(live), seats: [] }, [
			job("a02186db", "s-ghost", 31),
		]);
		expect(r).toEqual({ stopped: [], lines: [] });
	});

	it("stops nothing off an unread job store, saying so", () => {
		expect(run(registry(live), null)).toEqual({
			stopped: [],
			lines: ["never-started jobs unjudged: no job store would open"],
		});
	});

	it("never stops the job of the session it runs in", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "s-ghost");
		const r = run(registry(live), [job("a02186db", "s-ghost", 31)]);
		expect(r.stopped).toEqual([]);
	});

	it("leaves a job inside the grace, one with a live process, one not working, and one with a transcript", () => {
		const projects = path.join(home, ".claude", "projects", "p");
		fs.mkdirSync(projects, { recursive: true });
		fs.writeFileSync(path.join(projects, "s-spoke.jsonl"), "{}\n");
		const done = job("done0001", "s-done", 31);
		done.rec.state = "done";
		const r = run(registry(live), [
			job("young001", "s-young", 29),
			job("live0001", "s-live", 31),
			job("spoke001", "s-spoke", 31),
			done,
		]);
		expect(r).toEqual({ stopped: [], lines: [] });
	});
});

describe("the loop's resumes after a transient API stop (#2705)", () => {
	const block = (sub: import("./block-cause.js").ApiErrorKind) => ({
		cause: "API_ERROR" as const,
		sub,
		since: NOW - 2 * MIN,
	});
	const resuming = (over = {}): Launch =>
		record({ jobId: "p", parked: true, block: block("transient"), ...over });
	/** Resumes made, the last `ago` minutes back, the next due `dueIn`. */
	const tried = (tries: number, ago: number, dueIn: number, over = {}) => ({
		tries,
		triedAt: NOW - ago * MIN,
		nextAt: NOW + dueIn * MIN,
		...over,
	});
	const blocked = [agent("p", "blocked")];

	it("keeps an API_ERROR's kind on the block", () => {
		const [out] = judged([record({ jobId: "p" })], blocked, { sub: "auth" });
		expect(out?.block).toEqual({ cause: "API_ERROR", sub: "auth", since: NOW });
	});

	it("keeps a held launch unfinished, block and all, once its session ends", () => {
		const held = resuming({ resumes: tried(2, 10, 5, { heldAt: NOW - MIN }) });
		for (const agents of [[agent("p", "done")], []]) {
			const [out] = judged([held], agents);
			expect(out).toMatchObject({
				finishedAt: null,
				block: block("transient"),
			});
		}
	});

	it("judges finished a resuming launch whose session ended with no hold", () => {
		const [out] = judged(
			[resuming({ resumes: tried(1, 10, 5) })],
			[agent("p", "done")],
		);
		expect(out?.finishedAt).toBe(NOW);
	});

	it("drops the block, keeping the count, once the session works again", () => {
		const resumes = tried(3, 10, 5);
		const [out] = judged([resuming({ resumes })], [agent("p", "working")]);
		expect(out?.block).toBeUndefined();
		expect(out?.resumes).toEqual(resumes);
	});
});

describe("a resume the tick's step left held (#3855)", () => {
	const due = {
		jobId: "j1",
		seat: "a",
		root: "wfc",
		at: NOW - 60,
		line: "j1 held",
	};
	const launch = {
		root: "/r",
		issues: [5],
		prompt: "/implement 5",
		model: "opus" as const,
		seat: "a",
		reason: "soonest reset" as const,
	};
	const heldLaunch = {
		root: "/r",
		issues: [7],
		prompt: "/implement 7",
		seat: "a",
		jobId: "j1",
		launchedAt: NOW - 90,
		finishedAt: null,
		stepResume: {
			cause: "swapHeld" as const,
			at: NOW - 60,
			sessionId: "s1",
			cwd: "/r",
			tries: 0,
		},
	};
	const { stepResume: _, ...running } = heldLaunch;
	const startedAsCopy = {
		launches: [{ ...running, jobId: "j1-copy" }],
		started: 1,
		waiting: false,
	};
	const refused = { launches: [heldLaunch], started: 0, waiting: true };
	const settle = (
		resumed: typeof startedAsCopy | typeof refused,
		lateStop = false,
		{
			resumable = [due],
			capHeld,
		}: { resumable?: (typeof due)[]; capHeld?: (typeof due)[] } = {},
	) => {
		const lines: string[] = [];
		const launched: unknown[] = [];
		const writes: Tick["state"][] = [];
		const settled = settleTick(
			{
				input: {
					now: NOW,
					mode: "normal" as const,
					noProgressFrom: NOW,
					stopRequested: false,
					frontier: [],
					retroBundles: [],
					running: [],
					freeSlots: 2,
					seats: [],
					overflow: [],
					history: [],
					lastActAt: null,
					resumable,
				},
				decision: {
					launches: [launch],
					skipped: [],
					idle: null,
					held: [],
					resumes: [due],
					...(capHeld ? { capHeld } : {}),
				},
				state: loopStateOf(null),
				judged: [heldLaunch],
				probes: [],
				read: null,
				probeBrokenRoots: [],
			},
			{
				readControl: () => ({
					control: {
						noProgressFrom: NOW,
						stopRequested: lateStop && writes.length > 0,
						seats: [],
						scope: away([]),
					},
					damaged: null,
				}),
				launchBatch: (batch) => {
					launched.push(...batch);
					return { launched: [], refused: [] };
				},
				writePause: () => undefined,
				resumeHeld: () => resumed,
				runReview: (lastRunOn) => lastRunOn,
				updateState: stateFileFake(loopStateOf(null), writes),
				readOmittedDirs: () => [],
				log: (line) => lines.push(line),
				now: () => NOW,
			},
		);
		return { settled, launched, lines };
	};

	it("launches nothing ahead of one the re-read made wait", () => {
		const { launched, lines } = settle(refused);
		expect(launched).toEqual([]);
		expect(lines[0]).toMatch(/resumed 0 of 1 due/);
	});

	it("launches behind one that started", () => {
		expect(settle(startedAsCopy).launched).toEqual([launch]);
	});

	it("counts the resumes started of all due, and names each its seat's cap held (#3895, #3911)", () => {
		const seat2 = path.join(process.env.HOME || os.homedir(), "seat2");
		const onSeat2 = { ...due, jobId: "j2", seat: seat2, line: "j2 held" };
		const third = { ...due, jobId: "j3", line: "j3 held" };
		const { lines } = settle(startedAsCopy, false, {
			resumable: [due, onSeat2, third],
			capHeld: [onSeat2],
		});
		expect(lines).toContain(
			"not resuming j2 held, for a later tick: the cap on ~/seat2 has no fit left",
		);
		expect(lines.join("\n")).toMatch(/resumed 1 of 3 due/);
	});

	it("names on a late stop only what it left held", () => {
		const started = settle(startedAsCopy, true);
		expect(started.settled.decision).toMatchObject({ stop: "explicit" });
		expect(started.lines.join("\n")).not.toMatch(/left with a resume due/);
		const left = settle(refused, true);
		expect(left.lines.join("\n")).toMatch(/left with a resume due.*j1 held/);
	});
});
