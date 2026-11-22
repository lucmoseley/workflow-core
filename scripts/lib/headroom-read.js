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

module.exports = { field: "command", noun: "command", decide };
