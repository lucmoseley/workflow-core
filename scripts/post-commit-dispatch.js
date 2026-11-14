#!/usr/bin/env node
/*
 * post-commit-dispatch.js — .husky/post-commit's dispatcher (#5207): runs
 * every row of lib/post-commit-rows.js in this one process, through
 * lib/precommit-dispatch.js, on the commit route lib/commit-route.js reads.
 *
 *   node scripts/post-commit-dispatch.js
 *
 * Always exits 0, as the hook it serves never refuses: a row that throws
 * prints one line naming it and the rest run, and a dispatcher that cannot
 * load prints one line naming the fault.
 */

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */

/**
 * The registry's run under `io`, each row's output through `write`: the
 * wiring the entry below and the tests share.
 * @param {HookIo} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: import("./lib/post-commit-rows.js").PostCommitRow[],
 *   programs?: import("./lib/post-commit-steps.js").Programs,
 * }} opts `programs` absent, each row runs the real programs
 * @returns {Promise<number>}
 */
function runPostCommit(
	io,
	{ write, interrupted = async () => null, rows, programs },
) {
	const { commitRoute } = require("./lib/commit-route.js");
	const { readHookGitDir } = require("./lib/hook-entry.js");
	const { dispatch } = require("./lib/precommit-dispatch.js");
	const { ROWS } = require("./lib/post-commit-rows.js");
	return dispatch({
		rows: rows ?? ROWS,
		gates: "all",
		voice: { hook: "post-commit", noun: "step" },
		ports: {
			load: (row) => () => row.run(io, programs),
			write,
			interrupted,
			route: () => commitRoute("post-commit", readHookGitDir(io.cwd, io.env)),
		},
	});
}

/** @returns {Promise<number>} 0, whatever the rows did */
async function main() {
	const { writeFd } = require("./lib/write-fd.js");
	const { catchSignals } = require("./lib/hook-entry.js");
	await runPostCommit(
		{ cwd: process.cwd(), env: process.env },
		{ write: writeFd, interrupted: catchSignals() },
	);
	return 0;
}

module.exports = { runPostCommit };

if (require.main === module)
	require("./lib/hook-entry.js").exitWhenSettled(main, {
		hook: "post-commit",
		said: "did not run",
		exit: 0,
	});
