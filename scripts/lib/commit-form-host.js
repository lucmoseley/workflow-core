/*
 * commit-form-host.js — the production ports the dispatcher wires into the
 * guard-commit-form core, lib/commit-form.js (#2793, #3224). Every git read carries the hook's
 * git timeout, and a timed-out read answers as an erroring one.
 */

const fs = require("node:fs");
const { readCommitCheck } = require("./commit-check.js");
const { closingRefusal } = require("./closing-keyword.js");
const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { patchFiles, readTopLevel } = require("./git-tree.js");

/* git's empty tree, the base of a diff before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * @param {string[]} args
 * @returns {string | null}
 */
const git = (args) => gitOrNull(args, { timeout: HOOK_GIT_TIMEOUT_MS });

/**
 * git's stdout as lines, or null where git errors. core.quotePath=false, so
 * a non-ASCII path comes out raw, as the ledger holds it.
 * @param {string} dir
 * @param {string[]} args
 */
function lines(dir, args) {
	const out = git(["-C", dir, "-c", "core.quotePath=false", ...args]);
	if (out === null) return null;
	return out.split("\n").filter((l) => l !== "");
}

/** @type {Record<import("./commit-form.js").LsMode, string[]>} */
const LS_MODE = {
	cached: ["--cached"],
	others: ["--others"],
	"others-standard": ["--others", "--exclude-standard"],
};

/**
 * @param {string} root
 * @returns {import("./commit-form.js").CommitFormPorts}
 */
function buildHostPorts(root) {
	return {
		root,
		midSequence: (dir) => {
			const gitdir = git([
				"-C",
				dir,
				"rev-parse",
				"--path-format=absolute",
				"--git-dir",
			])?.trim();
			if (!gitdir) return false;
			const has = (/** @type {string} */ p) => fs.existsSync(`${gitdir}/${p}`);
			return (
				has("MERGE_HEAD") ||
				has("rebase-merge") ||
				has("rebase-apply") ||
				has("CHERRY_PICK_HEAD") ||
				has("REVERT_HEAD")
			);
		},
		stagedFiles: (dir) => {
			const born = git(["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"]);
			return lines(dir, [
				"diff",
				"--cached",
				"--name-only",
				...(born === null ? [EMPTY_TREE] : []),
			]);
		},
		lsFiles: (dir, p, mode) =>
			lines(dir, ["ls-files", ...LS_MODE[mode], "--", p]),
		topLevel: (dir) => readTopLevel(dir),
		patchFiles: (dir, file) => patchFiles(dir, file),
		readList: (file) => {
			try {
				if (!fs.statSync(file).isFile()) return null;
				return fs.readFileSync(file, "utf8");
			} catch {
				// Any unreadable list is null by the port's contract; the caller logs it (mantahostels#3324).
				return null;
			}
		},
		commitCheck: readCommitCheck,
		closingRefusal: (match) => closingRefusal(match, root),
	};
}

module.exports = { buildHostPorts };
