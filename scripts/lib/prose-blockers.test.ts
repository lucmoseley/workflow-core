// @vitest-environment node
import { describe, expect, it } from "vitest";

const { judgeProseRefs, proseRefsOf, unparsedBlockersOf } =
	require("./prose-blockers.js") as typeof import("./prose-blockers");

/* guess: far longer than any real blocker list or owner name (#5559) */
const LONG = 30_000;

const named = (body: string) => proseRefsOf(body).map((r) => r.number);
const unparsed = unparsedBlockersOf;

describe("proseRefsOf: the numbers a marker names", () => {
	it("returns nothing where the body carries no marker", () => {
		expect(named("no marker here")).toEqual([]);
	});

	it("reads the number off a marker at the head of its own line", () => {
		expect(named("**Blocked on** #831.")).toEqual([831]);
	});

	it("ignores the marker quoted mid-sentence as an example, never at a line's head", () => {
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

	it("dedupes, in marker order", () => {
		expect(named("**Blocked on** #12, #10, #12.")).toEqual([12, 10]);
	});

	it("is case-insensitive on the marker", () => {
		expect(named("**blocked ON** #5")).toEqual([5]);
	});

	it.each([
		[
			"**Blocked on** o/r#5 and #6, x.y/z-w#7",
			[
				{ repo: "o/r", number: 5 },
				{ repo: null, number: 6 },
				{ repo: "x.y/z-w", number: 7 },
			],
		],
		[
			"**Blocked on** #12abc/def#3",
			[
				{ repo: null, number: 12 },
				{ repo: "abc/def", number: 3 },
			],
		],
		[
			"**Blocked on** #5#6",
			[
				{ repo: null, number: 5 },
				{ repo: null, number: 6 },
			],
		],
		[
			"**Blocked on**#5 AND #6",
			[
				{ repo: null, number: 5 },
				{ repo: null, number: 6 },
			],
		],
		["**Blocked on** #5 , and #6", [{ repo: null, number: 5 }]],
		["**Blocked on** #5 or #6", [{ repo: null, number: 5 }]],
		["**Blocked on** a/b/c#4 #9", []],
		[
			"**Blocked on** #1\n**Blocked on** #2\r\n**Blocked on** #3",
			[1, 2, 3].map((number) => ({ repo: null, number })),
		],
	])("reads the list in %j up to its first non-reference", (body, refs) => {
		expect(proseRefsOf(body)).toEqual(refs);
	});

	it("reads every reference in a long list", () => {
		const list = Array.from({ length: LONG }, (_, i) => `#${i + 1}`);
		expect(named(`**Blocked on** ${list.join(", ")}`)).toHaveLength(LONG);
	});

	it("reads nothing from a long owner-shaped word with no reference after it", () => {
		expect(
			named(`**Blocked on** ${"a".repeat(LONG)}/${"b".repeat(LONG)}`),
		).toEqual([]);
	});

	it("ignores a bare issue mention with no marker", () => {
		expect(named("see #831 for background")).toEqual([]);
	});
});

describe("unparsedBlockersOf: a marker naming no number", () => {
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
});

describe("proseRefsOf: every reference a marker names", () => {
	it("keeps a reference's repo, null for a bare number", () => {
		expect(proseRefsOf("**Blocked on** o/x.y#5, #6 and o/x.y#5")).toEqual([
			{ repo: "o/x.y", number: 5 },
			{ repo: null, number: 6 },
		]);
	});
});

describe("judgeProseRefs: open, closed and unreadable (#3271)", () => {
	const reads: string[] = [];
	const readIssue = async (ref: { repo: string | null; number: number }) => {
		reads.push(`${ref.repo}#${ref.number}`);
		if (ref.number === 9) return { ok: false as const, error: "HTTP 404" };
		return {
			ok: true as const,
			issue: { state: ref.number === 4 ? "open" : "closed" },
		};
	};

	it("answers bare and own-repo refs from the open set, reading only other repos", async () => {
		reads.length = 0;
		const r = await judgeProseRefs(
			proseRefsOf("**Blocked on** #1, O/App#2, #3, o/lib#4, o/lib#5, o/lib#9"),
			{ openLocal: new Set([1, 2]), ownRepo: "o/app", readIssue },
		);
		expect(r.open).toEqual([
			{ repo: null, number: 1 },
			{ repo: "O/App", number: 2 },
			{ repo: "o/lib", number: 4 },
		]);
		expect(r.closed).toEqual([
			{ repo: null, number: 3 },
			{ repo: "o/lib", number: 5 },
		]);
		expect(r.unreadable).toEqual([
			{ ref: { repo: "o/lib", number: 9 }, error: "HTTP 404" },
		]);
		expect(reads).toEqual(["o/lib#4", "o/lib#5", "o/lib#9"]);
	});
});
