/*
 * shell-words.js — the guard parser's word helpers in Node (#2785, programme
 * #2733): given one command's words, masked as lib/shell-parse.js hands them
 * over, what do they say?
 *
 * A CORE: it does no I/O and reads nothing but its arguments. A word's quoted
 * spans arrive as the `spans` array lib/shell-parse.js's parseCommand records.
 *
 * Each behaviour here carries the ticket that set it.
 *
 * THE LOWER LAYER: lib/shell-parse.js reads its words through this file, the
 * span sentinel and its reader included, so neither requires the other.
 */

/**
 * The prefix a blanked quoted span is written as: each outermost span becomes
 * `${QUOTED}<index>\x01`, its text kept at `spans[index]` behind its quote
 * character (mantahostels#183).
 */
const QUOTED = "\x01QSTR\x01";

/** @param {string} s */
const hasExpansion = (s) => s.includes("$") || s.includes("`");

/**
 * A path word as an absolute path: as written where it starts at `/`, else
 * under `pwd`, one leading `./` dropped. Textual: nothing is resolved.
 * @param {string} p
 * @param {string} pwd
 */
const absolute = (p, pwd) =>
	p.startsWith("/") ? p : `${pwd}/${p.replace(/^\.\//, "")}`;

/**
 * Whether a word holds a pathname-expansion character, so an unquoted
 * expansion of it is globbed.
 * @param {string} s
 */
const isGlobPattern = (s) => /[*?[]/.test(s);

/**
 * A literal string as the regex source that matches it, `/` escaped too so
 * the source also stands inside a `/…/` literal.
 * @param {string} s
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The one walk over a masked text's span sentinels (#2785): `onSpan` is
 * handed the text before each sentinel and the span index read up to its
 * closing `\x01` — null where no index stands there — and answers what to
 * write for it and whether to step past the index. The four readers differ
 * only in that answer for a sentinel the masker never wrote.
 * @param {string} text
 * @param {(lit: string, idx: number | null) => { text: string, stepPast: boolean }} onSpan
 * @returns {{ out: string, rest: string }} what the sentinels gave, and the
 *   text after the last
 */
function readSentinels(text, onSpan) {
	let s = text;
	let out = "";
	while (s.includes(QUOTED)) {
		const at = s.indexOf(QUOTED);
		const lit = s.slice(0, at);
		s = s.slice(at + QUOTED.length);
		const digits = s.split("\x01")[0] ?? "";
		const r = onSpan(lit, /^[0-9]+$/.test(digits) ? Number(digits) : null);
		if (r.stepPast && s.includes("\x01")) s = s.slice(s.indexOf("\x01") + 1);
		out += r.text;
	}
	return { out, rest: s };
}

/**
 * A word whose quoted spans were blanked, put back: `{ text, known }`, the
 * text printed EITHER WAY so a caller can judge on the visible part, `known`
 * false where any of it could not be read — an unexpanded `$VAR`, a command
 * substitution, or a sentinel naming a span never recorded, which is read on
 * from right after its prefix.
 * @param {string} word
 * @param {string[]} spans
 */
function literal(word, spans) {
	let known = true;
	const { out, rest } = readSentinels(word, (lit, idx) => {
		if (hasExpansion(lit)) known = false;
		const recorded = idx === null ? undefined : spans[idx];
		if (recorded === undefined) {
			known = false;
			return { text: lit, stepPast: false };
		}
		const span = recorded.slice(1);
		/* A single-quoted span is literal whatever it holds. */
		if (recorded.charAt(0) !== "'" && hasExpansion(span)) known = false;
		return { text: lit + span, stepPast: true };
	});
	if (hasExpansion(rest)) known = false;
	return { text: out + rest, known };
}

/** A word as `read -ra` splits one line: on runs of IFS whitespace. */
const IFS_SPLIT = /[ \t\n]+/;

/** An assignment word, kept whole by unwrap and leading the harvest. */
const ASSIGNMENT_RE = /^[A-Za-z_].*=/s;

/**
 * A word's text after its last `/`, as bash's longest-prefix strip to a
 * slash reads a command word.
 * @param {string} w
 */
const afterSlash = (w) => w.slice(w.lastIndexOf("/") + 1);

/**
 * `basename`'s answer for a command word: a trailing `/` stripped first, `/`
 * itself kept.
 * @param {string} w
 */
function commandName(w) {
	const trimmed = w.replace(/\/+$/, "");
	return trimmed === "" && w !== "" ? "/" : afterSlash(trimmed);
}

/** @param {string} w a command word, read */
const isGhCommand = (w) => commandName(w) === "gh";

/**
 * The flags each wrapper takes its value from as a SEPARATE word, so the sweep
 * in unwrap steps two (mantahostels#2552).
 *
 * REQUIRED-value flags only. An OPTIONAL-value one takes its value joined or
 * not at all, so listing it here would eat the command word — which is why
 * `xargs -e[END]`, `-i[R]` and `-l[MAX]`, `sudo -h` (`--help` as readily as
 * `--host`) and `env`'s `--*-signal[=SIG]` family are absent, and adding any of
 * them for completeness reopens mantahostels#2552.
 *
 * `-u`, `-C`, `--unset` and `--chdir` are absent here: unwrap sweeps those four
 * for every wrapper, so `sudo -u`, `sudo -C` and `sudo --chdir` are already
 * covered.
 */
const WRAPPER_VALUE_FLAGS = new Map([
	["stdbuf", ["-i", "-o", "-e", "--input", "--output", "--error"]],
	["nice", ["-n", "--adjustment"]],
	[
		"ionice",
		["-c", "-n", "-p", "-P", "--class", "--classdata", "--pid", "--pgid"],
	],
	[
		"xargs",
		[
			"-a",
			"-d",
			"-E",
			"-I",
			"-L",
			"-n",
			"-P",
			"-s",
			"--arg-file",
			"--delimiter",
			"--max-lines",
			"--max-args",
			"--max-procs",
			"--max-chars",
			"--process-slot-var",
		],
	],
	[
		"sudo",
		[
			"-c",
			"-D",
			"-g",
			"-p",
			"-r",
			"-R",
			"-t",
			"-T",
			"-U",
			"--close-from",
			"--login-class",
			"--group",
			"--host",
			"--prompt",
			"--role",
			"--chroot",
			"--type",
			"--command-timeout",
			"--other-user",
			"--user",
		],
	],
]);

/** The wrappers stripped with nothing read but their flags. */
const PLAIN_WRAPPERS = [
	"nohup",
	"setsid",
	"time",
	"command",
	"stdbuf",
	"nice",
	"ionice",
	"xargs",
	"sudo",
];

/**
 * Strip the launcher wrappers off one command's words, so the command
 * actually being run stands first (mantahostels#2511, mantahostels#2524,
 * mantahostels#2552): `{ words, wrapperWords }`.
 *
 *   words         what is left to judge. Empty where the wrappers ran out of
 *                 words mid-strip; a caller must test that before reading
 *                 words[0]. It is NOT a promise that a command word stands
 *                 first — a malformed `bg-run.sh run` with no name leaves
 *                 `bg-run.sh run` standing.
 *   wrapperWords  the assignments an `env` carried, which a guard reading an
 *                 escape from the command string must still see — inside an
 *                 `env` prefix the escape is a WORD, not a leading shell
 *                 assignment the walk has already stepped past.
 *
 * `nohup FOO=1 cmd` execs a program literally named `FOO=1` and starts
 * nothing, so an assignment after any other wrapper is the command word and
 * stops the strip.
 *
 * `bg-run.sh run <name>` is stripped alongside the launchers: wrapping a suite
 * in the kill detector (mantahostels#1900) changes nothing about what the
 * suite then does. Its job NAME is free text and is never an escape.
 *
 * `sudo` IS STRIPPED, DELIBERATELY: stripping only ever widens what is judged.
 *
 * `env -S <string>` IS SPLIT, NOT SKIPPED. The string is the command, so
 * skipping it as an ordinary flag value would leave nothing to judge and allow
 * the launch. The split is `read -ra`'s, one line on IFS whitespace, so a
 * quote INSIDE the string stays welded to its word.
 *
 * THE WRAPPER CLASS IS STILL NOT CLOSED (mantahostels#2629). `sh -c "…"` stands
 * as the command word, its payload a blanked span; a heredoc's body never
 * reaches a split; and a separate-value flag absent from WRAPPER_VALUE_FLAGS
 * leaves its value where the command word is looked for.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @returns {{ words: string[], wrapperWords: string[] }}
 */
function unwrap(words, spans) {
	/** @type {Strip} */
	const st = { ws: [...words], inEnv: false, wrapperWords: [] };
	while (st.ws.length > 0) {
		const step = stripOne(st, spans);
		if (step === "cut") return { words: [], wrapperWords: st.wrapperWords };
		if (step === "done") break;
	}
	return { words: st.ws, wrapperWords: st.wrapperWords };
}

/**
 * @typedef {object} Strip unwrap's running state
 * @property {string[]} ws the words still to read
 * @property {boolean} inEnv whether the last wrapper was `env`, whose
 *   assignments are words of its own
 * @property {string[]} wrapperWords
 */

/**
 * Strip the wrapper `st.ws` opens with: "next" to read on, "done" where the
 * command word stands first, "cut" where the words ran out mid-strip.
 * @param {Strip} st
 * @param {string[]} spans
 * @returns {"next" | "done" | "cut"}
 */
function stripOne(st, spans) {
	/* An assignment keeps its whole word: the text after the last `/` of
	 * `A=/x/y` is `y`, which would stop the strip before a later `FOO=1`
	 * (#1499). */
	const first = st.ws[0] ?? "";
	const w = ASSIGNMENT_RE.test(first) ? first : afterSlash(first);
	if (w === "timeout") {
		const rest = skipTimeout(st.ws.slice(1));
		if (!rest) return "cut";
		st.inEnv = false;
		st.ws = rest;
		return "next";
	}
	if (w === "bg-run.sh") {
		if (st.ws[1] !== "run" || st.ws.length < 3) return "done";
		st.inEnv = false;
		st.ws = st.ws.slice(3);
		return "next";
	}
	if (w === "env" || PLAIN_WRAPPERS.includes(w)) st.inEnv = w === "env";
	else if (ASSIGNMENT_RE.test(w) && st.inEnv) st.wrapperWords.push(first);
	else return "done";
	st.ws = st.ws.slice(1);
	return sweepFlags(st, w, spans);
}

/** The flags unwrap sweeps with their SEPARATE value for every wrapper. */
const SWEPT_VALUE_FLAGS = ["-u", "-C", "--unset", "--chdir"];

/**
 * Sweep the flags after wrapper `w`. `-u NAME` and `-C DIR` take their value
 * as a SEPARATE word, so sweeping flags alone leaves `NAME` standing where the
 * command word is looked for; the joined spellings (`-uNAME`, `--unset=NAME`)
 * need nothing. Under `env`, a `-S` string is split into the words still to
 * read.
 * @param {Strip} st
 * @param {string} w
 * @param {string[]} spans
 * @returns {"next" | "cut"}
 */
function sweepFlags(st, w, spans) {
	while ((st.ws[0] ?? "").startsWith("-")) {
		const f = st.ws[0] ?? "";
		if (st.inEnv && isSplitString(f)) return splitEnvString(st, f, spans);
		const takes =
			SWEPT_VALUE_FLAGS.includes(f) ||
			(WRAPPER_VALUE_FLAGS.get(w)?.includes(f) ?? false);
		if (takes && st.ws.length < 2) return "cut";
		st.ws = st.ws.slice(takes ? 2 : 1);
	}
	return "next";
}

/** @param {string} f */
const isSplitString = (f) =>
	f === "-S" || f === "--split-string" || f.startsWith("--split-string=");

/**
 * Put an `env -S` string's words in its place.
 * @param {Strip} st
 * @param {string} f the flag word
 * @param {string[]} spans
 * @returns {"next" | "cut"}
 */
function splitEnvString(st, f, spans) {
	const rest = f.startsWith("--split-string=")
		? [f.slice("--split-string=".length), ...st.ws.slice(1)]
		: st.ws.slice(1);
	if (rest.length === 0) return "cut";
	st.ws = [...splitString(rest[0] ?? "", spans), ...rest.slice(1)];
	return "next";
}

/**
 * The words after `timeout`'s flags and its DURATION, a bare positional the
 * shared flag sweep would stop on; null where they run out.
 * @param {string[]} words the words after `timeout`
 */
function skipTimeout(words) {
	let ws = words;
	while ((ws[0] ?? "").startsWith("-")) {
		const takes = ["-k", "--kill-after", "-s", "--signal"].includes(
			ws[0] ?? "",
		);
		if (takes && ws.length < 2) return null;
		ws = ws.slice(takes ? 2 : 1);
	}
	return ws.length > 0 ? ws.slice(1) : null;
}

/**
 * An `env -S` string's words: read back through literal, its first line split
 * on IFS whitespace, as `read -ra` splits it.
 * @param {string} word
 * @param {string[]} spans
 */
const splitString = (word, spans) =>
	(literal(word, spans).text.split("\n")[0] ?? "")
		.split(IFS_SPLIT)
		.filter(Boolean);

/**
 * Does the command carry `name` set to a non-empty value (#1499), as an escape
 * a guard reads off the command string?
 *
 * Read from two sources and no other: the segment's own leading assignments,
 * and the assignments unwrap takes off an `env`. Spelled `env NAME=1 npm run
 * test`, the assignment is an argument to `env`, not a leading one
 * (mantahostels#2511, mantahostels#2524). A word after the command word —
 * `npm run test -- NAME=1` — is a flag value and no escape.
 *
 * guard-hook-escape.js refuses a wider set — empty values, `+=`, `export`,
 * `exec NAME=1` — and reads the two sources itself; this answer would loosen
 * it.
 * @param {string} name
 * @param {string[]} leading a walked Command's `leading`
 * @param {string[]} words its `words`
 * @param {string[]} spans
 */
function carriesVar(name, leading, words, spans) {
	const { wrapperWords } = unwrap(words, spans);
	return [...leading, ...wrapperWords].some(
		(w) => w.startsWith(`${name}=`) && w.length > name.length + 1,
	);
}

/** git's own options, before the subcommand, that take the next word. */
const GIT_VALUE_OPTIONS = [
	"-C",
	"-c",
	"--namespace",
	"--work-tree",
	"--git-dir",
	"--exec-path",
];

/** @param {string} w */
const isGitValueOption = (w) => GIT_VALUE_OPTIONS.includes(w);

/**
 * Where one command's words, past any launcher wrapper and git's own options,
 * are a `git` subcommand: `{ sub, args }`, the subcommand read through
 * literal and the words after it RAW (#2383). Null where the command is not
 * `git` or carries no subcommand. For a reader judging the command and not the
 * tree it runs against, which takes shell-parse.js's walkGit instead.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @returns {{ sub: string, args: string[] } | null}
 */
function gitWords(words, spans) {
	const ws = unwrap(words, spans).words;
	if (afterSlash(literal(ws[0] ?? "", spans).text) !== "git") return null;
	let i = 1;
	while ((ws[i] ?? "").startsWith("-")) {
		const step = isGitValueOption(ws[i] ?? "") ? 2 : 1;
		if (i + step > ws.length) return null;
		i += step;
	}
	if (i >= ws.length) return null;
	return { sub: literal(ws[i] ?? "", spans).text, args: ws.slice(i + 1) };
}

/**
 * One command's words from `gh`'s command word on, RAW, each still to be read
 * through literal (#772): `{ args, repo }`, `repo` the `-R`/`--repo` value
 * stepped over, raw, or "". Stepped over first: any launcher wrapper, a path to
 * the binary, and `gh`'s own flags before the command word, of which only
 * `-R`/`--repo` takes a value.
 *
 * Null where the command is not `gh`, or where `--help`/`-h` stands anywhere in
 * it: usage prints and dispatches nothing.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @returns {{ args: string[], repo: string } | null}
 */
function ghWords(words, spans) {
	const ws = unwrap(words, spans).words;
	if (!isGhCommand(literal(ws[0] ?? "", spans).text)) return null;
	const read = (/** @type {string} */ w) => literal(w, spans).text;
	const args = ws.slice(1);
	if (args.some((w) => read(w) === "--help" || read(w) === "-h")) return null;
	return stepGhFlags(args, read);
}

/**
 * Step `gh`'s own flags before the command word, keeping a `-R`/`--repo`
 * value; null where `-R` has none left. literal's `known` is ignored: a flag
 * carrying an expansion (`--repo=$R`) is still a flag to step over.
 * @param {string[]} words
 * @param {(w: string) => string} read
 * @returns {{ args: string[], repo: string } | null}
 */
function stepGhFlags(words, read) {
	let args = words;
	let repo = "";
	for (
		let f = read(args[0] ?? "");
		f.startsWith("-");
		f = read(args[0] ?? "")
	) {
		const raw = args[0] ?? "";
		let step = 1;
		if (f === "-R" || f === "--repo") {
			if (args.length < 2) return null;
			repo = args[1] ?? "";
			step = 2;
		} else if (f.startsWith("--repo=")) repo = stripPrefix(raw, "--repo=");
		else if (f.startsWith("-R")) repo = stripPrefix(raw, "-R");
		args = args.slice(step);
	}
	return { args, repo };
}

/**
 * `${w#prefix}`: `w` with `prefix` off its front where it stands there. The
 * test is on the literal, the cut on the raw word.
 * @param {string} w
 * @param {string} prefix
 */
const stripPrefix = (w, prefix) =>
	w.startsWith(prefix) ? w.slice(prefix.length) : w;

/** node's own flags that take the next word, which commitPathsArgs steps. */
const NODE_VALUE_FLAGS = [
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
];

/**
 * Where the command words are a `node …/commit-paths.js` call, the arguments
 * after the script; null otherwise. That call runs no `git` a walk sees, so a
 * guard judging commits reads it here (#1727, #2022).
 *
 * Judged on the visible text: a `"$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js`
 * spelling hides its directory and keeps its basename. Residual: a node flag
 * taking a value outside NODE_VALUE_FLAGS leaves the value in the script's
 * place, and the call is not recognised.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @returns {string[] | null}
 */
function commitPathsArgs(words, spans) {
	const ws = unwrap(words, spans).words;
	const head = afterSlash(literal(ws[0] ?? "", spans).text);
	if (head !== "node" && head !== "nodejs") return null;
	let i = 1;
	while ((ws[i] ?? "").startsWith("-")) {
		const step = NODE_VALUE_FLAGS.includes(ws[i] ?? "") ? 2 : 1;
		if (i + step > ws.length) return null;
		i += step;
	}
	const script = afterSlash(literal(ws[i] ?? "", spans).text);
	return script === "commit-paths.js" ? ws.slice(i + 1) : null;
}

/**
 * commitPathsArgs's words split as commit-paths.js's parseArgs splits them
 * (#2147): the words after `--` into `paths`, the `--patch` word into `patch`,
 * the message's `-m` or `-F` into `messageFlag` and its word into `message`
 * (#2383), and `tree` for a `--tree` call. A value is never an option, so
 * `-m --` stays a message. Null where commit-paths.js would refuse the option
 * words: an unknown option, `--help` among them, one missing its value, or a
 * second message or `--patch`. The words stay masked, for literal.
 * @param {string[]} args
 * @param {string[]} spans
 * @returns {CommitPathsCall | null}
 */
function commitPathsParse(args, spans) {
	/** @type {CommitPathsCall} */
	const out = {
		paths: [],
		patch: "",
		messageFlag: "",
		message: "",
		tree: false,
	};
	for (let i = 0; i < args.length; i++) {
		const opt = literal(args[i] ?? "", spans).text;
		if (opt === "--") return { ...out, paths: args.slice(i + 1) };
		if (opt === "--tree") out.tree = true;
		else if (takeCommitValue(out, opt, args[i + 1])) i++;
		else return null;
	}
	return out;
}

/**
 * @typedef {object} CommitPathsCall
 * @property {string[]} paths
 * @property {string} patch
 * @property {string} messageFlag
 * @property {string} message
 * @property {boolean} tree
 */

/**
 * Take `value` for option `opt` into `out`; false where commit-paths.js would
 * refuse it — an unknown option, no value left, or a second message or patch.
 * @param {CommitPathsCall} out
 * @param {string} opt
 * @param {string | undefined} value
 */
function takeCommitValue(out, opt, value) {
	if (value === undefined || !["-m", "-F", "--patch"].includes(opt))
		return false;
	if (opt === "--patch") {
		if (out.patch) return false;
		out.patch = value;
		return true;
	}
	if (out.messageFlag) return false;
	out.messageFlag = opt;
	out.message = value;
	return true;
}

/** The words that open a `find` expression, beside any starting `-`. */
const FIND_EXPRESSION_OPENERS = ["(", "\\(", "!", "\\!", ","];

/**
 * A `find`'s start points, masked, for literal to read: the words after its
 * leading options (`-H`, `-L`, `-P`, `-D <opts>`, `-O<n>`, `--`) and before the
 * first word opening an expression — one starting `-`, or `(`, `!`, `,`. Empty
 * means `find` defaults to `.`.
 * @param {string[]} words the words after `find`
 * @param {string[]} spans
 * @returns {string[]}
 */
function findStarts(words, spans) {
	const read = (/** @type {number} */ i) => literal(words[i] ?? "", spans).text;
	/** @type {string[]} */
	const starts = [];
	for (let i = skipFindOptions(words.length, read); i < words.length; i++) {
		const w = read(i);
		if (w.startsWith("-") || FIND_EXPRESSION_OPENERS.includes(w)) break;
		starts.push(words[i] ?? "");
	}
	return starts;
}

/**
 * The index past `find`'s leading options; `n` where a `-D` runs out of
 * words, which leaves no start point.
 * @param {number} n
 * @param {(i: number) => string} read
 */
function skipFindOptions(n, read) {
	let i = 0;
	for (; i < n; i++) {
		const w = read(i);
		if (w === "-D") {
			if (i + 1 >= n) return n;
			i++;
		} else if (w === "--") return i + 1;
		else if (!["-H", "-L", "-P"].includes(w) && !w.startsWith("-O")) break;
	}
	return i;
}

/**
 * @typedef {"opt" | "flag" | "dangling" | "arg"} FlagKind
 *   opt       a value-taking flag, and the value it took
 *   flag      a flag taking no value
 *   dangling  a value-taking flag with no value left to take
 *   arg       a bare word, its name ""
 */

/**
 * Read one command's own arguments and hand `fn` one event per option or bare
 * word (mantahostels#477): `fn(kind, name, value)`. `fn` returning false stops
 * the scan, and scanFlags returns false too; else it returns true.
 *
 * `spec` is the space-separated list of the flags that TAKE A VALUE, short and
 * long together — "-c --comment -R --repo". Every other flag takes none.
 *
 * A BARE `--` ENDS THE OPTIONS: it is emitted as `flag --`, and every word
 * after it is an `arg` however it is spelled, as git and gh (pflag) both parse
 * it (mantahostels#495). A lone `-` is stdin, a `flag`, not a bare word.
 *
 * A `--flag=value` is read as name and value WHATEVER `spec` says.
 *
 * A SHORT-FLAG RUN IS WALKED CHARACTER BY CHARACTER, and a value-taking letter
 * takes the rest of the run: `-qr` is -q then -r, `-Xtheirs` is -X with the
 * value theirs. A leading = on such a value is dropped: pflag takes `-l=x` as
 * x. A SHORT FLAG WHOSE VALUE IS OPTIONAL is listed with a trailing ?, as
 * `-S?`: it takes the rest of its run as a value, but never the next word, and
 * keeps a leading =, as git does.
 * @param {string} spec
 * @param {string[]} words
 * @param {(kind: FlagKind, name: string, value: string) => boolean | undefined | void} fn
 */
function scanFlags(spec, words, fn) {
	/** @type {ScanCtx} */
	const ctx = {
		has: (flag) => ` ${spec} `.includes(` ${flag} `),
		emit: (kind, name, value) => {
			if (fn(kind, name, value) === false) ctx.stopped = true;
		},
		ended: false,
		stopped: false,
	};
	for (let i = 0; i < words.length && !ctx.stopped; i++)
		i += scanWord(words[i] ?? "", words[i + 1], ctx);
	return !ctx.stopped;
}

/**
 * @typedef {object} ScanCtx
 * @property {(flag: string) => boolean} has whether the spec lists `flag`
 * @property {(kind: FlagKind, name: string, value: string) => void} emit
 *   sets `stopped` where the caller stopped the scan
 * @property {boolean} ended past a bare `--`
 * @property {boolean} stopped the caller returned false
 */

/**
 * One word's events: how many words after it it took.
 * @param {string} tok
 * @param {string | undefined} next
 * @param {ScanCtx} ctx
 * @returns {number}
 */
function scanWord(tok, next, ctx) {
	const { emit } = ctx;
	if (ctx.ended || !tok.startsWith("-")) emit("arg", "", tok);
	else if (tok === "-") emit("flag", "-", "");
	else if (tok === "--") {
		ctx.ended = true;
		emit("flag", "--", "");
	} else if (tok.startsWith("--")) return scanLong(tok, next, ctx);
	else return scanShortRun(tok.slice(1), next, ctx);
	return 0;
}

/**
 * A `--flag` or `--flag=value`.
 * @param {string} tok
 * @param {string | undefined} next
 * @param {ScanCtx} ctx
 * @returns {number}
 */
function scanLong(tok, next, { has, emit }) {
	const eq = tok.indexOf("=");
	if (eq >= 0) emit("opt", tok.slice(0, eq), tok.slice(eq + 1));
	else if (!has(tok)) emit("flag", tok, "");
	else if (next === undefined) emit("dangling", tok, "");
	else {
		emit("opt", tok, next);
		return 1;
	}
	return 0;
}

/**
 * One short-flag run, `-` off, letter by letter until a value-taking letter
 * takes the rest.
 * @param {string} run
 * @param {string | undefined} next
 * @param {ScanCtx} ctx
 * @returns {number}
 */
function scanShortRun(run, next, ctx) {
	for (let j = 0; j < run.length && !ctx.stopped; j++) {
		const name = `-${run.charAt(j)}`;
		if (ctx.has(`${name}?`) || ctx.has(name))
			return scanValueLetter(name, run.slice(j + 1), next, ctx);
		ctx.emit("flag", name, "");
	}
	return 0;
}

/**
 * A value-taking letter, `val` the rest of its run: an optional-value one
 * (`-S?`) takes that rest alone, `=` kept; a required one drops a leading `=`,
 * else takes the next word.
 * @param {string} name
 * @param {string} val
 * @param {string | undefined} next
 * @param {ScanCtx} ctx
 * @returns {number}
 */
function scanValueLetter(name, val, next, { has, emit }) {
	if (has(`${name}?`)) {
		if (val) emit("opt", name, val);
		else emit("flag", name, "");
	} else if (val) emit("opt", name, val.replace(/^=/, ""));
	else if (next === undefined) emit("dangling", name, "");
	else {
		emit("opt", name, next);
		return 1;
	}
	return 0;
}

/**
 * The scanFlags spec for `merge`, `rebase` or `commit`, shared by the pull
 * and commit form guards (#302); "" for any other subcommand.
 *
 * Derived from `git <sub> -h`, then each entry measured on git 2.43.0: `git
 * <sub> <flag> --bogus other` reports --bogus as the flag's bad value where the
 * flag swallows the next word. The help text alone misleads twice: `-m` under
 * rebase is --merge and takes nothing, and `-S`, `--gpg-sign`, `--log` and
 * rebase's `-r` print a value but take one only when stuck on. The long
 * optional-value flags are absent because scanFlags reads `--flag=value`
 * unprompted.
 * @param {string} sub
 */
function gitValueFlags(sub) {
	switch (sub) {
		case "merge":
			return "-s -X -m -F -S? --strategy --strategy-option --message --file --cleanup --into-name";
		case "rebase":
			return "-s -X -x -C -S? -r? --strategy --strategy-option --onto --exec --whitespace --empty";
		case "commit":
			return "-m -c -C -F -t --message --author --date --file --template --reedit-message --reuse-message --fixup --squash --cleanup --trailer --pathspec-from-file";
		default:
			return "";
	}
}

module.exports = {
	QUOTED,
	absolute,
	hasExpansion,
	isGlobPattern,
	escapeRe,
	readSentinels,
	literal,
	unwrap,
	carriesVar,
	commandName,
	isGhCommand,
	isGitValueOption,
	gitWords,
	ghWords,
	commitPathsArgs,
	commitPathsParse,
	findStarts,
	scanFlags,
	gitValueFlags,
};
