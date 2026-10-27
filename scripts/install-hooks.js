#!/usr/bin/env node
/*
 * install-hooks.js — the half of package.json's `prepare` that runs after
 * husky writes .husky/_, pointing git at those hooks from every worktree and
 * each hook at the committing worktree's own .husky/<hook> (workflow-core#3138).
 *
 * core.hooksPath is pinned absolute, into the canonical checkout's .husky/_,
 * because .husky/_ is gitignored and a relative path finds no hooks in a
 * linked worktree (mantahostels#344). husky's `h` shim then resolves the hook
 * beside its own directory, the canonical checkout's working copy, so a
 * worktree's commit or push ran a neighbour's half-written hook, or one
 * hundreds of commits behind its own tree. This rewrites that one lookup line
 * to the working tree git runs the hook in, falling back to husky's own where
 * git names no tree or that tree carries no such hook.
 *
 * Exit 2 (BROKEN) where the installed husky's `h` carries neither line: an
 * upgrade changed the shim, and patching blind could stop every hook.
 * Idempotent, so it can be rerun on a canonical checkout husky last wrote.
 *
 * In no family (§N3): it installs, writing git config and a generated file,
 * and judges nothing a gate could run.
 *
 * Residual: a checkout whose shim predates workflow-core#3138 runs the canonical hook copy
 * until `npm run prepare` reruns there, and an `npm install` run where
 * package.json predates workflow-core#3138 puts husky's stock shim back.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execGit, gitCommonDirOrThrow } = require("./lib/git.js");
const { writeFd } = require("./lib/write-fd.js");

const HUSKY_LOOKUP = 's=$(dirname "$(dirname "$0")")/$n';
const OWN_LOOKUP = `t=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$t/.husky/$n" ] && s="$t/.husky/$n" || ${HUSKY_LOOKUP}`;

const hooks = path.join(
	path.dirname(gitCommonDirOrThrow(process.cwd())),
	".husky",
	"_",
);
const shim = path.join(hooks, "h");
if (fs.existsSync(shim)) {
	const body = fs.readFileSync(shim, "utf8");
	if (!body.includes(OWN_LOOKUP)) {
		if (!body.includes(HUSKY_LOOKUP)) {
			writeFd(
				2,
				`install-hooks: BROKEN — ${shim} no longer carries husky's hook lookup \`${HUSKY_LOOKUP}\`, so a worktree's hooks cannot be pointed at its own tree. Read the installed husky's shim and update HUSKY_LOOKUP in scripts/install-hooks.js (workflow-core#3138).\n`,
			);
			process.exit(2);
		}
		fs.writeFileSync(shim, body.replace(HUSKY_LOOKUP, OWN_LOOKUP));
	}
} else {
	// husky writes none under HUSKY=0, CI's way of skipping hooks.
	writeFd(
		2,
		`install-hooks: no ${shim}, so no hook was pointed at its own tree.\n`,
	);
}

execGit(["config", "core.hooksPath", hooks]);
