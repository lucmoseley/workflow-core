/*
 * base-red-issue.js — the one issue the queue lander keeps open for files red
 * on `main` itself (#4485, spec #4458): failures a red batch shares with
 * `main`, which it blames on no member and lands past. Filed as
 * lib/queue-issue.js files it where none is open, else its body refreshed
 * naming the newest `main` red and its files.
 */

const { queueIssueFiler } = require("./queue-issue.js");

const TITLE = "`main` is red: failures the queue lander blames on no member";

/**
 * @param {string} sha
 * @param {readonly string[]} files
 * @returns {string}
 */
const buildBaseRedBody = (sha, files) => `## What to build

The queue lander (#4458) found these files failing on \`main\` as well as on a batch it tested, so it blamed them on no member and landed past them. Every later batch that fails them lands past them too, until they pass on \`main\`.

- Main: \`${sha}\`

Failing:
${files.map((f) => `- \`${f}\``).join("\n")}

## Acceptance criteria

- [ ] Each file above passes on \`main\`.
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
