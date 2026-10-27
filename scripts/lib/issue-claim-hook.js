/*
 * issue-claim-hook.js — the cores of record-issue-claim.js and
 * release-issue-claim.js (#2799, programme #2733): which issues a Bash call
 * assigns to this session with `gh issue edit <n> --add-assignee @me`, or
 * closes with `gh issue close <n>`.
 *
 * A CORE: it does no I/O. The origin remote and the arbiter's claim store
 * arrive as ports; lib/gh-recorder-host.js builds the real ones.
 */

const {
	ISSUE_VALUE_FLAGS,
	issueWord,
	isGh,
	repoOf,
	sessionOf,
} = require("./gh-issue-ref.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

/**
 * @typedef {object} ClaimPorts
 * @property {Record<string, unknown>} payload
 * @property {string} envSession CLAUDE_CODE_SESSION_ID, the payload's fallback
 * @property {string} root
 * @property {(dir: string) => string} originUrl the origin remote's URL of the
 *   repo at `dir`; "" where git cannot answer
 * @property {(issue: string, sessionId: string) => void} claimIssue
 * @property {(issue: string, sessionId: string) => void} releaseIssue
 * @typedef {import("./guard-entry.js").KitContext & ClaimPorts} ClaimContext
 */

/**
 * The issues one `gh issue <sub>` names: a URL counts only where it names the
 * host repo's own origin. A `--repo` anywhere, EVEN ONE NAMING THIS
 * REPOSITORY, or one left dangling, voids the call.
 * @param {string[]} words the arguments after `gh issue <sub>`
 * @param {string[]} spans
 * @param {string} spec the subcommand's value-taking flags
 * @param {() => string} origin the host repo's own `owner/name`
 * @returns {string[] | null} null where the call is `--repo`-scoped
 */
function localIssues(words, spans, spec, origin) {
	/** @type {string[]} */
	const issues = [];
	let scoped = false;
	scanFlags(spec, words, (kind, name, value) => {
		const repoFlag = name === "-R" || name === "--repo";
		if ((kind === "opt" || kind === "dangling") && repoFlag) scoped = true;
		else if (kind === "arg") {
			const ref = issueWord(value, spans);
			if (ref && (ref.repo === "" || ref.repo === origin()))
				issues.push(ref.number);
		}
	});
	return scoped ? null : issues;
}

/**
 * The issues `subject` hands one of `sub`'s calls, each handed to `act`.
 * @param {string} subject
 * @param {ClaimContext} ctx
 * @param {{ sub: "edit" | "close", wants: (words: string[], spans: string[]) => boolean,
 *   act: (issue: string, sessionId: string) => void }} limb
 */
function eachIssue(subject, ctx, { sub, wants, act }) {
	if ((ctx.tool ?? "Bash") !== "Bash") return null;
	const sessionId = sessionOf(ctx);
	if (!sessionId) return null;
	/** @type {string | undefined} */
	let origin;
	const own = () => {
		origin ??= repoOf(ctx.originUrl(ctx.root));
		return origin;
	};
	const parsed = parseCommand(subject);
	walkCommands(
		parsed,
		({ words }) => {
			if (!isGh(words) || words[1] !== "issue" || words[2] !== sub) return;
			const args = words.slice(3);
			if (!wants(args, parsed.spans)) return;
			for (const n of localIssues(
				args,
				parsed.spans,
				ISSUE_VALUE_FLAGS[sub],
				own,
			) ?? [])
				act(n, sessionId);
		},
		ctx,
	);
	return null;
}

/**
 * record-issue-claim's core: a `gh issue edit` whose `--add-assignee` list
 * holds `@me` claims each issue it names.
 * @param {string} subject the command
 * @param {ClaimContext} ctx
 * @returns {null}
 */
const decideClaim = (subject, ctx) =>
	eachIssue(subject, ctx, {
		sub: "edit",
		wants: (args, spans) => {
			let me = false;
			scanFlags(ISSUE_VALUE_FLAGS.edit, args, (kind, name, value) => {
				if (kind === "opt" && name === "--add-assignee")
					me ||= `,${literal(value, spans).text},`.includes(",@me,");
			});
			return me;
		},
		act: ctx.claimIssue,
	});

/**
 * release-issue-claim's core: a `gh issue close` drops this session's claim
 * on each issue it names.
 * @param {string} subject the command
 * @param {ClaimContext} ctx
 * @returns {null}
 */
const decideRelease = (subject, ctx) =>
	eachIssue(subject, ctx, {
		sub: "close",
		wants: () => true,
		act: ctx.releaseIssue,
	});

module.exports = { decideClaim, decideRelease };
