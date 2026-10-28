/*
 * pull-form-host.js — the production ports the dispatcher wires into the
 * guard-pull-form core, lib/pull-form.js (#2797, #3226). Every git read carries the hook's git
 * timeout, and a timed-out or erroring read answers "" or false, as the
 * bash guard's `|| x=""` did.
 */

const { readCommit } = require("./commit-sha.js");
const { gitOrNull, gitReader, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { readTopLevel } = require("./git-tree.js");
const { pushedRef } = require("./landing-refs.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * git's stdout in `dir`, trailing newlines off as a command substitution
 * takes them; "" where git errors.
 * @param {string} dir
 * @param {string[]} args
 */
const read = (dir, args) =>
	trimEndRun(
		gitOrNull(["-C", dir, ...args], { timeout: HOOK_GIT_TIMEOUT_MS }) ?? "",
		"\n",
	);

/**
 * Whether git answers in `dir` without error.
 * @param {string} dir
 * @param {string[]} args
 */
const isAnswered = (dir, args) =>
	gitOrNull(["-C", dir, ...args], { timeout: HOOK_GIT_TIMEOUT_MS }) !== null;

/**
 * @param {string} root
 * @returns {import("./pull-form.js").PullFormPorts}
 */
const buildHostPorts = (root) => ({
	pullFf: (dir) => read(dir, ["config", "--get", "pull.ff"]),
	cleanRequireForce: (dir) =>
		read(dir, ["config", "--type=bool", "--get", "clean.requireForce"]),
	currentBranch: (dir) =>
		read(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	isCommit: (dir, word) => {
		const r = readCommit(gitReader(dir, HOOK_GIT_TIMEOUT_MS), word);
		return r.ok && r.sha !== null;
	},
	isTree: (dir, word) =>
		isAnswered(dir, ["rev-parse", "--verify", "--quiet", `${word}^{tree}`]),
	topLevel: (dir) => readTopLevel(dir) ?? "",
	showPrefix: (dir) => read(dir, ["rev-parse", "--show-prefix"]),
	/* In process, not a landing-refs.js spawn: one node start spared a
	 * refusal. */
	pushedRef: () => pushedRef({ root }),
});

module.exports = { buildHostPorts };
