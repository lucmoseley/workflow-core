/*
 * issue-body-write.js — guard-issue-body.js's core (#2798, programme #2733):
 * does a Bash call write an issue body whole, through `gh issue edit --body`,
 * a `gh api` PATCH or a GraphQL `updateIssue`? *
 * A CORE: it does no I/O. The rule store and the script paths arrive as
 * ports on lib/guard-entry.js's context.
 *
 * THE FIRST DENY ENDS THE CALL. A
 * warn is held until the walk ends, in case a later segment denies.
 */

const {
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
 * @typedef {{ parsed: Parsed, ctx: BodyContext, warning: string }} Run one
 *   call's judging, `warning` the first warn, held back
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
 * Refuse, the stored rule spliced under the framing line. An unreadable
 * fragment is NOT a fail-open and is not logged.
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
	deny(
		ctx,
		segment,
		`This writes an issue body whole, erasing any parallel session's edit: @CMD@\n\n${rule}`,
	);
}

/**
 * @param {Run} run accumulator: warning is set where still unset
 * @param {string} cannot what the guard could not read
 * @param {string} fine what is still fine to do
 * @param {string} segment the segment to quote back
 */
function warnOnce(run, cannot, fine, segment) {
	if (run.warning) return;
	run.warning = `${cannot}

  ${unmask(segment)}

If it writes the body, it writes it whole and erases any parallel session's edit — GitHub offers no conditional write (mantahostels#128), and that is the 4 August 2026 loss on mantahostels#96. Route a body change through the helper instead:
  node ${run.ctx.scriptPath("issue-body.js")} append <n> --text "…"

${fine}`;
}

/**
 * Does this `gh issue edit` carry a body flag? `gh` is pflag, which has no
 * prefix abbreviation, so the long spellings are
 * exact. -b and -F are the shorthands, and both take a value, so in a bundle
 * they can only appear before the first value-taking letter.
 * @param {string[]} args the words after `gh issue edit`
 */
function editsBody(args) {
	for (const tok of args) {
		if (tok === "--") return false;
		if (/^--body(-file)?(=|$)/.test(tok)) return true;
		const bundle = !tok.startsWith("--") && tok.length > 1 && tok[0] === "-";
		if (bundle && bundleEditsBody(tok.slice(1))) return true;
	}
	return false;
}

/* gh issue edit's shorthand letters, each of which takes a value. */
const EDIT_SHORTHANDS = ISSUE_VALUE_FLAGS.edit
	.split(" ")
	.filter((f) => /^-[^-]$/.test(f))
	.map((f) => f.slice(1));

/**
 * A shorthand bundle, its `-` off: does a body letter come before the first
 * letter taking a value?
 * @param {string} letters
 */
function bundleEditsBody(letters) {
	for (const ch of letters) {
		if (ch === "b" || ch === "F") return true;
		/* Every other shorthand gh issue edit takes a value: the rest of the
		 * bundle is that value, not more flags. */
		if (EDIT_SHORTHANDS.includes(ch)) return false;
	}
	return false;
}

/** @param {string} word a raw word the parser could not fully read */
const unread = (word) => word.includes(QUOTED) || word.includes("$");

/**
 * One command the call runs: `gh issue edit` and `gh api` are judged.
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
 * A `gh api` call. A visible `body=` field is this guard's own read. Only
 * the field NAME decides: a masked VALUE — `-f title="New"` — is still
 * visibly not the body, and warning on it fires on the safe case
 * (mantahostels#109).
 * @param {Run} run
 * @param {string} segment
 * @param {string[]} args the words after `gh api`
 */
function judgeApi(run, segment, args) {
	const call = scanApi(args);
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
 * GraphQL names the write in the query text rather than in a field, and goes
 * out as a POST, so the PATCH test would not see it. `body:` inside
 * updateIssue's own arguments is an input field or a variable declaration,
 * both writes. Judged whatever the endpoint reads as.
 * @param {Run} run
 * @param {string} segment
 * @param {string} query
 * @returns {boolean} the whole input object arrives as one variable, so the
 *   query names no field at all and its value is somewhere this guard cannot
 *   read. A variable INSIDE a braced input is different: every field name is
 *   still spelled out there, so a body could not hide in one.
 */
function judgeMutation(run, segment, query) {
	const mutation = mutationArgs(query, "updateIssue");
	if (mutation === null) return false;
	if (mutation.includes("body:")) refuseClobber(run, segment);
	return mutation.includes("input:$");
}

/**
 * A PATCH at one issue. A method or an endpoint the parser cannot read is not
 * a pass: it drops the segment to the warn tier rather than out of the guard.
 * @param {Run} run
 * @param {string} segment
 * @param {import("./gh-api-call.js").ApiCall} call
 */
function judgePatch(run, segment, call) {
	const body = call.fields.some((f) => f.startsWith("body="));
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

module.exports = { decide };
