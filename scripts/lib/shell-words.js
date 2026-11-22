const { GIT_VALUED } = require("./git-options.js");
const { trimEndRun } = require("./trim-run.js");

const QUOTED = "\x01QSTR\x01";

const SENTINEL_BYTE = "\x01";

/** @param {string} recorded */
const isBareSpan = (recorded) => !["'", '"'].includes(recorded.charAt(0));

/** @param {string} s */
const hasExpansion = (s) => s.includes("$") || s.includes("`");

/** @param {string} p @param {string} pwd */
const absolute = (p, pwd) =>
	p.startsWith("/") ? p : `${pwd}/${p.replace(/^\.\//, "")}`;

/** @param {string} s */
const isGlobPattern = (s) => /[*?[]/.test(s);

/** @param {string} word */
const shellExpands = (word) => word.startsWith("~") || isGlobPattern(word);

/**
 * @param {string} text
 * @param {(lit: string, idx: number | null) => { text: string, stepPast: boolean }} onSpan
 * @returns {{ out: string, rest: string }}
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

/** @param {string} s @param {string} sep */
const beforeFirst = (s, sep) => {
	const at = s.indexOf(sep);
	return at < 0 ? s : s.slice(0, at);
};

const DOUBLE_ESCAPES = '$`"\\\n';

/**
 * Whether `c`, followed by `next`, is a backslash escaping it.
 * @param {string} c
 * @param {string} next
 * @param {boolean} double whether inside a `"…"` span
 */
const isEscape = (c, next, double) =>
	c === "\\" && next !== "" && (!double || DOUBLE_ESCAPES.includes(next));

/** @param {string} s @param {boolean} double */
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

/** @param {string} bare */
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

/** @param {string} bare @param {number} open */
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

/** @param {string} word @param {string[]} spans */
function literal(word, spans) {
	/** @type {string | null} */
	let head = null;
	let seen = "";
	let bare = "";
	/** @param {string} text @param {string} bareText */
	const append = (text, bareText) => {
		seen += text;
		bare += bareText;
	};
	/** @param {string} s @param {boolean} double */
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
		if (isBareSpan(recorded)) readOn(recorded, false);
		else if (recorded.charAt(0) === "'") append(span, "\0".repeat(span.length));
		else readOn(span, true);
		return { text: "", stepPast: true };
	});
	readOn(rest, false);
	const brace = braceAt(bare);
	// tsc narrows a closure-written variable to its assigned type, blind to the closures' writes: https://github.com/microsoft/TypeScript/issues/9998
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

const ASSIGNMENT_RE = /^[A-Za-z_].*=/s;

/** @param {string} w */
const afterSlash = (w) => w.slice(w.lastIndexOf("/") + 1);

/** @param {string} w */
function commandName(w) {
	const trimmed = trimEndRun(w, "/");
	return trimmed === "" && w !== "" ? "/" : afterSlash(trimmed);
}

/** @param {string} w */
const isGhCommand = (w) => commandName(w) === "gh";

/**
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

/** @param {string} name */
function interpreterFlags(name) {
	if (/^python([0-9].*)?$/.test(name)) return INTERPRETER_FLAGS.python;
	return INTERPRETER_FLAGS[name === "nodejs" ? "node" : name];
}

/**
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
 * @param {string} interpreter
 * @param {string[]} words
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
 * @typedef {object} WrapperGrammar
 * @property {string} values
 * @property {string[]} long
 * @property {string} [chdir]
 * @property {boolean} [splits]
 * @property {number} positionals
 * @property {"sh-string" | "flock-command"} [command]
 */

/**
 * @param {string} values
 * @param {string} flags
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
 * @param {string[]} words
 * @param {string[]} spans
 * @param {string[]} [judged]
 * @returns {[Unwrapped, ...Unwrapped[]]}
 */
function unwrap(words, spans, judged = []) {
	/** @type {Unwrapped[]} */
	const pending = [];
	const first = stripRun(buildBareRun(words), { spans, judged, pending });
	/** @type {Unwrapped[]} */
	const later = [];
	for (let run = pending.shift(); run !== undefined; run = pending.shift())
		later.push(stripRun(run, { spans, judged, pending }));
	return [first, ...later];
}

/** @param {string[]} argv @returns {Unwrapped[]} */
function unwrapArgv(argv) {
	/** @type {string[]} */
	const spans = [];
	return unwrap(argv, spans).map((run) => ({
		...run,
		words: run.words.map((w) => literal(w, spans).text),
	}));
}

/**
 * @typedef {object} Unwrapped
 * @property {string[]} words
 * @property {string[]} wrapperWords
 * @property {Chdir[]} chdirs
 * @property {string[]} unread
 * @property {boolean} watched
 * @property {boolean} scripted
 * @property {true} [envReset]
 */

/**
 * @typedef {ChdirWord & Pick<import("./shell-dirs.js").Move,
 *   "holds" | "afterFailed" | "chained" | "opensScope" | "depth" | "settles">} Chdir
 */

/**
 * @typedef {object} ChdirWord
 * @property {string} dir
 * @property {boolean} read
 * @property {Map<string, string | null>} [vars]
 * @property {boolean} [envReset]
 */

/**
 * @param {Unwrapped} run
 * @param {{ spans: string[], judged: string[], pending: Unwrapped[] }} with
 * @returns {Unwrapped}
 */
function stripRun(run, { spans, judged, pending }) {
	const st = buildStrip(run, judged, pending);
	stripWrappers(st, spans);
	return {
		words: st.ws,
		wrapperWords: st.wrapperWords,
		chdirs: st.chdirs,
		unread: st.unread,
		watched: st.watched,
		scripted: st.scripted,
	};
}

/** @param {Strip} st @param {string[]} spans */
function stripWrappers(st, spans) {
	for (let first = st.ws[0]; first !== undefined; first = st.ws[0]) {
		const step = stripOne(st, first, spans);
		if (step === "cut") st.ws = [];
		if (step !== "next") break;
	}
}

/** @param {string[]} words @param {string[]} spans */
function isScriptNext(words, spans) {
	const st = buildStrip(buildBareRun(words), [], []);
	stripWrappers(st, [...spans]);
	return st.awaitsScript;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {string | null}
 */
function wrapperScript(words, spans) {
	const [first] = words;
	if (first === undefined) return null;
	const st = buildStrip(buildBareRun(words), [], []);
	stripOne(st, first, [...spans]);
	return st.script;
}

/**
 * @param {Pick<Unwrapped, "words" | "scripted">} run
 * @param {string} segment
 */
const runText = (run, segment) =>
	run.scripted ? run.words.join(" ") : segment;

/**
 * @param {string[]} words
 * @returns {Unwrapped}
 */
const buildBareRun = (words) => ({
	words,
	wrapperWords: [],
	chdirs: [],
	unread: [],
	watched: false,
	scripted: false,
});

/**
 * @param {Unwrapped} run
 * @param {string[]} judged
 * @param {Unwrapped[]} pending
 * @returns {Strip}
 */
const buildStrip = (run, judged, pending) => ({
	ws: [...run.words],
	judged,
	inEnv: false,
	envReset: run.envReset ?? false,
	execs: false,
	awaitsScript: false,
	script: null,
	wrapperWords: [...run.wrapperWords],
	chdirs: [...run.chdirs],
	unread: [...run.unread],
	watched: run.watched,
	scripted: run.scripted,
	pending,
});

/** @param {string} w @param {string[]} flags */
const resetsEnv = (w, flags) =>
	w === "sudo" ||
	(w === "env" &&
		flags.some(
			(f) => f === "-" || /^-[^-]*[iu]|^--(?:ignore-env|unset)/.test(f),
		));

/**
 * @typedef {object} Strip
 * @property {string[]} ws
 * @property {string[]} judged
 * @property {boolean} inEnv
 * @property {boolean} envReset
 * @property {string[]} wrapperWords
 * @property {Chdir[]} chdirs
 * @property {string[]} unread
 * @property {boolean} watched
 * @property {Unwrapped[]} pending
 * @property {boolean} execs
 * @property {boolean} awaitsScript
 * @property {string | null} script
 * @property {boolean} scripted
 */

/**
 * @param {Strip} st
 * @param {string} first
 * @param {string[]} spans
 * @returns {"next" | "done" | "cut"}
 */
function stripOne(st, first, spans) {
	const { text } = literal(first, spans);
	if (st.inEnv && text.includes("=")) {
		st.wrapperWords.push(ASSIGNMENT_RE.test(first) ? first : text);
		st.ws = st.ws.slice(1);
		return "next";
	}
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
	const flagged = st.ws;
	if (!sweepFlags(st, wrapper, spans)) return "cut";
	const flags = flagged.slice(0, flagged.length - st.ws.length);
	st.envReset ||= resetsEnv(
		w,
		flags.map((f) => literal(f, spans).text),
	);
	if (st.ws.length < wrapper.positionals) return "cut";
	st.ws = st.ws.slice(wrapper.positionals);
	return stepAfterFlags(st, wrapper, spans);
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 * @returns {"next" | "cut"}
 */
function stepAfterFlags(st, wrapper, spans) {
	const [head, ...tail] = st.ws;
	/** @param {string[]} ws */
	const read = (ws) => ws.map((w) => literal(w, spans).text).join(" ");
	if (wrapper.command === "flock-command" && head !== undefined) {
		const f = literal(head, spans).text;
		if (f === "-c" || f === "--command") {
			const [string] = tail;
			if (string === undefined) {
				st.awaitsScript = true;
				return "cut";
			}
			st.script = read([string]);
			runScript(st, st.script, spans);
		}
	}
	if (wrapper.command === "sh-string") {
		st.watched = true;
		if (st.ws.length === 0) {
			st.awaitsScript = !st.execs;
			return "cut";
		}
		if (!st.execs) {
			st.script = read(st.ws);
			runScript(st, st.script, spans);
		}
		if (st.ws.length === 0) return "cut";
	}
	return "next";
}

/** @param {Strip} st @param {string} script @param {string[]} spans */
function runScript(st, script, spans) {
	// biome-ignore lint/suspicious/noImportCycles: required at the call, never at load, as shell-parse.js requires this file (#4863).
	const { parseScript } = require("./shell-parse.js");
	/** @type {Unwrapped[]} */
	const runs = parseScript(script, spans).map((cmd) => ({
		words: cmd.words,
		wrapperWords: [...st.wrapperWords, ...cmd.leading],
		chdirs: [
			...st.chdirs,
			...cmd.chdirs.map((cd) => (st.envReset ? { ...cd, envReset: true } : cd)),
		],
		unread: [...st.unread, ...cmd.unread],
		watched: st.watched,
		scripted: true,
		...(st.envReset && { envReset: /** @type {const} */ (true) }),
	}));
	const [first, ...later] = runs;
	st.ws = first?.words ?? [];
	st.scripted = true;
	if (first)
		Object.assign(st, {
			wrapperWords: first.wrapperWords,
			chdirs: first.chdirs,
			unread: first.unread,
		});
	st.pending.unshift(...later);
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 */
function sweepFlags(st, wrapper, spans) {
	for (let raw = st.ws[0]; raw !== undefined; raw = st.ws[0]) {
		const f = literal(raw, spans).text;
		if (!f.startsWith("-") || (f === "-" && !wrapper.splits)) break;
		if (f === "--") {
			st.ws = st.ws.slice(1);
			break;
		}
		const { options, taken, read } = scanWrapperFlag(
			wrapper,
			[raw, st.ws[1]],
			spans,
		);
		st.ws = st.ws.slice(1 + taken);
		for (const option of options)
			if (!takeOption(st, wrapper, option, read)) return false;
	}
	return true;
}

/**
 * @typedef {object} WrapperOption
 * @property {FlagKind} kind
 * @property {string} name
 * @property {string} value
 */

/**
 * @param {WrapperGrammar} wrapper
 * @param {[string, string | undefined]} words
 * @param {string[]} spans
 */
function scanWrapperFlag(wrapper, [flag, next], spans) {
	/** @param {string} w */
	const whole = (w) => literal(w, spans).known && !shellExpands(w);
	/** @type {WrapperOption[]} */
	const options = [];
	const after = next === undefined ? undefined : literal(next, spans).text;
	const taken = scanWord(literal(flag, spans).text, after, {
		has: specHas(wrapper.values),
		expandLong: (long) => wholeLongName(wrapper.long, long),
		endsAtEndOfOptions: false,
		emit: (kind, name, value) => options.push({ kind, name, value }),
		ended: false,
		stopped: false,
	});
	const read =
		whole(flag) && (taken === 0 || (next !== undefined && whole(next)));
	return { options, taken, read };
}

/** @param {string[]} long @param {string} flag */
function wholeLongName(long, flag) {
	const spelt = flag.slice(2);
	if (long.includes(spelt)) return flag;
	const [only, ...more] = long.filter((n) => n.startsWith(spelt));
	return only !== undefined && more.length === 0 ? `--${only}` : flag;
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {WrapperOption} option
 * @param {boolean} read
 */
function takeOption(st, wrapper, { kind, name, value }, read) {
	if (kind === "dangling") return false;
	if (wrapper.command === "sh-string" && (name === "-x" || name === "--exec"))
		st.execs = true;
	if (kind !== "opt") return true;
	if (wrapper.splits && (name === "-S" || name === "--split-string"))
		st.ws = [...splitEnvString(value), ...st.ws];
	else if (name === wrapper.chdir || name === "--chdir")
		st.chdirs.push({ dir: value, read, holds: "always" });
	return true;
}

const ENV_S_ESCAPES = new Map([
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
	["v", "\v"],
]);

/** @param {string} s @returns {string[]} */
function splitEnvString(s) {
	/** @type {EnvSplit} */
	const split = { words: [], word: null, quote: "" };
	for (let i = 0; i < s.length; )
		i += stepEnvChar(split, s.charAt(i), s.charAt(i + 1));
	endEnvWord(split);
	return split.words;
}

/**
 * @typedef {object} EnvSplit
 * @property {string[]} words
 * @property {string | null} word
 * @property {string} quote
 */

/** @param {EnvSplit} split */
function endEnvWord(split) {
	if (split.word !== null) split.words.push(split.word);
	split.word = null;
}

/** @param {EnvSplit} split @param {string} text */
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

/** @param {EnvSplit} split @param {string} c @param {string} next */
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
 * @param {string} name
 * @param {string[]} leading
 * @param {string[]} wrapperWords
 */
function carriesVar(name, leading, wrapperWords) {
	return [...leading, ...wrapperWords].some(
		(w) => w.startsWith(`${name}=`) && w.length > name.length + 1,
	);
}

/**
 * @param {string[]} ws
 * @param {string[]} spans
 * @param {(option: string, next: string | undefined) => void} [onOption]
 */
function stepGitOptions(ws, spans, onOption) {
	/** @param {string | undefined} raw @returns {string | null} */
	const optionAt = (raw) => {
		if (raw === undefined) return null;
		const { known, text } = literal(raw, spans);
		if (known) return text.startsWith("-") ? text : null;
		return raw.startsWith("-") ? raw : null;
	};
	let i = 1;
	for (let w = optionAt(ws[i]); w !== null; w = optionAt(ws[i])) {
		onOption?.(w, ws[i + 1]);
		i += GIT_VALUED.has(w) ? 2 : 1;
	}
	return i;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {{ sub: string, args: string[] }[]}
 */
const gitWords = (words, spans) =>
	unwrap(words, spans).flatMap((run) => {
		const git = gitRunWords(run.words, spans);
		return git ? [git] : [];
	});

/**
 * @param {string[]} ws
 * @param {string[]} spans
 * @returns {{ sub: string, args: string[] } | null}
 */
function gitRunWords(ws, spans) {
	const [cmd] = ws;
	if (cmd === undefined || afterSlash(literal(cmd, spans).text) !== "git")
		return null;
	const i = stepGitOptions(ws, spans);
	const sub = ws[i];
	if (sub === undefined) return null;
	return { sub: literal(sub, spans).text, args: ws.slice(i + 1) };
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {(GhCall & { wrapperWords: string[] })[]}
 */
const ghWords = (words, spans) =>
	unwrap(words, spans).flatMap(({ words: ws, wrapperWords }) => {
		const gh = dispatchingGhCall(ws, spans);
		return gh ? [{ ...gh, wrapperWords }] : [];
	});

/** @param {string[]} ws @param {string[]} spans @returns {GhCall | null} */
function dispatchingGhCall(ws, spans) {
	const gh = ghCall(ws, spans);
	return gh && !ws.slice(1).some((w) => isHelpWord(w, spans)) ? gh : null;
}

/** @param {string} w @param {string[]} spans */
const isHelpWord = (w, spans) => {
	const text = literal(w, spans).text;
	return text === "--help" || text === "-h";
};

/** @param {string[]} ws @param {string[]} spans @returns {GhCall | null} */
function ghCall(ws, spans) {
	const [cmd, ...args] = ws;
	if (cmd === undefined || !isGhCommand(literal(cmd, spans).text)) return null;
	const gh = stepGhFlags(args, spans);
	const own = args.slice(0, gh ? args.length - gh.args.length : 0);
	const help = own.some(
		(w, i) => isHelpWord(w, spans) && !isRepoFlag(own[i - 1], spans),
	);
	return help ? null : gh;
}

/** @param {string | undefined} w @param {string[]} spans */
const isRepoFlag = (w, spans) => {
	const text = w === undefined ? "" : literal(w, spans).text;
	return text === "-R" || text === "--repo";
};

/** @typedef {{ text: string, known: boolean }} GhRepo */

/** @typedef {{ args: string[], repo: GhRepo | null }} GhCall */

/**
 * @param {string[]} words
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

/** @param {GhRepo} read @param {string} prefix @returns {GhRepo | null} */
function valueAfter({ text, known }, prefix) {
	const value = text.slice(prefix.length);
	return known && value === "" ? null : { text: value, known };
}

const NODE_VALUE_FLAGS = [
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
];

/** @param {string[]} words @param {string[]} spans @returns {string[][]} */
const commitPathsArgs = (words, spans) =>
	unwrap(words, spans).flatMap((run) => {
		const args = nodeScriptArgs(run.words, spans, "commit-paths.js");
		return args ? [args] : [];
	});

/**
 * @param {string[]} ws
 * @param {string[]} spans
 * @param {string} script
 * @returns {string[] | null}
 */
function nodeScriptArgs(ws, spans, script) {
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
	const word = ws[i];
	if (word === undefined) return null;
	return afterSlash(literal(word, spans).text) === script
		? ws.slice(i + 1)
		: null;
}

/**
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

const FIND_EXPRESSION_OPENERS = ["(", "\\(", "!", "\\!", ","];

/** @param {string[]} words @param {string[]} spans @returns {string[]} */
function findStarts(words, spans) {
	const texts = words.map((w) => literal(w, spans).text);
	const from = skipFindOptions(texts);
	const end = texts.findIndex(
		(w, i) =>
			i >= from && (w.startsWith("-") || FIND_EXPRESSION_OPENERS.includes(w)),
	);
	return words.slice(from, end === -1 ? undefined : end);
}

/** @param {string[]} texts */
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

/** @typedef {"opt" | "flag" | "dangling" | "arg"} FlagKind */

// #4008
/**
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
 * @property {(flag: string) => boolean} has
 * @property {(flag: string) => string} expandLong
 * @property {boolean} endsAtEndOfOptions
 * @property {(kind: FlagKind, name: string, value: string) => void} emit
 * @property {boolean} ended
 * @property {boolean} stopped
 */

/**
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

// #302
/** @param {string} sub */
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
	ASSIGNMENT_RE,
	QUOTED,
	SENTINEL_BYTE,
	absolute,
	hasExpansion,
	isBareSpan,
	isGlobPattern,
	readSentinels,
	literal,
	unwrap,
	unwrapArgv,
	isScriptNext,
	wrapperScript,
	runText,
	carriesVar,
	commandName,
	isGhCommand,
	programSource,
	stepGitOptions,
	gitWords,
	ghCall,
	dispatchingGhCall,
	ghWords,
	stepGhFlags,
	valueAfter,
	commitPathsArgs,
	commitPathsParse,
	nodeScriptArgs,
	findStarts,
	scanFlags,
	gitValueFlags,
};
