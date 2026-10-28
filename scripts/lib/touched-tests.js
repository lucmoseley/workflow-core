/*
 * touched-tests.js — the tests a session's own work touched (#2930), which a
 * bare `npm run test` runs under the `landing` module, the lander being the
 * only full gate (#2868). A bare `npm run test:py` takes the same set for
 * pytest's route (#2934).
 *
 * THE SET is the union of every changed path that is a test file and every
 * test that directly imports or reads a changed path. One hop only: a test
 * reaching a changed file through a helper it imports is not selected. Reads
 * come from the read-graph manifest, committed and as this tree renders it;
 * imports are read lexically off each test's own source, since the manifest
 * holds no import edge. The manifest scans no pytest file, so on pytest's
 * route a read is lexical too: the test names the path in string literals.
 *
 * EACH ROUTE KEEPS ONLY WHAT ITS RUNNER COLLECTS (#2952): a test file its
 * suite would never run is not run by name either. Vitest's is its own
 * `vitest list`, asked where a config can narrow its include or exclude.
 * Pytest's is read off its config, by `pytest-collection.js`.
 *
 * WHERE THE MANIFEST IS UNREADABLE OR WILL NOT RENDER, its readers give way
 * to each changed file's same-stem siblings: for `<dir>/<stem>.<ext>`, the
 * test files in `<dir>` named `<stem>.test.*` or `<stem>.*.test.*`, or
 * `test_<stem>.py` on pytest's route. The lexical edges, needing no
 * manifest, stay. It never widens.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
	PY_TEST_FILE,
	isJsTestFile,
	pytestSiblings,
} = require("./test-kind.js");
const { pytestCollected } = require("./pytest-collection.js");
const {
	directImports,
	testsReading,
	readWorkingTree,
} = require("./test-read-edges.js");
const {
	liveEdges,
	readChangedPaths,
	readCommittedEdges,
	readDefaultChangedBase,
} = require("./changed-selection.js");
const { readVitestCollected } = require("./vitest-collected.js");
const { readUntrackedFiles } = require("./dirty-tree.js");
const { readOwnWork } = require("./own-work.js");
const idSeam = require("./session-id.js");
const { EDGES_FILE, shortSha } = require("./test-pass-marker.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/** @typedef {import("./own-selection.js").OwnSet} OwnSet */

/**
 * `import a.b, c` and `from a.b import c, d` — `from .m import x` included —
 * at a line's start. A parenthesised name list continued past the line is
 * read for its module alone.
 */
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.][\w., \t]*)/gm;
const PY_FROM = /^[ \t]*from[ \t]+([\w.]*)[ \t]+import[ \t]+\(?([\w, \t]*)/gm;

/**
 * The modules `source` imports, as written: dotted, relative ones led by
 * their dots.
 *
 * @param {string} source
 * @returns {string[]}
 */
function pythonModules(source) {
	const first = (/** @type {string} */ part) =>
		part.trim().split(/[ \t]/)[0] ?? "";
	/** @type {string[]} */
	const modules = [];
	for (const [, list = ""] of source.matchAll(PY_IMPORT))
		modules.push(...list.split(",").map(first));
	for (const [, mod = "", names = ""] of source.matchAll(PY_FROM)) {
		modules.push(mod);
		/* `from pkg import mod` names a submodule as often as an attribute. */
		const sep = mod.endsWith(".") ? "" : ".";
		for (const name of names.split(",").map(first))
			if (name) modules.push(`${mod}${sep}${name}`);
	}
	return modules;
}

/**
 * The files `mod` can resolve to from a test in `dir`: against `dir` and
 * `scripts/`, the two roots run-pytest.js and the tests' own
 * `sys.path.insert(0, HERE)` put on the path, or against `dir`'s ancestor
 * where it is relative.
 *
 * @param {string} mod
 * @param {string} dir
 * @returns {string[]}
 */
function pythonCandidates(mod, dir) {
	const dots = /^\.*/.exec(mod)?.[0].length ?? 0;
	const rel = mod.slice(dots).split(".").filter(Boolean).join("/");
	if (!rel) return [];
	let up = dir;
	for (let i = 1; i < dots; i++) up = path.posix.dirname(up);
	const bases = dots > 0 ? [up] : [dir, "scripts"];
	return bases.flatMap((base) =>
		[`${rel}.py`, `${rel}/__init__.py`].map((file) =>
			path.posix.normalize(base === "." ? file : `${base}/${file}`),
		),
	);
}

/**
 * The tracked `.py` files `source` imports, one hop.
 *
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
const pythonImports = (source, self, tracked) =>
	new Set(
		pythonModules(source)
			.flatMap((mod) => pythonCandidates(mod, path.posix.dirname(self)))
			.filter((p) => tracked.has(p)),
	);

/** A one-line quoted string literal. */
const PY_LITERAL = /(["'])((?:(?!\1)[^\\\n])*)\1/g;

/**
 * The tracked files under the test's own directory that `source` names in
 * string literals, one literal per path segment or several in one:
 * `Path(__file__).parent / "m" / "scan.py"` and `"m/scan.py"` both name
 * `<dir>/m/scan.py`.
 *
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
function pythonReads(source, self, tracked) {
	const named = new Set();
	for (const [, , text = ""] of source.matchAll(PY_LITERAL))
		for (const seg of text.split("/")) if (seg) named.add(seg);
	const dir = path.posix.dirname(self);
	const prefix = dir === "." ? "" : `${dir}/`;
	return new Set(
		[...tracked].filter(
			(p) =>
				p !== self &&
				p.startsWith(prefix) &&
				p
					.slice(prefix.length)
					.split("/")
					.every((seg) => named.has(seg)),
		),
	);
}

/**
 * @type {Record<"vitest"|"pytest", { isTest: (p: string) => boolean,
 *   edges: (source: string, self: string, tracked: Set<string>) => Set<string>,
 *   isSibling: (name: string, stem: string) => boolean,
 *   collected: (root: string, files: string[], execFn: ExecFn) => string[] }>}
 */
const ROUTES = {
	vitest: {
		isTest: isJsTestFile,
		edges: directImports,
		isSibling: (name, stem) =>
			isJsTestFile(name) && name.startsWith(`${stem}.`),
		collected: readVitestCollected,
	},
	pytest: {
		isTest: (p) => PY_TEST_FILE.test(p),
		edges: (source, self, tracked) =>
			new Set([
				...pythonImports(source, self, tracked),
				...pythonReads(source, self, tracked),
			]),
		isSibling: (name, stem) => pytestSiblings(stem).includes(name),
		collected: pytestCollected,
	},
};

/**
 * @param {string} root
 * @param {string} p
 */
const isOnDisk = (root, p) => {
	try {
		return fs.statSync(path.join(root, p)).isFile();
	} catch {
		/* Deleted, or never there: nothing to run. */
		return false;
	}
};

/**
 * @param {string} root
 * @param {string[]} changed
 * @param {(name: string, stem: string) => boolean} isSibling
 * @returns {string[]}
 */
function readSiblingTests(root, changed, isSibling) {
	const out = new Set();
	for (const p of changed) {
		const dir = path.posix.dirname(p);
		const stem = path.posix.parse(p).name;
		/** @type {string[]} */
		let names;
		try {
			names = fs.readdirSync(path.join(root, dir));
		} catch {
			/* A deleted path's directory, gone with it: no sibling to select. */
			continue;
		}
		for (const name of names)
			if (isSibling(name, stem)) out.add(dir === "." ? name : `${dir}/${name}`);
	}
	return [...out];
}

/**
 * The touched tests of `changed` in the tree at `root`, and the fallback's
 * cause where the manifest could not be read.
 *
 * @param {string} root
 * @param {string[]} changed repo-relative, forward slashes
 * @param {{ suite?: "vitest"|"pytest", execFn?: ExecFn,
 *   loadEdges?: () => Record<string, string[]>,
 *   renderEdges?: () => Record<string, string[]> }} [options]
 * @returns {{ files: string[], uncollected: string[], fallback: unknown }}
 *   `uncollected` the touched tests the runner does not collect; `fallback`
 *   null where the manifest selected
 * @throws where the runner's collection cannot be read: a selection it
 *   cannot check is never run, the fallback's included
 */
function resolveTouched(
	root,
	changed,
	{
		suite = "vitest",
		execFn = execFileSync,
		loadEdges = () => readCommittedEdges(root),
		renderEdges = () => liveEdges(root),
	} = {},
) {
	const { isTest, edges, isSibling, collected } = ROUTES[suite];
	/** @param {string[][]} lists */
	const select = (...lists) => {
		const touched = sortedUnion(...lists);
		const files = collected(root, touched, execFn);
		const kept = new Set(files);
		return { files, uncollected: touched.filter((f) => !kept.has(f)) };
	};
	const edited = changed.filter((p) => isTest(p) && isOnDisk(root, p));
	const tree = readWorkingTree(root);
	/* A deleted path stays resolvable, so its importers are selected. */
	const tracked = new Set([...tree.tracked, ...changed]);
	const wanted = new Set(changed);
	const lexical = [...tree.tracked].filter((t) => {
		if (!isTest(t)) return false;
		for (const p of edges(tree.read(t), t, tracked))
			if (wanted.has(p)) return true;
		return false;
	});
	/** @type {Record<string, string[]>} */
	let graph;
	try {
		graph = { ...loadEdges() };
		for (const [p, readers] of Object.entries(renderEdges()))
			graph[p] = [...new Set([...(graph[p] ?? []), ...readers])];
	} catch (error) {
		const siblings = readSiblingTests(root, changed, isSibling);
		try {
			return { ...select(edited, lexical, siblings), fallback: error };
		} catch (failed) {
			throw new Error(
				`${failed instanceof Error ? failed.message : String(failed)} (after the read graph failed: ${String(error).trim()})`,
				{ cause: failed },
			);
		}
	}
	const readers = testsReading(changed, graph).filter(
		(t) => isTest(t) && isOnDisk(root, t),
	);
	return { ...select(edited, lexical, readers), fallback: null };
}

/**
 * The session's own changed paths in the tree at `at` since the default's
 * base, untracked files included. `ownWork` stands in for the own-work read
 * where the caller already holds it; null reads the plain diff. One that
 * `carriesUntracked` is the whole set, so the tree's untracked files, a
 * neighbour's among them, are not added (#2958).
 *
 * @param {string} at
 * @param {{ sessionId?: string|null, execFn?: ExecFn,
 *   ledger?: import("./own-work.js").CommitLedger,
 *   ownWork?: OwnSet|null }} options
 * @returns {{ base: string, changed: string[] }}
 */
function readTouchedPaths(at, { execFn = execFileSync, ...options }) {
	const base = readDefaultChangedBase(at, execFn);
	const own =
		options.ownWork === undefined
			? readOwnWork(at, base, { ...options, execFn })
			: options.ownWork;
	const changed = [
		...new Set([
			...(own?.paths ?? readChangedPaths(at, base, execFn)),
			...(options.ownWork?.carriesUntracked
				? []
				: (readUntrackedFiles(at, execFn) ?? [])),
		]),
	].sort();
	return { base, changed };
}

/**
 * A touched run's selection in the tree at `at`: the session's changed
 * paths, the tests they touch on `suite`'s route, and the banner the run
 * prints.
 *
 * @param {string} at
 * @param {Parameters<typeof readTouchedPaths>[1] &
 *   Parameters<typeof resolveTouched>[2]} [options]
 */
function selectTouched(at, { suite, loadEdges, renderEdges, ...options } = {}) {
	const { base, changed } = readTouchedPaths(at, {
		...options,
		/* `||`, not `??`: the suite stubs the id to "", which is no session. */
		sessionId: options.sessionId || idSeam.fromEnv(),
	});
	const { files, uncollected, fallback } = resolveTouched(at, changed, {
		...(options.execFn ? { execFn: options.execFn } : {}),
		...(suite ? { suite } : {}),
		...(loadEdges ? { loadEdges } : {}),
		...(renderEdges ? { renderEdges } : {}),
	});
	return {
		base,
		changed,
		files,
		banner: touchedBanner(files, uncollected, base, fallback),
	};
}

/**
 * @param {string[]} files
 * @param {string[]} uncollected
 * @param {string} base
 * @param {unknown} fallback the manifest's failure, where it could not select
 */
function touchedBanner(files, uncollected, base, fallback) {
	const lines = [];
	if (fallback !== null)
		lines.push(
			`TOUCHED TESTS FELL BACK TO SAME-STEM SIBLINGS — ${EDGES_FILE} is unreadable or the read graph would not render (${String(fallback).trim()}), so the edited tests, the tests read lexically to reach a changed file and each changed file's same-stem sibling tests are selected (#2930, #2934).`,
		);
	if (uncollected.length > 0)
		lines.push(
			`NOT COLLECTED — ${uncollected.length} touched test file(s) the runner's own config does not collect, so they are not run by name either (#2952):`,
			...uncollected.map((f) => `  ${f}`),
		);
	if (files.length === 0 && uncollected.length > 0)
		lines.push(
			`NO TOUCHED TESTS — every test file your own work touched since ${shortSha(base)} is one the runner does not collect, so nothing ran. The lander runs the full suite (#2952).`,
		);
	else if (files.length === 0)
		lines.push(
			`NO TOUCHED TESTS — no test file is edited, imports or reads a file your own work changed since ${shortSha(base)}, so nothing ran. The lander runs the full suite (#2930).`,
		);
	else
		lines.push(
			`TOUCHED TESTS ONLY — ${files.length} test file(s) your own work since ${shortSha(base)} edited, or that directly import or read a file it changed. The lander runs the full suite (#2930).`,
			...files.map((f) => `  ${f}`),
		);
	return `${lines.join("\n")}\n`;
}

/** @param {string[][]} lists */
const sortedUnion = (...lists) => [...new Set(lists.flat())].sort();

module.exports = { selectTouched };
