/*
 * pull-form-host.js — the production ports the dispatcher wires into the
 * guard-pull-form core, lib/pull-form.js (#2797, #3226). Every git read carries the hook's git
 * timeout, and a timed-out or erroring read answers "" or false, as the
 * bash guard's `|| x=""` did.
 */

const { readCommit } = require("./commit-sha.js");
const {
	gitCommonDir,
	gitOrNull,
	gitReader,
	HOOK_GIT_TIMEOUT_MS,
} = require("./git.js");
const { parseFileAliases } = require("./git-alias.js");
const { readMainState } = require("./main-ref.js");
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
 * @param {string} root
 * @returns {import("./pull-form.js").PullFormPorts}
 */
const buildHostPorts = (root) => ({
	pullFf: (dir) => read(dir, ["config", "--get", "pull.ff"]),
	currentBranch: (dir) =>
		read(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	isCommit: (dir, word) => {
		const r = readCommit(gitReader(dir, HOOK_GIT_TIMEOUT_MS), word);
		return r.ok && r.sha !== null;
	},
	readFileAliases: (dir) => {
		/* Exit 1 is no alias at all; anything else is git not saying. */
		const r = gitReader(dir, HOOK_GIT_TIMEOUT_MS)(
			["config", "-z", "--get-regexp", "^alias\\."],
			[1],
		);
		return r.ok ? parseFileAliases(r.out) : null;
	},
	isMainUnreadable: () => {
		const commonDir = gitCommonDir(root, { timeout: HOOK_GIT_TIMEOUT_MS });
		return (
			commonDir !== null &&
			readMainState(commonDir, HOOK_GIT_TIMEOUT_MS) === "unreadable"
		);
	},
});

module.exports = { buildHostPorts };
