/*
 * code-edges.js — the files one script reaches, read lexically, comment lines
 * skipped, for surface-closure.js's and hook-code.js's walks (#4259) and the
 * pass store's reach, which also reads the paths each specifier tried before
 * its target (`reachOf`'s shadows, #4814):
 *   JS and TypeScript — a relative `require`/`from`/`import()` specifier,
 *     resolved as node resolves it, or as vitest does an extensionless `.ts`;
 *     and `path.join|resolve(__dirname, "<literal>", …)` naming a code file,
 *     the spelling of check.js's notify-report.js (#459) and
 *     doc-map-generator.js's session-arbiter.js spawn (#460).
 *   shell — a path spelled from the file's own directory,
 *     `$(dirname "${BASH_SOURCE[0]}")/x` or `${BASH_SOURCE[0]%/*}/x`, whether
 *     sourced or run (#460).
 *   Python — `import X.Y` or `from X import Z` (#465, #4864): X searched as
 *     CPython would, on the importer's directory and each sys.path entry the
 *     file adds before the import through a literal `insert(0, …)` or
 *     `append(…)` of a path built from `__file__`, literals and names it
 *     assigned from them; then each dotted part, and each `Z` that is a
 *     submodule, in the package found. Read in lexical order; an indented
 *     sys.path edit may never have run, so a module found on its entry
 *     settles nothing, and an indented import, or one on a one-line compound
 *     statement's body, is placed again on the file's final search path.
 * A path built any other way is unseen. A JSX or TSX file is code the walk
 * cannot read.
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
 * INLINE CODE: `inlineCodeSpawns` names each spawn of python, node, perl or
 * ruby handed its program inline (`-c`, `-e`, `-p`, `--eval`, `--print`) or
 * on stdin (`-`), whose loads no walk here reads, unless the program is one
 * plain literal that loads only builtin modules. Residual: a shell's `-c`,
 * through which tests run any command, and an interpreter named by a variable.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isBuiltin } = require("node:module");
const { JS_COMMENT_LINE } = require("./qualify-citations.js");
const { requiredGroup } = require("./regex-group.js");
/* The code files the walk reads, and those it cannot: a JSX or TSX source,
 * whose loads it never parses. */
const WALKED_CODE = /\.(?:[cm]?[jt]s|sh|py)$/;
const UNWALKED_CODE = /\.[cm]?[jt]sx$/;
/**
 * Whether `file` is code a script may load or spawn, walked or not.
 * @param {string} file
 */
const isCodeFile = (file) => WALKED_CODE.test(file) || UNWALKED_CODE.test(file);
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
const SH_SIBLING =
	/(?:\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)|\$\{BASH_SOURCE\[0\]%\/\*\})\/([\w./-]+\.(?:sh|js|py))/g;
const PY_IMPORT =
	/^\s*(?:from\s+([\w.]+)\s+import\s+\(?([\w., ]*)|import\s+([\w., ]+))/;
/* Any statement that may load a module, read with its strings blanked: one
 * `PY_IMPORT` does not match is an import the walk cannot parse. */
const PY_LOAD = /\bimport\b|\b__import__\s*\(|\bimport_module\s*\(/;
/* A triple-quoted block, a one-line string or a comment, whichever starts
 * first, so a quote inside a comment opens nothing. */
const PY_LEXEME =
	/("""|''')[\s\S]*?\1|"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|#[^\n]*/g;
const PY_STRING = /"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'/g;
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
 * @typedef {{edges: string[], shadows: string[]}} Reach absolute: the files
 *   reached, and the paths tried on the way before the file each resolved to
 */

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {Reach}
 */
function reachOf(file, text, fault) {
	const dir = path.dirname(file);
	if (/\.[cm]?[jt]s$/.test(file)) return jsReach(dir, text);
	if (file.endsWith(".sh")) return { edges: shEdges(dir, text), shadows: [] };
	if (file.endsWith(".py")) return pyReach(file, text, fault);
	if (UNWALKED_CODE.test(file))
		fault(`is ${path.extname(file)} code, whose loads the walk cannot read`);
	return { edges: [], shadows: [] };
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
 * @param {string} text
 * @returns {Reach}
 */
function jsReach(dir, text) {
	const code = parseCodeLines(text, JS_COMMENT_LINE).join("\n");
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
 * @param {string} dir the file's directory
 * @param {string} text
 * @returns {string[]}
 */
function shEdges(dir, text) {
	/** @type {string[]} */
	const edges = [];
	for (const line of parseCodeLines(text, /^\s*#/))
		for (const m of line.matchAll(SH_SIBLING))
			edges.push(path.join(dir, requiredGroup(m, 1, SH_SIBLING)));
	return edges;
}

/**
 * @typedef {{dir: string | null, maybe: boolean, tail: boolean}} PyEntry one
 *   sys.path entry: a null `dir` is one the walk cannot read; `maybe` marks
 *   one an indented statement added, which may never have run; `tail` one
 *   appended, so searched after the stdlib's own entries.
 * @typedef {{search: PyEntry[], names: Map<string, string>}} PyScope
 *   `search` is sys.path as the file has left it, its own directory
 *   included.
 * @typedef {{file: string, dir: string, scope: PyScope, reach: Reach,
 *   fault: (msg: string) => void}} PyWalk
 * @typedef {{text: string, indented: boolean}} PyStatement
 */

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {Reach}
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
 * @param {Reach} reach accumulator: gains the files and shadows
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

/* A literal an argument list may hold, and one read whole as a program: no
 * interpolation, no escape it would have to undo. */
const ARG_LITERAL =
	String.raw`(?:"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|` +
	"`[^`]*`)";
const PLAIN_LITERAL =
	String.raw`"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|` +
	"`[^`$\\\\]*`";
/* An interpreter handed its program inline in an argument list:
 * `"python3", ["-c", code]`, `process.execPath, ["-e", code]`,
 * `[sys.executable, "-c", code]`, or `"-"` for a program on stdin. Group 1
 * names the interpreter; group 2 is the program, where one plain literal is
 * the whole argument. */
const INLINE_ARGV = new RegExp(
	String.raw`(["'\x60](?:python(?:3(?:\.\d+)?)?|node|perl|ruby)["'\x60]|process\.execPath|sys\.executable)\s*,\s*(?:\[\s*)?(?:${ARG_LITERAL}\s*,\s*)*?["'\x60](?:-[A-Za-z]{0,2}[cep]|--eval|--print|-)["'\x60]\s*(?:,\s*(${PLAIN_LITERAL})\s*(?=[,\])]))?`,
	"g",
);
/* The same handed to a shell as one command string: `execSync("python3 -c …")`. */
const INLINE_COMMAND =
	/\bexec(?:Sync)?\(\s*["'`][^"'`]*?\b(?:python(?:3(?:\.\d+)?)?|node|perl|ruby)\s+(?:-\S+\s+)*?(?:-[A-Za-z]{0,2}[cep]|--eval|--print|-)(?=[\s"'`])/g;

/**
 * Whether an inline `program` for `interpreter` may load a file: any program
 * not one plain literal, and one that loads a module other than a builtin.
 * @param {"python"|"node"|"other"} interpreter
 * @param {string | undefined} program the literal, quotes included
 */
function loadsUnseen(interpreter, program) {
	if (program === undefined) return true;
	const body = program.slice(1, -1);
	if (interpreter === "python") {
		const { builtins } = readPython();
		return pyStatements(body, () => undefined).some((s) => {
			const imp = s.text.match(PY_IMPORT);
			if (!imp) return PY_LOAD.test(blankPyStrings(s.text));
			return pyImportTargets(imp).some(
				(t) => t.dots > 0 || !builtins.has(t.parts[0] ?? ""),
			);
		});
	}
	if (interpreter === "node") {
		const specs = [...body.matchAll(JS_SPEC)].map(jsSpecifier);
		const loads = body.match(/\brequire\b|\bimport\b/g)?.length ?? 0;
		return loads !== specs.length || !specs.every((s) => isBuiltin(s));
	}
	return /\b(?:require|use|do|load|eval)\b/.test(body);
}

/**
 * Each spawn in `file` of an interpreter handed its program inline, whose
 * loads no walk here reads: the pass store's reach cannot know them.
 * @param {string} file
 * @param {string} text
 * @returns {string[]} each such spawn as written, whitespace folded
 */
function inlineCodeSpawns(file, text) {
	const comment = commentLineOf(file);
	if (comment === null) return [];
	const code = parseCodeLines(text, comment).join("\n");
	/** @type {string[]} */
	const found = [];
	for (const m of code.matchAll(INLINE_ARGV))
		if (loadsUnseen(interpreterOf(requiredGroup(m, 1, INLINE_ARGV)), m[2]))
			found.push(m[0].replace(/\s+/g, " "));
	for (const m of code.matchAll(INLINE_COMMAND))
		found.push(m[0].replace(/\s+/g, " "));
	return found;
}

/**
 * A comment line in `file`'s language, or null where `inlineCodeSpawns`
 * reads no spawns in it.
 * @param {string} file
 * @returns {RegExp | null}
 */
function commentLineOf(file) {
	if (file.endsWith(".py")) return /^\s*#/;
	if (/\.[cm]?[jt]sx?$/.test(file)) return JS_COMMENT_LINE;
	return null;
}

/**
 * @param {string} head an `INLINE_ARGV` interpreter as written
 * @returns {"python"|"node"|"other"}
 */
function interpreterOf(head) {
	if (/python|executable/.test(head)) return "python";
	if (/node|execPath/.test(head)) return "node";
	return "other";
}

module.exports = {
	edgesOf,
	inlineCodeSpawns,
	isCodeFile,
	isFile,
	pythonVersion,
	reachOf,
	JS_SPEC,
	jsSpecifier,
};
