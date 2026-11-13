/*
 * rescue-cli.js — rescue-sessions.js's subcommands (#5157): the flags each
 * takes, its parsed arguments, and the core entry it runs. The shell runs
 * them on production's ports; lib/rescue-core-kit.ts on the fakes.
 */

const { parseOrExit } = require("./cli-args");
const { HAND_OFF_USAGE } = require("./rescue-takeover.js");

/** @typedef {import("./rescue-jobs.js").ParsedArgs} ParsedArgs */

const HOLDER_USAGE = "(--issue <n> | --session <id>) [--interval <s>]";

/** @type {Record<string, import("./cli-args").CommandSpec>} */
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

/** @type {import("./cli-args").CliSpec} */
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

/** The core entry each subcommand runs. */
const ENTRIES = {
	list: () => require("./rescue-jobs.js").list,
	snapshot: () => require("./rescue-jobs.js").snapshot,
	stop: () => require("./rescue-jobs.js").stop,
	probe: () => require("./rescue-probe.js").probe,
	takeover: () => require("./rescue-takeover.js").takeover,
	"hand-off": () => require("./rescue-takeover.js").handOff,
};

module.exports = { ENTRIES, parseArgs };
