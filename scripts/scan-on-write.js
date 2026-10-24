#!/usr/bin/env node
/*
 * scan-on-write.js — two rules the commit and the closing suite run, applied
 * to the one file a tool just wrote (workflow-core#1151, ruled at workflow-core#1138).
 *
 * Usage: node scripts/scan-on-write.js <file>
 *
 *   host-root   check-host-root.js's judges over this file alone — a
 *               `path.join(__dirname, "..", "docs", …)` refused at commit.
 *   citation    a `#N` a shipped code line prints outside a `( … )`, which
 *               fails every plugin-tree test reading the live core.
 *
 * Run by post-write.sh alone, after every Write/Edit, which always passes the
 * file. A fault is handed to the session as PostToolUse context; nothing is
 * refused, and every failure past the argument read prints nothing and exits
 * 0.
 *
 * Both rules bind only a root shipping a plugin, so elsewhere it says nothing.
 * plugin-tree.js is left behind by the release, so the citation half runs in
 * the core alone.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");

const USAGE = "Usage: node scripts/scan-on-write.js <file>";

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function faultsOf(root, rel) {
	const { fileFaults, shipsPlugin } = require("./check-host-root.js");
	if (!shipsPlugin(root)) return [];
	const out = fileFaults(root, rel);
	if (fs.existsSync(path.join(__dirname, "lib", "plugin-tree.js"))) {
		const { bareCitationFaults } = require("./lib/plugin-tree");
		out.push(...bareCitationFaults(root, rel));
	}
	return out;
}

function main() {
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		min: 1,
	});
	const [written] = positionals;
	if (written === undefined)
		throw new Error("parseOrExit passed no path despite min: 1");
	try {
		const root = hostRoot();
		/* Physically, as post-write.sh's in_root judged it: a symlinked prefix
		 * would otherwise land outside the dereferenced root. */
		const rel = path.relative(
			root,
			fs.realpathSync(path.resolve(root, written)),
		);
		if (rel.startsWith("..") || path.isAbsolute(rel)) return;
		const faults = faultsOf(root, rel);
		if (faults.length === 0) return;
		const text = `${rel} carries ${faults.length} fault(s) the commit gate or the release refuses — fix them now, before any test run (workflow-core#1151):\n${faults.join("\n")}`;
		writeFd(
			1,
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: text,
				},
			})}\n`,
		);
	} catch {
		/* Swallowed (workflow-core#1151): a scan that breaks a write is worse than one that
		 * misses a fault, which the commit gate and the release still judge. */
	}
}

main();
