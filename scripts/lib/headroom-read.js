/*
 * headroom-read.js — guard-headroom-read.js's core (#2784): a command that
 * reads memory is handed `rule:headroom-reap` before the session draws its
 * conclusion from the reading (mantahostels#1933).
 *
 * A reading is `free`, bar the help and version flags, which report no
 * memory and would spend the once-a-session delivery the real read needed —
 * NOT `-h`, free's human-readable flag. Or it is any word naming
 * /proc/meminfo, whatever the command. Words are read masked, so a quoted spelling is not seen.
 */

const { parseCommand, walkCommands } = require("./shell-parse.js");

const NO_READING = new Set(["--help", "-V", "--version"]);

/** @param {string[]} words */
function isMemoryRead(words) {
	const [head, ...args] = words;
	if (head === "free") return !args.some((a) => NO_READING.has(a));
	return words.some((w) => w.endsWith("/proc/meminfo"));
}

/**
 * @param {string} command
 * @param {import("./shell-parse.js").WalkPorts} ports
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ports) {
	let reads = false;
	walkCommands(
		parseCommand(command),
		(cmd) => {
			if (isMemoryRead(cmd.words)) reads = true;
		},
		ports,
	);
	return reads ? { injectRules: ["headroom-reap"] } : null;
}

module.exports = { decide };
