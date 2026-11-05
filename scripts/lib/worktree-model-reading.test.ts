// @vitest-environment node
/*
 * Pins the readings #4229's done check (#4253) rests on: a levelling
 * fast-forward is the only `main` entry that passes, a move is levelled only
 * if main reaches it before origin/main moves again, a not-moved log line is
 * dated by the stamp above it and owned by the header above it, every shape a
 * reconcile merge leaves is counted, and only a landing route that merged is
 * timed as a merge.
 *
 * In-process over hand-built rows, because each reading is a pure function of
 * what the CLI read. A reading
 * that drifts from the strings git or lib/level-main.js write turns a failing
 * check into a silent PASS on the 24 h reading #4229 closes on.
 */

import { describe, expect, it } from "vitest";
import { MOVED_LINE } from "./land-refusal.js";
import {
	foreignMainEntries,
	isMergeIntoReconcile,
	landingOutcome,
	levelLags,
	levellingRefusals,
	parseReflog,
	reconcileEntries,
	render,
	repoPath,
	spread,
	toolSpans,
	zeroChecks,
} from "./worktree-model-reading.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

describe("parseReflog", () => {
	it("reads the newest-first rows oldest first, in ms", () => {
		const text = `${B}\tmain@{200}\tmerge ${B}: Fast-forward\n${A}\tmain@{100}\tcommit: x\n`;
		expect(parseReflog(text)).toEqual([
			{ t: 100_000, sha: A, msg: "commit: x" },
			{ t: 200_000, sha: B, msg: `merge ${B}: Fast-forward` },
		]);
	});
});

describe("foreignMainEntries", () => {
	it("passes a levelling fast-forward and flags anything else", () => {
		const rows = [
			{ t: 1, sha: A, msg: `merge ${A}: Fast-forward` },
			{ t: 2, sha: B, msg: "commit: on main" },
			{ t: 3, sha: C, msg: "merge reconcile-12: Fast-forward" },
		];
		expect(foreignMainEntries(rows).map((r) => r.sha)).toEqual([B, C]);
	});
});

describe("reconcileEntries", () => {
	it("counts each shape a reconcile branch leaves, never a commit subject naming one", () => {
		const rows = [
			{ t: 1, sha: A, msg: "merge reconcile-3417: Fast-forward" },
			{ t: 2, sha: B, msg: "commit: Re-anchor reconcile-plugin" },
			{ t: 3, sha: C, msg: "checkout: moving from main to reconcile-9" },
			{
				t: 4,
				sha: D,
				msg: "commit (merge): Merge remote-tracking branch 'origin/landing' into reconcile-9",
			},
		];
		expect(reconcileEntries(rows).map((r) => r.sha)).toEqual([A, C, D]);
	});

	it("reads a merge into a reconcile branch off its subject", () => {
		expect(
			isMergeIntoReconcile(
				"Merge remote-tracking branch 'origin/landing' into reconcile-4159",
			),
		).toBe(true);
		expect(
			isMergeIntoReconcile(
				"Merge remote-tracking branch 'origin/landing' into HEAD",
			),
		).toBe(false);
	});
});

describe("levelLags", () => {
	/* A chain A <- B <- C. */
	const order = [A, B, C];
	const contains = (anc: string, sha: string) =>
		order.indexOf(anc) <= order.indexOf(sha);

	it("levels a move main reaches before the next one", () => {
		const lags = levelLags(
			[{ t: 10, sha: B, msg: "" }],
			[{ t: 12, sha: B, msg: "" }],
			contains,
			100,
		);
		expect(lags).toEqual([{ sha: B, at: 10, lagMs: 2, withinPass: true }]);
	});

	it("misses a move overtaken before main reached it, though a later pass reached past it", () => {
		const lags = levelLags(
			[
				{ t: 10, sha: B, msg: "" },
				{ t: 20, sha: C, msg: "" },
			],
			[{ t: 25, sha: C, msg: "" }],
			contains,
			100,
		);
		expect(lags.map((l) => [l.lagMs, l.withinPass])).toEqual([
			[15, false],
			[5, true],
		]);
	});

	it("misses a move main never reached, and ignores main entries before the move", () => {
		const lags = levelLags(
			[{ t: 10, sha: C, msg: "" }],
			[{ t: 5, sha: C, msg: "" }],
			contains,
			100,
		);
		expect(lags).toEqual([{ sha: C, at: 10, lagMs: null, withinPass: false }]);
	});
});

describe("levellingRefusals", () => {
	const w = {
		since: Date.parse("2026-11-05T02:00:00Z"),
		until: Date.parse("2026-11-05T04:00:00Z"),
	};

	it("dates a line by the stamp above it and keeps the window's not-moved lines", () => {
		const lines = [
			"refused: before any stamp",
			"2026-11-05T01:00:00.000Z tick",
			"refused: 1 edit(s) in the main checkout sit on paths a..b",
			"2026-11-05T03:00:00.000Z tick",
			"main fast-forwarded a..b to origin/main",
			"node_modules rebuild failed, and the next pass retries it: x",
			"refused: main carries 1 commit(s) not on origin/main",
			"level main: failed: boom",
		];
		expect(levellingRefusals(lines, w, "/r")).toEqual([
			{
				at: Date.parse("2026-11-05T03:00:00Z"),
				line: "refused: main carries 1 commit(s) not on origin/main",
				root: null,
			},
			{
				at: Date.parse("2026-11-05T03:00:00Z"),
				line: "level main: failed: boom",
				root: null,
			},
		]);
	});

	it("keeps only the measured checkout's lines once reports name theirs", () => {
		const lines = [
			"2026-11-05T03:00:00.000Z tick",
			"levelling /other",
			"refused: git would not fast-forward a..b",
			"levelling /r",
			"refused: git would not fast-forward c..d",
		];
		expect(levellingRefusals(lines, w, "/r")).toEqual([
			{
				at: Date.parse("2026-11-05T03:00:00Z"),
				line: "refused: git would not fast-forward c..d",
				root: "/r",
			},
		]);
	});
});

describe("toolSpans", () => {
	it("pairs a call with its result across records", () => {
		const spans = toolSpans([
			{
				type: "assistant",
				timestamp: "2026-11-05T00:00:00.000Z",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Edit",
							input: { file_path: "/r/x" },
						},
					],
				},
			},
			{
				type: "user",
				timestamp: "2026-11-05T00:00:03.500Z",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "ok" }],
						},
					],
				},
			},
		]);
		expect(spans).toEqual([
			{
				name: "Edit",
				input: { file_path: "/r/x" },
				start: Date.parse("2026-11-05T00:00:00Z"),
				end: Date.parse("2026-11-05T00:00:03.5Z"),
				isError: false,
				result: "ok",
			},
		]);
	});
});

describe("landingOutcome", () => {
	const bash = (command: string, result: string, isError = false) => ({
		name: "Bash",
		input: { command },
		start: 0,
		end: 1,
		isError,
		result,
	});
	const Land = "node scripts/session-checkout.js land";
	const Merged =
		"pushed 0123abcd to queue/implement-9-abc123, origin/main merged in first";

	it("names the merge commit a landing route pushed", () => {
		expect(
			landingOutcome(
				bash(Land, `session checkout: ${Merged}\nlander: started`),
			),
		).toEqual({ kind: "merged", sha: "0123abcd" });
	});

	it("marks a landing route that errored as failed, so it is counted apart", () => {
		expect(landingOutcome(bash(Land, Merged, true))).toEqual({
			kind: "failed",
		});
	});

	it("marks a land a neighbour's push beat as moved, off the line session-checkout.js throws (#4446)", () => {
		expect(
			landingOutcome(bash(Land, `session checkout: ${MOVED_LINE}`, true)),
		).toEqual({ kind: "moved" });
	});

	it("marks a push with no merge as pushed, and names nothing where nothing landed or it was not the landing route", () => {
		expect(
			landingOutcome(
				bash(
					Land,
					"session checkout: pushed 0123abcd to queue/implement-9-abc123",
				),
			),
		).toEqual({ kind: "pushed" });
		expect(
			landingOutcome(bash(Land, "session checkout: nothing to land")),
		).toBeNull();
		expect(landingOutcome(bash("git merge origin/main", Merged))).toBeNull();
	});
});

describe("repoPath", () => {
	it("strips the main checkout or a worktree under it, and drops other paths", () => {
		expect(repoPath("/r", "/r/scripts/a.js")).toBe("scripts/a.js");
		expect(repoPath("/r", "/r/.claude/worktrees/w1/scripts/a.js")).toBe(
			"scripts/a.js",
		);
		expect(repoPath("/r", "/elsewhere/a.js")).toBeNull();
		expect(repoPath("/r", "/rx/a.js")).toBeNull();
	});
});

describe("spread", () => {
	it("reads nearest-rank percentiles, and nulls on no values", () => {
		expect(spread([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({
			n: 10,
			p50: 5,
			p90: 9,
			max: 10,
		});
		expect(spread([])).toEqual({ n: 0, p50: null, p90: null, max: null });
	});
});

describe("zeroChecks", () => {
	const spreadOf = spread([]);
	const reading = (over: Record<string, unknown> = {}) => ({
		main: { rows: [], moves: [], foreign: [], unlanded: [], lags: [] },
		reconcile: { worktrees: 1, entries: [] },
		refusals: [],
		absentLogs: [],
		dirt: { dirty: [], untracked: 0, touched: [] },
		costs: {
			transcripts: 0,
			unparsed: 0,
			edit: spreadOf,
			editErrors: 0,
			mergeToCommit: spreadOf,
			mergeCall: spreadOf,
			mergeUnread: 0,
			land: { merged: 0, pushed: 0, moved: 0, failed: 0 },
		},
		...over,
	});

	it("counts commits off origin/main, never a foreign entry that stranded none", () => {
		const r = reading({
			main: {
				rows: [],
				moves: [],
				foreign: [{ t: 0, sha: A, msg: "reset: moving to origin/main" }],
				unlanded: [],
				lags: [],
			},
		});
		expect(zeroChecks(r).map((k) => k.count)).toEqual([0, 0, 0, 0]);
		const one = reading({
			main: { rows: [], moves: [], foreign: [], unlanded: [B], lags: [] },
		});
		expect(zeroChecks(one)[0]?.count).toBe(1);
	});

	it("fails the render on any nonzero check, and passes an empty window", () => {
		const w = { since: 0, until: 1000 };
		expect(render(reading(), w).failed).toBe(false);
		const dirty = render(
			reading({ dirt: { dirty: ["a.txt"], untracked: 0, touched: [] } }),
			w,
		);
		expect(dirty.failed).toBe(true);
		expect(dirty.text).toMatch(/^FAIL tracked dirt in the main checkout: 1 /m);
	});

	it("reports the landing route's weekly rates against #4229's prediction and #4166's race window", () => {
		const day = 24 * 60 * 60_000;
		const r = reading();
		const text = render(
			{
				...r,
				costs: {
					...r.costs,
					land: { merged: 70, pushed: 20, moved: 10, failed: 0 },
				},
			},
			{ since: 0, until: day },
		).text;
		expect(text).toContain(
			"landing route a week: 490 merged origin/main first, of 630 pushed — below the predicted 491–587 (#4229; against 436 merges on the shared checkout); 70 refused as no fast-forward of the queue ref, 10.0% of 100 push attempt(s)",
		);
		expect(render(reading(), { since: 0, until: day }).text).toMatch(
			/0 refused as no fast-forward of the queue ref, — of 0 push attempt/,
		);
	});
});
