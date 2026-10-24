// @vitest-environment node
/*
 * The dead-window self-throttling detector's core (mantahostels#1404).
 *
 * The acceptance test this cannot run lives outside the repo: sweeping this
 * machine's real transcript corpus must reproduce
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/self-throttling-turn-collapse.md. Here it runs in-process on
 * synthetic transcripts written to a temp dir, turns spaced by hand to sit
 * either side of each threshold.
 *
 * `check-self-throttling.js`, swept daily from `sweep-debts-detached.sh`, appends
 * its readings to the history a seat cut is judged against; loosen a case and
 * that history gains a false episode or misses the real one, with nothing
 * downstream to catch it.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const tc: any = createRequire(__filename)("./turn-collapse.js");

const HOUR = 36e5;

/** One assistant turn as the harness writes it. */
function turn(
	timestamp: string,
	id: string,
	{ out = 10, cache = 20, sidechain = false } = {},
) {
	return JSON.stringify({
		type: "assistant",
		isSidechain: sidechain,
		timestamp,
		message: {
			id,
			usage: { output_tokens: out, cache_creation_input_tokens: cache },
		},
	});
}

/** `n` turns an even `spacingMin` apart, starting at `startMs`. */
function run(startMs: number, n: number, spacingMin: number) {
	return Array.from({ length: n }, (_, i) => startMs + i * spacingMin * 60_000);
}

describe("readCorpus", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/** The ISO timestamps `readCorpus` returns for one transcript's text. */
	const turnsOf = (text: string) => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-collapse-"));
		const file = path.join(dir, "t.jsonl");
		fs.writeFileSync(file, text);
		return tc
			.readCorpus([file])
			.map((ms: number) => new Date(ms).toISOString());
	};

	it("keeps sidechain turns, which are a subagent's spend", () => {
		const text = [
			turn("2026-08-01T00:00:00.000Z", "msg_a"),
			turn("2026-08-01T00:01:00.000Z", "msg_b", { sidechain: true }),
		].join("\n");
		expect(turnsOf(text)).toHaveLength(2);
	});

	it("skips user turns, assistant turns with no usage, and a half-written line", () => {
		const text = [
			turn("2026-08-01T00:00:00.000Z", "msg_a"),
			JSON.stringify({ type: "user", timestamp: "2026-08-01T00:02:00.000Z" }),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-08-01T00:03:00.000Z",
				message: { id: "msg_c" },
			}),
			'{"type":"assistant","timesta',
		].join("\n");
		expect(turnsOf(text)).toEqual(["2026-08-01T00:00:00.000Z"]);
	});

	it("keys on the id AND both usage figures", () => {
		/* One id with a different output or cache figure is a real second turn;
		 * the same three again is the same turn written twice. */
		const text = [
			turn("2026-08-01T00:00:00.000Z", "msg_a", { out: 7, cache: 9 }),
			turn("2026-08-01T00:01:00.000Z", "msg_a", { out: 8, cache: 9 }),
			turn("2026-08-01T00:02:00.000Z", "msg_a", { out: 7, cache: 10 }),
			turn("2026-08-01T00:03:00.000Z", "msg_a", { out: 7, cache: 9 }),
		].join("\n");
		expect(turnsOf(text)).toEqual([
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:01:00.000Z",
			"2026-08-01T00:02:00.000Z",
		]);
	});

	it("deduplicates one turn replayed across two transcripts, keeping the earliest timestamp", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-collapse-"));
		fs.writeFileSync(
			path.join(dir, "a.jsonl"),
			turn("2026-08-01T00:00:00.000Z", "msg_a"),
		);
		fs.writeFileSync(
			path.join(dir, "b.jsonl"),
			[
				turn("2026-08-01T09:00:00.000Z", "msg_a"),
				turn("2026-08-01T00:30:00.000Z", "msg_b"),
			].join("\n"),
		);
		const files = [path.join(dir, "a.jsonl"), path.join(dir, "b.jsonl")];
		expect(
			tc.readCorpus(files).map((ms: number) => new Date(ms).toISOString()),
		).toEqual(["2026-08-01T00:00:00.000Z", "2026-08-01T00:30:00.000Z"]);
	});

	it("returns turns sorted, whatever order the files arrive in", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-collapse-"));
		fs.writeFileSync(
			path.join(dir, "late.jsonl"),
			turn("2026-08-02T00:00:00.000Z", "msg_z"),
		);
		fs.writeFileSync(
			path.join(dir, "early.jsonl"),
			turn("2026-08-01T00:00:00.000Z", "msg_a"),
		);
		const turns = tc.readCorpus([
			path.join(dir, "late.jsonl"),
			path.join(dir, "early.jsonl"),
		]);
		expect(turns[0]).toBeLessThan(turns[1]);
	});
});

describe("corpusFiles", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("finds a subagent transcript nested under its parent session", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-collapse-"));
		const nested = path.join(dir, "-a-project", "session-1", "subagents");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "agent-1.jsonl"), "");
		fs.writeFileSync(path.join(dir, "-a-project", "session-1.jsonl"), "");
		expect(tc.corpusFiles([dir])).toHaveLength(2);
	});

	it("counts a file reached by two paths once", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-collapse-"));
		const real = path.join(dir, "seat-a");
		fs.mkdirSync(real);
		fs.writeFileSync(path.join(real, "s.jsonl"), "");
		fs.symlinkSync(real, path.join(dir, "seat-b"));
		expect(tc.corpusFiles([dir])).toHaveLength(1);
	});
});

describe("trailingBusyRate", () => {
	it("is the median of the busiest 24 hour-buckets in the trailing 7 days", () => {
		/* The busiest 24 buckets carry 25..48, whose median is (36 + 37) / 2. */
		const base = Date.parse("2026-08-10T00:00:00.000Z");
		const turns: number[] = [];
		for (let h = 0; h < 48; h++)
			for (let n = 0; n <= h; n++) turns.push(base + h * HOUR + n * 1000);
		const hist = tc.hourlyCounts(turns);
		expect(tc.trailingBusyRate(hist, base + 48 * HOUR)).toBe(36.5);
	});

	it("is null where the trailing week holds fewer than 24 busy hours", () => {
		/* "The busiest 24 hours" is undefined over a week that had six. Taking it
		 * anyway would score a handful of turns as full-rate work. */
		const base = Date.parse("2026-08-10T00:00:00.000Z");
		const turns = run(base, 6, 60);
		expect(tc.trailingBusyRate(tc.hourlyCounts(turns), base + 6 * HOUR)).toBe(
			null,
		);
	});

	it("counts busy hours, not the median's value — a thin week still has none", () => {
		/* 23 hours carrying one turn each: a top-24 median over all buckets would be
		 * a non-zero 0.5 and normalise a flank of 1/hour to double the busy rate. */
		const base = Date.parse("2026-08-10T00:00:00.000Z");
		const turns = run(base, 23, 60);
		expect(tc.trailingBusyRate(tc.hourlyCounts(turns), base + 23 * HOUR)).toBe(
			null,
		);
		// One more busy hour and it resolves, to the median of 24 ones.
		const enough = run(base, 24, 60);
		expect(tc.trailingBusyRate(tc.hourlyCounts(enough), base + 24 * HOUR)).toBe(
			1,
		);
	});
});

describe("a window's flank rates", () => {
	/* Each flank is read off the one window a lone turn 10 hours away opens. */
	it("counts turns per hour over the 3 hours ending at the gap", () => {
		const at = Date.parse("2026-08-10T12:00:00.000Z");
		// 13 turns spanning exactly [at - 3h, at], one every 15 minutes.
		const turns = [...run(at - 3 * HOUR, 13, 15), at + 10 * HOUR];
		const [window] = tc.deadWindows(turns, 10);
		expect(window.start).toBe(at);
		// Half-open away from `at`: the turn ON at - 3h belongs to the window before.
		expect(window.before).toBe(12 / 3);
	});

	it("looks forward for the after-flank", () => {
		const at = Date.parse("2026-08-10T12:00:00.000Z");
		// 7 turns spanning exactly [at, at + 3h], one every 30 minutes.
		const turns = [at - 10 * HOUR, ...run(at, 7, 30)];
		const [window] = tc.deadWindows(turns, 10);
		expect(window.end).toBe(at);
		// The turn that closes the gap counts; the one on at + 3h does not.
		expect(window.after).toBe(6 / 3);
	});
});

/**
 * A corpus shaped like the real one: a fortnight of steady heavy work with one
 * long, strongly-flanked silence in it.
 *
 * `gapAtHour` is measured from the start; `gapHours` is how long the silence
 * runs. Work is 60 turns an hour for 12 hours a day, so the busy-hour baseline
 * is 60 and a full-rate flank normalises to 1.0.
 */
function corpus({
	gapAtHour,
	gapHours,
}: {
	gapAtHour: number;
	gapHours: number;
}) {
	const base = Date.parse("2026-08-01T00:00:00.000Z");
	const turns: number[] = [];
	for (let h = 0; h < 14 * 24; h++) {
		if (h % 24 >= 12) continue; // twelve hours off a day
		if (h >= gapAtHour && h < gapAtHour + gapHours) continue;
		for (let n = 0; n < 60; n++) turns.push(base + h * HOUR + n * 60_000);
	}
	return turns;
}

describe("deadWindows and episodes", () => {
	it("fires on a 24h silence between two full-rate stretches", () => {
		// Starts on day 10 hour 6, so a full 7 days of history sits behind it.
		const fired = tc.episodes(
			tc.deadWindows(corpus({ gapAtHour: 10 * 24 + 6, gapHours: 24 })),
		);
		expect(fired).toHaveLength(1);
		expect(fired[0].hours).toBeGreaterThanOrEqual(tc.MIN_DEAD_HOURS);
		expect(fired[0].beforeRatio).toBeGreaterThanOrEqual(tc.FLANK_RATIO);
		expect(fired[0].afterRatio).toBeGreaterThanOrEqual(tc.FLANK_RATIO);
	});

	it("does not fire on the ordinary 12-hour nights that shape the same corpus", () => {
		expect(
			tc.episodes(tc.deadWindows(corpus({ gapAtHour: 0, gapHours: 0 }))),
		).toEqual([]);
	});

	it("does not fire when only one flank is strong", () => {
		/* Both flanks are required: a long silence with weak work after it is a
		 * holiday or a machine that stopped, not rationing. */
		const turns = corpus({ gapAtHour: 10 * 24 + 6, gapHours: 24 });
		const resume =
			Date.parse("2026-08-01T00:00:00.000Z") + (11 * 24 + 6) * HOUR;
		// Thin the three hours after the gap to a tenth of full rate.
		const thinned = turns.filter(
			(ms) =>
				ms < resume || ms >= resume + 3 * HOUR || (ms / 60_000) % 10 === 0,
		);
		const [window] = tc
			.deadWindows(thinned)
			.filter((w: { hours: number }) => w.hours >= tc.MIN_DEAD_HOURS);
		expect(window.beforeRatio).toBeGreaterThanOrEqual(tc.FLANK_RATIO);
		expect(window.afterRatio).toBeLessThan(tc.FLANK_RATIO);
		expect(tc.episodes([window])).toEqual([]);
	});

	it("does not fire on an 18-hour silence, however hard the flanks work", () => {
		/* The night before day 10 runs six hours long. */
		const windows = tc.deadWindows(corpus({ gapAtHour: 10 * 24, gapHours: 6 }));
		const near = windows.find((w: { hours: number }) => w.hours > 17);
		expect(near.hours).toBeCloseTo(18, 1);
		expect(near.beforeRatio).toBeGreaterThanOrEqual(tc.FLANK_RATIO);
		expect(near.afterRatio).toBeGreaterThanOrEqual(tc.FLANK_RATIO);
		expect(tc.episodes([near])).toEqual([]);
	});

	it("scores no baseline at the very start of a corpus", () => {
		/* Day 0's night has twelve busy hours behind it, under the 24 a baseline
		 * needs, so its flanks cannot be normalised and it can never fire, however
		 * long it runs. */
		const windows = tc.deadWindows(corpus({ gapAtHour: 12, gapHours: 24 }));
		expect(windows[0].hours).toBeGreaterThanOrEqual(tc.MIN_DEAD_HOURS);
		expect(windows[0].baseline).toBe(null);
		expect(tc.episodes([windows[0]])).toEqual([]);
	});

	it("lists every ordinary night as a candidate, firing on none of them", () => {
		const windows = tc.deadWindows(corpus({ gapAtHour: 10 * 24, gapHours: 0 }));
		expect(windows.length).toBe(13);
		expect(
			windows.every((w: { hours: number }) => Math.abs(w.hours - 12) < 0.1),
		).toBe(true);
		expect(tc.episodes(windows)).toEqual([]);
	});
});
