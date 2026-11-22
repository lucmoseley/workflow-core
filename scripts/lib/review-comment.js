const { COMMENT_SPELLING, readIssueCall } = require("./gh-acts.js");
const { isGh } = require("./gh-issue-ref.js");
const { deny, walkVerdict } = require("./guard-verdict.js");
const { parseCommand } = require("./shell-parse.js");

/**
 * @typedef {object} ReviewCommentPorts
 * @property {string} home
 * @property {(path: string) => string|undefined} readFile
 * @typedef {import("./kit-context.js").KitContext & ReviewCommentPorts} ReviewCommentContext
 */

/**
 * @param {string} command
 * @param {ReviewCommentContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	return (
		walkVerdict(
			parsed,
			({ words, cwd, segment }) => {
				if (!isGh(words) || words[1] !== "issue" || words[2] !== "comment")
					return;
				const call = readIssueCall("comment", words.slice(3), {
					spans: parsed.spans,
					subject: command,
					...COMMENT_SPELLING,
					cwd,
					home: ctx.home,
					readFile: ctx.readFile,
				});
				if (call.noPost || !call.body.given) return;
				if (call.body.fault || call.body.hidden) {
					ctx.log(
						`${call.body.fault || "body hidden"} — review comment's TICKETED lines unchecked`,
					);
					return;
				}
				const { ticketedRefusal } = require("./ticketed-tags.js");
				const refusal = ticketedRefusal(call.body.text);
				if (refusal)
					deny(
						ctx,
						segment,
						`This posts a whole-spec review that tickets a finding naming no exception: @CMD@\n\n${refusal}`,
					);
			},
			ctx,
		) ?? null
	);
}

module.exports = { field: "command", noun: "command", decide };
