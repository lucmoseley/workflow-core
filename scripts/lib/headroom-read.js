/*
 * headroom-read.js — the guard-headroom-read core (#2784, #3225): a command that
 * reads memory is handed `rule:headroom-reap` before the session draws its
 * conclusion from the reading (mantahostels#1933).
 *
 * A reading is `free`, bar the help and version flags, which report no
 * memory and would spend the once-a-session delivery the real read needed —
 * NOT `-h`, free's human-readable flag. Or it is any word naming
 * /proc/meminfo, whatever the command. Words are read masked, so a quoted spelling is not seen.
 *
 * INJECTION ONLY — it never denies. Reading memory is the correct thing to do;
 * what the rule corrects is the conclusion drawn from the reading, which no
 * guard can observe. It fires on the read, not on the launch: a session that
 * stops on a short reading never launches, so the guard-suite-concurrency core
 * never fires.
 *
 * LIMITS
 *  - Its manifest row runs it only on a command its two `if` clauses admit,
 *    a `free` followed by a space or a word naming /proc/meminfo, so a bare
 *    `free` never reaches it (mantahostels#2811). A reading reached any other way — `vmstat`, `top`, a
 *    script, `memcheck` — states nothing.
 *  - It FAILS OPEN on anything it cannot resolve, except the rule store, which
 *    refuses the call on a fragment it cannot read or emit.
 *  - It guards the Bash tool. A reading taken outside Claude Code sees no hook.
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

module.exports = { field: "command", noun: "command", decide };
