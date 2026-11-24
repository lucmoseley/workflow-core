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
	"A raw link write skips the loop check: the link commands walk every open blocker and sub-issue, in any repo, and refuse a link that would close a loop of issues that can never close (workflow-core#5055).";

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
			`This adds a link through GraphQL's ${mutation}: @CMD@\n\n${WHY}\nMake it with ${mutation === "addBlockedBy" ? blockerForm(ctx, "<blocked>") : subIssueForm(ctx, "<parent>", false)}.`,
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
			`This POSTs a blocker link by raw gh api: @CMD@\n\n${WHY}\nMake it with ${blockerForm(ctx, qualified(repo, blocked))}.`,
		);
	const parent = SUB_ISSUE.exec(endpoint)?.[1];
	if (parent) {
		const replace = call.fields.some((f) =>
			/^replace_parent=true$/.test(literal(f, parsed.spans).text),
		);
		deny(
			ctx,
			cmd.segment,
			`This POSTs a sub-issue link by raw gh api: @CMD@\n\n${WHY}\nMake it with ${repo ? `WFC_LINK_REPO=${repo} ` : ""}${subIssueForm(ctx, parent, replace)}.`,
		);
	}
}

const ISSUE_LINK_FLAGS = {
	edit: ["--add-blocked-by", "--add-blocking", "--add-sub-issue", "--parent"],
	create: ["--blocked-by", "--blocking", "--parent"],
};

/**
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
		`This makes a link through gh issue ${verb} ${flag}: @CMD@\n\n${WHY}\nMake it with ${issueFlagForm(ctx, verb, flag, n)}.`,
	);
}

const REF_FORMS =
	"each issue as a bare number or owner/name#n, never a database id";

/**
 * @param {LinkContext} ctx
 * @param {"edit" | "create"} verb
 * @param {string} flag
 * @param {string} n
 */
function issueFlagForm(ctx, verb, flag, n) {
	const filer = `node ${ctx.scriptPath("file-issue.js")}`;
	if (verb === "create")
		return flag === "--parent"
			? `${filer} --parent <parent> …, which files and links in one call`
			: `${filer} …, then ${blockerForm(ctx, flag === "--blocked-by" ? "<new>" : "<blocked>")}`;
	if (flag === "--add-blocked-by") return blockerForm(ctx, n);
	if (flag === "--add-blocking")
		return `node ${ctx.scriptPath("link-blocker.js")} <blocked> ${n} — ${REF_FORMS}; it resolves the id and verifies the edge in a separate read`;
	if (flag === "--add-sub-issue") return subIssueForm(ctx, n, false);
	return `${ctx.scriptPath("link-sub-issue.sh")} <parent> ${n} --replace-parent — --replace-parent only where #${n} already has a parent`;
}

/**
 * @param {string | null} repo
 * @param {string} n
 */
const qualified = (repo, n) => (repo ? `${repo}#${n}` : n);

/** @param {LinkContext} ctx @param {string} blocked */
const blockerForm = (ctx, blocked) =>
	`node ${ctx.scriptPath("link-blocker.js")} ${blocked} <blocker> — ${REF_FORMS}; it resolves the id and verifies the edge in a separate read`;

/**
 * @param {LinkContext} ctx
 * @param {string} parent
 * @param {boolean} replace
 */
const subIssueForm = (ctx, parent, replace) =>
	`${ctx.scriptPath("link-sub-issue.sh")} ${parent} <child>${replace ? " --replace-parent" : ""} — the child a bare number or owner/name#n, never a database id${replace ? "" : "; add --replace-parent to move a child that already has a parent"}`;

module.exports = { field: "command", noun: "command", decide };
