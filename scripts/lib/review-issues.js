/*
 * review-issues.js — the morning review issues on a tracker, read off the
 * label list (#2011, #2017): scripts/file-morning-review.js reads them to
 * window and dedupe the day's filing, scripts/answer-review-reversals.js for
 * the `reverse <n>` comments on them.
 */

const { ghIssueListAll } = require("./gh.js");
const { parseReviewDate } = require("./morning-review.js");
const { takesLabel } = require("./takes-label.js");

/* Spec #1995: the founder answers the review inside a /wayfinder session. */
const REVIEW_LABEL = takesLabel("wayfinder");

/**
 * The review issues on `repo` in `state`, newest first, with their body and
 * comments where `withComments`, for the reversals. Read off the label list,
 * not search, whose index lags a fresh create and would let a quick re-run
 * file twice.
 * @param {string} repo
 * @param {"all" | "open" | "closed"} state
 * @param {{withComments?: boolean, more?: string[]}} [opts]
 * @returns {{number: number, title: string, state: string, createdAt: string,
 *   body?: string, comments?: import("./review-reversal.js").Comment[]}[]}
 */
function readReviewIssues(
	repo,
	state,
	{ withComments = false, more = [] } = {},
) {
	return ghIssueListAll("review issues", [
		"--repo",
		repo,
		"--state",
		state,
		"--label",
		REVIEW_LABEL,
		...more,
		"--json",
		`number,title,state,createdAt${withComments ? ",body,comments" : ""}`,
	])
		.filter((/** @type {{title: string}} */ i) => parseReviewDate(i.title))
		.sort(
			(
				/** @type {{createdAt: string}} */ a,
				/** @type {{createdAt: string}} */ b,
			) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
		);
}

module.exports = { REVIEW_LABEL, readReviewIssues };
