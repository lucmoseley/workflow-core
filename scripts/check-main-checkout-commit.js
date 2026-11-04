#!/usr/bin/env node
/*
 * check-main-checkout-commit.js — refuses a commit made in the main checkout
 * once it is cut over to the worktree model (#4248, spec #4229): every
 * session commits in its own worktree, and the main checkout's `main` moves by
 * the levelling step's fast-forward alone, which makes no commit.
 *
 * Usage:
 *   node check-main-checkout-commit.js [--json] [--warn]
 *
 * Passes in a linked worktree, with the `landing` module off, and in a main
 * checkout not yet cut over (lib/cutover.js), where the shared-tree model's
 * own limb in .husky/pre-commit still holds it on `main`.
 *
 * IMPLICIT:  on every commit in a cut-over main checkout, refuses it.
 * JUSTIFIED: fail-safe — a commit there is a local commit the fast-forward cannot keep, and the PreToolUse refusal sees only Claude Code's own calls.
 * DEFEAT:    WFC_ALLOW_BRANCH=1, the founder's to set from their own terminal, never an agent's (#916).
 */

const { runCheck } = require("./lib/check.js");
const { isCutOver } = require("./lib/cutover.js");
const { gitDirs } = require("./lib/git.js");
const { checkoutOfCommonDir } = require("./lib/main-checkout.js");
const { scriptPath } = require("./lib/script-path.js");
const { moduleOn } = require("./lib/workflow-core-config.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

/** @param {Ctx} ctx */
function run(ctx) {
	const dirs = gitDirs(process.cwd());
	if (dirs === null) ctx.broken("git cannot name this tree's git dirs");
	if (dirs.gitDir !== dirs.common)
		return { okLine: "a linked worktree, which takes its session's commits" };
	const top = checkoutOfCommonDir(dirs.common);
	if (top === null)
		return { okLine: "no checkout of its own: nothing to hold" };
	if (!moduleOn("landing", { root: top }))
		return {
			okLine:
				"the `landing` module is off: the main checkout is the shared tree",
		};
	if (!isCutOver(top))
		return { okLine: "the main checkout is not yet cut over" };
	if (process.env.WFC_ALLOW_BRANCH)
		return { okLine: "WFC_ALLOW_BRANCH is set: the founder's commit" };
	ctx.fail("MAIN-CHECKOUT-COMMIT", `a commit in the main checkout ${top}`);
	ctx.say(
		`This commit is in the main checkout, ${top}, which takes no commits.`,
	);
	ctx.say(
		"  Its main follows origin/main by the levelling step's fast-forward alone, and a local commit is one that fast-forward cannot keep (#4229).",
	);
	ctx.say(
		`  Commit in your session's worktree under .claude/worktrees/; \`node ${scriptPath("session-checkout.js")} cut <session-name>\` cuts one and prints its path.`,
	);
	ctx.say(
		"  Deliberate? The escape is the founder's to set, never an agent's (#916): an agent stops and asks.",
	);
	return { noun: "commit(s) in the main checkout", count: 1 };
}

if (require.main === module) {
	runCheck({
		name: "main-checkout-commit",
		usage: "node check-main-checkout-commit.js [--json] [--warn]",
		run,
	});
}
