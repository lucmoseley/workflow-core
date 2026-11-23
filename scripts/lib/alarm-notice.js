const { VERIFIED_BRANCH } = require("./landing-refs.js");
const { ALARMS } = require("./queue-alarms.js");

const BOT = "github-actions[bot]";
// guess, #5529
const RUN_PAGE = 100;
// GitHub REST per_page is max 100: https://docs.github.com/en/rest/issues/comments#list-issue-comments
const COMMENT_PAGE = 100;
// guess, #5529
const COMMENT_PAGES = 10;

/**
 * @typedef {{id: number, conclusion: string|null, updated_at: string,
 *   html_url: string}} Run
 * @typedef {{created_at: string, body?: string, user?: {login?: string}}} Comment
 * @typedef {import("./actions-api.js").Get} Get
 * @typedef {import("./actions-api.js").Post} Post
 * @typedef {{get: Get, post: Post, say: (line: string) => void,
 *   codeRepo: string, noticeRepo: string, issue: number, mention: string}} NoticeDeps
 */

/** @param {string} file */
const buildMarker = (file) => `<!-- alarm-notice:${file} -->`;

/**
 * @param {Comment[]} comments
 * @param {string} marker
 * @param {Run|undefined} green
 */
const isNoticed = (comments, marker, green) => {
	const since =
		green === undefined
			? Number.NEGATIVE_INFINITY
			: Date.parse(green.updated_at);
	return comments.some(
		(c) =>
			c.user?.login === BOT &&
			typeof c.body === "string" &&
			c.body.includes(marker) &&
			Date.parse(c.created_at) > since,
	);
};

/**
 * @param {Get} get
 * @param {string} path
 * @param {string|undefined} since
 * @returns {Promise<Comment[]>}
 */
async function readComments(get, path, since) {
	/** @type {Comment[]} */
	const all = [];
	for (let page = 1; page <= COMMENT_PAGES; page++) {
		const got = await get(
			`${path}?per_page=${COMMENT_PAGE}&page=${page}${since === undefined ? "" : `&since=${encodeURIComponent(since)}`}`,
		);
		if (!Array.isArray(got)) throw new Error(`no comment list at ${path}`);
		all.push(...got);
		if (got.length < COMMENT_PAGE) return all;
	}
	throw new Error(`more than ${COMMENT_PAGES} pages of comments at ${path}`);
}

/**
 * @param {NoticeDeps} deps
 * @returns {Promise<number>}
 */
async function runNotice({
	get,
	post,
	say,
	codeRepo,
	noticeRepo,
	issue,
	mention,
}) {
	const commentsPath = `/repos/${noticeRepo}/issues/${issue}/comments`;
	try {
		for (const { name, file } of ALARMS) {
			const listed = await get(
				`/repos/${codeRepo}/actions/workflows/${file}/runs?branch=${VERIFIED_BRANCH}&status=completed&per_page=${RUN_PAGE}`,
			);
			const runs = /** @type {{workflow_runs?: unknown}} */ (listed)
				?.workflow_runs;
			if (!Array.isArray(runs)) throw new Error(`no run list for ${file}`);
			/** @type {Run[]} */
			const decisive = runs.filter(
				(r) => r.conclusion === "success" || r.conclusion === "failure",
			);
			const red = decisive[0];
			if (red === undefined || red.conclusion === "success") {
				say(`${name}: green, or no finished run on ${VERIFIED_BRANCH}.`);
				continue;
			}
			const green = decisive.find((r) => r.conclusion === "success");
			const marker = buildMarker(file);
			const comments = await readComments(get, commentsPath, green?.updated_at);
			if (isNoticed(comments, marker, green)) {
				say(
					`${name}: red on run ${red.id}, already noticed since its last green.`,
				);
				continue;
			}
			await post(commentsPath, {
				body: `@${mention} \`${name}\` is red on ${codeRepo}, run ${red.html_url}. Its error line names what to look at first. No further notice for this alarm until it has passed.\n\n${marker}`,
			});
			say(`${name}: red on run ${red.id}, noticed on #${issue}.`);
		}
	} catch (e) {
		say(
			`::error title=Notice broken::${e instanceof Error ? e.message : String(e)}. No notice went; read the two alarms' runs on ${codeRepo} by hand.`,
		);
		return 2;
	}
	return 0;
}

module.exports = { runNotice };
