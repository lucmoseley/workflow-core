#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execGit, gitCommonDirOrThrow } = require("./lib/git.js");
const {
	HUSKY_LOOKUP,
	OWN_LOOKUP,
	readShim,
	shimPaths,
} = require("./lib/husky-shim.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { writeFd } = require("./lib/write-fd.js");

const commonDir = gitCommonDirOrThrow(process.cwd());
const { hooks, shim } = shimPaths(commonDir);
const read = readShim(shim);
if (read.state === "unknown") {
	writeFd(
		2,
		`install-hooks: BROKEN — ${shim} no longer carries husky's hook lookup \`${HUSKY_LOOKUP}\`, so a worktree's hooks cannot be pointed at its own tree. Read the installed husky's shim and update HUSKY_LOOKUP in scripts/lib/husky-shim.js (#3138).\n`,
	);
	process.exit(2);
}
if (read.state === "stock")
	// #4372
	writeFileAtomic(shim, read.body.replace(HUSKY_LOOKUP, OWN_LOOKUP), {
		mode: (fs.statSync(shim).mode & 0o777) | 0o200,
	});
if (read.state === "absent")
	writeFd(
		2,
		`install-hooks: no ${shim}, so no hook was pointed at its own tree.\n`,
	);

execGit(["config", "core.hooksPath", hooks]);
const driver = path.join(
	path.dirname(commonDir),
	"scripts",
	"merge-registry-anchors.js",
);
execGit([
	"config",
	"merge.registry-anchors.driver",
	`node ${shellQuote(driver)} %O %A %B`,
]);
execGit([
	"config",
	"merge.registry-anchors.name",
	"guard registry anchors, merged per row (scripts/merge-registry-anchors.js)",
]);
