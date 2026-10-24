/*
 * The morning review body, rendered from fixtures (#2011). Driven through
 * renderReview alone, the export the generator calls, so the body's shape is
 * pinned without gh. Break it and the founder's one daily read lists the wrong
 * window, drops an entry or a one-way close, or is refused at filing.
 */

import { describe, expect, it } from "vitest";

const {
	parseEntries,
	parseReviewDate,
	renderReview,
	reviewTitle,
} = require("./morning-review.js");
const { basisFaults } = require("./issue-gate.js");
const { titleFirstLinks } = require("./title-first-links.js");

const SINCE = "2026-10-17T07:00:00Z";
const NOW = "2026-10-18T07:00:00Z";

const entry = (at: string, issue: number, stillClose: boolean, q = "Q") => ({
	at,
	issue,
	comment: `https://github.com/acme/a/issues/${issue}#issuecomment-${issue}`,
	question: q,
	taken: { option: "(A) keep", figure: 55 },
	stillClose,
});

const closed = (number: number, closedAt: string, door?: string) => ({
	number,
	title: `Ticket ${number}`,
	url: `https://github.com/acme/a/issues/${number}`,
	closedAt,
	comments: [
		{ body: "**Door:** two-way — an earlier, superseded close" },
		{ body: door ? `Built.\n\n**Door:** ${door}\n` : "No door here." },
	],
});

const render = (
	repos: unknown[],
	failed: unknown[] = [],
	previous: number | null = 7,
) => renderReview({ since: SINCE, now: NOW, previous, repos, failed });

describe("renderReview (#2011)", () => {
	it("lists still-caught entries by repo, numbered across repos, and counts the clear ones", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [
					entry("2026-10-17T09:00:00Z", 11, true, "Which key?"),
					entry("2026-10-17T10:00:00Z", 12, false),
				],
				closed: [],
			},
			{
				repo: "acme/b",
				entries: [entry("2026-10-17T11:00:00Z", 21, true, "Which cap?")],
				closed: [],
			},
		]);
		expect(body.startsWith("## Question\n")).toBe(true);
		expect(body).toContain(
			"### acme/a\n\n1. acme/a#11 — `Which key?` — taken: `(A) keep` (55%) — [#11 comment](https://github.com/acme/a/issues/11#issuecomment-11)",
		);
		expect(body).toContain("### acme/b\n\n2. acme/b#21 — `Which cap?`");
		expect(body).toMatch(
			/1 made in the window — \[search\]\(.*repo%3Aacme%2Fa/,
		);
		const clear = body.split("## Clear delegated decisions")[1] ?? "";
		expect(clear.split("## Closed")[0]).not.toContain("acme%2Fb");
		expect(body).toContain("from #7, the previous review issue");
	});

	it("lists an entry recorded still caught at a not-close 65/35 top, and searches the clear ones under both wordings (#2594)", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [
					{
						...entry("2026-10-17T09:00:00Z", 11, true, "Low top"),
						taken: { option: "(A) keep", figure: 65 },
						runnerUp: { option: "(B) drop", figure: 35 },
					},
					entry("2026-10-17T10:00:00Z", 12, false),
				],
				closed: [],
			},
		]);
		const listed = body.split("## Clear delegated decisions")[0] ?? "";
		expect(listed).toContain(
			"1. acme/a#11 — `Low top` — taken: `(A) keep` (65%)",
		);
		const search = /\[search\]\(([^)]+)\)/.exec(
			body.split("## Clear delegated decisions")[1] ?? "",
		)?.[1];
		const q = new URL(search ?? "").searchParams.get("q");
		expect(q).toContain('("Still caught: no" OR "Still close: no")');
	});

	it("cites each still-caught entry's comment link by number, so the citation check finds no title-first link in it (#2265)", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [entry("2026-10-17T09:00:00Z", 11, true)],
				closed: [],
			},
		]);
		expect(body).toContain("/issues/11#issuecomment-11)");
		expect(titleFirstLinks(body, "acme/a")).toEqual([]);
		expect(
			titleFirstLinks(
				"[comment](https://github.com/acme/a/issues/11#issuecomment-11)",
				"acme/a",
			),
		).toEqual([{ target: 11, linkText: "comment" }]);
	});

	it("holds the window to (since, now]: an entry or close at the previous issue's instant is that issue's, one at now is this one's", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [
					entry(SINCE, 1, true, "At since"),
					entry(NOW, 2, true, "At now"),
					entry("2026-10-18T07:00:01Z", 3, true, "After now"),
				],
				closed: [
					closed(40, SINCE, "one-way — at since"),
					closed(41, NOW, "one-way — at now"),
				],
			},
		]);
		expect(body).not.toContain("At since");
		expect(body).toContain("1. acme/a#2 — `At now`");
		expect(body).not.toContain("After now");
		expect(body).toContain("1 closed in the window");
		expect(body).toContain("acme/a#41 — `Ticket 41` — `at now`");
		expect(body).not.toContain("acme/a#40");
	});

	it("lists every one-way close and every still-caught entry uncapped, off each close's last Door line", () => {
		const many = Array.from({ length: 40 }, (_, i) => i + 100);
		const body = render([
			{
				repo: "acme/a",
				entries: many.map((n) => entry("2026-10-17T12:00:00Z", n, true)),
				closed: [
					...many.map((n) =>
						closed(n, "2026-10-17T12:00:00Z", `one-way — undo ${n}`),
					),
					closed(200, "2026-10-17T12:00:00Z", "two-way — revert"),
					closed(201, "2026-10-17T12:00:00Z"),
				],
			},
		]);
		expect(body).toContain("40. acme/a#139");
		expect(body.match(/^- acme\/a#\d+ — `Ticket/gm)).toHaveLength(40);
		expect(body).toContain("- acme/a#139 — `Ticket 139` — `undo 139`");
		expect(body).toContain("42 closed in the window");
		expect(body).not.toContain("acme/a#200 —");
	});

	it("says none, names an unread repo, and counts an earlier review issue in the tally its search link shows", () => {
		const body = render(
			[
				{
					repo: "acme/a",
					entries: [],
					closed: [
						{
							...closed(9, "2026-10-17T08:00:00Z"),
							title: reviewTitle("2026-10-17"),
						},
					],
				},
			],
			[{ repo: "acme/c", why: "HTTP 502" }],
			null,
		);
		expect(body).toContain("## Still-caught delegated decisions\n\nNone");
		expect(body).toContain("## Clear delegated decisions\n\nNone");
		expect(body).toContain("1 closed in the window");
		expect(body).toContain("- acme/c: `HTTP 502`");
		expect(body).toContain("no previous review issue");
		expect(body).toContain("comment `reverse <entry number>`");
	});

	it("passes file-issue.js's basis check whatever the copied-in text says", () => {
		const body = render(
			[
				{
					repo: "acme/a",
					entries: [
						entry(
							"2026-10-17T09:00:00Z",
							5,
							true,
							"Should the cache expire 7 days after the last `write`?",
						),
					],
					closed: [
						{
							...closed(
								6,
								"2026-10-17T09:00:00Z",
								"one-way — wait 2 weeks after",
							),
							title: "Re-run 3 days after the deploy",
						},
					],
				},
			],
			[],
			null,
		);
		expect(basisFaults(body)).toEqual([]);
		expect(body).toContain(
			"`Should the cache expire 7 days after the last 'write'?`",
		);
	});

	it("reads each close's last Door line only, and parses only a review title's date", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [],
				closed: [
					{
						...closed(50, "2026-10-17T09:00:00Z"),
						comments: [
							{ body: "**Door:** one-way — old" },
							{ body: "**Door:** two-way — new" },
						],
					},
				],
			},
		]);
		expect(body).toContain("One-way closes:\n\nNone");
		expect(parseReviewDate(reviewTitle("2026-10-18"))).toBe("2026-10-18");
		expect(parseReviewDate("Morning review — notes")).toBeNull();
	});
});

describe("parseEntries (#2017)", () => {
	it("reads back every still-caught entry the body numbers, by number", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [
					entry("2026-10-17T09:00:00Z", 11, true, "Which `key` — A or B?"),
					entry("2026-10-17T10:00:00Z", 12, false),
				],
				closed: [],
			},
			{
				repo: "acme/b",
				entries: [entry("2026-10-17T11:00:00Z", 21, true)],
				closed: [],
			},
		]);
		expect([...parseEntries(body)]).toEqual([
			[
				1,
				{
					repo: "acme/a",
					issue: 11,
					comment: "https://github.com/acme/a/issues/11#issuecomment-11",
				},
			],
			[
				2,
				{
					repo: "acme/b",
					issue: 21,
					comment: "https://github.com/acme/a/issues/21#issuecomment-21",
				},
			],
		]);
	});

	it("reads no entry from a line whose link names another issue than its entry's (#2265)", () => {
		const line =
			"1. acme/a#11 — `Q` — taken: `(A) keep` (55%) — [#12 comment](https://github.com/acme/a/issues/11#issuecomment-11)";
		expect(parseEntries(line).size).toBe(0);
	});

	it("reads no entry from a body listing none", () => {
		expect(parseEntries(render([])).size).toBe(0);
	});
});
