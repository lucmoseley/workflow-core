#!/usr/bin/env node
/*
 * post-commit-dispatch.js — .husky/post-commit's dispatcher (workflow-core#5207): runs
 * every row of lib/post-commit-rows.js in this one process, through
 * lib/precommit-dispatch.js, on the commit route lib/commit-route.js reads.
 *
 *   node scripts/post-commit-dispatch.js
 *
 * Always exits 0, as the hook it serves never refuses: a row that throws
 * prints one line naming it and the rest run, and a dispatcher that cannot
 * load prints one line naming the fault.
 */

/** @returns {Promise<number>} */
async function main() {
	const { catchSignals } = require("./lib/hook-entry.js");
	const { writeFd } = require("./lib/write-fd.js");
	const { runPostCommit } = require("./lib/post-commit-rows.js");
	await runPostCommit(
		{ cwd: process.cwd(), env: process.env },
		{ write: writeFd, interrupted: catchSignals() },
	);
	return 0;
}

module.exports = { main };

if (require.main === module) {
	const crash = /** @type {const} */ ({
		hook: "post-commit",
		said: "did not run",
		exit: 0,
	});
	try {
		require("./lib/hook-entry.js").exitWhenSettled(main, crash);
	} catch (e) {
		/* hook-entry.js prints the crash line, so a fault loading it prints
		 * here: bare, as write-fd.js may be what will not load (workflow-core#5207). */
		require("node:fs").writeSync(
			2,
			`${crash.hook}: the dispatcher ${crash.said}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
		);
		process.exit(crash.exit);
	}
}
