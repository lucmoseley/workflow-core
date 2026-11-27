const fs = require("node:fs");
const { closingRefusal } = require("./closing-keyword.js");
const { gitOrNull, HOOK_GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { readUnpushedRef } = require("./landing-refs.js");
const { patchFiles, readTopLevel } = require("./git-tree.js");

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * @param {string[]} args
 * @returns {string | null}
 */
const git = (args) => gitOrNull(args, { timeout: HOOK_GIT_TIMEOUT_MS });

/**
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
 * @param {{ root: string }} env
 * @returns {import("./commit-form.js").CommitFormPorts}
 */
function buildHostPorts({ root }) {
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
				return null;
			}
		},
		pushedHead: (dir) => {
			const ref = readUnpushedRef({ root, tree: dir });
			const r = spawnGitSync(
				["-C", dir, "merge-base", "--is-ancestor", "HEAD", ref],
				{ timeout: HOOK_GIT_TIMEOUT_MS, stdio: "ignore" },
			);
			if (r.status === 0) return ref;
			return r.status === 1 ? "" : null;
		},
		closingRefusal: (match) => closingRefusal(match, root),
	};
}

module.exports = { buildHostPorts };
