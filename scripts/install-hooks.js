#!/usr/bin/env node
/*
 * install-hooks.js — the half of package.json's `prepare` that runs after
 * husky writes .husky/_, pointing git at those hooks from every worktree and
 * each hook at the committing worktree's own .husky/<hook> (#3138).
 *
 * core.hooksPath is pinned absolute, into the canonical checkout's .husky/_,
 * because .husky/_ is gitignored and a relative path finds no hooks in a
 * linked worktree (mantahostels#344). husky's `h` shim then resolves the hook
 * beside its own directory, the canonical checkout's working copy, so a
 * worktree's commit or push ran a hook hundreds of commits from its own tree. This rewrites that one lookup line
 * to the working tree git runs the hook in, falling back to husky's own where
 * git names no tree or that tree carries no such hook.
 *
 * It also defines the guard registry's anchors merge driver that .gitattributes
 * names (#4171), pinned absolute into the canonical checkout like the hooks.
 * `driver` is written before `name`, as a section with a name and no driver is
 * a fatal error on every merge; with no section, git text-merges the file.
 *
 * Exit 2 (BROKEN) where the installed husky's `h` carries neither line: an
 * upgrade changed the shim, and patching blind could stop every hook.
 * Idempotent, so it can be rerun on a canonical checkout husky last wrote.
 *
 * In no family (§N3): it installs, writing git config and a generated file,
 * and judges nothing a gate could run.
 *
 * Residual: a checkout whose shim predates #3138 runs the canonical hook copy
 * until `npm run prepare` reruns there, and an `npm install` run where
 * package.json predates #3138 puts husky's stock shim back;
 * check-husky-shim.js reports both on `npm run status` (#3172).
 */

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
	// A rename, not an overwrite: husky copies the shim with its source's mode,
	// read-only where node_modules is an immutable dependency store (#4372).
	writeFileAtomic(shim, read.body.replace(HUSKY_LOOKUP, OWN_LOOKUP), {
		mode: (fs.statSync(shim).mode & 0o777) | 0o200,
	});
if (read.state === "absent")
	// husky writes none under HUSKY=0, CI's way of skipping hooks.
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
