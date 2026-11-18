#!/usr/bin/env node
/*
 * commit-msg-dispatch.js — .husky/commit-msg's dispatcher (workflow-core#5207): runs every
 * row of lib/commit-msg-rows.js in this one process, through
 * lib/precommit-dispatch.js, on the commit route lib/commit-route.js reads.
 *
 *   node scripts/commit-msg-dispatch.js [--route-file <path>] <message-file>
 *
 * `--route-file` writes the route to <path>, one line, before any row runs:
 * the hook hands it to the adopter's `.husky/commit-msg.local` as `$route`
 * (workflow-core#5215).
 *
 * Exit 0 every armed row passed or stood down; a refusing row's own code
 * otherwise; 128 + n on signal n.
 */

/** This commit's route, as commit-msg reads it. */
function readRoute() {
	const { commitRoute } = require("./lib/commit-route.js");
	const { readHookGitDir } = require("./lib/hook-entry.js");
	return commitRoute("commit-msg", readHookGitDir(process.cwd()));
}

/**
 * Every lib is loaded here, not at the top, so a lib that will not load
 * prints the one crash line.
 * @returns {Promise<number>}
 */
async function main() {
	const { parseOrCode } = require("./lib/cli-args.js");
	const { ROWS } = require("./lib/commit-msg-rows.js");
	const { catchSignals } = require("./lib/hook-entry.js");
	const { dispatch } = require("./lib/precommit-dispatch.js");
	const { scriptPath } = require("./lib/script-path.js");
	const { writeFd } = require("./lib/write-fd.js");
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `node ${scriptPath("commit-msg-dispatch.js")} [--route-file <path>] <message-file>`,
		flags: { "--route-file": "value" },
		max: 1,
	});
	if (typeof parsed === "number") return parsed;
	const file = parsed.positionals[0] ?? "";
	/* Read here, not in the port, so a route that will not read refuses: the
	 * port's fault would stand every row down. */
	const route = readRoute();
	const routeFile = parsed.flags["--route-file"];
	if (typeof routeFile === "string") {
		require("node:fs").writeFileSync(routeFile, `${route}\n`);
	}
	const interrupted = catchSignals();
	return dispatch({
		rows: ROWS,
		gates: "all",
		voice: { hook: "commit-msg", noun: "check" },
		ports: {
			load: (row) => () => row.run(file),
			write: writeFd,
			interrupted,
			route: () => route,
		},
	});
}

module.exports = { main };

if (require.main === module) {
	const crash = /** @type {const} */ ({
		hook: "commit-msg",
		said: "threw",
		exit: 2,
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
