const {
	isBodyField,
	isGraphql,
	isIssueEndpoint,
	mutationArgs,
	scanApi,
	scanGraphql,
} = require("./gh-api-call.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { deny, ruleOrFallback, walkVerdict } = require("./guard-verdict.js");
const { parseCommand, unmask } = require("./shell-parse.js");
const { QUOTED, isGhCommand } = require("./shell-words.js");

/**
 * @typedef {import("./kit-context.js").KitContext} BodyContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {{ parsed: Parsed, ctx: BodyContext, warning: string }} Run
 */

/**
 * @param {string} command
 * @param {BodyContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = { parsed: parseCommand(command), ctx, warning: "" };
	const stopped = walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx);
	if (stopped !== undefined) return stopped;
	return run.warning
		? { injectRules: [], prelude: ctx.corePaths(run.warning) }
		: null;
}

/**
 * @param {Run} run
 * @param {string} segment
 * @returns {never}
 */
function refuseClobber(run, segment) {
	const { ctx } = run;
	const rule = ruleOrFallback(
		ctx,
		"issue-body-clobber",
		"Every issue-body edit goes through node scripts/issue-body.js",
	);
	return deny(
		ctx,
		segment,
		`This writes an issue body whole, erasing any parallel session's edit: @CMD@\n\n${rule}`,
	);
}

/**
 * @param {Run} run
 * @param {string} cannot
 * @param {string} fine
 * @param {string} segment
 */
function warnOnce(run, cannot, fine, segment) {
	if (run.warning) return;
	run.warning = `${cannot}

  ${unmask(segment)}

If it writes the body, it writes it whole and erases any parallel session's edit — GitHub offers no conditional write (mantahostels#128), and that is the 4 August 2026 loss on mantahostels#96. Route a body change through the helper instead:
  node ${run.ctx.scriptPath("issue-body.js")} append <n> --text "…"

${fine}`;
}

/** @param {string[]} args */
function editsBody(args) {
	for (const tok of args) {
		if (tok === "--") return false;
		if (/^--body(-file)?(=|$)/.test(tok)) return true;
		const bundle = !tok.startsWith("--") && tok.length > 1 && tok[0] === "-";
		if (bundle && bundleEditsBody(tok.slice(1))) return true;
	}
	return false;
}

const EDIT_SHORTHANDS = ISSUE_VALUE_FLAGS.edit
	.split(" ")
	.filter((f) => /^-[^-]$/.test(f))
	.map((f) => f.slice(1));

/** @param {string} letters */
function bundleEditsBody(letters) {
	for (const ch of letters) {
		if (ch === "b" || ch === "F") return true;
		if (EDIT_SHORTHANDS.includes(ch)) return false;
	}
	return false;
}

/** @param {string} word */
const unread = (word) => word.includes(QUOTED) || word.includes("$");

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const [head = "", sub, verb] = cmd.words;
	if (!isGhCommand(head)) return;
	if (sub === "issue") {
		if (verb === "edit" && editsBody(cmd.words.slice(3)))
			refuseClobber(run, cmd.segment);
	} else if (sub === "api") judgeApi(run, cmd.segment, cmd.words.slice(2));
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string[]} args
 */
function judgeApi(run, segment, args) {
	const call = scanApi(args, run.parsed.spans);
	const graphql = scanGraphql(call.fields, run.parsed.spans);
	const hiddenInput = judgeMutation(run, segment, graphql.query);
	if (isGraphql(call.endpoint)) {
		if (graphql.hidden || call.opaque || call.input || hiddenInput)
			warnOnce(
				run,
				"This posts a GraphQL query the guard cannot read in full:",
				"A read-only query is fine; carry on.",
				segment,
			);
		return;
	}
	judgePatch(run, segment, call);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} query
 * @returns {boolean}
 */
function judgeMutation(run, segment, query) {
	const mutation = mutationArgs(query, "updateIssue");
	if (mutation === null) return false;
	if (mutation.includes("body:")) refuseClobber(run, segment);
	return mutation.includes("input:$");
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {import("./gh-api-call.js").ApiCall} call
 */
function judgePatch(run, segment, call) {
	const body = call.fields.some((f) => isBodyField(f, run.parsed.spans));
	let hidden;
	if (call.method.toUpperCase() === "PATCH") hidden = false;
	else if (unread(call.method)) hidden = true;
	else return;
	if (!isIssueEndpoint(call.endpoint)) {
		if (!unread(call.endpoint)) return;
		hidden = true;
	}

	if (!hidden && body) refuseClobber(run, segment);
	if (!(body || call.opaque || call.input)) return;
	warnOnce(
		run,
		"This PATCHes an issue resource directly, and the guard cannot see whether it writes the body:",
		"A field-only PATCH — state, labels, assignees — is fine; carry on.",
		segment,
	);
}

module.exports = { field: "command", noun: "command", decide };
