// @vitest-environment node
/*
 * The refill loop's acts on blocked and resumed-idle launches (#2848),
 * through actOnBlocks and actOnIdle with a fake BlockIo that records each
 * call. refill-loop-run.test.ts drives the program's own BlockIo end to end.
 *
 * Loosen one and the loop stops, resumes, holds, parks or hands off a session
 * when it should not, fails to when it should, acts at the wrong count or
 * time, or misreports what it did.
 */
import { describe, expect, it } from "vitest";
import { RESUME_CAP } from "./block-act.js";
import {
	hasTurnedSince,
	type IdleReading,
	resumedIdleSince,
} from "./block-cause.js";
import { buildErrorText } from "./caught.js";
import { API_PROMPT, IDLE_PROMPT, LIMIT_PROMPT } from "./loop-prompts.js";
import {
	actOnBlocks,
	actOnIdle,
	actOnLimits,
	buildChildLine,
	buildHeldStopText,
	isHeld,
	markParked,
	queueLifted,
	releaseAwayParks,
	releaseEndedHolds,
	resumableOf,
	resumeHeldLaunches,
	unknownNews,
	unparkAnswered,
} from "./refill-blocks.js";
import { buildLimitCapText } from "./refill-decide.js";
import { judgedLaunches } from "./refill-loop.js";
import { buildSeatName } from "./refill-seats.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse("2026-10-18T12:00:00Z");
const LIMIT_HOLD_BOUND_DAYS = 8;
/** The cap refill-decide.js keeps to itself, pinned here. */
const LIMIT_PARK_CAP = 2;

type Launch = import("./refill-loop.js").LoopLaunch;
type Cause = import("./block-cause.js").Cause;
type BlockIo = import("./refill-blocks.js").BlockIo;
type Agents = import("./refill-blocks.js").Tick["agents"];
type SwapHold = import("./admission.js").SwapHold;

const NO_HOLD: SwapHold = { held: false };

function record(over: Record<string, unknown> = {}): Launch {
	return {
		root: "/home/u/design-vault",
		issues: [42],
		prompt: "/implement 42",
		seat: "/home/u/.claude3",
		jobId: "job42",
		launchedAt: NOW - 10 * MIN,
		finishedAt: null,
		...over,
	} as Launch;
}

const agent = (id: string, state: string) => ({
	sessionId: `s-${id}`,
	id,
	kind: "background",
	state,
});

/** A BlockIo whose every act succeeds unless `over` says otherwise, and its
 * `calls`. */
function fakeIo(over: Partial<BlockIo> = {}) {
	const calls: string[] = [];
	const io: BlockIo = {
		stop: (_, id) => {
			calls.push(`stop ${id}`);
			return { ok: true, said: "" };
		},
		type: (l) => {
			calls.push(`type ${l.jobId}`);
			return null;
		},
		resumeTargetOf: () => ({ sessionId: "s", cwd: "/" }),
		resumeStopped: (l) => {
			calls.push(`resume ${l.jobId}`);
			return {
				failed: null,
				jobId: `${l.jobId}-copy`,
				sessionId: "s",
				copy: true,
			};
		},
		moveSession: (l, target, _prompt, moved) => {
			calls.push(`move ${l.jobId} ${l.seat} ${target} ${moved.sessionId}`);
			return {
				failed: null,
				jobId: l.jobId,
				sessionId: moved.sessionId,
				copy: false,
			};
		},
		removeJobRecord: (seat) => {
			calls.push(`rm on ${seat}`);
			return null;
		},
		hasEndedUnblocked: () => false,
		jobStateOf: () => ({ state: "working" }),
		writeLedgerHold: (l, until) => {
			calls.push(`ledger ${l.jobId} ${until}`);
			return true;
		},
		readTimeline: () => [],
		idleSince: () => null,
		hasTurnedSince: () => false,
		hasRepliedSince: () => false,
		labelParked: () => [],
		recordParked: (_, sid, ns) => {
			calls.push(`record ${sid} ${ns.join(",")}`);
			return null;
		},
		readParkMarkers: () => [],
		unparkSession: () => null,
		comment: (_, body) => calls.push(`comment ${body}`),
		postHandOff: (l) => {
			calls.push(`hand-off ${l.jobId}`);
			return { failed: null, out: "" };
		},
		release: () => true,
		readActsBefore: () => ({}),
		progressOf: () => ({}),
		log: (line) => calls.push(`log ${line}`),
		admitResume: () => {
			calls.push("re-read");
			return null;
		},
		stagger: () => calls.push("stagger"),
		...over,
	};
	return { io, calls };
}

const logs = (calls: string[]) =>
	calls.filter((c) => c.startsWith("log ")).map((c) => c.slice(4));

function blocks(
	launches: Launch[],
	agents: Agents,
	mode: "away" | "normal",
	{ now = NOW, io: over = {} }: { now?: number; io?: Partial<BlockIo> } = {},
) {
	const { io, calls } = fakeIo(over);
	return {
		out: actOnBlocks(launches, mode, { agents, now, io, swapHold: NO_HOLD }),
		calls,
	};
}

const ids = (ls: Launch[]) => ls.map((l) => l.jobId);

describe("which parks the loop stops (#2699)", () => {
	const parkedFor = (cause: Cause, minutes: number, over = {}) =>
		record({
			jobId: "p",
			sessionId: "s-p",
			parked: true,
			block: { cause, since: NOW - minutes * MIN },
			...over,
		});
	const blocked = [agent("p", "blocked")];
	const stops = (
		l: Launch,
		mode: "away" | "normal",
		agents: Agents = blocked,
	) => ids(blocks([l], agents, mode).out.filter((o) => o.parkStopped === NOW));

	it("stops an away question or permission park on its first tick", () => {
		expect(stops(parkedFor("QUESTION", 0), "away")).toEqual(["p"]);
		expect(stops(parkedFor("PERMISSION", 0), "away")).toEqual(["p"]);
	});

	it("never stops a normal-mode question or permission park (#3621)", () => {
		expect(stops(parkedFor("QUESTION", 600), "normal")).toEqual([]);
		expect(stops(parkedFor("PERMISSION", 600), "normal")).toEqual([]);
	});

	it("leaves every other cause as today", () => {
		for (const cause of ["LIMIT", "OTHER_DIALOG", "UNKNOWN"] as const)
			expect(stops(parkedFor(cause, 600), "away")).toEqual([]);
	});

	it("stops nothing off an unread listing", () => {
		const r = blocks([parkedFor("QUESTION", 600)], null, "away");
		expect(r.calls).toEqual([]);
	});

	it("stops nothing the listing no longer shows blocked", () => {
		expect(stops(parkedFor("QUESTION", 600), "away", [])).toEqual([]);
		expect(
			stops(parkedFor("QUESTION", 600), "away", [agent("p", "working")]),
		).toEqual([]);
	});

	it("never stops a park twice, nor a finished launch", () => {
		for (const over of [{ parkStopped: NOW - MIN }, { finishedAt: NOW }])
			expect(
				blocks([parkedFor("QUESTION", 600, over)], blocked, "away").calls,
			).toEqual([]);
	});

	it("logs and comments a stop with its cause, mode and issues, and any label it missed", () => {
		const since = new Date(NOW).toISOString();
		const stopped = blocks([parkedFor("PERMISSION", 0)], blocked, "away");
		const line = `stopped PERMISSION park design-vault /implement 42 (away mode, blocked since ${since}); labelled parked: #42`;
		expect(stopped.calls).toEqual([
			"stop p",
			"record s-p 42",
			`log ${line}`,
			`comment Refill loop: ${line}. The conversation is kept: \`claude attach\` reopens it.`,
		]);
		const missed = blocks(
			[parkedFor("PERMISSION", 0, { issues: [42, 43] })],
			blocked,
			"away",
			{ io: { labelParked: () => [{ n: 43, why: "HTTP 502" }] } },
		);
		expect(logs(missed.calls)[0]).toMatch(
			/; labelled parked: #42; not labelled #43: HTTP 502$/,
		);
		const failed = blocks([parkedFor("PERMISSION", 0)], blocked, "away", {
			io: { stop: () => ({ ok: false, why: "exit 1: boom" }) as never },
		});
		expect(logs(failed.calls)).toEqual([
			expect.stringMatching(
				/^could not stop PERMISSION park .*: exit 1: boom$/,
			),
		]);
		expect(failed.out[0]).not.toHaveProperty("parkStopped");
	});

	it("records the labelled issues in its session's marker, so his typing unparks them (#3584)", () => {
		const missed = blocks(
			[parkedFor("QUESTION", 0, { issues: [42, 43] })],
			blocked,
			"away",
			{ io: { labelParked: () => [{ n: 43, why: "HTTP 502" }] } },
		);
		expect(missed.calls).toContain("record s-p 42");
		const none = blocks([parkedFor("QUESTION", 0)], blocked, "away", {
			io: { labelParked: () => [{ n: 42, why: "HTTP 502" }] },
		});
		expect(none.calls.some((c) => c.startsWith("record "))).toBe(false);
		expect(logs(none.calls)[0]).not.toMatch(/left parked/);
	});

	it("says in the stop line why the labelled issues are not in the marker (#3584)", () => {
		const unread = blocks(
			[parkedFor("QUESTION", 0, { sessionId: undefined })],
			blocked,
			"away",
		);
		expect(logs(unread.calls)[0]).toMatch(
			/; left parked until claimed, not on his typing: no session id read$/,
		);
		const unwritten = blocks([parkedFor("QUESTION", 0)], blocked, "away", {
			io: { recordParked: () => "EACCES" },
		});
		expect(logs(unwritten.calls)[0]).toMatch(
			/; left parked until claimed, not on his typing: EACCES$/,
		);
	});

	it("comments only each failure's first line, logging it in full (#3670)", () => {
		const stack = buildErrorText(new Error("EACCES: permission denied"));
		const { calls } = blocks(
			[parkedFor("QUESTION", 0, { issues: [42, 43] })],
			blocked,
			"away",
			{
				io: {
					labelParked: () => [{ n: 43, why: "HTTP 502\r\nretry later" }],
					recordParked: () => stack,
				},
			},
		);
		expect(logs(calls)[0]).toContain(`not on his typing: ${stack}`);
		expect(logs(calls)[0]).toContain(
			"not labelled #43: HTTP 502\r\nretry later",
		);
		const comment = calls.find((c) => c.startsWith("comment "));
		expect(comment).toContain("; not labelled #43: HTTP 502;");
		expect(comment).toMatch(
			/; left parked until claimed, not on his typing: Error: EACCES: permission denied\. The conversation is kept/,
		);
		expect(comment).not.toMatch(/[\r\n]/);
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
	const resumed = (
		l: Launch,
		agents: Agents = blocked,
		mode = "away" as const,
	) =>
		ids(
			blocks([l], agents, mode).out.filter((o) => o.resumes?.triedAt === NOW),
		);
	const held = (l: Launch, agents: Agents = blocked) =>
		ids(
			blocks([l], agents, "away").out.filter((o) => o.resumes?.heldAt === NOW),
		);

	it("makes no resume and checks no typed one on a paused tick (#3856)", () => {
		for (const l of [
			resuming(),
			resuming({ resumes: tried(1, 10, 0, { attachAt: NOW - 10 * MIN }) }),
		]) {
			const { io, calls } = fakeIo();
			const out = actOnBlocks([l], "away", {
				agents: blocked,
				now: NOW,
				io,
				swapHold: NO_HOLD,
				paused: true,
			});
			expect(calls).toEqual([]);
			expect(out).toEqual([l]);
		}
	});

	it("resumes a due one, live or held, but not off an unread listing", () => {
		expect(resumed(resuming())).toEqual(["p"]);
		expect(
			resumed(
				resuming({ resumes: tried(1, 10, 0, { heldAt: NOW - MIN }) }),
				[],
			),
		).toEqual(["p-copy"]);
		expect(blocks([resuming()], null, "away").calls).toEqual([]);
	});

	it("keeps a held one its resume wakes in place under its own job, never as a copy (#2987)", () => {
		const { out, calls } = blocks(
			[resuming({ resumes: tried(1, 10, 0, { heldAt: NOW - MIN }) })],
			[],
			"away",
			{
				io: {
					resumeStopped: (l) => ({
						failed: null,
						jobId: l.jobId ?? "",
						sessionId: "s",
						copy: false,
					}),
				},
			},
		);
		expect(out[0]).toMatchObject({ jobId: "p", relaunchedAt: NOW });
		expect(out[0]).not.toHaveProperty("copiedFrom");
		expect(out[0]).not.toHaveProperty("pastSessionIds");
		expect(calls.join("\n")).toMatch(/woken in place/);
		expect(calls.join("\n")).not.toMatch(/as its copy/);
	});

	it("never resumes before it is due, nor while a typed resume awaits its check", () => {
		expect(resumed(resuming({ resumes: tried(1, 1, 3) }))).toEqual([]);
		expect(
			blocks(
				[resuming({ resumes: tried(1, 0.5, -1, { attachAt: NOW - MIN / 2 }) })],
				blocked,
				"away",
			).calls,
		).toEqual([]);
	});

	it("holds a session blocked again past the retry cycle, until its next resume", () => {
		expect(held(resuming({ resumes: tried(2, 4, 6) }))).toEqual(["p"]);
		expect(held(resuming({ resumes: tried(2, 3, 6) }))).toEqual([]);
		expect(
			blocks(
				[resuming({ resumes: tried(2, 4, 6, { heldAt: NOW - MIN }) })],
				blocked,
				"away",
			).calls,
		).toEqual([]);
		expect(held(resuming({ resumes: tried(2, 10, 0) }))).toEqual([]);
		expect(
			held(resuming({ resumes: tried(2, 4, 6) }), [agent("p", "working")]),
		).toEqual([]);
		expect(
			logs(
				blocks([resuming({ resumes: tried(2, 4, 6) })], blocked, "away").calls,
			),
		).toEqual([
			`stopped design-vault /implement 42 until its next resume, due ${new Date(NOW + 6 * MIN).toISOString()}`,
		]);
	});

	it("parks auth and invalid_request at once, and a held one at the cap, not below it", () => {
		for (const sub of ["auth", "invalid_request"] as const)
			expect(
				ids(
					blocks(
						[resuming({ block: block(sub) })],
						blocked,
						"normal",
					).out.filter((o) => o.parkStopped === NOW),
				),
			).toEqual(["p"]);
		const at = (tries: number) =>
			resuming({ resumes: tried(tries, 30, 0, { heldAt: NOW - MIN }) });
		const capped = blocks([at(RESUME_CAP)], [], "normal");
		expect(capped.out[0]?.parkStopped).toBe(NOW);
		expect(capped.calls).not.toContain("resume p");
		expect(
			blocks([at(RESUME_CAP - 1)], [], "normal").out[0],
		).not.toHaveProperty("parkStopped");
	});

	it("parks a held one whose stop finds no job, but fails a live one's", () => {
		const noJob = {
			io: {
				stop: () => ({
					ok: false as const,
					why: "exit 1: No job matching 'p'.",
					said: "No job matching 'p'.",
					timedOut: false,
					noJob: true,
				}),
			},
		};
		const capped = resuming({
			resumes: tried(RESUME_CAP, 30, 0, { heldAt: NOW - MIN }),
		});
		expect(blocks([capped], [], "normal", noJob).out[0]?.parkStopped).toBe(NOW);
		const live = blocks(
			[resuming({ block: block("auth") })],
			blocked,
			"away",
			noJob,
		);
		expect(live.out[0]).not.toHaveProperty("parkStopped");
		expect(logs(live.calls)).toEqual([
			expect.stringMatching(/: exit 1: No job matching 'p'\.$/),
		]);
	});

	it("counts each resume, schedules the next, and marks a typed or failed one", () => {
		expect(blocks([resuming()], blocked, "away").out[0]?.resumes).toEqual({
			tries: 1,
			triedAt: NOW,
			nextAt: NOW + 4 * MIN,
			attachAt: NOW,
		});
		const wasHeld = resuming({
			resumes: tried(1, 4, 0, { heldAt: NOW - MIN }),
		});
		expect(blocks([wasHeld], [], "away").out[0]?.resumes).toEqual({
			tries: 2,
			triedAt: NOW,
			nextAt: NOW + 10 * MIN,
		});
		expect(
			blocks([wasHeld], [], "away", {
				io: { resumeStopped: () => ({ failed: "exit 1" }) },
			}).out[0]?.resumes?.heldAt,
		).toBe(NOW - MIN);
	});

	it("reads a typed resume as arrived only off a later timeline row carrying it", () => {
		const typed = resuming({
			resumes: tried(1, 2, 2, { attachAt: NOW - 2 * MIN }),
		});
		const row = (at: number, detail: string) => ({
			at: new Date(at).toISOString(),
			state: "blocked",
			detail,
		});
		const fellBack = (timeline: unknown[] | null) =>
			blocks([typed], blocked, "away", {
				io: { readTimeline: () => timeline },
			}).calls.includes("resume p");
		// Half the prompt clears the head it shares with IDLE_PROMPT.
		expect(
			fellBack([
				row(NOW - MIN, `${API_PROMPT.slice(0, API_PROMPT.length / 2)}…`),
			]),
		).toBe(false);
		expect(fellBack([row(NOW - 3 * MIN, API_PROMPT)])).toBe(true);
		expect(fellBack([row(NOW - MIN, IDLE_PROMPT)])).toBe(true);
		expect(fellBack([row(NOW - MIN, "API Error: 529")])).toBe(true);
		expect(fellBack(null)).toBe(true);
	});

	it("logs and comments a resume with its count, route and next due time, and a morning park as such", () => {
		const line = `resume 1 of ${RESUME_CAP} after an API error, design-vault /implement 42, by typing into the live session; next due ${new Date(NOW + 4 * MIN).toISOString()}`;
		expect(blocks([resuming()], blocked, "away").calls).toEqual([
			"type p",
			`log ${line}`,
			`comment Refill loop: ${line}.`,
		]);
		const relaunchFailed = blocks(
			[resuming({ resumes: tried(1, 4, 0, { heldAt: NOW - MIN }) })],
			[],
			"away",
			{ io: { resumeStopped: () => ({ failed: "exit 1" }) } },
		);
		expect(logs(relaunchFailed.calls)).toEqual([
			expect.stringMatching(
				/^could not resume 2 of \d+ .*, by stop and --bg --resume: exit 1$/,
			),
		]);
		const morning = blocks(
			[
				resuming({
					block: {
						...block("transient"),
						since: new Date(2026, 9, 24, 23, 0).getTime(),
					},
				}),
			],
			blocked,
			"away",
			{ now: new Date(2026, 9, 25, 7, 0).getTime() },
		);
		expect(logs(morning.calls)[0]).toMatch(/, at the morning cut-off\)/);
	});
});

describe("the resumed-idle launches the loop acts on (#2659, #2978)", () => {
	const idleFor = (minutes: IdleReading) => () =>
		minutes === null || minutes === "unread" ? minutes : NOW - minutes * MIN;
	const idle = (
		l: Launch,
		minutes: IdleReading,
		{
			mode = "away",
			agents = [],
			io: over = {},
			swapHold = NO_HOLD,
		}: {
			mode?: "away" | "normal";
			agents?: Agents;
			io?: Partial<BlockIo>;
			swapHold?: SwapHold;
		} = {},
	) => {
		const { io, calls } = fakeIo({ idleSince: idleFor(minutes), ...over });
		const [out] = actOnIdle([l], mode, { agents, now: NOW, io, swapHold });
		return { out, calls };
	};
	const listed = [agent("job42", "working")];
	const typed = (tries: number, ago: number) =>
		record({ idleResumes: { tries, triedAt: NOW - ago * MIN } });
	/* A reader that says `first` on its first call and `then` after: a turn
	 * or a job's end landing mid-tick, between the table's read and the
	 * hand-off's own. */
	const landing = <T>(first: T, then: T) => {
		let n = 0;
		return () => (n++ === 0 ? first : then);
	};

	it("types a resume into a working launch 5 min from its restart row, in either mode, and no sooner", () => {
		for (const mode of ["away", "normal"] as const) {
			const r = idle(record(), 5, { mode, agents: listed });
			expect(r.calls.slice(0, 2)).toEqual([
				"type job42",
				"log resumed design-vault /implement 42, idle since its host's restart, by typing into the live session, try 1 of 2",
			]);
			expect(r.out?.idleResumes).toEqual({ tries: 1, triedAt: NOW });
		}
		expect(idle(record(), 4.9, { agents: listed }).calls).toEqual([]);
	});

	it("types once more into one still idle 5 min after its first typed resume, never stopping it", () => {
		expect(idle(typed(1, 4), 30, { agents: listed }).calls).toEqual([]);
		const r = idle(typed(1, 5), 30, { agents: listed });
		expect(r.calls[0]).toBe("type job42");
		expect(r.calls).not.toContain("stop job42");
		expect(r.out?.idleResumes).toEqual({ tries: 2, triedAt: NOW });
	});

	it("types and hands off nothing on a paused tick, leaving them for the tick after (#3856)", () => {
		for (const l of [record(), typed(2, 5), record({ handOffTries: 1 })]) {
			const { io, calls } = fakeIo({ idleSince: idleFor(30) });
			actOnIdle([l], "away", {
				agents: listed,
				now: NOW,
				io,
				swapHold: NO_HOLD,
				paused: true,
			});
			expect(calls).toEqual([]);
		}
	});

	it("hands off one still idle 5 min after its second typed resume", () => {
		expect(idle(typed(2, 4), 30, { agents: listed }).calls).toEqual([]);
		const r = idle(typed(2, 5), 30, { agents: listed });
		expect(r.calls.slice(0, 2)).toEqual(["stop job42", "hand-off job42"]);
		expect(r.out).toMatchObject({ finishedAt: NOW, handedOff: NOW });
	});

	it("ends the episode of a typed resume answered by a turn, read off the transcript", () => {
		const row = (type: string, ago: number, over = {}) => ({
			type,
			timestamp: new Date(NOW - ago * MIN).toISOString(),
			...over,
		});
		const rows = [
			row("api-request", 30),
			row("user", 20, {
				isMeta: true,
				message: {
					content: [
						{
							type: "text",
							text: "Continue from where you left off. Note: this session was automatically restarted after its process exited unexpectedly.",
						},
					],
				},
			}),
			row("user", 6),
			row("api-request", 5.9),
			row("assistant", 5.8),
		];
		const off = (seen: object[]): Partial<BlockIo> => ({
			idleSince: () =>
				resumedIdleSince({ job: { state: "working" }, rows: seen }),
			hasTurnedSince: (_, at) => hasTurnedSince(seen, at),
		});
		const r = idle(typed(1, 6), null, { agents: listed, io: off(rows) });
		expect(r.calls).toEqual([]);
		expect(r.out).not.toHaveProperty("idleResumes");
		const unanswered = idle(typed(1, 6), null, {
			agents: listed,
			io: off(rows.slice(0, 3)),
		});
		expect(unanswered.calls[0]).toBe("type job42");
	});

	it("drops the count of an episode a turn ended before a later restart", () => {
		const r = idle(typed(2, 30), 2, {
			agents: listed,
			io: { hasTurnedSince: () => true },
		});
		expect(r.calls).toEqual([]);
		expect(r.out).not.toHaveProperty("idleResumes");
	});

	it("clears the count of a launch seen taking a turn again", () => {
		const r = idle(typed(2, 9), null);
		expect(r.calls).toEqual([]);
		expect(r.out).not.toHaveProperty("idleResumes");
	});

	it("records when a launch went idle for status, clearing it once it takes a turn (#2850)", () => {
		const waiting = idle(record(), 2, { agents: listed }).out;
		expect(waiting?.idleSince).toBe(NOW - 2 * MIN);
		expect(idle(record(), 5, { agents: listed }).out?.idleSince).toBe(
			NOW - 5 * MIN,
		);
		expect(idle({ ...record(), ...waiting }, null).out).not.toHaveProperty(
			"idleSince",
		);
		const resumed = idle(record(), 5, { agents: listed }).out;
		expect(
			idle({ ...record(), ...resumed }, 1, { agents: listed }).out?.idleSince,
		).toBe(NOW - 5 * MIN);
	});

	it("holds the count across an unread tick, so the check after still hands off (#2847)", () => {
		const r = idle(typed(2, 9), "unread");
		expect(r).toEqual({ out: typed(2, 9), calls: [] });
		expect(idle(typed(2, 9), 30, { agents: listed }).calls).toContain(
			"hand-off job42",
		);
	});

	it("types off an unread listing but never stops off one", () => {
		expect(idle(record(), 5, { agents: null }).calls[0]).toBe("type job42");
		expect(idle(typed(2, 5), 30, { agents: null }).calls).toEqual([
			"log not handing off design-vault /implement 42: the listing is unread",
		]);
	});

	it("counts a resume it could not type, so the hand-off still follows", () => {
		const r = idle(record(), 5, {
			agents: listed,
			io: { type: () => "exit 1" },
		});
		expect(r.out?.idleResumes).toEqual({ tries: 1, triedAt: NOW });
		expect(logs(r.calls)).toEqual([
			"could not resume design-vault /implement 42, idle since its host's restart, by typing into the live session, try 1 of 2: exit 1",
		]);
		const gone = idle(record(), 5, { agents: [agent("job42", "done")] });
		expect(gone.calls).not.toContain("type job42");
		expect(gone.out?.idleResumes).toEqual({ tries: 1, triedAt: NOW });
	});

	it("passes over a finished, park-stopped, API-resuming or hand-off-owed launch", () => {
		for (const l of [
			record({ finishedAt: NOW - MIN }),
			record({ jobId: null }),
			record({ parkStopped: NOW - MIN }),
			record({ block: { cause: "API_ERROR", sub: "transient", since: NOW } }),
		]) {
			const r = idle(l, 30, { agents: listed });
			expect(r.calls).toEqual([]);
			expect(r.out).toEqual(l);
		}
	});

	it("stops nothing whose records, read again before the hand-off's stop, show a turn, a job no longer working or no read (#2979)", () => {
		const spared = (io: Partial<BlockIo>, line: string) => {
			const r = idle(typed(2, 5), 30, { agents: listed, io });
			expect(r.calls).toEqual([
				`log not stopping design-vault /implement 42: ${line}`,
			]);
			return r.out;
		};
		const turned = spared(
			{ hasTurnedSince: landing(false, true) },
			"it took a turn after its resume",
		);
		expect(turned).not.toHaveProperty("idleResumes");
		const done = spared(
			{ idleSince: landing<IdleReading>(NOW - 30 * MIN, null) },
			"its job is no longer idle",
		);
		expect(done).not.toHaveProperty("idleResumes");
		const unread = spared(
			{ idleSince: landing<IdleReading>(NOW - 30 * MIN, "unread") },
			"its resumed-idle records are unread",
		);
		expect(unread?.idleResumes).toEqual({ tries: 2, triedAt: NOW - 5 * MIN });
	});

	it("retries an owed hand-off without stopping again", () => {
		const r = idle(record({ handOffTries: 1 }), 30, { agents: listed });
		expect(r.calls[0]).toBe("hand-off job42");
		expect(r.out).toMatchObject({ finishedAt: NOW, handedOff: NOW });
	});

	describe("under the swap hold (#3093)", () => {
		const Hold: SwapHold = {
			held: true,
			swapFreeMb: 300,
			swapTotalMb: 2048,
			availableMb: 1900,
		};
		const restartedAt = NOW - 2 * MIN;
		/* #2978's detector reads the launch resumed-idle off these. */
		const restarted: Partial<BlockIo> = {
			idleSince: () =>
				resumedIdleSince({
					job: { state: "working" },
					rows: [
						{
							type: "api-request",
							timestamp: new Date(NOW - 30 * MIN).toISOString(),
						},
						{
							type: "user",
							isMeta: true,
							timestamp: new Date(restartedAt).toISOString(),
							message: {
								content: [
									{
										type: "text",
										text: "Continue from where you left off. Note: this session was automatically restarted after its process exited unexpectedly.",
									},
								],
							},
						},
					],
				}),
		};
		const why =
			"design-vault /implement 42, restarted by its host, under the swap hold (swap is 300 of 2048 MB free and 1900 MB available)";
		const held = (over = {}) =>
			record({
				idleSince: restartedAt,
				swapHeld: { at: NOW - 10 * MIN, sessionId: "s42", cwd: "/c", tries: 0 },
				...over,
			});

		it("stops and holds a restarted launch at once instead of typing into it", () => {
			const r = idle(typed(1, 1), null, {
				agents: listed,
				io: restarted,
				swapHold: Hold,
			});
			expect(r.calls).toEqual([
				"stop job42",
				`log stopped ${why}, until the hold clears`,
			]);
			expect(r.out?.swapHeld).toEqual({
				at: NOW,
				sessionId: "s",
				cwd: "/",
				tries: 0,
			});
			expect(r.out?.idleResumes).toEqual({ tries: 1, triedAt: NOW - MIN });
			expect(r.out).not.toHaveProperty("idleSince");
			expect(isHeld(r.out as Launch)).toBe(true);
		});

		it("hands off, not holds, one whose typed resumes are spent", () => {
			const r = idle(typed(2, 1), null, {
				agents: listed,
				io: restarted,
				swapHold: Hold,
			});
			expect(r.calls.slice(0, 2)).toEqual(["stop job42", "hand-off job42"]);
			expect(r.out).toMatchObject({ finishedAt: NOW, handedOff: NOW });
			expect(r.out).not.toHaveProperty("swapHeld");
		});

		it("leaves the typed resume unchanged outside the hold", () => {
			const early = idle(record(), null, { agents: listed, io: restarted });
			expect(early.calls).toEqual([]);
			expect(early.out?.idleSince).toBe(restartedAt);
			const due = idle(record(), 5, { agents: listed });
			expect(due.calls[0]).toBe("type job42");
			expect(due.out).not.toHaveProperty("swapHeld");
		});

		it("logs a stop that fails, holds nothing and tries again next tick", () => {
			for (const fail of [
				{ why: "timed out", timedOut: true, noJob: false },
				{ why: "No job matching 'job42'", timedOut: false, noJob: true },
			]) {
				const io: Partial<BlockIo> = {
					...restarted,
					stop: () => ({ ok: false, said: null, ...fail }),
				};
				const r = idle(record(), null, { agents: listed, io, swapHold: Hold });
				expect(logs(r.calls)).toEqual([`could not stop ${why}: ${fail.why}`]);
				expect(r.out).not.toHaveProperty("swapHeld");
				expect(isHeld(r.out as Launch)).toBe(false);
				const again = idle(r.out as Launch, null, {
					agents: listed,
					io: restarted,
					swapHold: Hold,
				});
				expect(again.calls[0]).toBe("stop job42");
				expect(again.out?.swapHeld?.at).toBe(NOW);
			}
		});

		it("stops nothing off an unread listing or with no session id to resume it by", () => {
			const unread = idle(record(), null, {
				agents: null,
				io: restarted,
				swapHold: Hold,
			});
			expect(unread.calls).toEqual([
				`log not stopping ${why}: the listing is unread`,
			]);
			const noId = idle(record(), null, {
				agents: listed,
				io: {
					...restarted,
					resumeTargetOf: () => ({ sessionId: null, cwd: "/" }),
				},
				swapHold: Hold,
			});
			expect(noId.calls).toEqual([
				`log not stopping ${why}: no session id read to resume it by`,
			]);
		});

		it("keeps a held launch stopped while the hold binds", () => {
			const stopped = [agent("job42", "stopped")];
			const r = idle(held(), null, {
				agents: stopped,
				io: restarted,
				swapHold: Hold,
			});
			expect(r).toEqual({ out: held(), calls: [] });
		});

		/* The tick's resume step over everything resumableOf finds due. */
		const resumeDue = (
			launches: Launch[],
			{
				agents = [agent("job42", "stopped")] as Agents,
				io: over = {} as Partial<BlockIo>,
				isStopped = (): boolean => false,
			} = {},
		) => {
			const { io, calls } = fakeIo(over);
			const seen = { agents, now: NOW, io, swapHold: NO_HOLD };
			const due = resumableOf(launches, seen);
			return {
				due,
				calls,
				...resumeHeldLaunches(due, launches, seen, isStopped),
			};
		};
		const heldAs = (jobId: string, ago: number, tries = 0) =>
			held({
				jobId,
				swapHeld: {
					at: NOW - ago * MIN,
					sessionId: `s-${jobId}`,
					cwd: "/c",
					tries,
				},
			});

		it("carries each due session's seat, for the decision to charge (#3895)", () => {
			expect(resumeDue([held()]).due).toMatchObject([
				{ jobId: "job42", seat: "/home/u/.claude3" },
			]);
		});

		it("finds nothing due while the hold binds", () => {
			const { io } = fakeIo();
			expect(
				resumableOf([held()], {
					agents: [],
					now: NOW,
					io,
					swapHold: Hold,
				}),
			).toEqual([]);
		});

		it("resumes none on the clearing tick's idle pass: the decision paces them", () => {
			const r = idle(held(), null, {
				agents: [agent("job42", "stopped")],
				io: restarted,
			});
			expect(r.calls).toEqual([]);
			expect(r.out).toEqual(held());
		});

		it("passes each resume through the re-read first, pausing after each it starts", () => {
			const r = resumeDue([heldAs("a", 20), heldAs("b", 10)], { agents: [] });
			expect(r.calls.filter((c) => !c.startsWith("log "))).toEqual([
				"re-read",
				"resume a",
				"stagger",
				"re-read",
				"resume b",
				"stagger",
			]);
			expect(r.started).toBe(2);
			expect(r.waiting).toBe(false);
		});

		it("makes the first resume the re-read refuses wait, charged no try, with all behind it", () => {
			const reads = ["no slot"];
			const launches = [heldAs("a", 20, 1), heldAs("b", 10)];
			const r = resumeDue(launches, {
				agents: [],
				io: { admitResume: () => reads.shift() ?? null },
			});
			expect(r.calls).toEqual([
				"log not resuming a design-vault /implement 42, stopped under the swap hold at 2026-10-18T11:40:00.000Z, for a later tick: no slot",
			]);
			expect(r.launches).toEqual(launches);
			expect(r.started).toBe(0);
			expect(r.waiting).toBe(true);
		});

		it("resumes none once a stop lands, and leaves it held", () => {
			const r = resumeDue([held()], { isStopped: () => true });
			expect(r.calls).toEqual([]);
			expect(r.launches).toEqual([held()]);
		});

		it("resumes a held launch through the step once the hold clears", () => {
			const r = resumeDue([held()]);
			const [out] = r.launches;
			expect(r.started).toBe(1);
			expect(r.calls).toEqual([
				"re-read",
				"resume job42",
				"log resumed design-vault /implement 42, stopped under the swap hold at 2026-10-18T11:50:00.000Z, the hold cleared, by --bg --resume, as its copy job42-copy",
				"stagger",
			]);
			expect(out).not.toHaveProperty("swapHeld");
			expect(out).toMatchObject({
				jobId: "job42-copy",
				copiedFrom: "job42",
				relaunchedAt: NOW,
				pastSessionIds: ["s42"],
			});
		});

		it("resumes nothing off an unread listing", () => {
			const r = resumeDue([held()], { agents: null });
			expect(r.due).toEqual([]);
			expect(r.calls).toEqual([
				"log not resuming design-vault /implement 42, stopped under the swap hold at 2026-10-18T11:50:00.000Z: the listing is unread",
			]);
		});

		it("lets go of one the listing shows live again, blocked or working", () => {
			const unknown = () => ({ cause: "UNKNOWN" as const, why: "" });
			for (const state of ["working", "blocked"]) {
				const [out] = markParked(
					[held()],
					[agent("job42", state)],
					unknown,
					NOW,
				);
				expect(out).not.toHaveProperty("swapHeld");
			}
			const [still] = markParked(
				[held()],
				[agent("job42", "stopped")],
				unknown,
				NOW,
			);
			expect(still).toEqual(held());
		});

		it("keeps what it knew of one whose row carries no state, and reads its cause for the log (#3200)", () => {
			const { state: _, ...bare } = agent("job42", "blocked");
			const read: unknown[] = [];
			const [out] = markParked(
				[held()],
				[bare],
				(_l, row) => {
					read.push(row);
					return {
						cause: "UNKNOWN",
						why: "row carries neither status nor state",
					};
				},
				NOW,
			);
			expect(out).toEqual(held());
			expect(read).toEqual([bare]);
		});

		it("keeps one whose resume failed held for the next tick, and hands it off at the third failure", () => {
			const io: Partial<BlockIo> = {
				resumeStopped: () => ({ failed: "exit 1" }),
			};
			const stopped = [agent("job42", "stopped")];
			const first = resumeDue([held()], { agents: stopped, io });
			expect(first.launches[0].swapHeld?.tries).toBe(1);
			expect(first.launches[0].finishedAt).toBeNull();
			expect(first.started).toBe(0);
			const last = resumeDue([heldAs("job42", 10, 2)], { agents: stopped, io });
			expect(last.calls).toContain("hand-off job42");
			expect(last.calls).not.toContain("stop job42");
			expect(last.launches[0]).toMatchObject({
				finishedAt: NOW,
				handedOff: NOW,
			});
			expect(last.launches[0]).not.toHaveProperty("swapHeld");
			expect(last.started).toBe(0);
		});
	});
});

describe("releasing an away park's ledger row in normal mode (#3872)", () => {
	const parkedAway = record({ jobId: "a", parkStopped: NOW, parkedAway: true });
	const parkedNormal = record({ jobId: "n", parkStopped: NOW });
	const released = (
		ok = true,
		mode: "away" | "normal" = "normal",
		served = [parkedAway.root],
	) => {
		const calls: string[] = [];
		const out = releaseAwayParks([parkedAway, parkedNormal], mode, served, {
			release: (l) => {
				calls.push(`release ${l.jobId}`);
				return ok;
			},
			log: (line) => calls.push(`log ${line}`),
		});
		return { out, calls };
	};

	it("releases only the park away mode made, once, in normal mode", () => {
		const { out, calls } = released();
		expect(calls).toEqual(["release a"]);
		expect(out[0]).not.toHaveProperty("parkedAway");
		expect(out[1]).toBe(parkedNormal);
	});

	it("releases none in away mode", () => {
		const { out, calls } = released(true, "away");
		expect(calls).toEqual([]);
		expect(out[0]).toBe(parkedAway);
	});

	it("releases none in a checkout normal mode does not serve", () => {
		const { out, calls } = released(true, "normal", ["/elsewhere"]);
		expect(calls).toEqual([]);
		expect(out[0]).toBe(parkedAway);
	});

	it("keeps it due and logs it where the release fails", () => {
		const { out, calls } = released(false);
		expect(calls[1]).toContain("could not release");
		expect(out[0]).toBe(parkedAway);
	});
});

describe("unparkAnswered (#3940)", () => {
	const marker = (over: Record<string, unknown> = {}) => ({
		sessionId: "s",
		issues: [42],
		job: { seat: "/seat", jobId: "j", cwd: "/c" },
		writtenAt: NOW,
		...over,
	});

	/** The unparks and log of one sweep over `markers`, reading `over`'s answers. */
	const sweep = (
		markers: ReturnType<typeof marker>[] | null,
		over: Partial<BlockIo> = {},
		agents: Agents = [],
	) => {
		const unparked: string[] = [];
		const { io, calls } = fakeIo({
			readParkMarkers: () => markers,
			hasEndedUnblocked: () => true,
			unparkSession: ({ root }, sid, issues) => {
				unparked.push(`${root} ${sid} ${issues.join(",")}`);
				return null;
			},
			...over,
		});
		unparkAnswered(["/r"], { agents, io });
		return { unparked, calls };
	};

	it("unparks what a marker lists where its session ended unblocked", () => {
		expect(sweep([marker()]).unparked).toEqual(["/r s 42"]);
	});

	it("leaves one that parked again or never answered", () => {
		expect(
			sweep([marker()], { hasEndedUnblocked: () => false }).unparked,
		).toEqual([]);
	});

	it("leaves one whose session or job still runs", () => {
		for (const id of ["s", "j"])
			expect(
				sweep([marker()], {}, [
					{ id, sessionId: id, kind: "background", state: "working" },
				]).unparked,
			).toEqual([]);
	});

	it("reads an ended session in the listing as no longer running", () => {
		expect(sweep([marker()], {}, [agent("j", "done")]).unparked).toEqual([
			"/r s 42",
		]);
	});

	it("does nothing off an unread listing", () => {
		expect(sweep([marker()], {}, null).unparked).toEqual([]);
	});

	it("leaves an issue a newer park holds to that park's session", () => {
		const older = marker({ writtenAt: NOW - MIN, issues: [42, 43] });
		const newer = marker({ sessionId: "n", job: null });
		const judged = (m: { sessionId: string }) => m.sessionId === "s";
		expect(
			sweep([older, newer], { hasEndedUnblocked: judged }).unparked,
		).toEqual(["/r s 43"]);
	});

	it("waits where the markers will not read", () => {
		expect(sweep(null).unparked).toEqual([]);
	});

	it("logs a label that would not come off", () => {
		const { calls } = sweep([marker()], {
			unparkSession: () => "#42: HTTP 502",
		});
		expect(calls.join("\n")).toContain("still labelled parked: #42: HTTP 502");
	});
});

describe("unknownNews (#3200)", () => {
	const unread = (why: string) => ({ cause: "UNKNOWN" as const, why });

	it("logs an UNKNOWN once for each why, and again once a cause has read between", () => {
		const logged = new Map<string, string>();
		const news = (r: Parameters<typeof unknownNews>[2]) =>
			unknownNews(logged, "job42", r);
		expect(news(unread("no transcript"))).toBe("no transcript");
		expect(news(unread("no transcript"))).toBeNull();
		expect(news(unread("no job record"))).toBe("no job record");
		expect(news({ cause: "QUESTION" })).toBeNull();
		expect(logged.has("job42")).toBe(false);
		expect(news(unread("no job record"))).toBe("no job record");
		expect(unknownNews(logged, "job43", unread("no job record"))).toBe(
			"no job record",
		);
	});
});

describe("buildChildLine (#3645)", () => {
	it.each([
		[
			"puts exit 0 after the label and indents each output line under it",
			{ out: "filed #9\nfiled #10", failed: null },
			"memory kills: exit 0\n  filed #9\n  filed #10",
		],
		[
			"puts the run's failure after the label, ahead of its output",
			{ out: "boom", failed: "exit 1" },
			"memory kills: exit 1\n  boom",
		],
	])("%s", (_, ran, line) => {
		expect(buildChildLine("memory kills", ran)).toBe(line);
	});
});

describe("the acts on a limit-blocked launch (#3735)", () => {
	const Seat = "/home/u/.claude3";
	const Since = NOW - 5 * MIN;
	type Sized = import("./refill-decide.js").SizedSeat;
	const planSeat = (over: Partial<Sized> = {}): Sized => ({
		seat: Seat,
		week: 50,
		session: 10,
		weekFull: false,
		sessionFull: false,
		sessionResets: null,
		weekResets: null,
		readAt: NOW,
		weekRead: { percent: 50, atMs: NOW },
		fits: 1,
		...over,
	});
	const fiveHourFull = planSeat({
		session: 100,
		sessionFull: true,
		sessionResets: "2026-10-18T15:00:00Z",
		fits: null,
	});
	const LimitHeld = {
		at: Since,
		sessionId: "s-job42",
		cwd: "/home/u/design-vault",
		limit: { bar: "5-hour", resets: "2026-10-18T15:00:00Z" },
	};
	const blocked = (over: Record<string, unknown> = {}) =>
		record({
			sessionId: "s-job42",
			parked: true,
			block: { cause: "LIMIT", since: Since },
			...over,
		});
	const held = (over: Record<string, unknown> = {}) =>
		blocked({ limitHeld: LimitHeld, ...over });

	function limits(
		launches: Launch[],
		agents: Agents,
		{
			seats = [planSeat()],
			slots = 1,
			mode = "away",
			seatListRead = true,
			now = NOW,
			io: over = {},
		}: {
			seats?: Sized[];
			seatListRead?: boolean;
			slots?: number;
			now?: number;
			mode?: "away" | "normal";
			io?: Partial<BlockIo>;
		} = {},
	) {
		const { io, calls } = fakeIo({
			resumeStopped: (l, prompt, target) => {
				calls.push(`confirmed ${l.seat} ${target.sessionId} ${prompt}`);
				return {
					failed: null,
					jobId: l.jobId,
					sessionId: target.sessionId,
					copy: false,
				};
			},
			...over,
		});
		const out = actOnLimits(launches, mode, {
			agents,
			now,
			io,
			swapHold: NO_HOLD,
			typedSeat: null,
			readMoveSeats: () => seats,
			seatListRead,
			slots,
		});
		return { ...out, calls };
	}
	const comments = (calls: string[]) =>
		calls.filter((c) => c.startsWith("comment "));

	describe.each(["away", "normal"] as const)("in %s mode", (mode) => {
		it("holds: stops the job, logs session, seat and limit, comments nothing", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ seats: [fiveHourFull], mode },
			);
			expect(calls).toContain("stop job42");
			expect(comments(calls)).toEqual([]);
			expect(logs(calls)).toEqual([
				`held job42 design-vault /implement 42 on ${Seat}, at its 5-hour limit (reset 2026-10-18T15:00:00Z): stopped until a seat has room`,
			]);
			expect(launches[0]).toMatchObject({
				finishedAt: null,
				limitHeld: {
					at: NOW,
					sessionId: "s",
					cwd: "/",
					limit: { bar: "5-hour" },
				},
			});
			expect(isHeld(launches[0] as Launch)).toBe(true);
		});

		it("resumes a live one: stops, resumes under its seat, comments once", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ mode },
			);
			expect(calls.slice(0, 2)).toEqual([
				"stop job42",
				`confirmed ${Seat} s ${LIMIT_PROMPT}`,
			]);
			expect(comments(calls)).toHaveLength(1);
			expect(launches[0]).toMatchObject({
				jobId: "job42",
				relaunchedAt: NOW,
				limitHeld: { resumedAt: NOW },
			});
		});
	});

	it("resumes a held one without a second stop, and its comment says what was lost", () => {
		const { launches, calls, slots } = limits([held()], []);
		expect(calls).not.toContain("stop job42");
		expect(calls).toContain(`confirmed ${Seat} s-job42 ${LIMIT_PROMPT}`);
		const [comment] = comments(calls);
		expect(comment).toContain("5-hour limit (reset 2026-10-18T15:00:00Z)");
		expect(comment).toContain(`same seat, ${Seat}`);
		expect(comment).toContain(
			"in-flight subagents, background tasks and monitors, and the warm prompt cache",
		);
		expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
		expect(slots).toBe(0);
	});

	it("takes a slot per held resume, and a live one's stop and resume takes none", () => {
		const two = [held(), held({ jobId: "job43", issues: [43] })];
		const out = limits(two, [], { slots: 1 });
		expect(out.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
		expect(out.launches[1]?.limitHeld).not.toHaveProperty("resumedAt");
		expect(out.slots).toBe(0);
		const live = limits([blocked()], [agent("job42", "blocked")], { slots: 0 });
		expect(live.calls).toContain("stop job42");
		expect(live.slots).toBe(0);
		expect(live.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
	});

	it("a failed resume stays held and names the failure in log and comment", () => {
		const { launches, calls, slots } = limits([held()], [], {
			io: {
				resumeStopped: () => ({ failed: "not confirmed: job42 reads x" }),
			},
		});
		expect(launches[0]).toMatchObject({
			limitHeld: LimitHeld,
			limitResumes: {
				tries: 1,
				triedAt: NOW,
				nextAt: NOW + 4 * MIN,
				failed: "not confirmed: job42 reads x",
			},
		});
		expect(isHeld(launches[0] as Launch)).toBe(true);
		expect(slots).toBe(1);
		expect(logs(calls).join("\n")).toContain("not confirmed: job42 reads x");
		expect(comments(calls)[0]).toContain("not confirmed: job42 reads x");
	});

	it("comments a failure once, and again only when it changes", () => {
		const io = { resumeStopped: () => ({ failed: "same" }) };
		const tried = {
			tries: 1,
			triedAt: NOW - 30 * MIN,
			nextAt: NOW - MIN,
			failed: "same",
		};
		const again = limits([held({ limitResumes: tried })], [], { io });
		expect(comments(again.calls)).toEqual([]);
		expect(logs(again.calls).join("\n")).toContain("same");
		const changed = limits(
			[held({ limitResumes: { ...tried, failed: "other" } })],
			[],
			{ io },
		);
		expect(comments(changed.calls)).toHaveLength(1);
	});

	describe("a held one whose resume can never take (#3790)", () => {
		const failedTo = (failedTries: number) =>
			held({ limitHeld: { ...LimitHeld, failedTries } });
		const otherSeat = [planSeat({ seat: "/home/u/.claude2" })];

		function expectParked(
			{ launches, calls, slots }: ReturnType<typeof limits>,
			why: string,
		) {
			const parked = launches[0] as Launch;
			expect(parked).toMatchObject({ parkStopped: NOW, finishedAt: null });
			expect(parked).not.toHaveProperty("limitHeld");
			expect(isHeld(parked)).toBe(false);
			const [judged] = judgedLaunches([parked], [], NOW, {
				progressOf: () => ({}),
				causeOf: () => ({ cause: "LIMIT" }),
			});
			expect(judged?.finishedAt).toBe(NOW);
			expect(comments(calls)[0]).toContain("labelled parked: #42");
			expect(comments(calls)[0]).toContain(why);
			expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
			expect(calls).toContain("stop job42");
			expect(slots).toBe(1);
		}

		it("parks at the cap of failed resumes, and it finishes", () => {
			expectParked(
				limits([failedTo(RESUME_CAP)], []),
				`${RESUME_CAP} failed resumes or moves`,
			);
		});

		describe("held on a seat that never reads open (#3793)", () => {
			const heldFor = (ms: number) =>
				held({ limitHeld: { ...LimitHeld, at: NOW - ms } });
			const weekFull = planSeat({
				week: 100,
				weekFull: true,
				weekResets: NOW + DAY,
				fits: null,
			});

			it("parks past the bound with no resume tried, and it finishes", () => {
				expectParked(
					limits([heldFor(LIMIT_HOLD_BOUND_DAYS * DAY)], [], {
						seats: [{ ...weekFull, readAt: NOW - LIMIT_HOLD_BOUND_DAYS * DAY }],
					}),
					`past the ${LIMIT_HOLD_BOUND_DAYS}-day bound`,
				);
			});

			it("parks past the bound on a stand-in seat list, and not within it", () => {
				const standIn = { seats: [], seatListRead: false };
				expectParked(
					limits([heldFor(LIMIT_HOLD_BOUND_DAYS * DAY)], [], standIn),
					`past the ${LIMIT_HOLD_BOUND_DAYS}-day bound`,
				);
				const within = limits([heldFor(7 * DAY)], [], standIn);
				expect(within.launches[0]).toHaveProperty("limitHeld");
			});

			it("parks one at the failed-resume cap on a stand-in seat list (#3800)", () => {
				expectParked(
					limits([failedTo(RESUME_CAP)], [], {
						seats: [],
						seatListRead: false,
					}),
					`${RESUME_CAP} failed resumes or moves`,
				);
			});

			it("stays held within the bound, waiting on a weekly reset", () => {
				const { launches, calls } = limits([heldFor(7 * DAY)], [], {
					seats: [weekFull],
				});
				expect(launches[0]).toMatchObject({ finishedAt: null });
				expect(launches[0]).toHaveProperty("limitHeld");
				expect(launches[0]).not.toHaveProperty("parkStopped");
				expect(calls).not.toContain("stop job42");
			});
		});

		it("parks where its seat has gone from the seats read, and it finishes", () => {
			expectParked(
				limits([held()], [], { seats: otherSeat }),
				`its seat ${Seat} off the loop's seats`,
			);
		});

		it("parks though its stop fails, and logs why", () => {
			const { launches, calls } = limits([failedTo(RESUME_CAP)], [], {
				io: {
					stop: () => ({
						ok: false,
						why: "seat gone",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			});
			expect(launches[0]).toMatchObject({ parkStopped: NOW });
			expect(logs(calls).join("\n")).toContain("seat gone");
		});

		it("marks its park under the hold's session id, where the launch has none", () => {
			const { launches, calls } = limits([held({ sessionId: undefined })], [], {
				seats: otherSeat,
			});
			expect(calls).toContain("record s-job42 42");
			expect(launches[0]).toMatchObject({ sessionId: "s-job42" });
		});

		it("stays held off a damaged or empty control's stand-in seats", () => {
			const { launches, calls } = limits([held()], [], {
				seats: otherSeat,
				seatListRead: false,
			});
			expect(isHeld(launches[0] as Launch)).toBe(true);
			expect(comments(calls)).toEqual([]);
		});

		it("parks on the tick after the failure that reaches the cap", () => {
			const io = { resumeStopped: () => ({ failed: "still failing" }) };
			const failed = limits([failedTo(RESUME_CAP - 1)], [], { io });
			expect(isHeld(failed.launches[0] as Launch)).toBe(true);
			expect(failed.launches[0]?.limitHeld).toMatchObject({
				failedTries: RESUME_CAP,
			});
			const next = limits(failed.launches as Launch[], [], { io });
			expect(next.launches[0]).toMatchObject({ parkStopped: NOW });
		});

		it("resumes a try short of the cap", () => {
			const { launches, calls } = limits([failedTo(RESUME_CAP - 1)], []);
			expect(calls).toContain(`confirmed ${Seat} s-job42 ${LIMIT_PROMPT}`);
			expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
			expect(launches[0]).not.toHaveProperty("parkStopped");
		});

		it("counts a resume its record later shows failed", () => {
			const { launches } = limits(
				[held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } })],
				[],
				{ io: { jobStateOf: () => null } },
			);
			expect(launches[0]?.limitHeld).toMatchObject({ failedTries: 1 });
		});

		it("counts no resume that took, however many the launch has made", () => {
			const { launches } = limits(
				[
					held({
						limitResumes: {
							tries: RESUME_CAP + 5,
							triedAt: NOW - 60 * MIN,
							nextAt: NOW - MIN,
						},
					}),
				],
				[],
			);
			expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
			expect(launches[0]?.limitHeld).not.toHaveProperty("failedTries");
		});

		it("counts a new hold's failures from none, a resume having taken", () => {
			const { launches: settled } = limits(
				[
					held({
						limitHeld: { ...LimitHeld, resumedAt: NOW - MIN, failedTries: 3 },
					}),
				],
				[],
			);
			const reheld = limits(
				[{ ...settled[0], block: blocked().block } as Launch],
				[agent("job42", "blocked")],
				{ seats: [fiveHourFull] },
			);
			expect(isHeld(reheld.launches[0] as Launch)).toBe(true);
			expect(reheld.launches[0]?.limitHeld).not.toHaveProperty("failedTries");
		});

		it("leaves a live one alone off a seat the loop does not read", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ seats: otherSeat },
			);
			expect(launches[0]).toEqual(blocked());
			expect(comments(calls)).toEqual([]);
		});
	});

	describe("a resume that takes and re-blocks (#3792)", () => {
		const live = [agent("job42", "blocked")];
		const buildDryResumes = (
			dryResumes: number,
			over: Record<string, unknown> = {},
		) => ({
			tries: dryResumes + 1,
			triedAt: NOW - 60 * MIN,
			nextAt: NOW - MIN,
			takenAt: NOW - 60 * MIN,
			dryResumes,
			...over,
		});

		/** Each tick's act, then the next listing showing it blocked again, each
		 * tick at its next try, until it parks or `ticks` run out. */
		function reblocking(ticks: number, io: Partial<BlockIo>) {
			let launch = blocked();
			let now = NOW;
			let resumes = 0;
			for (let i = 0; i < ticks; i += 1) {
				const out = limits([launch], live, { now, io });
				launch = out.launches[0] as Launch;
				resumes += out.calls.filter((c) => c.startsWith("confirmed")).length;
				if (launch.parkStopped !== undefined) break;
				[launch] = markParked(
					[launch],
					live,
					() => ({ cause: "LIMIT" }),
					now + MIN,
				) as [Launch];
				now = launch.limitResumes?.nextAt ?? now;
			}
			return { launch, resumes };
		}

		it("parks past the bound of resumes with no reply, and it finishes", () => {
			const { launch, resumes } = reblocking(RESUME_CAP * 2, {
				hasRepliedSince: () => false,
			});
			expect(resumes).toBe(RESUME_CAP);
			expect(launch.parkStopped).toBeDefined();
			const at = launch.parkStopped as number;
			const [judged] = judgedLaunches([launch], [], at, {
				progressOf: () => ({}),
				causeOf: () => ({ cause: "LIMIT" }),
			});
			expect(judged?.finishedAt).toBe(at);
		});

		it("resumes one that replies between its blocks however many it has met", () => {
			const { launch, resumes } = reblocking(RESUME_CAP * 3, {
				hasRepliedSince: () => true,
			});
			expect(resumes).toBe(RESUME_CAP * 3);
			expect(launch.parkStopped).toBeUndefined();
			expect(launch.limitResumes?.tries).toBe(RESUME_CAP * 3);
		});

		it("clears the count on a reply, so the bound is on resumes in a row", () => {
			const { launches, calls } = limits(
				[blocked({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				live,
				{ io: { hasRepliedSince: () => true } },
			);
			expect(calls).toContain(`confirmed ${Seat} s ${LIMIT_PROMPT}`);
			expect(launches[0]?.limitResumes).not.toHaveProperty("dryResumes");
		});

		it("counts the block once, however many ticks it then waits", () => {
			const replied: number[] = [];
			const io = {
				hasRepliedSince: (_: unknown, at: number) => {
					replied.push(at);
					return false;
				},
			};
			const first = limits(
				[blocked({ limitResumes: buildDryResumes(2) })],
				live,
				{
					seats: [fiveHourFull],
					io,
				},
			);
			expect(first.launches[0]?.limitResumes).toMatchObject({ dryResumes: 3 });
			const next = limits(first.launches as Launch[], [], {
				seats: [fiveHourFull],
				io,
			});
			expect(next.launches[0]?.limitResumes).toMatchObject({ dryResumes: 3 });
			expect(replied).toHaveLength(1);
		});

		it("parks one held on a full seat once its count reaches the bound", () => {
			const { launches, calls } = limits(
				[held({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				[],
				{ seats: [fiveHourFull] },
			);
			expect(launches[0]).toMatchObject({ parkStopped: NOW });
			expect(comments(calls)[0]).toContain(
				`${RESUME_CAP} resumes or moves in a row with no reply`,
			);
		});

		it("names the cap the table parked on, for one held at both (#3800)", () => {
			const { calls } = limits(
				[
					held({
						limitHeld: { ...LimitHeld, failedTries: RESUME_CAP },
						limitResumes: buildDryResumes(RESUME_CAP),
					}),
				],
				[],
				{ seats: [fiveHourFull] },
			);
			expect(comments(calls)[0]).toContain(
				`${RESUME_CAP} failed resumes or moves`,
			);
			expect(comments(calls)[0]).not.toContain("with no reply");
		});

		it("judges nothing off an unread transcript", () => {
			const { launches, calls } = limits(
				[blocked({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				live,
				{ seats: [fiveHourFull], io: { hasRepliedSince: () => null } },
			);
			expect(launches[0]?.limitResumes).toMatchObject({
				dryResumes: RESUME_CAP - 1,
				takenAt: NOW - 60 * MIN,
			});
			expect(launches[0]).not.toHaveProperty("parkStopped");
			expect(calls).toContain("stop job42");
		});

		describe("the park's count of limit-cap parks in a row (#3804)", () => {
			const buildLaunchAtResumeCap = (over: Record<string, unknown> = {}) =>
				blocked({ limitResumes: buildDryResumes(RESUME_CAP), ...over });
			const parkOf = (launch: Launch, io: Partial<BlockIo> = {}) => {
				const counts: (number | undefined)[] = [];
				const { calls } = limits([launch], live, {
					io: {
						hasRepliedSince: () => false,
						recordParked: (_, __, ___, limitParks) => {
							counts.push(limitParks);
							return null;
						},
						...io,
					},
				});
				return { counts, calls };
			};
			const comment = (calls: string[]) =>
				calls.find((c) => c.startsWith("comment ")) ?? "";

			it("counts a first park as one, and leaves the ticket to relaunch", () => {
				const { counts, calls } = parkOf(buildLaunchAtResumeCap());
				expect(counts).toEqual([1]);
				expect(comment(calls)).not.toContain("will not relaunch");
			});

			it("counts on from the parks its launch came back from, and says at the cap that relaunches end", () => {
				const { counts, calls } = parkOf(
					buildLaunchAtResumeCap({ limitParks: LIMIT_PARK_CAP - 1 }),
				);
				expect(counts).toEqual([LIMIT_PARK_CAP]);
				expect(comment(calls)).toContain(buildLimitCapText(LIMIT_PARK_CAP));
			});

			it("promises no end to relaunches where the marker holding the count went unwritten", () => {
				const { calls } = parkOf(
					buildLaunchAtResumeCap({ limitParks: LIMIT_PARK_CAP - 1 }),
					{
						recordParked: () => "EACCES",
					},
				);
				expect(comment(calls)).not.toContain("will not relaunch");
			});

			it("starts again where the launch replied since it began", () => {
				const seen: number[] = [];
				const launchedAt = NOW - 3 * 60 * MIN;
				const { counts } = parkOf(
					buildLaunchAtResumeCap({
						limitParks: LIMIT_PARK_CAP - 1,
						launchedAt,
					}),
					{
						hasRepliedSince: (_, at) => {
							seen.push(at);
							return at === launchedAt;
						},
					},
				);
				expect(counts).toEqual([1]);
				expect(seen).toContain(launchedAt);
			});

			it("counts on over an unread transcript, which cannot lift the bound", () => {
				const { counts } = parkOf(buildLaunchAtResumeCap({ limitParks: 1 }), {
					hasRepliedSince: () => null,
				});
				expect(counts).toEqual([2]);
			});

			it("counts no park off a dropped seat, which routes afresh", () => {
				const counts: (number | undefined)[] = [];
				limits(
					[
						blocked({
							limitParks: 1,
							limitHeld: { at: NOW - MIN, sessionId: "s1", cwd: "/r" },
						}),
					],
					[],
					{
						seats: [planSeat({ seat: "/other" })],
						io: {
							recordParked: (_, __, ___, limitParks) => {
								counts.push(limitParks);
								return null;
							},
						},
					},
				);
				expect(counts).toEqual([undefined]);
			});
		});

		it("keeps the count through a resume that runs as a copy", () => {
			const { launches } = limits(
				[blocked({ limitResumes: buildDryResumes(3) })],
				live,
				{
					io: {
						resumeStopped: () => ({
							failed: null,
							jobId: "job99",
							sessionId: "s2",
							copy: true,
						}),
					},
				},
			);
			expect(launches[0]).toMatchObject({
				jobId: "job99",
				limitResumes: { dryResumes: 4, takenAt: NOW },
			});
		});

		it("keeps the count through a resume that fails", () => {
			const { launches } = limits(
				[held({ limitResumes: buildDryResumes(3) })],
				[],
				{
					io: { resumeStopped: () => ({ failed: "no" }) },
				},
			);
			expect(launches[0]?.limitResumes).toMatchObject({
				dryResumes: 4,
				failed: "no",
			});
			expect(launches[0]?.limitResumes).not.toHaveProperty("takenAt");
		});

		it("stays blocked and logs why where a live one's stop fails, and parks once it holds", () => {
			const stuck = [blocked({ limitResumes: buildDryResumes(RESUME_CAP) })];
			const { launches, calls } = limits(stuck, live, {
				io: {
					stop: () => ({
						ok: false,
						why: "seat busy",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			});
			expect(launches[0]).not.toHaveProperty("parkStopped");
			expect(comments(calls)).toEqual([]);
			expect(logs(calls).join("\n")).toContain("seat busy");
			const parked = limits(launches as Launch[], live);
			expect(parked.launches[0]).toMatchObject({ parkStopped: NOW });
			expect(parked.workingChange).toBe(-1);
		});
	});

	describe("a resume judged a tick on", () => {
		const resumed = () =>
			held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } });

		it("goes back to held, named, where its record reads failed (#2159)", () => {
			const { launches, calls, slots } = limits([resumed()], [], {
				io: {
					jobStateOf: () => ({ state: "failed", detail: "source not found" }),
				},
			});
			expect(launches[0]?.limitHeld).not.toHaveProperty("resumedAt");
			expect(isHeld(launches[0] as Launch)).toBe(true);
			expect(comments(calls)[0]).toContain(
				"state failed after its resume: source not found",
			);
			expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
			expect(slots).toBe(1);
		});

		it("goes back to held where its record is unread", () => {
			const { launches } = limits([resumed()], [], {
				io: { jobStateOf: () => null },
			});
			expect(isHeld(launches[0] as Launch)).toBe(true);
		});

		it("is let go on any other reading, for the listing to judge", () => {
			const { launches, calls } = limits([resumed()], [], {
				io: { jobStateOf: () => ({ state: "done" }) },
			});
			expect(launches[0]).not.toHaveProperty("limitHeld");
			expect(launches[0]).not.toHaveProperty("block");
			expect(comments(calls)).toEqual([]);
		});
	});

	describe("the dispatch-ledger hold", () => {
		const seats = [fiveHourFull];

		it("is written on the tick a session is held", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ seats },
			);
			const until = NOW + LIMIT_HOLD_BOUND_DAYS * DAY;
			expect(calls).toContain(`ledger job42 ${until}`);
			expect(launches[0]?.limitHeld).toMatchObject({ ledgerHeldUntil: until });
		});

		it("is written once, as it outlasts the run", () => {
			const written = held({
				limitHeld: { ...LimitHeld, ledgerHeldUntil: NOW + DAY },
			});
			expect(limits([written], [], { seats }).calls).toEqual([]);
		});

		it("is logged where the write fails, and tried again next tick", () => {
			const { launches, calls } = limits([held()], [], {
				seats,
				io: { writeLedgerHold: () => false },
			});
			expect(logs(calls).join("\n")).toContain("dispatch-ledger hold");
			expect(launches[0]?.limitHeld).not.toHaveProperty("ledgerHeldUntil");
		});

		describe("once the hold ends", () => {
			const holding = held({
				limitHeld: { ...LimitHeld, ledgerHeldUntil: NOW + DAY },
			});
			const released = (
				after: Launch[],
				before: Launch[] = [holding],
				ok = true,
			) => {
				const calls: string[] = [];
				releaseEndedHolds(before, after, {
					release: (l) => {
						calls.push(`release ${l.jobId}`);
						return ok;
					},
					writeLedgerHold: (l, until) => {
						calls.push(`row ${l.jobId} ${until}`);
						return true;
					},
					log: (line) => calls.push(`log ${line}`),
				});
				return calls;
			};

			it("is released on a launch gone off the hold, its running session taking an ordinary row", () => {
				const { limitHeld: _, ...ended } = holding;
				expect(released([ended])).toEqual([
					"release job42",
					"row job42 undefined",
				]);
			});

			it("takes no row where the launch parked or finished", () => {
				const { limitHeld: _, ...ended } = holding;
				for (const over of [{ parkStopped: NOW }, { finishedAt: NOW }])
					expect(released([{ ...ended, ...over }])).toEqual(["release job42"]);
			});

			it("comes back where a resume that gave it up fails", () => {
				const unjudged = { ...LimitHeld, resumedAt: NOW - MIN };
				const failed = limits([held({ limitHeld: unjudged })], [], {
					io: { jobStateOf: () => ({ state: "failed", detail: "no" }) },
				});
				expect(failed.calls).toContain(
					`ledger job42 ${Since + LIMIT_HOLD_BOUND_DAYS * DAY}`,
				);
				expect(failed.launches[0]?.limitHeld).toMatchObject({
					ledgerHeldUntil: Since + LIMIT_HOLD_BOUND_DAYS * DAY,
				});
			});

			it("is kept on one still held, a copy included", () => {
				expect(released([holding])).toEqual([]);
				const copy = { ...holding, jobId: "job99", copiedFrom: "job42" };
				expect(released([copy])).toEqual([]);
			});

			it("is left alone on one whose hold was never written", () => {
				const { limitHeld: _, ...ended } = held();
				expect(released([ended], [held()])).toEqual([]);
			});

			it("names how long its issues wait where the release fails", () => {
				const { limitHeld: _, ...ended } = holding;
				expect(released([ended], [holding], false).join("\n")).toContain(
					new Date(NOW + DAY).toISOString(),
				);
			});
		});
	});

	describe("a stop's line for a held launch", () => {
		const text = (limitHeld: object) =>
			buildHeldStopText(
				held({ limitHeld: { ...LimitHeld, ...limitHeld } }) as never,
			);

		it("names the session, its seat, and how long its ticket is held", () => {
			const line = text({ ledgerHeldUntil: NOW + DAY });
			expect(line).toContain("job42");
			expect(line).toContain(buildSeatName(held().seat));
			expect(line).toContain(
				`held from dispatch until ${new Date(NOW + DAY).toISOString()}`,
			);
		});

		it("says a session resumed and unjudged is that, not stopped", () => {
			const line = text({ resumedAt: NOW });
			expect(line).toContain(`resumed at ${new Date(NOW).toISOString()}`);
			expect(line).not.toContain("stopped at");
		});

		it("says a direct dispatch may take the ticket where no hold was written", () => {
			expect(text({})).toContain("a direct dispatch may take its ticket");
		});
	});

	it("logs a held one whose seat reads open, waiting on a slot", () => {
		const { calls } = limits([held()], [], { slots: 0 });
		expect(logs(calls).join("\n")).toContain("waits on a free slot");
	});

	it("reads no seat with none limit-blocked", () => {
		const { io } = fakeIo();
		const out = actOnLimits([record()], "away", {
			agents: [],
			now: NOW,
			io,
			swapHold: NO_HOLD,
			typedSeat: null,
			readMoveSeats: () => {
				throw new Error("read");
			},
			seatListRead: true,
			slots: 2,
		});
		expect(out).toMatchObject({ slots: 2, workingChange: 0 });
	});

	describe("the tick's working figure (#3778)", () => {
		const Open = { seats: [planSeat()] };
		const FailedResume = { resumeStopped: () => ({ failed: "no" }) };
		const live = [agent("job42", "blocked")];
		it.each<[string, () => { workingChange: number }, number]>([
			["a held one resumed adds one", () => limits([held()], [], Open), 1],
			[
				"a live one stopped for its limit takes one off",
				() => limits([blocked()], live, { seats: [fiveHourFull] }),
				-1,
			],
			[
				"a live one resumed in place moves nothing",
				() => limits([blocked()], live, Open),
				0,
			],
			[
				"a held one staying held moves nothing",
				() => limits([held()], [], { seats: [fiveHourFull] }),
				0,
			],
			[
				"a held one whose resume failed moves nothing",
				() =>
					limits([held()], [], {
						...Open,
						io: FailedResume,
					}),
				0,
			],
			[
				"a live one whose resume failed after its stop takes one off",
				() =>
					limits([blocked()], live, {
						...Open,
						io: FailedResume,
					}),
				-1,
			],
			[
				"a live one whose stop failed moves nothing",
				() =>
					limits([blocked()], live, {
						seats: [fiveHourFull],
						io: {
							stop: () => ({
								ok: false,
								why: "no",
								said: null,
								timedOut: false,
								noJob: false,
							}),
						},
					}),
				0,
			],
			[
				"last tick's resume, judged now, moves nothing",
				() =>
					limits(
						[held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } })],
						[],
						Open,
					),
				0,
			],
		])("%s", (_, run, change) => {
			expect(run().workingChange).toBe(change);
		});
	});

	it("a live one whose resume failed after its stop is held, its target kept", () => {
		const { launches } = limits([blocked()], [agent("job42", "blocked")], {
			io: { resumeStopped: () => ({ failed: "no" }) },
		});
		expect(launches[0]).toMatchObject({
			limitHeld: { sessionId: "s", cwd: "/" },
		});
	});

	it("a failed stop leaves it live, named, and never resumes", () => {
		const { launches, calls } = limits(
			[blocked()],
			[agent("job42", "blocked")],
			{
				io: {
					stop: () => ({
						ok: false,
						why: "exit 1",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			},
		);
		expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
		expect(launches[0]).not.toHaveProperty("limitHeld");
		expect(comments(calls)[0]).toContain("stop: exit 1");
	});

	it("tracks a resume the launcher ran as a copy as the same launch", () => {
		const { launches, calls } = limits([held()], [], {
			io: {
				resumeStopped: () => ({
					failed: null,
					jobId: "copy1",
					sessionId: "s-copy",
					copy: true,
				}),
			},
		});
		expect(launches[0]).toMatchObject({
			jobId: "copy1",
			copiedFrom: "job42",
			sessionId: "s-copy",
			pastSessionIds: ["s-job42"],
		});
		expect(comments(calls)[0]).toContain("as its copy copy1");
	});

	it("an adopter's one seat, no overflow: hold, then resume in place at reset", () => {
		const first = limits([blocked()], [agent("job42", "blocked")], {
			seats: [fiveHourFull],
		});
		expect(isHeld(first.launches[0] as Launch)).toBe(true);
		const waiting = limits(first.launches as Launch[], [], {
			seats: [fiveHourFull],
		});
		expect(waiting.calls).toEqual([]);
		const reset = limits(first.launches as Launch[], []);
		expect(reset.calls).toContain(`confirmed ${Seat} s ${LIMIT_PROMPT}`);
		expect(reset.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
	});

	describe("a move to another seat (#3734)", () => {
		const other = () => planSeat({ seat: "/other" });
		const moveLine = (from: string, to: string) => `move job42 ${from} ${to} s`;

		it.each(["away", "normal"] as const)(
			"%s: stops it, moves it, rewrites seat and reason, comments once",
			(mode) => {
				const { launches, calls } = limits(
					[blocked()],
					[agent("job42", "blocked")],
					{ seats: [fiveHourFull, other()], mode },
				);
				expect(calls.indexOf("stop job42")).toBeLessThan(
					calls.indexOf(moveLine(Seat, "/other")),
				);
				expect(launches[0]).toMatchObject({
					seat: "/other",
					reason: `moved from ${Seat}`,
					jobId: "job42",
					relaunchedAt: NOW,
					limitHeld: { resumedAt: NOW, movedFrom: { seat: Seat } },
				});
				expect(comments(calls)).toHaveLength(1);
				expect(comments(calls)[0]).toContain(`from ${Seat} to /other`);
				expect(comments(calls)[0]).toContain("5-hour limit");
				expect(comments(calls)[0]).toContain("Lost: its in-flight subagents");
			},
		);

		it("moves a held one as another seat opens, unstopped, taking a slot", () => {
			const { launches, calls, slots, workingChange } = limits([held()], [], {
				seats: [fiveHourFull, other()],
				slots: 1,
			});
			expect(calls).not.toContain("stop job42");
			expect(calls).toContain(`move job42 ${Seat} /other s-job42`);
			expect(launches[0]).toMatchObject({ seat: "/other" });
			expect(slots).toBe(0);
			expect(workingChange).toBe(1);
		});

		it("leaves a failed move held on its old seat, naming why in the log and a comment", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{
					seats: [fiveHourFull, other()],
					io: { moveSession: () => ({ failed: "state failed: nope" }) },
				},
			);
			expect(launches[0]).toMatchObject({
				seat: Seat,
				limitHeld: { failedTries: 1, sessionId: "s" },
			});
			expect(launches[0].limitHeld).not.toHaveProperty("resumedAt");
			expect(launches[0]).not.toHaveProperty("relaunchedAt");
			expect(logs(calls).join("\n")).toContain("state failed: nope");
			expect(comments(calls)[0]).toContain("could not move");
			expect(comments(calls)[0]).toContain("state failed: nope");
		});

		it("takes a failed move's resume back to the old seat a tick on", () => {
			const moved = limits(
				[blocked({ reason: "last typed on" })],
				[agent("job42", "blocked")],
				{ seats: [fiveHourFull, other()] },
			).launches as Launch[];
			const { launches, calls } = limits(moved, [], {
				seats: [fiveHourFull, other()],
				io: { jobStateOf: () => ({ state: "failed", detail: "nope" }) },
			});
			expect(launches[0]).toMatchObject({
				seat: Seat,
				reason: "last typed on",
			});
			expect(launches[0].limitHeld).not.toHaveProperty("movedFrom");
			expect(comments(calls)[0]).toContain("could not move");
		});

		it("settles a move that took, and stops address its new seat", () => {
			const moved = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			}).launches as Launch[];
			const { launches, calls } = limits(moved, [], {
				seats: [fiveHourFull, other()],
			});
			expect(calls).toContain(`rm on ${Seat}`);
			expect(launches[0]).toMatchObject({ seat: "/other", finishedAt: null });
			expect(launches[0]).not.toHaveProperty("limitHeld");
			const stops: string[] = [];
			const again = limits(
				[{ ...launches[0], parked: true, block: blocked().block } as Launch],
				[agent("job42", "blocked")],
				{
					seats: [fiveHourFull, { ...fiveHourFull, seat: "/other" }],
					io: {
						stop: (seat, id) => {
							stops.push(`${seat} ${id}`);
							return { ok: true, said: "" };
						},
					},
				},
			);
			expect(again.launches[0]).toHaveProperty("limitHeld");
			expect(stops).toEqual(["/other job42"]);
		});

		it("dates a moved session's block at the move, keeps the seat it left, and spaces no next move", () => {
			const { launches } = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			});
			expect(launches[0]).toMatchObject({
				block: { since: NOW },
				limitLeft: [{ seat: Seat, since: Since }],
				limitResumes: { nextAt: NOW },
			});
		});

		it("stops a resume that reads failed a tick on, before going back", () => {
			const moved = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			}).launches as Launch[];
			const stops: string[] = [];
			limits(moved, [], {
				seats: [fiveHourFull, other()],
				io: {
					jobStateOf: () => null,
					stop: (seat) => {
						stops.push(seat);
						return { ok: true, said: "" };
					},
				},
			});
			expect(stops).toEqual(["/other"]);
		});

		it("takes one move per seat a tick, the seat being sized for one", () => {
			const twin = blocked({ jobId: "job43" });
			const { launches, calls } = limits(
				[blocked(), twin],
				[agent("job42", "blocked"), agent("job43", "blocked")],
				{ seats: [fiveHourFull, other()] },
			);
			expect(calls.filter((c) => c.startsWith("move "))).toHaveLength(1);
			expect(launches[1]).toMatchObject({
				seat: Seat,
				limitHeld: { sessionId: "s" },
			});
		});
	});

	it("acts on nothing off an unread listing, nor a launch on no plan seat", () => {
		expect(limits([blocked()], null).calls).toEqual([]);
		expect(
			limits([blocked({ seat: "/api" })], [agent("job42", "blocked")]).calls,
		).toEqual([]);
	});

	it("keeps a held launch through a listing that drops it or shows it ended", () => {
		const causeOf = () => ({ cause: "LIMIT" as const });
		for (const agents of [[], [agent("job42", "stopped")]]) {
			const [l] = markParked([held()], agents, causeOf, NOW);
			expect(l).toMatchObject({ limitHeld: LimitHeld, finishedAt: null });
		}
	});

	it("lets go of one the listing shows live again", () => {
		const causeOf = () => ({ cause: "LIMIT" as const });
		const [l] = markParked([held()], [agent("job42", "working")], causeOf, NOW);
		expect(l).not.toHaveProperty("limitHeld");
	});

	it("leaves the other acts' pass alone: actOnBlocks takes no limit block", () => {
		const { calls } = blocks([blocked()], [agent("job42", "blocked")], "away");
		expect(calls).toEqual([]);
	});

	it("reads a held one neither resumed-idle nor owed anything by actOnIdle", () => {
		const { io, calls } = fakeIo({ idleSince: () => NOW - 60 * MIN });
		actOnIdle([held()], "away", {
			agents: [],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		});
		expect(calls).toEqual([]);
	});
});

describe("queueing the sessions parked on a lifted repo hold (#3863)", () => {
	const hold = {
		root: "/repo",
		dir: "/store/lifted/abc-1",
		id: "abc",
		recordJobs: ["p"],
		jobs: ["p"],
	};
	const marker = {
		issues: [7],
		job: { seat: "/seat", jobId: "p", cwd: "/repo" },
		sessionId: "s-p",
		writtenAt: NOW - MIN,
	};
	const queue = (agents: Agents, over: Partial<BlockIo>) => {
		const { io, calls } = fakeIo({ readParkMarkers: () => [marker], ...over });
		return {
			out: queueLifted([], [hold], { agents, now: NOW, io, swapHold: NO_HOLD }),
			calls,
		};
	};

	it("keeps a session whose stop failed for the next tick, not yet due", () => {
		const { out, calls } = queue([agent("p", "blocked")], {
			stop: () => ({
				ok: false,
				why: "refused",
				said: null,
				timedOut: false,
				noJob: false,
			}),
		});
		expect(out.launches).toEqual([]);
		expect(out.settled).toEqual([{ hold, jobs: [] }]);
		expect(logs(calls)).toEqual([
			"could not stop session p, parked on repo hold abc now cleared, the next tick retries: refused",
		]);
	});

	it("counts a session the loop never launched only from its resume, a known launch as it stood (#3942)", () => {
		const readActsBefore = (root: string, sessionId: string) => ({
			[`${root} ${sessionId}`]: 2,
		});
		const { out } = queue([agent("p", "stopped")], { readActsBefore });
		expect(out.launches[0]).toMatchObject({
			sessionId: "s-p",
			actsBefore: { "/repo s-p": 2 },
		});
		const { io } = fakeIo({
			readParkMarkers: () => [marker],
			readActsBefore,
		});
		const known = {
			...record(),
			root: "/repo",
			issues: [7],
			jobId: "p",
			sessionId: "s-p",
		};
		const { launches } = queueLifted([known], [hold], {
			agents: [agent("p", "stopped")],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		});
		expect(launches[0]).not.toHaveProperty("actsBefore");
	});

	it("judges nothing off a marker directory that will not read", () => {
		const { out } = queue([agent("other", "working")], {
			readParkMarkers: () => null,
		});
		expect(out).toEqual({ launches: [], settled: [] });
	});

	it("judges nothing off an unread listing", () => {
		const { out, calls } = queue(null, {});
		expect(out).toEqual({ launches: [], settled: [] });
		expect(calls).toEqual([]);
	});

	it("queues one session once, however many lifts name it", () => {
		const { io } = fakeIo({ readParkMarkers: () => [marker] });
		const out = queueLifted([], [hold, { ...hold, id: "def" }], {
			agents: [agent("other", "working")],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		});
		expect(ids(out.launches)).toEqual(["p"]);
		expect(out.settled.map((s) => s.jobs)).toEqual([["p"], ["p"]]);
	});

	it("leaves alone a session listed live, and one no marker lists", () => {
		const live = queue([agent("p", "working")], {});
		expect(live.out.launches).toEqual([]);
		expect(live.out.settled).toEqual([{ hold, jobs: ["p"] }]);

		const answered = queue([agent("other", "working")], {
			readParkMarkers: () => [],
		});
		expect(answered.out.launches).toEqual([]);
		expect(answered.out.settled).toEqual([{ hold, jobs: ["p"] }]);
	});

	it("stops a session its blocked round holds, then queues it", () => {
		const { out, calls } = queue([agent("p", "blocked")], {});
		expect(calls).toContain("stop p");
		expect(out.launches[0]).toMatchObject({
			jobId: "p",
			finishedAt: null,
			holdCleared: { sessionId: "s-p", cwd: "/repo", tries: 0, hold: "abc" },
		});
	});

	const due = () =>
		record({
			jobId: "p",
			holdCleared: {
				at: NOW - MIN,
				sessionId: "s-p",
				cwd: "/repo",
				tries: 0,
				hold: "abc",
			},
		});

	it("finishes one due back that its marker no longer lists", () => {
		const { io } = fakeIo({ readParkMarkers: () => [] });
		const out = queueLifted([due()], [], {
			agents: [agent("other", "working")],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		});
		expect(out.launches[0]).toMatchObject({ finishedAt: NOW });
		expect(out.launches[0]).not.toHaveProperty("holdCleared");
	});

	const queueOn = (launches: Launch[]) => {
		const { io, calls } = fakeIo({ readParkMarkers: () => [marker] });
		return {
			out: queueLifted(launches, [hold], {
				agents: [agent("other", "working")],
				now: NOW,
				io,
				swapHold: NO_HOLD,
			}),
			calls,
		};
	};

	it("takes up a job's newest record alone, so one session resumes once", () => {
		const older = record({ jobId: "p", root: "/repo", finishedAt: NOW - MIN });
		const newer = record({ jobId: "p", root: "/repo", finishedAt: NOW - MIN });
		const { out } = queueOn([older, newer]);
		expect(out.launches[0]).toBe(older);
		expect(out.launches[1]).toHaveProperty("holdCleared");
		const { io, calls } = fakeIo();
		const seen = {
			agents: [agent("other", "working")],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		};
		const stepped = resumeHeldLaunches(
			resumableOf(out.launches, seen),
			out.launches,
			seen,
			() => false,
		);
		expect(stepped.started).toBe(1);
		expect(calls.filter((c) => c.startsWith("resume "))).toHaveLength(1);
		expect(stepped.launches[0]).toBe(older);
	});

	it("leaves one handed off, and one whose ticket another live launch holds", () => {
		const handed = queueOn([
			record({ jobId: "p", handedOff: NOW, finishedAt: NOW }),
		]);
		expect(handed.out.launches[0]).not.toHaveProperty("holdCleared");
		expect(handed.out.settled).toEqual([{ hold, jobs: ["p"] }]);

		const held = queueOn([
			record({ jobId: "fresh", root: "/repo", issues: [7] }),
		]);
		expect(ids(held.out.launches)).toEqual(["fresh"]);
		expect(held.out.settled).toEqual([{ hold, jobs: ["p"] }]);
		expect(logs(held.calls).join()).toContain("now holds its ticket");
	});

	it("carries every issue its marker lists, wider than its launch's", () => {
		const { out } = queueOn([
			record({ jobId: "p", issues: [5], finishedAt: NOW - MIN }),
		]);
		expect(out.launches[0]?.issues).toEqual([5, 7]);
	});

	it("waits out a swap hold like any other stopped session", () => {
		const { io } = fakeIo();
		const seen = { agents: [agent("other", "working")], now: NOW, io };
		expect(
			resumableOf([due()], { ...seen, swapHold: { held: true } as never }),
		).toEqual([]);
		expect(resumableOf([due()], { ...seen, swapHold: NO_HOLD })).toHaveLength(
			1,
		);
	});

	it("takes the label off a session once it has gone back, resumed or handed off", () => {
		const unparked: string[] = [];
		const unparkSession: BlockIo["unparkSession"] = (_, sid) => {
			unparked.push(sid);
			return null;
		};
		const { io } = fakeIo({ unparkSession });
		const seen = {
			agents: [agent("other", "working")],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		};
		const resumes = resumableOf([due()], seen);
		resumeHeldLaunches(resumes, [due()], seen, () => false);
		expect(unparked).toEqual(["s-p"]);
	});
});
