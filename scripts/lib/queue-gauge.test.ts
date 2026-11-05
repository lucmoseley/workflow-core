// @vitest-environment node
/*
 * lib/queue-gauge.js's limits, crossings and status line (#4485, spec
 * #4458), off canned queue logs; the remote read is
 * lib/queue-lander-adapters.js's, crossed in scripts/landing-status.test.ts.
 *
 * Loosen it and a tiny or empty baseline alerts on a queue a minute old, a
 * busy week's queue is called stalled, or the status line misreports the
 * oldest ref's wait.
 */
import { describe, expect, it } from "vitest";
import {
	AGE_FLOOR_MS,
	buildCrossingLines,
	buildQueueLine,
	DEPTH_FLOOR,
	queueCrossings,
} from "./queue-gauge.js";
import { queueBaseline } from "./queue-log.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const A = "a".repeat(40);

type Event = "enqueue" | "take" | "land" | "drop";
const row = (min: number, event: Event, name: string) => ({
	at: NOW - min * MIN,
	event,
	ref: `refs/heads/queue/${name}`,
	sha: A,
});

/** A week of `n` refs, pushed a minute apart and each landed `wait` later. */
const week = (n: number, wait: number) =>
	Array.from({ length: n }, (_, i) => [
		row(5000 - i, "enqueue", `r${i}`),
		row(5000 - i - wait, "land", `r${i}`),
	])
		.flat()
		.sort((a, b) => a.at - b.at);

const waiting = (...ages: number[]) =>
	ages.map((age, i) => ({ name: `w${i}`, sha: A, since: NOW - age * MIN }));

const EMPTY = queueBaseline([], NOW);

/** The limits a gauge of `b` is held to. */
const queueLimits = (b: ReturnType<typeof queueBaseline>) =>
	queueCrossings({ now: NOW, waiting: [], baseline: b }).limits;

describe("the limits", () => {
	it("holds the floors on an empty baseline", () => {
		expect(queueLimits(EMPTY)).toEqual({
			ageMs: AGE_FLOOR_MS,
			depth: DEPTH_FLOOR,
		});
		expect(AGE_FLOOR_MS).toBe(60 * MIN);
		expect(DEPTH_FLOOR).toBe(10);
	});

	it("holds the floors on a tiny baseline", () => {
		const b = queueBaseline(week(3, 5), NOW);
		expect(b.p90Ms).toBe(5 * MIN);
		expect(queueLimits(b)).toEqual({ ageMs: AGE_FLOOR_MS, depth: DEPTH_FLOOR });
	});

	it("is twice the p90s where they pass the floors", () => {
		/* 12 refs pushed a minute apart, each 90 min in queue: depths 12
		 * down to 1 at the lands, the 11th of 12 sorted 11. */
		const b = queueBaseline(week(12, 90), NOW);
		expect(b.p90Ms).toBe(90 * MIN);
		expect(b.depthP90).toBe(11);
		expect(queueLimits(b)).toEqual({ ageMs: 180 * MIN, depth: 22 });
	});
});

describe("queueCrossings", () => {
	it("crosses the floor of an empty baseline past 60 min and past 10 refs", () => {
		const c = queueCrossings({
			now: NOW,
			waiting: waiting(61, ...new Array(10).fill(1)),
			baseline: EMPTY,
		});
		expect(c.age).toEqual(
			expect.objectContaining({ name: "w0", waitedMs: 61 * MIN }),
		);
		expect(c.depth).toBe(11);
	});

	it("crosses neither at the limits themselves", () => {
		const c = queueCrossings({
			now: NOW,
			waiting: waiting(60, ...new Array(9).fill(1)),
			baseline: EMPTY,
		});
		expect(c.age).toBeNull();
		expect(c.depth).toBeNull();
	});

	it("crosses neither with none waiting", () => {
		const c = queueCrossings({ now: NOW, waiting: [], baseline: EMPTY });
		expect([c.age, c.depth]).toEqual([null, null]);
	});

	it("holds a busy week's queue to its own baseline", () => {
		const b = queueBaseline(week(12, 90), NOW);
		const g = {
			now: NOW,
			waiting: waiting(150, ...new Array(15).fill(1)),
			baseline: b,
		};
		expect(queueCrossings(g)).toEqual(
			expect.objectContaining({ age: null, depth: null }),
		);
		const lines = buildCrossingLines(
			queueCrossings({ ...g, waiting: waiting(181, ...new Array(24).fill(1)) }),
			b,
		);
		expect(lines.age).toBe(
			`queue/w0 has waited 3 h 1 min, since ${new Date(NOW - 181 * MIN).toISOString()}, past its limit of 3 h 0 min, the larger of 2 × the 7-day p90 time in queue (1 h 30 min) and 60 min`,
		);
		expect(lines.depth).toBe(
			"25 queue refs wait, past the limit of 22, the larger of 2 × the 7-day p90 depth (11) and 10",
		);
	});
});

describe("buildQueueLine", () => {
	it("prints the waiting refs, the oldest's wait and the 7-day figures off a canned log", () => {
		const b = queueBaseline(
			[
				row(100, "enqueue", "a"),
				row(90, "enqueue", "b"),
				row(80, "take", "a"),
				row(70, "land", "a"),
				row(60, "land", "b"),
			],
			NOW,
		);
		expect(
			buildQueueLine({ now: NOW, waiting: waiting(42, 7), baseline: b }),
		).toBe(
			"queue: 2 waiting, the oldest queue/w0 for 0 h 42 min; time in queue over 7 days p50 0 h 30 min, p90 0 h 30 min across 2 landed or dropped; depth p90 2.",
		);
	});

	it("says so where nothing waits and nothing landed", () => {
		expect(buildQueueLine({ now: NOW, waiting: [], baseline: EMPTY })).toBe(
			"queue: none waiting; nothing landed or dropped in 7 days; depth p90 none.",
		);
	});
});
