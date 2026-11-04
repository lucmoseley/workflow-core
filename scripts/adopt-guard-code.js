#!/usr/bin/env node
/*
 * adopt-guard-code.js — fetch origin/main and adopt its tip as the code this
 * repo's guard hooks run, where it passes the load probe (lib/guard-code.js,
 * #4227). The lander runs the same adoption each time it moves `main`; this is
 * the hand route, and the one that sets the link up on a fresh machine.
 *
 *   node scripts/adopt-guard-code.js
 *
 * Joins no §N3 family: it gates nothing and is no hook.
 *
 * Exit codes: 0 where guard code is live afterwards; 1 where none is, or the
 * adoption failed; 2 on a command line it refuses.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	adoptGuardCodeAt,
	adoptionLine,
	guardCodeDir,
	guardFiles,
} = require("./lib/guard-code.js");
const { writeFd } = require("./lib/write-fd.js");

parseOrExit(process.argv.slice(2), {
	usage: "Usage: node scripts/adopt-guard-code.js",
});

const adoption = adoptGuardCodeAt(hostRoot());
if (adoption === null) {
	writeFd(
		1,
		"guard code: nothing to adopt — this checkout's hooks do not run from pinned guard code\n",
	);
	process.exit(0);
}
let live = false;
try {
	live = fs.existsSync(
		path.join(
			guardFiles(guardCodeDir()).current,
			"scripts",
			"guard-dispatch.js",
		),
	);
} catch {
	// HOME unset: the adoption above already said why it failed.
}
writeFd(
	adoption.kind === "error" || !live ? 2 : 1,
	`${adoptionLine(adoption)}${live ? "" : "; no guard code is live, so every guarded call is refused"}\n`,
);
process.exit(adoption.kind !== "error" && live ? 0 : 1);
