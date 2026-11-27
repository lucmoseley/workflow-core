#!/usr/bin/env node

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
