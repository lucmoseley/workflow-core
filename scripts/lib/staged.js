/*
 * staged.js — the commit's staged side as the pre-commit checkers read it:
 * the staged path list and each path's blob, never the worktree copy, since
 * the commit carries the blob and in the shared tree a worktree read would
 * judge a neighbour's half-written edit. Shared by scripts/check-ruff-introduced.js (workflow-core#122),
 * scripts/check-format-staged.js (workflow-core#1332, workflow-core#1354) and
 * scripts/check-swallowed-errors.js (workflow-core#1830).
 */

const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { spawnGitSync } = require("./git.js");

/** @typedef {import("./check").CheckContext} Ctx */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [input]
 */
function spawn(cmd, args, input) {
	return spawnSync(cmd, args, {
		input,
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
}

/**
 * `git diff --cached` NUL-separated, broken if git fails.
 * @param {Ctx} ctx
 * @param {string[]} args
 * @returns {string[]}
 */
function readStagedDiff(ctx, args) {
	const r = spawnGitSync(["diff", "--cached", "-z", ...args], {
		encoding: "utf8",
	});
	if (r.status !== 0) ctx.broken(`git diff --cached failed: ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * A blob's text, or null where git has none by that name.
 * @param {string} spec a `<rev>:<path>` blob name, `:<path>` for the staged one
 * @returns {string | null}
 */
function readBlob(spec) {
	const r = spawnGitSync(["cat-file", "blob", spec], { encoding: "utf8" });
	return r.status === 0 ? r.stdout : null;
}

/**
 * The HEAD path of each staged rename, new → old. Unrestricted by pathspec:
 * limited to the new path, git has no old one to pair it with and reports a
 * plain add.
 * @param {Ctx} ctx
 */
function readRenameSources(ctx) {
	const fields = readStagedDiff(ctx, [
		"--name-status",
		"-M",
		"--diff-filter=R",
	]);
	/** @type {Map<string, string>} */
	const sources = new Map();
	for (let i = 0; ; i += 3) {
		const from = fields[i + 1];
		const to = fields[i + 2];
		if (from === undefined || to === undefined) break;
		sources.set(to, from);
	}
	return sources;
}

module.exports = { readBlob, readRenameSources, spawn, readStagedDiff };
