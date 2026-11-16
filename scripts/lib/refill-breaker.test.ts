// @vitest-environment node
/*
 * lib/refill-breaker.js — the per-checkout throughput breaker (#5275). Broken,
 * it refills a repo whose sessions have stopped landing, or it trips on workflow-core's quiet hours, or a
 * restart forgets it is open.
 *
 * The replays step the breaker each quarter hour over two fixtures cut from the real job
 * timelines and `origin/main` (scripts/fixtures/refill-breaker-*.json),
 * each row kept wherever dropping it would change an hour-capped span.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLookbackOf,
	foldBreakerAt,
	stepBreakers,
	workingMsOf,
} from "./refill-breaker.js";

type BreakerEvent = import("./refill-breaker.js").BreakerEvent;
type ThroughputRead = import("./refill-breaker.js").ThroughputRead;
type BreakerLaunch = import("./refill-breaker.js").BreakerLaunch;

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-15T19:00:00Z");
const DV = "/h/design-vault";
const iso = (ms: number) => new Date(ms).toISOString();

interface Fixture {
	commits: string[];
	sessions: { rows: [string, string][]; endAt: string }[];
}
const DV_NIGHT = path.join(
	__dirname,
	"..",
	"fixtures",
	"refill-breaker-design-vault-2026-11-15.json",
);
const WFC_DIPS = path.join(
	__dirname,
	"..",
	"fixtures",
	"refill-breaker-workflow-core-dips.json",
);
const fixture = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
/**
 * The fixture's night stepped through the breaker each quarter hour in
 * [from, to], as the loop's ticks would: each session a launch from its first
 * row to its end, unfinished until then, the record carried tick to tick.
 * Each tick's events and the room it left.
 */
function replay(f: Fixture, from: string, to: string) {
	const root = "/h/replayed";
	const sessions = f.sessions.map((s, i) => ({
		rows: s.rows.map(([at, state]) => ({ at, state })),
		launch: {
			root,
			seat: "/seat",
			issues: [i],
			jobId: `j${i}`,
			sessionId: `s${i}`,
			launchedAt: Date.parse(s.rows[0]?.[0] ?? s.endAt),
			endAt: Date.parse(s.endAt),
		},
	}));
	const commits = f.commits.map((c, i) => ({
		sha: `c${i}`,
		at: Date.parse(c),
	}));
	const record: BreakerEvent[] = [];
	const ticks: {
		at: string;
		events: BreakerEvent[];
		room?: number;
		running: number;
	}[] = [];
	for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * MIN) {
		const launches = sessions
			.filter((s) => s.launch.launchedAt <= t)
			.map(({ launch: { endAt, ...l } }) => ({
				...l,
				finishedAt: endAt <= t ? endAt : null,
			}));
		const { events, room } = stepBreakers({
			roots: [root],
			launches,
			now: t,
			read: {
				byRoot: {
					[root]: {
						commits: commits.filter((c) => c.at <= t),
						gateRuns: [],
						sessions: sessions
							.filter((s) => s.launch.launchedAt <= t)
							.map((s) => ({
								rows: s.rows,
								endAt: Math.min(s.launch.endAt, t),
							})),
					},
				},
				commitsOf: () => [],
				queueOf: () => ({ state: "gone" }),
				record,
			},
		});
		record.push(...events);
		ticks.push({
			at: iso(t),
			events,
			room: room[root],
			running: launches.filter((l) => l.finishedAt === null).length,
		});
	}
	return ticks;
}

describe("the replays (#5250's measurement)", () => {
	it("opens on design-vault's night of 2026-11-15 at 19:00Z, and blocks the night's later launches", () => {
		const ticks = replay(
			fixture(DV_NIGHT),
			"2026-11-15T09:00:00Z",
			"2026-11-16T06:00:00Z",
		);
		const opened = ticks.findIndex((t) => t.events.length > 0);
		expect(ticks[opened]).toMatchObject({
			at: "2026-11-15T19:00:00.000Z",
			events: [expect.objectContaining({ event: "open" })],
			room: 0,
		});
		const after = ticks.slice(opened);
		expect(after.every((t) => t.room !== undefined)).toBe(true);
		expect(after.filter((t) => t.running > 0).every((t) => t.room === 0)).toBe(
			true,
		);
		expect(after.every((t) => (t.room ?? 0) <= 1)).toBe(true);
		expect(after.flatMap((t) => t.events).map((e) => e.event)).not.toContain(
			"close",
		);
	});

	it("does not trip in any of workflow-core's four overnight dips", () => {
		const { windows } = fixture(WFC_DIPS);
		expect(windows).toHaveLength(4);
		for (const w of windows)
			expect(replay(w, w.from, w.to).flatMap((t) => t.events)).toEqual([]);
	});
});

describe("working time", () => {
	const rows = (...r: [number, string][]) =>
		r.map(([at, state]) => ({ at: iso(NOW + at * MIN), state }));

	it("counts working and running rows to the next row, and no blocked, done or stopped one", () => {
		const s = {
			rows: rows(
				[0, "working"],
				[10, "blocked"],
				[20, "running"],
				[30, "stopped"],
				[40, "done"],
			),
			endAt: NOW + 50 * MIN,
		};
		expect(workingMsOf([s], NOW, NOW + HOUR)).toBe(20 * MIN);
	});

	it("caps a row's span at an hour of silence, its last row's included", () => {
		const s = {
			rows: rows([0, "working"], [180, "working"]),
			endAt: NOW + 400 * MIN,
		};
		expect(workingMsOf([s], NOW, NOW + 10 * HOUR)).toBe(2 * HOUR);
	});

	it("clips each span to the window", () => {
		const s = { rows: rows([0, "working"]), endAt: NOW + 30 * MIN };
		expect(workingMsOf([s], NOW + 10 * MIN, NOW + 20 * MIN)).toBe(10 * MIN);
	});
});

/** `n` launches into DV, each working every half hour from `from` to now. */
const busy = (
	n: number,
	from = NOW - 6 * HOUR,
	over: Partial<BreakerLaunch> = {},
) =>
	Array.from({ length: n }, (_, i) => ({
		root: DV,
		seat: "/seat",
		issues: [400 + i],
		jobId: `j${i}`,
		sessionId: `s${i}`,
		launchedAt: from,
		finishedAt: null,
		...over,
	}));

const working = (from: number, to: number) => ({
	rows: Array.from({ length: Math.ceil((to - from) / (30 * MIN)) }, (_, i) => ({
		at: iso(from + i * 30 * MIN),
		state: "working",
	})),
	endAt: to,
});

type SessionTimeline = import("./refill-breaker.js").SessionTimeline;
/** Read as each launch `step` is given working from its launch to its end. */
const FROM_LAUNCHES: SessionTimeline[] = [];

const readOf = (
	over: Partial<ThroughputRead> & {
		commits?: { sha: string; at: number }[] | null;
		sessions?: SessionTimeline[];
	} = {},
): ThroughputRead => {
	const {
		commits = [{ sha: "a", at: NOW - HOUR }],
		sessions = FROM_LAUNCHES,
		...rest
	} = over;
	return {
		byRoot: { [DV]: { commits, gateRuns: [], sessions } },
		commitsOf: () => [],
		queueOf: () => {
			throw new Error("the queue ref read where no trial asked for it");
		},
		record: [],
		...rest,
	};
};

const event = (
	name: BreakerEvent["event"],
	at: number,
	over: Partial<BreakerEvent> = {},
): BreakerEvent => ({
	at: iso(at),
	repo: DV,
	event: name,
	rate: 0.1,
	workingHours: 14,
	...over,
});

const step = (launches: BreakerLaunch[], read: ThroughputRead, now = NOW) => {
	const of = read.byRoot[DV];
	const byRoot =
		of?.sessions === FROM_LAUNCHES
			? {
					[DV]: {
						...of,
						sessions: launches.map((l) =>
							working(l.launchedAt, l.finishedAt ?? now),
						),
					},
				}
			: read.byRoot;
	return stepBreakers({
		roots: [DV],
		launches,
		read: { ...read, byRoot },
		now,
	});
};

describe("the breaker's steps", () => {
	it("opens at 12 working hours under 0.3, barring the checkout while its sessions run", () => {
		const { events, room } = step(busy(3), readOf());
		expect(events).toEqual([
			expect.objectContaining({
				repo: DV,
				event: "open",
				at: iso(NOW),
				workingHours: 18,
			}),
		]);
		expect(events[0]?.rate).toBeCloseTo(1 / 18);
		expect(room).toEqual({ [DV]: 0 });
	});

	it("stays closed under 12 working hours, or at the floor", () => {
		expect(step(busy(1), readOf()).events).toEqual([]);
		const commits = Array.from({ length: 6 }, (_, i) => ({
			sha: `c${i}`,
			at: NOW - i * MIN,
		}));
		expect(step(busy(2), readOf({ commits })).events).toEqual([]);
	});

	it("leaves no room anywhere, and records nothing, where the record will not read", () => {
		expect(step(busy(1), readOf({ record: null }))).toEqual({
			events: [],
			room: { [DV]: 0 },
			notes: [],
		});
	});

	it("moves nowhere where the commits will not read", () => {
		expect(step(busy(3), readOf({ commits: null }))).toEqual({
			events: [],
			room: {},
			notes: [],
		});
	});

	it("counts the hours of sessions no launch it is given names (#5289)", () => {
		const sessions = Array.from({ length: 3 }, () =>
			working(NOW - 6 * HOUR, NOW),
		);
		expect(step([], readOf({ sessions })).events).toEqual([
			expect.objectContaining({ event: "open", workingHours: 18 }),
		]);
	});

	it("admits one trial once no loop session runs there, and records the launch that takes it", () => {
		const record = [event("open", NOW - HOUR)];
		const finished = busy(3, NOW - 7 * HOUR, { finishedAt: NOW - 2 * HOUR });
		expect(step(finished, readOf({ record })).room).toEqual({ [DV]: 1 });
		const trial = busy(1, NOW - MIN, { jobId: "t", sessionId: "st" });
		const { events, room } = step([...finished, ...trial], readOf({ record }));
		expect(events).toEqual([
			expect.objectContaining({
				event: "trial-start",
				session: "st",
				ticket: 400,
			}),
		]);
		expect(room).toEqual({ [DV]: 0 });
	});

	it("takes no launch without an id for its trial, holding the room meanwhile", () => {
		const record = [event("open", NOW - HOUR)];
		const trial = busy(1, NOW - MIN, { jobId: null, sessionId: undefined });
		expect(step(trial, readOf({ record }))).toEqual({
			events: [],
			room: { [DV]: 0 },
			notes: [],
		});
	});

	it("takes no session that ran before the open for its trial", () => {
		const record = [event("open", NOW - HOUR)];
		expect(step(busy(1, NOW - 2 * HOUR), readOf({ record }))).toEqual({
			events: [],
			room: { [DV]: 0 },
			notes: [],
		});
	});

	describe("a trial", () => {
		const record = [
			event("open", NOW - 2 * HOUR),
			event("trial-start", NOW - HOUR, { session: "st", ticket: 400 }),
		];
		const trial = (over: Partial<BreakerLaunch> = {}) =>
			busy(1, NOW - HOUR, { jobId: "t", sessionId: "st", ...over });

		it("holds the checkout while it runs", () => {
			expect(step(trial(), readOf({ record }))).toEqual({
				events: [],
				room: { [DV]: 0 },
				notes: [],
			});
		});

		it("closes the breaker once a commit of its lands", () => {
			const read = readOf({
				record,
				commits: [{ sha: "landed", at: NOW - MIN }],
				commitsOf: (l) => (l.sessionId === "st" ? ["landed"] : []),
			});
			const { events, room } = step(trial(), read);
			expect(events).toEqual([
				expect.objectContaining({ event: "close", session: "st" }),
			]);
			expect(room).toEqual({});
		});

		const ended = () => trial({ finishedAt: NOW - MIN });
		const committed = (over: Parameters<typeof readOf>[0] = {}) =>
			readOf({
				record,
				commits: [{ sha: "other", at: NOW - HOUR }],
				commitsOf: () => ["mine"],
				...over,
			});

		it("stays in trial while its commit waits on its queue ref, saying so, and closes once it lands on a later tick (#5300)", () => {
			const waiting = { queueOf: () => ({ state: "waiting" as const }) };
			expect(step(ended(), committed(waiting))).toEqual({
				events: [],
				room: { [DV]: 0 },
				notes: [
					"breaker trial st in /h/design-vault held in trial: its commits wait in the landing queue",
				],
			});
			const landed = committed({
				...waiting,
				commits: [{ sha: "mine", at: NOW + 20 * MIN }],
			});
			expect(step(ended(), landed, NOW + 30 * MIN).events).toEqual([
				expect.objectContaining({ event: "close", session: "st" }),
			]);
		});

		it("closes where its queue ref landed ahead of origin/main showing it", () => {
			const read = committed({ queueOf: () => ({ state: "landed" }) });
			expect(step(ended(), read).events).toEqual([
				expect.objectContaining({ event: "close" }),
			]);
		});

		it("reopens once its queue ref's stays are dropped", () => {
			const { events, room } = step(
				ended(),
				committed({ queueOf: () => ({ state: "gone" }) }),
			);
			expect(events).toEqual([
				expect.objectContaining({ event: "reopen", ticket: 400 }),
			]);
			expect(room).toEqual({ [DV]: 0 });
		});

		it("reopens on the tick it ends where it committed nothing, reading no queue ref", () => {
			expect(step(ended(), readOf({ record })).events).toEqual([
				expect.objectContaining({ event: "reopen", ticket: 400 }),
			]);
		});

		it("stays in trial, and says so on the loop's log, where its queue ref, its commit ledger or origin/main will not read", () => {
			for (const read of [
				committed({
					queueOf: () => ({ state: "unread", why: "the remote is down" }),
				}),
				committed({ commitsOf: () => null }),
				committed({ commits: null }),
			]) {
				const { events, room, notes } = step(ended(), read);
				expect(events).toEqual([]);
				expect(room).toEqual({ [DV]: 0 });
				expect(notes).toEqual([
					expect.stringMatching(
						/^breaker trial st in \/h\/design-vault held in trial: (the remote is down|its commit ledger will not read|origin\/main will not read)$/,
					),
				]);
			}
		});

		it("reaches its reads back to its launch, finished or not, while the record holds it in trial", () => {
			const early = trial({
				launchedAt: NOW - 9 * HOUR,
				finishedAt: NOW - 8 * HOUR,
			});
			expect(buildLookbackOf(early, DV, NOW, record)).toBe(NOW - 9 * HOUR);
			expect(buildLookbackOf(early, DV, NOW, [])).toBe(NOW - 6 * HOUR);
		});

		it("reopens where its launch is no longer known", () => {
			expect(step([], readOf({ record })).events).toEqual([
				expect.objectContaining({ event: "reopen" }),
			]);
		});
	});

	it("counts a closed breaker only from its close", () => {
		const record = [
			event("open", NOW - 3 * HOUR),
			event("trial-start", NOW - 2 * HOUR, { session: "st" }),
			event("close", NOW - HOUR),
		];
		expect(step(busy(3), readOf({ record })).events).toEqual([]);
	});
});

describe("the breaker's state off its record, across a restart", () => {
	it("folds each checkout's own events, a budget park moving nothing", () => {
		const record = [
			event("open", NOW - 3 * HOUR),
			event("trial-start", NOW - 2 * HOUR, { session: "st", ticket: 9 }),
			event("budget-park", NOW - HOUR, { session: "sx" }),
			event("open", NOW - HOUR, { repo: "/h/other" }),
		];
		expect(foldBreakerAt(record, DV, NOW)).toEqual({
			state: "trial",
			since: NOW - 3 * HOUR,
			session: "st",
			ticket: 9,
		});
		expect(foldBreakerAt(record, "/h/other", NOW)).toEqual({
			state: "open",
			since: NOW - HOUR,
		});
		expect(foldBreakerAt([], DV, NOW)).toEqual({
			state: "closed",
			since: null,
		});
	});
});
