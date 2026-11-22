#!/usr/bin/env node
function readRoute() {
	const { commitRoute } = require("./lib/commit-route.js");
	const { readHookGitDir } = require("./lib/hook-entry.js");
	return commitRoute("commit-msg", readHookGitDir(process.cwd()));
}

// #5207
/**
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
		// #5207
		require("node:fs").writeSync(
			2,
			`${crash.hook}: the dispatcher ${crash.said}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
		);
		process.exit(crash.exit);
	}
}
