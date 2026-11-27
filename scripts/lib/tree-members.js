const fs = require("node:fs");
const path = require("node:path");

const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");

/** @typedef {{ index: Set<string> | null, failure: string | null }} Tree */

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
	if (!hasOwnGit(base)) return { index: null, failure: null };
	const { env, failure } = envFor(base);
	if (!env) return { index: null, failure };
	const opts = {
		encoding: /** @type {const} */ ("utf8"),
		timeout: GIT_TIMEOUT_MS,
		env,
	};
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

/** @returns {{ vars: string[] } | { failure: string }} */
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

/** @param {string} dir */
function hasOwnGit(dir) {
	return fs.existsSync(path.join(dir, ".git"));
}

/** @param {string} base @returns {Tree} */
function treeOf(base) {
	const key = path.resolve(base);
	let tree = trees.get(key);
	if (!tree) {
		tree = readTree(key);
		trees.set(key, tree);
	}
	return tree;
}

/** @param {string} base @param {string} rel */
function isTreeMember(base, rel) {
	const { index } = treeOf(base);
	return index
		? index.has(path.normalize(rel))
		: fs.existsSync(path.join(base, rel));
}

/** @type {Map<Set<string>, Set<string>>} */
const dirsOf = new Map();

/** @param {string} base @param {string} rel */
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
