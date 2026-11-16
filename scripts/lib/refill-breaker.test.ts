// @vitest-environment node
/*
 * lib/refill-breaker.js — the per-checkout throughput breaker (#5275). Broken,
 * it refills a repo whose sessions have stopped landing, as design-vault's
 * night of 2026-11-15 did, or it trips on workflow-core's quiet hours, or a
 * restart forgets it is open.
 *
 * The replays drive readingOf over two fixtures cut from the real job
 * timelines and `origin/main` (scripts/fixtures/refill-breaker-*.json),
 * each row kept wherever dropping it would change an hour-capped span.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	foldBreaker,
	isTripping,
	readingOf,
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
const sessionsOf = (f: Fixture) =>
	f.sessions.map((s) => ({
		rows: s.rows.map(([at, state]) => ({ at, state })),
		endAt: Date.parse(s.endAt),
	}));

/** Each quarter hour in [from, to] the breaker would trip at. */
function replay(f: Fixture, from: string, to: string) {
	const sessions = sessionsOf(f);
	const commitTimes = f.commits.map((c) => Date.parse(c));
	const trips: string[] = [];
	for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * MIN)
		if (
			isTripping(
				readingOf({ commitTimes, sessions, from: t - 6 * HOUR, to: t }),
			)
		)
			trips.push(iso(t));
	return trips;
}

describe("the replays (#5250's measurement)", () => {
	it("opens on design-vault's night of 2026-11-15 at 19:00Z, and stays tripping", () => {
		const trips = replay(
			fixture(DV_NIGHT),
			"2026-11-15T09:00:00Z",
			"2026-11-16T06:00:00Z",
		);
		expect(trips[0]).toBe("2026-11-15T19:00:00.000Z");
		expect(trips).toContain("2026-11-16T02:00:00.000Z");
	});

	it("does not trip in any of workflow-core's four overnight dips", () => {
		const { windows } = fixture(WFC_DIPS);
		expect(windows).toHaveLength(4);
		for (const w of windows) expect(replay(w, w.from, w.to)).toEqual([]);
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

const readOf = (
	over: Partial<ThroughputRead> & {
		commits?: { sha: string; at: number }[] | null;
	} = {},
): ThroughputRead => {
	const { commits = [{ sha: "a", at: NOW - HOUR }], ...rest } = over;
	return {
		byRoot: { [DV]: { commits, gateRuns: [] } },
		timelineOf: (l) => working(l.launchedAt, l.finishedAt ?? NOW),
		commitsOf: () => [],
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

const step = (launches: BreakerLaunch[], read: ThroughputRead, now = NOW) =>
	stepBreakers({ roots: [DV], launches, read, now });

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

	it("moves nowhere where the commits will not read", () => {
		expect(step(busy(3), readOf({ commits: null }))).toEqual({
			events: [],
			room: {},
		});
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

	it("takes no session that ran before the open for its trial", () => {
		const record = [event("open", NOW - HOUR)];
		expect(step(busy(1, NOW - 2 * HOUR), readOf({ record }))).toEqual({
			events: [],
			room: { [DV]: 0 },
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

		it("reopens the breaker where it ends with no landing", () => {
			const { events, room } = step(
				trial({ finishedAt: NOW - MIN }),
				readOf({ record }),
			);
			expect(events).toEqual([
				expect.objectContaining({ event: "reopen", ticket: 400 }),
			]);
			expect(room).toEqual({ [DV]: 0 });
		});

		it("reopens where its launch is no longer known", () => {
			expect(step([], readOf({ record })).events).toEqual([
				expect.objectContaining({ event: "reopen" }),
			]);
		});
	});

	it("counts a closed breaker only from its close, so the trial's landing starts afresh", () => {
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
		expect(foldBreaker(record, DV)).toEqual({
			state: "trial",
			since: NOW - 3 * HOUR,
			session: "st",
			ticket: 9,
		});
		expect(foldBreaker(record, "/h/other")).toEqual({
			state: "open",
			since: NOW - HOUR,
		});
		expect(foldBreaker([], DV)).toEqual({ state: "closed", since: null });
	});
});
