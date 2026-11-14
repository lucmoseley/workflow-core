/*
 * commit-route.js — which git operation made the commit a hook is asked
 * about: its commit route (GLOSSARY.md), for Node callers.
 * scripts/lib/commit-route.sh is the shell callers' copy, and
 * lib/commit-route.test.ts holds the two to the same answer on every row of
 * the marker table below and every route's replay answer, abort and name.
 * Change the two together.
 *
 * THE MARKER TABLE: what each hook sees in $GIT_DIR per route, measured on git
 * 2.43.0 (#1503). A hook missing from a row
 * does not fire on that route. `--no-verify` skips pre-commit, commit-msg and
 * pre-merge-commit, never prepare-commit-msg (mantahostels#1705).
 *
 *   commit           nothing, at pre-commit, prepare-commit-msg, commit-msg and
 *                    post-commit
 *   single revert    AUTO_MERGE and MERGE_MSG at prepare-commit-msg and
 *                    post-commit; a killed merge can strand both, so this reads
 *                    as `commit`
 *   merge            pre-merge-commit: AUTO_MERGE and GIT_REFLOG_ACTION
 *                    (`merge …`, or `pull …` from a pull), no MERGE_HEAD yet;
 *                    prepare-commit-msg and commit-msg: MERGE_HEAD; no
 *                    post-commit. The `git commit` resolving a conflicted merge:
 *                    MERGE_HEAD at pre-commit through commit-msg, nothing at
 *                    post-commit
 *   cherry-pick      CHERRY_PICK_HEAD at prepare-commit-msg and post-commit, plus
 *                    `sequencer` on a range; no pre-commit. `--continue`:
 *                    CHERRY_PICK_HEAD at pre-commit through commit-msg, nothing
 *                    at post-commit
 *   revert-sequence  `git revert A B`: `sequencer` at prepare-commit-msg and
 *                    post-commit, its `abort-safety` naming the commit this one
 *                    is made on, and at post-commit a `revert:` HEAD reflog
 *                    entry; no pre-commit
 *   revert-continue  REVERT_HEAD at pre-commit through commit-msg, nothing at
 *                    post-commit
 *   rebase           a replay: rebase-merge and CHERRY_PICK_HEAD at
 *                    prepare-commit-msg and post-commit; no pre-commit.
 *                    `--continue`: rebase-merge alone at the same two. A reword,
 *                    or a `git commit` by hand mid-rebase: rebase-merge at
 *                    pre-commit through post-commit
 *   rebase-apply     `git rebase --apply`: rebase-apply/rebasing at
 *                    applypatch-msg, pre-applypatch and post-applypatch only
 *   am               `git am`: rebase-apply/applying at the same three only
 *   bisect           a commit by hand mid-bisect: BISECT_LOG at all four commit
 *                    hooks
 *
 * So the order matters: rebase-merge before CHERRY_PICK_HEAD, which a rebase
 * replay sets too; CHERRY_PICK_HEAD and REVERT_HEAD before `sequencer`, which a
 * range of either sets; and MERGE_HEAD before `sequencer`, which a cherry-pick
 * range stopped on a conflict and finished by a plain `git commit` leaves behind,
 * so that a later merge still reads as one.
 *
 * A LEFTOVER `sequencer` IS NOT A SEQUENCE (#3298): a stopped range finished by
 * hand leaves one until `git revert --quit`. A single pick or revert over it
 * rewrites its `abort-safety` as a sequence's own step does, so post-commit
 * also asks the HEAD reflog (sequencing, below). The hooks before it, with no
 * reflog entry yet, read a commit right after such a pick as `revert-sequence`;
 * none of them acts on that route.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");
const { trimEndRun } = require("./trim-run.js");

const HOOKS_WITH_ROWS = new Set([
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
]);

const APPLY_HOOKS = new Set([
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
]);

/**
 * The markers read first, in the table's order, each with its route.
 * @type {[string, string][]}
 */
const MARKER_ROUTES = [
	["rebase-merge", "rebase"],
	["rebase-apply/rebasing", "rebase-apply"],
	["rebase-apply", "am"],
	["CHERRY_PICK_HEAD", "cherry-pick"],
	["REVERT_HEAD", "revert-continue"],
	["MERGE_HEAD", "merge"],
];

/**
 * @typedef {object} RouteEnv
 * @property {string} [GIT_REFLOG_ACTION]
 */

/**
 * The route of the commit `hook` is asked about, reading `gitDir`'s markers.
 * An empty `gitDir` reads as no marker at all. Throws on a hook with no row
 * in the marker table, as the shell copy exits 2.
 * @param {string} hook
 * @param {string} gitDir
 * @param {{ env?: RouteEnv }} [opts]
 * @returns {string}
 */
function commitRoute(hook, gitDir, { env = process.env } = {}) {
	const dir = gitDir || "/nonexistent";
	const has = (/** @type {string} */ rel) => fs.existsSync(path.join(dir, rel));
	if (APPLY_HOOKS.has(hook))
		return has("rebase-apply/rebasing") ? "rebase-apply" : "am";
	if (hook === "pre-merge-commit") return "merge";
	if (!HOOKS_WITH_ROWS.has(hook))
		throw new Error(`commit-route.js: no marker table for the hook '${hook}'`);
	const marked = MARKER_ROUTES.find(([rel]) => has(rel));
	if (marked) return marked[1];
	if (hook === "pre-commit" && merging(env)) return "merge";
	if (sequencing(hook, dir)) return "revert-sequence";
	return has("BISECT_LOG") ? "bisect" : "commit";
}

/** @param {RouteEnv} env */
const merging = (env) => /^(merge|pull)/.test(env.GIT_REFLOG_ACTION ?? "");

/**
 * Whether `sequencer` is a live sequence: its `abort-safety` names the
 * commit this one is made on, HEAD before post-commit; at post-commit HEAD's
 * parent, with HEAD's last reflog entry the sequence's own. No
 * `abort-safety` or reflog, or a git that would not answer, reads as a
 * leftover.
 * @param {string} hook
 * @param {string} dir
 */
function sequencing(hook, dir) {
	if (!fs.existsSync(path.join(dir, "sequencer"))) return false;
	let safety;
	try {
		safety = trimEndRun(
			fs.readFileSync(path.join(dir, "sequencer", "abort-safety"), "utf8"),
			"\n",
		);
	} catch {
		return false;
	}
	if (safety === "") return false;
	let madeOn = "HEAD";
	if (hook === "post-commit") {
		let last = "";
		try {
			last =
				fs
					.readFileSync(path.join(dir, "logs", "HEAD"), "utf8")
					.replace(/\n$/, "")
					.split("\n")
					.at(-1) ?? "";
		} catch {
			return false;
		}
		if (!/\t(revert|cherry-pick): /.test(last)) return false;
		madeOn = "HEAD^";
	}
	const r = spawnGitSync(
		["--git-dir", dir, "rev-parse", "-q", "--verify", madeOn],
		{ encoding: "utf8" },
	);
	return r.status === 0 && String(r.stdout).trim() === safety;
}

const REPLAY_ROUTES = new Set(["rebase", "rebase-apply", "am", "cherry-pick"]);

/**
 * Whether `route` replays commits already made and reaches no pre-commit:
 * commit-route.sh's wfc_commit_route_replays.
 * @param {string} route
 */
const isReplayRoute = (route) => REPLAY_ROUTES.has(route);

/**
 * The routes post-commit's route-gated steps stand down on: a replay fires it
 * once per replayed commit, a revert sequence likewise, and a bisect checks
 * out commits nobody here wrote (mantahostels#1825, mantahostels#2336, #766).
 */
const STAND_DOWN_ROUTES = new Set([
	...REPLAY_ROUTES,
	"revert-sequence",
	"revert-continue",
	"bisect",
]);

/** The named route sets a hook dispatcher row arms on. */
const ROUTE_SETS = new Map([
	["replay", REPLAY_ROUTES],
	["post-commit-stand-down", STAND_DOWN_ROUTES],
]);

/**
 * Whether `route` is in `name`: a set ROUTE_SETS names, else one route.
 * @param {string} name
 * @param {string} route
 */
const inRouteSet = (name, route) =>
	ROUTE_SETS.get(name)?.has(route) ?? name === route;

const ABORTS = new Map([
	["rebase", "git rebase --abort"],
	["rebase-apply", "git rebase --abort"],
	["am", "git am --abort"],
	["cherry-pick", "git cherry-pick --abort"],
	["revert-sequence", "git revert --abort"],
	["revert-continue", "git revert --abort"],
	["merge", "git merge --abort"],
]);

/**
 * The command that clears `route`'s operation, or "" where there is none.
 * Naming the wrong one strands the tree: `git am --abort` does not clear a
 * rebase.
 * @param {string} route
 */
const routeAbort = (route) => ABORTS.get(route) ?? "";

const NAMES = new Map([
	["rebase", "git rebase"],
	["rebase-apply", "git rebase --apply"],
	["am", "git am"],
	["cherry-pick", "git cherry-pick"],
	["revert-sequence", "git revert"],
	["revert-continue", "git revert"],
	["merge", "git merge"],
]);

/**
 * `route`'s operation as a reader typed it.
 * @param {string} route
 */
const routeName = (route) => NAMES.get(route) ?? "commit";

module.exports = {
	commitRoute,
	inRouteSet,
	isReplayRoute,
	ROUTE_SETS,
	routeAbort,
	routeName,
};
