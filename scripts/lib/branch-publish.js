/*
 * branch-publish.js — the dispatcher core that keeps work landing on `main`
 * directly — no branch on the remote, and never a pull request (#764) — and
 * that never merges a Dependabot PR (mantahostels#3351). One core, because
 * both limbs read the same `gh pr` walk. Its production port, the `gh pr view`
 * lookup, is lib/branch-publish-host.js; git reads go through `ctx.git`.
 *
 * DENY, not warn (mantahostels#103): a push's destination ref, a `gh pr
 * create` and a merge of a PR whose author is Dependabot are structured facts,
 * and none has a legitimate use under its rule.
 *
 * WHAT IS DENIED
 *  - `gh pr create` / `gh pr new`, wherever `-R` points.
 *  - `gh api` creating a pull request: a POST to `repos/<o>/<r>/pulls` —
 *    explicit `-X POST`, or no method and a field or `--input`, which gh sends
 *    as POST — or a `graphql` call whose fields carry `createPullRequest`.
 *  - `git push` whose destination is a branch other than `main` or `spike/*`,
 *    each destination read by lib/push-dests.js. `--all`, `--branches` and
 *    `--mirror` are denied outright.
 *  - A FORCED push or a deletion whose destination is `main` (#1733): `-f`,
 *    `--force`, `--force-with-lease` or a `+` refspec, and `--delete main` or
 *    `:main` — `heads/main` and git's abbreviations of the two long flags
 *    read the same. It prints docs/agents/rules/main-rewind.txt, framed by
 *    lib/main-rewind.js.
 *  - `gh pr merge` of a Dependabot PR (#2020): a `dependabot/` branch named on
 *    the command, or a PR whose head branch or author `gh pr view` reads as
 *    Dependabot's.
 *
 * WHAT PASSES: a destination of `main` or under `spike/` — the #174 precedent,
 *   a data branch kept off `main` on purpose — or outside `refs/heads/` (a
 *   tag, a note); `--tags` with no refspec; any deletion but `main`'s; a
 *   detached HEAD's bare push, which git itself refuses; `--help`,
 *   `--dry-run`.
 *
 * WITH THE `landing` MODULE ON (#2409, spec #2261), sessions push to `landing`
 *   and only the lander moves `main`: a push to `main` is denied, `landing`
 *   passes in its place, and a forced push or a deletion of `landing` is
 *   denied as one of `main` is.
 *
 * THE FIRST REFUSAL WINS, as the bash guard's exit on its first deny did: the
 * push walk runs before the gh walk, and once a refusal stands no later
 * segment is judged, looked up or recorded.
 *
 * LIMITS
 *  - A bare `git push` is judged by the current branch (lib/push-dests.js). A
 *    `remote.<name>.push` refspec or push.default=matching pushes something
 *    else, unseen — and a `+` refspec there forces it.
 *  - It walks every working tree of THIS repo, a linked worktree included
 *    (walkGit's "repo" scope). A push in another repo is not judged; a `gh pr
 *    create` is, whatever repo it targets — a session wanting one elsewhere
 *    runs it outside Claude Code.
 *  - A push whose tree it cannot resolve (`git -C "$W"`, W unset) FAILS OPEN,
 *    recorded by the walker (mantahostels#147). A `graphql` query it cannot
 *    read back (`$(cat q)`, a `@file` field) is allowed unrecorded: nothing
 *    says it creates anything. A refspec it cannot read (`git push origin
 *    "$B"`) is allowed and recorded: Bash calls share no shell state, so the
 *    name is unknowable here.
 *  - A `gh pr merge` naming no `dependabot/` branch costs one `gh pr view`,
 *    under the host's 8 s timeout: 0.95–1.45 s over five measured calls.
 *    Where the lookup fails — or cannot be aimed: an unreadable PR or repo
 *    word, a `GH_REPO` override, an unknown directory — the merge is allowed
 *    and recorded. The lookup runs
 *    in the segment's own directory (walkCommands' cwd). A merge through `gh
 *    api` is not read. Adopters get the limb too (#2020).
 *  - Only a segment's own command word is read, after shell-words.js's unwrap
 *    wrappers (`env`, `timeout`, `command`, …), a push included (#1731). A
 *    wrapper's own `-C DIR` is swept, so `env -C /x git push` is judged
 *    against the cwd. `sh -c "…"`, a script, the GitHub web UI and the
 *    founder's terminal are not seen, and Dependabot's PRs are opened by
 *    GitHub itself (docs/agents/dependabot.md governs those).
 *
 * The rules it prints are docs/agents/rules/branch-publish.txt, main-rewind.txt
 * and dependabot-merge.txt, and with `landing` on branch-publish-landing.txt in
 * place of the first and landing-rewind.txt. A refusal whose fragment cannot
 * be read still refuses, naming the file (mantahostels#1648's store rule), and
 * logs nothing: an unreadable fragment is check-guard-registry.js's assertion.
 */

const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { rewindReason } = require("./main-rewind.js");
const { readPush } = require("./push-dests.js");
const {
	parseCommand,
	unmask,
	walkCommands,
	walkGit,
} = require("./shell-parse.js");
const { carriesVar, ghWords, literal, scanFlags } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} BranchPublishPorts
 * @property {(cwd: string, args: string[]) => string | null}
 *   ghLookup `gh args…` run in `cwd`: its stdout, or null where it could not
 *   run, timed out or exited non-zero
 * @typedef {import("./guard-dispatch.js").CoreContext & BranchPublishPorts}
 *   BranchPublishContext
 * @typedef {{ reason: string, segment: string }} Refusal the reason before the
 *   splice, and the segment, masked
 */

/** `gh pr merge`'s value-taking flags, from `gh pr merge --help` on gh 2.95.0. */
const MERGE_VALUE_FLAGS =
	"-b --body -F --body-file -t --subject -A --author-email --match-head-commit -R --repo";

/** `gh api`'s value-taking flags, from `gh api --help` on gh 2.95.0. */
const API_VALUE_FLAGS =
	"-X --method -f --raw-field -F --field -H --header --input -q --jq -t --template --cache --hostname -p --preview";

/** `gh pr view`'s verdict on whether the PR is Dependabot's. */
const DEPENDABOT_JQ =
	'(.headRefName | startswith("dependabot/")) or (.author.login | test("^(app/)?dependabot(\\\\[bot\\\\])?$"))';

const PULLS_RE = /^repos\/[^/]+\/[^/]+\/pulls\/?(\?.*)?$/;

/* Each id spelt whole at its own call, so the registry's emitter scan reads
 * it. */

/** @param {BranchPublishContext} ctx */
const publishRule = (ctx) =>
	ctx.moduleOn("landing")
		? ruleOrFallback(
				ctx,
				"branch-publish-landing",
				"Work lands through `landing` — never a push to `main`, no other branch on the remote, and never a pull request",
			)
		: ruleOrFallback(
				ctx,
				"branch-publish",
				"Work lands on `main` directly — no branch on the remote, and never a pull request",
			);

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what the refusal's opening, "This …"
 * @param {string} segment
 * @returns {Refusal}
 */
const refuse = (ctx, what, segment) => ({
	reason: `${what}: @CMD@\n\n${publishRule(ctx)}`,
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what completing "This …"
 * @param {string} segment
 * @returns {Refusal}
 */
const mainRewind = (ctx, what, segment) => ({
	reason: rewindReason(ctx, what),
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string} what completing "This …"
 * @param {string} segment
 * @returns {Refusal}
 */
const landingRewind = (ctx, what, segment) => ({
	reason: `This ${what}: @CMD@\n\n${ruleOrFallback(ctx, "landing-rewind", "Never force-push or delete `landing`")}`,
	segment,
});

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @returns {Refusal}
 */
const dependabotMerge = (ctx, segment) => ({
	reason: `This merges a Dependabot pull request: @CMD@\n\n${ruleOrFallback(ctx, "dependabot-merge", "Never merge a Dependabot pull request — take its fix locally and commit it direct to `main`")}`,
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
	/* What a walk would record after the refusal is a command never run. */
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

// ── THE PUSH ─────────────────────────────────────────────────────────────

/** @param {string} ref as written */
const isMain = (ref) =>
	ref === "main" || ref === "heads/main" || ref === "refs/heads/main";

/** @param {string} ref as written */
const isLanding = (ref) =>
	ref === "landing" || ref === "heads/landing" || ref === "refs/heads/landing";

/**
 * Whether publishing `ref`, a full ref, is allowed.
 * @param {string} ref
 * @param {BranchPublishContext} ctx
 */
function isAllowedDst(ref, ctx) {
	if (ref.startsWith("refs/heads/spike/")) return true;
	if (ref === "refs/heads/main") return !ctx.moduleOn("landing");
	if (ref === "refs/heads/landing") return ctx.moduleOn("landing");
	return !ref.startsWith("refs/heads/");
}

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
 * One destination's refusal, or null where it passes.
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {import("./push-dests.js").PushRow} row
 * @returns {Refusal | null}
 */
function judgeRow(ctx, segment, row) {
	if (row.kind === "unread-delete" || row.kind === "unread-push") {
		const what = row.kind === "unread-delete" ? "deletion" : "refspec";
		ctx.log(
			`unreadable push ${what} — push allowed unchecked`,
			unmask(segment),
		);
		return null;
	}
	return row.kind === "delete"
		? judgeDelete(ctx, segment, row.ref)
		: judgeDestination(ctx, segment, row);
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {string} ref the deleted ref as written
 * @returns {Refusal | null}
 */
function judgeDelete(ctx, segment, ref) {
	if (isMain(ref))
		return mainRewind(ctx, "deletes `main` on the remote", segment);
	if (isLanding(ref) && ctx.moduleOn("landing"))
		return landingRewind(ctx, "deletes `landing` on the remote", segment);
	return null;
}

/**
 * @param {BranchPublishContext} ctx
 * @param {string} segment
 * @param {import("./push-dests.js").PushRow} row a push
 * @returns {Refusal | null}
 */
function judgeDestination(ctx, segment, { ref, forced, bare }) {
	if (forced && ref === "refs/heads/main")
		return mainRewind(ctx, "force-pushes `main`", segment);
	if (forced && ref === "refs/heads/landing" && ctx.moduleOn("landing"))
		return landingRewind(ctx, "force-pushes `landing`", segment);
	if (isAllowedDst(ref, ctx)) return null;
	const branch = ref.slice("refs/heads/".length);
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

// ── GH ───────────────────────────────────────────────────────────────────

/**
 * `${w#prefix}`: `w` with `prefix` off its front where it stands there. The
 * test is on the literal, the cut on the raw word, as the bash guard cut.
 * @param {string} w
 * @param {string} prefix
 */
const cut = (w, prefix) => (w.startsWith(prefix) ? w.slice(prefix.length) : w);

/**
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {import("./shell-parse.js").Command} cmd
 * @returns {Refusal | null}
 */
function judgeGh(ctx, spans, { segment, words, leading, cwd }) {
	const repoEnv = carriesVar("GH_REPO", leading, words, spans);
	const gh = ghWords(words, spans);
	if (!gh) return null;
	/* The word as the shell would pass it, so a quoted `"create"` still reads
	 * as `create`; an expansion it cannot read stays masked and matches
	 * nothing. */
	/** @param {string | undefined} w */
	const lit = (w) => literal(w ?? "", spans).text;
	const first = lit(gh.args[0]);
	if (first === "api") return judgeApi(ctx, spans, segment, gh.args.slice(1));
	if (first !== "pr") return null;
	const pr = stepPrFlags(gh.args.slice(1), gh.repo, lit);
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

/**
 * The flags between `pr` and its verb stepped over, keeping a `-R`/`--repo`
 * value, raw; null where `-R` has none left.
 * @param {string[]} words the words after `pr`
 * @param {string} repo the `-R` before `pr`, raw, or ""
 * @param {(w: string | undefined) => string} lit
 * @returns {{ args: string[], repo: string } | null}
 */
function stepPrFlags(words, repo, lit) {
	let args = words;
	let r = repo;
	for (let f = lit(args[0]); f.startsWith("-"); f = lit(args[0])) {
		const raw = args[0] ?? "";
		let step = 1;
		if (f === "-R" || f === "--repo") {
			if (args.length < 2) return null;
			r = args[1] ?? "";
			step = 2;
		} else if (f.startsWith("--repo=")) r = cut(raw, "--repo=");
		else if (f.startsWith("-R")) r = cut(raw, "-R");
		args = args.slice(step);
	}
	return { args, repo: r };
}

/** The `gh api` flags that carry a request body. */
const BODY_FLAGS = ["-f", "--raw-field", "-F", "--field", "--input"];

/**
 * A `gh api` call that opens a pull request.
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {string} segment
 * @param {string[]} args the words after `api`
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
	if (!PULLS_RE.test(cut(endpoint, "/"))) return null;
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
 * A `gh api` call's endpoint and method, read through literal, whether it
 * carries a body, and whether a field names `createPullRequest`.
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
 * @property {string} repo the `-R` word before `merge`, raw, or ""
 * @property {boolean} repoEnv the command carries GH_REPO
 * @property {string} cwd where the command runs; "" where the walk cannot know
 * @property {string[]} args the words after `merge`
 */

/**
 * A `gh pr merge` of a Dependabot PR: named by its branch, else read through
 * one `gh pr view`. Anything that stops the lookup allows, recorded.
 * @param {BranchPublishContext} ctx
 * @param {string[]} spans
 * @param {Merge} merge
 * @returns {Refusal | null}
 */
function judgeMerge(ctx, spans, { segment, repo, repoEnv, cwd, args }) {
	let rawSelector = "";
	let mergeRepo = "";
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
	const rawRepo = mergeRepo || repo;
	if (rawRepo) {
		const r = literal(rawRepo, spans);
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
