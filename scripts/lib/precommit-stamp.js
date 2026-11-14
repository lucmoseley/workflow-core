/*
 * precommit-stamp.js — the stamp .husky/pre-commit writes at its foot on its
 * own exit 0: `git write-tree`'s answer, in the git directory, so
 * .husky/prepare-commit-msg stands down on the index it already gated
 * rather than running the whole stack twice (mantahostels#1705).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * The stamp's path in `gitDir`.
 * @param {string} gitDir
 */
const precommitStamp = (gitDir) => path.join(gitDir, "wfc-precommit-stamp");

/**
 * The tree the stamp in `gitDir` records, its trailing newlines dropped, ""
 * where there is none, it will not read or `gitDir` is "". CONSUMED ON READ:
 * the stamp is deleted, so one that outlived its commit — an editor abort,
 * a refusal further down the hook chain — stands down no later commit
 * sharing its tree.
 * @param {string} gitDir
 * @returns {string}
 */
function takePrecommitStamp(gitDir) {
	if (!gitDir) return "";
	const stamp = precommitStamp(gitDir);
	const read = readText(stamp);
	if (read.state === "absent") return "";
	fs.rmSync(stamp, { force: true });
	return read.state === "read" ? trimEndRun(read.data, "\n") : "";
}

module.exports = { precommitStamp, takePrecommitStamp };
