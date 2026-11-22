#!/usr/bin/env node
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

module.exports = { main };

if (require.main === module) {
	const crash = /** @type {const} */ ({
		hook: "prepare-commit-msg",
		said: "threw",
		exit: 2,
	});
	try {
		require("./lib/hook-entry.js").exitWhenSettled(main, crash);
	} catch (e) {
		require("node:fs").writeSync(
			2,
			`${crash.hook}: the dispatcher ${crash.said}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
		);
		process.exit(crash.exit);
	}
}
