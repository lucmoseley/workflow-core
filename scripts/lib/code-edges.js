/*
 * code-edges.js — the files one script reaches, read lexically, for
 * surface-closure.js's and hook-code.js's walks (#4259) and the pass store's
 * reach, which also reads the paths each specifier tried before its target
 * (`reachOf`'s shadows, #4814) and each load the walk cannot read (`unread`,
 * #4790), on which the store records no row:
 *   JS and TypeScript, comment lines skipped — a relative
 *     `require`/`from`/`import()` specifier, resolved as node resolves it, or
 *     as vitest does an extensionless `.ts`; and
 *     `path.join|resolve(__dirname, "<literal>", …)` naming a code file, the
 *     spelling of check.js's notify-report.js (#459) and
 *     doc-map-generator.js's session-arbiter.js spawn (#460).
 *   shell, a `.sh` file or one with no extension and a shell `#!` line,
 *     cut into simple commands (lib/shell-script-lexer.js) — every word
 *     naming a code path, and every load: a file sourced or `.`-read, run
 *     through an interpreter or by its path, behind a wrapper such as `exec`
 *     or a function running its arguments, named by node's `--require`, or
 *     loaded by an inline node program as `require(process.argv[N])` off an
 *     argument. A load's word is read as a path built from literals, the
 *     file's own path and directory (`${BASH_SOURCE[0]}`, `%/*`, `dirname`,
 *     `basename`, `cd … && pwd`), an inherited variable's `${X:-default}` as
 *     its default, and variables the file assigns one such path in every
 *     assignment, read where the word stands, so an `unset` after it clears
 *     nothing (#460, #4790). A load word that is one value the caller hands
 *     in, whole — an argument, or an inherited variable or its default
 *     command name — is the caller's to name. A load word built any other way
 *     is unread, never dropped (#4790): off `$0`, which in a sourced file is
 *     its caller, off an argument or an inherited variable, or off the
 *     working directory; so is a program on stdin or in a heredoc, a shell's
 *     `-c` command, and a module an interpreter finds on its own search path
 *     (`python3 -m`). Residual: a caller's load is read only where the
 *     caller spells it in a way this walk reads (the JS residual below), and
 *     a function running its arguments is read only where an interpreter
 *     names them, as `hb node x.js`, not `hb "$script"`.
 *   Python — `import X.Y` or `from X import Z` (#465, #4864): X searched as
 *     CPython would, on the importer's directory and each sys.path entry the
 *     file adds before the import through a literal `insert(0, …)` or
 *     `append(…)` of a path built from `__file__`, literals and names it
 *     assigned from them; then each dotted part, and each `Z` that is a
 *     submodule, in the package found. Read in lexical order; an indented
 *     sys.path edit may never have run, so a module found on its entry
 *     settles nothing, and an indented import, or one on a one-line compound
 *     statement's body, is placed again on the file's final search path.
 * A JSX or TSX file is code the walk cannot read.
 *
 * FOREIGN: a Python import the walk cannot place — a module neither stdlib
 * (python3's own sys.stdlib_module_names, so 3.10 or later) nor on that
 * search path, a dotted part it cannot find, an import whose search meets an
 * entry the walk cannot read before it is placed (a builtin module never
 * meets one, and a stdlib one only an entry appended after the stdlib's), an
 * import statement it cannot parse, or a file ending inside an open bracket —
 * is handed to the caller's `fault`, as is a JSX or TSX file. Residual: a
 * module is walked on its own directory and edits, not on the sys.path of
 * the script that imports it (#4870).
 *
 * INLINE CODE: a spawn of python, node, perl or ruby handed its program
 * inline (`-c`, `-e`, `-p`, `--eval`, `--print`) or on stdin (`-`), in JS,
 * TypeScript or Python, is unread unless its program is one plain literal,
 * its escapes undone, loading only builtin modules; in a shell script the
 * program must be single-quoted, and node's `require(process.argv[N])` of
 * an argument read as a path is an edge. Residual: in JS and TypeScript, a
 * spawn handing a shell its command (`bash -c`), through which tests run any
 * command, an interpreter named by a variable, and a script spawned by a
 * path not spelled off `__dirname`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isBuiltin } = require("node:module");
const {
	HASH_COMMENT_LINE,
	JS_COMMENT_LINE,
} = require("./qualify-citations.js");
const { requiredGroup } = require("./regex-group.js");
const {
	SH_ASSIGN,
	SH_RESERVED,
	braceEnd,
	shCommands,
	substitutionAt,
} = require("./shell-script-lexer.js");
/**
 * The language of the code `file` holds, by its extension, or null where it
 * holds none a script may load or spawn. A JSX or TSX source is code whose
 * loads the walk never parses.
 * @param {string} file
 * @returns {"js"|"jsx"|"sh"|"python"|null}
 */
function languageOf(file) {
	if (/\.[cm]?[jt]s$/.test(file)) return "js";
	if (/\.[cm]?[jt]sx$/.test(file)) return "jsx";
	if (file.endsWith(".sh")) return "sh";
	if (file.endsWith(".py")) return "python";
	return null;
}
/* The interpreter an extensionless script's `#!` line names, by its
 * program's basename, or `env`'s first word that is not a flag. */
/** @type {Map<string, "js"|"python"|"sh">} */
const SHEBANG_LANGUAGE = new Map([
	["node", "js"],
	["python", "python"],
	["python3", "python"],
	["sh", "sh"],
	["bash", "sh"],
	["dash", "sh"],
	["zsh", "sh"],
	["ksh", "sh"],
]);

/**
 * The language of a script by its extension, or for a file with none, as a
 * git hook, by its `#!` line.
 * @param {string} file
 * @param {string} text
 * @returns {"js"|"jsx"|"sh"|"python"|null}
 */
function scriptLanguage(file, text) {
	const named = languageOf(file);
	if (named !== null || path.basename(file).includes(".")) return named;
	if (!text.startsWith("#!")) return null;
	const words = text.slice(2, text.indexOf("\n") + 1 || undefined).split(/\s+/);
	const program = words.filter(Boolean).map((w) => path.basename(w));
	const name =
		program[0] === "env"
			? program.slice(1).find((w) => !w.startsWith("-"))
			: program[0];
	return name === undefined ? null : (SHEBANG_LANGUAGE.get(name) ?? null);
}

/**
 * Whether `file` is code a script may load or spawn, walked or not.
 * @param {string} file
 */
const isCodeFile = (file) => languageOf(file) !== null;
/* Every literal module specifier: `require(…)`, `require.resolve(…)`,
 * `from "…"`, `import(…)` and a bare `import "…"`. plugin-tree.js's package
 * scan reads the same. */
const JS_SPEC =
	/\brequire(?:\.resolve)?\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
/* A relative specifier a test loads straight through `createRequire(…)(…)`,
 * which no `require(` precedes. Out of `JS_SPEC`: the package scan must not
 * read a lazy optional load as a dependency. */
const CREATE_REQUIRE_SPEC =
	/\bcreateRequire\([^()]*(?:\([^()]*\)[^()]*)?\)\(\s*["'](\.[^"']*)["']\s*(?:,\s*)?\)/g;

/**
 * The specifier a `JS_SPEC` match captured: each of its four branches has one
 * group, and exactly one branch takes part.
 * @param {RegExpMatchArray} m
 * @returns {string}
 */
function jsSpecifier(m) {
	const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
	if (spec === undefined)
		throw new Error(`no specifier group took part in ${JSON.stringify(m[0])}`);
	return spec;
}

const DIRNAME_JOIN =
	/\bpath\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*["'][^"']+["'])+)\s*(?:,\s*)?\)/g;
const QUOTED = /["']([^"']+)["']/g;
const PY_IMPORT =
	/^\s*(?:from\s+([\w.]+)\s+import\s+\(?([\w., ]*)|import\s+([\w., ]+))/;
/* Any statement that may load a module or run a file's code, read with its
 * strings blanked: one `PY_IMPORT` does not match is a load the walk cannot
 * parse. Beside the `import` keyword, `__import__`, importlib's
 * `import_module`, `spec_from_file_location`, `exec_module` and loaders,
 * runpy's `run_path` and `run_module`, and `exec` of read source. */
const PY_LOAD =
	/\bimport\b|\b(?:__import__|import_module|spec_from_file_location|spec_from_loader|exec_module|load_module|SourceFileLoader|run_path|run_module|exec|execfile)\s*\(/;
/* A one-line string in either quote, escapes skipped: Python's, and a JS
 * literal's other than a template. */
const ONE_LINE_STRING = String.raw`"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'`;
/* A triple-quoted block, a one-line string or a comment, whichever starts
 * first, so a quote inside a comment opens nothing. */
const PY_LEXEME = new RegExp(
	String.raw`("""|''')[\s\S]*?\1|${ONE_LINE_STRING}|#[^\n]*`,
	"g",
);
const PY_STRING = new RegExp(ONE_LINE_STRING, "g");
/* A compound statement's header with its body on the same line, read with
 * strings blanked: `try: import x`, `if X: import y`. A colon in the header
 * itself cuts it early, leaving a body the walk then faults. */
const PY_COMPOUND =
	/^\s*(?:(?:try|else|finally)\s*|(?:if|elif|while|for|with|except|def|class|match|case|async\s+(?:def|for|with))\b[^:]*):(?=\s*\S)/;
/* Any statement that changes sys.path; SYS_PATH_ADD is the shape of one
 * the walk reads, `insert(0, …)` (group 1) or `append(…)` (group 2). */
const SYS_PATH_EDIT =
	/\bsys\.path\s*(?:\.\s*(?:insert|append|extend|pop|remove|clear)\b|\[[^\]]*\]\s*=|\+=|=(?!=))|\bdel\s+sys\.path\b/;
const SYS_PATH_ADD =
	/^\s*sys\.path\.(?:insert\(\s*0\s*,(.+)\)|append\((.+)\))\s*$/;
const PY_ASSIGN = /^\s*([A-Za-z_]\w*)\s*=(?!=)(.+)$/;
const PY_PATH_TOKEN = /(?:(\.?[A-Za-z_][\w.]*)|("[^"\\]*"|'[^'\\]*')|([(),/]))/;
const PY_PATH_CALLS = new Set([
	"str",
	"Path",
	"os.path.abspath",
	"os.path.dirname",
	"os.path.join",
]);

/**
 * @param {string} text
 * @param {RegExp} comment
 */
const parseCodeLines = (text, comment) =>
	text.split("\n").filter((line) => !comment.test(line));

/**
 * The paths node tries, in order, for a relative specifier, with vitest's
 * `.ts` for a `.js` specifier naming a `.ts` source. Residual: node's
 * `.node`, a directory's `package.json` "main", and vite's `.mjs`, `.mts`,
 * `.jsx`, `.tsx` and `index.ts` are not tried, so a file appearing there is
 * neither an edge nor a shadow.
 * @param {string} abs
 */
const candidatesOf = (abs) => [
	abs,
	`${abs}.js`,
	`${abs}.json`,
	`${abs}.ts`,
	...(abs.endsWith(".js") ? [`${abs.slice(0, -3)}.ts`] : []),
	path.join(abs, "index.js"),
];

/** @param {string} c */
const isFile = (c) =>
	fs.statSync(c, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The file node would load for a relative specifier, or vitest would where a
 * `.js` specifier names a `.ts` source — the bare join where none exists, so
 * a miss names the path as written — and the candidates tried before it,
 * none where nothing resolved.
 * @param {string} abs
 * @returns {{target: string, tried: string[]}}
 */
function resolutionOf(abs) {
	const candidates = candidatesOf(abs);
	for (const [i, candidate] of candidates.entries())
		if (isFile(candidate))
			return { target: candidate, tried: candidates.slice(0, i) };
	return { target: abs, tried: [] };
}

/**
 * @typedef {{version: string, builtins: Set<string>, stdlib: Set<string>}}
 *   Python this machine's python3: its version, the modules compiled into it,
 *   which no sys.path entry can shadow, and its stdlib's module names
 */

/* readPython's spawn's answer: the version, then two name lists. */
const PYTHON_ANSWER = /^(\S+)\n(.*)\n(.*)\n$/;
/** @type {Python | null} */
let python = null;
/**
 * This machine's python3, read once a process.
 * @returns {Python}
 */
function readPython() {
	if (python) return python;
	/* Builtin modules only, so the walk's own spawn loads no file. */
	const r = spawnSync(
		"python3",
		[
			"-c",
			"import sys; print('.'.join(map(str, sys.version_info))); print(' '.join(sys.builtin_module_names)); print(' '.join(sys.stdlib_module_names))",
		],
		{ encoding: "utf8" },
	);
	const answer = r.status === 0 ? r.stdout.match(PYTHON_ANSWER) : null;
	if (!answer)
		throw new Error(
			`python3 cannot list its stdlib (${(r.stderr || String(r.error) || r.stdout).trim().split("\n")[0]})`,
		);
	const names = (/** @type {number} */ g) =>
		new Set(requiredGroup(answer, g, PYTHON_ANSWER).split(" "));
	python = {
		version: requiredGroup(answer, 1, PYTHON_ANSWER),
		builtins: names(2),
		stdlib: names(3),
	};
	return python;
}

/** This machine's python3 version, as `major.minor.micro.level.serial`. */
const pythonVersion = () => readPython().version;

/**
 * @typedef {{edges: string[], shadows: string[]}} Found absolute: the files
 *   reached, and the paths tried on the way before the file each resolved to
 * @typedef {{edges: string[], shadows: string[], unread: string[],
 *   python: boolean}} Reach absolute: the files reached, the paths tried on
 *   the way before the file each resolved to, each load the walk cannot
 *   read, and whether the file runs an inline Python program
 */

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {Reach}
 */
function reachOf(file, text, fault) {
	const language = scriptLanguage(file, text);
	if (language === "sh") return shReach(file, text);
	if (language === "jsx")
		fault(`is ${path.extname(file)} code, whose loads the walk cannot read`);
	if (language !== "js" && language !== "python")
		return { edges: [], shadows: [], unread: [], python: false };
	const code = parseCodeLines(
		text,
		language === "js" ? JS_COMMENT_LINE : HASH_COMMENT_LINE,
	).join("\n");
	const { edges, shadows } =
		language === "js"
			? jsReach(path.dirname(file), code)
			: pyReach(file, text, fault);
	return { edges, shadows, ...inlineSpawns(code) };
}

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {string[]} absolute paths the file reaches
 */
const edgesOf = (file, text, fault) => reachOf(file, text, fault).edges;

/**
 * Each relative `require`, import or `createRequire(…)(…)` specifier in
 * `code`, joined to `dir`.
 * @param {string} dir
 * @param {string} code comment lines already cut
 * @returns {string[]}
 */
function relativeSpecifiers(dir, code) {
	/** @type {string[]} */
	const joined = [];
	for (const m of code.matchAll(JS_SPEC)) {
		const spec = jsSpecifier(m);
		if (spec.startsWith(".")) joined.push(path.join(dir, spec));
	}
	for (const m of code.matchAll(CREATE_REQUIRE_SPEC))
		joined.push(path.join(dir, requiredGroup(m, 1, CREATE_REQUIRE_SPEC)));
	return joined;
}

/**
 * A JS or TypeScript file's edges, and the paths its relative specifiers
 * tried before the file each resolved to (#4814): a file appearing at one
 * would take the import over.
 * @param {string} dir the file's directory
 * @param {string} code comment lines already cut
 * @returns {{edges: string[], shadows: string[]}}
 */
function jsReach(dir, code) {
	const resolved = relativeSpecifiers(dir, code).map(resolutionOf);
	const edges = resolved.map((r) => r.target);
	for (const m of code.matchAll(DIRNAME_JOIN)) {
		const parts = [...requiredGroup(m, 1, DIRNAME_JOIN).matchAll(QUOTED)].map(
			(p) => requiredGroup(p, 1, QUOTED),
		);
		const target = path.join(dir, ...parts);
		if (isCodeFile(target)) edges.push(target);
	}
	return { edges, shadows: resolved.flatMap((r) => r.tried) };
}

/**
 * @typedef {{dir: string | null, maybe: boolean, tail: boolean}} PyEntry one
 *   sys.path entry: a null `dir` is one the walk cannot read; `maybe` marks
 *   one an indented statement added, which may never have run; `tail` one
 *   appended, so searched after the stdlib's own entries.
 * @typedef {{search: PyEntry[], names: Map<string, string>}} PyScope
 *   `search` is sys.path as the file has left it, its own directory
 *   included.
 * @typedef {{file: string, dir: string, scope: PyScope, reach: Found,
 *   fault: (msg: string) => void}} PyWalk
 * @typedef {{text: string, indented: boolean}} PyStatement
 */

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {Found}
 */
function pyReach(file, text, fault) {
	const dir = path.dirname(file);
	/** @type {Set<string>} */
	const faulted = new Set();
	/** @type {PyWalk} */
	const walk = {
		file,
		dir,
		scope: {
			search: [{ dir, maybe: false, tail: false }],
			names: new Map(),
		},
		reach: { edges: [], shadows: [] },
		/* An indented import is placed twice, so one fault can come twice. */
		fault: (msg) => {
			if (!faulted.has(msg)) fault(msg);
			faulted.add(msg);
		},
	};
	/** @type {PyImportTarget[]} */
	const deferred = [];
	for (const statement of pyStatements(text, walk.fault)) {
		const imp = statement.text.match(PY_IMPORT);
		if (imp) {
			const targets = pyImportTargets(imp);
			for (const target of targets) placePyImport(walk, target);
			/* A function's import runs when it is called, perhaps after a
			 * later sys.path edit: place it on the final search path too. */
			if (statement.indented) deferred.push(...targets);
		} else if (PY_LOAD.test(blankPyStrings(statement.text)))
			walk.fault(
				`imports through ${statement.text.trim()}, which the walk cannot parse`,
			);
		else if (SYS_PATH_EDIT.test(statement.text)) editSysPath(walk, statement);
		else bindPyName(walk, statement.text);
	}
	for (const target of deferred) placePyImport(walk, target);
	return walk.reach;
}

/**
 * `text` with each one-line string's body blanked to spaces, quotes and
 * length kept, so an index into it is one into `text`.
 * @param {string} text
 */
const blankPyStrings = (text) =>
	text.replace(
		PY_STRING,
		(s) => `${s.charAt(0)}${" ".repeat(s.length - 2)}${s.charAt(0)}`,
	);

/**
 * Records `NAME = <path expression>` in the scope, or forgets NAME where the
 * value is no path the walk reads.
 * @param {PyWalk} walk accumulator: its scope's `names` gains or loses the
 *   name
 * @param {string} text
 */
function bindPyName(walk, text) {
	const assign = text.match(PY_ASSIGN);
	if (!assign) return;
	const name = requiredGroup(assign, 1, PY_ASSIGN);
	const value = evalPyPath(requiredGroup(assign, 2, PY_ASSIGN), walk);
	if (value === null) walk.scope.names.delete(name);
	else walk.scope.names.set(name, value);
}

/**
 * The file's logical statements in order: strings' triple-quoted blocks and
 * comments cut, bracketed and backslash continuations joined, `;` split, a
 * one-line compound statement's body split from its header, each marked
 * where it is indented or such a body. A file ending inside an open bracket
 * faults: its last statement is not read whole.
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {PyStatement[]}
 */
function pyStatements(text, fault) {
	/** @type {PyStatement[]} */
	const statements = [];
	let pending = "";
	let indented = false;
	let depth = 0;
	const flush = () => {
		let inBody = indented;
		for (const part of pending.split(";")) {
			const header = blankPyStrings(part).match(PY_COMPOUND);
			if (header) inBody = true;
			statements.push({
				text: header ? part.slice(header[0].length) : part,
				indented: inBody,
			});
		}
		pending = "";
	};
	const code = text.replace(PY_LEXEME, cutPyLexeme);
	for (const line of code.split("\n")) {
		if (pending === "") indented = /^\s/.test(line);
		const blank = line.replace(PY_STRING, '""');
		depth +=
			(blank.match(/[([{]/g)?.length ?? 0) -
			(blank.match(/[)\]}]/g)?.length ?? 0);
		const continued = /\\\s*$/.test(line);
		pending += ` ${continued ? line.replace(/\\\s*$/, "") : line}`;
		if (depth > 0 || continued) continue;
		flush();
		depth = 0;
	}
	if (depth > 0)
		fault("ends inside an open bracket, so its last statement goes unread");
	if (pending) flush();
	return statements;
}

/**
 * A `PY_LEXEME` as `pyStatements` reads it: a comment goes, a triple-quoted
 * block stands as an empty string, and a one-line string stays.
 * @param {string} m
 */
function cutPyLexeme(m) {
	if (m.startsWith("#")) return "";
	return /^("""|''')/.test(m) ? '""' : m;
}

/**
 * Applies one sys.path edit to the scope: a literal `insert(0, …)` or
 * `append(…)` whose path `evalPyPath` reads, or else an entry the walk
 * cannot read at the front.
 * @param {PyWalk} walk accumulator: its scope's `search` gains the entry
 * @param {PyStatement} statement
 */
function editSysPath(walk, statement) {
	const m = statement.text.match(SYS_PATH_ADD);
	const dir = m
		? evalPyPath(m[1] ?? requiredGroup(m, 2, SYS_PATH_ADD), walk)
		: null;
	const tail = m?.[2] !== undefined;
	const entry = { dir, maybe: statement.indented, tail };
	if (tail) walk.scope.search.push(entry);
	else walk.scope.search.unshift(entry);
}

/**
 * The absolute path a Python path expression spells, or null where it is
 * built from anything but `__file__`, string literals, the names this file
 * assigned from them, and `Path`, `os.path` and `str` over those.
 * @param {string} expr
 * @param {PyWalk} walk
 * @returns {string | null}
 */
function evalPyPath(expr, walk) {
	/** @type {string[]} */
	const tokens = [];
	const tokenRe = new RegExp(PY_PATH_TOKEN.source, "g");
	if (expr.replace(tokenRe, "").trim() !== "") return null;
	for (const m of expr.matchAll(tokenRe))
		tokens.push(m[1] ?? m[2] ?? requiredGroup(m, 3, PY_PATH_TOKEN));
	try {
		const parser = new PyPathParser(tokens, walk);
		const v = parser.pathExpr();
		return parser.done() && path.isAbsolute(v) ? path.normalize(v) : null;
	} catch {
		return null;
	}
}

/** Python's join: an absolute part restarts the path. */
const pyJoin = (/** @type {string[]} */ parts) =>
	parts.reduce((a, b) => (path.isAbsolute(b) ? b : path.join(a, b)));

/** Recursive descent over `evalPyPath`'s tokens; throws on any other shape. */
class PyPathParser {
	/**
	 * @param {string[]} tokens
	 * @param {PyWalk} walk its file and the names it assigned
	 */
	constructor(tokens, walk) {
		this.tokens = tokens;
		this.i = 0;
		this.walk = walk;
	}

	done() {
		return this.i === this.tokens.length;
	}

	peek() {
		return this.tokens[this.i];
	}

	take() {
		const t = this.tokens[this.i++];
		if (t === undefined) throw new Error("ends early");
		return t;
	}

	/** @param {string} t */
	expect(t) {
		if (this.take() !== t) throw new Error(`wants ${t}`);
	}

	/** A whole expression: terms joined by pathlib's `/`. @returns {string} */
	pathExpr() {
		let v = this.term();
		while (this.peek() === "/") {
			this.take();
			v = pyJoin([v, this.term()]);
		}
		return v;
	}

	/** @returns {string} */
	term() {
		let v = this.primary();
		while (this.peek()?.startsWith("."))
			v = this.attrs(v, this.take().slice(1));
		return v;
	}

	/** @returns {string} */
	primary() {
		const t = this.take();
		if (/^["']/.test(t)) return t.slice(1, -1);
		if (t === "(") {
			const v = this.pathExpr();
			this.expect(")");
			return v;
		}
		if (this.peek() === "(" && PY_PATH_CALLS.has(t)) return this.call(t);
		const dot = t.indexOf(".");
		const base = dot === -1 ? t : t.slice(0, dot);
		const v =
			base === "__file__" ? this.walk.file : this.walk.scope.names.get(base);
		if (v === undefined) throw new Error(`unknown ${base}`);
		return dot === -1 ? v : this.attrs(v, t.slice(dot + 1));
	}

	/** @param {string} name one of `PY_PATH_CALLS` */
	call(name) {
		this.expect("(");
		/** @type {string[]} */
		const args = [];
		while (this.peek() !== ")") {
			args.push(this.pathExpr());
			if (this.peek() === ",") this.take();
		}
		this.take();
		return pyPathCall(name, args);
	}

	/**
	 * @param {string} v
	 * @param {string} chain dotted attributes, the last perhaps `resolve()`
	 */
	attrs(v, chain) {
		const parts = chain.split(".");
		for (const [k, part] of parts.entries()) {
			const resolve =
				k === parts.length - 1 && part === "resolve" && this.peek() === "(";
			if (part === "parent") v = path.dirname(v);
			else if (resolve) {
				this.take();
				this.expect(")");
			} else throw new Error(`.${part}`);
		}
		return v;
	}
}

/**
 * @param {string} name one of `PY_PATH_CALLS`
 * @param {string[]} args
 * @returns {string}
 */
function pyPathCall(name, args) {
	const [first] = args;
	if (first === undefined) throw new Error(`${name}() without a path`);
	if (name === "os.path.join" || name === "Path") return pyJoin(args);
	if (args.length !== 1) throw new Error(`${name} takes one path`);
	if (name === "os.path.dirname") return path.dirname(first);
	/* str, and abspath over an absolute path, leave it naming the same file. */
	if (!path.isAbsolute(first)) throw new Error(`${name} of a relative path`);
	return first;
}

/**
 * @typedef {{dots: number, parts: string[], names: string[]}} PyImportTarget
 *   `import a.b` is parts [a, b]; `from a.b import x` adds names [x], each
 *   perhaps a submodule; `dots` counts a relative import's leading dots.
 */

/**
 * The names a comma-separated Python import list carries, each cut at its
 * first space so `x as y` reads as `x`.
 * @param {string} list
 * @returns {string[]}
 */
function pyNames(list) {
	return list
		.split(",")
		.map((n) => n.trim().replace(/\s.*/s, ""))
		.filter(Boolean);
}

/**
 * The modules one import statement names.
 * @param {RegExpMatchArray} m a `PY_IMPORT` match
 * @returns {PyImportTarget[]}
 */
function pyImportTargets(m) {
	/* Group 1 is the `from` branch, which always carries group 2; group
	 * 3 is the bare `import` branch. */
	const [, from, fromNames, bareNames] = m;
	if (from === undefined) {
		if (bareNames === undefined)
			throw new Error(`PY_IMPORT matched neither branch: ${m[0]}`);
		return pyNames(bareNames).map((mod) => ({
			dots: 0,
			parts: mod.split("."),
			names: [],
		}));
	}
	if (fromNames === undefined)
		throw new Error(`PY_IMPORT's from branch matched without names: ${m[0]}`);
	const rest = from.replace(/^\.+/, "");
	return [
		{
			dots: from.length - rest.length,
			parts: rest ? rest.split(".") : [],
			names: pyNames(fromNames.replace(/[()]/g, "")),
		},
	];
}

/**
 * What a module name finds in one directory, package first as CPython's
 * FileFinder tries them: the file, the candidates tried before it, and a
 * namespace directory (one with no __init__.py) where no file stands.
 * @param {string} dir
 * @param {string} name
 * @returns {{found: string | null, tried: string[], namespace: string | null}}
 */
function pyModuleIn(dir, name) {
	const candidates = [
		path.join(dir, name, "__init__.py"),
		path.join(dir, `${name}.py`),
	];
	const at = candidates.findIndex(isFile);
	if (at !== -1)
		return {
			found: candidates[at] ?? null,
			tried: candidates.slice(0, at),
			namespace: null,
		};
	const namespace = path.join(dir, name);
	return {
		found: null,
		tried: candidates,
		namespace: isDir(namespace) ? namespace : null,
	};
}

/** @param {string} c */
const isDir = (c) =>
	fs.statSync(c, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * @typedef {{pkg: string | null, namespace: boolean}} PyPlace where an
 *   import's next part is looked for: a package directory, null below a
 *   plain module; `namespace` where that directory has no __init__.py
 * @typedef {{kind: "placed", places: PyPlace[]} | {kind: "absent"}
 *   | {kind: "opaque", tail: boolean}} PyTopPlacement where the search for a
 *   top-level module ended: found, on no entry, or at an entry the walk
 *   cannot read, `tail` where that entry was appended
 * @typedef {{name: string, isPart: boolean, at: PyPlace,
 *   namespace: string | null}} PyMiss a dotted part, or a from-imported
 *   name, `descend` found no file for, the place it looked in, and the
 *   namespace directory standing there, if any
 */

/** @param {string} found */
const placeOf = (found) =>
	found.endsWith("__init__.py")
		? { pkg: path.dirname(found), namespace: false }
		: { pkg: null, namespace: false };

/**
 * Pushes the files one import loads onto the walk's reach, or faults an
 * import the walk cannot place.
 * @param {PyWalk} walk accumulator: `reach` gains the files and shadows
 * @param {PyImportTarget} target
 */
function placePyImport(walk, target) {
	if (target.dots > 0) {
		placeRelativePyImport(walk, target);
		return;
	}
	const [top, ...below] = target.parts;
	if (top === undefined) throw new Error("an absolute import names no module");
	const placed = placePyTop(walk.scope, top, walk.reach);
	if (placed.kind === "absent") {
		if (!readPython().stdlib.has(top))
			walk.fault(
				`imports ${top}, which is neither stdlib nor found beside it or on a sys.path entry it adds`,
			);
		return;
	}
	if (placed.kind === "opaque") {
		/* A builtin module is found before sys.path is searched, and a stdlib
		 * one before an entry appended after the stdlib's. */
		const { builtins, stdlib } = readPython();
		if (!builtins.has(top) && !(placed.tail && stdlib.has(top)))
			walk.fault(`imports ${top} after a sys.path edit the walk cannot read`);
		return;
	}
	const dotted = target.parts.join(".");
	for (const place of placed.places)
		descend(walk, place, { parts: below, names: target.names }, (miss) => {
			/* A name a regular package lacks may be an attribute its
			 * __init__.py defines; a namespace package defines none. */
			if (miss.isPart)
				walk.fault(
					`imports ${dotted}, whose ${miss.name} the walk cannot place`,
				);
			else if (miss.at.namespace && !miss.namespace)
				walk.fault(
					`imports ${miss.name} from ${dotted}, a namespace package that holds no ${miss.name}`,
				);
		});
}

/**
 * Walks an import's parts down from `at`, then its from-imported names in
 * the package the parts leave it in, pushing each file found and the paths
 * tried before it. A part or name with no file goes to `miss`; a part ends
 * the descent there, as does one below a plain module, whose names are no
 * submodules.
 * @param {PyWalk} walk accumulator: `reach` gains the files and shadows
 * @param {PyPlace} at
 * @param {{parts: string[], names: string[]}} below the parts under `at`
 *   and the names from-imported at the last
 * @param {(miss: PyMiss) => void} miss
 */
function descend(walk, at, { parts, names }, miss) {
	let here = at;
	for (const part of parts) {
		if (here.pkg === null) {
			miss({ name: part, isPart: true, at: here, namespace: null });
			return;
		}
		const found = pyModuleIn(here.pkg, part);
		walk.reach.shadows.push(...found.tried);
		if (found.found) {
			walk.reach.edges.push(found.found);
			here = placeOf(found.found);
		} else if (found.namespace)
			here = { pkg: found.namespace, namespace: true };
		else {
			miss({ name: part, isPart: true, at: here, namespace: null });
			return;
		}
	}
	if (here.pkg === null) return;
	for (const name of names) {
		const found = pyModuleIn(here.pkg, name);
		walk.reach.shadows.push(...found.tried);
		if (found.found) walk.reach.edges.push(found.found);
		else miss({ name, isPart: false, at: here, namespace: found.namespace });
	}
}

/**
 * A relative import never faults: a target missing from the tree stays an
 * edge, so surface-closure.js reports it unshipped.
 * @param {PyWalk} walk accumulator: `reach` gains the files and shadows
 * @param {PyImportTarget} target
 */
function placeRelativePyImport(walk, { dots, parts, names }) {
	const pkg = path.resolve(walk.dir, "../".repeat(dots - 1));
	const init = path.join(pkg, "__init__.py");
	if (parts.length === 0 && isFile(init)) walk.reach.edges.push(init);
	descend(walk, { pkg, namespace: false }, { parts, names }, (miss) => {
		if (miss.at.pkg !== null)
			walk.reach.edges.push(path.join(miss.at.pkg, `${miss.name}.py`));
	});
}

/**
 * Places a top-level module on the scope's search path, pushing each file it
 * may load and the candidates tried before the one that settles it. An
 * entry an indented statement added may never have run, so a module found
 * there settles nothing: the search goes on, and every file found counts.
 * @param {PyScope} scope
 * @param {string} top
 * @param {Found} reach accumulator: gains the files and shadows
 * @returns {PyTopPlacement}
 */
function placePyTop(scope, top, reach) {
	/** @type {PyPlace[]} */
	const places = [];
	/** @type {string | null} */
	let namespace = null;
	for (const entry of scope.search) {
		if (entry.dir === null) return { kind: "opaque", tail: entry.tail };
		const here = pyModuleIn(entry.dir, top);
		reach.shadows.push(...here.tried);
		namespace ??= here.namespace;
		if (!here.found) continue;
		reach.edges.push(here.found);
		places.push(placeOf(here.found));
		if (!entry.maybe) return { kind: "placed", places };
	}
	/* A namespace package, which CPython takes only where no entry holds a
	 * regular module or package. */
	if (namespace) places.push({ pkg: namespace, namespace: true });
	return places.length > 0 ? { kind: "placed", places } : { kind: "absent" };
}

/* The interpreters whose inline programs are read, and the flag that hands
 * one its program: `-c`, `-e` or `-p` closing any bundle of single-letter
 * flags (python3's `-c` and `-Ic`, node's `-pe`, perl's `-lane`),
 * `--eval`, `--print`, or `-` for a program on stdin. */
const INTERPRETER = String.raw`python(?:3(?:\.\d+)?)?|node|perl|ruby`;
const INLINE_FLAG = "-[A-Za-z]*[cep]|--eval|--print|-";
/* A literal an argument list may hold, and one read whole as a program: a
 * template only where it interpolates nothing and escapes nothing. */
const ARG_LITERAL = String.raw`(?:${ONE_LINE_STRING}|\x60[^\x60]*\x60)`;
const PLAIN_LITERAL = String.raw`${ONE_LINE_STRING}|\x60[^\x60$\\]*\x60`;
/* An interpreter handed its program inline in an argument list:
 * `"python3", ["-c", code]`, `process.execPath, ["-e", code]`,
 * `[sys.executable, "-c", code]`, or `"-"` for a program on stdin. Group 1
 * names the interpreter, group 2 the flag; group 3 is the program, where one
 * plain literal is the whole argument. */
const INLINE_ARGV = new RegExp(
	String.raw`(["'\x60](?:${INTERPRETER})["'\x60]|process\.execPath|sys\.executable)\s*,\s*(?:\[\s*)?(?:${ARG_LITERAL}\s*,\s*)*?["'\x60](${INLINE_FLAG})["'\x60]\s*(?:,\s*(${PLAIN_LITERAL})\s*(?=[,\])]))?`,
	"g",
);
/* The same handed to a shell as one command string: `execSync("python3 -c …")`. */
const INLINE_COMMAND = new RegExp(
	String.raw`\bexec(?:Sync)?\(\s*["'\x60][^"'\x60]*?\b(?:${INTERPRETER})\s+(?:-\S+\s+)*?(?:${INLINE_FLAG})(?=[\s"'\x60])`,
	"g",
);
/* A node program's load of a path handed to it as an argument. */
const ARGV_REQUIRE = /\brequire\(\s*process\.argv\[(\d+)\]\s*\)/g;
/* The escapes a literal program may hold that `literalBody` undoes. */
const LITERAL_ESCAPES = new Map([
	["n", "\n"],
	["t", "\t"],
	["\\", "\\"],
	["'", "'"],
	['"', '"'],
	["`", "`"],
]);

/**
 * @typedef {"python"|"node"|"other"} Interpreter
 * @typedef {{unread: boolean, argv: number[]}} ProgramLoads whether a
 *   program loads a file it does not name to the walk, and the indexes of
 *   the arguments it loads by path
 */

/**
 * A literal program's text, its escapes undone, or null where it holds one
 * `LITERAL_ESCAPES` does not name.
 * @param {string} literal quotes included
 * @returns {string | null}
 */
function literalBody(literal) {
	let unknown = false;
	const body = literal.slice(1, -1).replace(/\\([\s\S])/g, (_, c) => {
		const undone = LITERAL_ESCAPES.get(c);
		if (undone === undefined) unknown = true;
		return undone ?? "";
	});
	return unknown ? null : body;
}

/**
 * The builtin module names of this machine's python3, or null where it
 * cannot list them: a walk for edges alone, as surface-closure.js's, never
 * needs python3 for a shell script's inline program.
 * @returns {Set<string> | null}
 */
function pythonBuiltins() {
	try {
		return readPython().builtins;
	} catch {
		return null;
	}
}

/**
 * What an inline `program` for `interpreter` loads: every load of a program
 * not read is unread; a read one's load is unread unless it is a builtin
 * module, or for node a `require(process.argv[N])`.
 * @param {Interpreter} interpreter
 * @param {string | null} program its text
 * @returns {ProgramLoads}
 */
function programLoads(interpreter, program) {
	if (program === null) return { unread: true, argv: [] };
	if (interpreter === "python") {
		const builtins = pythonBuiltins();
		if (builtins === null) return { unread: true, argv: [] };
		const unread = pyStatements(program, () => undefined).some((s) => {
			const imp = s.text.match(PY_IMPORT);
			if (!imp) return PY_LOAD.test(blankPyStrings(s.text));
			return pyImportTargets(imp).some((t) => {
				const [top] = t.parts;
				return t.dots > 0 || top === undefined || !builtins.has(top);
			});
		});
		return { unread, argv: [] };
	}
	if (interpreter === "node") {
		const specs = [...program.matchAll(JS_SPEC)].map(jsSpecifier);
		const argv = [...program.matchAll(ARGV_REQUIRE)].map((m) =>
			Number(requiredGroup(m, 1, ARGV_REQUIRE)),
		);
		const loads = program.match(/\brequire\b|\bimport\b/g)?.length ?? 0;
		const unread =
			loads !== specs.length + argv.length || !specs.every((s) => isBuiltin(s));
		return { unread, argv };
	}
	return {
		unread: /\b(?:require|use|do|load|eval)\b/.test(program),
		argv: [],
	};
}

/**
 * The inline programs a JS, TypeScript or Python file spawns: one whose
 * loads no walk reads, or that loads an argument by path, which no walk
 * here reads in these languages, is unread.
 * @param {string} code comment lines already cut
 * @returns {{unread: string[], python: boolean}}
 */
function inlineSpawns(code) {
	/** @type {string[]} */
	const unread = [];
	let runsPython = false;
	for (const m of code.matchAll(INLINE_ARGV)) {
		const interpreter = interpreterOf(requiredGroup(m, 1, INLINE_ARGV));
		runsPython ||= interpreter === "python";
		const program =
			m[3] === undefined || requiredGroup(m, 2, INLINE_ARGV) === "-"
				? null
				: literalBody(m[3]);
		const loads = programLoads(interpreter, program);
		if (loads.unread || loads.argv.length > 0)
			unread.push(`spawns ${m[0].replace(/\s+/g, " ")}`);
	}
	for (const m of code.matchAll(INLINE_COMMAND)) {
		runsPython ||= interpreterOf(m[0]) === "python";
		unread.push(`spawns ${m[0].replace(/\s+/g, " ")}`);
	}
	return { unread, python: runsPython };
}

/**
 * @param {string} head an interpreter as written
 * @returns {Interpreter}
 */
function interpreterOf(head) {
	if (/python|executable/.test(head)) return "python";
	if (/node|execPath/.test(head)) return "node";
	return "other";
}

/* ---------------------------------------------------------------- shell */

/**
 * @typedef {import("./shell-script-lexer.js").ShWord} ShWord
 * @typedef {import("./shell-script-lexer.js").ShCommand} ShCommand
 * @typedef {{name: string, at: number, value: string | null,
 *   caller: boolean, bare: boolean, array: boolean}} ShBinding a variable's
 *   assignment: its value an absolute path or null for any other; `caller`
 *   where the value is one the caller hands in (`shCallerWord`), `bare`
 *   where it is a literal name, as `true`, `array` where it is an array's
 *   literal elements
 */

/* The interpreters a shell command may run a file or a program through. */
const SH_INTERPRETER =
	/^(?:node(?:js)?|python(?:3(?:\.\d+)?)?|perl|ruby|bash|sh|dash|zsh|ksh)$/;
/* Matches nothing: a flag kind an interpreter lacks. */
const NONE = /(?!)/;
/* Per interpreter kind: the flag closing a bundle that hands it its program
 * inline; a flag whose next word it loads; one naming a module it finds on
 * its own search path, which the walk cannot place; and one taking a value
 * that is no load. */
const SH_FLAGS = {
	node: {
		inline: /^(?:-[A-Za-z]*[ep]|--eval|--print)$/,
		load: /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file)$/,
		module: NONE,
		value: /^(?:-C|--conditions|--title|--input-type)$/,
	},
	python: {
		inline: /^-[A-Za-z]*c$/,
		load: NONE,
		module: /^-[A-Za-z]*m$/,
		value: /^-[WX]$/,
	},
	other: {
		inline: /^-[A-Za-z]*[eE]$/,
		load: NONE,
		module: /^-[Mmr]/,
		value: /^-[IC]$/,
	},
	shell: {
		inline: /^-[A-Za-z]*c$/,
		load: NONE,
		module: NONE,
		value: /^[-+]o$/,
	},
};
/* Commands whose arguments name an interpreter without running it. */
const SH_NAMING_HEAD =
	/^(?:echo|printf|type|hash|which|pgrep|pkill|grep|die|warn)$/;
/* A flag that runs no program. */
const SH_INFO_FLAG = /^(?:-v|-V|--version|-h|--help)$/;
/* Commands that run the command their own arguments spell, and the flags
 * of each that take a value; `command -v` and `-V` only name one. */
const SH_WRAPPERS = new Map([
	["exec", /^-a$/],
	["command", NONE],
	["builtin", NONE],
	["env", /^(?:-u|-C|-S)$/],
	["nohup", NONE],
	["setsid", NONE],
	["nice", /^-n$/],
	["timeout", /^(?:-k|-s)$/],
	["stdbuf", NONE],
	["xargs", /^(?:-[IndPLsaE]|--max-args|--delimiter|--replace)$/],
]);
/* Commands that bind a name to a value the walk does not read: every name
 * after them, or the first. */
const SH_REBINDS = new Map([
	["read", "all"],
	["mapfile", "all"],
	["readarray", "all"],
	["for", "first"],
	["select", "first"],
]);
/* Commands that declare names; `local X` alone binds no value, as an
 * assignment follows. */
const SH_DECLARES = /^(?:local|export|readonly|declare|typeset)$/;
/* `[[ "$X" == "${BASH_SOURCE[0]}" ]]`, whose `&& X=.` names the directory
 * `.` where the script was run by a bare name: the directory itself. */
const SH_BARE_NAME_TEST = /^\[\[ "\$(\w+)" == "\$\{BASH_SOURCE\[0\]\}" \]\]$/;
/* A word that is one parameter whole: positional (group 3), or a variable
 * (group 1 or 4) with perhaps a default (group 2). */
const SH_ONE_PARAMETER =
	/^"?\$(?:\{(?:[@*]|\d+|(\w+)(?::?-([^}]*))?)\}|([@*]|\d)|(\w+))"?$/;
/* `$PWD/` before a variable; the script's own path, `${BASH_SOURCE[0]}`, or
 * a variable (group 1 or 3), perhaps cut to its directory by `%/*` (group
 * 2). */
const SH_PARAMETER =
	/^\$\{?PWD\}?\/(?=\$)|^\$\{(\w+)(?:\[0\])?(%\/\*)?\}|^\$(\w+)(?!\w)/;
/* `${X:-default}` or `${X-default}`: an inherited X reads as its default,
 * the value where the caller sets none. */
const SH_DEFAULTED = /^\$\{(\w+):?-/;

/**
 * @typedef {{file: string, bindings: Map<string, ShBinding[]>,
 *   unsets: Map<string, number[]>}} ShScope a script's variables: every
 *   assignment of each, and where each is unset
 * @typedef {{scope: ShScope, reach: Reach, said: string}} ShRun one
 *   command's walk: the script's variables, the reach it adds to, and the
 *   command as written, which an unread load names
 */

/**
 * A shell script's reach: each word of a command that reads as a code path,
 * and each file a command loads (`shLoads`). A load word the walk cannot
 * read as a path is unread.
 * @param {string} file absolute
 * @param {string} code
 * @returns {Reach}
 */
function shReach(file, code) {
	const commands = shCommands(code);
	const scope = shScope(file, commands);
	/** @type {Reach} */
	const reach = { edges: [], shadows: [], unread: [], python: false };
	for (const command of commands) {
		for (const word of command.words) {
			const p = shPath(word, scope);
			if (p !== null && p !== file && isCodeFile(p)) reach.edges.push(p);
		}
		shLoads(command, scope, reach);
	}
	reach.edges = [...new Set(reach.edges)];
	return reach;
}

/**
 * Every variable binding in `commands`, each value read on the bindings
 * written before it.
 * @param {string} file absolute
 * @param {ShCommand[]} commands
 * @returns {ShScope}
 */
function shScope(file, commands) {
	/** @type {ShScope} */
	const scope = { file, bindings: new Map(), unsets: new Map() };
	for (const command of commands) {
		const [head, ...rest] = command.words;
		if (head === undefined) continue;
		if (head.text === "unset")
			for (const w of rest) pushTo(scope.unsets, w.text, w.at);
		for (const w of assignmentWords(command)) bindAssignment(scope, command, w);
		for (const w of reboundNames(head.text, rest))
			bind(scope, unknownBinding(w.text, w.at));
	}
	return scope;
}

/**
 * The names a `read`, `mapfile`, `for` or `select` binds to values the walk
 * does not read.
 * @param {string} head
 * @param {ShWord[]} rest
 * @returns {ShWord[]}
 */
function reboundNames(head, rest) {
	const rebound = SH_REBINDS.get(head);
	if (rebound === undefined) return [];
	return (rebound === "first" ? rest.slice(0, 1) : rest).filter((w) =>
		/^[A-Za-z_]\w*$/.test(w.text),
	);
}

/**
 * @template T
 * @param {Map<string, T[]>} map accumulator: `key`'s list gains `value`
 * @param {string} key
 * @param {T} value
 */
function pushTo(map, key, value) {
	map.set(key, [...(map.get(key) ?? []), value]);
}

/**
 * @param {ShScope} scope accumulator: the name gains the binding
 * @param {ShBinding} binding
 */
const bind = (scope, binding) => pushTo(scope.bindings, binding.name, binding);

/**
 * A binding whose value the walk does not read.
 * @param {string} name
 * @param {number} at
 * @returns {ShBinding}
 */
const unknownBinding = (name, at) => ({
	name,
	at,
	value: null,
	caller: false,
	bare: false,
	array: false,
});

/**
 * The assignment words a command opens with, or that a declaration such as
 * `local` or `export` holds.
 * @param {ShCommand} command
 * @returns {ShWord[]}
 */
function assignmentWords(command) {
	const [head, ...rest] = command.words;
	const declares = SH_DECLARES.test(head?.text ?? "");
	const words = declares ? rest : command.words;
	const skipped = (/** @type {ShWord} */ w) =>
		declares && /^(?:-\w+|[A-Za-z_]\w*)$/.test(w.text);
	const end = words.findIndex((w) => !SH_ASSIGN.test(w.text) && !skipped(w));
	return (end === -1 ? words : words.slice(0, end)).filter((w) =>
		SH_ASSIGN.test(w.text),
	);
}

/**
 * Records one assignment word's binding, its value read on the bindings so
 * far: an element or an array binds no one path.
 * @param {ShScope} scope accumulator: the name gains the binding
 * @param {ShCommand} command
 * @param {ShWord} word
 */
function bindAssignment(scope, command, word) {
	const m = word.text.match(SH_ASSIGN);
	if (!m) return;
	const name = requiredGroup(m, 1, SH_ASSIGN);
	const value = {
		text: word.text.slice(m[0].length),
		at: word.at + m[0].length,
	};
	if (value.text === "." && isBareNameFallback(command, name)) return;
	if (m[2] !== undefined || value.text.startsWith("(")) {
		bind(scope, {
			...unknownBinding(name, word.at),
			array: m[2] === undefined,
		});
		return;
	}
	bind(scope, {
		name,
		at: word.at,
		value: shPath(value, scope),
		caller: shCallerWord(value.text, scope),
		bare: /^(["']?)[\w.+-]+\1$/.test(value.text),
		array: false,
	});
}

/**
 * Whether `command`, `X=.`, follows `[[ "$X" == "${BASH_SOURCE[0]}" ]] &&`.
 * @param {ShCommand} command
 * @param {string} name
 */
function isBareNameFallback(command, name) {
	const test = command.prev?.words.map((w) => w.text).join(" ") ?? "";
	return command.joined === "&&" && test.match(SH_BARE_NAME_TEST)?.[1] === name;
}

/**
 * Whether `text` is one value the caller hands in, whole: an argument, all
 * of them, or a variable the script never assigns, bare or with a command
 * name as its default, or one it assigns only such a value. The caller names
 * such a load, and its own walk reads it where it spells it.
 * @param {string} text
 * @param {ShScope} scope
 * @returns {boolean}
 */
function shCallerWord(text, scope) {
	const m = text.match(SH_ONE_PARAMETER);
	if (!m) return false;
	const name = m[1] ?? m[4];
	if (name === undefined) return true;
	if (m[2] !== undefined && !/^[\w.+-]+$/.test(m[2])) return false;
	return (scope.bindings.get(name) ?? []).every((b) => b.caller);
}

/**
 * Whether a command's head names a command off PATH rather than a file: a
 * variable every assignment of which is a literal name, as `found=true`, or
 * the caller's.
 * @param {string} text
 * @param {ShScope} scope
 */
function namesCommand(text, scope) {
	const name = text.match(SH_ONE_PARAMETER)?.[4];
	const bindings = name === undefined ? [] : (scope.bindings.get(name) ?? []);
	return bindings.length > 0 && bindings.every((b) => b.bare || b.caller);
}

/**
 * Whether `text` is `"${X[@]}"` of an array the script assigns only
 * literal elements, whose loads are read where they are written.
 * @param {string} text
 * @param {ShScope} scope
 */
function isLiteralArray(text, scope) {
	const name = text.match(/^"?\$\{(\w+)\[[@*]\]\}"?$/)?.[1];
	const bindings = name === undefined ? [] : (scope.bindings.get(name) ?? []);
	return bindings.length > 0 && bindings.every((b) => b.array);
}

/**
 * A variable's value at `at`: the one path every assignment of it names,
 * where no `unset` before `at` cleared it; null otherwise, and for a name
 * the script never assigns, as an inherited one.
 * @param {ShScope} scope
 * @param {string} name
 * @param {number} at
 * @returns {string | null}
 */
function shLookup(scope, name, at) {
	if ((scope.unsets.get(name) ?? []).some((u) => u < at)) return null;
	const values = new Set((scope.bindings.get(name) ?? []).map((b) => b.value));
	const [only] = values;
	return values.size === 1 && only !== undefined ? only : null;
}

/**
 * A shell word read as an absolute path, or null where any part of it is
 * not: a literal, the script's own path or directory, a variable `shLookup`
 * resolves, `${X%/*}`, an inherited `${X:-default}` as its default, or
 * `$(cd <path> && pwd)`, `$(dirname <path>)` or `$(basename <path>)`.
 * `$PWD/` before a variable adds nothing, as the absolute directory it would
 * make of a relative one is the walk's.
 * @param {ShWord} word
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shPath(word, scope) {
	const value = shWordValue(word.text, word.at, scope);
	return value !== null && path.isAbsolute(value)
		? path.normalize(value)
		: null;
}

/**
 * @param {string} text
 * @param {number} at the word's offset, where its variables are read
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shWordValue(text, at, scope) {
	let out = "";
	let i = 0;
	let quoted = false;
	while (i < text.length) {
		const rest = text.slice(i);
		if (rest.startsWith('"')) quoted = !quoted;
		const piece = rest.startsWith('"')
			? { value: "", length: 1 }
			: shPiece(rest, quoted, at, scope);
		if (piece === null) return null;
		out += piece.value;
		i += piece.length;
	}
	return out;
}

/**
 * The value of the word part opening `rest`, and its length; null where the
 * walk cannot read it.
 * @param {string} rest
 * @param {boolean} quoted inside a double quote, where `'` and globs are
 *   literal
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shPiece(rest, quoted, at, scope) {
	const c = rest.charAt(0);
	if (c === "'" && !quoted) {
		const end = rest.indexOf("'", 1);
		return end === -1 ? null : { value: rest.slice(1, end), length: end + 1 };
	}
	if (c === "\\") return { value: rest.charAt(1), length: 2 };
	if (rest.startsWith("$(") && !rest.startsWith("$((")) {
		const { commands, end } = substitutionAt(rest);
		const value = shSubstitution(commands, at, scope);
		return value === null ? null : { value, length: end };
	}
	if (SH_DEFAULTED.test(rest)) return shDefaulted(rest, at, scope);
	if (c === "$") return shParameter(rest, at, scope);
	if (c === "`" || (/[*?[~]/.test(c) && !quoted)) return null;
	return { value: c, length: 1 };
}

/**
 * `${X:-default}` opening `rest`: X's value where the script assigns it,
 * else its default.
 * @param {string} rest
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shDefaulted(rest, at, scope) {
	const end = braceEnd(rest);
	const m = rest.match(SH_DEFAULTED);
	if (!m) return null;
	const name = requiredGroup(m, 1, SH_DEFAULTED);
	const value = scope.bindings.has(name)
		? shLookup(scope, name, at)
		: shWordValue(rest.slice(m[0].length, end - 1), at, scope);
	return value === null ? null : { value, length: end };
}

/**
 * A parameter opening `rest` (`SH_PARAMETER`).
 * @param {string} rest
 * @param {number} at
 * @param {ShScope} scope
 * @returns {{value: string, length: number} | null}
 */
function shParameter(rest, at, scope) {
	const m = rest.match(SH_PARAMETER);
	if (!m) return null;
	const name = m[1] ?? m[3];
	let value = name === undefined ? "" : shLookup(scope, name, at);
	if (name === "BASH_SOURCE") value = scope.file;
	if (value === null) return null;
	return {
		value: m[2] === undefined ? value : path.dirname(value),
		length: m[0].length,
	};
}

/**
 * A `$(…)` substitution's output read as a path: `cd <path> && pwd`,
 * `dirname <path>` or `basename <path>`; null for any other.
 * @param {ShCommand[]} commands its commands, redirections left out
 * @param {number} at
 * @param {ShScope} scope
 * @returns {string | null}
 */
function shSubstitution(commands, at, scope) {
	const [first, second] = commands.map((c) => c.words.map((w) => w.text));
	const [head, arg] = first?.filter((w) => !w.startsWith("-")) ?? [];
	if (arg === undefined) return null;
	const value = shWordValue(arg, at, scope);
	if (value === null) return null;
	const shape = `${commands.length} ${head}`;
	if (shape === "1 dirname") return path.dirname(value);
	if (shape === "1 basename") return path.basename(value);
	if (shape === "2 cd" && /^pwd(?: -P)?$/.test(second?.join(" ") ?? ""))
		return value;
	return null;
}

/**
 * Adds what one command loads to `reach`: a file sourced or `.`-read, run
 * through an interpreter or by its path. A path read becomes an edge, or a
 * shadow where no file stands there yet.
 * @param {ShCommand} command
 * @param {ShScope} scope
 * @param {Reach} reach accumulator: gains the command's loads
 */
function shLoads(command, scope, reach) {
	const words = runWords(command.words, scope);
	const [head, ...args] = words;
	if (head === undefined) return;
	/** @type {ShRun} */
	const run = { scope, reach, said: words.map((w) => w.text).join(" ") };
	if (SH_INTERPRETER.test(head.text)) {
		shInterpreterLoads(run, head.text, args);
		return;
	}
	/* An array's elements are a command only where an interpreter heads them. */
	if (command.array) return;
	/* A function running its arguments, as `hook_bound node x.js`. */
	const nested = args.findIndex((w) => SH_INTERPRETER.test(w.text));
	const nestedHead = args[nested];
	if (nestedHead && !SH_NAMING_HEAD.test(head.text))
		shInterpreterLoads(run, nestedHead.text, args.slice(nested + 1));
	const [first] = args;
	if ((head.text === "source" || head.text === ".") && first) load(run, first);
	else if (/[/$`]/.test(head.text) && !namesCommand(head.text, scope))
		load(run, head);
}

/**
 * Adds the file `word` names to the run's reach: unread where the walk
 * cannot read it as a path and it is not one the caller hands in whole.
 * @param {ShRun} run accumulator: its reach gains the load
 * @param {ShWord} word
 */
function load(run, word) {
	const p = shPath(word, run.scope);
	if (p !== null) (isFile(p) ? run.reach.edges : run.reach.shadows).push(p);
	else if (!shCallerWord(word.text, run.scope))
		run.reach.unread.push(`loads ${word.text} in \`${run.said}\``);
}

/**
 * A command's words from the one it runs: leading assignments, reserved
 * words, an array of literal elements, whose own loads are read at its
 * elements, and wrappers such as `exec` or `env` with their flags cut.
 * None for `command -v`, which names a command and runs none, or a
 * compound command's head.
 * @param {ShWord[]} words
 * @param {ShScope} scope
 * @returns {ShWord[]}
 */
function runWords(words, scope) {
	let k = 0;
	for (;;) {
		const w = words[k]?.text ?? "";
		const valued = SH_WRAPPERS.get(w);
		if (SH_RESERVED.has(w) || SH_ASSIGN.test(w) || isLiteralArray(w, scope))
			k++;
		else if (valued === undefined) break;
		else if (w === "command" && /^-[vV]$/.test(words[k + 1]?.text ?? ""))
			return [];
		else k = wrappedAt(words, k + 1, valued, w === "timeout");
	}
	if (/^(?:case|for|select|function)$/.test(words[k]?.text ?? "")) return [];
	return words.slice(k);
}

/**
 * Where the command a wrapper runs starts: after its flags, a flag's value,
 * `env`'s assignments and `timeout`'s duration.
 * @param {ShWord[]} words
 * @param {number} k the word after the wrapper
 * @param {RegExp} valued its flags taking a value
 * @param {boolean} timed whether a duration comes before the command
 */
function wrappedAt(words, k, valued, timed) {
	let at = k;
	for (let w = words[at]?.text; w !== undefined; w = words[at]?.text) {
		if (!w.startsWith("-") && !SH_ASSIGN.test(w)) break;
		at += valued.test(w) ? 2 : 1;
	}
	return timed ? at + 1 : at;
}

/**
 * Adds what one interpreter run loads: its script, a file a flag names, or
 * an inline program's loads. A program on stdin, a module off the
 * interpreter's search path and a shell's inline command are unread.
 * @param {ShRun} run accumulator: its reach gains the run's loads
 * @param {string} name the interpreter as written
 * @param {ShWord[]} args
 */
function shInterpreterLoads(run, name, args) {
	const kind = interpreterKind(name);
	const flags = SH_FLAGS[kind];
	for (let k = 0; k < args.length; k++) {
		const t = args[k]?.text ?? "";
		if (SH_INFO_FLAG.test(t)) return;
		const script = scriptWord(args, k);
		if (script) {
			load(run, script);
			return;
		}
		if (kind !== "shell" && flags.inline.test(t)) {
			shInlineProgram(run, kind, args.slice(k + 1));
			return;
		}
		if (/^--?$/.test(t) || flags.module.test(t) || flags.inline.test(t)) break;
		k += shFlagValue(run, flags, args, k);
	}
	run.reach.unread.push(
		`runs \`${run.said}\`, whose program the walk cannot read`,
	);
}

/**
 * The script an interpreter's argument `k` names: itself where it is no
 * flag, the word after a `--`.
 * @param {ShWord[]} args
 * @param {number} k
 */
function scriptWord(args, k) {
	const t = args[k]?.text ?? "";
	if (t === "--") return args[k + 1];
	return t.startsWith("-") ? undefined : args[k];
}

/**
 * How many words a flag's value takes after it: one where the flag takes a
 * value, which is a load where the flag loads it and it reads as a path.
 * @param {ShRun} run accumulator: its reach gains a flag's load
 * @param {{load: RegExp, value: RegExp}} flags
 * @param {ShWord[]} args
 * @param {number} k the flag's index
 */
function shFlagValue(run, flags, args, k) {
	const flag = args[k]?.text ?? "";
	const value = args[k + 1];
	if (flags.load.test(flag) && value && /[/$]/.test(value.text))
		load(run, value);
	return flags.load.test(flag) || flags.value.test(flag) ? 1 : 0;
}

/**
 * @param {string} name an interpreter as written
 * @returns {"node"|"python"|"other"|"shell"}
 */
function interpreterKind(name) {
	if (name.startsWith("node")) return "node";
	if (name.startsWith("python")) return "python";
	return /^(?:perl|ruby)$/.test(name) ? "other" : "shell";
}

/**
 * Adds an inline program's loads: node's `require(process.argv[N])` of an
 * argument read as a path; any other load but a builtin module's is unread.
 * Only a single-quoted program is read, as the shell leaves it as written.
 * @param {ShRun} run accumulator: its reach gains the program's loads
 * @param {Interpreter} kind
 * @param {ShWord[]} words the program, then its arguments
 */
function shInlineProgram(run, kind, words) {
	const [program, ...args] = words;
	run.reach.python ||= kind === "python";
	const text =
		program !== undefined && /^'[^']*'$/.test(program.text)
			? program.text.slice(1, -1)
			: null;
	const { unread, argv } = programLoads(kind, text);
	if (unread) {
		run.reach.unread.push(
			`runs \`${run.said}\`, whose program the walk cannot read`,
		);
		return;
	}
	for (const n of argv) {
		const word = args[n - 1];
		const p = word === undefined ? null : shPath(word, run.scope);
		if (p === null)
			run.reach.unread.push(
				`runs \`${run.said}\`, whose program loads argument ${n}, no path it reads`,
			);
		else run.reach.edges.push(p);
	}
}

module.exports = {
	edgesOf,
	isCodeFile,
	languageOf,
	isFile,
	pythonVersion,
	reachOf,
	JS_SPEC,
	jsSpecifier,
};
