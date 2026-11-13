/*
 * commit-route.js — which git operation made the commit a hook is asked
 * about: its commit route (GLOSSARY.md), for Node callers. The one copy for
 * them; scripts/lib/commit-route.sh is the shell callers' copy, and
 * lib/commit-route.test.ts holds the two to the same answer on every row of
 * that file's marker table. Change the two together.
 *
 * The marker table, the order its checks run in and why, and the leftover
 * `sequencer` (#3298), are commit-route.sh's header.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");

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
 * The markers read first, in commit-route.sh's order, each with its route.
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
 * Whether `sequencer` is a live sequence, as commit-route.sh's
 * wfc_cr_sequencing reads it.
 * @param {string} hook
 * @param {string} dir
 */
function sequencing(hook, dir) {
	if (!fs.existsSync(path.join(dir, "sequencer"))) return false;
	let safety;
	try {
		safety = stripNewlines(
			fs.readFileSync(path.join(dir, "sequencer", "abort-safety"), "utf8"),
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

/**
 * `text` less its trailing newlines, as a shell's `$(cat …)` reads it.
 * @param {string} text
 */
function stripNewlines(text) {
	let end = text.length;
	while (end > 0 && text[end - 1] === "\n") end--;
	return text.slice(0, end);
}

/**
 * The routes that replay commits already made and reach no pre-commit.
 * @param {string} route
 */
const commitRouteReplays = (route) =>
	["rebase", "rebase-apply", "am", "cherry-pick"].includes(route);

module.exports = { commitRoute, commitRouteReplays };
