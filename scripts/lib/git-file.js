/*
 * git-file.js — a linked worktree's `.git` file read without spawning git: for
 * a hook-path caller that spawns none (lib/overflow-key.js), and for one whose
 * git will not answer for that worktree (lib/repo-holds.js, #4402), and a
 * common dir's registrations read back to the worktrees they name (#4880).
 */

const fs = require("node:fs");
const path = require("node:path");

const { caught } = require("./caught.js");

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/**
 * `file`'s text, or null where it is absent or a directory; any other failure
 * throws.
 * @param {string} file
 */
function readTextOrNull(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		if (ABSENT_CODES.has(caught(err).code ?? "")) return null;
		throw err;
	}
}

/**
 * The worktree's registration directory a `.git` file's `gitdir:` line names
 * (`<common dir>/worktrees/<name>`), resolved against `dir`, the directory
 * holding that file; null where no such line reads.
 * @param {string} dir
 * @param {string} text
 */
function parseGitFileTarget(dir, text) {
	const gitDir = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
	return gitDir ? path.resolve(dir, gitDir) : null;
}

/**
 * The common dir a worktree registration belongs to: its `commondir` file's,
 * or its place under `worktrees/` where that file is gone; null where neither
 * says.
 * @param {string} registration
 */
function readRegistrationCommonDir(registration) {
	const common = readTextOrNull(path.join(registration, "commondir"));
	if (common !== null) return path.resolve(registration, common.trim());
	return path.basename(path.dirname(registration)) === "worktrees"
		? path.dirname(path.dirname(registration))
		: null;
}

/**
 * The common dir a linked worktree's `.git` file at `root` points at; null
 * where `root/.git` is absent, a directory, or names no registration.
 * @param {string} root
 */
function readGitFileCommonDir(root) {
	const text = readTextOrNull(path.join(root, ".git"));
	const registration = text === null ? null : parseGitFileTarget(root, text);
	return registration && readRegistrationCommonDir(registration);
}

/**
 * The registration directory of each linked worktree under common dir
 * `common`; none where it registers none.
 * @param {string} common
 * @returns {string[]}
 */
function readRegistrations(common) {
	const base = path.join(common, "worktrees");
	try {
		return fs.readdirSync(base).map((name) => path.join(base, name));
	} catch (err) {
		if (ABSENT_CODES.has(caught(err).code ?? "")) return [];
		throw err;
	}
}

/**
 * The worktree root a registration's `gitdir` file names; null where that
 * file is gone or empty.
 * @param {string} registration
 */
function readRegisteredTree(registration) {
	const gitFile = readTextOrNull(path.join(registration, "gitdir"))?.trim();
	return gitFile ? path.dirname(path.resolve(registration, gitFile)) : null;
}

/**
 * The nearest `.git` file at or above `start`, and the directory holding it;
 * null where the nearest `.git` is a directory, or there is none.
 * @param {string} start
 * @returns {{dir: string, text: string}|null}
 */
function readGitFile(start) {
	for (let dir = start; ; dir = path.dirname(dir)) {
		try {
			return { dir, text: fs.readFileSync(path.join(dir, ".git"), "utf8") };
		} catch (err) {
			const { code } = caught(err);
			if (code === "EISDIR") return null;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			if (path.dirname(dir) === dir) return null;
		}
	}
}

module.exports = {
	parseGitFileTarget,
	readGitFile,
	readGitFileCommonDir,
	readRegisteredTree,
	readRegistrationCommonDir,
	readRegistrations,
};
