/*
 * tree-members.js — whether a path is in the tree a guard's closure is judged
 * in (workflow-core#4508). In a checkout that tree is git's index, never the working
 * directory, so one commit gives one digest in every worktree. Membership only: the bytes hashed stay the
 * working tree's, as a pathspec commit commits them, so an unstaged edit to a
 * tracked dependency still moves the digest, and --review stands that row down
 * as dirty. The index, not HEAD, so a file `git add`ed for
 * the commit being built is in, and a pathspec commit's temporary index
 * (GIT_INDEX_FILE) is the one read.
 *
 * Only for the repository that index belongs to (workflow-core#4733). Inside a commit hook
 * git exports GIT_INDEX_FILE, and sometimes GIT_DIR, for the hook's repo; any
 * other checkout — the core's, read from an adopter's hook — is read with the
 * repository-local variables stripped.
 *
 * A directory no checkout tops — a materialised `--root` copy, which `git
 * archive` wrote tracked-only, or a plugin cache with no `.git` — is its own
 * tree, read as it lies on disk. So is a checkout git cannot answer for, with
 * its reason kept: the report fails open on it as the gitignore filter does
 * (mantahostels#2243), and --review, whose anchors would keep the disk's
 * answer, refuses.
 */

const fs = require("node:fs");
const path = require("node:path");

const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");

/**
 * @typedef {{ index: Set<string> | null, failure: string | null }} Tree
 * `index` null where the tree is read on disk; `failure` why, where git could not answer.
 */

/** @type {Map<string, Tree>} */
const trees = new Map();

/**
 * @param {{ error?: Error, status: number | null, stderr?: unknown }} r
 * @param {string} what
 */
const buildGitFailure = (r, what) =>
	`git ${what} failed: ${r.error?.message ?? (String(r.stderr ?? "").trim() || `exit ${r.status}`)}`;

/**
 * @param {string} base
 * @returns {Tree}
 */
function readTree(base) {
	/* Before any git call: an exported GIT_DIR would otherwise answer for a
	 * materialised copy out of the live index. */
	if (!hasOwnGit(base)) return { index: null, failure: null };
	const { env, failure } = envFor(base);
	if (!env) return { index: null, failure };
	const opts = {
		encoding: /** @type {const} */ ("utf8"),
		timeout: GIT_TIMEOUT_MS,
		env,
	};
	/* An empty prefix says git takes `base` for the top of the checkout whose
	 * `.git` it carries, and not a directory below some other work tree. */
	const top = spawnGitSync(["-C", base, "rev-parse", "--show-prefix"], opts);
	if (
		!top.error &&
		top.status !== 0 &&
		/not a git repository/.test(String(top.stderr))
	)
		return { index: null, failure: null };
	if (top.error || top.status !== 0)
		return { index: null, failure: buildGitFailure(top, "rev-parse") };
	if (String(top.stdout).trim() !== "") return { index: null, failure: null };
	const listed = spawnGitSync(["-C", base, "ls-files", "-z"], {
		...opts,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (listed.error || listed.status !== 0)
		return { index: null, failure: buildGitFailure(listed, "ls-files") };
	const index = new Set(
		String(listed.stdout)
			.split("\0")
			.filter(Boolean)
			.map((p) => path.normalize(p)),
	);
	return { index, failure: null };
}

/**
 * The environment to read `base` under: the process's own where the
 * repository-local variables it carries are `base`'s, else those stripped.
 * An exported GIT_INDEX_FILE with no GIT_DIR is, as git reads it, the index of
 * the repository the working directory is in, so that repository is the one
 * matched: a hook process run from inside another checkout reads that
 * checkout from the hook's index.
 *
 * @param {string} base
 * @returns {{ env: NodeJS.ProcessEnv, failure: null } | { env: null, failure: string }}
 */
function envFor(base) {
	const local = readLocalEnvVars();
	if ("failure" in local) return { env: null, failure: local.failure };
	const set = local.vars.filter((k) => process.env[k] !== undefined);
	if (set.length === 0) return { env: process.env, failure: null };
	const stripped = { ...process.env };
	for (const k of set) delete stripped[k];
	const exported = readGit(["rev-parse", "--absolute-git-dir"], process.env);
	if ("failure" in exported)
		return {
			env: null,
			failure: `no repository owns the exported ${set.join(", ")}: ${exported.failure}`,
		};
	const own = readGit(
		["-C", base, "rev-parse", "--absolute-git-dir"],
		stripped,
	);
	return {
		env: "out" in own && own.out === exported.out ? process.env : stripped,
		failure: null,
	};
}

/**
 * The variables that name a repository rather than configure git, less the
 * `-c` overrides git carries into another repository too
 * (`prepare_other_repo_env`).
 *
 * @returns {{ vars: string[] } | { failure: string }}
 */
function readLocalEnvVars() {
	const r = readGit(["rev-parse", "--local-env-vars"], process.env);
	if ("failure" in r) return r;
	return {
		vars: r.out
			.split("\n")
			.filter(
				(k) => k && k !== "GIT_CONFIG_PARAMETERS" && k !== "GIT_CONFIG_COUNT",
			),
	};
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ out: string } | { failure: string }}
 */
function readGit(args, env) {
	const r = spawnGitSync(args, {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		env,
	});
	return r.error || r.status !== 0
		? { failure: buildGitFailure(r, String(args[args[0] === "-C" ? 2 : 0])) }
		: { out: String(r.stdout).trim() };
}

/**
 * Whether `dir` carries its own `.git`, not an ancestor's (workflow-core#3450).
 * @param {string} dir
 */
function hasOwnGit(dir) {
	return fs.existsSync(path.join(dir, ".git"));
}

/**
 * `base`'s tree, read once per process.
 *
 * @param {string} base
 * @returns {Tree}
 */
function treeOf(base) {
	const key = path.resolve(base);
	let tree = trees.get(key);
	if (!tree) {
		tree = readTree(key);
		trees.set(key, tree);
	}
	return tree;
}

/**
 * @param {string} base
 * @param {string} rel a path from `base`
 */
function isTreeMember(base, rel) {
	const { index } = treeOf(base);
	return index
		? index.has(path.normalize(rel))
		: fs.existsSync(path.join(base, rel));
}

/** @type {Map<Set<string>, Set<string>>} */
const dirsOf = new Map();

/**
 * `isTreeMember`, also true of a directory holding a member: the index lists
 * files alone, and a rule may name a directory.
 *
 * @param {string} base
 * @param {string} rel a path from `base`
 */
function isTreeFileOrDir(base, rel) {
	if (isTreeMember(base, rel)) return true;
	const { index } = treeOf(base);
	if (!index) return false;
	let dirs = dirsOf.get(index);
	if (!dirs) {
		dirs = new Set();
		for (const p of index)
			for (let d = path.dirname(p); d !== "."; d = path.dirname(d)) dirs.add(d);
		dirsOf.set(index, dirs);
	}
	return dirs.has(path.normalize(rel).replace(/\/$/, ""));
}

module.exports = { hasOwnGit, isTreeFileOrDir, isTreeMember, treeOf };
