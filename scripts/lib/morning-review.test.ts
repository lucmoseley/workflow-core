/*
 * The morning review body, rendered from fixtures (#2011). Rendered through
 * renderReview, the export the generator calls, so the body's shape is pinned
 * without gh. Break it and the founder's one daily read lists the wrong
 * window, drops an entry or a one-way close, or is refused at filing.
 */

import { describe, expect, it } from "vitest";

const {
	parseEntries,
	parseReviewDate,
	renderReview,
	buildReviewTitle,
	closeEdge,
	parseHistoryCursor,
	windowStart,
} = require("./morning-review.js");
const { buildAbsentRepos, buildRepoStart } = require("./review-carry.js");
const { basisFaults } = require("./issue-gate.js");
const { readout } = require("./concurrency.js");
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

const MIN = 60 * 1000;

const QUIET_IDLE = { trackers: [], loopRunning: true, damaged: [] };

/** The readout core's 24-hour and 7-day readouts ending at NOW. */
const concurrencyOver = (ticks: unknown[], minutes: unknown[] | null) => {
	const r = (windowMs: number) =>
		readout({ ticks, minutes, now: Date.parse(NOW), windowMs });
	return { day: r(DAY), week: r(7 * DAY) };
};

const COUNT_LINE =
	"primitives: 2 enforced, 0 open breaches, 1 new heresies since the last sweep";
const HEAD = "a".repeat(40);
const QUIET_PRIMITIVES = {
	count: { line: COUNT_LINE },
	history: { commits: [], tip: HEAD, whyByTime: null },
};

const QUIET_KILLS = { incidents: [], tickets: new Map(), why: null };
const QUIET_RUNAWAYS = { episodes: [], tickets: new Map(), why: null };

const renderWith = (overrides: object) =>
	renderReview({
		since: SINCE,
		now: NOW,
		previous: 7,
		repos: [],
		failed: [],
		unreadEvents: [],
		holds: [],
		kills: QUIET_KILLS,
		runaways: QUIET_RUNAWAYS,
		concurrency: concurrencyOver([], []),
		idle: QUIET_IDLE,
		wslCurrency: null,
		...overrides,
	});

const QUIET_READING = {
	checkout: "wfc",
	closesSince: SINCE,
	decisionsSince: SINCE,
	urgent: [],
	parked: [],
	primitives: QUIET_PRIMITIVES,
};

const render = (
	repos: unknown[],
	failed: unknown[] = [],
	previous: number | null = 7,
	kills: unknown = QUIET_KILLS,
) =>
	renderWith({
		previous,
		repos: repos.map((r) => ({ ...QUIET_READING, ...(r as object) })),
		failed,
		kills,
	});

describe("the next run's bookkeeping (#3844, #3934)", () => {
	const buildReading = (
		checkout: string,
		repo: string,
		primitives: object = QUIET_PRIMITIVES,
	) => ({ checkout, repo, entries: [], stalls: [], closed: [], primitives });
	const ReadOneHistory = [
		buildReading("my wfc", "acme/a"),
		buildReading("second", "acme/b", {
			count: { line: COUNT_LINE },
			history: { why: "git: fatal" },
		}),
	];
	/* No code writes this since #3934, but reviews filed before it stay input:
	 * parseHistoryCursor walks back through older bodies. */
	const VisibleFormat = [
		"## Primitives",
		"",
		"### acme/a",
		"",
		`Table history read to ${HEAD} in acme/a.`,
		"",
		"### acme/b",
		"",
		"Row changes not read: `git: fatal`.",
		"",
		"## Checkouts read",
		"",
		"The next review checks each of these for absence from discovery:",
		"",
		"Events read in my wfc.",
		"Events read in second.",
		"",
		"## How to reverse",
		"",
	].join("\n");

	it("closes the body with one comment holding each line, and prints none of them", () => {
		const body = render(ReadOneHistory);
		const comment = body.indexOf("<!--");
		expect(body.slice(comment)).toBe(
			[
				"<!--",
				`Table history read to ${HEAD} in acme/a.`,
				"Events read in my wfc.",
				"Events read in second.",
				"-->",
				"",
			].join("\n"),
		);
		const visible = body.slice(0, comment);
		expect(visible).toContain("## How to reverse");
		expect(visible).not.toContain("Checkouts read");
		expect(visible).not.toContain("Table history read");
		expect(visible).not.toContain("Events read in");
	});

	it("carries no comment and no None line where nothing read", () => {
		const body = render([]);
		expect(body).not.toContain("<!--");
		expect(body).toMatch(/recipe\.\n\nStandalone: [^\n]+\n$/);
	});

	it.each([
		["this render", () => render(ReadOneHistory)],
		["a review filed with the lines visible", () => VisibleFormat],
	])(
		"reads the history cursor and carried checkouts back off %s",
		(_, make) => {
			const body = make();
			const reviews = [{ body }];
			expect(parseHistoryCursor(reviews, "acme/a")).toBe(HEAD);
			expect(parseHistoryCursor(reviews, "acme/b")).toBeNull();
			expect(
				buildAbsentRepos({
					previous: { number: 7, body },
					listed: new Set(),
					since: SINCE,
					nowMs: Date.parse(NOW),
					readAbsence: () => ({ carried: true, why: "no .git" }),
				}).flatMap((r: { unreadEvents: object[] }) => r.unreadEvents),
			).toEqual([
				{ kind: "Events", checkout: "my wfc", since: SINCE },
				{ kind: "Events", checkout: "second", since: SINCE },
			]);
		},
	);
});

describe("renderReview (#2011)", () => {
	it("takes a repo's events from its own start, and says so on its closes (#3831)", () => {
		const start = "2026-10-16T07:00:00Z";
		const body = render(
			[
				{
					repo: "acme/a",
					closesSince: start,
					decisionsSince: start,
					stalls: [],
					entries: [
						entry("2026-10-16T07:00:00Z", 1, true, "At the start"),
						entry("2026-10-16T08:00:00Z", 2, true, "Unread window"),
						entry("2026-10-16T09:00:00Z", 3, false),
					],
					closed: [
						closed(4, "2026-10-16T08:00:00Z", "one-way — gone"),
						closed(6, "2026-10-16T06:45:00Z", "one-way — at the edge"),
					],
				},
				{
					repo: "acme/b",
					stalls: [],
					entries: [entry("2026-10-16T08:00:00Z", 5, true, "Read before")],
					closed: [],
				},
			],
			[],
		);
		expect(body).toContain("Unread window");
		expect(body).not.toContain("At the start");
		expect(body).not.toContain("Read before");
		expect(body).toContain("acme/a#4");
		expect(body).not.toContain("acme/a#6");
		expect(body).toContain(
			"1 made since 2026-10-16T07:00:00Z, as a review since did not read a repo — [search]",
		);
		expect(body).toContain(
			"- acme/a: 1 from 2026-10-16T06:45:00.000Z, as the reviews since did not read it — [search]",
		);
		expect(body).toMatch(/- acme\/b: 0 — \[search\]/);
		expect(body).toContain(
			encodeURIComponent("updated:>=2026-10-16T07:00:00+00:00"),
		);
	});

	it("prints where an unread checkout's events start, for the next review to read back (#3831)", () => {
		const quiet = render([]);
		expect(quiet).not.toContain("Events unread since");
		const body = renderWith({
			failed: [{ repo: "acme/wfc", why: "HTTP 502" }],
			unreadEvents: [{ kind: "Events", checkout: "wfc", since: SINCE }],
		});
		expect(buildRepoStart({ number: 7, body }, "wfc", NOW)).toEqual({
			closes: SINCE,
			decisions: SINCE,
			why: null,
		});
		expect(body).toContain("- acme/wfc: `HTTP 502`");
	});

	it("says decisions that did not read are unread, never none in the window (#3928)", () => {
		const unread =
			"- acme/a: not read, so the next review to read it lists them";
		const body = render([
			{ repo: "acme/a", stalls: [], entries: null, closed: [] },
		]);
		expect(body).toContain(
			"## Still-caught delegated decisions\n\nNone in the repos read.",
		);
		expect(body).toContain(
			"## Clear delegated decisions\n\nNone in the repos read.",
		);
		expect(body.split(unread)).toHaveLength(3);
	});

	it("says closes that did not read are unread, never 0, and counts the rest (#3928)", () => {
		const body = render([
			{ repo: "acme/a", stalls: [], entries: [], closed: null },
			{
				repo: "acme/b",
				stalls: [],
				entries: [],
				closed: [closed(4, "2026-10-17T08:00:00Z", "one-way — gone")],
			},
		]);
		expect(body).toContain(
			"- acme/a: not read, so the next review to read them lists them",
		);
		expect(body).not.toMatch(/- acme\/a: 0/);
		expect(body).toContain("1 closed across the repos read");
		expect(body).toContain("acme/b#4");
	});

	it("links an unread repo's closes from its closes start, and the carry still reads the body (#3981)", () => {
		const start = "2026-10-15T07:00:00Z";
		const buildSearchLink = (repo: string, from: string) =>
			`[search](https://github.com/search?type=issues&q=${encodeURIComponent(
				`repo:${repo} is:issue is:closed closed:>=${from}`,
			)})`;
		const body = renderWith({
			repos: [
				{
					...QUIET_READING,
					checkout: "a",
					repo: "acme/a",
					closesSince: start,
					stalls: [],
					entries: [],
					closed: null,
				},
				{
					...QUIET_READING,
					checkout: "b",
					repo: "acme/b",
					stalls: [],
					entries: [],
					closed: [],
				},
			],
			unreadEvents: [{ kind: "Closes", checkout: "a", since: start }],
		});
		expect(body).toContain(
			`- acme/a: not read, so the next review to read them lists them — ${buildSearchLink("acme/a", "2026-10-15T06:45:00+00:00")}\n`,
		);
		expect(body).toContain(
			`- acme/b: 0 — ${buildSearchLink("acme/b", "2026-10-17T06:45:00+00:00")}\n`,
		);
		expect(buildRepoStart({ number: 7, body }, "a", NOW).closes).toBe(start);
	});

	it("speaks for the repos read where the only closes did not read (#3928)", () => {
		const body = render([
			{ repo: "acme/a", stalls: [], entries: [], closed: null },
		]);
		expect(body).toContain("0 closed across the repos read");
		expect(body).toContain("One-way closes:\n\nNone in the repos read.");
	});

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
			jobId: null as string | null,
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
				{
					...killed("2026-10-17T19:57:00.000Z", 2, "claude", "headless run"),
					jobId: "0aaaaaaa",
				},
			],
			unjoined: null,
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
			`## Memory kills\n\n2 in the window — headless run 1 (job 0aaaaaaa), other 1.\n\n- \`${incidentTitle(incident)}\` — 2 kills: headless run 1 (job 0aaaaaaa), other 1 — #52\n`,
		);
		expect(basisFaults(body)).toEqual([]);
	});

	it("lists the window's process runaways with what each killed and its ticket (#3807)", () => {
		const { buildEpisodeTitle } = require("./process-runaways.js");
		const episode = (since: string, ts: string, killed: number[]) => ({
			since,
			argv: "x",
			firings: [
				{ ts, since, procs: 750, argv: "x", size: 200, parents: [], killed },
			],
		});
		const inside = episode(
			"2026-10-18T06:50:00+0000",
			"2026-10-18T07:00:00+0000",
			[1, 2],
		);
		const outside = episode(
			"2026-10-16T06:50:00+0000",
			"2026-10-16T07:00:00+0000",
			[3],
		);
		const lines = (runaways: object) =>
			renderWith({ runaways }).split("## Process runaways\n\n")[1];
		expect(lines(QUIET_RUNAWAYS)).toMatch(/^None in the window\.\n/);
		const tickets = new Map([[buildEpisodeTitle(inside), 77]]);
		const listed = lines({
			episodes: [outside, inside],
			tickets,
			why: null,
		});
		expect(listed).toContain(
			`- \`${buildEpisodeTitle(inside)}\` — \`x\` — killed 2 — #77\n`,
		);
		expect(listed).not.toContain(buildEpisodeTitle(outside));
		expect(
			lines({ episodes: [inside], tickets: "HTTP 502", why: null }),
		).toContain("killed 2 — ticket unread: `HTTP 502`\n");
		expect(
			lines({ episodes: [inside], tickets: new Map(), why: null }),
		).toContain("killed 2 — no ticket filed yet\n");
		expect(lines({ ...QUIET_RUNAWAYS, why: "EACCES" })).toMatch(
			/^Not read: `EACCES`\.\n/,
		);
	});

	it("counts only kills inside the window, and says why the journal or the tracker did not read (#3094)", () => {
		const { incidentTitle } = require("./earlyoom-kills.js");
		const at = (iso: string, pid: number) => ({
			at: iso,
			pid,
			uid: 1000,
			name: "2.1.310",
			kind: "Claude host",
			jobId: null,
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
			unjoined: "journalctl --list-boots: denied",
		};
		/* One after the window's end, read minutes into a filing: the next
		 * review's (#3813). */
		const later = {
			first: "2026-10-18T07:05:00Z",
			last: "2026-10-18T07:05:00Z",
			kills: [at("2026-10-18T07:05:00Z", 3)],
			unjoined: null,
		};
		const repos = [{ repo: "acme/a", entries: [], stalls: [], closed: [] }];
		const body = render(repos, [], 7, {
			incidents: [edge, later],
			tickets: "HTTP 502",
			why: null,
		});
		expect(body).toContain(
			`## Memory kills\n\n1 in the window — Claude host 1.\n\n- \`${incidentTitle(edge)}\` — 2 kills: Claude host 2 — headless runs not joined: \`journalctl --list-boots: denied\` — ticket unread: \`HTTP 502\`\n`,
		);
		expect(body).not.toContain(incidentTitle(later));
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

	it("says no session worked and no tick was recorded where both records are empty (#3321)", () => {
		expect(
			render([{ repo: "acme/a", entries: [], stalls: [], closed: [] }]),
		).toContain(
			[
				"## Concurrency",
				"",
				"Sustained concurrency, the founder's own sessions counted:",
				"",
				"- no session recorded working over the last 7 days",
				"",
				"Admission ceiling: no refill-loop tick recorded.",
				"",
				"No session worked over the last 24 h, so no hours to charge or spread.",
				"",
				"## Parked",
			].join("\n"),
		);
	});

	it("buckets ten or more working sessions as one spread line, and reads an unread ceiling as such (#3321)", () => {
		const now = Date.parse(NOW);
		const minutes = [
			{ ts: new Date(now - 20 * MIN).toISOString(), sessions: 12 },
			{ ts: new Date(now - 10 * MIN).toISOString(), sessions: 10 },
		];
		const ticks = [
			{
				at: new Date(now - 20 * MIN).toISOString(),
				working: null,
				ceiling: null,
				binding: { limit: "CPU", why: "load" },
				also: [],
				memory: null,
			},
		];
		const body = renderWith({ concurrency: concurrencyOver(ticks, minutes) });
		expect(body).toContain(
			"Admission ceiling: unread at the last refill-loop tick",
		);
		expect(body).toContain("- CPU: 0.3 h\n");
		expect(body).toContain(
			"Share of those hours by how many sessions were working:\n\n- 10 or more working: 100%\n",
		);
	});

	it("reads the sustained figure and hours unread where the minute record did not read (mantahostels#1206)", () => {
		const body = renderWith({ concurrency: concurrencyOver([], null) });
		expect(body).toContain(
			"- unread over the last 7 days — memwatch's minute record did not read\n",
		);
		expect(body).toContain(
			"Hours by binding limit and their spread: unread, as memwatch's minute record did not read.",
		);
		expect(body).not.toContain("No session worked");
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

	it("starts a window where the previous rendered body's ended, whichever way that body was windowed (#3813)", () => {
		const startAfter = (body: string) =>
			windowStart({ number: 7, createdAt: "created", body }, new Date(NOW));
		expect(startAfter(render([]))).toEqual({ since: NOW, why: null });
		expect(startAfter(render([], [], null))).toEqual({ since: NOW, why: null });
	});

	it("starts at the previous issue's creation, saying so, where its Window line will not read (#3813)", () => {
		for (const body of ["Edited by hand.\n", "Window: then → soon, from #7.\n"])
			expect(
				windowStart({ number: 7, createdAt: SINCE, body }, new Date(NOW)),
			).toEqual({
				since: SINCE,
				why: "#7's Window line, so an event during its filing",
			});
	});

	it("starts 24 hours back with no previous issue", () => {
		expect(windowStart(undefined, new Date(NOW))).toEqual({
			since: new Date(Date.parse(NOW) - DAY).toISOString(),
			why: null,
		});
	});

	it("names the newest review's commit for each repo, past a review that could not read it (#3827)", () => {
		const line = (sha: string, repo: string) =>
			`Table history read to ${sha.repeat(40)} in ${repo}.`;
		const reviews = [
			{ body: "Row changes not read: `git: fatal`.\n" },
			{ body: `${line("b", "acme/b")}\n${line("c", "acme/a")}\n` },
			{ body: `${line("d", "acme/a")}\n` },
		];
		expect(parseHistoryCursor(reviews, "acme/a")).toBe("c".repeat(40));
		expect(parseHistoryCursor(reviews, "acme/b")).toBe("b".repeat(40));
		expect(parseHistoryCursor(reviews, "acme/z")).toBeNull();
	});

	it("reads back the commit a rendered body read to, and says where it fell back on commit time (#3827)", () => {
		const body = render([
			{
				repo: "acme/a",
				entries: [],
				stalls: [],
				closed: [],
				primitives: {
					...QUIET_PRIMITIVES,
					history: {
						commits: [],
						tip: HEAD,
						whyByTime: "no earlier review read this history",
					},
				},
			},
		]);
		expect(parseHistoryCursor([{ body }], "acme/a")).toBe(HEAD);
		expect(body).toContain(
			"Found by commit time, as no earlier review read this history: a commit that reached the branch after its window may be missing.",
		);
	});

	it("holds entries to (since, now] and closes to the same span 15 minutes behind it: at the start edge is the earlier issue's, at the end edge this one's", () => {
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
					closed(40, closeEdge(SINCE), "one-way — at since"),
					closed(41, closeEdge(NOW), "one-way — at now"),
					closed(42, NOW, "one-way — not yet settled"),
				],
			},
		]);
		expect(body).not.toContain("At since");
		expect(body).toContain("1. acme/a#2 — `At now`");
		expect(body).not.toContain("After now");
		expect(body).toContain(
			`1 closed across included repos, ${closeEdge(SINCE)} → ${closeEdge(NOW)}, 15 minutes behind the window`,
		);
		expect(body).toContain("acme/a#41 — `Ticket 41` — `at now`");
		expect(body).not.toContain("acme/a#40");
		expect(body).not.toContain("acme/a#42");
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
		expect(body).toContain("42 closed across included repos");
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
		expect(body).toContain("1 closed across included repos");
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
					kind: "decision",
					repo: "acme/a",
					issue: 11,
					comment: "https://github.com/acme/a/issues/11#issuecomment-11",
				},
			],
			[
				2,
				{
					kind: "decision",
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
		body.slice(body.indexOf("## Parked"), body.indexOf("## Idle efforts"));

	it("lists every parked issue with its age in whole days, under one as under a day, and one whose start will not read as age unknown", () => {
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
			"- acme/a#40 — `Parked overnight` — under a day\n",
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

describe("primitives (#3465)", () => {
	const Header =
		"| Job | Primitive | Exemplar | Rule | Enforcing check |\n|---|---|---|---|---|";
	const table = (...rows: string[]) =>
		`# Standards\n\n## Primitives\n\n${Header}\n${rows.join("\n")}\n\n## §G\n`;
	const hostRow = "| Finding the host | `hostRoot()` | `a.js` | §0 | `c.js` |";
	const cliRow = "| Reading argv | `cli-args.js` | `b.js` | §0 | `d.js` |";
	const commit = (
		sha: string,
		[before, after]: [string | null, string | null],
		side = "local",
	) => ({ sha, side, before, after });
	const repo = (
		name: string,
		primitives: { count: unknown; history: object },
		entries: unknown[] = [],
	) => ({
		repo: name,
		entries,
		stalls: [],
		closed: [],
		primitives: {
			...primitives,
			history:
				"why" in primitives.history
					? primitives.history
					: { tip: HEAD, whyByTime: null, ...primitives.history },
		},
	});
	const section = (body: string) =>
		body.slice(
			body.indexOf("## Primitives"),
			body.indexOf("## Closed tickets"),
		);

	it("lists each row a commit in the window added, removed or rewrote, by job, with its short sha", () => {
		const body = render([
			repo("acme/a", {
				count: { line: COUNT_LINE },
				history: {
					commits: [
						commit("aaa1111", [null, table(hostRow)], "base"),
						commit("bbb2222", [
							table(hostRow, cliRow),
							table(hostRow.replace("`a.js`", "`z.js`").replace("§0", "§N7")),
						]),
					],
				},
			}),
		]);
		expect(section(body)).toBe(
			[
				"## Primitives",
				"",
				"Each repo's count line, then each primitives-table row added, removed or rewritten since the last review's read, with its commit:",
				"",
				"### acme/a",
				"",
				`\`${COUNT_LINE}\``,
				"",
				"1. acme/a — base row added: `'hostRoot()'` — job `Finding the host` — aaa1111",
				"2. acme/a — local row rewritten (Exemplar, Rule): `'hostRoot()'` — job `Finding the host` — bbb2222",
				"3. acme/a — local row removed: `'cli-args.js'` — job `Reading argv` — bbb2222",
				"",
				"",
			].join("\n"),
		);
	});

	it("says no row changed where no commit in the window touched a table row", () => {
		const body = render([
			repo("acme/a", {
				count: { line: COUNT_LINE },
				history: {
					commits: [
						commit("ddd4444", [table(hostRow), `${table(hostRow)}\nprose\n`]),
					],
				},
			}),
		]);
		expect(section(body)).toContain(
			`### acme/a\n\n\`${COUNT_LINE}\`\n\nNo row changed since the last read.\n`,
		);
		expect(parseEntries(body).size).toBe(0);
	});

	it("names a repo whose count line or history did not read, and a commit whose table did not", () => {
		const body = render([
			repo("acme/a", {
				count: { why: "check-primitives.js: BROKEN: base unreadable" },
				history: { why: "git log: fatal: not a git repository" },
			}),
			repo("acme/b", {
				count: { line: COUNT_LINE },
				history: {
					commits: [
						commit("eee5555", [table(hostRow), "## Primitives\n\nno table\n"]),
					],
				},
			}),
		]);
		const s = section(body);
		expect(s).toContain(
			"### acme/a\n\nCount line not read: `check-primitives.js: BROKEN: base unreadable`.\n\nRow changes not read: `git log: fatal: not a git repository`.\n",
		);
		expect(s).toContain(
			"- eee5555: the local table did not read — `after: its Primitives section holds no table`",
		);
	});

	it("numbers its entries on from the still-caught decisions, across repos, and parseEntries reads both kinds back", () => {
		const changed = {
			count: { line: COUNT_LINE },
			history: {
				commits: [commit("fff6666", [null, table(cliRow)])],
			},
		};
		const body = render([
			repo("acme/a", changed, [entry("2026-10-17T09:00:00Z", 11, true)]),
			repo("acme/b", changed, [entry("2026-10-17T10:00:00Z", 21, true)]),
		]);
		expect(body).toContain("1. acme/a#11 — `Q`");
		expect(body).toContain("2. acme/b#21 — `Q`");
		expect(body).toContain(
			"3. acme/a — local row added: `'cli-args.js'` — job `Reading argv` — fff6666",
		);
		expect(body).toContain(
			"4. acme/b — local row added: `'cli-args.js'` — job `Reading argv` — fff6666",
		);
		const entries = parseEntries(body);
		expect(entries.get(2)).toMatchObject({ kind: "decision", repo: "acme/b" });
		expect(entries.get(4)).toEqual({
			kind: "primitive",
			repo: "acme/b",
			side: "local",
			change: "added",
			cells: [],
			primitive: "'cli-args.js'",
			job: "Reading argv",
			sha: "fff6666",
		});
		expect(basisFaults(body)).toEqual([]);
	});
});

describe("the WSL currency section (#4082)", () => {
	it("prints each of the checker's lines, between idle efforts and the decisions", () => {
		const body = renderWith({
			wslCurrency: { lines: ["WSL 2.7.11.0 is behind", "wsl --update"] },
		});
		expect(body).toContain(
			"## WSL currency\n\n- `WSL 2.7.11.0 is behind`\n- `wsl --update`\n\n## Still-caught",
		);
		expect(body.indexOf("## Idle efforts")).toBeLessThan(
			body.indexOf("## WSL currency"),
		);
	});

	it("names an envelope that did not arrive", () => {
		expect(
			renderWith({ wslCurrency: { why: "check-wsl-currency.js: boom" } }),
		).toContain("## WSL currency\n\nNot read: `check-wsl-currency.js: boom`\n");
	});

	it("prints nothing where this is not WSL", () => {
		expect(renderWith({ wslCurrency: null })).not.toContain("WSL currency");
	});
});

describe("the idle efforts section (#3644)", () => {
	const idleRender = (idle: unknown) => renderWith({ idle });
	const section = (body: string) =>
		body.slice(
			body.indexOf("## Idle efforts"),
			body.indexOf("## Still-caught"),
		);

	it("renders a damaged file's line above the trackers (#3918)", () => {
		const body = idleRender({
			loopRunning: true,
			trackers: [{ repo: "acme/a", served: true, error: null, idle: [] }],
			damaged: ["/r/state is damaged (x)"],
		});
		expect(section(body)).toContain(
			[
				"- `Refill loop file damaged: /r/state is damaged (x)`",
				"- `acme/a: none idle past 2 days`",
			].join("\n"),
		);
	});

	it("renders the alarm's lines, each as a code span, an unserved tracker's urgent issues nested", () => {
		const body = idleRender({
			loopRunning: false,
			damaged: [],
			trackers: [
				{ repo: "acme/a", served: true, error: null, idle: [] },
				{
					repo: "acme/b",
					served: false,
					error: null,
					idle: [
						{
							number: 8,
							title: "Ship it",
							idleMs: 3 * 24 * 60 * MIN,
							urgent: true,
							skip: null,
						},
					],
				},
			],
		});
		expect(section(body)).toContain(
			[
				"- `The refill loop is not running, so it serves no tracker. node scripts/refill-loop.js start restarts it.`",
				"- `acme/a: none idle past 2 days`",
				"- `acme/b: 1 idle past 2 days (the refill loop does not serve it); oldest #8 (Ship it), idle 3.0 days; skip reason: none, the launch filter passes it`",
				"  - `urgent #8 (Ship it), idle 3.0 days`",
				"",
			].join("\n"),
		);
	});

	it("says why where the alarm did not read", () => {
		expect(
			section(idleRender({ why: "check-idle-efforts.js: boom" })),
		).toContain("Not read: `check-idle-efforts.js: boom`\n");
	});
});

describe("an open repo hold (#3865)", () => {
	it("adds no section with none open", () => {
		expect(renderWith({ holds: [] })).not.toContain("## Open repo holds");
	});

	it("says so where its issue has yet to be filed", () => {
		const body = renderWith({
			holds: [
				{
					checkout: "wfc",
					repo: "acme/wfc",
					act: "repair `main`",
					issue: null,
					kind: "probe",
					age: "5m",
					attached: 0,
					notice: "raise sent, clear not sent",
				},
			],
		});

		expect(body).toContain(
			"- wfc: `repair 'main'` — no issue filed yet — probe, which stops launches — age 5m — 0 attached — notice: raise sent, clear not sent",
		);
		expect(basisFaults(body)).toEqual([]);
	});
});
