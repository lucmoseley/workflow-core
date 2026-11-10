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
 * THE ONE EXCEPTION (#4967): a changed path that is a row of `NARROWED`, a
 * file a tool rewrites as a side effect of ordinary work, selects its
 * checker tests alone, the tests that check it against the tool writing it,
 * and these whether or not an edge reaches them. Its other readers are left
 * to the lander and returned as `leftOut`. Every other changed path, and
 * every edited test, selects as above, so a test is left out only where each
 * edge that would select it comes from a narrowed file. A row is added only
 * with a measured miss rate for that file: the share of red touched runs in
 * which the tests it would leave out caught a fault the session's own change
 * caused.
 *
 * EACH ROUTE KEEPS ONLY WHAT ITS RUNNER COLLECTS (#2952): a test file its
 * suite would never run is not run by name either. Vitest's is its own
 * `vitest list`, asked where a config can narrow its include or exclude.
 * Pytest's is read off its config, by `pytest-collection.js`.
 *
 * WHERE THE MANIFEST IS UNREADABLE OR WILL NOT RENDER, its readers give way
 * to each changed file's same-stem siblings: for `<dir>/<stem>.<ext>`, the
 * test files in `<dir>` that `JS_TEST_FILE` takes and that open `<stem>.`
 * (`<stem>.test.*`, `<stem>.spec.*`, `<stem>.<infix>.test.*`), or
 * `test_<stem>.py` and `<stem>_test.py` on pytest's route. The lexical edges, needing no
 * manifest, stay. It never widens, and nothing is narrowed there.
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
 * The narrowed files, each with its checker tests: a path, or a pattern
 * over one family of them. A ROW IS ADDED ONLY WITH A MEASURED MISS RATE FOR
 * THAT FILE (#4967): no file selects fewer tests than its readers on a
 * guess. `touched-tests.live.test.ts` holds each row against this tree,
 * failing where its file or a checker test is gone; a new row adds its case
 * there.
 *
 * @type {{ file: string, checkers: (string|RegExp)[] }[]}
 */
const NARROWED = [
	{
		file: ".claude/guard-registry-anchors.json",
		checkers: [
			/^scripts\/check-guard-registry(?:-[\w-]+)?\.test\.ts$/,
			"scripts/lib/registry-anchors-merge.test.ts",
		],
	},
	{
		file: EDGES_FILE,
		checkers: ["scripts/lib/generated-rule-copies.test.ts"],
	},
	{
		file: "scripts/instruction-surface-anchors.json",
		checkers: [
			"scripts/check-instruction-surface.test.ts",
			"scripts/lib/generated-rule-copies.test.ts",
		],
	},
];

/**
 * @param {string|RegExp} checker
 * @param {Iterable<string>} tracked
 * @returns {string[]}
 */
const checkerMatches = (checker, tracked) =>
	[...tracked].filter((t) =>
		typeof checker === "string" ? t === checker : checker.test(t),
	);

/**
 * The checker tests `tracked` holds for `p`, or null where `p` is no
 * narrowed file here: a tree holding none of a row's checker tests, an
 * adopting repo's, selects that path's readers as any other's.
 *
 * @param {string} p
 * @param {Set<string>} tracked
 * @returns {string[]|null}
 */
function checkerTests(p, tracked) {
	const row = NARROWED.find(({ file }) => file === p);
	if (!row) return null;
	const tests = row.checkers.flatMap((c) => checkerMatches(c, tracked));
	return tests.length > 0 ? tests : null;
}

/**
 * `import a.b, c` and `from a.b import c, d` — `from .m import x` included —
 * at a line's start. A parenthesised name list continued past the line is
 * read for its module alone. An absent module is exactly one blank before
 * the blanks ahead of `import`, so the two runs never split one run of
 * blanks every way (#3383); group 1 is then
 * undefined, which pythonModules reads as "".
 */
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.][\w., \t]*)/gm;
const PY_FROM =
	/^[ \t]*from(?:[ \t]+([\w.]+)|[ \t])[ \t]+import[ \t]+(?:\(|(?![ \t]))([\w, \t]*)/gm;

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
 * Each changed path's lexical tests: those whose own source imports it or,
 * on pytest's route, names it.
 *
 * @param {ReturnType<typeof readWorkingTree>} tree
 * @param {string[]} changed
 * @param {Pick<typeof ROUTES["vitest"], "isTest"|"edges">} route
 * @returns {Map<string, string[]>}
 */
function lexicalTests(tree, changed, { isTest, edges }) {
	/* A deleted path stays resolvable, so its importers are selected. */
	const tracked = new Set([...tree.tracked, ...changed]);
	/** @type {Map<string, string[]>} */
	const lexical = new Map(changed.map((p) => [p, []]));
	for (const t of tree.tracked) {
		if (!isTest(t)) continue;
		for (const p of edges(tree.read(t), t, tracked)) lexical.get(p)?.push(t);
	}
	return lexical;
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
 * @returns {{ files: string[], uncollected: string[], leftOut: string[],
 *   narrowedBy: string[], fallback: unknown }}
 *   `uncollected` the touched tests the runner does not collect; `leftOut`
 *   the collected tests only narrowed files would select, and `narrowedBy`
 *   those files; `fallback` null where the manifest selected
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
	const { isTest, isSibling, collected } = ROUTES[suite];
	/**
	 * @param {string[]} owed the tests selected
	 * @param {[string, string[]][]} [cuts] each narrowed file's other readers
	 */
	const settle = (owed, cuts = []) => {
		const running = new Set(
			collected(root, sortedUnion(owed, ...cuts.map(([, t]) => t)), execFn),
		);
		const left = cuts
			.map(([p, tests]) => ({ p, tests: tests.filter((t) => running.has(t)) }))
			.filter(({ tests }) => tests.length > 0);
		return {
			files: owed.filter((f) => running.has(f)),
			uncollected: owed.filter((f) => !running.has(f)),
			leftOut: sortedUnion(...left.map(({ tests }) => tests)),
			narrowedBy: left.map(({ p }) => p),
		};
	};
	const edited = changed.filter((p) => isTest(p) && isOnDisk(root, p));
	const tree = readWorkingTree(root);
	const lexical = lexicalTests(tree, changed, ROUTES[suite]);
	/** @type {Record<string, string[]>} */
	let graph;
	try {
		graph = { ...loadEdges() };
		for (const [p, readers] of Object.entries(renderEdges()))
			graph[p] = [...new Set([...(graph[p] ?? []), ...readers])];
	} catch (error) {
		const siblings = readSiblingTests(root, changed, isSibling);
		try {
			return {
				...settle(sortedUnion(edited, ...lexical.values(), siblings)),
				fallback: error,
			};
		} catch (failed) {
			throw new Error(
				`${failed instanceof Error ? failed.message : String(failed)} (after the read graph failed: ${String(error).trim()})`,
				{ cause: failed },
			);
		}
	}
	/** @param {string} p the tests an edge from `p` selects */
	const reach = (p) => [
		...(lexical.get(p) ?? []),
		...testsReading([p], graph).filter((t) => isTest(t) && isOnDisk(root, t)),
	];
	/** @type {Map<string, string[]>} each narrowed changed path's checker tests */
	const kept = new Map();
	for (const p of changed) {
		const tests = checkerTests(p, tree.tracked);
		if (tests) kept.set(p, tests.filter(isTest));
	}
	const touched = sortedUnion(
		edited,
		...changed.map((p) => kept.get(p) ?? reach(p)),
	);
	const selected = new Set(touched);
	return {
		...settle(
			touched,
			[...kept.keys()].map((p) => [
				p,
				reach(p).filter((t) => !selected.has(t)),
			]),
		),
		fallback: null,
	};
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
	const resolved = resolveTouched(at, changed, {
		...(options.execFn ? { execFn: options.execFn } : {}),
		...(suite ? { suite } : {}),
		...(loadEdges ? { loadEdges } : {}),
		...(renderEdges ? { renderEdges } : {}),
	});
	return {
		base,
		changed,
		files: resolved.files,
		leftOut: resolved.leftOut,
		banner: touchedBanner(resolved, base),
	};
}

/**
 * @param {ReturnType<typeof resolveTouched>} resolved
 * @param {string} base
 */
function touchedBanner(
	{ files, uncollected, leftOut, narrowedBy, fallback },
	base,
) {
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
	if (leftOut.length > 0)
		lines.push(
			`LEFT TO THE LANDER — ${leftOut.length} test file(s) that only ${narrowedBy.join(", ")} would select. A file regenerated as a side effect of ordinary work selects its checker tests alone; the lander's full suite runs these (#4967).`,
		);
	if (files.length === 0 && uncollected.length > 0)
		lines.push(
			`NO TOUCHED TESTS — every test file your own work touched since ${shortSha(base)} is one the runner does not collect, so nothing ran. The lander runs the full suite (#2952).`,
		);
	else if (files.length === 0 && leftOut.length > 0)
		lines.push(
			`NO TOUCHED TESTS — every test file your own work since ${shortSha(base)} touched is left to the lander above, so nothing ran (#4967).`,
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
