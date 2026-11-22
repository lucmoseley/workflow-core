#!/usr/bin/env node

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
