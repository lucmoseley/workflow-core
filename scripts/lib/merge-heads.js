/*
 * merge-heads.js — the commits an unfinished merge is bringing in, read from
 * `$GIT_DIR/MERGE_HEAD` or, before git writes it, the GITHEAD_<sha> exports.
 * Apart from git.js so that a change here re-anchors only the guards that
 * read a merge's sides (#4529).
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

/* git exports one per merged head to the hooks a `git merge` runs (its
 * conflict-marker labels), before MERGE_HEAD exists. */
const SHA_HEX = "[0-9a-f]{40}|[0-9a-f]{64}";
const GITHEAD_ENV = new RegExp(`^GITHEAD_(${SHA_HEX})$`);

/**
 * The shas `env`'s GITHEAD_<sha> names, as a hook `git merge` runs sees them.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function githeadShas(env) {
	return Object.keys(env).flatMap((k) => {
		const m = GITHEAD_ENV.exec(k);
		return m?.[1] ? [m[1]] : [];
	});
}

/**
 * The commits a merge in flight brings in: MERGE_HEAD's lines, or, in a hook
 * `git merge` runs before writing that file, its GITHEAD_<sha> exports. None
 * where no merge is in flight. BROKEN as `readMergeHeadLines` is.
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function readMergingHeads(cwd, env = process.env) {
	const lines = readMergeHeadLines(cwd);
	return lines.length > 0 ? lines : githeadShas(env);
}

/*
 * The merge parents a commit gate hands the throwaway worktree its suite runs
 * in, which has no MERGE_HEAD of its own: space-separated shas, empty where
 * the committing checkout has no merge in flight, `UNREAD_PREFIX` and why
 * where its merge state would not read (#5334).
 */
const MERGE_PARENTS_ENV = "WFC_MERGE_PARENTS";

const UNREAD_PREFIX = "unread: ";

const SHA = new RegExp(`^(?:${SHA_HEX})$`);

/**
 * `env` with the merge parents of the checkout at `cwd` handed off, or why
 * they would not read, so the child reports that rather than reading its
 * own worktree's lack of a merge as none (#5334).
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function withMergeParents(cwd, env) {
	const out = { ...env };
	try {
		out[MERGE_PARENTS_ENV] = readMergingHeads(cwd, env).join(" ");
	} catch (error) {
		out[MERGE_PARENTS_ENV] = `${UNREAD_PREFIX}${caught(error).message}`;
	}
	return out;
}

/**
 * The merge parents a commit made at `cwd` has besides HEAD: those a gate
 * handed off in `env`, else `readMergingHeads`'s. BROKEN as that is, where
 * the gate handed off why they would not read, and where a handed-off value
 * is no list of shas.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function readMergeParents(cwd, env = process.env) {
	const handed = env[MERGE_PARENTS_ENV];
	if (handed === undefined) return readMergingHeads(cwd, env);
	if (handed.startsWith(UNREAD_PREFIX))
		throw brokenError(
			`the committing checkout's merge parents would not read: ${handed.slice(UNREAD_PREFIX.length)}`,
		);
	const shas = handed.split(" ").filter(Boolean);
	if (!shas.every((s) => SHA.test(s)))
		throw brokenError(`${MERGE_PARENTS_ENV} holds no list of shas: ${handed}`);
	return shas;
}

module.exports = {
	githeadShas,
	readMergeHeadLines,
	readMergeParents,
	readMergingHeads,
	withMergeParents,
};
