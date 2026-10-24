/*
 * touched-by.js — what a commit changed, and the ceiling every --touched-by
 * git read runs under (workflow-core#2210, workflow-core#2375).
 */

const { GIT_MAX_BUFFER } = require("./census-digest.js");
const { buildGitCeiling } = require("./git-ceiling.js");

/* ~60x the 0.5s the census took over a commit adding two rule files, so only a
 * hang meets it, and short enough that a post-commit hook stalled on one costs
 * a commit half a minute. */
const TOUCHED_BY_CEILING_MS = 30_000;

/** @returns {import("./git-ceiling.js").GitCeiling} */
function touchedByCeiling() {
	return buildGitCeiling({
		label: "--touched-by",
		/* The suite's seam: a ceiling short enough to meet in a test. */
		ms: Number(process.env.WFC_TOUCHED_BY_CEILING_MS) || TOUCHED_BY_CEILING_MS,
	});
}

/**
 * The paths `rev` changed against its first parent, each mapped to its
 * diff-tree status letter. The letter, not a disk read, says a file is gone:
 * a disk read would answer from a file `git rm --cached` left behind. A merge
 * commit lists nothing in this form, so a conflict resolved inside a guard
 * there goes unnamed until the daily run. A git fault or CeilingPassed is
 * thrown.
 *
 * @param {string} root
 * @param {string} rev
 * @param {import("./git-ceiling.js").GitCeiling} ceiling
 * @returns {Map<string, string>}
 */
function touchedBy(root, rev, ceiling) {
	const fields = String(
		ceiling.git(
			[
				"-C",
				root,
				"diff-tree",
				"--no-commit-id",
				"--name-status",
				"-r",
				"-z",
				"--root",
				rev,
			],
			{
				encoding: "utf8",
				maxBuffer: GIT_MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			},
			`git diff-tree ${rev}`,
		),
	).split("\0");
	/** @type {Map<string, string>} */
	const touched = new Map();
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [status, rel] = [fields[i], fields[i + 1]];
		if (status !== undefined && rel !== undefined) touched.set(rel, status);
	}
	return touched;
}

module.exports = { TOUCHED_BY_CEILING_MS, touchedBy, touchedByCeiling };
