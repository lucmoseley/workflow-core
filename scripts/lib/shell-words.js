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

const { trimEndRun } = require("./trim-run.js");

/**
 * The prefix a blanked quoted span is written as: each outermost span becomes
 * `${QUOTED}<index>\x01`, its text kept at `spans[index]` behind its quote
 * character (mantahostels#183). A `\x01` typed outside every quote is a BARE
 * span, kept as written with no quote, so no typed text reads as a sentinel
 * (#4278).
 */
const QUOTED = "\x01QSTR\x01";

/** The byte a sentinel opens and closes on. */
const SENTINEL_BYTE = "\x01";

/** @param {string} recorded a span as recorded */
const isBareSpan = (recorded) => !["'", '"'].includes(recorded.charAt(0));

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
 * write for it and whether to step past the index.
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
		const digits = beforeFirst(s, "\x01");
		const r = onSpan(lit, /^[0-9]+$/.test(digits) ? Number(digits) : null);
		if (r.stepPast && s.includes("\x01")) s = s.slice(s.indexOf("\x01") + 1);
		out += r.text;
	}
	return { out, rest: s };
}

/**
 * `s` up to the first `sep`, or all of `s` where it carries none.
 * @param {string} s
 * @param {string} sep
 */
const beforeFirst = (s, sep) => {
	const at = s.indexOf(sep);
	return at < 0 ? s : s.slice(0, at);
};

/** What a `"…"` span's backslash escapes; any other backslash there stays. */
const DOUBLE_ESCAPES = '$`"\\\n';

/**
 * Whether `c`, followed by `next`, is a backslash escaping it.
 * @param {string} c
 * @param {string} next
 * @param {boolean} double whether inside a `"…"` span
 */
const isEscape = (c, next, double) =>
	c === "\\" && next !== "" && (!double || DOUBLE_ESCAPES.includes(next));

/**
 * Masked text outside a single-quoted span, read as bash reads it (#3518):
 * `{ text, at, bare }`, `text` with each backslash escape undone — unquoted
 * `\x` is `x`, a `"…"` span's per DOUBLE_ESCAPES — `at` where in `text` its
 * first unescaped `$` or `` ` `` stands, -1 where none does, and `bare`
 * `text` with every quoted or escaped character as `\0`, for braceAt. The
 * masker already dropped an unquoted backslash-newline.
 * @param {string} s
 * @param {boolean} double whether `s` is a `"…"` span's text
 */
function parseEscapes(s, double) {
	let text = "";
	let bare = "";
	let at = -1;
	for (let i = 0; i < s.length; i++) {
		const c = s.charAt(i);
		const next = s.charAt(i + 1);
		if (isEscape(c, next, double)) {
			const kept = next === "\n" ? "" : next;
			text += kept;
			bare += "\0".repeat(kept.length);
			i++;
		} else {
			if (at < 0 && (c === "$" || c === "`")) at = text.length;
			text += c;
			bare += double ? "\0" : c;
		}
	}
	return { text, at, bare };
}

/**
 * Where the first brace group bash would expand opens in a word's `bare`
 * reading (#3578): an unquoted `{` not after a `$`, closed by its matching
 * `}`, holding a `,` or `..` at its own depth — `{a,b}`, `{1..3}`. -1 where
 * none does. Any `..` counts, though bash expands only a well-formed
 * sequence, so the error is a word read as unknown.
 * @param {string} bare
 */
function braceAt(bare) {
	for (let i = 0; i < bare.length; i++)
		if (
			bare.charAt(i) === "{" &&
			bare.charAt(i - 1) !== "$" &&
			hasBraceSplit(bare, i)
		)
			return i;
	return -1;
}

/**
 * Whether the `{` at `open` in `bare` is closed and holds a `,` or `..` at
 * its own depth. A `}` closing it before either is literal to bash, which
 * scans on: `{x}y,main}` is `x}y` and `main`.
 * @param {string} bare
 * @param {number} open
 */
function hasBraceSplit(bare, open) {
	let depth = 0;
	let sep = false;
	for (let j = open; j < bare.length; j++) {
		const c = bare.charAt(j);
		if (c === "{") depth++;
		else if (c === "}" && depth === 1 && sep) return true;
		else if (c === "}" && depth > 1) depth--;
		else if (depth === 1 && (c === "," || bare.startsWith("..", j))) sep = true;
	}
	return false;
}

/**
 * A word whose quoted spans were blanked, put back: `{ text, known, head }`,
 * the text as bash reads it, backslash escapes undone (#3518), printed
 * EITHER WAY so a caller can judge on the visible part, `known` false where
 * any of it could not be read — an unescaped `$VAR`, a command substitution,
 * an unquoted brace group bash expands into several words (#3578), or a
 * sentinel naming a span never recorded, which is read on from right after
 * its prefix — and `head` the text before the first of them, so text the
 * shell reads as written (#3441).
 * @param {string} word
 * @param {string[]} spans
 */
function literal(word, spans) {
	/** @type {string | null} */
	let head = null;
	let seen = "";
	let bare = "";
	/**
	 * `text` onto `seen` and its `bare` reading onto `bare`, so the two stay
	 * index-aligned for braceAt's cut.
	 * @param {string} text
	 * @param {string} bareText
	 */
	const append = (text, bareText) => {
		seen += text;
		bare += bareText;
	};
	/**
	 * @param {string} s the text after `seen`
	 * @param {boolean} double whether it is a `"…"` span's
	 */
	const readOn = (s, double) => {
		const r = parseEscapes(s, double);
		if (head === null && r.at >= 0) head = seen + r.text.slice(0, r.at);
		append(r.text, r.bare);
	};
	const { rest } = readSentinels(word, (lit, idx) => {
		readOn(lit, false);
		const recorded = idx === null ? undefined : spans[idx];
		if (recorded === undefined) {
			head ??= seen;
			return { text: "", stepPast: false };
		}
		const span = recorded.slice(1);
		/* A single-quoted span is literal whatever it holds. */
		if (isBareSpan(recorded)) readOn(recorded, false);
		else if (recorded.charAt(0) === "'") append(span, "\0".repeat(span.length));
		else readOn(span, true);
		return { text: "", stepPast: true };
	});
	readOn(rest, false);
	const brace = braceAt(bare);
	/* tsc narrows `head` to null, blind to the closures' writes. */
	const exprHead = /** @type {string | null} */ (head);
	const braceFirst =
		brace >= 0 && (exprHead === null || brace < exprHead.length);
	const unknownHead = braceFirst ? seen.slice(0, brace) : exprHead;
	return {
		text: seen,
		known: unknownHead === null,
		head: unknownHead ?? seen,
	};
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
	const trimmed = trimEndRun(w, "/");
	return trimmed === "" && w !== "" ? "/" : afterSlash(trimmed);
}

/** @param {string} w a command word, read */
const isGhCommand = (w) => commandName(w) === "gh";

/**
 * One interpreter's options (#4479). `program` maps each
 * flag that settles where the program comes from: `inline` its value, as
 * `-c`; `script` a module it names, as python's `-m`; `stdin`, as a shell's
 * `-s`. `valued` takes a value, attached or the next word. `bundles` is
 * whether short options combine, `-uc` and `-Wignore`: node's do not, its
 * `-pe` being one alias. `plus` is whether `+o` spells an option too, as a
 * shell's does. `valued` lists the common flags only, so an unlisted one's
 * value reads as the script.
 * @typedef {"inline" | "script" | "stdin"} ProgramSource
 * @typedef {{ program: Record<string, ProgramSource>, valued: Set<string>,
 *   bundles: boolean, plus: boolean }} InterpreterFlags
 */

/** @type {InterpreterFlags} */
const SHELL_FLAGS = {
	program: { "-c": "inline", "-s": "stdin" },
	valued: new Set(["-o", "-O", "--rcfile", "--init-file"]),
	bundles: true,
	plus: true,
};

/** @type {Record<string, InterpreterFlags>} */
const INTERPRETER_FLAGS = {
	node: {
		program: {
			"-e": "inline",
			"--eval": "inline",
			"-p": "inline",
			"--print": "inline",
			"-pe": "inline",
		},
		valued: new Set([
			"-r",
			"--require",
			"--import",
			"--loader",
			"--experimental-loader",
			"-C",
			"--conditions",
			"--input-type",
			"--env-file",
			"--title",
		]),
		bundles: false,
		plus: false,
	},
	python: {
		program: { "-c": "inline", "-m": "script" },
		valued: new Set(["-W", "-X", "--check-hash-based-pycs"]),
		bundles: true,
		plus: false,
	},
	perl: {
		program: { "-e": "inline", "-E": "inline" },
		valued: new Set(),
		bundles: false,
		plus: false,
	},
	ruby: {
		program: { "-e": "inline" },
		valued: new Set(["-r", "-I", "-C"]),
		bundles: false,
		plus: false,
	},
	bash: SHELL_FLAGS,
	sh: SHELL_FLAGS,
	dash: SHELL_FLAGS,
	zsh: SHELL_FLAGS,
};

/**
 * The flag table an interpreter's command name reads by.
 * @param {string} name
 */
function interpreterFlags(name) {
	if (/^python([0-9].*)?$/.test(name)) return INTERPRETER_FLAGS.python;
	return INTERPRETER_FLAGS[name === "nodejs" ? "node" : name];
}

/**
 * What one option word says: where the program comes from, where a flag in it
 * or a bare `-` settles that, else whether the next word is a flag's value.
 * @param {InterpreterFlags} flags
 * @param {string} word
 * @returns {{ source: ProgramSource } | { takesNext: boolean }}
 */
function parseOption(flags, word) {
	if (word === "-") return { source: "stdin" };
	const names =
		flags.bundles && !word.startsWith("--")
			? [...word.slice(1)].map((c) => `-${c}`)
			: [word.split("=")[0] ?? word];
	for (const [at, name] of names.entries()) {
		const source = flags.program[name];
		if (source) return { source };
		if (flags.valued.has(name))
			return { takesNext: at === names.length - 1 && !word.includes("=") };
	}
	return { takesNext: false };
}

/**
 * Where an interpreter's words take its program from (#3456, #4479):
 * `inline` from an inline-code flag's value, `script` from a file or module
 * named, `stdin` where the options end with no program word, at `-` or with
 * a stdin flag. `script` is the word naming a script, absent for a module.
 * The scan stops at the program, since a flag past it is the program's own.
 * @param {string} interpreter the command name, read
 * @param {string[]} words the words after it
 * @returns {{ source: ProgramSource, script?: string } | null}
 */
function programSource(interpreter, words) {
	const flags = interpreterFlags(interpreter);
	if (!flags) return null;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === undefined) break;
		if (word === "--") return scriptAt(words, i + 1);
		if (!isOption(flags, word)) return { source: "script", script: word };
		const option = parseOption(flags, word);
		if ("source" in option) return { source: option.source };
		if (option.takesNext) i++;
	}
	return { source: "stdin" };
}

/**
 * @param {InterpreterFlags} flags
 * @param {string} word
 */
const isOption = (flags, word) =>
	word.startsWith("-") || (flags.plus && /^\+./.test(word));

/**
 * @param {string[]} words
 * @param {number} at
 */
function scriptAt(words, at) {
	const script = words[at];
	return script === undefined
		? { source: /** @type {const} */ ("stdin") }
		: { source: /** @type {const} */ ("script"), script };
}

/**
 * One wrapper's options, read through scanFlags's word reader (#4046): `values`
 * its spec, the flags taking a value, and `long` every whole long name, each
 * readable by any prefix naming just one. `sudo`'s is from its manual, unmeasured.
 * @typedef {object} WrapperGrammar
 * @property {string} values
 * @property {string[]} long
 * @property {string} [chdir] the short flag naming its working directory
 * @property {boolean} [splits] whether `-S` is a string to split, as `env`'s is
 * @property {number} positionals bare words it reads before the command
 * @property {"sh-string" | "flock-command"} [command] how the words after them
 *   read
 */

/**
 * @param {string} values
 * @param {string} flags the long names taking no separate value, space-separated
 * @param {Partial<Pick<WrapperGrammar, "chdir" | "splits" | "positionals" | "command">>} [rest]
 * @returns {WrapperGrammar}
 */
function buildGrammar(values, flags, rest = {}) {
	const valued = values
		.split(" ")
		.filter((f) => f.startsWith("--"))
		.map((f) => f.slice(2));
	return {
		values,
		long: [...valued, ...flags.split(" ").filter(Boolean), "help", "version"],
		positionals: 0,
		...rest,
	};
}

/** The launcher wrappers unwrap strips, by the name they run under. */
const WRAPPERS = new Map([
	[
		"env",
		buildGrammar(
			"-u -C -S --unset --chdir --split-string",
			"ignore-environment null block-signal default-signal ignore-signal list-signal-handling debug",
			{ chdir: "-C", splits: true },
		),
	],
	[
		"sudo",
		buildGrammar(
			"-C -c -D -g -h? -p -R -r -T -t -U -u --close-from --chdir --group --host --login-class --prompt --chroot --role --type --command-timeout --other-user --user",
			"askpass background bell preserve-env edit set-home login remove-timestamp reset-timestamp list non-interactive preserve-groups stdin shell validate",
			{ chdir: "-D" },
		),
	],
	["nohup", buildGrammar("", "")],
	["builtin", buildGrammar("", "")],
	["exec", buildGrammar("-a", "")],
	["command", buildGrammar("", "")],
	["setsid", buildGrammar("", "ctty fork wait")],
	[
		"time",
		buildGrammar("-f -o --format --output", "append portability quiet verbose"),
	],
	["stdbuf", buildGrammar("-i -o -e --input --output --error", "")],
	["nice", buildGrammar("-n --adjustment", "")],
	[
		"ionice",
		buildGrammar(
			"-c -n -p -P -u --class --classdata --pid --pgid --uid",
			"ignore",
		),
	],
	[
		"xargs",
		buildGrammar(
			"-a -d -E -e? -I -i? -L -l? -n -P -s --arg-file --delimiter --max-args --max-procs --process-slot-var --max-chars",
			"null eof replace max-lines interactive open-tty no-run-if-empty verbose show-limits exit",
		),
	],
	[
		"timeout",
		buildGrammar(
			"-k -s --kill-after --signal",
			"foreground preserve-status verbose",
			{ positionals: 1 },
		),
	],
	[
		"flock",
		buildGrammar(
			"-w -E -c --timeout --wait --conflict-exit-code --command",
			"shared exclusive unlock nonblock nb close no-fork verbose",
			{ positionals: 1, command: "flock-command" },
		),
	],
	["taskset", buildGrammar("", "all-tasks pid cpu-list", { positionals: 1 })],
	[
		"watch",
		buildGrammar(
			"-d? -n -q --interval --equexit",
			"beep color no-color differences errexit chgexit precise no-rerun no-title no-wrap exec",
			{ command: "sh-string" },
		),
	],
]);

/**
 * Strip the launcher wrappers off one command's words, so the command
 * actually being run stands first (mantahostels#2511, mantahostels#2524,
 * mantahostels#2552): `{ words, wrapperWords, watched }`. A wrapper, its flags
 * and an `env` assignment are read through literal as the shell hands them to it
 * (#4046); the words left stay raw.
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
 *   chdirs        each directory an `env -C` or `sudo -D` moved to, read through
 *                 literal, in order.
 *   watched       a `watch` was stripped: the command reruns on a timer.
 *
 * `nohup FOO=1 cmd` execs a program literally named `FOO=1` and starts
 * nothing, so an assignment after any other wrapper is the command word and
 * stops the strip. `env` and `sudo` take any word holding a `=` as one, and no
 * flag after the first.
 *
 * `bg-run.sh run <name>` is stripped alongside the launchers: wrapping a suite
 * in the kill detector (mantahostels#1900) changes nothing about what the
 * suite then does. Its job NAME is free text and is never an escape.
 *
 * `sudo` IS STRIPPED, DELIBERATELY: stripping only ever widens what is judged.
 *
 * `watch` AND `flock <file> -c` RUN THEIR COMMAND THROUGH `sh -c`, so the words
 * holding it are split on whitespace (#3376, #4046); a quote, a `;` or a second
 * line inside them is not read.
 *
 * `env -S <string>` IS SPLIT, NOT SKIPPED, as `env` splits it, and read on as
 * `env`'s own words.
 *
 * THE WRAPPER CLASS IS STILL NOT CLOSED (mantahostels#2629). `sh -c "…"` stands
 * as the command word, its payload a blanked span; a heredoc's body never
 * reaches a split; and a launcher outside WRAPPERS, `chrt` and `unshare` among
 * them, stands as the command word.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @param {string[]} [judged] wrappers the caller judges itself, left standing
 *   as the command word
 * @returns {{ words: string[], wrapperWords: string[], chdirs: string[],
 *   watched: boolean }}
 */
function unwrap(words, spans, judged = []) {
	/** @type {Strip} */
	const st = {
		ws: [...words],
		judged,
		inEnv: false,
		wrapperWords: [],
		chdirs: [],
		watched: false,
	};
	for (let first = st.ws[0]; first !== undefined; first = st.ws[0]) {
		const step = stripOne(st, first, spans);
		if (step === "cut") st.ws = [];
		if (step !== "next") break;
	}
	return {
		words: st.ws,
		wrapperWords: st.wrapperWords,
		chdirs: st.chdirs,
		watched: st.watched,
	};
}

/**
 * @typedef {object} Strip unwrap's running state
 * @property {string[]} ws the words still to read
 * @property {string[]} judged wrappers left standing as the command word
 * @property {boolean} inEnv whether the last wrapper was `env` or `sudo`, whose
 *   assignments are words of its own
 * @property {string[]} wrapperWords
 * @property {string[]} chdirs
 * @property {boolean} watched
 */

/**
 * Strip the wrapper `st.ws` opens with: "next" to read on, "done" where the
 * command word stands first, "cut" where the words ran out mid-strip.
 * @param {Strip} st accumulator: its fields are written
 * @param {string} first `st.ws[0]`
 * @param {string[]} spans
 * @returns {"next" | "done" | "cut"}
 */
function stripOne(st, first, spans) {
	const { text } = literal(first, spans);
	if (st.inEnv && text.includes("=")) {
		/* Raw where its name is bare, so a guard still reads its value's quoting. */
		st.wrapperWords.push(ASSIGNMENT_RE.test(first) ? first : text);
		st.ws = st.ws.slice(1);
		return "next";
	}
	/* An assignment keeps its whole word: the text after the last `/` of
	 * `A=/x/y` is `y`, which would stop the strip before a later `FOO=1`
	 * (#1499). */
	const w = ASSIGNMENT_RE.test(text) ? text : afterSlash(text);
	if (w === "bg-run.sh") {
		if (st.ws[1] !== "run" || st.ws.length < 3) return "done";
		st.inEnv = false;
		st.ws = st.ws.slice(3);
		return "next";
	}
	const wrapper = WRAPPERS.get(w);
	if (!wrapper || st.judged.includes(w)) return "done";
	st.inEnv = w === "env" || w === "sudo";
	st.ws = st.ws.slice(1);
	if (!sweepFlags(st, wrapper, spans)) return "cut";
	if (st.ws.length < wrapper.positionals) return "cut";
	st.ws = st.ws.slice(wrapper.positionals);
	return stepAfterFlags(st, wrapper, spans);
}

/**
 * Stand on the command after a wrapper's flags and positionals. `flock` looks
 * for its `-c` by exact spelling after its file, no cluster or abbreviation.
 * @param {Strip} st accumulator: its `ws` and `watched` are written
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 * @returns {"next" | "cut"}
 */
function stepAfterFlags(st, wrapper, spans) {
	const [head, ...tail] = st.ws;
	if (wrapper.command === "flock-command" && head !== undefined) {
		const f = literal(head, spans).text;
		if (f === "-c" || f === "--command") {
			const [string] = tail;
			if (string === undefined) return "cut";
			st.ws = splitString(string, spans);
		}
	}
	if (wrapper.command === "sh-string") {
		st.ws = st.ws.flatMap((w) => splitString(w, spans));
		if (st.ws.length === 0) return "cut";
		st.watched = true;
	}
	return "next";
}

/**
 * Sweep the flags off the front of `st.ws`; false where a flag's value ran out.
 * @param {Strip} st accumulator: its `ws` and `chdirs` are written
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 */
function sweepFlags(st, wrapper, spans) {
	/** @param {string} w */
	const read = (w) => literal(w, spans).text;
	for (let raw = st.ws[0]; raw !== undefined; raw = st.ws[0]) {
		const f = read(raw);
		if (!f.startsWith("-") || (f === "-" && !wrapper.splits)) break;
		if (f === "--") {
			st.ws = st.ws.slice(1);
			break;
		}
		const next = st.ws[1];
		const { options, taken } = scanWrapperFlag(
			wrapper,
			f,
			next === undefined ? undefined : read(next),
		);
		st.ws = st.ws.slice(1 + taken);
		for (const option of options)
			if (!takeOption(st, wrapper, option)) return false;
	}
	return true;
}

/**
 * @typedef {object} WrapperOption one option a wrapper's flag word says
 * @property {FlagKind} kind
 * @property {string} name
 * @property {string} value
 */

/**
 * What the flag word `f` says under a wrapper's grammar, and how many words after
 * it it took.
 * @param {WrapperGrammar} wrapper
 * @param {string} f
 * @param {string | undefined} next
 */
function scanWrapperFlag(wrapper, f, next) {
	/** @type {WrapperOption[]} */
	const options = [];
	const taken = scanWord(f, next, {
		has: specHas(wrapper.values),
		expandLong: (flag) => wholeLongName(wrapper.long, flag),
		endsAtEndOfOptions: false,
		emit: (kind, name, value) => options.push({ kind, name, value }),
		ended: false,
		stopped: false,
	});
	return { options, taken };
}

/**
 * The whole name of a long flag spelt as any prefix naming just one; as spelt
 * otherwise, which the tool refuses.
 * @param {string[]} long
 * @param {string} flag with its `--`
 */
function wholeLongName(long, flag) {
	const spelt = flag.slice(2);
	if (long.includes(spelt)) return flag;
	const [only, ...more] = long.filter((n) => n.startsWith(spelt));
	return only !== undefined && more.length === 0 ? `--${only}` : flag;
}

/**
 * Keep the directory an option moves to and, under `env`, put a `-S` string's
 * words at the front of `st.ws`; false where its value ran out.
 * @param {Strip} st accumulator: its `ws` and `chdirs` are written
 * @param {WrapperGrammar} wrapper
 * @param {WrapperOption} option
 */
function takeOption(st, wrapper, { kind, name, value }) {
	if (kind === "dangling") return false;
	if (kind !== "opt") return true;
	if (wrapper.splits && (name === "-S" || name === "--split-string"))
		st.ws = [...splitEnvString(value), ...st.ws];
	else if (name === wrapper.chdir || name === "--chdir") st.chdirs.push(value);
	return true;
}

/** What a backslash in an `env -S` string writes, beside the character itself. */
const ENV_S_ESCAPES = new Map([
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["v", "\v"],
]);

/**
 * An `env -S` string's words as `env` itself splits them: on any whitespace, its own quotes undone, `\_` a space inside `"…"` and a
 * separator outside, `\c` or a word-opening `#` the end. A `${NAME}` stays as
 * written, for literal to call unknown.
 * @param {string} s
 * @returns {string[]}
 */
function splitEnvString(s) {
	/** @type {EnvSplit} */
	const split = { words: [], word: null, quote: "" };
	for (let i = 0; i < s.length; )
		i += stepEnvChar(split, s.charAt(i), s.charAt(i + 1));
	endEnvWord(split);
	return split.words;
}

/**
 * @typedef {object} EnvSplit splitEnvString's running state
 * @property {string[]} words
 * @property {string | null} word the word being built, null between words
 * @property {string} quote the quote it stands inside, "" for none
 */

/** @param {EnvSplit} split accumulator: its fields are written */
function endEnvWord(split) {
	if (split.word !== null) split.words.push(split.word);
	split.word = null;
}

/**
 * @param {EnvSplit} split accumulator: its fields are written
 * @param {string} text
 */
function addToEnvWord(split, text) {
	split.word = (split.word ?? "") + text;
}

/**
 * Read the character `c`, `next` after it: how many characters it took, Infinity
 * where the string ends there.
 * @param {EnvSplit} split accumulator: its fields are written
 * @param {string} c
 * @param {string} next
 * @returns {number}
 */
function stepEnvChar(split, c, next) {
	if (split.quote === "'") return stepEnvSingleQuoted(split, c, next);
	if (c === "\\" && next !== "") return stepEnvEscape(split, next);
	if (split.quote === '"') {
		if (c === '"') split.quote = "";
		else addToEnvWord(split, c);
	} else if (c === "'" || c === '"') {
		split.quote = c;
		addToEnvWord(split, "");
	} else if (/\s/.test(c)) endEnvWord(split);
	else if (c === "#" && split.word === null) return Number.POSITIVE_INFINITY;
	else addToEnvWord(split, c);
	return 1;
}

/**
 * @param {EnvSplit} split accumulator: its fields are written
 * @param {string} c
 * @param {string} next
 */
function stepEnvSingleQuoted(split, c, next) {
	if (c === "\\" && (next === "'" || next === "\\")) {
		addToEnvWord(split, next);
		return 2;
	}
	if (c === "'") split.quote = "";
	else addToEnvWord(split, c);
	return 1;
}

/**
 * The backslash escape of `next`, outside a single-quoted span.
 * @param {EnvSplit} split accumulator: its fields are written
 * @param {string} next
 */
function stepEnvEscape(split, next) {
	const bare = split.quote === "";
	if (next === "c" && bare) return Number.POSITIVE_INFINITY;
	if (next === "_" && bare) endEnvWord(split);
	else if (next === "_") addToEnvWord(split, " ");
	else addToEnvWord(split, ENV_S_ESCAPES.get(next) ?? next);
	return 2;
}

/**
 * The words of a string a wrapper hands to `sh -c`: read back through literal,
 * its first line split on IFS whitespace.
 * @param {string} word
 * @param {string[]} spans
 */
const splitString = (word, spans) =>
	beforeFirst(literal(word, spans).text, "\n").split(IFS_SPLIT).filter(Boolean);

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
 * the guard-hook-escape core refuses a wider set — empty values, `+=`, `export`,
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
	"--config-env",
	"--namespace",
	"--work-tree",
	"--git-dir",
	"--exec-path",
	"--attr-source",
	"--shallow-file",
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
	const [cmd] = ws;
	if (cmd === undefined || afterSlash(literal(cmd, spans).text) !== "git")
		return null;
	let i = 1;
	for (let w = ws[i]; w?.startsWith("-"); w = ws[i]) {
		const step = isGitValueOption(w) ? 2 : 1;
		if (i + step > ws.length) return null;
		i += step;
	}
	const sub = ws[i];
	if (sub === undefined) return null;
	return { sub: literal(sub, spans).text, args: ws.slice(i + 1) };
}

/**
 * One command's words from `gh`'s command word on, RAW, each still to be read
 * through literal (#772): `{ args, repo }`, `repo` the `-R`/`--repo` value
 * stepped over, as stepGhFlags reads it. Stepped over first: any launcher
 * wrapper, a path to the binary, and `gh`'s own flags before the command
 * word, of which only `-R`/`--repo` takes a value.
 *
 * Null where the command is not `gh`, or where `--help`/`-h` stands anywhere in
 * it: usage prints and dispatches nothing.
 * @param {string[]} words masked
 * @param {string[]} spans
 * @returns {GhCall | null}
 */
function ghWords(words, spans) {
	const [cmd, ...args] = unwrap(words, spans).words;
	if (cmd === undefined || !isGhCommand(literal(cmd, spans).text)) return null;
	const read = (/** @type {string} */ w) => literal(w, spans).text;
	if (args.some((w) => read(w) === "--help" || read(w) === "-h")) return null;
	return stepGhFlags(args, spans);
}

/**
 * A `-R`/`--repo` value as read: `text` as literal reads it, `known` false
 * where any of it could not be. Read, not raw: an attached value's prefix may
 * sit inside a quoted span or behind an escape, which no raw cut can split
 * (#4268).
 * @typedef {{ text: string, known: boolean }} GhRepo
 */

/**
 * A `gh` command's words past its own flags, RAW, and the repo they named.
 * @typedef {{ args: string[], repo: GhRepo | null }} GhCall
 */

/**
 * Step `gh`'s flags up to the next word not one, keeping the last `-R`/
 * `--repo` value, `repo` where none stands; null where `-R` has none left.
 * An empty value names no repo, as gh then falls back to GH_REPO.
 * Each flag is judged on its literal, so a quoted or escaped one counts;
 * literal's `known` is ignored for that: a flag carrying an expansion
 * (`--repo=$R`) is still a flag to step over.
 * @param {string[]} words raw
 * @param {string[]} spans
 * @param {GhRepo | null} [repo]
 * @returns {GhCall | null}
 */
function stepGhFlags(words, spans, repo = null) {
	let args = words;
	let r = repo;
	for (let raw = args[0]; raw !== undefined; raw = args[0]) {
		const f = literal(raw, spans);
		if (!f.text.startsWith("-")) break;
		let step = 1;
		if (f.text === "-R" || f.text === "--repo") {
			const value = args[1];
			if (value === undefined) return null;
			r = valueAfter(literal(value, spans), "");
			step = 2;
		} else if (f.text.startsWith("--repo=")) r = valueAfter(f, "--repo=");
		else if (f.text.startsWith("-R")) r = valueAfter(f, "-R");
		args = args.slice(step);
	}
	return { args, repo: r };
}

/**
 * A flag word's value, `prefix` cut off its read text; null where that
 * leaves it empty.
 * @param {GhRepo} read
 * @param {string} prefix
 * @returns {GhRepo | null}
 */
function valueAfter({ text, known }, prefix) {
	const value = text.slice(prefix.length);
	return known && value === "" ? null : { text: value, known };
}

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
	const [cmd] = ws;
	if (cmd === undefined) return null;
	const head = afterSlash(literal(cmd, spans).text);
	if (head !== "node" && head !== "nodejs") return null;
	let i = 1;
	for (let w = ws[i]; w?.startsWith("-"); w = ws[i]) {
		const step = NODE_VALUE_FLAGS.includes(w) ? 2 : 1;
		if (i + step > ws.length) return null;
		i += step;
	}
	const script = ws[i];
	if (script === undefined) return null;
	return afterSlash(literal(script, spans).text) === "commit-paths.js"
		? ws.slice(i + 1)
		: null;
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
	for (let i = 0, arg = args[0]; arg !== undefined; arg = args[++i]) {
		const opt = literal(arg, spans).text;
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
	const texts = words.map((w) => literal(w, spans).text);
	const from = skipFindOptions(texts);
	const end = texts.findIndex(
		(w, i) =>
			i >= from && (w.startsWith("-") || FIND_EXPRESSION_OPENERS.includes(w)),
	);
	return words.slice(from, end === -1 ? undefined : end);
}

/**
 * The index past `find`'s leading options; `texts.length` where a `-D` runs
 * out of words, which leaves no start point.
 * @param {string[]} texts the words after `find`, read through literal
 */
function skipFindOptions(texts) {
	let i = 0;
	for (let w = texts[0]; w !== undefined; w = texts[++i]) {
		if (w === "-D") {
			if (i + 1 >= texts.length) return texts.length;
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
 *
 * `gitLong`, where given, reads the words as git's own parser does, which pflag
 * does not: it turns a long flag as spelled into its whole name, before `spec`
 * is read, and `--end-of-options` makes every later word an `arg`, a `--`
 * among them (measured on git 2.43.0, #4008).
 * @param {string} spec
 * @param {string[]} words
 * @param {(kind: FlagKind, name: string, value: string) => boolean | undefined | void} fn
 * @param {(flag: string) => string} [gitLong]
 */
function scanFlags(spec, words, fn, gitLong) {
	/** @type {ScanCtx} */
	const ctx = {
		has: specHas(spec),
		expandLong: gitLong ?? ((flag) => flag),
		endsAtEndOfOptions: gitLong !== undefined,
		emit: (kind, name, value) => {
			if (fn(kind, name, value) === false) ctx.stopped = true;
		},
		ended: false,
		stopped: false,
	};
	for (let i = 0, w = words[0]; w !== undefined && !ctx.stopped; w = words[++i])
		i += scanWord(w, words[i + 1], ctx);
	return !ctx.stopped;
}

/**
 * @param {string} spec
 * @returns {(flag: string) => boolean}
 */
const specHas = (spec) => (flag) => ` ${spec} `.includes(` ${flag} `);

/**
 * @typedef {object} ScanCtx
 * @property {(flag: string) => boolean} has whether the spec lists `flag`
 * @property {(flag: string) => string} expandLong a long flag's whole name
 * @property {boolean} endsAtEndOfOptions whether `--end-of-options` ends them
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
	else if (
		tok === "--" ||
		(tok === "--end-of-options" && ctx.endsAtEndOfOptions)
	) {
		ctx.ended = true;
		emit("flag", tok, "");
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
function scanLong(tok, next, { has, expandLong, emit }) {
	const eq = tok.indexOf("=");
	const name = expandLong(eq >= 0 ? tok.slice(0, eq) : tok);
	if (eq >= 0) emit("opt", name, tok.slice(eq + 1));
	else if (!has(name)) emit("flag", name, "");
	else if (next === undefined) emit("dangling", name, "");
	else {
		emit("opt", name, next);
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
	SENTINEL_BYTE,
	absolute,
	hasExpansion,
	isBareSpan,
	isGlobPattern,
	escapeRe,
	readSentinels,
	literal,
	unwrap,
	carriesVar,
	commandName,
	isGhCommand,
	programSource,
	isGitValueOption,
	gitWords,
	ghWords,
	stepGhFlags,
	commitPathsArgs,
	commitPathsParse,
	findStarts,
	scanFlags,
	gitValueFlags,
};
