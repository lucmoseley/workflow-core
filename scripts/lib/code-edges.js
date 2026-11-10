/*
 * code-edges.js — the files one script reaches, read lexically, comment lines
 * skipped, for surface-closure.js's and hook-code.js's walks (#4259) and the
 * pass store's reach, which also reads the paths each specifier tried before
 * its target (`shadowsOf`, #4814):
 *   JS and TypeScript — a relative `require`/`from`/`import()` specifier,
 *     resolved as node resolves it, or as vitest does an extensionless `.ts`;
 *     and `path.join|resolve(__dirname, "<literal>", …)` naming a .js, .sh or
 *     .py, the spelling of check.js's notify-report.js (#459) and
 *     doc-map-generator.js's session-arbiter.js spawn (#460).
 *   shell — a path spelled from the file's own directory,
 *     `$(dirname "${BASH_SOURCE[0]}")/x` or `${BASH_SOURCE[0]%/*}/x`, whether
 *     sourced or run (#460).
 *   Python — `import X.Y` or `from X import Z` (#465, #4864): X searched as
 *     CPython would, on the importer's directory and each sys.path entry the
 *     file adds before the import through a literal `insert(0, …)` or
 *     `append(…)` of a path built from `__file__`, literals and names it
 *     assigned from them; then each dotted part, and each `Z` that is a
 *     submodule, in the package found. Read in lexical order, so an edit
 *     under a condition counts as made.
 * A path built any other way is unseen.
 *
 * FOREIGN: a Python import the walk cannot place — a module neither stdlib
 * (python3's own sys.stdlib_module_names, so 3.10 or later) nor on that
 * search path, a dotted part it cannot find, or any import after a sys.path
 * edit it cannot read — is handed to the caller's `fault`. A third-party
 * package is foreign: no tracked file pins what is installed. Residual: a
 * repo file appearing on the search path under a stdlib module's name is
 * not a shadow.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { JS_COMMENT_LINE } = require("./qualify-citations.js");
const { requiredGroup } = require("./regex-group.js");
const CODE_FILE = /\.(?:[cm]?js|sh|py)$/;
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
const PY_STRING_BLOCK = /("""|''')[\s\S]*?\1/g;
const PY_STRING = /"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'/g;
const PY_STRING_OR_COMMENT = new RegExp(`(${PY_STRING.source})|#.*`, "g");
/* Any statement that adds to sys.path; SYS_PATH_ADD is the shape of one
 * the walk reads, `insert(0, …)` (group 1) or `append(…)` (group 2). */
const SYS_PATH_EDIT =
	/\bsys\.path\s*(?:\.\s*(?:insert|append|extend)\b|\[[^\]]*\]\s*=|\+=|=(?!=))/;
const SYS_PATH_ADD =
	/^\s*sys\.path\.(?:insert\(\s*0\s*,(.+)\)|append\((.+)\))\s*$/;
const PY_ASSIGN = /^\s*([A-Za-z_]\w*)\s*=(?!=)(.+)$/;
const PY_PATH_TOKEN = /(?:(\.?[A-Za-z_][\w.]*)|("[^"\\]*"|'[^'\\]*')|([(),/]))/;
const PY_PATH_CALLS = new Set([
	"str",
	"os.fspath",
	"Path",
	"pathlib.Path",
	"os.path.abspath",
	"os.path.realpath",
	"os.path.normpath",
	"os.path.dirname",
	"os.path.join",
]);
const PY_IDENTITY_METHODS = new Set(["resolve", "absolute"]);

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

/** @type {Set<string> | null} */
let stdlib = null;
/** @returns {Set<string>} */
function readPythonStdlib() {
	if (stdlib) return stdlib;
	const r = spawnSync(
		"python3",
		["-c", "import sys; print('\\n'.join(sys.stdlib_module_names))"],
		{ encoding: "utf8" },
	);
	if (r.status !== 0)
		throw new Error(
			`python3 cannot list its stdlib (${(r.stderr || String(r.error)).trim().split("\n")[0]})`,
		);
	stdlib = new Set(r.stdout.split("\n").filter(Boolean));
	return stdlib;
}

/**
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {string[]} absolute paths the file reaches
 */
function edgesOf(file, text, fault) {
	const dir = path.dirname(file);
	if (/\.[cm]?[jt]s$/.test(file)) return jsEdges(dir, text);
	if (file.endsWith(".sh")) return shEdges(dir, text);
	if (file.endsWith(".py")) return pyReach(file, text, fault).edges;
	return [];
}

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
 * The paths a JS or TypeScript file's relative specifiers tried before the
 * file each resolved to (#4814): a file appearing at one would take the
 * import over.
 * @param {string} file absolute
 * @param {string} text
 * @returns {string[]} absolute
 */
function shadowsOf(file, text) {
	if (file.endsWith(".py"))
		return pyReach(file, text, () => {
			/* edgesOf's caller reports the faults */
		}).shadows;
	if (!/\.[cm]?[jt]s$/.test(file)) return [];
	const code = parseCodeLines(text, JS_COMMENT_LINE).join("\n");
	return relativeSpecifiers(path.dirname(file), code).flatMap(
		(abs) => resolutionOf(abs).tried,
	);
}

/**
 * @param {string} dir the file's directory
 * @param {string} text
 * @returns {string[]}
 */
function jsEdges(dir, text) {
	const code = parseCodeLines(text, JS_COMMENT_LINE).join("\n");
	const edges = relativeSpecifiers(dir, code).map(
		(abs) => resolutionOf(abs).target,
	);
	for (const m of code.matchAll(DIRNAME_JOIN)) {
		const parts = [...requiredGroup(m, 1, DIRNAME_JOIN).matchAll(QUOTED)].map(
			(p) => requiredGroup(p, 1, QUOTED),
		);
		const target = path.join(dir, ...parts);
		if (CODE_FILE.test(target)) edges.push(target);
	}
	return edges;
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
 * @typedef {{edges: string[], shadows: string[]}} PyReach
 * @typedef {{search: (string | null)[], names: Map<string, string>}} PyScope
 *   `search` is sys.path as the file has left it, its own directory
 *   included; null stands for an entry the walk cannot read.
 */

/**
 * A Python file's reach: the files its imports load, and the paths each
 * import tried before the file it found (#4864).
 * @param {string} file absolute
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {PyReach}
 */
function pyReach(file, text, fault) {
	const dir = path.dirname(file);
	/** @type {PyScope} */
	const scope = { search: [dir], names: new Map() };
	/** @type {PyWalk} */
	const walk = { dir, scope, reach: { edges: [], shadows: [] }, fault };
	for (const statement of pyStatements(text)) {
		const imp = statement.match(PY_IMPORT);
		if (imp) {
			for (const target of pyImportTargets(imp)) placePyImport(walk, target);
			continue;
		}
		if (SYS_PATH_EDIT.test(statement)) {
			editSysPath(file, scope, statement);
			continue;
		}
		const assign = statement.match(PY_ASSIGN);
		if (assign) {
			const name = requiredGroup(assign, 1, PY_ASSIGN);
			const value = evalPyPath(
				requiredGroup(assign, 2, PY_ASSIGN),
				file,
				scope,
			);
			if (value === null) scope.names.delete(name);
			else scope.names.set(name, value);
		}
	}
	return walk.reach;
}

/**
 * The file's logical statements in order: triple-quoted blocks and comments
 * cut, bracketed and backslash continuations joined, `;` split.
 * @param {string} text
 * @returns {string[]}
 */
function pyStatements(text) {
	/** @type {string[]} */
	const statements = [];
	let pending = "";
	let depth = 0;
	for (const raw of text.replace(PY_STRING_BLOCK, "").split("\n")) {
		const line = raw.replace(PY_STRING_OR_COMMENT, (_m, s) => s ?? "");
		const blank = line.replace(PY_STRING, '""');
		depth +=
			(blank.match(/[([{]/g)?.length ?? 0) -
			(blank.match(/[)\]}]/g)?.length ?? 0);
		const continued = /\\\s*$/.test(line);
		pending += ` ${continued ? line.replace(/\\\s*$/, "") : line}`;
		if (depth > 0 || continued) continue;
		statements.push(...pending.split(";"));
		pending = "";
		depth = 0;
	}
	if (pending) statements.push(...pending.split(";"));
	return statements;
}

/**
 * Applies one sys.path edit to `scope`: a literal `insert(0, …)` or
 * `append(…)` whose path `evalPyPath` reads, or else an entry the walk
 * cannot read at the front.
 * @param {string} file
 * @param {PyScope} scope
 * @param {string} statement
 */
function editSysPath(file, scope, statement) {
	const m = statement.match(SYS_PATH_ADD);
	const value = m
		? evalPyPath(m[1] ?? requiredGroup(m, 2, SYS_PATH_ADD), file, scope)
		: null;
	if (m?.[2] === undefined) scope.search.unshift(value);
	else scope.search.push(value);
}

/**
 * The absolute path a Python path expression spells, or null where it is
 * built from anything but `__file__`, string literals, the names this file
 * assigned from them, and `Path`, `os.path` and `str` over those.
 * @param {string} expr
 * @param {string} file
 * @param {PyScope} scope
 * @returns {string | null}
 */
function evalPyPath(expr, file, scope) {
	/** @type {string[]} */
	const tokens = [];
	const tokenRe = new RegExp(PY_PATH_TOKEN.source, "g");
	if (expr.replace(tokenRe, "").trim() !== "") return null;
	for (const m of expr.matchAll(tokenRe))
		tokens.push(m[1] ?? m[2] ?? requiredGroup(m, 3, PY_PATH_TOKEN));
	try {
		const parser = new PyPathParser(tokens, file, scope);
		const v = parser.quotient();
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
	 * @param {string} file
	 * @param {PyScope} scope
	 */
	constructor(tokens, file, scope) {
		this.tokens = tokens;
		this.i = 0;
		this.file = file;
		this.scope = scope;
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

	/** @returns {string} */
	quotient() {
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
			const v = this.quotient();
			this.expect(")");
			return v;
		}
		if (this.peek() === "(" && PY_PATH_CALLS.has(t)) return this.call(t);
		const [base = "", ...rest] = t.split(".");
		const v = base === "__file__" ? this.file : this.scope.names.get(base);
		if (v === undefined) throw new Error(`unknown ${base}`);
		return rest.length > 0 ? this.attrs(v, rest.join(".")) : v;
	}

	/** @param {string} name one of `PY_PATH_CALLS` */
	call(name) {
		this.expect("(");
		/** @type {string[]} */
		const args = [];
		while (this.peek() !== ")") {
			args.push(this.quotient());
			if (this.peek() === ",") this.take();
		}
		this.take();
		return pyPathCall(name, args);
	}

	/**
	 * @param {string} v
	 * @param {string} chain dotted attributes, the last perhaps a method
	 */
	attrs(v, chain) {
		const parts = chain.split(".");
		for (const [k, part] of parts.entries()) {
			const method =
				k === parts.length - 1 &&
				PY_IDENTITY_METHODS.has(part) &&
				this.peek() === "(";
			if (part === "parent") v = path.dirname(v);
			else if (method) {
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
	if (name === "os.path.join" || name.endsWith("Path")) return pyJoin(args);
	if (args.length !== 1) throw new Error(`${name} takes one path`);
	if (name === "os.path.dirname") return path.dirname(first);
	/* str, os.fspath, and abspath, realpath and normpath over an absolute
	 * path, all of which leave it naming the same file. */
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
	const dots = requiredGroup(
		/** @type {RegExpMatchArray} */ (from.match(/^\.*/)),
		0,
		/^\.*/,
	).length;
	const rest = from.slice(dots);
	return [
		{
			dots,
			parts: rest ? rest.split(".") : [],
			names: pyNames(fromNames.replace(/[()]/g, "")),
		},
	];
}

/**
 * The file a module name resolves to in one directory, package first as
 * CPython's FileFinder tries them, and the candidates tried before it.
 * @param {string} dir
 * @param {string} name
 * @returns {{found: string | null, tried: string[]}}
 */
function pyModuleIn(dir, name) {
	const candidates = [
		path.join(dir, name, "__init__.py"),
		path.join(dir, `${name}.py`),
	];
	const at = candidates.findIndex(isFile);
	return at === -1
		? { found: null, tried: candidates }
		: { found: candidates[at] ?? null, tried: candidates.slice(0, at) };
}

/** @param {string} c */
const isDir = (c) =>
	fs.statSync(c, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * @typedef {{dir: string, scope: PyScope, reach: PyReach,
 *   fault: (msg: string) => void}} PyWalk one file's walk: its directory,
 *   its sys.path so far, what it reaches, and its caller's fault
 */

/**
 * Pushes the files one import loads onto the walk's reach, or faults an
 * import the walk cannot place.
 * @param {PyWalk} walk
 * @param {PyImportTarget} target
 */
function placePyImport(walk, target) {
	if (target.dots > 0) {
		placeRelativePyImport(walk.dir, target, walk.reach);
		return;
	}
	const [top = ""] = target.parts;
	const placed = placePyTop(walk.scope, top, walk.reach);
	if (placed === "opaque" || placed === null) {
		if (!readPythonStdlib().has(top))
			walk.fault(
				placed === null
					? `imports ${top}, which is neither stdlib nor found beside it or on a sys.path entry it adds`
					: `imports ${top} after a sys.path edit the walk cannot read`,
			);
		return;
	}
	const pkg = placeBelow(walk, placed || null, target.parts);
	if (pkg === null) return;
	for (const name of target.names) {
		const { found } = pyModuleIn(pkg, name);
		if (found) walk.reach.edges.push(found);
	}
}

/**
 * Walks a dotted import's parts below its top-level one, pushing each file;
 * returns the package the last part opens, or null where it is a plain
 * module or the walk faulted.
 * @param {PyWalk} walk
 * @param {string | null} pkg the top-level package's directory, null for a module
 * @param {string[]} parts
 * @returns {string | null}
 */
function placeBelow(walk, pkg, parts) {
	for (const part of parts.slice(1)) {
		const found = pkg === null ? null : pyModuleIn(pkg, part).found;
		if (found) {
			walk.reach.edges.push(found);
			pkg = found.endsWith("__init__.py") ? path.dirname(found) : null;
		} else if (pkg !== null && isDir(path.join(pkg, part)))
			pkg = path.join(pkg, part);
		else {
			walk.fault(
				`imports ${parts.join(".")}, whose ${part} the walk cannot place`,
			);
			return null;
		}
	}
	return pkg;
}

/**
 * A relative import never faults: a target missing from the tree stays an
 * edge, so surface-closure.js reports it unshipped.
 * @param {string} dir the importer's directory
 * @param {PyImportTarget} target
 * @param {PyReach} reach
 */
function placeRelativePyImport(dir, { dots, parts, names }, reach) {
	let pkg = path.resolve(dir, "../".repeat(dots - 1));
	const init = path.join(pkg, "__init__.py");
	if (parts.length === 0 && isFile(init)) reach.edges.push(init);
	for (const part of parts) {
		const { found } = pyModuleIn(pkg, part);
		reach.edges.push(found ?? path.join(pkg, `${part}.py`));
		if (!found?.endsWith("__init__.py")) return;
		pkg = path.dirname(found);
	}
	for (const name of names)
		reach.edges.push(
			pyModuleIn(pkg, name).found ?? path.join(pkg, `${name}.py`),
		);
}

/**
 * Places a top-level module on the scope's search path: pushes its file and
 * the candidates tried before it, and returns the package directory it
 * opens, "" for a plain module, null where no entry holds it, or "opaque"
 * where an entry the walk cannot read comes first.
 * @param {PyScope} scope
 * @param {string} top
 * @param {PyReach} reach
 * @returns {string | null}
 */
function placePyTop(scope, top, reach) {
	/** @type {string[]} */
	const tried = [];
	for (const entry of scope.search) {
		if (entry === null) return "opaque";
		const { found, tried: here } = pyModuleIn(entry, top);
		tried.push(...here);
		if (found) {
			reach.edges.push(found);
			reach.shadows.push(...tried);
			return found.endsWith("__init__.py") ? path.dirname(found) : "";
		}
	}
	/* A namespace package: a directory with no __init__.py, which CPython
	 * takes only where no entry holds a regular module or package. */
	const namespace = scope.search.find(
		(entry) => entry !== null && isDir(path.join(entry, top)),
	);
	if (!namespace) return null;
	reach.shadows.push(...tried);
	return path.join(namespace, top);
}

module.exports = { edgesOf, isFile, shadowsOf, JS_SPEC, jsSpecifier };
