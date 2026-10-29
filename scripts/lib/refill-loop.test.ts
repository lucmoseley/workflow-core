// @vitest-environment node
/*
 * The refill loop's pure readings (#2012) and the repos a tick serves
 * (#2123). No fixture
 * touches disk but the reads of dispatch-sessions.sh that pin the loop's copies
 * of its cap thresholds and cap-call flags to the script's, and the acts
 * ledgers the progress cases write in arbiter-testkit's sandbox.
 *
 * Loosen one and a working session can be judged finished and stop the run
 * for no progress, failover leave its order, a stop written mid-tick let the rest
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AS_ROOT, freshSandbox, store } from "./arbiter-testkit";
import { decideTick, FULL } from "./refill-decide.js";
import {
	actsOf,
	buildFinishLine,
	buildReviewRunLines,
	capArgs,
	ceilingsOf,
	FREE_SLOT_ARGS,
	isRenewedSince,
	isReviewRunDue,
	judgedLaunches,
	landingRoots,
	parseCapFits,
	parseControl,
	parseProbeOutcome,
	parseScope,
	parseState,
	readSizedSeats,
	reviewRunOf,
	reviewRunRecorded,
	reviewSkipOf,
	runningOf,
	scopeRoots,
	seatReadingOf,
	settleTick,
	stopNeverStarted,
	summaryOf,
	trimmed,
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
	WFC,
} from "./refill-loop-fixture";

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

	const stopOn = (history: Launch[]) =>
		decideTick({
			now: NOW,
			mode: "normal" as const,
			startedAt: NOW - 60 * MIN,
			stopRequested: false,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 0,
			lastPromptAt: null,
			seats: [
				{
					seat: "s",
					week: 10,
					session: 10,
					weekFull: false,
					sessionFull: false,
					sessionResets: null,
					fits: 1,
				},
			],
			history,
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

	it("stops on three finishes with no act, an unread one between them passed over", () => {
		const history = finishes(["j1", "j2", "j3", "j4"], ["j2"]);
		expect(history.map((l) => l.acts)).toEqual([{}, "unread", {}, {}]);
		expect(stopOn(history)).toMatchObject({ stop: "no-progress" });
	});

	it("does not stop on two finishes with no act beside an unread one", () => {
		const history = finishes(["j1", "j2", "j3"], ["j2"]);
		expect(history.map((l) => l.acts)).toEqual([{}, "unread", {}]);
		expect(stopOn(history)).not.toHaveProperty("stop");
	});

	it("does not stop where one of the three made an act", () => {
		store.recordAct("relabel owner/repo#3 takes:implement", "s-j3", sb.repo);
		expect(stopOn(finishes(["j1", "j2", "j3"]))).not.toHaveProperty("stop");
	});
});

const seat = (name: string, week: number | null, session: number | null) => ({
	seat: name,
	week,
	session,
	weekFull: week !== null && week >= FULL,
	sessionFull: session !== null && session >= FULL,
	sessionResets: null,
});

describe("a seat's reading (#2606)", () => {
	const bar = (
		percent: number | null,
		trust: "fresh" | "stale" | "absent",
		resetsAt: string | null,
	) => ({ percent, trust, resetsAt, severity: null, fetchedAtMs: null });
	const Ahead = "2026-10-20T00:00:00Z";
	const Passed = "2026-10-18T11:00:00Z";
	const readOn = (
		session: ReturnType<typeof bar>,
		week: ReturnType<typeof bar>,
	) => seatReadingOf("s", { session, weekly_all: week }, NOW);
	const read = (week: ReturnType<typeof bar>) =>
		readOn(bar(30, "stale", Ahead), week);

	it("is weekly-full on a fresh 100% week", () => {
		expect(read(bar(100, "fresh", Ahead))).toMatchObject({
			week: 100,
			weekFull: true,
		});
	});

	it("is weekly-full on a cached 100% week whose reset is ahead, the bar still unread", () => {
		expect(read(bar(100, "stale", Ahead))).toEqual({
			seat: "s",
			week: null,
			session: null,
			weekFull: true,
			sessionFull: false,
			sessionResets: null,
		});
	});

	it("is unread, not weekly-full, on a cached 100% whose reset has passed or will not parse", () => {
		expect(read(bar(100, "stale", Passed)).weekFull).toBe(false);
		expect(read(bar(100, "stale", null)).weekFull).toBe(false);
		expect(read(bar(99, "stale", Ahead)).weekFull).toBe(false);
		expect(read(bar(null, "absent", null)).weekFull).toBe(false);
	});

	it("carries a full 5-hour bar's reset, fresh or cached with the reset ahead", () => {
		const week = bar(40, "fresh", Ahead);
		expect(readOn(bar(100, "fresh", "3pm"), week)).toMatchObject({
			session: 100,
			sessionFull: true,
			sessionResets: "3pm",
		});
		expect(readOn(bar(100, "stale", Ahead), week)).toMatchObject({
			session: null,
			sessionFull: true,
			sessionResets: Ahead,
		});
		expect(readOn(bar(100, "stale", Passed), week)).toMatchObject({
			session: null,
			sessionFull: false,
			sessionResets: null,
		});
	});

	describe("through decideTick", () => {
		const tickOn = (
			session: ReturnType<typeof bar>,
			week: ReturnType<typeof bar>,
		) =>
			decideTick({
				now: NOW,
				mode: "normal" as const,
				startedAt: NOW - 60 * MIN,
				stopRequested: false,
				frontier: [],
				retroBundles: [],
				running: [],
				freeSlots: 2,
				lastPromptAt: null,
				seats: [{ ...readOn(session, week), fits: null }],
				history: [],
			});

		it("stops on a locked seat's cached 100% week whose reset is ahead", () => {
			expect(
				tickOn(bar(30, "stale", Ahead), bar(100, "stale", Ahead)),
			).toMatchObject({ stop: "allowance" });
		});

		it("waits, unread, on a cached 100% week whose reset has passed", () => {
			expect(
				tickOn(bar(30, "stale", Ahead), bar(100, "stale", Passed)),
			).toMatchObject({ idle: "no seat has a fresh allowance reading" });
		});

		it("names a locked seat's cached 5-hour wait and its reset", () => {
			expect(
				tickOn(bar(100, "stale", Ahead), bar(40, "stale", Ahead)),
			).toMatchObject({
				idle: `the 5-hour bar is full on s until its 5-hour reset ${Ahead}`,
			});
		});
	});
});

/**
 * readSizedSeats over readings no probe changes, with the seats each probe
 * was asked to refresh.
 */
function sizedRead(
	readings: ReturnType<typeof seat>[],
	slots: number,
	sizeOf: (s: string, members: number) => number | null,
) {
	const probed: string[][] = [];
	const { seats } = readSizedSeats(slots, {
		read: () => readings,
		probe: (stale: string[]) => {
			probed.push(stale);
			return { usage: new Map(stale.map((s) => [s, ""])), probes: [] };
		},
		sizeOf,
	});
	return { probed, seats };
}

describe("which seats are refreshed", () => {
	const probedOn = (readings: ReturnType<typeof seat>[]) =>
		sizedRead(readings, 2, () => 1).probed;

	it("refreshes a stale seat ahead of a fresh one, so failover keeps order", () => {
		expect(probedOn([seat("a", null, null), seat("b", 10, 10)])).toEqual([
			["a"],
		]);
	});

	it("reads a stale seat behind a full one rather than waiting on it", () => {
		expect(probedOn([seat("a", 100, 10), seat("b", null, 5)])).toEqual([["b"]]);
	});

	it("refreshes nothing past a seat past the cap's threshold but under 100% (#2278)", () => {
		expect(probedOn([seat("a", 98, 10), seat("b", null, null)])).toEqual([]);
	});

	it("passes a seat full on a cached bar unread (#2606)", () => {
		expect(
			probedOn([
				{ ...seat("a", null, null), weekFull: true },
				{ ...seat("b", null, null), sessionFull: true },
				seat("c", null, null),
			]),
		).toEqual([["c"]]);
	});
});

describe("a tick's log line (#2362)", () => {
	type Tick = Parameters<typeof settleTick>[0];
	type Io = Parameters<typeof settleTick>[1];
	const idle = (why: string) => ({
		launches: [],
		skipped: [],
		idle: why,
		held: [],
	});
	function logged(
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
					startedAt: NOW,
					stopRequested: false,
					seats: [],
					scope: away([]),
				},
				damaged: null,
			}),
			read = null,
			writes = [],
			state = parseState(null),
		}: Partial<{
			dispatch: Io["launchBatch"];
			readControl: Io["readControl"];
			read: Tick["read"];
			writes: Tick["state"][];
			state: Tick["state"];
		}> = {},
	) {
		const lines: string[] = [];
		settleTick(
			{
				input: {
					now: NOW,
					mode: "normal" as const,
					startedAt: NOW,
					stopRequested: false,
					frontier: [],
					retroBundles: [],
					running: [],
					freeSlots,
					lastPromptAt: null,
					seats: [],
					history: [],
				},
				decision,
				state,
				judged: [],
				probes,
				read,
			},
			{
				readControl,
				launchBatch: dispatch,
				runReview: (lastRunOn) => lastRunOn,
				writeState: (next) => writes.push(next),
				log: (line) => lines.push(line),
				now: () => NOW,
			},
		);
		return lines[0];
	}

	it("names the free slots on an idle tick and each probed seat's outcome", () => {
		expect(logged(idle("no free slot"), 0, [])).toBe(
			"idle: no free slot (free slots: 0)",
		);
		expect(
			logged(idle("no seat has a fresh allowance reading"), 2, [
				{ seat: "/s2", outcome: "finished" },
				{ seat: "/s3", outcome: "failed (spawn claude ENOENT)" },
			]),
		).toBe(
			"idle: no seat has a fresh allowance reading (free slots: 2; probed /s2: finished, /s3: failed (spawn claude ENOENT))",
		);
	});

	it("names the 5-hour wait on an idle tick and in a dry run's summary (#2606)", () => {
		const d = decideTick({
			now: NOW,
			mode: "normal" as const,
			startedAt: NOW - 60 * MIN,
			stopRequested: false,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 2,
			lastPromptAt: null,
			seats: [
				{
					...seat("/s1", 40, 100),
					sessionResets: "2026-10-18T14:00:00Z",
					fits: null,
				},
			],
			history: [],
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
			idle: "nothing launchable",
			held: [],
		};
		const writes: Parameters<typeof settleTick>[0]["state"][] = [];
		expect(
			logged(decision, 3, [], { read: { rows: 67, ms: 78_240 }, writes }),
		).toBe(
			"idle: nothing launchable (free slots: 3; frontier: 67 rows in 78.2 s; skipped 2 already running, 1 parked, 1 takes:triage+implement; first wfc #2463 already running, wfc #2469 parked, wfc #2470 already running)",
		);
		expect(writes[0].lastTick?.skipped).toEqual(decision.skipped);
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
		const state = { ...parseState(null), held: [kept] };
		logged(decision, 3, [], { read: { rows: 2, ms: 900 }, writes, state });
		expect(writes[0].held).toEqual([kept, { ...fresh, since: NOW }]);
	});

	it("keeps the last holds across a tick that reads no frontier", () => {
		const writes: Tick["state"][] = [];
		const state = { ...parseState(null), held: [kept] };
		logged(idle("no free slot"), 0, [], { state, writes });
		expect(writes[0].held).toEqual([kept]);
	});

	it("reads a stored hold with no start, or no skip, as none", () => {
		expect(
			parseState({ held: [kept, held, { root: "/r/wfc", since: NOW }] }).held,
		).toEqual([kept]);
	});

	it("names an empty frontier's read", () => {
		const none = {
			launches: [],
			skipped: [],
			idle: "nothing launchable",
			held: [],
		};
		expect(logged(none, 3, [], { read: { rows: 0, ms: 9100 } })).toBe(
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
				},
			],
			skipped: [],
			idle: null,
			held: [],
		};
		expect(logged(decision, 2, [])).toBe("launch wfc /implement 1");
		expect(logged(decision, 2, [{ seat: "/s2", outcome: "stopped" }])).toBe(
			"launch wfc /implement 1 (probed /s2: stopped)",
		);
		expect(logged(decision, 2, [], { read: { rows: 4, ms: 212_400 } })).toBe(
			"launch wfc /implement 1 (frontier: 4 rows in 212.4 s)",
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
	});

	it("logs a member the dispatcher refused as refused, with its reason, never as a launch (#2500)", () => {
		const decision = {
			launches: [wfc(1), wfc(2)],
			skipped: [],
			idle: null,
			held: [],
		};
		const line = logged(decision, 2, [], {
			dispatch: ([a, b]) => ({
				launched: [{ ...a, jobId: "job1", launchedAt: NOW, finishedAt: null }],
				refused: [{ launch: b, reason: "slots 0 — HOLD: 1840 MB available" }],
			}),
		});
		expect(line).toBe(
			"launch wfc /implement 1; refused wfc /implement 2: slots 0 — HOLD: 1840 MB available",
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
		};
		let reads = 0;
		const line = logged(decision, 2, [], {
			readControl: () => ({
				control: {
					startedAt: NOW,
					stopRequested: reads++ > 0,
					seats: [],
					scope: away([]),
				},
				damaged: null,
			}),
		});
		expect(line).toBe(
			"launch wfc /implement 1; not dispatched mh /implement 2: a stop landed first",
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

describe("which seats the cap is sized on (#2278)", () => {
	const sizer = (answers: Record<string, number | null>) => {
		const asked: string[] = [];
		const sizeOf = (s: string, members: number) => {
			asked.push(`${s}:${members}`);
			return answers[s] ?? null;
		};
		return { asked, sizeOf };
	};

	it("sizes seats with room in order up to the first that sizes", () => {
		const { asked, sizeOf } = sizer({ b: 1, c: 2 });
		const out = sizedRead(
			[seat("a", 100, 10), seat("b", 98, 10), seat("c", 10, 10)],
			3,
			sizeOf,
		).seats;
		expect(asked).toEqual(["b:3"]);
		expect(out.map((s: { fits: number | null }) => s.fits)).toEqual([
			null,
			1,
			null,
		]);
	});

	it("falls through a seat the cap sizes 0 to the next with room (#2432)", () => {
		const { asked, sizeOf } = sizer({ a: 0, b: 2 });
		const out = sizedRead(
			[seat("a", 98, 10), seat("b", 10, 10), seat("c", 10, 10)],
			2,
			sizeOf,
		).seats;
		expect(asked).toEqual(["a:2", "b:2"]);
		expect(out.map((s: { fits: number | null }) => s.fits)).toEqual([
			0,
			2,
			null,
		]);
	});

	it("moves past a seat whose cap cannot be sized", () => {
		const { asked, sizeOf } = sizer({ b: 2 });
		sizedRead([seat("a", 98, 10), seat("b", 10, 10)], 2, sizeOf);
		expect(asked).toEqual(["a:2", "b:2"]);
	});

	it("sizes nothing with no slot free", () => {
		const { asked, sizeOf } = sizer({ a: 1 });
		const out = sizedRead([seat("a", 98, 10)], 0, sizeOf).seats;
		expect(asked).toEqual([]);
		expect(out[0].fits).toBe(0);
	});
});

describe("a tick's seat read past a seat sized 0 (#2432)", () => {
	/* Seat a reads 98% of the week and sizes 0; seat b is stale until probed,
	 * reading 10% then (or still stale, where its probe fails) and sizing 2. */
	function io(probeReads = true) {
		const probed: string[][] = [];
		const asked: string[] = [];
		return {
			probed,
			asked,
			read: (usage: Map<string, string>) => [
				seat("a", 98, 10),
				probeReads && usage.has("b")
					? seat("b", 10, 10)
					: seat("b", null, null),
			],
			probe: (seats: string[]) => {
				probed.push(seats);
				return {
					usage: new Map(seats.map((s) => [s, ""])),
					probes: seats.map((s) => ({ seat: s, outcome: "refreshed" })),
				};
			},
			sizeOf: (s: string, members: number) => {
				asked.push(`${s}:${members}`);
				return s === "a" ? 0 : 2;
			},
		};
	}

	it("probes the stale seat behind it once and sizes each seat once", () => {
		const fake = io();
		const out = readSizedSeats(2, fake);
		expect(fake.probed).toEqual([["b"]]);
		expect(fake.asked).toEqual(["a:2", "b:2"]);
		expect(out.seats.map((s: { fits: number | null }) => s.fits)).toEqual([
			0, 2,
		]);
		expect(out.probes).toEqual([{ seat: "b", outcome: "refreshed" }]);
	});

	it("probes a seat whose probe fails no second time", () => {
		const fake = io(false);
		const out = readSizedSeats(2, fake);
		expect(fake.probed).toEqual([["b"]]);
		expect(out.seats[1]).toMatchObject({ week: null, fits: null });
	});

	it("probes and sizes nothing with no slot free", () => {
		const fake = io();
		readSizedSeats(0, fake);
		expect(fake.probed).toEqual([]);
		expect(fake.asked).toEqual([]);
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

describe("the cap's launch count (#2278)", () => {
	it("passes the flags dispatch-sessions.sh's cap call passes", () => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const call = sh.match(/allowance\.js" --json \\\n\s*(--cap[\s\S]*?) 2>/);
		const flags = (args: string[]) => args.filter((a) => a.startsWith("--"));
		expect(call).not.toBeNull();
		expect(
			flags(capArgs("s", 2, { week: 97, session: 90 })).filter(
				(f) => f !== "--config-dir",
			),
		).toEqual(["--json", ...flags(String(call?.[1]).split(/[\s\\]+/))]);
	});

	it("reads cap.launch from allowance.js's payload", () => {
		expect(parseCapFits(JSON.stringify({ cap: { launch: 2 } }))).toEqual({
			fits: 2,
		});
	});

	it("reads a launch that is the floor's member alone as 0 (#2432)", () => {
		expect(
			parseCapFits(JSON.stringify({ cap: { launch: 1, floored: true } })),
		).toEqual({ fits: 0 });
	});

	it.each([
		["no JSON", "oops", "printed no JSON", true],
		[
			"no cap, the reading untrusted",
			"{}",
			"no trustworthy allowance reading",
			false,
		],
		[
			"a cap error",
			JSON.stringify({ cap: { launch: 0, error: "cost table unreadable" } }),
			"cost table unreadable",
			true,
		],
	])(
		"reads %s as unsized, naming why and whether a fault (#2937)",
		(_, stdout, why, fault) => {
			expect(parseCapFits(stdout)).toEqual({
				fits: null,
				why: expect.stringContaining(why),
				fault,
			});
		},
	);
});

describe("dispatch's cap thresholds", () => {
	it("defaults to the figures dispatch-sessions.sh defaults to", () => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const week = sh.match(
			/WEEK_CEILING="\$\{WFC_DISPATCH_WEEK_CEILING:-(\d+)\}"/,
		);
		const session = sh.match(
			/SESSION_CEILING="\$\{WFC_DISPATCH_SESSION_CEILING:-(\d+)\}"/,
		);
		expect(ceilingsOf({})).toEqual({
			week: Number(week?.[1]),
			session: Number(session?.[1]),
		});
	});

	it("reads the variables dispatch-sessions.sh reads", () => {
		expect(
			ceilingsOf({
				WFC_DISPATCH_WEEK_CEILING: "80",
				WFC_DISPATCH_SESSION_CEILING: "70",
			}),
		).toEqual({ week: 80, session: 70 });
	});
});

describe("the control file", () => {
	it("reads a malformed file as no start", () => {
		expect(parseControl(null)).toBeNull();
		expect(parseControl({ startedAt: "soon" })).toBeNull();
	});

	it("keeps only string seats and a literal true stop", () => {
		expect(
			parseControl({ startedAt: 5, stopRequested: "yes", seats: ["/a", 3] }),
		).toEqual({
			startedAt: 5,
			stopRequested: false,
			seats: ["/a"],
			scope: away([]),
		});
	});

	it("reads a control from before scopes as away mode over every repo", () => {
		expect(parseControl({ startedAt: 5 })?.scope).toEqual(away([]));
	});

	it("keeps a normal scope's repos and only whole-number goals", () => {
		expect(
			parseScope({
				mode: "normal",
				repos: [WFC, 7],
				goals: { [WFC]: [1, "2", 3.5], [MH]: [] },
			}),
		).toEqual(normal([WFC], { [WFC]: [1] }));
	});

	it("lets a renewal after the tick's read overtake its stop", () => {
		const renewed = {
			startedAt: 20,
			stopRequested: false,
			seats: [],
			scope: away([]),
		};
		expect(isRenewedSince(renewed, 10)).toBe(true);
		expect(isRenewedSince({ ...renewed, stopRequested: true }, 10)).toBe(false);
		expect(isRenewedSince(renewed, 20)).toBe(false);
		expect(isRenewedSince(null, 10)).toBe(false);
	});
});

describe("a stop landing mid-tick (#2126, #2286)", () => {
	type Tick = Parameters<typeof settleTick>[0];
	const input = {
		now: 100,
		mode: "normal" as const,
		startedAt: 10,
		stopRequested: false,
		frontier: [],
		retroBundles: [],
		running: [],
		freeSlots: 2,
		lastPromptAt: null,
		seats: [],
		history: [],
	} as Tick["input"];
	/* One repo per pick, so each is its own dispatcher call. */
	const pick = (n: number) => ({
		root: `/r/repo${n}`,
		issues: [n],
		prompt: `/implement ${n}`,
		model: "opus" as const,
		seat: "/s",
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
		onLaunch = (_n: number, _stop: () => void): unknown => undefined,
		onReview = (_stop: () => void): unknown => undefined,
	} = {}) {
		let stopWritten = stopFirst;
		const stop = () => {
			stopWritten = true;
		};
		const dispatched: string[] = [];
		const writes: Tick["state"][] = [];
		const decision = {
			launches: [pick(1), pick(2)],
			skipped: [],
			idle: null,
			held: [],
		};
		const result = settleTick(
			{
				input,
				decision,
				state: parseState(null),
				judged: [],
				probes: [],
				read: null,
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
									startedAt: 10,
									stopRequested: stopWritten,
									seats: [],
									scope: away([]),
								},
								damaged: null,
							},
				launchBatch: ([l]) => {
					const [n] = l.issues;
					dispatched.push(l.prompt);
					onLaunch(n, stop);
					return refused.includes(n)
						? { launched: [], refused: [{ launch: l, reason: "refused" }] }
						: {
								launched: [
									{ ...l, jobId: `job${n}`, launchedAt: 50, finishedAt: null },
								],
								refused: [],
							};
				},
				runReview: (lastRunOn) => {
					onReview(stop);
					return lastRunOn;
				},
				writeState: (s) => writes.push(s),
				log: () => undefined,
				now: () => NOW,
			},
		);
		return { result, decision, dispatched, state: writes.at(-1) };
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
	const included = () => [WFC, MH, DV];

	it("serves every included repo but the excluded in away mode", () => {
		expect(scopeRoots(away([MH]), included, () => null)).toEqual({
			roots: [WFC, DV],
			dropped: [],
		});
	});

	it("serves only a normal scope's repos, dropping one that opted out", () => {
		const optedOut = (root: string) =>
			root === MH ? "refillLoop: false" : null;
		expect(scopeRoots(normal([WFC, MH]), included, optedOut)).toEqual({
			roots: [WFC],
			dropped: [{ root: MH, why: "refillLoop: false" }],
		});
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
		expect(reviewRunOf(now, lastRunOn)).toEqual(run);
	});

	it("records the day off a due tick's review status, never past a timeout or on a tick not due", () => {
		const run = (status: number | null, due = true) =>
			reviewRunRecorded({
				due,
				status,
				lastRunOn: "2026-10-18",
				today: "2026-10-19",
			});
		expect(run(0)).toBe("2026-10-19");
		expect(run(2)).toBe("2026-10-19");
		expect(run(1)).toBe("2026-10-18");
		expect(run(null)).toBe("2026-10-18");
		expect(run(0, false)).toBe("2026-10-18");
	});

	it("logs a missing config once, on the due tick, and records it (#3604)", () => {
		const skip = (due: boolean) =>
			reviewSkipOf({
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
		["a due tick, quiet", true, { out: "" }, ["morning review: exit 0\n  "]],
		[
			"a not-due tick with output",
			false,
			{ out: "answered #9\nanswered #10" },
			["morning review reversals: exit 0\n  answered #9\n  answered #10"],
		],
		[
			"a not-due tick that failed",
			false,
			{ out: "", failed: "exit 1" },
			["morning review reversals: exit 1\n  "],
		],
		["a quiet not-due tick", false, { out: "" }, []],
	])(
		"logs the review child's line only where due, printed or failed: %s (#3604)",
		(_, due, ran, lines) => {
			expect(buildReviewRunLines(due ? filing : answering, ran)).toEqual(lines);
		},
	);

	it("keeps the last run's date across a state round trip", () => {
		expect(parseState({ reviewRunOn: "2026-10-19" }).reviewRunOn).toBe(
			"2026-10-19",
		);
		expect(parseState({}).reviewRunOn).toBeNull();
	});
});

describe("a job that never started (#2467)", () => {
	let home: string;
	const saved = process.env.CLAUDE_CONFIG_DIR;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-ghost-"));
		process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved;
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
		const ownSession = process.env.CLAUDE_CODE_SESSION_ID;
		process.env.CLAUDE_CODE_SESSION_ID = "s-ghost";
		try {
			const r = run(registry(live), [job("a02186db", "s-ghost", 31)]);
			expect(r.stopped).toEqual([]);
		} finally {
			if (ownSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
			else process.env.CLAUDE_CODE_SESSION_ID = ownSession;
		}
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

describe("trimmed (#3621)", () => {
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

	it("keeps an older park the loop stopped until a later launch of its issue follows it", () => {
		const parked = at(1, { parkStopped: 2 });
		const kept = trimmed(history([parked, at(3)]));
		expect(kept).toHaveLength(51);
		expect(kept[0]).toBe(parked);
		const followed = trimmed([...history([parked]), at(1)]);
		expect(followed).not.toContain(parked);
	});
});
