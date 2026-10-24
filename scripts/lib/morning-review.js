/*
 * morning-review.js — the morning review issue's title and body (workflow-core#2011, spec
 * workflow-core#1995 §The morning review issue). Pure: the generator,
 * scripts/file-morning-review.js, does every read and the filing.
 *
 * The window runs from the previous review issue's creation to now, not a
 * calendar day. Both edges are applied here, after the reads, so the reads may
 * over-fetch: an entry or close at the previous issue's own instant belongs
 * to that issue, one at `now` to this.
 *
 * Entry numbers run 1…n across every repo, so `reverse <n>` names one entry;
 * each line links the decision's own comment, which keys its ledger line.
 */

const { requiredGroup } = require("./regex-group.js");

const TITLE = /^Morning review — (\d{4}-\d{2}-\d{2})$/;

/** @param {Date} d @returns {string} its machine-local `YYYY-MM-DD` */
const localDate = (d) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");

/** @param {string} date machine-local `YYYY-MM-DD` */
const reviewTitle = (date) => `Morning review — ${date}`;

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
function oneWayDoor(comments) {
	const door = /^[ \t]*\*\*Door:\*\*[ \t]*(.*)$/m;
	for (const { body } of [...comments].reverse()) {
		const m = door.exec(body ?? "");
		if (!m) continue;
		const text = (m[1] ?? "").trim();
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
 * @typedef {{repo: string, entries: LedgerLine[], closed: ClosedIssue[]}} RepoReading
 * @typedef {{since: string, now: string, previous: number | null,
 *   repos: RepoReading[], failed: Unread[]}} Reading
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
 * is what check-issue-citations.js reads a citation by (workflow-core#2265).
 * @param {number} n @param {string} url @param {string} [noun]
 */
const commentLink = (n, url, noun = "comment") => `[#${n} ${noun}](${url})`;

/**
 * @param {Reading} r
 * @returns {string}
 */
function renderReview({ since, now, previous, repos, failed }) {
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
	/* Comments recorded before workflow-core#2594 print `Still close:` and are never
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
	const oneWay = readings.flatMap(({ repo, closed }) =>
		closed.flatMap((c) => {
			const door = oneWayDoor(c.comments);
			return door === null
				? []
				: [
						`- ${repo}#${c.number} — ${quoted(c.title)} — ${quoted(door || "one-way")}`,
					];
		}),
	);

	return [
		"## Question",
		"",
		"Do you want any delegated decision below reversed? Read the still-caught entries and the one-way closes, comment `reverse <entry number>` against any you disagree with, then close this issue.",
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
		"## Still-caught delegated decisions",
		"",
		...(caughtLines.length === 0 ? ["None in the window.", ""] : caughtLines),
		"## Clear delegated decisions",
		"",
		clearLine,
		"",
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

/**
 * The still-caught entries a review body lists, by entry number: the body the
 * founder read, so `reverse <n>` names what he saw even where a ledger has
 * changed since.
 * @param {string} body
 * @returns {Map<number, {repo: string, issue: number, comment: string}>}
 */
function parseEntries(body) {
	const entries = new Map();
	for (const line of body.split("\n")) {
		const m = ENTRY_LINE.exec(line);
		if (m)
			entries.set(Number(requiredGroup(m, 1, ENTRY_LINE)), {
				repo: requiredGroup(m, 2, ENTRY_LINE),
				issue: Number(requiredGroup(m, 3, ENTRY_LINE)),
				comment: requiredGroup(m, 4, ENTRY_LINE),
			});
	}
	return entries;
}

module.exports = {
	commentLink,
	localDate,
	parseEntries,
	parseReviewDate,
	quoted,
	renderReview,
	reviewTitle,
	searchTime,
};
