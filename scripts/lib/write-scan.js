/*
 * write-scan.js — two rules the commit and the closing suite run, applied to
 * the one file a tool just wrote (workflow-core#1151, ruled at workflow-core#1138): the post-write
 * core's step 3.
 *
 *   host-root   check-host-root.js's judges over this file alone — a
 *               `path.join(__dirname, "..", "docs", …)` refused at commit.
 *   citation    a `#N` a shipped code line prints outside a `( … )`, which
 *               fails every plugin-tree test reading the live core.
 *
 * Both rules bind only a root shipping a plugin, so elsewhere it says nothing.
 * plugin-tree.js is left behind by the release, so the citation half runs in
 * the core alone.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function faultsOf(root, rel) {
	const { fileFaults, shipsPlugin } = require("../check-host-root.js");
	if (!shipsPlugin(root)) return [];
	const out = fileFaults(root, rel);
	if (fs.existsSync(path.join(__dirname, "plugin-tree.js"))) {
		const { bareCitationFaults } = require("./plugin-tree.js");
		out.push(...bareCitationFaults(root, rel));
	}
	return out;
}

/**
 * The faults in `written`, as text handed to the session, or "" where it has
 * none or lies outside `root`.
 * @param {string} root
 * @param {string} written
 */
function writeFaults(root, written) {
	/* Physically, as post-write's in-root test judged it: a symlinked prefix
	 * would otherwise land outside the dereferenced root. */
	const rel = path.relative(root, fs.realpathSync(path.resolve(root, written)));
	if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
	const faults = faultsOf(root, rel);
	if (faults.length === 0) return "";
	return `${rel} carries ${faults.length} fault(s) the commit gate or the release refuses — fix them now, before any test run (workflow-core#1151):\n${faults.join("\n")}`;
}

module.exports = { writeFaults };
