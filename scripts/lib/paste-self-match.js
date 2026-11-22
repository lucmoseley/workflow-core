const {
	asWritten,
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
} = require("./shell-parse.js");
const { literal } = require("./shell-words.js");
const { SHELL_NAME, pgrepSelects, readPgrepArgs } = require("./pgrep-args.js");

/**
 * @typedef {{ verdict: "kill" | "read", segment: string, pattern: string,
 *   relation: "matches" | "misses", against: "paste" | "name" }} PasteFinding
 */

/** @param {string} s */
const oneLine = (s) => s.replace(/[\t\n]/g, " ");

/**
 * @param {string} paste
 * @param {(what: string, detail?: string) => void} log
 * @returns {PasteFinding[]}
 */
function scanPaste(paste, log) {
	const parsed = parseCommand(paste);
	/** @type {PasteFinding[]} */
	const out = [];
	walkCommands(
		parsed,
		(c) => {
			const f = judgeSegment(c, parsed.spans, paste, log);
			if (f) out.push(f);
		},
		TEXT_ONLY_PORTS,
	);
	return out;
}

/**
 * @param {import("./shell-parse.js").Command} c
 * @param {string[]} spans
 * @param {string} paste
 * @param {(what: string, detail?: string) => void} log
 * @returns {PasteFinding | null}
 */
function judgeSegment(c, spans, paste, log) {
	const word = c.words[0] ?? "";
	const cmd = word.slice(word.lastIndexOf("/") + 1);
	if (cmd !== "pgrep" && cmd !== "pkill") return null;
	const a = readPgrepArgs(c.words.slice(1));
	if (a.ancestors || a.pattern === "") return null;
	const written = asWritten(c.segment, spans);
	if (!a.invert && (written.includes("$$") || written.includes("$PPID")))
		return null;
	const lit = literal(a.pattern, spans);
	if (!lit.known) {
		log("pattern carries an expansion — not judged", written);
		return null;
	}
	const sel = pgrepSelects(a.full ? paste : SHELL_NAME, lit.text, a);
	if (sel === "invalid") {
		log("pattern did not compile as a regex — not judged", lit.text);
		return null;
	}
	if (sel === "spares") return null;
	return {
		verdict: cmd === "pkill" ? "kill" : "read",
		segment: oneLine(written),
		pattern: oneLine(lit.text),
		relation: a.invert ? "misses" : "matches",
		against: a.full ? "paste" : "name",
	};
}

module.exports = { scanPaste };
