// @vitest-environment node
/*
 * The trial-scoped read gate 2 turns on (mantahostels#2849). Its ordinary sibling — the
 * three-seat upward trigger, the rolled-window figure, `readSeats`, `recordReading`
 * and `rungOneLogged` — is covered beside the checker in
 * `scripts/check-seat-utilisation.test.ts`; this file is the layer added over
 * it, which is a separate read and never an edit to that one (mantahostels#2845).
 *
 * WHY THE COVERAGE IS HEAVY FOR THE SIZE. The trial runs once, for a fortnight,
 * and the window cannot be replayed: a branch that silently fails to fire is
 * unrecoverable, which is the exact defect mantahostels#2835 was opened on.
 *
 * In-process, on hand-built readings against a fixed clock (`NOW`), so every
 * branch of the window can be reached without waiting a fortnight for it.
 * `check-seat-utilisation.js` runs it as a SessionStart hook in
 * `.claude/settings.json`; a loosened case lets gate 2 stay silent through the
 * one window it is read in.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	readHistory,
	scopedVerdict,
	trialReview,
	trialVerdict,
	// eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("./seat-utilisation.js");

const NOW = Date.parse("2026-09-15T12:00:00Z");
const HOUR = 36e5;
/** A reset comfortably outside the 24 h the policy waits out. */
const FAR = new Date(NOW + 72 * HOUR).toISOString();
/** …and one inside it. */
const NEAR = new Date(NOW + 6 * HOUR).toISOString();

const BASELINE = {
	sevenDay: 62,
	resetsAt: "2026-09-20T21:00:00Z",
	fetchedAtMs: Date.parse("2026-09-09T07:00:00Z"),
};

const DECL = {
	state: "declared",
	dir: ".claude3",
	accountUuid: "acct-3",
	startIso: "2026-09-10T21:00:00Z",
	endIso: "2026-09-24T21:00:00Z",
	startMs: Date.parse("2026-09-10T21:00:00Z"),
	endMs: Date.parse("2026-09-24T21:00:00Z"),
	basis: [
		{ dir: ".claude", resetsAt: "2026-09-10T21:00:00Z", staleHours: 1 },
		{ dir: ".claude2", resetsAt: "2026-09-10T21:00:00Z", staleHours: 1 },
	],
	excludedBaseline: BASELINE,
};

interface ScopedBarOver {
	model: string;
	percent: number;
	effective: number;
	resetsAt?: string | null;
	severity?: string | null;
	rolled?: boolean;
}

type SeatOver = Partial<{
	dir: string;
	accountUuid: string | null;
	unread: boolean;
	sevenDay: number | null;
	resetsAt: string | null;
	fetchedAtMs: number | null;
	/** Only ever set on a HISTORY row, which spells the stamp as an ISO string. */
	fetchedAt: string;
	scopedBars: ScopedBarOver[];
}>;

/** One `weekly_scoped` bar, already judged — `scopedVerdict()` takes `Seat[]`
 * off `readSeats()`, never raw cache JSON, so its own tests build the bar
 * shape directly rather than through the judging `readSeats()` does. */
const scopedBar = (
	model: string,
	percent: number,
	over: Partial<ScopedBarOver> = {},
) => ({
	model,
	percent,
	severity: "x",
	resetsAt: FAR,
	effective: percent,
	rolled: false,
	...over,
});

const seat = (dir: string, sevenDay: number | null, over: SeatOver = {}) => ({
	dir,
	accountUuid: `acct-${dir.slice(-1)}`,
	unread: false,
	sevenDay,
	fiveHour: 10,
	effective: sevenDay,
	resetsAt: FAR,
	fetchedAtMs: NOW - HOUR,
	staleHours: 1,
	rolled: false,
	severity: "x",
	...over,
});

/** Seat 3 as the declaration describes it, untouched since. */
const seat3 = (over: SeatOver = {}) =>
	seat(".claude3", BASELINE.sevenDay, {
		accountUuid: "acct-3",
		resetsAt: BASELINE.resetsAt,
		fetchedAtMs: BASELINE.fetchedAtMs,
		...over,
	});

describe("trialVerdict — what it refuses to honour", () => {
	it("honours nothing when no trial is declared, and says so without a reason", () => {
		const t = trialVerdict([seat(".claude", 100)], { state: "none" }, NOW);
		expect(t).toEqual({ honoured: false, reason: null });
	});

	it("carries a malformed declaration's own reason through", () => {
		const t = trialVerdict(
			[],
			{ state: "malformed", reason: "bad dates" },
			NOW,
		);
		expect(t.honoured).toBe(false);
		expect(t.reason).toBe("bad dates");
	});

	it("refuses when the declared account is not among the seats read", () => {
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 100)],
			DECL,
			NOW,
		);
		expect(t.honoured).toBe(false);
		expect(t.reason).toMatch(/not among the 2 seat\(s\) read/);
	});

	it("refuses when the declared directory and account name different seats", () => {
		/* readSeats deduplicates by account, so the survivor may not be the row
		 * the founder wrote the line about (mantahostels#2847 Q3). */
		const t = trialVerdict(
			[seat(".claude", 100), seat3({ dir: ".claude9" })],
			DECL,
			NOW,
		);
		expect(t.honoured).toBe(false);
		expect(t.reason).toMatch(
			/names `\.claude3` but account acct-3 reads as `\.claude9`/,
		);
	});
});

describe("trialVerdict — the trigger over the seats the trial leaves live", () => {
	it("fires when both remaining seats are exhausted, ignoring the excluded one", () => {
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 100), seat3()],
			DECL,
			NOW,
		);
		expect(t.honoured).toBe(true);
		expect(t.verdict.fired).toBe(true);
		expect(t.verdict.read).toHaveLength(2);
		expect(t.excluded.dir).toBe(".claude3");
	});

	it("does not fire when one remaining seat still has allowance", () => {
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 40), seat3()],
			DECL,
			NOW,
		);
		expect(t.verdict.fired).toBe(false);
	});

	it("does not fire when the earliest remaining reset is inside the 24h wait", () => {
		const t = trialVerdict(
			[
				seat(".claude", 100, { resetsAt: NEAR }),
				seat(".claude2", 100),
				seat3(),
			],
			DECL,
			NOW,
		);
		expect(t.verdict.fired).toBe(false);
		expect(t.verdict.allExhausted).toBe(true);
	});

	it("keeps the excluded seat EXCLUDED and never recast as unread (mantahostels#1742)", () => {
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 100), seat3()],
			DECL,
			NOW,
		);
		expect(t.verdict.unread).toHaveLength(0);
		expect(t.verdict.seats.map((s: { dir: string }) => s.dir)).toEqual([
			".claude",
			".claude2",
		]);
	});

	it("still lets an UNREAD remaining seat block the fire, recording that the panel is needed (mantahostels#1742)", () => {
		const t = trialVerdict(
			[
				seat(".claude", 100),
				seat(".claude2", null, { unread: true, accountUuid: null }),
				seat3(),
			],
			DECL,
			NOW,
		);
		expect(t.verdict.fired).toBe(false);
		expect(t.verdict.panelNeeded).toBe(true);
	});

	it("would fire on a seat 3 the trial did not exclude — the blindness mantahostels#2835 opened on", () => {
		/* The ordinary read over all three: seat 3's frozen 62% is what keeps the
		 * every-live-seat test false for the whole fortnight. */
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 100), seat3()],
			DECL,
			NOW,
		);
		const { verdict } = require("./seat-utilisation.js");
		expect(
			verdict([seat(".claude", 100), seat(".claude2", 100), seat3()], NOW)
				.fired,
		).toBe(false);
		expect(t.verdict.fired).toBe(true);
	});
});

/** What the honoured trial read says of seat 3's own use, beside two live
 *  seats with allowance left. */
const seat3Use = (excluded: ReturnType<typeof seat3>) =>
	trialVerdict([seat(".claude", 40), seat(".claude2", 40), excluded], DECL, NOW)
		.use;

describe("the trial's read of seat 3's use — void, annotate, or clean (mantahostels#2848 Q3)", () => {
	it("is clean where seat 3's cache has not moved at all", () => {
		expect(seat3Use(seat3()).kind).toBe("clean");
	});

	it("VOIDS where the 7-day figure rose inside seat 3's declared window", () => {
		const u = seat3Use(seat3({ sevenDay: 63 }));
		expect(u.kind).toBe("void");
		expect(u.detail).toMatch(/rose from 62% to 63%/);
	});

	it("VOIDS where seat 3's window rolled and the new one is being spent", () => {
		const u = seat3Use(
			seat3({ resetsAt: "2026-09-27T21:00:00Z", sevenDay: 4 }),
		);
		expect(u.kind).toBe("void");
		expect(u.detail).toMatch(/4% of the new window/);
	});

	it("reads sub-second jitter in resets_at as the same window, not a roll", () => {
		const u = seat3Use(seat3({ resetsAt: "2026-09-20T20:59:59.886397+00:00" }));
		expect(u.kind).toBe("clean");
	});

	it("never reads a missing or unparseable reset as the declared window (mantahostels#3379)", () => {
		expect(seat3Use(seat3({ resetsAt: null })).kind).not.toBe("clean");
		expect(seat3Use(seat3({ resetsAt: "not a date" })).kind).not.toBe("clean");
	});

	it("ANNOTATES a roll that spent nothing, rather than voiding on a touch", () => {
		/* mantahostels#2848 rejected voiding on any sign of life: one accidental session must
		 * not cost another 14-21 days on a window that cannot be replayed. */
		const u = seat3Use(
			seat3({ resetsAt: "2026-09-27T21:00:00Z", sevenDay: 0 }),
		);
		expect(u.kind).toBe("annotated");
	});

	it("ANNOTATES a bare fetch advance with the figure unchanged", () => {
		const u = seat3Use(seat3({ fetchedAtMs: NOW - HOUR }));
		expect(u.kind).toBe("annotated");
		expect(u.detail).toMatch(/unchanged at 62%/);
	});

	it("ANNOTATES rather than voids where seat 3's cache became unreadable", () => {
		expect(seat3Use(seat3({ unread: true })).kind).toBe("annotated");
	});

	it("does not void on a FALL, which is a window rolling and not work", () => {
		expect(
			seat3Use(seat3({ sevenDay: 3, fetchedAtMs: BASELINE.fetchedAtMs })).kind,
		).toBe("clean");
	});
});

/** Shared by every `trialReview` test below, whichever `describe` it sits in. */
const row = (at: string, a: number, b: number, three: SeatOver = {}) => ({
	at,
	seats: [
		{ dir: ".claude", accountUuid: "acct-", sevenDay: a, resetsAt: FAR },
		{ dir: ".claude2", accountUuid: "acct-2", sevenDay: b, resetsAt: FAR },
		{
			dir: ".claude3",
			accountUuid: "acct-3",
			sevenDay: BASELINE.sevenDay,
			resetsAt: BASELINE.resetsAt,
			fetchedAt: new Date(BASELINE.fetchedAtMs).toISOString(),
			...three,
		},
	],
});

describe("trialReview — the fortnight read back off the daily series", () => {
	it("passes a fortnight in which the condition never held", () => {
		const r = trialReview(
			[
				row("2026-09-11T00:00:00Z", 40, 50),
				row("2026-09-20T00:00:00Z", 90, 20),
			],
			DECL,
		);
		expect(r.kind).toBe("passed");
		expect(r.readingCount).toBe(2);
	});

	it("fails on a fire the live session start missed, recording the missed fire", () => {
		const r = trialReview(
			[
				row("2026-09-11T00:00:00Z", 40, 50),
				row("2026-09-14T00:00:00Z", 100, 100),
			],
			DECL,
		);
		expect(r.kind).toBe("failed");
		expect(r.fires).toHaveLength(1);
		expect(r.fires[0].at).toBe("2026-09-14T00:00:00Z");
	});

	it("VOIDS ahead of a fire, because a used seat 3 makes the fire unreadable", () => {
		const r = trialReview(
			[row("2026-09-14T00:00:00Z", 100, 100, { sevenDay: 70 })],
			DECL,
		);
		expect(r.kind).toBe("void");
		expect(r.voids).toHaveLength(1);
	});

	it("ignores rows outside the declared window, and calls that UNMEASURED", () => {
		/* Not "passed": a window nothing observed must not prescribe retiring a
		 * $200/month seat, and the two consumers must not disagree about it. */
		const r = trialReview(
			[
				row("2026-09-01T00:00:00Z", 100, 100),
				row("2026-09-30T00:00:00Z", 100, 100),
			],
			DECL,
		);
		expect(r.kind).toBe("unmeasured");
		expect(r.readingCount).toBe(0);
	});

	it("does not count a row carrying no declared seat as coverage", () => {
		const bare = {
			at: "2026-09-12T00:00:00Z",
			seats: [
				{ dir: ".claude", accountUuid: "acct-", sevenDay: 40, resetsAt: FAR },
			],
		};
		const r = trialReview([bare], DECL);
		expect(r.readingCount).toBe(0);
		expect(r.kind).toBe("unmeasured");
	});

	it("reports readHistory()'s dropped-line count under droppedLines (mantahostels#2871)", () => {
		const rows = Object.assign(
			[
				row("2026-09-11T00:00:00Z", 40, 50),
				row("2026-09-20T00:00:00Z", 90, 20),
			],
			{ dropped: 3 },
		);
		expect(trialReview(rows, DECL).droppedLines).toBe(3);
	});

	it("reads droppedLines as 0 off a plain array with no rider", () => {
		expect(
			trialReview(
				[
					row("2026-09-11T00:00:00Z", 40, 50),
					row("2026-09-20T00:00:00Z", 90, 20),
				],
				DECL,
			).droppedLines,
		).toBe(0);
	});
});

describe("readHistory — counting what it drops", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-history-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("counts an unparseable line as dropped, not silently", () => {
		const file = path.join(dir, "history.jsonl");
		fs.writeFileSync(
			file,
			[
				'{"at":"2026-09-11T00:00:00Z","seats":[]}',
				"{not json at all, a truncated write",
				'{"at":"2026-09-12T00:00:00Z","seats":[]}',
			].join("\n"),
		);
		const rows = readHistory(file);
		expect(rows).toHaveLength(2);
		expect(rows.dropped).toBe(1);
	});

	it("counts a well-formed JSON line missing `at` as dropped too", () => {
		const file = path.join(dir, "history.jsonl");
		fs.writeFileSync(file, '{"seats":[]}\n');
		const rows = readHistory(file);
		expect(rows).toHaveLength(0);
		expect(rows.dropped).toBe(1);
	});

	it("reports 0 dropped on an unreadable file, never throwing", () => {
		const rows = readHistory(path.join(dir, "nope.jsonl"));
		expect(rows).toHaveLength(0);
		expect(rows.dropped).toBe(0);
	});
});

describe("trialVerdict's basis refusal, and trialReview's gap and annotation handling", () => {
	it("refuses a basis that names only some of the remaining seats", () => {
		const partial = {
			...DECL,
			basis: [
				{ dir: ".claude", resetsAt: "2026-09-10T21:00:00Z", staleHours: 1 },
			],
		};
		const t = trialVerdict(
			[seat(".claude", 100), seat(".claude2", 100), seat3()],
			partial,
			NOW,
		);
		expect(t.honoured).toBe(false);
		expect(t.reason).toMatch(/names no reset for `\.claude2`/);
	});

	it("measures the largest gap from both edges, not just between readings", () => {
		/* One reading in the middle of a 14-day window: the gap to the END is the
		 * biggest hole, and a review that only looked between rows would report 0. */
		const r = trialReview([row("2026-09-12T21:00:00Z", 40, 40)], DECL);
		expect(Math.round(r.largestGapHours)).toBe(288);
	});

	it("reports annotations without letting them change the verdict", () => {
		const r = trialReview(
			[
				row("2026-09-12T00:00:00Z", 40, 40, {
					fetchedAt: "2026-09-12T00:00:00Z",
				}),
			],
			DECL,
		);
		expect(r.kind).toBe("passed");
		expect(r.annotations).toHaveLength(1);
	});
});

describe("scopedVerdict — #298's second state (#304)", () => {
	it("fires a model only when every readable seat's bar for it is over ceiling", () => {
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			seat(".claude2", 20, { scopedBars: [scopedBar("Fable", 100)] }),
		];
		const sx = scopedVerdict(seats);
		expect(sx.fired).toBe(true);
		expect(sx.exhausted.map((m: { model: string }) => m.model)).toEqual([
			"Fable",
		]);
	});

	it("never fires while any seat's bar for that model still has headroom", () => {
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			seat(".claude2", 20, { scopedBars: [scopedBar("Fable", 12)] }),
		];
		expect(scopedVerdict(seats).fired).toBe(false);
	});

	it("vetoes a model a readable seat carries no bar for at all, rather than treating it as spent or as headroom", () => {
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			seat(".claude2", 20, { scopedBars: [] }),
		];
		expect(scopedVerdict(seats).fired).toBe(false);
	});

	it("holds the fire in total silence on a whole-cache-unread seat, mirroring verdict()'s own split", () => {
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			{ ...seat(".claude2", null), unread: true },
		];
		const sx = scopedVerdict(seats);
		expect(sx.fired).toBe(false);
		expect(sx.heldFire).toBe(true);
		expect(sx.unread.map((s: { dir: string }) => s.dir)).toEqual([".claude2"]);
	});

	it("reads a cache with no numeric seven-day figure as unread too, exactly as verdict() does", () => {
		/* A cache present but carrying nothing readable — `effective: null` —
		 * is unread for the same reason an absent one is (#298 ruling 3). */
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			seat(".claude2", null, { scopedBars: [scopedBar("Fable", 100)] }),
		];
		const sx = scopedVerdict(seats);
		expect(sx.fired).toBe(false);
		expect(sx.heldFire).toBe(true);
	});

	it("handles N bars: two models, only the fully-exhausted one fires", () => {
		const seats = [
			seat(".claude", 50, {
				scopedBars: [scopedBar("Fable", 100), scopedBar("Opus", 40)],
			}),
			seat(".claude2", 50, {
				scopedBars: [scopedBar("Fable", 100), scopedBar("Opus", 30)],
			}),
		];
		const sx = scopedVerdict(seats);
		expect(sx.exhausted.map((m: { model: string }) => m.model)).toEqual([
			"Fable",
		]);
	});

	it("never touches the ordinary verdict's fired, allExhausted or panelNeeded", () => {
		const { verdict } = require("./seat-utilisation.js");
		const seats = [
			seat(".claude", 16, { scopedBars: [scopedBar("Fable", 100)] }),
			seat(".claude2", 20, { scopedBars: [scopedBar("Fable", 100)] }),
		];
		const v = verdict(seats, NOW);
		expect(v.fired).toBe(false);
		expect(v.allExhausted).toBe(false);
		expect(v.panelNeeded).toBe(false);
		expect(scopedVerdict(seats).fired).toBe(true);
	});
});
