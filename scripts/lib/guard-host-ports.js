/*
 * guard-host-ports.js — the production adapters the guard dispatcher
 * (lib/guard-dispatch.js) hands its cores: the host root's shared reads and
 * tree ports, whether a path exists or is a regular file, and the
 * environment; and any other tree's ports where a session works in a linked
 * worktree (workflow-core#2786, ADR-0010). A module of its own so these ports are tested
 * through the exports the dispatcher calls (base §G6, workflow-core#4136).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText: readFileText } = require("./file-read.js");
const { gitOutcome, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { sharedReaders } = require("./kit-context.js");
const { relativeUnder } = require("./is-under.js");

/**
 * @typedef {import("./kit-context.js").KitContext} KitContext
 * @typedef {{
 *   root: string,
 *   git: import("./git.js").GitReader,
 *   readText: (rel: string) => string | null,
 *   repoRel: (file: string) => string | null,
 * }} TreePorts one tree's reads: its root; git run there, one call per
 *   distinct argument list; a file's text by its path from the root, null
 *   where it is absent; and a path's spelling under the root
 * @typedef {TreePorts & {
 *   exists: (p: string) => boolean,
 *   isFile: (p: string) => boolean,
 *   env: Record<string, string | undefined>,
 * }} CorePorts the dispatcher core contract its production adapters fill
 *   (workflow-core#2786), the ports a core reads beyond the kit's: the host root's tree
 *   ports — where the shared stores live, claims, markers, ledgers, the rule
 *   store; whether a path exists, and whether it is a regular file; and the
 *   environment the entry was run in
 * @typedef {Pick<KitContext, "moduleOn" | "treeClass"> & CorePorts
 *   & Partial<Pick<KitContext, "fallbackCwd" | "vars">>} Adapters
 *   the hook's own directory and expansion scope, which test support fills
 *   in place of the hook's; the dispatcher's entry leaves both to the kit's,
 *   the process's cwd and environment
 */

/**
 * The adapters every core of one call shares.
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Adapters}
 */
function hostAdapters(root, log) {
	return {
		...sharedReaders(root, log),
		...treePorts(root),
		exists: (p) => fs.existsSync(p),
		isFile: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
		env: process.env,
	};
}

/**
 * The reads of the tree rooted at `root`, symlink-resolved.
 * @param {string} root
 * @returns {TreePorts}
 */
function treePorts(root) {
	return {
		root,
		git: (args, noMatch) =>
			gitOutcome(args, noMatch, root, HOOK_GIT_TIMEOUT_MS),
		readText: (rel) => {
			const got = readFileText(path.join(root, rel));
			if (got.state === "unreadable") throw got.error;
			return got.state === "read" ? got.data : null;
		},
		repoRel: (file) => repoRel(file, root),
	};
}

/**
 * An absolute path's spelling under `root`, null where it is
 * relative or lies outside. A path not under `root` as spelled is retried with
 * its longest existing ancestor's symlinks resolved, so a write spelled
 * through a link to the checkout is still the checkout's (workflow-core#2553).
 * @param {string} file
 * @param {string} root symlink-resolved
 * @returns {string | null}
 */
function repoRel(file, root) {
	if (!path.isAbsolute(file)) return null;
	/** @param {string} p */
	const under = (p) => relativeUnder(root, p) || null;
	const abs = path.resolve(file);
	const direct = under(abs);
	if (direct !== null) return direct;
	let dir = abs;
	let tail = "";
	for (;;) {
		try {
			return under(path.join(fs.realpathSync(dir), tail));
		} catch {
			if (dir === path.dirname(dir)) return null;
			tail = path.join(path.basename(dir), tail);
			dir = path.dirname(dir);
		}
	}
}

module.exports = {
	hostAdapters,
	treePorts,
};
