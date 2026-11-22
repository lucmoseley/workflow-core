const { commentLink, quoted } = require("./morning-review.js");
const { STANDARDS_DOCS } = require("./primitives-table.js");
const { requiredGroup } = require("./regex-group.js");

const REQUEST = /^[ \t]*reverse\b(.*)$/gim;
const NUMBERS =
	/^[ \t]+(?:entry[ \t]+|entries[ \t]+)?(#?\d+(?:[ \t]*(?:,|and)[ \t]*#?\d+)*)/i;
const MARKER = /<!-- reversal-of (\S+) entry (\d+|\?) -->/g;
// guess, #3465
const TITLE_TEXT_MAX = 80;

/**
 * @typedef {{url: string, body: string}} Comment
 * @typedef {{commentUrl: string, n: number | null}} Request
 * @typedef {{filed: string} | {why: string}} Outcome
 */

/**
 * @param {{repo: string, number: number}} review
 * @param {Request} request
 */
const buildRequestClause = (review, request) =>
	`reversed entry ${request.n} of the morning review ${review.repo}#${review.number} (${commentLink(review.number, request.commentUrl)})`;

/** @param {string} url @param {number | null} n */
const buildMarker = (url, n) => `<!-- reversal-of ${url} entry ${n ?? "?"} -->`;

/**
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
 * @param {Comment[]} comments
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
 * @param {{review: {repo: string, number: number}, request: Request,
 *   entry: import("./delegated-decision.js").LedgerLine}} r
 * @returns {{title: string, body: string}}
 */
function buildReversalTicket({ review, request, entry: e }) {
	return {
		title: `Reverse a delegated decision on #${e.issue}: ${clipped(e.question, TITLE_TEXT_MAX)}`,
		body: [
			"## What to build",
			"",
			`The founder ${buildRequestClause(review, request)}: the delegated decision recorded on ${e.repo}#${e.issue} (${commentLink(e.issue, e.comment)}). Undo the option taken and build the runner-up in its place.`,
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
 * @param {string} text
 * @param {number} max
 */
const clipped = (text, max) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

const UNDO = {
	added: { did: "added", undo: () => "Remove the row it added" },
	removed: {
		did: "removed",
		undo: () => "Restore the row as it stood before that commit",
	},
	rewritten: {
		did: "rewrote",
		/** @param {string[]} cells */
		undo: (cells) =>
			`Restore the row's ${cells.join(", ")} ${cells.length === 1 ? "cell" : "cells"} as they stood before that commit`,
	},
};

/**
 * @param {{review: {repo: string, number: number}, request: Request,
 *   entry: Extract<import("./morning-review.js").Entry, {kind: "primitive"}>}} r
 * @returns {{title: string, body: string}}
 */
function buildPrimitiveReversalTicket({ review, request, entry: e }) {
	const file = STANDARDS_DOCS[e.side];
	return {
		title: `Reverse a primitives-table change in ${e.sha}: ${clipped(e.primitive, TITLE_TEXT_MAX)}`,
		body: [
			"## What to build",
			"",
			`The founder ${buildRequestClause(review, request)}: commit ${e.sha} ${UNDO[e.change].did} the ${e.side} primitives-table row in \`${file}\`. ${UNDO[e.change].undo(e.cells)}, and whatever the commit changed to match it.`,
			"",
			`- Job: ${quoted(e.job)}`,
			`- Primitive: ${quoted(e.primitive)}`,
			`- Diff: \`git show ${e.sha} -- ${file}\``,
			"",
			"## Acceptance criteria",
			"",
			`- [ ] The row stands as it did before ${e.sha}`,
			"- [ ] The `primitives` check (`check-primitives.js`, at the plugin root) passes",
			"",
		].join("\n"),
	};
}

/**
 * @param {number} reviewNumber
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
	buildPrimitiveReversalTicket,
	buildRequestClause,
	buildReversalTicket,
	pendingRequests,
};
