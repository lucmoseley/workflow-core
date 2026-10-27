/*
 * issue-body-write.js — the guard-issue-body core (#2798, programme #2733,
 * #3225): does a Bash call write an issue body whole, through `gh issue edit
 * --body`, a `gh api` PATCH or a GraphQL `updateIssue` (mantahostels#132)?
 *
 * Why: a GitHub issue body is download-whole/edit/upload-whole, so two
 * sessions editing one issue means the second silently erases the first, and
 * GitHub offers no conditional write to prevent it (mantahostels#128). The
 * answer is scripts/issue-body.js (mantahostels#131), which re-fetches after
 * writing and re-applies your change onto a rival's body where it was
 * overwritten.
 *
 * DENY, not warn. With every caller routed through the script there is no
 * legitimate direct use of `gh issue edit --body` left at all —
 * mantahostels#103's deny side, which is deny on a structured fact where the
 * action has no legitimate use, warn where the hook is inferring.
 *
 * No WFC_ALLOW_* escape, and none is needed: issue-body.js calls GitHub from
 * Node rather than through the Bash tool, so the permitted path never reaches
 * this core.
 *
 * A CORE: it does no I/O. The rule store and the script paths arrive as
 * ports on lib/kit-context.js's context.
 *
 * THE FIRST DENY ENDS THE CALL. A
 * warn is held until the walk ends, in case a later segment denies.
 *
 * THE OTHER SPELLINGS
 *  - `gh api --method PATCH repos/…/issues/<n>` IS chased — the spelling a
 *    session reaches for the moment the flag form is denied. Where the PATCH
 *    is aimed at an issue but the core cannot see its fields — a fully
 *    quoted `-f "body=…"`, or `--input` — it WARNS rather than denying,
 *    because there it is inferring, not reading (mantahostels#103).
 *  - `gh api graphql` carrying an `updateIssue` mutation with a body field IS
 *    chased (mantahostels#284), by reading its `query` field back out of the
 *    span the parser blanked. Where the core cannot see that text it WARNS,
 *    the same inferring tier as the unreadable PATCH — `-F query=@file`,
 *    `--input`, a variable, a command substitution, or an input object passed
 *    whole as one variable. Denying every opaque `gh api graphql` would
 *    refuse the read-only queries that are routine here.
 *  - The graphql deny is judged on the `query=` field's VALUE, concatenated
 *    by scanGraphql and scoped by mutationArgs (both lib/gh-api-call.js), and
 *    `body:` counts only between `updateIssue(` and its first `)` — a
 *    response selection (`{issue{body}}`, the `{issue{body:bodyHTML}}` alias)
 *    reads and runs; whitespace is squashed first; an `input:$var` argument
 *    names no field and drops to the warn tier. The deny is deliberately NOT
 *    gated on the endpoint being `graphql` — a masked or variable endpoint
 *    would otherwise walk past a mutation in plain sight — and a query only
 *    partly readable is still denied on what can be seen. THE WARN IS GATED,
 *    though: the warn for an unreadable query sits behind isGraphql, so a
 *    masked endpoint carrying an unreadable query gets neither deny nor warn
 *    and passes in silence.
 *  - RESIDUAL, what still reaches a body: the warn cases above; a wrapper or
 *    non-`gh` client; `updateIssue(` inside a string literal in a read-only
 *    query; and the founder's own terminal, which no Bash hook binds.
 *    check-clobbered-bodies.js covers those after the fact.
 *
 * LIMITS
 *  - It matches the *parsed command form* — a segment whose command word is
 *    `gh`, whose subcommand pair is `issue edit`, carrying a body flag — never
 *    a substring, so a grep, an echo or a heredoc mentioning `gh issue edit
 *    --body` passes. The parser is lib/shell-parse.js, shared with every
 *    Node guard (mantahostels#123).
 *  - Scope is the ISSUE body. `gh issue create --body` writes a body that
 *    does not exist yet; `gh issue comment` creates a new resource and reads
 *    no existing state; `gh pr edit --body` is a different resource with no
 *    helper to route to.
 *  - It FAILS CLOSED on a throw of its own, and open on every payload fault
 *    the dispatcher names, RECORDED (mantahostels#147) for
 *    check-guard-errors.js to report under `npm run status`. The
 *    unreadable-PATCH case is not one of these: it warns rather than failing
 *    open.
 *  - A write reached through a wrapper — `xargs gh issue edit`, a shell
 *    function, a script — is not seen, because only a segment's own command
 *    word is read.
 *  - Its manifest row runs it only on a command `Bash(gh *)` admits
 *    (mantahostels#2127): some segment leads with `gh`. NEARLY the same test
 *    as the core's own basename check, which differs on one spelling:
 *    `/usr/bin/gh …` passes the basename and matches the anchored form in
 *    neither spelling, so a path-spelled call is unjudged (mantahostels#2127).
 *  - THE RULE IT PRINTS lives in docs/agents/rules/, not here
 *    (mantahostels#1649, spec mantahostels#1641), spliced into its refusal.
 *    An unreadable fragment is the ONE fault this core does not fail open on
 *    and does not log — the command is resolved and known bad, only the rule
 *    could not be read; it refuses with a pointer to the fragment instead.
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

module.exports = { field: "command", noun: "command", decide };
