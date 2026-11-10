#!/usr/bin/env node
/*
 * alarm-notice.js — the off-machine queue alarms' route to the founder
 * (#4939): mentions him once per stall, as github-actions[bot], on the
 * tracker issue NOTICE_ISSUE, which GitHub delivers by email and a GitHub
 * Mobile push (#3874). Run hourly by the tracker's `alarm-notice.yml`, the
 * one place a workflow may hold `issues: write` (TRACKER-SCOPE,
 * scripts/check-workflow-permissions.js), and checked out from the public
 * code repo's `main` there. The judging is lib/alarm-notice.js's.
 *
 *   node scripts/alarm-notice.js
 *
 * Reads GITHUB_API_URL, GITHUB_REPOSITORY (the tracker, where the comment
 * goes), GH_TOKEN and NOTICE_ISSUE; the code repo and the login to mention
 * come from the checkout's config, `codeRepo` and `founderNotice.mention`.
 *
 * NOT A `check-*` OR `report-*`: it judges no repo state and files no
 * ticket; it relays two workflows' verdicts, and a check's SKIP on an
 * unreachable GitHub would read as no stall.
 *
 * RESIDUAL: a broken read fails this run with nothing posted, and with
 * Actions email off nobody hears of it; the next hourly run retries.
 *
 * Exit codes: 0 where every alarm was read; 2 where a read, the config or
 * the comment failed. Needs no npm install.
 */

const { buildActionsApi } = require("./lib/actions-api.js");
const { runNotice } = require("./lib/alarm-notice.js");
const { readConfig } = require("./lib/workflow-core-config.js");

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
	const { get, post } = buildActionsApi(process.env);
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

module.exports = { main };
