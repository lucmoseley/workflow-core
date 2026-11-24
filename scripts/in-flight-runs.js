#!/usr/bin/env node
// #5716
const { writeFd } = require("./lib/write-fd.js");
const idSeam = require("./lib/session-id.js");
const { parseOrCode } = require("./lib/cli-args.js");
const {
	commitRefusal,
	readInFlightRuns,
	runList,
	touchedRuns,
	waitForRuns,
} = require("./lib/in-flight-runs.js");

const EXIT = { USAGE: 2, REFUSED: 3, UNREAD: 4, CEILING: 5 };

const CLI = {
	usage: `usage: node ${__filename} commit <declared command>
       node ${__filename} wait`,
	commands: {
		commit: {
			usage: `usage: node ${__filename} commit <declared command>`,
			min: 1,
		},
		wait: { usage: `usage: node ${__filename} wait` },
	},
};

/**
 * @typedef {{ env?: NodeJS.ProcessEnv, read?: typeof readInFlightRuns, out?: (s: string) => void, err?: (s: string) => void, wait?: Parameters<typeof waitForRuns>[1] }} MainOptions
 */

/**
 * @param {string[]} argv
 * @param {MainOptions} [options]
 * @returns {Promise<number>}
 */
async function main(
	argv,
	{
		env = process.env,
		read = readInFlightRuns,
		out = (s) => writeFd(1, s),
		err = (s) => writeFd(2, s),
		wait,
	} = {},
) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const session = idSeam.fromEnv(env);
	if (parsed.command === "commit") {
		if (!session) return 0;
		const runs = read(session);
		if (runs === null) {
			err(
				"pre-commit: this session's test-run records would not read, so the commit goes ahead without checking for an in-flight touched run (#5716).\n",
			);
			return 0;
		}
		const held = touchedRuns(runs);
		if (held.length === 0) return 0;
		err(commitRefusal(held, parsed.positionals[0] ?? ""));
		return EXIT.REFUSED;
	}
	if (!session) {
		err(
			"in-flight-runs: no session id (CLAUDE_CODE_SESSION_ID is unset), so there is no session's run to wait on.\n",
		);
		return EXIT.USAGE;
	}
	const result = await waitForRuns(() => read(session), wait);
	if (result.verdict === "UNREAD") {
		err(
			"UNREAD: the run records would not read, so this wait cannot see the session's test runs; wait on the run's own notification instead.\n",
		);
		return EXIT.UNREAD;
	}
	if (result.verdict === "CEILING") {
		out(
			`CEILING: after ${result.ceilingS} s this session still holds ${runList(result.runs)}; re-run this wait to keep waiting.\n`,
		);
		return EXIT.CEILING;
	}
	out(
		"DONE: this session holds no live touched, named or changed test run; read each run's notification for its verdict.\n",
	);
	return 0;
}

if (require.main === module)
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			writeFd(2, `in-flight-runs: ${e}\n`);
			process.exitCode = EXIT.USAGE;
		},
	);

module.exports = { main };
