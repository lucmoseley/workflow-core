/*
 * git-file.js — a linked worktree's `.git` file read without spawning git: for
 * a hook-path caller that spawns none (lib/overflow-key.js), and for one whose
 * git will not answer for that worktree (lib/repo-holds.js, #4402).
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * The worktree's registration directory a `.git` file's `gitdir:` line names
 * (`<common dir>/worktrees/<name>`), resolved against `dir`, the directory
 * holding that file; null where no such line reads.
 * @param {string} dir
 * @param {string} text
 */
function gitFileTarget(dir, text) {
	const gitDir = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
	return gitDir ? path.resolve(dir, gitDir) : null;
}

/**
 * The common dir a linked worktree's `.git` file at `root` points at, read
 * off its registration's `commondir` file, or off the registration's place
 * under `worktrees/` where that file is gone; null where `root/.git` is no
 * such file.
 * @param {string} root
 */
function gitFileCommonDir(root) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, ".git"), "utf8");
	} catch {
		return null;
	}
	const registration = gitFileTarget(root, text);
	if (!registration) return null;
	try {
		const common = fs.readFileSync(
			path.join(registration, "commondir"),
			"utf8",
		);
		return path.resolve(registration, common.trim());
	} catch {
		return path.basename(path.dirname(registration)) === "worktrees"
			? path.dirname(path.dirname(registration))
			: null;
	}
}

module.exports = { gitFileCommonDir, gitFileTarget };
