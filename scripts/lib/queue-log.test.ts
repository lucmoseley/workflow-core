// @vitest-environment node
/*
 * lib/queue-log.js's readers (#4485, spec #4458): time in queue, depth,
 * each waiting ref's start, percentiles and the 7-day baselines, off canned
 * queue logs.
 *
 * Loosen it and a ref's time in queue starts at a later push than its
 * oldest pending one, a ref pushed again stops ageing, a ref pushed again
 * after its take is dropped from the depth, pushes and takes skew the depth,
 * or the baselines the queue alert's limits rest on read the wrong week.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pendingSince, queueBaseline, readQueueRows } from "./queue-log.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

type Event = "enqueue" | "take" | "land" | "drop";
const row = (min: number, event: Event, name: string, sha: string) => ({
	at: NOW - min * MIN,
	event,
	ref: `refs/heads/queue/${name}`,
	sha,
});

/** The baseline at NOW of `rows`, in minutes. */
const minutes = (rows: ReturnType<typeof row>[]) => {
	const b = queueBaseline(rows, NOW);
	const min = (ms: number | null) => (ms === null ? null : ms / MIN);
	return { ...b, p50Ms: min(b.p50Ms), p90Ms: min(b.p90Ms) };
};

describe("time in queue and depth", () => {
	it("times a land from the enqueue of the sha that landed", () => {
		expect(
			minutes([
				row(50, "enqueue", "x", A),
				row(40, "take", "x", A),
				row(20, "land", "x", A),
			]),
		).toEqual({ spans: 1, p50Ms: 30, p90Ms: 30, depthP90: 1 });
	});

	it("keeps a push after the take pending, and times it on its own land", () => {
		expect(
			minutes([
				row(60, "enqueue", "x", A),
				row(50, "take", "x", A),
				row(45, "enqueue", "x", B),
				row(30, "land", "x", A),
				row(10, "land", "x", B),
			]),
		).toEqual({ spans: 2, p50Ms: 30, p90Ms: 35, depthP90: 1 });
	});

	it("takes every pending push at or before the sha that left", () => {
		expect(
			minutes([
				row(60, "enqueue", "x", A),
				row(55, "enqueue", "x", B),
				row(30, "drop", "x", B),
				row(20, "enqueue", "x", C),
				row(10, "land", "x", C),
			]),
		).toEqual(expect.objectContaining({ spans: 2, p50Ms: 10, p90Ms: 30 }));
	});

	it("times a land from the ref's oldest pending push, not the sha that landed", () => {
		expect(
			minutes([
				row(60, "enqueue", "x", A),
				row(40, "enqueue", "x", B),
				row(10, "land", "x", B),
			]),
		).toEqual(expect.objectContaining({ spans: 1, p50Ms: 50 }));
	});

	it("falls back to the ref's earliest pending push where none names the sha", () => {
		expect(
			minutes([
				row(60, "enqueue", "x", A),
				row(40, "enqueue", "x", B),
				row(10, "land", "x", C),
			]),
		).toEqual(expect.objectContaining({ spans: 1, p50Ms: 50 }));
	});

	it("gives no time for a land with no push pending", () => {
		expect(minutes([row(10, "land", "x", A)])).toEqual({
			spans: 0,
			p50Ms: null,
			p90Ms: null,
			depthP90: 0,
		});
	});

	it("samples the depth at each land or drop alone, the ref leaving counted", () => {
		/* One land with one ref waiting, then nine pushes and their takes:
		 * sampled at every event, the p90 would be 9. */
		const names = Array.from({ length: 9 }, (_, i) => `r${i}`);
		const rows = [
			row(100, "enqueue", "x", A),
			row(90, "land", "x", A),
			...names.map((n, i) => row(80 - i, "enqueue", n, A)),
			...names.map((n, i) => row(50 - i, "take", n, A)),
		];
		expect(minutes(rows).depthP90).toBe(1);
	});
});

describe("percentiles", () => {
	it("are nearest-rank, each a value the log holds", () => {
		/* Four refs waiting 7, 1, 4 and 3 min. */
		const rows = [7, 1, 4, 3].flatMap((wait, i) => [
			row(100 - 10 * i, "enqueue", `r${i}`, A),
			row(100 - 10 * i - wait, "land", `r${i}`, A),
		]);
		expect(minutes(rows)).toEqual(
			expect.objectContaining({ p50Ms: 3, p90Ms: 7 }),
		);
	});
});

describe("queueBaseline", () => {
	it("reads p50, p90 and the depth p90 exactly off a small log", () => {
		/* Five refs pushed a minute apart, then landed after 10, 20, 30, 40
		 * and 50 min: depths 5 down to 1 at the lands. */
		const rows = [10, 20, 30, 40, 50].flatMap((wait, i) => [
			row(120 - i, "enqueue", `r${i}`, A),
			row(120 - i - wait, "land", `r${i}`, A),
		]);
		const b = queueBaseline(
			rows.sort((x, y) => x.at - y.at),
			NOW,
		);
		expect(b).toEqual({
			spans: 5,
			p50Ms: 30 * MIN,
			p90Ms: 50 * MIN,
			depthP90: 5,
		});
	});

	it("reads only the 7 days before now, though the state before them counts", () => {
		const week = 7 * 24 * 60;
		const b = queueBaseline(
			[
				row(week + 100, "enqueue", "old", A),
				row(week + 10, "land", "old", A),
				row(week + 5, "enqueue", "long", B),
				row(30, "land", "long", B),
			],
			NOW,
		);
		expect(b.spans).toBe(1);
		expect(b.p90Ms).toBe((week + 5 - 30) * MIN);
		/* The one land in the window: `long`'s, with it alone waiting. */
		expect(b.depthP90).toBe(1);
	});

	it("is empty, every figure null, on an empty log", () => {
		expect(queueBaseline([], NOW)).toEqual({
			spans: 0,
			p50Ms: null,
			p90Ms: null,
			depthP90: null,
		});
	});
});

describe("pendingSince", () => {
	const x = "refs/heads/queue/x";

	it("dates a ref pushed again from its earliest pending push", () => {
		const since = pendingSince([
			row(60, "enqueue", "x", A),
			row(50, "take", "x", A),
			row(40, "enqueue", "x", B),
		]);
		expect(since.get(x)).toBe(NOW - 60 * MIN);
	});

	it("dates a ref from the first push after its last land", () => {
		const since = pendingSince([
			row(60, "enqueue", "x", A),
			row(30, "land", "x", A),
			row(20, "enqueue", "x", B),
			row(10, "enqueue", "x", C),
		]);
		expect(since.get(x)).toBe(NOW - 20 * MIN);
	});

	it("keeps a push after the landed sha pending, and names no ref with none", () => {
		const since = pendingSince([
			row(60, "enqueue", "x", A),
			row(40, "enqueue", "x", B),
			row(30, "land", "x", A),
			row(20, "enqueue", "y", A),
			row(10, "drop", "y", A),
		]);
		expect(since.get(x)).toBe(NOW - 40 * MIN);
		expect(since.has("refs/heads/queue/y")).toBe(false);
	});
});

describe("readQueueRows", () => {
	it("reads a canned log oldest first, leaving out a torn or unknown row", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-log-"));
		try {
			const file = path.join(dir, ".queue-log.jsonl");
			const iso = (min: number) => new Date(NOW - min * MIN).toISOString();
			fs.writeFileSync(
				file,
				[
					JSON.stringify({
						at: iso(5),
						event: "land",
						ref: "refs/heads/queue/x",
						sha: A,
					}),
					"{torn",
					JSON.stringify({
						at: iso(6),
						event: "rename",
						ref: "refs/heads/queue/x",
						sha: A,
					}),
					JSON.stringify({
						at: iso(9),
						event: "enqueue",
						ref: "refs/heads/queue/x",
						sha: A,
					}),
					"",
				].join("\n"),
			);
			expect(readQueueRows(file).map((r) => r.event)).toEqual([
				"enqueue",
				"land",
			]);
			expect(queueBaseline(readQueueRows(file), NOW).p50Ms).toBe(4 * MIN);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("has no row where the log is absent", () => {
		expect(
			readQueueRows(path.join(os.tmpdir(), "no-such-queue-log.jsonl")),
		).toEqual([]);
	});
});
