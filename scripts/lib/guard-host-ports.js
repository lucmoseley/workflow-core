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
 * }} TreePorts
 * @typedef {TreePorts & {
 *   exists: (p: string) => boolean,
 *   isFile: (p: string) => boolean,
 *   env: Record<string, string | undefined>,
 * }} CorePorts
 * @typedef {Pick<KitContext, "moduleOn" | "treeClass"> & CorePorts
 *   & Partial<Pick<KitContext, "fallbackCwd" | "vars">>} Adapters
 */

/**
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
 * @param {string} file
 * @param {string} root
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
