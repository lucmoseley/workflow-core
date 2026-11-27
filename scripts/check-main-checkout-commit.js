#!/usr/bin/env node

const { runCheck } = require("./lib/check.js");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { buildCutCommand, isCutOver } = require("./lib/cutover.js");
const { gitDirs } = require("./lib/git.js");
const { checkoutOfCommonDir } = require("./lib/main-checkout.js");
const { WORKTREES } = require("./lib/worktree-dirs.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @param {Ctx} ctx */
function run(ctx) {
	const dirs = gitDirs(process.cwd());
	if (dirs === null) ctx.broken("git cannot name this tree's git dirs");
	if (dirs.gitDir !== dirs.common)
		return { okLine: "a linked worktree, which takes its session's commits" };
	const top = checkoutOfCommonDir(dirs.common);
	if (top === null)
		return { okLine: "no checkout of its own: nothing to hold" };
	if (!isCutOver(top))
		return { okLine: "the main checkout is not yet cut over" };
	if (readCommitOrBroken("HEAD", top) === null)
		return { okLine: "HEAD is unborn: this commit starts main" };
	if (process.env.WFC_ALLOW_BRANCH)
		return { okLine: "WFC_ALLOW_BRANCH is set: the founder's commit" };
	ctx.fail("MAIN-CHECKOUT-COMMIT", `a commit in the main checkout ${top}`);
	ctx.say(
		`This commit is in the main checkout, ${top}, which takes no commits.`,
	);
	ctx.say(
		"  Its main follows origin/main by the levelling step's fast-forward alone, and a local commit is one that fast-forward cannot keep (workflow-core#4229).",
	);
	ctx.say(
		`  Commit in your session's worktree under ${WORKTREES}/; ${buildCutCommand()} cuts one and prints its path.`,
	);
	ctx.say(
		"  Deliberate? The escape is the founder's to set, never an agent's (workflow-core#916): an agent stops and asks.",
	);
	return { noun: "commit(s) in the main checkout", count: 1 };
}

const SPEC = {
	name: "main-checkout-commit",
	usage: "node check-main-checkout-commit.js [--json] [--warn]",
	run,
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
