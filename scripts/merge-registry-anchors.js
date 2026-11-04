#!/usr/bin/env node
/*
 * merge-registry-anchors.js — git's merge driver for
 * `.claude/guard-registry-anchors.json` (#4171), so a merge, revert or
 * cherry-pick never stops on a conflict there:
 *
 *   node <abs>/scripts/merge-registry-anchors.js %O %A %B
 *
 * Writes lib/registry-anchors-merge.js's per-row merge over %A and exits 0.
 * A row both sides moved keeps %A's digest, which the guard-registry gate at
 * `pre-merge-commit` and pre-push then names stale, owing its `--review`.
 *
 * Where a side is not a JSON object of digests, it falls back to git's own
 * text merge, markers and all, and exits 1, a conflict.
 *
 * In no family (§N3): its exits are git's merge-driver alphabet, not runCheck's.
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { spawnGitSync } = require("./lib/git.js");
const { buildMergedAnchors } = require("./lib/registry-anchors-merge.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: merge-registry-anchors.js %O %A %B, as git passes them\n";
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { help: { type: "boolean" } },
});
if (values.help) {
	writeFd(1, USAGE);
	process.exit(0);
}
const [base, ours, theirs] = positionals;
if (base === undefined || ours === undefined || theirs === undefined) {
	writeFd(2, `merge-registry-anchors: ${USAGE}`);
	/* Above 128, git fails the merge rather than calling the file conflicted. */
	process.exit(129);
}
/** @param {string} file */
const read = (file) => fs.readFileSync(file, "utf8");
const merged = buildMergedAnchors(read(base), read(ours), read(theirs));
if (merged !== null) {
	fs.writeFileSync(ours, merged);
	process.exit(0);
}
const text = spawnGitSync(
	[
		"merge-file",
		"-L",
		"ours",
		"-L",
		"base",
		"-L",
		"theirs",
		ours,
		base,
		theirs,
	],
	{ encoding: "utf8" },
);
/* merge-file exits with its conflict count, and negative (above 127) on an error. */
if (text.status === null || text.status > 127) {
	writeFd(
		2,
		`merge-registry-anchors: a side is not a JSON object of digests, and git merge-file failed: ${String(text.stderr).trim()}\n`,
	);
	process.exit(129);
}
writeFd(
	2,
	"merge-registry-anchors: a side is not a JSON object of digests, so it is text-merged; resolve the markers.\n",
);
process.exit(1);
