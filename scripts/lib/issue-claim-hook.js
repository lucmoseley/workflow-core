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
 * @property {string} envSession
 * @property {string} root
 * @property {(dir: string) => string} originUrl
 * @property {(issue: string, sessionId: string) => void} claimIssue
 * @property {(issue: string, sessionId: string) => void} releaseIssue
 * @typedef {import("./kit-context.js").KitContext & ClaimPorts} ClaimContext
 */

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {string} spec
 * @param {() => string} origin
 * @returns {string[] | null}
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
 * @param {string} subject
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
 * @param {string} subject
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
