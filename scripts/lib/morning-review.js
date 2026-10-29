/*
 * morning-review.js — the morning review issue's title and body (#2011, spec
 * #1995 §The morning review issue). Pure: the generator,
 * scripts/file-morning-review.js, does every read and the filing.
 *
 * The window runs from the previous review issue's creation to now, not a
 * calendar day. Both edges are applied here, after the reads, so the reads may
 * over-fetch: an entry or close at the previous issue's own instant belongs
 * to that issue, one at `now` to this.
 *
 * Entry numbers run 1…n across every repo, so `reverse <n>` names one entry;
 * each line links the decision's own comment, which keys its ledger line.
 * The primitives-table row changes (#3465) carry on the numbering after the
 * still-caught decisions.
 */

const { requiredGroup } = require("./regex-group.js");
const { byKind, incidentTitle, isOver } = require("./earlyoom-kills.js");
const {
	NONE,
	SPREAD_CAP,
	SUSTAINED_WINDOW,
	buildSustainedText,
} = require("./concurrency.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { rowChanges } = require("./primitives-table.js");

const TITLE = /^Morning review — (\d{4}-\d{2}-\d{2})$/;
/* An `urgent` older than this is listed as stuck: #2693's figure, a guess,
 * unmeasured. */
const STUCK_URGENT_DAYS = 7;
/* The concurrency section's two readout windows; untraced (#3315). */
const CONCURRENCY_WINDOWS = {
	day: SUSTAINED_WINDOW,
	week: { ms: 7 * DAY_MS, span: "7 days" },
};
/* Untraced: spec #1995's "first tick after 07:00", machine-local. */
const REVIEW_HOUR = 7;

/** @param {Date} d @returns {string} its machine-local `YYYY-MM-DD` */
const localDate = (d) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");

/** @param {string} date machine-local `YYYY-MM-DD` */
const buildReviewTitle = (date) => `Morning review — ${date}`;

/**
 * The date a review issue's title carries, or null for any other title.
 * @param {string} title
 */
const parseReviewDate = (title) => TITLE.exec(title)?.[1] ?? null;

/**
 * The `**Door:**` line of an issue's resolution — the last comment carrying
 * one — when it reads one-way: its text after `one-way`, or null.
 * @param {{body: string}[]} comments oldest first
 */
function parseOneWayDoor(comments) {
	const door = /^[ \t]*\*\*Door:\*\*[ \t]*(.*)$/m;
	for (const { body } of [...comments].reverse()) {
		const m = door.exec(body ?? "");
		if (!m) continue;
		const text = requiredGroup(m, 1, door).trim();
		return /^one-way\b/.test(text)
			? text.replace(/^one-way\b[\s—–-]*/, "")
			: null;
	}
	return null;
}

/**
 * @typedef {import("./delegated-decision.js").LedgerLine} LedgerLine
 * @typedef {{number: number, title: string, url: string, closedAt: string,
 *   comments: {body: string}[]}} ClosedIssue
 * @typedef {{number: number, title: string}} OpenIssue
 * @typedef {{number: number, title: string, appliedAt: string,
 *   why: string | null}} UrgentIssue an open issue carrying `urgent`, when the
 *   label was last applied, and why pick-next left it unlaunched, where it says
 * @typedef {{number: number, title: string} & ({appliedAt: string}
 *   | {appliedAt: null, ageError: string})} ParkedIssue an open issue carrying
 *   `parked`, and when the label was last applied, or why that did not read
 * @typedef {import("./primitives-table.js").Side} Side
 * @typedef {{sha: string, at: string, side: Side, before: string | null,
 *   after: string | null}} TableCommit a commit touching a side's standards
 *   file, with the file's text either side of it,
 *   null where absent
 * @typedef {{count: {line: string} | {why: string},
 *   history: {commits: TableCommit[]} | {why: string}}} PrimitivesReading
 *   check-primitives.js's count line, and the commits touching each
 *   standards file the repo's history holds; or why either did not read
 * @typedef {{repo: string, entries: LedgerLine[], closed: ClosedIssue[],
 *   stalls: OpenIssue[], urgent: UrgentIssue[], parked: ParkedIssue[],
 *   primitives: PrimitivesReading}}
 *   RepoReading the repo's ledger, its closes, its open stall ticket
 *   (lib/stall-ticket.js, #2692), its urgent issues and its parked ones
 * @typedef {{since: string, now: string, previous: number | null,
 *   repos: RepoReading[], failed: Unread[], kills: KillReading,
 *   concurrency: ConcurrencyReading}} Reading the machine's earlyoom kills
 *   and its concurrency are read once, not per repo (#3094, #3321)
 * @typedef {ReturnType<typeof import("./concurrency.js").readout>} Readout
 * @typedef {Record<keyof typeof CONCURRENCY_WINDOWS, Readout>}
 *   ConcurrencyReading the readout core's readout over each window, all
 *   ending at the review's `now`
 * @typedef {{incidents: import("./earlyoom-kills.js").Incident[],
 *   tickets: Map<string, number> | string, why: string | null}} KillReading
 *   the incidents with a kill in the window, their tickets by title or why
 *   the tracker did not read, and why the journal did not read, where it did
 *   not
 * @typedef {{repo: string, why: string}} Unread a repo the review could not
 *   read whole
 */

/**
 * Text copied in from a ledger, a title or a comment, as a code span: the
 * basis check file-issue.js runs skips code spans, so a copied "7 days after"
 * cannot get the whole review refused. An inner backtick becomes `'`, since
 * the check finds a span by counting backticks on the line.
 * @param {string} text
 */
const quoted = (text) => `\`${text.replaceAll("`", "'")}\``;

/** GitHub's search reads `+00:00`, not `Z`, as a time zone. @param {string} iso */
const searchTime = (iso) =>
	new Date(iso).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/**
 * `encodeURIComponent` leaves parentheses bare, and a bare `)` would end the
 * Markdown link the URL sits in.
 * @param {string} q
 */
const issueSearch = (q) =>
	`https://github.com/search?type=issues&q=${encodeURIComponent(q).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))}`;

/**
 * A link to a comment on issue `n`, its text leading with the number, which
 * is what check-issue-citations.js reads a citation by (#2265).
 * @param {number} n @param {string} url @param {string} [noun]
 */
const commentLink = (n, url, noun = "comment") => `[#${n} ${noun}](${url})`;

/** @param {number} ms @returns {string} whole days, as pick-next's PARKED prints them */
const wholeDays = (ms) => {
	const days = Math.floor(ms / DAY_MS);
	return `${days} ${days === 1 ? "day" : "days"}`;
};

/**
 * An incident's ticket as the review names it.
 * @param {import("./earlyoom-kills.js").Incident} i
 * @param {KillReading["tickets"]} tickets
 * @param {number} now
 */
function ticketText(i, tickets, now) {
	if (typeof tickets === "string") return `ticket unread: ${quoted(tickets)}`;
	const n = tickets.get(incidentTitle(i));
	if (n !== undefined) return `#${n}`;
	return isOver(i, now)
		? "no ticket filed yet"
		: "no ticket yet: the incident is not over";
}

/**
 * The "Memory kills" lines: the window's kills by kind, each at its first
 * signal, then each incident with its ticket.
 * @param {KillReading} r
 * @param {number} lo the window's start, ms, exclusive
 * @param {number} hi its end, ms, inclusive
 * @returns {string[]}
 */
function renderKillLines({ incidents, tickets, why }, lo, hi) {
	if (why !== null) return [`Not read: ${quoted(why)}.`];
	const inWindow = incidents.flatMap((i) =>
		i.kills.filter((k) => Date.parse(k.at) > lo && Date.parse(k.at) <= hi),
	);
	if (inWindow.length === 0) return ["None in the window."];
	return [
		`${inWindow.length} in the window — ${byKind(inWindow)}.`,
		"",
		...incidents.map(
			(i) =>
				`- ${quoted(incidentTitle(i))} — ${i.kills.length} ${i.kills.length === 1 ? "kill" : "kills"}: ${byKind(i.kills)} — ${ticketText(i, tickets, hi)}`,
		),
	];
}

/** @param {number} h */
const hours = (h) => `${h.toFixed(1)} h`;

/**
 * The "Concurrency" lines, every figure as lib/concurrency.js's readout gives
 * it: the sustained figures, the last tick's ceiling, the day's working hours
 * by the limit binding then, and how many sessions worked across them.
 * @param {ConcurrencyReading} c
 * @returns {string[]}
 */
function renderConcurrencyLines({ day, week }) {
	const t = day.lastTick;
	const charged = Object.entries(day.hours)
		.sort(([, a], [, b]) => b - a)
		.map(
			([limit, h]) =>
				`- ${limit === NONE ? "nothing (a slot was free)" : limit}: ${hours(h)}`,
		);
	const spread = Object.entries(day.spread)
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(
			([n, share]) =>
				`- ${Number(n) === SPREAD_CAP ? `${n} or more` : n} working: ${Math.round(share * 100)}%`,
		);
	return [
		"Sustained concurrency, the founder's own sessions counted:",
		"",
		`- ${buildSustainedText(day, CONCURRENCY_WINDOWS.day.span)}`,
		`- ${buildSustainedText(week, CONCURRENCY_WINDOWS.week.span)}`,
		"",
		t
			? `Admission ceiling: ${t.ceiling ?? "unread"} at the last refill-loop tick (${t.at}).`
			: "Admission ceiling: no refill-loop tick recorded.",
		"",
		...(charged.length === 0
			? [
					day.minutesRead
						? `No session worked over the last ${CONCURRENCY_WINDOWS.day.span}, so no hours to charge or spread.`
						: "Hours by binding limit and their spread: unread, as memwatch's minute record did not read.",
				]
			: [
					`Hours with any session working over the last ${CONCURRENCY_WINDOWS.day.span}, by the limit binding then:`,
					"",
					...charged,
					"",
					"Share of those hours by how many sessions were working:",
					"",
					...spread,
				]),
	];
}

/**
 * One primitives entry line, as PRIMITIVE_LINE reads it back.
 * @param {number} n
 * @param {string} repo
 * @param {TableCommit} commit
 * @param {import("./primitives-table.js").RowChange} c
 */
const primitiveLine = (n, repo, { side, sha }, c) =>
	`${n}. ${repo} — ${side} row ${c.change}${c.cells.length > 0 ? ` (${c.cells.join(", ")})` : ""}: ${quoted(c.primitive)} — job ${quoted(c.job)} — ${sha}`;

/**
 * @param {string} repo
 * @param {PrimitivesReading["history"]} history
 * @param {(at: string) => boolean} inWindow
 * @param {() => number} next the next entry number free
 * @returns {string[]}
 */
function renderRowChanges(repo, history, inWindow, next) {
	if ("why" in history)
		return [`Row changes not read: ${quoted(history.why)}.`];
	return history.commits
		.filter((commit) => inWindow(commit.at))
		.flatMap((commit) => {
			const read = rowChanges(commit.side, commit.before, commit.after);
			return "unreadable" in read
				? [
						`- ${commit.sha}: the ${commit.side} table did not read — ${quoted(read.unreadable)}`,
					]
				: read.changes.map((c) => primitiveLine(next(), repo, commit, c));
		});
}

/**
 * The "Primitives" lines.
 * @param {RepoReading[]} repos
 * @param {(at: string) => boolean} inWindow
 * @param {number} first the first entry number free
 * @returns {string[]}
 */
function renderPrimitivesLines(repos, inWindow, first) {
	let n = first;
	return repos.flatMap(({ repo, primitives: { count, history } }) => {
		const changed = renderRowChanges(repo, history, inWindow, () => n++);
		return [
			`### ${repo}`,
			"",
			"line" in count
				? quoted(count.line)
				: `Count line not read: ${quoted(count.why)}.`,
			"",
			...(changed.length === 0 ? ["No row changed in the window."] : changed),
			"",
		];
	});
}

/**
 * @param {Reading} r
 * @returns {string}
 */
function renderReview({
	since,
	now,
	previous,
	repos,
	failed,
	kills,
	concurrency,
}) {
	const lo = Date.parse(since);
	const hi = Date.parse(now);
	/** @param {string} at */
	const inWindow = (at) => Date.parse(at) > lo && Date.parse(at) <= hi;

	const readings = repos.map(({ repo, entries, closed }) => {
		const decided = entries.filter((e) => inWindow(e.at));
		return {
			repo,
			caught: decided.filter((e) => e.stillClose),
			clear: decided.filter((e) => !e.stillClose).length,
			closed: closed.filter((c) => inWindow(c.closedAt)),
		};
	});

	const numbered = readings.flatMap(({ repo, caught }) =>
		caught.map((e) => ({ repo, e })),
	);
	const caughtLines = numbered.flatMap(({ repo, e }, i) => [
		...(i === 0 || numbered[i - 1]?.repo !== repo ? [`### ${repo}`, ""] : []),
		`${i + 1}. ${repo}#${e.issue} — ${quoted(e.question)} — taken: ${quoted(e.taken.option)} (${e.taken.figure}%) — ${commentLink(e.issue, e.comment)}`,
		...(numbered[i + 1]?.repo === repo ? [] : [""]),
	]);

	const clearCount = readings.reduce((sum, r) => sum + r.clear, 0);
	const clearRepos = readings.filter((r) => r.clear > 0).map((r) => r.repo);
	/* Comments recorded before #2594 print `Still close:` and are never
	 * rewritten. `updated:` is the issue's last activity, not the comment's
	 * date, so any old issue can re-enter the window: both wordings for good. */
	const clearLine =
		clearCount === 0
			? "None in the window."
			: `${clearCount} made in the window — [search](${issueSearch(
					`${clearRepos.map((r) => `repo:${r}`).join(" ")} ("Still caught: no" OR "Still close: no") in:comments updated:>=${searchTime(since)}`,
				)}).`;

	const closedCount = readings.reduce((sum, r) => sum + r.closed.length, 0);
	const perRepo = readings.map(
		(r) =>
			`- ${r.repo}: ${r.closed.length} — [search](${issueSearch(
				`repo:${r.repo} is:issue is:closed closed:>=${searchTime(since)}`,
			)})`,
	);
	const stuck = repos.flatMap(({ repo, urgent }) =>
		urgent.flatMap((i) => {
			const age = hi - Date.parse(i.appliedAt);
			return age > STUCK_URGENT_DAYS * DAY_MS
				? [
						`- ${repo}#${i.number} — ${quoted(i.title)} — ${Math.floor(age / DAY_MS)} days — ${i.why === null ? "pick-next does not say why" : quoted(i.why)}`,
					]
				: [];
		}),
	);
	const oneWay = readings.flatMap(({ repo, closed }) =>
		closed.flatMap((c) => {
			const door = parseOneWayDoor(c.comments);
			return door === null
				? []
				: [
						`- ${repo}#${c.number} — ${quoted(c.title)} — ${quoted(door || "one-way")}`,
					];
		}),
	);

	const stalls = repos.flatMap(({ repo, stalls: open }) =>
		open.map((i) => `- ${repo}#${i.number} — ${quoted(i.title)}`),
	);
	const parked = repos.flatMap(({ repo, parked: open }) =>
		open.map(
			(i) =>
				`- ${repo}#${i.number} — ${quoted(i.title)} — ${i.appliedAt === null ? `age unknown: ${quoted(i.ageError)}` : wholeDays(hi - Date.parse(i.appliedAt))}`,
		),
	);

	return [
		"## Question",
		"",
		"Do you want any delegated decision or primitives-table change below reversed? Read the still-caught entries, the primitives-table changes and the one-way closes, comment `reverse <entry number>` against any you disagree with, then close this issue.",
		"",
		`Window: ${since} → ${now}${previous === null ? " (no previous review issue: the last 24 hours)" : `, from #${previous}, the previous review issue`}.`,
		...(failed.length === 0
			? []
			: [
					"",
					"**Not read, so missing below:**",
					...failed.map((f) => `- ${f.repo}: ${quoted(f.why)}`),
				]),
		"",
		"## Landing stalls",
		"",
		...(stalls.length === 0 ? ["None open."] : stalls),
		"",
		"## Memory kills",
		"",
		...renderKillLines(kills, lo, hi),
		"",
		"## Concurrency",
		"",
		...renderConcurrencyLines(concurrency),
		"",
		"## Parked",
		"",
		"Open issues labelled `parked`, with how long each has been parked:",
		"",
		...(parked.length === 0 ? ["None."] : parked),
		"",
		"## Still-caught delegated decisions",
		"",
		...(caughtLines.length === 0 ? ["None in the window.", ""] : caughtLines),
		"## Clear delegated decisions",
		"",
		clearLine,
		"",
		"## Primitives",
		"",
		"Each repo's count line, then each primitives-table row added, removed or rewritten in the window, with its commit:",
		"",
		...renderPrimitivesLines(repos, inWindow, numbered.length + 1),
		"## Closed tickets",
		"",
		`${closedCount} closed in the window across included repos:`,
		"",
		...perRepo,
		"",
		"One-way closes:",
		"",
		...(oneWay.length === 0 ? ["None in the window."] : oneWay),
		"",
		"## Stuck urgent",
		"",
		`Open issues labelled \`urgent\` more than ${STUCK_URGENT_DAYS} days ago, with why pick-next's last run in that checkout left each unlaunched:`,
		"",
		...(stuck.length === 0 ? ["None."] : stuck),
		"",
		"## How to reverse",
		"",
		"Comment `reverse <entry number>` on this issue, one per line. Each becomes a `takes:implement` ticket in that entry's repo carrying the entry's reversal recipe.",
		"",
	].join("\n");
}

/* An entry line as renderReview writes it: number, repo, issue, the comment.
 * A link numbered other than its entry's issue is no line renderReview wrote,
 * so it is no entry. */
const ENTRY_LINE = /^(\d+)\. (\S+)#(\d+) — .* — \[#\3 comment\]\((\S+)\)$/;
/* A primitives entry line, as primitiveLine writes it. */
const PRIMITIVE_LINE =
	/^(\d+)\. (\S+) — (base|local) row (added|removed|rewritten)(?: \(([^)]*)\))?: `([^`]*)` — job `([^`]*)` — ([0-9a-f]+)$/;

/**
 * @typedef {{kind: "decision", repo: string, issue: number, comment: string}
 *   | ({kind: "primitive", repo: string, side: Side, sha: string}
 *   & import("./primitives-table.js").RowChange)} Entry
 */

/**
 * One body line as an entry, or null for any other line.
 * @param {string} line
 * @returns {[number, Entry] | null}
 */
function parseEntryLine(line) {
	const m = ENTRY_LINE.exec(line);
	if (m)
		return [
			Number(requiredGroup(m, 1, ENTRY_LINE)),
			{
				kind: "decision",
				repo: requiredGroup(m, 2, ENTRY_LINE),
				issue: Number(requiredGroup(m, 3, ENTRY_LINE)),
				comment: requiredGroup(m, 4, ENTRY_LINE),
			},
		];
	const p = PRIMITIVE_LINE.exec(line);
	if (!p) return null;
	const cells = p[5];
	return [
		Number(requiredGroup(p, 1, PRIMITIVE_LINE)),
		{
			kind: "primitive",
			repo: requiredGroup(p, 2, PRIMITIVE_LINE),
			side: /** @type {Side} */ (requiredGroup(p, 3, PRIMITIVE_LINE)),
			change: /** @type {Extract<Entry, {kind: "primitive"}>["change"]} */ (
				requiredGroup(p, 4, PRIMITIVE_LINE)
			),
			cells: cells === undefined ? [] : cells.split(", "),
			primitive: requiredGroup(p, 6, PRIMITIVE_LINE),
			job: requiredGroup(p, 7, PRIMITIVE_LINE),
			sha: requiredGroup(p, 8, PRIMITIVE_LINE),
		},
	];
}

/**
 * The entries a review body lists, by entry number: the body the founder
 * read, so `reverse <n>` names what he saw even where a ledger or a table has
 * changed since.
 * @param {string} body
 * @returns {Map<number, Entry>}
 */
function parseEntries(body) {
	/** @type {Map<number, Entry>} */
	const entries = new Map();
	for (const line of body.split("\n")) {
		const e = parseEntryLine(line);
		if (e) entries.set(...e);
	}
	return entries;
}

module.exports = {
	CONCURRENCY_WINDOWS,
	REVIEW_HOUR,
	commentLink,
	localDate,
	parseEntries,
	parseReviewDate,
	quoted,
	renderReview,
	buildReviewTitle,
	searchTime,
};
