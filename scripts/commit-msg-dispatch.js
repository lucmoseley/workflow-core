#!/usr/bin/env node
/*
 * commit-msg-dispatch.js — .husky/commit-msg's dispatcher (#5207): runs every
 * row of lib/commit-msg-rows.js in this one process, through
 * lib/precommit-dispatch.js, on the commit route lib/commit-route.js reads.
 *
 *   node scripts/commit-msg-dispatch.js <message-file>
 *   node scripts/commit-msg-dispatch.js --print-route
 *
 * `--print-route` prints the route, one line, and runs no row: the hook hands
 * it to the adopter's `.husky/commit-msg.local` as `$route`.
 *
 * Exit 0 every armed row passed or stood down; a refusing row's own code
 * otherwise; 128 + n on signal n.
 */

const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { commitRoute } = require("./lib/commit-route.js");
const { ROWS } = require("./lib/commit-msg-rows.js");
const { catchSignals, hookGitDir } = require("./lib/hook-entry.js");
const { dispatch } = require("./lib/precommit-dispatch.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

/** This commit's route, as commit-msg reads it. */
const readRoute = () => commitRoute("commit-msg", hookGitDir(process.cwd()));

/** @returns {Promise<number>} */
async function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `node ${scriptPath("commit-msg-dispatch.js")} <message-file> | --print-route`,
		flags: { "--print-route": "boolean" },
		max: 1,
	});
	if (typeof parsed === "number") return parsed;
	if (parsed.flags["--print-route"]) {
		writeFd(1, `${readRoute()}\n`);
		return 0;
	}
	const file = parsed.positionals[0] ?? "";
	/* Read here, not in the port, so a route that will not read refuses: the
	 * port's fault would stand every row down. */
	const route = readRoute();
	const interrupted = catchSignals();
	return dispatch({
		rows: ROWS,
		gates: "all",
		voice: { hook: "commit-msg", noun: "check" },
		ports: {
			staged: () => [],
			computed: () => [],
			exists: () => false,
			load: (row) => () => row.run(file),
			write: writeFd,
			interrupted,
			route: () => route,
		},
	});
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(2, `commit-msg: the dispatcher threw: ${caught(e).message}\n`);
			process.exit(2);
		},
	);
