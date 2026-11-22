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

/** @type {[string, string][]} */
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

/** @param {string} route */
const isReplayRoute = (route) => REPLAY_ROUTES.has(route);

const STAND_DOWN_ROUTES = new Set([
	...REPLAY_ROUTES,
	"revert-sequence",
	"revert-continue",
	"bisect",
]);

const ROUTE_SETS = new Map([
	["replay", REPLAY_ROUTES],
	["post-commit-stand-down", STAND_DOWN_ROUTES],
]);

const ROUTES = new Set([
	...MARKER_ROUTES.map(([, route]) => route),
	"revert-sequence",
	"bisect",
	"commit",
]);

/** @param {string} name */
function checkRouteSetName(name) {
	if (!ROUTE_SETS.has(name) && !ROUTES.has(name))
		throw new Error(`commit-route.js: '${name}' names no route or route set`);
}

/**
 * @param {string} name
 * @param {string} route
 */
function inRouteSet(name, route) {
	checkRouteSetName(name);
	return ROUTE_SETS.get(name)?.has(route) ?? name === route;
}

const ABORTS = new Map([
	["rebase", "git rebase --abort"],
	["rebase-apply", "git rebase --abort"],
	["am", "git am --abort"],
	["cherry-pick", "git cherry-pick --abort"],
	["revert-sequence", "git revert --abort"],
	["revert-continue", "git revert --abort"],
	["merge", "git merge --abort"],
]);

/** @param {string} route */
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

/** @param {string} route */
const routeName = (route) => NAMES.get(route) ?? "commit";

/**
 * @param {string} hook
 * @param {string} route
 */
function scanRefusal(hook, route) {
	const name = routeName(route);
	return (
		`${hook}: the secrets scan did not pass on this ${name} (mantahostels#1706).\n` +
		"  Its own output is above — a finding, or gitleaks itself is missing.\n" +
		`  The ${name} is left IN PROGRESS. Clear it with:  ${routeAbort(route)}\n`
	);
}

module.exports = {
	checkRouteSetName,
	commitRoute,
	inRouteSet,
	isReplayRoute,
	routeAbort,
	routeName,
	scanRefusal,
};
