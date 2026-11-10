// @vitest-environment node
/*
 * lib/time-to-land.js (#4951): a queue ref's stay off canned queue rows, the
 * green suite's runs and a red batch's steps off a canned lander log, and the
 * reading against the target.
 *
 * Loosen it and a ref taken again is timed from its last take, two batches
 * under test at once swap their runs, a red batch's steps are charged to the
 * batch beside it, or a slow queue reads as inside its target.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	greenSuiteSpans,
	judgeTimeToLand,
	MIN_STAYS,
	memberStays,
	parseLanderLog,
	readLogSince,
	replayBatches,
	TARGET_MULTIPLE,
} from "./time-to-land.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const S = 1000;
const A = "a".repeat(40);
const B = "b".repeat(40);

type Event = "enqueue" | "take" | "land" | "drop";
const row = (s: number, event: Event, name: string, sha = A) => ({
	at: NOW + s * S,
	event,
	ref: `refs/heads/queue/${name}`,
	sha,
});

/** A lander log line `s` seconds after NOW. */
const line = (s: number, text: string) =>
	`${new Date(NOW + s * S).toISOString()} ${text}`;

describe("a queue ref's stay", () => {
	it("runs from its first take to its land, through a take again", () => {
		const stays = memberStays([
			row(0, "enqueue", "x"),
			row(10, "take", "x"),
			row(300, "take", "x"),
			row(500, "land", "x"),
		]);

		expect(stays).toEqual([
			{
				ref: "refs/heads/queue/x",
				sha: A,
				event: "land",
				take: NOW + 10 * S,
				at: NOW + 500 * S,
				takes: 2,
			},
		]);
	});

	it("starts a ref's next stay afresh, and gives none to a drop never taken", () => {
		const stays = memberStays([
			row(0, "take", "x"),
			row(100, "drop", "x"),
			row(200, "take", "x", B),
			row(260, "land", "x", B),
			row(300, "drop", "y"),
		]);

		expect(stays.map((s) => [s.event, s.at - s.take, s.takes])).toEqual([
			["drop", 100 * S, 1],
			["land", 60 * S, 1],
		]);
	});
});

describe("the lander log", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "time-to-land-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("pairs each green run by its sha where two batches are under test at once, leaving out a sha the red path reran", () => {
		const events = parseLanderLog(
			[
				line(0, "test-sha aaa"),
				line(20, "test-sha bbb"),
				"a child's line, unstamped",
				line(180, "fast-forward-main aaa"),
				line(260, "fast-forward-main bbb"),
				line(300, "test-sha ccc"),
				line(310, "test-sha ddd"),
				line(400, "rerun-files ddd pass 2: "),
				line(500, "fast-forward-main ddd"),
			].join("\n"),
		);

		expect(greenSuiteSpans(events).map((g) => [g.sha, g.at - g.from])).toEqual([
			["aaa", 180 * S],
			["bbb", 240 * S],
		]);
	});

	it("reads an absent log as empty, and a log's tail back past the time asked", () => {
		const file = path.join(tmp, "lander.log");
		expect(readLogSince(file, NOW)).toBe("");
		fs.writeFileSync(
			file,
			`${line(-900, "exit old")}\n${line(-10, "test-sha aaa")}\n`,
		);

		expect(parseLanderLog(readLogSince(file, NOW - 60 * S)).at(-1)).toEqual({
			t: NOW - 10 * S,
			kind: "test-sha",
			rest: "aaa",
		});
	});

	it("charges a red batch's steps to it, each to its next line, while the batch behind lands", () => {
		const batches = replayBatches(
			parseLanderLog(
				[
					line(
						0,
						"take-batch onto m0 as lander/batch-0: queue/a@a1, queue/b@b1",
					),
					line(1, "merge-members onto m0: queue/a, queue/b"),
					line(5, "test-sha ab"),
					line(200, "detach lander/batch-0"),
					line(201, "start-isolation queue/a, queue/b on x.test.ts"),
					line(202, "merge-iso onto m0: queue/a"),
					line(205, "isolate-members alone 0@ia, alone 1@ib"),
					line(206, "take-batch onto m0 as lander/batch-1: queue/c@c1"),
					line(207, "merge-members onto m0: queue/c"),
					line(210, "test-sha c1"),
					line(275, "confirm-members alone 1@ib"),
					line(340, "drop-member queue/b@b1 as dropped/b"),
					line(341, "rebatch-passers queue/a"),
					line(400, "fast-forward-main c1"),
				].join("\n"),
			),
		);

		const [red, green] = batches;
		expect(red?.outcome).toBe("rebatched");
		expect(red?.drops).toEqual(["b"]);
		expect(
			red?.steps.map((st) => [st.kind, ((st.end ?? 0) - st.t) / S]),
		).toEqual([
			["start-isolation", 1],
			["merge-iso", 3],
			["isolate-members", 70],
			["confirm-members", 65],
			["rebatch-passers", 0],
		]);
		expect([green?.outcome, green?.detach, green?.end]).toEqual([
			"green",
			null,
			NOW + 400 * S,
		]);
	});

	it("reads a take-batch repeating its slot's members as the same batch, and a lone member's drop as its end", () => {
		const batches = replayBatches(
			parseLanderLog(
				[
					line(0, "take-batch onto m0 as lander/batch-0: queue/a@a1"),
					line(9, "take-batch onto m0 as lander/batch-0: queue/a@a1"),
					line(10, "merge-members onto m0: queue/a"),
					line(12, "test-sha a1"),
					line(200, "detach lander/batch-0"),
					line(201, "isolate-members alone 0@a1"),
					line(260, "drop-member queue/a@a1 as dropped/a"),
				].join("\n"),
			),
		);

		expect(batches).toHaveLength(1);
		expect([batches[0]?.take, batches[0]?.outcome, batches[0]?.end]).toEqual([
			NOW,
			"dropped",
			NOW + 260 * S,
		]);
	});
});

describe("the reading against the target", () => {
	/** `n` stays ended a minute ago, a tenth of them `slow` s and the rest 200 s. */
	const stays = (n: number, slow: number) =>
		Array.from({ length: n }, (_, k) => ({
			ref: `r${k}`,
			sha: A,
			event: "land" as const,
			take: NOW - 60 * S - (k < n / 10 + 1 ? slow : 200) * S,
			at: NOW - 60 * S,
			takes: 1,
		}));
	const greens = [{ from: NOW - 400 * S, at: NOW - 220 * S }];

	it("is over where the p90 passes the multiple of the green p50, and not at it", () => {
		const target = TARGET_MULTIPLE * 180;

		expect(
			judgeTimeToLand(stays(MIN_STAYS, target + 1), greens, NOW),
		).toMatchObject({
			judged: true,
			over: true,
			p90Ms: (target + 1) * S,
			targetMs: target * S,
		});
		expect(judgeTimeToLand(stays(MIN_STAYS, target), greens, NOW).over).toBe(
			false,
		);
	});

	it("judges nothing on too few stays, on no green run, or on stays older than the week", () => {
		const few = judgeTimeToLand(stays(MIN_STAYS - 1, 9000), greens, NOW);
		const noGreen = judgeTimeToLand(stays(MIN_STAYS, 9000), [], NOW);
		const old = judgeTimeToLand(
			stays(MIN_STAYS, 9000),
			greens,
			NOW + 8 * 24 * 3600 * S,
		);

		expect([few.judged, few.over]).toEqual([false, false]);
		expect([noGreen.judged, noGreen.targetMs]).toEqual([false, null]);
		expect([old.stays, old.judged]).toEqual([0, false]);
	});
});
