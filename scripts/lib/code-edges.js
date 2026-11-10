/*
 * code-edges.js — the files one script reaches, read lexically, comment lines
 * skipped, for surface-closure.js's and hook-code.js's walks (#4259):
 *   JS and TypeScript — a relative `require`/`from`/`import()` specifier,
 *     resolved as node resolves it, or as vitest does an extensionless `.ts`;
 *     and `path.join|resolve(__dirname, "<literal>", …)` naming a .js, .sh or
 *     .py, the spelling of check.js's notify-report.js (#459) and
 *     doc-map-generator.js's session-arbiter.js spawn (#460).
 *   shell — a path spelled from the file's own directory,
 *     `$(dirname "${BASH_SOURCE[0]}")/x` or `${BASH_SOURCE[0]%/*}/x`, whether
 *     sourced or run (#460).
 *   Python — `import X` or `from X import`, X.py sitting beside the importer
 *     (#465).
 * A path built any other way is unseen.
 *
 * FOREIGN: a Python module neither stdlib (python3's own
 * sys.stdlib_module_names, so 3.10 or later) nor beside its importer is
 * handed to the caller's `fault`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cutAt } = require("./cut-at.js");
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
	const hit = candidates.findIndex(isFile);
	return hit < 0
		? { target: abs, tried: [] }
		: { target: candidates[hit] ?? abs, tried: candidates.slice(0, hit) };
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
	if (file.endsWith(".py")) return pyEdges(dir, text, fault);
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
 * @param {string} dir the file's directory
 * @param {string} text
 * @param {(msg: string) => void} fault
 * @returns {string[]}
 */
function pyEdges(dir, text, fault) {
	/** @type {string[]} */
	const edges = [];
	const code = text.replace(PY_STRING_BLOCK, "");
	for (const line of parseCodeLines(code, /^\s*#/))
		for (const statement of line.split(";")) {
			const m = statement.match(PY_IMPORT);
			if (!m) continue;
			for (const mod of pyImportedModules(m))
				pushPyModuleEdge(dir, mod, edges, fault);
		}
	return edges;
}

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
 * The modules one import statement names; a sibling one from `from . import`
 * keeps its leading dot.
 * @param {RegExpMatchArray} m a `PY_IMPORT` match
 * @returns {string[]}
 */
function pyImportedModules(m) {
	/* Group 1 is the `from` branch, which always carries group 2; group
	 * 3 is the bare `import` branch. */
	const [, from, fromNames, bareNames] = m;
	if (from === undefined) {
		if (bareNames === undefined)
			throw new Error(`PY_IMPORT matched neither branch: ${m[0]}`);
		return pyNames(bareNames);
	}
	if (/^\.+$/.test(from)) {
		if (fromNames === undefined)
			throw new Error(`PY_IMPORT's from branch matched without names: ${m[0]}`);
		return pyNames(fromNames).map((n) => `.${n}`);
	}
	return [from];
}

/**
 * Pushes the shipped file `mod` resolves to beside the importer, or faults a
 * module that is neither there nor stdlib.
 * @param {string} dir the importer's directory
 * @param {string} mod
 * @param {string[]} edges accumulator: the resolved file is pushed here
 * @param {(msg: string) => void} fault
 */
function pushPyModuleEdge(dir, mod, edges, fault) {
	const [top] = cutAt(mod.replace(/^\.+/, ""), ".");
	const module = path.join(dir, `${top}.py`);
	const pkg = path.join(dir, top, "__init__.py");
	if (fs.existsSync(pkg) && !fs.existsSync(module)) edges.push(pkg);
	else if (fs.existsSync(module) || mod.startsWith(".")) edges.push(module);
	else if (!readPythonStdlib().has(top))
		fault(`imports ${top}, which is neither stdlib nor shipped beside it`);
}

module.exports = { edgesOf, isFile, shadowsOf, JS_SPEC, jsSpecifier };
