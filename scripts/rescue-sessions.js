#!/usr/bin/env node
/**
 * Move stuck /implement sessions from one Claude config dir (one Anthropic
 * subscription) to another, when the source plan has run out of allowance.
 *
 * mantahostels#2605.
 *
 * list, snapshot and stop take `--from <config-dir>`, defaulting to $CLAUDE_CONFIG_DIR.
 * Nothing here writes to the repo outside --out, or takeover's and hand-off's
 * .claude/tmp/rescue/; only `stop`, `takeover` and `hand-off` are not
 * read-only.
 *
 *   list      [--from D] [--state S]      what is stuck, and where its transcript is
 *   snapshot  [--from D] --out DIR [--ids] copy state + transcript, extract narration
 *   stop      [--from D] --ids a,b,c       stop them (snapshot FIRST -- see below)
 *   probe     (--issue N | --session ID) [--interval S]
 *                                          is one named session frozen? (#620)
 *   takeover  (--issue N | --session ID) [--interval S] [--confirm-within S]
 *             [--despite SLOW|ASKING --reason TEXT]
 *                                          stop it and adopt its ticket (#621);
 *                                          --despite overrules that verdict (#622);
 *                                          a GHOST is stopped, not adopted (#1989)
 *   hand-off  --from D --job SHORT [--session ID] --issue N [--issue M]
 *                                          snapshot a stopped job, post its
 *                                          Hand-off on each issue and release
 *                                          its claim, for a fresh session (#2659);
 *                                          of a job with no record, --session
 *                                          stands in for it (#3988)
 *
 * SNAPSHOT BEFORE YOU STOP.
 */

const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args");
const { HAND_OFF_USAGE } = require("./lib/rescue-takeover.js");

/** @typedef {import("./lib/rescue-jobs.js").ParsedArgs} ParsedArgs */

const HOLDER_USAGE = "(--issue <n> | --session <id>) [--interval <s>]";

/** @type {Record<string, import("./lib/cli-args").CommandSpec>} */
const SUBCOMMANDS = {
	list: {
		usage: "usage: rescue-sessions.js list [--from <config-dir>] [--state S]",
		flags: { "--from": "value", "--state": "value" },
	},
	snapshot: {
		usage:
			"usage: rescue-sessions.js snapshot [--from <config-dir>] --out DIR [--ids a,b,c]",
		flags: { "--from": "value", "--out": "value", "--ids": "value" },
	},
	stop: {
		usage: "usage: rescue-sessions.js stop [--from <config-dir>] --ids a,b,c",
		flags: { "--from": "value", "--ids": "value" },
	},
	probe: {
		usage: `usage: rescue-sessions.js probe ${HOLDER_USAGE}`,
		flags: { "--issue": "value", "--session": "value", "--interval": "value" },
	},
	takeover: {
		usage: `usage: rescue-sessions.js takeover ${HOLDER_USAGE} [--confirm-within <s>] [--despite SLOW|ASKING --reason "<text>"]`,
		flags: {
			"--issue": "value",
			"--session": "value",
			"--interval": "value",
			"--confirm-within": "value",
			"--despite": "value",
			"--reason": "value",
		},
	},
	"hand-off": {
		usage: HAND_OFF_USAGE,
		flags: {
			"--from": "value",
			"--job": "value",
			"--session": "value",
			"--issue": "list",
		},
	},
};

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: Object.values(SUBCOMMANDS)
		.map((c) => c.usage)
		.join("\n"),
	commands: SUBCOMMANDS,
};

/**
 * lib/cli-args.js's parseOrExit, keyed as the subcommands read it: each flag
 * without its `--`, the subcommand alone in `_`.
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
	const { command, flags, lists } = parseOrExit(argv, CLI);
	/** @type {ParsedArgs} */
	const out = { _: command ? [command] : [] };
	for (const [flag, value] of Object.entries({ ...flags, ...lists }))
		out[flag.slice(2)] = value;
	return out;
}

/**
 * The production adapters: the real oracle, `claude stop`, `gh`, clock,
 * sleep and /proc.
 * @returns {import("./lib/rescue-jobs.js").RescuePorts}
 */
function productionPorts() {
	const { gh } = require("./lib/gh.js");
	const { procRoot } = require("./lib/proc-root.js");
	return {
		env: process.env,
		now: Date.now,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		oracle: undefined,
		claude: undefined,
		gh,
		procRoot: procRoot(),
	};
}

/** The core entry each subcommand runs. */
const ENTRIES = {
	list: () => require("./lib/rescue-jobs.js").list,
	snapshot: () => require("./lib/rescue-jobs.js").snapshot,
	stop: () => require("./lib/rescue-jobs.js").stop,
	probe: () => require("./lib/rescue-probe.js").probe,
	takeover: () => require("./lib/rescue-takeover.js").takeover,
	"hand-off": () => require("./lib/rescue-takeover.js").handOff,
};

/** @param {string[]} [argv] */
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const run = ENTRIES[/** @type {keyof typeof ENTRIES} */ (args._[0])];
	const { status, stdout, stderr } = await run()(args, productionPorts());
	// writeFd: run through Bash, stdout is a pipe that process.exit truncates.
	writeFd(1, stdout);
	writeFd(2, stderr);
	process.exit(status);
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(2, `rescue-sessions: ${e?.stack ?? e}\n`);
		process.exit(1);
	});
