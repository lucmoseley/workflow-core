#!/usr/bin/env node

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
		/* #5207 */
		require("node:fs").writeSync(
			2,
			`${crash.hook}: the dispatcher ${crash.said}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
		);
		process.exit(crash.exit);
	}
}
