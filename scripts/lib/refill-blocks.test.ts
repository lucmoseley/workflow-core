// @vitest-environment node
/*
 * The refill loop's acts on blocked and resumed-idle launches (#2848),
 * through actOnBlocks and actOnIdle with a fake BlockIo that records each
 * call. refill-loop-run.test.ts drives the program's own BlockIo end to end.
 *
 * Loosen one and a park is stopped off an unread listing or twice, an
 * API-error session resumed twice for one try, before it is due, or past its
 * cap, or held mid-retry, or a resumed-idle one stopped before its two
 * typed resumes, or its count lost across a tick that would not read, or
 * a parked session resumed by the loop that stopped it.
 */
import { describe, expect, it } from "vitest";
import { RESUME_CAP } from "./block-act.js";
import {
	type IdleReading,
	resumedIdleSince,
	turnedSince,
} from "./block-cause.js";
import { actOnBlocks, actOnIdle } from "./refill-blocks.js";

const MIN = 60 * 1000;
const NOW = Date.parse("2026-10-18T12:00:00Z");
const API_PROMPT =
	"resume — your last turn ended on an API error. Before repeating your last tool call, check whether it already took effect.";

type Launch = import("./refill-loop.js").LoopLaunch;
type Cause = import("./block-cause.js").Cause;
type BlockIo = import("./refill-blocks.js").BlockIo;
type Agents = import("./refill-blocks.js").Tick["agents"];

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

/** A BlockIo whose every act succeeds unless `over` says otherwise, and
 * `calls`, what it was asked, in order. */
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
		readTimeline: () => [],
		idleSince: () => null,
		turnedSince: () => false,
		labelParked: () => [],
		comment: (_, body) => calls.push(`comment ${body}`),
		postHandOff: (l) => {
			calls.push(`hand-off ${l.jobId}`);
			return { failed: null, out: "" };
		},
		release: () => true,
		progressOf: () => ({}),
		log: (line) => calls.push(`log ${line}`),
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
	return { out: actOnBlocks(launches, mode, { agents, now, io }), calls };
}

const ids = (ls: Launch[]) => ls.map((l) => l.jobId);

describe("which parks the loop stops (#2699)", () => {
	const parkedFor = (cause: Cause, minutes: number, over = {}) =>
		record({
			jobId: "p",
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

	it("stops a normal-mode park only after 60 min unanswered", () => {
		expect(stops(parkedFor("QUESTION", 59), "normal")).toEqual([]);
		expect(stops(parkedFor("PERMISSION", 60), "normal")).toEqual(["p"]);
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
		expect(fellBack([row(NOW - MIN, "resume — your last…")])).toBe(false);
		expect(fellBack([row(NOW - 3 * MIN, API_PROMPT)])).toBe(true);
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
		}: {
			mode?: "away" | "normal";
			agents?: Agents;
			io?: Partial<BlockIo>;
		} = {},
	) => {
		const { io, calls } = fakeIo({ idleSince: idleFor(minutes), ...over });
		const [out] = actOnIdle([l], mode, { agents, now: NOW, io });
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
			turnedSince: (_, at) => turnedSince(seen, at),
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
			io: { turnedSince: () => true },
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
			{ turnedSince: landing(false, true) },
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
});
