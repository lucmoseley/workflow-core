const { scanFlags } = require("./shell-words.js");
const { compileEre } = require("./posix-ere.js");

const VALUE_FLAGS =
	"-d -g -G -O -P -r -s -t -u -U -F -q --delimiter --pgroup --group --older --parent --runstates --session --terminal --euid --uid --pidfile --signal --ns --nslist --queue --cgroup --env";

const SHELL_NAME = "bash";

const SIGNALS = new Set(
	"HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO PWR SYS RTMIN RTMAX".split(
		" ",
	),
);

const TRAPS = new Set(["EXIT", "ERR", "DEBUG", "RETURN"]);

/** @param {string} word */
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
 * @property {boolean} full
 * @property {boolean} icase
 * @property {boolean} exact
 * @property {boolean} invert
 * @property {boolean} ancestors
 * @property {string} pattern
 */

/**
 * @param {string[]} words
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
