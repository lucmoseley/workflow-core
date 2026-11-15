#!/usr/bin/env node
/*
 * prepare-commit-msg-dispatch.js — .husky/prepare-commit-msg's dispatcher
 * (#5207): runs every row of lib/prepare-commit-msg-rows.js in this one
 * process, through lib/precommit-dispatch.js, on the commit route
 * lib/commit-route.js reads.
 *
 *   node scripts/prepare-commit-msg-dispatch.js --husky <dir> [<message-file> [<source> [<sha>]]]
 *
 * `--husky` is the hook's own directory, which holds the `pre-commit` the
 * inline path runs; the steps' scripts are read from WFC_PLUGIN_ROOT, else
 * the directory above it. The rest is what git hands the hook; only the
 * message file is read.
 *
 * BEFORE ANY ROW, in this order: the pre-commit stamp is read and DELETED,
 * so a stamp that outlived its commit stands down no later one; the route is
 * read, and a route that will not read refuses rather than gating the commit
 * as an ordinary one (#1503); and the index's tree is written, to match the
 * stamp against.
 *
 * Exit 0 every armed row passed or stood down; a refusing row's own code
 * otherwise, 2 where a row or this entry threw; 128 + n on signal n.
 */

/** @returns {Promise<number>} */
async function main() {
	const { flagValue, parseOrCode } = require("./lib/cli-args.js");
	const { catchSignals } = require("./lib/hook-entry.js");
	const { scriptPath } = require("./lib/script-path.js");
	const { writeFd } = require("./lib/write-fd.js");
	const usage = `node ${scriptPath("prepare-commit-msg-dispatch.js")} --husky <dir> [<message-file> [<source> [<sha>]]]\n`;
	const parsed = parseOrCode(process.argv.slice(2), {
		usage,
		flags: { "--husky": "value" },
		max: 3,
	});
	if (typeof parsed === "number") return parsed;
	const husky = flagValue(parsed.flags, "--husky");
	if (husky === undefined) {
		writeFd(2, `--husky is required\n${usage}`);
		return 2;
	}
	const { runPrepareCommitMsg } = require("./lib/prepare-commit-msg-rows.js");
	return runPrepareCommitMsg(
		{ cwd: process.cwd(), env: process.env },
		{
			write: writeFd,
			husky,
			file: parsed.positionals[0] ?? "",
			interrupted: catchSignals(),
		},
	);
}

if (require.main === module) {
	const crash = /** @type {const} */ ({
		hook: "prepare-commit-msg",
		said: "threw",
		exit: 2,
	});
	try {
		require("./lib/hook-entry.js").exitWhenSettled(main, crash);
	} catch (e) {
		/* hook-entry.js prints the crash line, so a fault loading it prints
		 * here: bare, as write-fd.js may be what will not load (#5207). */
		require("node:fs").writeSync(
			2,
			`${crash.hook}: the dispatcher ${crash.said}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
		);
		process.exit(crash.exit);
	}
}
