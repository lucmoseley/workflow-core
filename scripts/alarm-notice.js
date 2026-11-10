#!/usr/bin/env node
/*
 * alarm-notice.js — the off-machine queue alarms' route to the founder
 * (#4939): mentions him once per stall, as github-actions[bot], on the
 * tracker issue NOTICE_ISSUE, which GitHub delivers by email and a GitHub
 * Mobile push (#3874). Run hourly by the tracker's `alarm-notice.yml`, the
 * one place a workflow may hold `issues: write` (TRACKER-SCOPE,
 * scripts/check-workflow-permissions.js), and checked out from the public
 * code repo's `main` there.
 *
 *   node scripts/alarm-notice.js
 *
 * Reads GITHUB_API_URL, GITHUB_REPOSITORY (the tracker, where the comment
 * goes), GH_TOKEN and NOTICE_ISSUE; the code repo and the login to mention
 * come from the checkout's config, `codeRepo` and `founderNotice.mention`.
 *
 * ONE MENTION PER STALL: an alarm whose newest finished run on `main` failed
 * is noticed unless the issue already carries the bot's notice for it posted
 * since that alarm's newest green run. A forced failure counts like any
 * other, so a forced pair tests the dedup. Nothing is posted on a green.
 *
 * RESIDUAL: a broken read fails this run with nothing posted, and with
 * Actions email off nobody hears of it; the next hourly run retries.
 *
 * Exit codes: 0 where every alarm was read; 2 where a read or the comment
 * failed. Needs no npm install.
 */

const { actionsApi } = require("./lib/actions-api.js");
const { VERIFIED_BRANCH } = require("./lib/landing-refs.js");
const { ALARMS } = require("./lib/queue-alarms.js");
const { readConfig } = require("./lib/workflow-core-config.js");

const BOT = "github-actions[bot]";
/* A guess: enough finished runs to reach the last green of a stall days
 * long; with none listed, any notice for that alarm stands for this stall. */
const RUN_PAGE = 100;
/* GitHub's ceiling for one page of issue comments, and a cap on pages. */
const COMMENT_PAGE = 100;
const COMMENT_PAGES = 10;

/**
 * @typedef {{id: number, conclusion: string|null, updated_at: string,
 *   html_url: string}} Run a workflow run, as the REST API lists it
 * @typedef {{created_at: string, body?: string, user?: {login?: string}}}
 *   Comment an issue comment, as the REST API lists it
 * @typedef {import("./lib/actions-api.js").Get} Get
 * @typedef {import("./lib/actions-api.js").Post} Post
 */

/** @param {string} file the alarm's workflow file */
const buildMarker = (file) => `<!-- alarm-notice:${file} -->`;

/**
 * The failed run a stall's notice is due for, or null where the alarm is
 * green, has no finished run, or was noticed since its last green.
 * @param {Run[]} runs newest first
 * @param {Comment[]} comments the notice issue's comments
 * @param {string} marker
 * @returns {{red: Run|null, due: boolean}}
 */
function judgeAlarm(runs, comments, marker) {
	const decisive = runs.filter(
		(r) => r.conclusion === "success" || r.conclusion === "failure",
	);
	const newest = decisive[0];
	if (newest === undefined || newest.conclusion === "success")
		return { red: null, due: false };
	const green = decisive.find((r) => r.conclusion === "success");
	const since =
		green === undefined
			? Number.NEGATIVE_INFINITY
			: Date.parse(green.updated_at);
	const noticed = comments.some(
		(c) =>
			c.user?.login === BOT &&
			typeof c.body === "string" &&
			c.body.includes(marker) &&
			Date.parse(c.created_at) > since,
	);
	return { red: newest, due: !noticed };
}

/**
 * @param {Get} get
 * @param {string} path the comments path, no query
 * @param {string|undefined} since an ISO time, or undefined for all
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
		if (got.length < COMMENT_PAGE) break;
	}
	return all;
}

/**
 * @param {{get: Get, post: Post, say: (line: string) => void,
 *   codeRepo: string, noticeRepo: string, issue: number, mention: string}}
 *   deps
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
			const green = runs.find((r) => r.conclusion === "success");
			const comments = await readComments(get, commentsPath, green?.updated_at);
			const marker = buildMarker(file);
			const { red, due } = judgeAlarm(runs, comments, marker);
			if (red === null) {
				say(`${name}: green, or no finished run on ${VERIFIED_BRANCH}.`);
				continue;
			}
			if (!due) {
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

/** @returns {Promise<number>} */
function main() {
	const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);
	const { codeRepo, founderNotice } = readConfig({ quiet: true });
	const issue = Number(process.env.NOTICE_ISSUE);
	const noticeRepo = process.env.GITHUB_REPOSITORY;
	if (
		codeRepo === undefined ||
		founderNotice === undefined ||
		noticeRepo === undefined ||
		!Number.isInteger(issue) ||
		issue <= 0
	) {
		say(
			"::error title=Notice broken::Needs `codeRepo` and `founderNotice` in .claude/workflow-core.json, GITHUB_REPOSITORY, and NOTICE_ISSUE as an issue number.",
		);
		return Promise.resolve(2);
	}
	const { get, post } = actionsApi(process.env);
	return runNotice({
		get,
		post,
		say,
		codeRepo,
		noticeRepo,
		issue,
		mention: founderNotice.mention,
	});
}

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.stderr.write(`alarm-notice: ${e}\n`);
			process.exitCode = 2;
		},
	);

module.exports = { main, runNotice };
