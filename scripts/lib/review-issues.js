const { gh, buildGhReaders } = require("./gh.js");
const { parseReviewDate } = require("./morning-review.js");
const { takesLabel } = require("./takes-label.js");

const REVIEW_LABEL = takesLabel("wayfinder");

/**
 * @param {string} repo
 * @param {"all" | "open" | "closed"} state
 * @param {{withComments?: boolean, more?: string[], run?: typeof gh}} [opts]
 * @returns {{number: number, title: string, state: string, createdAt: string,
 *   body: string, comments?: import("./review-reversal.js").Comment[]}[]}
 */
function readReviewIssues(
	repo,
	state,
	{ withComments = false, more = [], run = gh } = {},
) {
	return buildGhReaders(run)
		.ghIssueListAll("review issues", [
			"--repo",
			repo,
			"--state",
			state,
			"--label",
			REVIEW_LABEL,
			...more,
			"--json",
			`number,title,state,createdAt,body${withComments ? ",comments" : ""}`,
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
