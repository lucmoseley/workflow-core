/*
 * ugrep-pattern.js — the guard-ugrep-pattern core (#2801, #3227, programme #2733):
 * does a bare `grep` pattern carry a bounded repeat that Claude Code's bundled
 * ugrep may refuse (#1021), and does the command discard the stderr that
 * would say so?
 *
 * A CORE: it does no I/O.
 *
 * WHY. Whether ugrep refuses depends on the repeat sizes (#1021), so any
 * ranged repeat is warned on. WARN, NOT DENY (#1021 Q1): the pattern often
 * works, and only the exit status tells the session which happened.
 *
 * ITS ROW'S `Bash(grep *)` CLAUSE IS ANCHORED on purpose: only a bare `grep` is
 * the function, and every wrapper the unanchored form would admit — `xargs
 * grep`, `command grep`, `timeout 5 grep` — execs GNU grep instead. Not folded
 * into lib/recursive-dot-read.js, the one core already reading `grep` on every
 * Bash call: this narrowing is what spares the rest.
 *
 * ADVISORY: a throw is allowed, logged — its row fails open — and so is every
 * payload fault the kit names (mantahostels#103 §6, mantahostels#147).
 *
 * IT WARNS, NEVER DENIES, and once per (agent, session): the note rides as
 * the kit's prelude and latches `warn.ugrep-pattern` after it is written, the
 * marker lib/guard-entry.js's latchPath names.
 *
 * A WORD IT CANNOT READ — an unexpanded `$VAR`, a command substitution — is
 * skipped, unrecorded: on the hand-off list it hands nothing off, as a pattern
 * it is unjudged. A missed warning costs one unexplained exit 2; a record per
 * `grep "$x"` would bury the error log.
 *
 * LIMITS
 *  - The command word must be exactly `grep`. `egrep` and `fgrep` are
 *    /usr/bin's GNU scripts here, and a path spelling is GNU grep too.
 *  - The function hands a call to GNU grep when an argument matches its own
 *    list (`-z`, `-Z`, `--null`, `--null-data`, `--config`, `--filter`, …),
 *    which drifts with Claude Code.
 *  - A pattern is the first bare word, or every `-e`/`--regexp` value. A `-f`
 *    pattern file is unread.
 *  - Repeats read: ERE `{N,M}`/`{,M}`/`{N,}` where `-E` came after any `-G`,
 *    else BRE `\{N,M\}`, the function passing `-G` first. An exact `{N}` is
 *    not warned on alone, and a brace inside a bracket expression (`[{1,3}]`)
 *    is warned on wrongly.
 *  - A discarded stderr is read from this grep's own redirects: `2>/dev/null`,
 *    `2>&-`, `&>/dev/null`, and `>/dev/null 2>&1`. Any other route to
 *    /dev/null — a wrapping `{ …; } 2>/dev/null`, an `exec 2>` — warns without
 *    the stderr sentence.
 *  - A compaction clears the latch.
 */

const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

const LATCH = "ugrep-pattern";

/* Flags taking a value, read off ugrep's own `--help`. Its optional-value
 * flags (`--group-separator[=SEP]`, `--config[=FILE]`) are absent: listed,
 * they would eat the pattern. */
const UGREP_VALUE_FLAGS =
	"-A -B -C -D -J -K -M -N -O -d -e -f -g -m -t --regexp --file --max-count --after-context --before-context --context --directories --devices --jobs --range --file-magic --neg-regexp --file-extension --file-type --glob --iglob --include --exclude --exclude-dir --exclude-from --include-dir --include-from --binary-files --and --andnot --not";

/* The function's own hand-off to GNU grep: its case globs, copied from Claude
 * Code 2.1.295. */
const GNU_HANDOFF =
	/^(?:-[\s\S]*-(?:filter|pager|view|format-open|config)|---|-@|-[Zz]|-[^-][\s\S]*[Zz]|--null$|--null-data$)/;

const ERE_REPEAT = /(?:^|[^\\])\{(?:[0-9]+,[0-9]*|,[0-9]+)\}/;
const BRE_REPEAT = /\\\{(?:[0-9]+,[0-9]*|,[0-9]+)\\\}/;

/* Each flag's say in the mode; the last of -E and -G wins, -P and -F win from
 * anywhere. */
const MODE_FLAGS = new Map([
	["-P", "perl"],
	["--perl-regexp", "perl"],
	["-F", "fixed"],
	["--fixed-strings", "fixed"],
	["-E", "ere"],
	["--extended-regexp", "ere"],
	["-G", "bre"],
	["--basic-regexp", "bre"],
]);

/* The value flags whose value is a pattern; `-f` names a file of them. */
const PATTERN_OPTS = ["-e", "--regexp", "--and", "--andnot", "--not"];
const FILE_OPTS = ["-f", "--file"];

const NOTE_HEAD =
	'`grep` here is Claude Code\'s bundled ugrep, and a bounded repeat in its pattern — `.{0,80}`, say — can make it refuse the pattern with `exceeds complexity limits` or stall on a long line (#1021). A refused pattern exits 2, not 1: exit 2 is no verdict, never "no match".';
const NOTE_SILENCED =
	" This command discards stderr, which is what hides the refusal.";
const NOTE_TAIL =
	"\n\nRe-spell it as the same command with `-P` in place of `-E`, or added where there is neither, every other flag kept and the backslashes taken off a `\\{N,M\\}`. A pattern of literals, `.`, bracket classes and bounded repeats prints what the refused command would have; an alternation, or a basic-mode `( ) | + ?`, can match differently under `-P`. Or use `rg` or python. Warned once a session; docs/agents/tool-output.md.";

/**
 * @typedef {import("./kit-context.js").KitContext} UgrepContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Redirect} Redirect
 * @typedef {{ fires: boolean, silenced: boolean }} Verdict whether some grep
 *   fires, and whether some firing grep's stderr is discarded
 */

/**
 * @param {string} command
 * @param {UgrepContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	if (ctx.told(LATCH)) return null;
	const parsed = parseCommand(command);
	/** @type {Verdict} */
	const verdict = { fires: false, silenced: false };
	walkCommands(
		parsed,
		(cmd) => {
			if (!judge(cmd.words, parsed.spans)) return;
			verdict.fires = true;
			if (silencesStderr(cmd.redirects())) verdict.silenced = true;
		},
		ctx,
	);
	if (!verdict.fires) return null;
	return {
		injectRules: [],
		prelude: ctx.corePaths(note(verdict.silenced)),
		latchAfter: LATCH,
	};
}

/**
 * @param {boolean} silenced
 */
const note = (silenced) =>
	`${NOTE_HEAD}${silenced ? NOTE_SILENCED : ""}${NOTE_TAIL}`;

/**
 * Whether one command is a bare `grep` the function keeps whose pattern holds
 * a ranged repeat in the mode it reads.
 * @param {string[]} words the command's own words, masked
 * @param {string[]} spans
 */
function judge(words, spans) {
	const [head, ...args] = words;
	if (literal(head ?? "", spans).text !== "grep") return false;
	if (args.some((w) => handsOff(w, spans))) return false;
	const scan = scanPatterns(args);
	if (scan.mode.has("perl") || scan.mode.has("fixed")) return false;
	const repeat = scan.ere ? ERE_REPEAT : BRE_REPEAT;
	return scan.patterns.some((p) => {
		const { text, known } = literal(p, spans);
		return known && repeat.test(text);
	});
}

/**
 * Whether the function hands this word's call to GNU grep; a word it cannot
 * read hands nothing off.
 * @param {string} word
 * @param {string[]} spans
 */
function handsOff(word, spans) {
	const { text, known } = literal(word, spans);
	return known && GNU_HANDOFF.test(text);
}

/**
 * The flags' modes, whether ERE is the one in force, and the patterns: every
 * `-e`-style value, else the first bare word — none where `-f` names a file.
 * @param {string[]} args
 */
function scanPatterns(args) {
	/** @type {Set<string>} */
	const mode = new Set();
	let ere = false;
	let byFlag = false;
	/** @type {string[]} */
	const patterns = [];
	/** @type {string[]} */
	const bare = [];
	scanFlags(UGREP_VALUE_FLAGS, args, (kind, name, value) => {
		if (kind === "flag") {
			const m = MODE_FLAGS.get(name);
			if (m) mode.add(m);
			if (m === "ere" || m === "bre") ere = m === "ere";
		} else if (kind === "arg") bare.push(value);
		else if (kind === "opt") byFlag = takeOpt(name, value, patterns) || byFlag;
	});
	if (!byFlag && bare.length > 0) patterns.push(bare[0] ?? "");
	return { mode, ere, patterns };
}

/**
 * Takes an `-e`-style value into `patterns`; whether this option names the
 * patterns itself, which an `-f` file does too.
 * @param {string} name
 * @param {string} value
 * @param {string[]} patterns accumulator: every `-e`-style value so far
 */
function takeOpt(name, value, patterns) {
	if (PATTERN_OPTS.includes(name)) patterns.push(value);
	return PATTERN_OPTS.includes(name) || FILE_OPTS.includes(name);
}

/**
 * Whether these redirects, read in the order written as bash applies them,
 * discard stderr: `>/dev/null 2>&1` does, `2>&1 >/dev/null` keeps it.
 * @param {Redirect[]} redirects
 */
function silencesStderr(redirects) {
	let silenced = false;
	let nullOut = false;
	for (const r of redirects) {
		const writes = r.kind === "truncate" || r.kind === "append";
		if (r.fd === "1") nullOut = writes && r.path === "/dev/null";
		else if (discardsStderr(r, writes, nullOut)) silenced = true;
	}
	return silenced;
}

/**
 * Whether this one redirect sends stderr nowhere, given whether stdout
 * already goes to /dev/null.
 * @param {Redirect} r
 * @param {boolean} writes
 * @param {boolean} nullOut
 */
function discardsStderr({ fd, kind, path, target }, writes, nullOut) {
	if ((fd === "&" || fd === "2") && writes && path === "/dev/null") return true;
	if (fd !== "2") return false;
	return kind === "close" || (kind === "copy" && nullOut && target === "1");
}

module.exports = { field: "command", noun: "command", decide };
