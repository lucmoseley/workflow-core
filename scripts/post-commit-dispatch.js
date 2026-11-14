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

const { writeFd } = require("./lib/write-fd.js");

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */

/**
 * The registry's run under `io`, each row's output through `write`: the
 * wiring the entry below and the tests share.
 * @param {HookIo} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: import("./lib/post-commit-rows.js").PostCommitRow[],
 * }} opts
 * @returns {Promise<number>}
 */
function runPostCommit(io, { write, interrupted = async () => null, rows }) {
	const { commitRoute } = require("./lib/commit-route.js");
	const { hookGitDir } = require("./lib/hook-entry.js");
	const { dispatch } = require("./lib/precommit-dispatch.js");
	const { ROWS } = require("./lib/post-commit-rows.js");
	return dispatch({
		rows: rows ?? ROWS,
		gates: "all",
		voice: { hook: "post-commit", noun: "step" },
		ports: {
			staged: () => [],
			computed: () => [],
			exists: () => false,
			load: (row) => () => row.run(io),
			write,
			interrupted,
			route: () => commitRoute("post-commit", hookGitDir(io.cwd, io.env)),
		},
	});
}

/** @returns {Promise<void>} */
async function main() {
	const { catchSignals } = require("./lib/hook-entry.js");
	await runPostCommit(
		{ cwd: process.cwd(), env: process.env },
		{ write: writeFd, interrupted: catchSignals() },
	);
}

module.exports = { runPostCommit };

if (require.main === module)
	main().then(
		() => process.exit(0),
		(e) => {
			writeFd(
				2,
				`post-commit: the dispatcher did not run: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`,
			);
			process.exit(0);
		},
	);
