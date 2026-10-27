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
	buildReviewTitle,
} = require("./morning-review.js");
const { basisFaults } = require("./issue-gate.js");
const { titleFirstLinks } = require("./title-first-links.js");

const SINCE = "2026-10-17T07:00:00Z";
const NOW = "2026-10-18T07:00:00Z";
const DAY = 24 * 60 * 60 * 1000;

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
	kills: unknown = { incidents: [], tickets: new Map(), why: null },
) =>
	renderReview({
		since: SINCE,
		now: NOW,
		previous,
		repos: repos.map((r) => ({ urgent: [], parked: [], ...(r as object) })),
		failed,
		kills,
	});

describe("renderReview (#2011)", () => {
	it("lists each repo's open stall ticket, and says none is open where none is (#2692)", () => {
		const quiet = render([
			{ repo: "acme/a", entries: [], stalls: [], closed: [] },
		]);
		expect(quiet).toContain("## Landing stalls\n\nNone open.\n");
		const body = render([
			{
				repo: "acme/a",
				entries: [],
				stalls: [{ number: 41, title: "Landing queue stalled" }],
				closed: [],
			},
		]);
		expect(body).toContain(
			"## Landing stalls\n\n- acme/a#41 — `Landing queue stalled`\n",
		);
	});

	it("lists the window's memory kills by kind with each incident's ticket, and says none where there were none (#3094)", () => {
		const quiet = render([
			{ repo: "acme/a", entries: [], stalls: [], closed: [] },
		]);
		expect(quiet).toContain("## Memory kills\n\nNone in the window.\n");
		const killed = (at: string, pid: number, name: string, kind: string) => ({
			at,
			pid,
			uid: 1000,
			name,
			kind,
			badness: 741,
			rssMiB: 983,
			availMiB: 776,
			swapFreeMiB: 0,
			signals: 1,
		});
		const incident = {
			first: "2026-10-17T19:56:56.000Z",
			last: "2026-10-17T19:57:00.000Z",
			kills: [
				killed("2026-10-17T19:56:56.000Z", 1, "dbus-daemon", "other"),
				killed("2026-10-17T19:57:00.000Z", 2, "MainThread", "test or build"),
			],
		};
		const { incidentTitle } = require("./earlyoom-kills.js");
		const body = render(
			[{ repo: "acme/a", entries: [], stalls: [], closed: [] }],
			[],
			7,
			{
				incidents: [incident],
				tickets: new Map([[incidentTitle(incident), 52]]),
				why: null,
			},
		);
		expect(body).toContain(
			`## Memory kills\n\n2 in the window — Claude host 0, test or build 1, other 1.\n\n- \`${incidentTitle(incident)}\` — 2 kills: Claude host 0, test or build 1, other 1 — #52\n`,
		);
		expect(basisFaults(body)).toEqual([]);
	});

	it("counts only kills inside the window, and says why the journal or the tracker did not read (#3094)", () => {
		const { incidentTitle } = require("./earlyoom-kills.js");
		const at = (iso: string, pid: number) => ({
			at: iso,
			pid,
			uid: 1000,
			name: "2.1.310",
			kind: "Claude host",
			badness: 690,
			rssMiB: 450,
			availMiB: 776,
			swapFreeMiB: 0,
			signals: 1,
		});
		/* One kill at the window's start, owed to the previous review. */
		const edge = {
			first: SINCE,
			last: "2026-10-17T07:10:00Z",
			kills: [at(SINCE, 1), at("2026-10-17T07:10:00Z", 2)],
		};
		const repos = [{ repo: "acme/a", entries: [], stalls: [], closed: [] }];
		expect(
			render(repos, [], 7, {
				incidents: [edge],
				tickets: "HTTP 502",
				why: null,
			}),
		).toContain(
			`## Memory kills\n\n1 in the window — Claude host 1, test or build 0, other 0.\n\n- \`${incidentTitle(edge)}\` — 2 kills: Claude host 2, test or build 0, other 0 — ticket unread: \`HTTP 502\`\n`,
		);
		expect(
			render(repos, [], 7, {
				incidents: [],
				tickets: new Map(),
				why: "journalctl -u earlyoom: exit 1",
			}),
		).toContain(
			"## Memory kills\n\nNot read: `journalctl -u earlyoom: exit 1`.\n",
		);
	});

	it("lists still-caught entries by repo, numbered across repos, and counts the clear ones", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [
					entry("2026-10-17T09:00:00Z", 11, true, "Which key?"),
					entry("2026-10-17T10:00:00Z", 12, false),
				],
				stalls: [],
				closed: [],
			},
			{
				repo: "acme/b",
				entries: [entry("2026-10-17T11:00:00Z", 21, true, "Which cap?")],
				stalls: [],
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
				stalls: [],
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
				stalls: [],
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
				stalls: [],
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
				stalls: [],
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
					stalls: [],
					closed: [
						{
							...closed(9, "2026-10-17T08:00:00Z"),
							title: buildReviewTitle("2026-10-17"),
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
					stalls: [],
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
				stalls: [],
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
		expect(parseReviewDate(buildReviewTitle("2026-10-18"))).toBe("2026-10-18");
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
				stalls: [],
				closed: [],
			},
			{
				repo: "acme/b",
				entries: [entry("2026-10-17T11:00:00Z", 21, true)],
				stalls: [],
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

describe("stuck urgent (#2693)", () => {
	const daysAgo = (d: number) =>
		new Date(Date.parse(NOW) - d * DAY).toISOString();
	const urgent = (number: number, days: number, why: string | null) => ({
		number,
		title: `Urgent ${number}`,
		appliedAt: daysAgo(days),
		why,
	});

	it("lists an issue labelled urgent over 7 days ago with its age and why, and not one labelled 6 days ago", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [],
				stalls: [],
				closed: [],
				urgent: [
					urgent(31, 8, "container — 2 open children"),
					urgent(32, 6, null),
					urgent(33, 9, null),
				],
			},
		]);
		const section = body.slice(body.indexOf("## Stuck urgent"));
		expect(section).toContain(
			"- acme/a#31 — `Urgent 31` — 8 days — `container — 2 open children`\n",
		);
		expect(section).toContain(
			"- acme/a#33 — `Urgent 33` — 9 days — pick-next does not say why\n",
		);
		expect(section).not.toContain("#32");
		expect(basisFaults(body)).toEqual([]);
	});

	it("says none where no urgent is over 7 days old", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [],
				stalls: [],
				closed: [],
				urgent: [urgent(32, 6, null)],
			},
		]);
		expect(body).toContain("## Stuck urgent\n\n");
		expect(body.slice(body.indexOf("## Stuck urgent"))).toContain("\nNone.\n");
	});
});

describe("parked (#2725)", () => {
	const at = (hours: number) =>
		new Date(Date.parse(NOW) - hours * 60 * 60 * 1000).toISOString();
	const reading = (parked: unknown[]) => ({
		repo: "acme/a",
		entries: [],
		stalls: [],
		closed: [],
		parked,
	});
	const section = (body: string) =>
		body.slice(body.indexOf("## Parked"), body.indexOf("## Still-caught"));

	it("lists every parked issue with its age in whole days, and one whose start will not read as age unknown", () => {
		const body = render([
			reading([
				{ number: 40, title: "Parked overnight", appliedAt: at(9.5) },
				{ number: 41, title: "Parked a day", appliedAt: at(30) },
				{ number: 42, title: "Parked 2 days", appliedAt: at(49) },
				{
					number: 43,
					title: "Unread start",
					appliedAt: null,
					ageError: "HTTP 502",
				},
			]),
		]);
		expect(section(body)).toContain(
			"- acme/a#40 — `Parked overnight` — 0 days\n",
		);
		expect(section(body)).toContain("- acme/a#41 — `Parked a day` — 1 day\n");
		expect(section(body)).toContain("- acme/a#42 — `Parked 2 days` — 2 days\n");
		expect(section(body)).toContain(
			"- acme/a#43 — `Unread start` — age unknown: `HTTP 502`\n",
		);
		expect(basisFaults(body)).toEqual([]);
	});

	it("says none where nothing is parked", () => {
		expect(section(render([reading([])]))).toContain("\nNone.\n");
	});
});
