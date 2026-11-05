/*
 * base-red-issue.js — the one issue the queue lander keeps open for files red
 * on `main` itself: failures a red batch shares with `main`, which it blames
 * on no member.
 */

const { buildFileList } = require("./fix-ticket.js");
const { queueIssueFiler } = require("./queue-issue.js");

const TITLE = "`main` is red: failures the queue lander blames on no member";

/**
 * @param {string} sha
 * @param {readonly string[]} files
 * @returns {string}
 */
const buildBaseRedBody = (sha, files) => `## What to build

The queue lander (#4458) found ${files.length > 0 ? "these files" : "the whole suite, naming no file,"} failing on \`main\` as well as on a batch it tested, so it blamed them on no member. Until they pass on \`main\`, a batch red only on them is held where \`main\` takes only a sha a CI run passed, as on Actions, and lands past them elsewhere.

- Main: \`${sha}\`
${
	files.length > 0
		? `
Failing:
${buildFileList(files)}
`
		: ""
}
## Acceptance criteria

- [ ] ${files.length > 0 ? "Each file above passes" : "The whole suite passes"} on \`main\`.
`;

/**
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @returns {Pick<import("./queue-lander.js").QueueTracker, "fileBaseRed">}
 */
function baseRedFiler(deps) {
	const file = queueIssueFiler(deps);
	return {
		fileBaseRed: (sha, files) =>
			file(
				{
					title: TITLE,
					standalone:
						"The base-red ticket tracks `main` itself, not one ticket's work.",
					noun: "base-red ticket",
					subject: `main at ${sha.slice(0, 9)}`,
				},
				buildBaseRedBody(sha, files),
			),
	};
}

module.exports = { baseRedFiler };
