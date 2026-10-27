/*
 * paste-self-match.js — the judging half of guard-paste-self-match.js (workflow-core#921):
 * given one `!` paste block the agent is handing the founder, name every
 * `pgrep -f`/`pkill -f` in it whose pattern matches the block's own text — or,
 * under `-v`, misses it (workflow-core#1814) — and every `pgrep`/`pkill` without `-f` whose
 * pattern matches the shell's name, `bash`, or under `-v` misses it (workflow-core#1842).
 *
 * Why that is the whole condition: a `!` line runs as one shell whose command
 * line is the pasted text, and `-f` matches full command lines — so a pattern
 * that matches the paste matches the founder's own shell, and `-v`, selecting
 * every process the pattern misses, selects that shell when it misses. Without
 * `-f` the pattern is tested against process names instead, the same way.
 *
 * A CORE: no I/O. The block is read by lib/shell-parse.js exactly as a Bash
 * tool call is — the same segment split and flag reader lib/self-match.js
 * uses on the agent's own commands — and each fail-open goes to `log`.
 *
 * PASSES, as lib/self-match.js does: a segment naming `$$` or `$PPID`, unless
 * inverted, which naming the shell never spares. Per segment here, not per
 * command, since a paste is longer than a tool call. Also `-A`, which spares
 * pkill's ancestors — the founder's shell among them. Under `-x` the pattern
 * must match the whole paste, so it is tested anchored.
 *
 * FAILS OPEN, logged: a pattern carrying an expansion it cannot read, and a
 * pattern that does not compile as an extended regex — pgrep compiles it the
 * same way, so a compile failure here is one there too.
 *
 * LIMITS
 *  - The command line pgrep sees may differ from the paste by however the
 *    harness wraps a `!` command; the paste text is the subject, as workflow-core#921 rules.
 *    A pattern aimed at the wrapper's words (`[b]ash`) therefore passes, and
 *    under `-v` is refused though its match spares the shell. The shell's name
 *    is taken to be `bash`, the Bash tool's, which a `!` command shares.
 *  - A `-v` pattern that spares the shell still selects the harness and nearly
 *    everything else; only the shell is judged.
 *  - A pattern reached through a wrapper (`sudo pkill`, `xargs pkill`) is not
 *    seen: only a segment's own command word is read, as in lib/self-match.js.
 */

const { asWritten, parseCommand, walkCommands } = require("./shell-parse.js");
const { literal } = require("./shell-words.js");
const { SHELL_NAME, pgrepSelects, readPgrepArgs } = require("./pgrep-args.js");

/**
 * @typedef {{ verdict: "kill" | "read", segment: string, pattern: string,
 *   relation: "matches" | "misses", against: "paste" | "name" }} PasteFinding
 *   the segment as written and the pattern as pgrep reads it, each on one line
 */

/** @param {string} s */
const oneLine = (s) => s.replace(/[\t\n]/g, " ");

/**
 * @param {string} paste the block, its `!` off
 * @param {(what: string, detail?: string) => void} log the fail-open record
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
		{ cwd: undefined, fallbackCwd: "/", vars: {}, isDir: () => false },
	);
	return out;
}

/**
 * One command of the paste: its finding, or null where it selects nothing
 * the founder's shell is.
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
