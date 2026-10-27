/*
 * pull-form-host.js — the production ports guard-pull-form.js wires into its
 * core, lib/pull-form.js (#2797). Every git read carries the hook's git
 * timeout, and a timed-out or erroring read answers "" or false, as the
 * bash guard's `|| x=""` did.
 */

const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { readTopLevel } = require("./git-tree.js");
const { pushedRef } = require("./landing-refs.js");

/**
 * git's stdout in `dir`, trailing newlines off as a command substitution
 * takes them; "" where git errors.
 * @param {string} dir
 * @param {string[]} args
 */
const read = (dir, args) =>
	(
		gitOrNull(["-C", dir, ...args], { timeout: HOOK_GIT_TIMEOUT_MS }) ?? ""
	).replace(/\n+$/, "");

/**
 * Whether git answers in `dir` without error.
 * @param {string} dir
 * @param {string[]} args
 */
const isAnswered = (dir, args) =>
	gitOrNull(["-C", dir, ...args], { timeout: HOOK_GIT_TIMEOUT_MS }) !== null;

/**
 * @param {import("./guard-entry.js").PortEnv} env
 * @returns {import("./pull-form.js").PullFormPorts}
 */
const buildHostPorts = ({ root }) => ({
	pullFf: (dir) => read(dir, ["config", "--get", "pull.ff"]),
	cleanRequireForce: (dir) =>
		read(dir, ["config", "--type=bool", "--get", "clean.requireForce"]),
	currentBranch: (dir) =>
		read(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	isCommit: (dir, word) =>
		isAnswered(dir, ["rev-parse", "--verify", "--quiet", `${word}^{commit}`]),
	isTree: (dir, word) =>
		isAnswered(dir, ["rev-parse", "--verify", "--quiet", `${word}^{tree}`]),
	topLevel: (dir) => readTopLevel(dir) ?? "",
	showPrefix: (dir) => read(dir, ["rev-parse", "--show-prefix"]),
	/* In process, not a landing-refs.js spawn: one node start spared a
	 * refusal. */
	pushedRef: () => pushedRef({ root }),
});

module.exports = { buildHostPorts };
