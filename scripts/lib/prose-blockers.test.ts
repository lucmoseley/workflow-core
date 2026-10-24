// @vitest-environment node
/*
 * The prose self-gate reader (mantahostels#1289). In-process against plain strings — no
 * filesystem, no `gh` — so a regression here is the anchoring regex itself,
 * never a fixture. `resolveProseBlockers`' own set-membership test needs no
 * seam either: `openNumbers` is a plain `Set`, not a store.
 *
 * `pick-next.js` reads it behind the `/pick-next` skill: loosen a case and the
 * picker offers an issue still blocked in prose, or holds back one that only
 * quotes the marker.
 */
import { describe, expect, it } from "vitest";

const { proseRefsOf, resolveProseBlockers } =
	require("./prose-blockers.js") as typeof import("./prose-blockers");

/*
 * The reading half of `resolveProseBlockers`, with nothing on the open list:
 * every named number lands in `named` whatever its state, so these cases pin
 * the marker parsing alone.
 */
const named = (body: string) => resolveProseBlockers(body, new Set()).named;
const unparsed = (body: string) =>
	resolveProseBlockers(body, new Set()).unparsed;

describe("resolveProseBlockers: the numbers a marker names", () => {
	it("returns nothing where the body carries no marker", () => {
		expect(named("no marker here")).toEqual([]);
	});

	it("reads the number off a marker at the head of its own line", () => {
		// The real shape (mantahostels#832, mantahostels#833, mantahostels#835).
		expect(named("**Blocked on** #831.")).toEqual([831]);
	});

	it("ignores the marker quoted mid-sentence as an example, never at a line's head", () => {
		// mantahostels#1289's own body does exactly this.
		expect(
			named(
				'#832, #833 and #835 each carry "**Blocked on** #831" in the body.',
			),
		).toEqual([]);
	});

	it("still reads a marker indented up to three spaces, CommonMark's un-indented rule", () => {
		expect(named("  **Blocked on** #831.")).toEqual([831]);
	});

	it("ignores a marker indented four spaces or more, a code block in CommonMark", () => {
		expect(named("    **Blocked on** #831.")).toEqual([]);
	});

	it("reads several, comma- or `and`-separated", () => {
		expect(named("**Blocked on** #10, #11 and #12.")).toEqual([10, 11, 12]);
	});

	it("dedupes and sorts", () => {
		expect(named("**Blocked on** #12, #10, #12.")).toEqual([10, 12]);
	});

	it("is case-insensitive on the marker", () => {
		expect(named("**blocked ON** #5")).toEqual([5]);
	});

	it("ignores a bare issue mention with no marker", () => {
		expect(named("see #831 for background")).toEqual([]);
	});
});

describe("resolveProseBlockers: open against resolved", () => {
	it("calls a named number still on the open list a live blocker", () => {
		const r = resolveProseBlockers("**Blocked on** #831.", new Set([831, 900]));
		expect(r).toEqual({
			named: [831],
			open: [831],
			resolved: [],
			unparsed: [],
		});
	});

	it("calls a named number absent from the open list resolved, no second call needed", () => {
		// mantahostels#831 closed; mantahostels#832/mantahostels#833/mantahostels#835 named it and were takeable all along.
		const r = resolveProseBlockers("**Blocked on** #831.", new Set([900]));
		expect(r).toEqual({
			named: [831],
			open: [],
			resolved: [831],
			unparsed: [],
		});
	});

	it("splits a mix of still-open and already-resolved blockers", () => {
		const r = resolveProseBlockers("**Blocked on** #1, #2.", new Set([1]));
		expect(r).toEqual({
			named: [1, 2],
			open: [1],
			resolved: [2],
			unparsed: [],
		});
	});
});

describe("resolveProseBlockers: a marker naming no number", () => {
	/*
	 * mantahostels#927's real body, verbatim. The marker opens mid-sentence and names a
	 * ROADMAP CARD, so it carries no number for the open-issue list to settle.
	 */
	const real =
		"Standalone: cross-cutting data-quality work. **Blocked on the `seed-listings` " +
		"roadmap card** — the checks are meaningless against an empty listings table.";

	it("reports a marker that names a roadmap card instead of an issue", () => {
		expect(unparsed(real)).toEqual([
			"**Blocked on the `seed-listings` roadmap card** — the checks are " +
				"meaningless against an empty listings table.",
		]);
	});

	it("matches mid-sentence, where the line-head anchor would miss it", () => {
		expect(named(real)).toEqual([]);
	});

	it("never double-reports the canonical form, which carries its number", () => {
		expect(unparsed("**Blocked on** #831.")).toEqual([]);
	});

	it("leaves a body quoting the marker as an example alone", () => {
		// Dropping the line-head anchor is safe because the quoted canonical
		// form still carries a `#<n>`, and the number test filters it.
		expect(unparsed("each carry `**Blocked on** #831` in the body")).toEqual(
			[],
		);
	});

	it("returns nothing where the body carries no marker at all", () => {
		expect(unparsed("no marker here")).toEqual([]);
	});

	it("stops the bold span at its own closing `**`", () => {
		expect(unparsed("**Blocked on the card** and **something**")).toEqual([
			"**Blocked on the card** and **something**",
		]);
	});

	it("surfaces on resolveProseBlockers, which excludes nothing on it", () => {
		const r = resolveProseBlockers(real, new Set([1, 2]));
		expect(r.named).toEqual([]);
		expect(r.open).toEqual([]);
		expect(r.unparsed).toHaveLength(1);
	});
});

describe("resolveProseBlockers: a reference into another repo (#2427)", () => {
	it("is matched in the marker but left to the graph, not named or resolved here", () => {
		const r = resolveProseBlockers(
			"**Blocked on** lucmoseley/mantahostels#3842 and #1.",
			new Set([1]),
		);
		expect(r).toEqual({
			named: [1],
			open: [1],
			resolved: [],
			unparsed: [],
		});
	});
});

describe("proseRefsOf: every reference a marker names", () => {
	it("keeps a reference's repo, null for a bare number", () => {
		expect(proseRefsOf("**Blocked on** o/x.y#5, #6 and o/x.y#5")).toEqual([
			{ repo: "o/x.y", number: 5 },
			{ repo: null, number: 6 },
		]);
	});
});
