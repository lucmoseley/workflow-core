/*
 * pgrep-args.js — a pgrep or pkill's arguments read as procps-ng reads them,
 * and whether the pattern they carry selects a given text (#2790). Shared by
 * lib/self-match.js, which judges the agent's own Bash calls, and
 * lib/paste-self-match.js, which judges a `!` paste handed to the founder.
 *
 * A CORE: no I/O. The pattern is compiled as pgrep compiles it, by
 * lib/posix-ere.js.
 */

const { scanFlags } = require("./shell-words.js");
const { compileEre } = require("./posix-ere.js");

/**
 * The value-taking flags of procps-ng pgrep/pkill (`pkill --help`), so a value
 * is never read as the pattern: `pkill -u lucmo -f x` has pattern x, not lucmo.
 */
const VALUE_FLAGS =
	"-d -g -G -O -P -r -s -t -u -U -F -q --delimiter --pgroup --group --older --parent --runstates --session --terminal --euid --uid --pidfile --signal --ns --nslist --queue --cgroup --env";

/**
 * The name a pgrep/pkill without -f tests its pattern against, for the shell
 * running it: the Bash tool and a `!` paste both run under /bin/bash.
 */
const SHELL_NAME = "bash";

/** The signal names `kill -l` lists on Linux, without their SIG. */
const SIGNALS = new Set(
	"HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS RTMIN RTMAX".split(
		" ",
	),
);

/** The trap names bash's `kill -l` also accepts, never with a SIG. */
const TRAPS = new Set(["EXIT", "ERR", "DEBUG", "RETURN"]);

/**
 * Whether a word is a signal spelled as an option — `-9`, `-STOP`, `-SIGTERM`
 * — dropped before the flag read, as pkill drops it: walked letter by letter,
 * `-TSTP`'s P would read as `-P` swallowing the next word. `-F`, `-P` and the
 * other capital flags name no signal, so they are never dropped. The names and
 * numbers are those bash's `kill -l` accepts.
 * @param {string} word
 */
function isSignalWord(word) {
	if (/^-[0-9]+$/.test(word)) {
		const n = Number(word.slice(1));
		return n <= 64 || (n >= 129 && n <= 192);
	}
	if (!/^-(SIG)?[A-Z][A-Z0-9+-]*$/.test(word)) return false;
	const bare = word.slice(1);
	if (TRAPS.has(bare)) return true;
	const name = bare.replace(/^SIG/, "");
	if (SIGNALS.has(name)) return true;
	const rt = /^RT(MIN\+|MAX-)([0-9]+)$/.exec(name);
	if (!rt) return false;
	const n = Number(rt[2]);
	return rt[1] === "MIN+" ? n <= 30 : n >= 1 && n <= 14;
}

/**
 * @typedef {object} PgrepArgs
 * @property {boolean} full -f: the pattern is tested against whole command
 *   lines, else against process names
 * @property {boolean} icase
 * @property {boolean} exact
 * @property {boolean} invert -v: every process the pattern misses
 * @property {boolean} ancestors -A: the calling shell and its ancestors are
 *   spared
 * @property {string} pattern the first bare word, "" where there is none
 */

/**
 * @param {string[]} words a pgrep or pkill's arguments, its own name off
 * @returns {PgrepArgs}
 */
function readPgrepArgs(words) {
	const a = {
		full: false,
		icase: false,
		exact: false,
		invert: false,
		ancestors: false,
		pattern: "",
	};
	/** @type {Record<string, "full" | "icase" | "exact" | "invert" | "ancestors">} */
	const Flags = {
		"-f": "full",
		"--full": "full",
		"-i": "icase",
		"--ignore-case": "icase",
		"-x": "exact",
		"--exact": "exact",
		"-v": "invert",
		"--inverse": "invert",
		"-A": "ancestors",
		"--ignore-ancestors": "ancestors",
	};
	scanFlags(
		VALUE_FLAGS,
		words.filter((w) => !isSignalWord(w)),
		(kind, name, value) => {
			const flag = Flags[name];
			if (kind === "flag" && flag) a[flag] = true;
			else if (kind === "arg" && a.pattern === "") a.pattern = value;
		},
	);
	return a;
}

/**
 * Whether a pgrep/pkill reading `pattern` as its literal pattern, under
 * `args`'s exact, icase and invert, selects `subject`: "invalid" where the
 * pattern will not compile, so pgrep refuses it and kills nothing.
 * @param {string} subject
 * @param {string} pattern
 * @param {Pick<PgrepArgs, "exact" | "icase" | "invert">} args
 * @returns {"selects" | "spares" | "invalid"}
 */
function pgrepSelects(subject, pattern, { exact, icase, invert }) {
	const re = compileEre(exact ? `^(${pattern})$` : pattern, { icase });
	if (re === null) return "invalid";
	return re.test(subject) === invert ? "spares" : "selects";
}

module.exports = {
	SHELL_NAME,
	isSignalWord,
	pgrepSelects,
	readPgrepArgs,
};
