/*
 * review-reversal.js — a `reverse <n>` comment on the morning review issue,
 * turned into the ticket that undoes entry n and the reply acknowledging it
 * (#2017, spec #1995 §The morning review issue). Pure:
 * scripts/answer-review-reversals.js reads the issue and the ledgers and files.
 *
 * THE ACKNOWLEDGEMENT IS THE RECORD: each reply carries a hidden marker naming
 * the reverse comment and the entry, so a request already answered is never
 * filed again, by the next tick or by a hand run. A request that can never be
 * filed — an entry number the review does not list, a decision no ledger
 * holds, a line opening `reverse` that names no number — is answered too,
 * saying why.
 */

const { commentLink, quoted } = require("./morning-review.js");
const { requiredGroup } = require("./regex-group.js");

/* A line opening `reverse`, then its entry numbers, a list allowed, then
 * anything: "reverse 3", "Reverse entry #3, 5 — wrong call". */
const REQUEST = /^[ \t]*reverse\b(.*)$/gim;
const NUMBERS =
	/^[ \t]+(?:entry[ \t]+|entries[ \t]+)?(#?\d+(?:[ \t]*(?:,|and)[ \t]*#?\d+)*)/i;
const MARKER = /<!-- reversal-of (\S+) entry (\d+|\?) -->/g;
/* Untraced: room for the question in a title GitHub lists whole. */
const TITLE_QUESTION_MAX = 80;

/**
 * @typedef {{url: string, body: string}} Comment
 * @typedef {{commentUrl: string, n: number | null}} Request the reverse
 *   comment and the entry number it names; null where a `reverse` line names
 *   none
 * @typedef {{filed: string} | {why: string}} Outcome the ticket filed, as
 *   `owner/name#n`, or why none was
 */

/** @param {string} url @param {number | null} n */
const buildMarker = (url, n) => `<!-- reversal-of ${url} entry ${n ?? "?"} -->`;

/**
 * The entry numbers one comment asks to reverse, each once; null for a
 * `reverse` line whose numbers cannot be read.
 * @param {string} body
 * @returns {(number | null)[]}
 */
function parseReverseRequests(body) {
	const asked = [...(body ?? "").matchAll(REQUEST)].flatMap((m) => {
		const list = NUMBERS.exec(requiredGroup(m, 1, REQUEST));
		if (!list) return [null];
		return requiredGroup(list, 1, NUMBERS)
			.split(/,|and/i)
			.map((s) => Number(s.trim().replace(/^#/, "")));
	});
	return [...new Set(asked)];
}

/**
 * The requests on a review issue's comments no reply has answered yet,
 * oldest first.
 * @param {Comment[]} comments oldest first
 * @returns {Request[]}
 */
function pendingRequests(comments) {
	const answered = new Set(
		comments.flatMap((c) =>
			[...(c.body ?? "").matchAll(MARKER)].map(
				(m) => `${requiredGroup(m, 1, MARKER)} ${requiredGroup(m, 2, MARKER)}`,
			),
		),
	);
	return comments.flatMap((c) =>
		parseReverseRequests(c.body).flatMap((n) =>
			answered.has(`${c.url} ${n ?? "?"}`) ? [] : [{ commentUrl: c.url, n }],
		),
	);
}

/**
 * The `takes:implement` ticket for one reversal, filed in the entry's repo.
 * @param {{review: {repo: string, number: number}, request: Request,
 *   entry: import("./delegated-decision.js").LedgerLine}} r
 * @returns {{title: string, body: string}}
 */
function buildReversalTicket({ review, request, entry: e }) {
	const question =
		e.question.length > TITLE_QUESTION_MAX
			? `${e.question.slice(0, TITLE_QUESTION_MAX - 1)}…`
			: e.question;
	return {
		title: `Reverse a delegated decision on #${e.issue}: ${question}`,
		body: [
			"## What to build",
			"",
			`The founder reversed entry ${request.n} of the morning review ${review.repo}#${review.number} (${commentLink(review.number, request.commentUrl)}): the delegated decision recorded on ${e.repo}#${e.issue} (${commentLink(e.issue, e.comment)}). Undo the option taken and build the runner-up in its place.`,
			"",
			`- Question: ${quoted(e.question)}`,
			`- Taken: ${quoted(e.taken.option)} — ${e.taken.figure}%`,
			`- Runner-up: ${quoted(e.runnerUp.option)} — ${e.runnerUp.figure}%`,
			`- To reverse: ${quoted(e.reverse)}`,
			"",
			"## Acceptance criteria",
			"",
			"- [ ] The option taken is undone, by the recipe above where it still applies",
			"- [ ] The runner-up is built in its place",
			"",
		].join("\n"),
	};
}

/**
 * @param {number} reviewNumber the review issue the request was made on
 * @param {Request} request
 * @param {Outcome} outcome
 */
const buildAckComment = (reviewNumber, request, outcome) =>
	[
		"filed" in outcome
			? `**Reversal filed:** entry ${request.n} → ${outcome.filed}, for ${commentLink(reviewNumber, request.commentUrl, "request")}.`
			: `**Reversal not filed:** entry ${request.n ?? "?"}, for ${commentLink(reviewNumber, request.commentUrl, "request")} — ${outcome.why}.`,
		"",
		buildMarker(request.commentUrl, request.n),
		"",
	].join("\n");

module.exports = {
	buildAckComment,
	buildReversalTicket,
	pendingRequests,
};
