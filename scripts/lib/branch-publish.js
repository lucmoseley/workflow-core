const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const path = require("node:path");
const {
	DROPPED_PREFIX,
	LANDER_PREFIX,
	ownQueueRef,
	QUEUE_PREFIX,
} = require("./landing-refs.js");
const { remoteRewindRule } = require("./main-rewind.js");
const { readPush } = require("./push-dests.js");
const { shellQuote } = require("./sh-quote.js");
const {
	parseCommand,
	unmask,
	walkCommands,
	walkGit,
} = require("./shell-parse.js");
const {
	carriesVar,
	ghWords,
	literal,
	scanFlags,
	stepGhFlags,
	valueAfter,
} = require("./shell-words.js");
const { treeOr } = require("./tree-or.js");
const { trimEndRun } = require("./trim-run.js");
const { WORKTREES } = require("./worktree-dirs.js");

/**
 * @typedef {object} BranchPublishPorts
 * @property {(cwd: string, args: string[]) => string | null} ghLookup
 * @typedef {import("./core-contract.js").CoreContext & BranchPublishPorts} BranchPublishContext
 * @typedef {{ reason: string, segment: string }} Refusal
 */

const MERGE_VALUE_FLAGS =
	"-b --body -F --body-file -t --subject -A --author-email --match-head-commit -R --repo";

const API_VALUE_FLAGS =
	"-X --method -f --raw-field -F --field -H --header --input -q --jq -t --template --cache --hostname -p --preview";

const DEPENDABOT_JQ =
	'(.headRefName | startswith("dependabot/")) or (.author.login | test("^(app/)?dependabot(\\\\[bot\\\\])?$"))';

const PULLS_RE = /^repos\/[^/]+\/[^/]+\/pulls\/?(\?.*)?$/;

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what
 * @param {string} segment
 * @returns {Refusal}
 */
const refuse = (ctx, what, segment) => ({
	reason: buildOwnRefReason(
		ctx,
		what,
		ruleOrFallback(
			ctx,
			"branch-publish",
			"Work lands through your session's queue ref — never a push to `main`, no other branch on the remote, and never a pull request",
		),
	),
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what
 * @param {string} segment
 * @returns {Refusal}
 */
const mainRewind = (ctx, what, segment) => ({
	reason: buildOwnRefReason(ctx, `This ${what}`, remoteRewindRule(ctx)),
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what
 * @param {string} rule
 * @param {string | null} [own]
 * @returns {string}
 */
const buildOwnRefReason = (ctx, what, rule, own = sessionQueueRef(ctx)) =>
	`${what}: @CMD@\n\n${ownRefLine(ctx, own)}\n\n${rule}`;

/**
 * @param {BranchPublishContext} ctx
 * @returns {string | null}
 */
function sessionQueueRef(ctx) {
	return ownQueueRef(treeOr(ctx, null)?.root, ctx.root);
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what
 * @param {string | null} own
 * @param {string} segment
 * @returns {Refusal}
 */
const queueRefusal = (ctx, what, own, segment) => ({
	reason: buildOwnRefReason(
		ctx,
		what,
		ruleOrFallback(
			ctx,
			"queue-ref",
			"Push your work to your session's own queue ref, a creation or a fast-forward, never forced",
		),
		own,
	),
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string | null} own
 */
function ownRefLine(ctx, own) {
	return own
		? `Your session's queue ref is \`${own}\`: push your work there, as \`git push origin ${shellQuote(`HEAD:refs/heads/${own}`)}\`.`
		: `This session runs outside a worktree under ${path.join(ctx.root, WORKTREES)}/, so it has no queue ref. Launch it in its own worktree with \`${ctx.scriptPath("start-session.sh")} <session-name>\`, which cuts \`${WORKTREES}/<session-name>/\` and starts the session there; its queue ref is then \`${QUEUE_PREFIX}<session-name>\`.`;
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @returns {Refusal}
 */
const dependabotMerge = (ctx, segment) => ({
	reason: `This merges a Dependabot pull request: @CMD@\n\n${ruleOrFallback(ctx, "dependabot-merge", "Never merge a Dependabot pull request")}`,
	segment,
});

/**
 * @param {string} command
 * @param {BranchPublishContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Refusal | null} */
	let refused = null;
	/** @type {BranchPublishContext} */
	const quiet = {
		...ctx,
		log: (what, detail) => {
			if (!refused) ctx.log(what, detail);
		},
	};
	walkGit(
		parsed,
		(call) => {
			refused ??= judgePush(quiet, parsed.spans, call);
		},
		quiet,
		{ subs: ["push"], noun: "branch publish", scope: "repo", unwrap: true },
	);
	if (!refused)
		walkCommands(
			parsed,
			(cmd) => {
				refused ??= judgeGh(quiet, parsed.spans, cmd);
			},
			quiet,
		);
	if (!refused) return null;
	const { reason, segment } = /** @type {Refusal} */ (refused);
	return { deny: denyText(ctx, segment, reason) };
}

/** @param {string} ref */
const isMain = (ref) =>
	ref === "main" || ref === "heads/main" || ref === "refs/heads/main";

const MANAGED = [QUEUE_PREFIX, LANDER_PREFIX, DROPPED_PREFIX];

/** @param {string} ref */
const branchNamed = (ref) => ref.replace(/^(refs\/)?heads\//, "");

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {{ branch: string, forced: boolean, deleted: boolean }} push
 * @returns {Refusal | null | undefined}
 */
function judgeManaged(ctx, segment, { branch, forced, deleted }) {
	const prefix = MANAGED.find(
		(p) => branch.startsWith(p) && branch.length > p.length,
	);
	if (!prefix) return;
	const own = sessionQueueRef(ctx);
	const named = `\`${branch}\``;
	if (prefix !== QUEUE_PREFIX)
		return queueRefusal(
			ctx,
			`This ${deleted ? "deletes" : "pushes to"} ${named}, which only the lander writes`,
			own,
			segment,
		);
	if (deleted)
		return queueRefusal(
			ctx,
			`This deletes the queue ref ${named}, which only the lander deletes`,
			own,
			segment,
		);
	if (!own)
		return queueRefusal(
			ctx,
			`This pushes to the queue ref ${named} from outside a worktree`,
			own,
			segment,
		);
	if (branch !== own)
		return queueRefusal(
			ctx,
			`This pushes to ${named}, another session's queue ref`,
			own,
			segment,
		);
	return forced
		? queueRefusal(ctx, `This force-pushes ${named}`, own, segment)
		: null;
}

/** @param {string} ref */
const isAllowedDst = (ref) =>
	ref.startsWith("refs/heads/spike/") || !ref.startsWith("refs/heads/");

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {import("./shell-parse.js").GitCall} call
 * @returns {Refusal | null}
 */
function judgePush(ctx, spans, { segment, tree, args }) {
	const read = readPush(args, spans, (src) => {
		const r = ctx.git(
			["-C", tree, "rev-parse", "--symbolic-full-name", src],
			[],
		);
		return r.ok ? trimEndRun(r.out, "\n") : "";
	});
	if (read.inert) return null;
	if (read.all && !read.delete)
		return refuse(ctx, "This pushes every local branch", segment);
	for (const row of read.rows) {
		const r = judgeRow(ctx, segment, row);
		if (r) return r;
	}
	return null;
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {import("./push-dests.js").PushRow} row
 * @returns {Refusal | null}
 */
function judgeRow(ctx, segment, row) {
	if (row.kind === "unread-delete" || row.kind === "unread-push") {
		const deleted = row.kind === "unread-delete";
		return queueRefusal(
			ctx,
			`This ${deleted ? "deletes" : "pushes to"} a ref this guard cannot read, which could be another session's queue ref, \`${LANDER_PREFIX}*\` or \`${DROPPED_PREFIX}*\` — spell the destination out`,
			sessionQueueRef(ctx),
			segment,
		);
	}
	return row.kind === "delete"
		? judgeDelete(ctx, segment, row.ref)
		: judgeDestination(ctx, segment, row);
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {string} ref
 * @returns {Refusal | null}
 */
function judgeDelete(ctx, segment, ref) {
	const managed = judgeManaged(ctx, segment, {
		branch: branchNamed(ref),
		forced: false,
		deleted: true,
	});
	if (managed !== undefined) return managed;
	if (isMain(ref))
		return mainRewind(ctx, "deletes `main` on the remote", segment);
	return null;
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {import("./push-dests.js").PushRow} row
 * @returns {Refusal | null}
 */
function judgeDestination(ctx, segment, { ref, forced, bare }) {
	if (forced && ref === "refs/heads/main")
		return mainRewind(ctx, "force-pushes `main`", segment);
	if (ref.startsWith("refs/heads/")) {
		const managed = judgeManaged(ctx, segment, {
			branch: branchNamed(ref),
			forced,
			deleted: false,
		});
		if (managed !== undefined) return managed;
	}
	if (isAllowedDst(ref)) return null;
	const branch = branchNamed(ref);
	if (ref === "refs/heads/main")
		return refuse(
			ctx,
			"This pushes to main, which only the lander moves",
			segment,
		);
	if (bare)
		return refuse(
			ctx,
			`This pushes the branch the tree is on, ${branch}`,
			segment,
		);
	return refuse(
		ctx,
		`This publishes a branch other than main, ${branch}`,
		segment,
	);
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {import("./shell-parse.js").Command} cmd
 * @returns {Refusal | null}
 */
function judgeGh(ctx, spans, { segment, words, leading, cwd }) {
	for (const gh of ghWords(words, spans)) {
		const refusal = judgeGhRun(ctx, spans, gh, { segment, leading, cwd });
		if (refusal) return refusal;
	}
	return null;
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {import("./shell-words.js").GhCall & { wrapperWords: string[] }} gh
 * @param {{ segment: string, leading: string[], cwd: string }} cmd
 * @returns {Refusal | null}
 */
function judgeGhRun(ctx, spans, gh, { segment, leading, cwd }) {
	const repoEnv = carriesVar("GH_REPO", leading, gh.wrapperWords);
	/** @param {string | undefined} w */
	const lit = (w) => literal(w ?? "", spans).text;
	const first = lit(gh.args[0]);
	if (first === "api") return judgeApi(ctx, spans, segment, gh.args.slice(1));
	if (first !== "pr") return null;
	const pr = stepGhFlags(gh.args.slice(1), spans, gh.repo);
	if (!pr) return null;
	const verb = lit(pr.args[0]);
	if (verb === "create" || verb === "new")
		return refuse(ctx, "This opens a pull request", segment);
	if (verb !== "merge") return null;
	return judgeMerge(ctx, spans, {
		segment,
		repo: pr.repo,
		repoEnv,
		cwd,
		args: pr.args.slice(1),
	});
}

const BODY_FLAGS = ["-f", "--raw-field", "-F", "--field", "--input"];

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {string} segment
 * @param {string[]} args
 * @returns {Refusal | null}
 */
function judgeApi(ctx, spans, segment, args) {
	const { endpoint, method, body, mutation } = readApi(args, spans);
	if (endpoint === "graphql")
		return mutation
			? refuse(
					ctx,
					"This opens a pull request through the GraphQL API",
					segment,
				)
			: null;
	if (!PULLS_RE.test(endpoint.replace(/^\//, ""))) return null;
	const verb = method.toUpperCase();
	if (verb === "POST" || (!verb && body))
		return refuse(
			ctx,
			"This opens a pull request through the REST API",
			segment,
		);
	return null;
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 */
function readApi(args, spans) {
	const read = { endpoint: "", method: "", body: false, mutation: false };
	/** @param {string} w */
	const lit = (w) => literal(w, spans).text;
	scanFlags(API_VALUE_FLAGS, args, (kind, name, value) => {
		if (kind === "arg") read.endpoint ||= lit(value);
		else if (kind === "opt" && (name === "-X" || name === "--method"))
			read.method = lit(value);
		else if (kind === "opt" && BODY_FLAGS.includes(name)) {
			read.body = true;
			read.mutation ||= lit(value).includes("createPullRequest");
		}
	});
	return read;
}

/**
 * @typedef {object} Merge
 * @property {string} segment
 * @property {import("./shell-words.js").GhRepo | null} repo
 * @property {boolean} repoEnv
 * @property {string} cwd
 * @property {string[]} args
 */

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {Merge} merge
 * @returns {Refusal | null}
 */
function judgeMerge(ctx, spans, { segment, repo, repoEnv, cwd, args }) {
	let rawSelector = "";
	/** @type {string | null} */
	let mergeRepo = null;
	let disable = false;
	scanFlags(MERGE_VALUE_FLAGS, args, (kind, name, value) => {
		if (kind === "arg") rawSelector ||= value;
		else if (kind === "opt" && (name === "-R" || name === "--repo"))
			mergeRepo = value;
		else if (kind === "flag" && name === "--disable-auto") disable = true;
	});
	if (disable) return null;
	/** @param {string} what */
	const unchecked = (what) => {
		ctx.log(`${what} — merge allowed unchecked`, unmask(segment));
		return null;
	};
	let selector = "";
	if (rawSelector) {
		const sel = literal(rawSelector, spans);
		if (!sel.known) return unchecked("unreadable pr merge selector");
		selector = sel.text;
	}
	if (selector.startsWith("dependabot/")) return dependabotMerge(ctx, segment);
	const view = ["pr", "view", ...(selector ? [selector] : [])];
	const r =
		mergeRepo === null ? repo : valueAfter(literal(mergeRepo, spans), "");
	if (r) {
		if (!r.known) return unchecked("unreadable pr merge repo");
		view.push("-R", r.text);
	} else if (repoEnv) return unchecked("pr merge under a GH_REPO override");
	if (!cwd) return unchecked("pr merge in an unknown directory");
	const found = ctx.ghLookup(cwd, [
		...view,
		"--json",
		"headRefName,author",
		"--jq",
		DEPENDABOT_JQ,
	]);
	if (found === null) return unchecked("pr merge's PR could not be looked up");
	return trimEndRun(found, "\n") === "true"
		? dependabotMerge(ctx, segment)
		: null;
}

module.exports = { field: "command", noun: "command", decide };
