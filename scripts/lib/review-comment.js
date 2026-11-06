/*
 * review-comment.js — a PreToolUse dispatcher core (#4492): it denies a
 * `gh issue comment` posting a whole-spec review — a body carrying
 * `**Reviewed through:**` — where a line marks a finding TICKETED without
 * naming the exception that let it skip fix-first (#4284).
 *
 * A CORE: it does no I/O.
 *
 * LIMITS
 *  - A body it cannot read (`$(cat …)`, a missing file, a file the same call
 *    writes) passes, logged; a comment posted through `gh api` or a script's
 *    child `gh` is not seen.
 *  - It reads the tag, never whether the exception named is true.
 *  - Wired with `if: Bash(gh *)` (best-effort: a `timeout gh …` prefix or a
 *    path-spelled `gh` goes unjudged).
 */

const { COMMENT_SPELLING, readIssueCall } = require("./gh-acts.js");
const { isGh } = require("./gh-issue-ref.js");
const { deny, walkVerdict } = require("./guard-verdict.js");
const { parseCommand } = require("./shell-parse.js");

/**
 * @typedef {object} ReviewCommentPorts
 * @property {string} home what a body path's leading `~` expands to
 * @property {(path: string) => string|undefined} readFile a body file's text,
 *   undefined where it is absent; throws where it cannot be read
 * @typedef {import("./kit-context.js").KitContext & ReviewCommentPorts}
 *   ReviewCommentContext
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
				/* Loaded only for a comment's body: this core sits on every `gh` call. */
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
