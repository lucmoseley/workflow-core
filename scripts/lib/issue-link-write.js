/*
 * issue-link-write.js — the guard-issue-link core (#5086, spec #5070): does a
 * Bash call write a blocker or sub-issue link by raw `gh api`, past the link
 * commands that refuse a link closing a loop of open issues?
 *
 * Why: two links filed four minutes apart once closed a loop across two
 * trackers, each reasonable alone, and GitHub accepted it (#5055). The link
 * commands — scripts/link-blocker.js and scripts/link-sub-issue.sh — walk the
 * wait graph before they POST and refuse the closing link; a raw call skips
 * that walk.
 *
 * A write is:
 *  - `gh api` at `issues/<n>/dependencies/blocked_by` or `issues/<n>/sub_issues`
 *    whose method is POST, or which names no method but carries a field flag
 *    or `--input` — gh's own implicit POST;
 *  - `gh api` carrying a GraphQL `addSubIssue` or `addBlockedBy` mutation,
 *    judged on the `query=` text whatever the endpoint reads as, as the
 *    guard-issue-body core judges `updateIssue`;
 *  - `gh issue edit` with `--add-blocked-by`, `--add-blocking`,
 *    `--add-sub-issue` or `--parent`, and `gh issue create` with `--parent`,
 *    `--blocked-by` or `--blocking` — gh 2.94's own link flags.
 * GET, DELETE, the `sub_issues/priority` PATCH, gh's `--remove-*` flags, the
 * link commands and an endpoint named only inside `--jq` pass: removing a link
 * never closes a loop.
 *
 * A CORE: it does no I/O and makes no network call. Script paths arrive as
 * ports on lib/kit-context.js's context.
 *
 * LIMITS
 *  - Lexical: a method, endpoint or query the parser cannot read passes.
 *  - A link made in the web UI, or by a `gh` a script shells out to, never
 *    reaches a PreToolUse core; scripts/check-issue-cycles.js reports the loop
 *    after the fact.
 *  - Its manifest row runs it only on a command `Bash(gh *)` admits, so a
 *    path-spelled `/usr/bin/gh` is unjudged, as for guard-issue-body.
 *  - It FAILS CLOSED on a throw of its own.
 */

const {
	apiPath,
	defaultsToPost,
	endpointRepo,
	mutationArgs,
	scanApi,
	scanGraphql,
} = require("./gh-api-call.js");
const { deny, walkVerdict } = require("./guard-verdict.js");
const { parseCommand } = require("./shell-parse.js");
const { isGhCommand, literal } = require("./shell-words.js");

/**
 * @typedef {import("./kit-context.js").KitContext} LinkContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

const BLOCKER =
	/^repos\/[^/]+\/[^/]+\/issues\/([^/]+)\/dependencies\/blocked_by\/?$/;
const SUB_ISSUE = /^repos\/[^/]+\/[^/]+\/issues\/([^/]+)\/sub_issues\/?$/;
const MUTATIONS = ["addSubIssue", "addBlockedBy"];

const WHY =
	"A raw link write skips the loop check: the link commands walk every open blocker and sub-issue, in any repo, and refuse a link that would close a loop of issues that can never close (#5055).";

/**
 * @param {string} command
 * @param {LinkContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const stopped = walkVerdict(parsed, (cmd) => judge(parsed, ctx, cmd), ctx);
	return stopped === undefined ? null : stopped;
}

/**
 * @param {Parsed} parsed
 * @param {LinkContext} ctx
 * @param {Command} cmd
 */
function judge(parsed, ctx, cmd) {
	const [head = "", sub, verb] = cmd.words;
	if (!isGhCommand(head)) return;
	if (sub === "issue" && (verb === "edit" || verb === "create"))
		judgeIssueFlags(ctx, cmd, verb);
	if (sub === "api") judgeApi(parsed, ctx, cmd);
}

/**
 * A `gh api` call: a GraphQL link mutation, or a POST at a link endpoint.
 * @param {Parsed} parsed
 * @param {LinkContext} ctx
 * @param {Command} cmd
 */
function judgeApi(parsed, ctx, cmd) {
	const call = scanApi(cmd.words.slice(2), parsed.spans);
	const { query } = scanGraphql(call.fields, parsed.spans);
	const mutation = MUTATIONS.find((m) => mutationArgs(query, m) !== null);
	if (mutation)
		deny(
			ctx,
			cmd.segment,
			`This adds a link through GraphQL's ${mutation}: @CMD@\n\n${WHY}\nMake it with ${mutation === "addBlockedBy" ? blockerForm("<blocked>") : subIssueForm("<parent>", false)}.`,
		);
	const method = literal(call.method, parsed.spans).text.toUpperCase();
	if (method ? method !== "POST" : !defaultsToPost(call)) return;
	const endpoint = apiPath(
		literal(call.endpoint, parsed.spans).text.split("?")[0] ?? "",
	);
	const repo = endpointRepo(endpoint);
	const blocked = BLOCKER.exec(endpoint)?.[1];
	if (blocked)
		deny(
			ctx,
			cmd.segment,
			`This POSTs a blocker link by raw gh api: @CMD@\n\n${WHY}\nMake it with ${blockerForm(qualified(repo, blocked))}.`,
		);
	const parent = SUB_ISSUE.exec(endpoint)?.[1];
	if (parent) {
		const replace = call.fields.some((f) =>
			/^replace_parent=true$/.test(literal(f, parsed.spans).text),
		);
		deny(
			ctx,
			cmd.segment,
			`This POSTs a sub-issue link by raw gh api: @CMD@\n\n${WHY}\nMake it with ${repo ? `WFC_LINK_REPO=${repo} ` : ""}${subIssueForm(parent, replace)}.`,
		);
	}
}

/* gh 2.94's own link flags, which make the same native links. */
const ISSUE_LINK_FLAGS = {
	edit: ["--add-blocked-by", "--add-blocking", "--add-sub-issue", "--parent"],
	create: ["--blocked-by", "--blocking", "--parent"],
};

/**
 * A `gh issue edit` or `gh issue create` carrying a link flag.
 * @param {LinkContext} ctx
 * @param {Command} cmd
 * @param {"edit" | "create"} verb
 */
function judgeIssueFlags(ctx, cmd, verb) {
	const args = cmd.words.slice(3);
	const flag = ISSUE_LINK_FLAGS[verb].find((f) =>
		args.some((w) => w === f || w.startsWith(`${f}=`)),
	);
	if (!flag) return;
	const n = /^#?\d+$/.test(args[0] ?? "")
		? String(args[0]).replace("#", "")
		: "<n>";
	deny(
		ctx,
		cmd.segment,
		`This makes a link through gh issue ${verb} ${flag}: @CMD@\n\n${WHY}\nMake it with ${issueFlagForm(verb, flag, n)}.`,
	);
}

/**
 * The link command standing in for one gh issue link flag.
 * @param {"edit" | "create"} verb
 * @param {string} flag
 * @param {string} n the edited issue, `<n>` where unread
 */
function issueFlagForm(verb, flag, n) {
	if (verb === "create")
		return flag === "--parent"
			? "node scripts/file-issue.js --parent <parent> …, which files and links in one call"
			: `node scripts/file-issue.js …, then ${blockerForm(flag === "--blocked-by" ? "<new>" : "<blocked>")}`;
	if (flag === "--add-blocked-by") return blockerForm(`#${n}`);
	if (flag === "--add-blocking")
		return `node scripts/link-blocker.js <blocked> #${n} — each issue as #n or owner/name#n; it resolves the id and verifies the edge in a separate read`;
	if (flag === "--add-sub-issue") return subIssueForm(n, false);
	return `scripts/link-sub-issue.sh <parent> ${n} --replace-parent — --replace-parent only where #${n} already has a parent`;
}

/**
 * `#n` where the endpoint names gh's placeholders, `owner/name#n` where it
 * names a repo, as link-blocker.js reads either.
 * @param {string | null} repo
 * @param {string} n
 */
const qualified = (repo, n) => (repo ? `${repo}#${n}` : `#${n}`);

/** @param {string} blocked */
const blockerForm = (blocked) =>
	`node scripts/link-blocker.js ${blocked} <blocker> — each issue as #n or owner/name#n, never a database id; it resolves the id and verifies the edge in a separate read`;

/**
 * @param {string} parent
 * @param {boolean} replace
 */
const subIssueForm = (parent, replace) =>
	`scripts/link-sub-issue.sh ${parent} <child>${replace ? " --replace-parent" : ""} — the child's #number, never its database id${replace ? "" : "; add --replace-parent to move a child that already has a parent"}`;

module.exports = { field: "command", noun: "command", decide };
