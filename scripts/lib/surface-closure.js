/*
 * surface-closure.js — does a rendered plugin tree carry the helper surface
 * whole? Every entry point and command scripts/lib/helper-surface.json lists
 * (#655), every file each one reaches, and nothing reached from outside the
 * tree (#464, spec #457).
 *
 * A PRESENCE CLOSURE, NOT A LOAD CLOSURE: a file loaded lazily, or run rather
 * than imported, still has to ship. The edges, all lexical, comment lines
 * skipped:
 *   JS and TypeScript — a relative `require`/`from`/`import()` specifier,
 *     resolved as node resolves it, or as vitest does an extensionless `.ts`; and `path.join|resolve(__dirname, "<literal>", …)` naming a
 *     .js, .sh or .py, the spelling of check.js's notify-report.js (#459) and
 *     doc-map-generator.js's session-arbiter.js spawn (#460).
 *   shell — a path spelled from the file's own directory,
 *     `$(dirname "${BASH_SOURCE[0]}")/x` or `${BASH_SOURCE[0]%/*}/x`, whether
 *     sourced or run (#460).
 *   Python — `import X` or `from X import`, X.py sitting beside the importer
 *     (#465).
 * A path built any other way is unseen.
 *
 * FOREIGN: a Python module neither stdlib (python3's own
 * sys.stdlib_module_names, so 3.10 or later) nor beside its importer is a
 * fault. A JS file's npm package is not judged here: plugin-tree.js's scan
 * already faults one in every shipped file.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cutAt } = require("./cut-at.js");
const { JS_COMMENT_LINE } = require("./qualify-citations.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");

const MANIFEST = "scripts/lib/helper-surface.json";
const CODE_FILE = /\.(?:[cm]?js|sh|py)$/;
/* Every literal module specifier: `require(…)`, `require.resolve(…)`,
 * `from "…"`, `import(…)` and a bare `import "…"`. plugin-tree.js's package
 * scan reads the same. */
const JS_SPEC =
	/\brequire(?:\.resolve)?\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

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
	/\bpath\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*["'][^"']+["'])+)\s*,?\s*\)/g;
const QUOTED = /["']([^"']+)["']/g;
const SH_SIBLING =
	/(?:\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)|\$\{BASH_SOURCE\[0\]%\/\*\})\/([\w./-]+\.(?:sh|js|py))/g;
const PY_IMPORT =
	/^\s*(?:from\s+(\.+[\w.]*|[\w.]+)\s+import\s+\(?([\w., ]*)|import\s+([\w., ]+))/;
const PY_STRING_BLOCK = /("""|''')[\s\S]*?\1/g;

/**
 * @param {string} text
 * @param {RegExp} comment
 */
const codeLines = (text, comment) =>
	text.split("\n").filter((line) => !comment.test(line));

/**
 * The file node would load for a relative specifier, or the bare join where
 * none exists — so a miss names the path as written.
 * @param {string} abs
 */
function resolveJs(abs) {
	for (const c of [
		abs,
		`${abs}.js`,
		`${abs}.json`,
		`${abs}.ts`,
		path.join(abs, "index.js"),
	])
		if (fs.statSync(c, { throwIfNoEntry: false })?.isFile()) return c;
	return abs;
}

/** @type {Set<string> | null} */
let stdlib = null;
/** @returns {Set<string>} */
function pythonStdlib() {
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
 * @param {string} dir the file's directory
 * @param {string} text
 * @returns {string[]}
 */
function jsEdges(dir, text) {
	/** @type {string[]} */
	const edges = [];
	const code = codeLines(text, JS_COMMENT_LINE).join("\n");
	for (const m of code.matchAll(JS_SPEC)) {
		const spec = jsSpecifier(m);
		if (spec.startsWith(".")) edges.push(resolveJs(path.join(dir, spec)));
	}
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
	for (const line of codeLines(text, /^\s*#/))
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
	for (const line of codeLines(code, /^\s*#/))
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
	 * 3 is the bare `import` branch. The two throws check that invariant. */
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
	else if (!pythonStdlib().has(top))
		fault(`imports ${top}, which is neither stdlib nor shipped beside it`);
}

/**
 * Each root the manifest declares, by its absolute path in `out`, to its kind.
 * @param {string} manifest the manifest's path
 * @param {string} out the rendered tree
 * @returns {Map<string, string>}
 */
function surfaceRoots(manifest, out) {
	const { entryPoints, commands } = JSON.parse(
		fs.readFileSync(manifest, "utf8"),
	);
	const roots = new Map();
	for (const rel of Object.keys(entryPoints ?? {}))
		roots.set(path.join(out, rel), "entry point");
	for (const rel of Object.keys(commands ?? {}))
		roots.set(path.join(out, rel), "command");
	return roots;
}

/**
 * Faults in the rendered tree `out` against the helper surface `root`
 * declares; none where `root` declares no surface.
 * @param {string} root the source the tree was rendered from
 * @param {string} out the rendered tree
 * @returns {string[]}
 */
function surfaceClosureFaults(root, out) {
	const manifest = path.join(root, MANIFEST);
	if (!fs.existsSync(manifest)) return [];
	const roots = surfaceRoots(manifest, out);
	/** @type {string[]} */
	const faults = [];
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {[string, string | null][]} path, and the file that reached it */
	const queue = [...roots.keys()].map((abs) => [abs, null]);
	const relOf = (/** @type {string} */ abs) => path.relative(out, abs);
	while (queue.length > 0) {
		const [abs, from] = /** @type {[string, string | null]} */ (queue.shift());
		if (seen.has(abs)) continue;
		seen.add(abs);
		if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) {
			faults.push(
				from === null
					? `helper surface: ${roots.get(abs)} ${relOf(abs)} is missing from the render`
					: `helper surface: ${relOf(abs)}, reached from ${relOf(from)}, is missing from the render`,
			);
			continue;
		}
		const report = (/** @type {string} */ msg) =>
			faults.push(`helper surface: ${relOf(abs)} ${msg}`);
		try {
			for (const edge of edgesOf(abs, fs.readFileSync(abs, "utf8"), report))
				queue.push([edge, abs]);
		} catch (err) {
			report(`goes unjudged — ${caught(err).message}`);
		}
	}
	return faults;
}

module.exports = { JS_SPEC, jsSpecifier, surfaceClosureFaults };
