/*
 * merge-heads.js — the commits an unfinished merge is bringing in, read from
 * `$GIT_DIR/MERGE_HEAD`. Apart from git.js so that a change here re-anchors
 * only the guards that read a merge's sides (#4529).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { execGit } = require("./git.js");
const { brokenError } = require("./outcome-error.js");

/**
 * The non-empty lines of `$GIT_DIR/MERGE_HEAD`, one per side, none where the
 * file is absent. BROKEN where git will not locate the file or it will not
 * read: only ENOENT is absence, so no failed read quietly becomes HEAD alone
 * (#3184).
 * @param {string} [cwd] the checkout, the process's own where omitted
 * @returns {string[]}
 */
function readMergeHeadLines(cwd) {
	let file;
	try {
		file = String(
			execGit(
				["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		).trim();
	} catch (e) {
		throw brokenError(
			`git would not locate MERGE_HEAD: ${caught(e).message} — run \`git rev-parse --git-path MERGE_HEAD\` to see git's own error`,
		);
	}
	if (!file)
		throw brokenError(
			"git rev-parse --git-path MERGE_HEAD printed no path — run it to see git's own answer",
		);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw brokenError(
			`could not read MERGE_HEAD at ${file}: ${caught(e).message}`,
		);
	}
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

module.exports = { readMergeHeadLines };
