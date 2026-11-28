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
const { gitRead, readUntrackedFiles } = require("./dirty-tree.js");
const { readOwnWork } = require("./own-work.js");
const { readMergeParents } = require("./merge-heads.js");
const { caught } = require("./caught.js");
const { byCodeUnit } = require("./by-code-unit.js");
const { readGateSeats } = require("./suite-queue.js");
const idSeam = require("./session-id.js");
const { EDGES_FILE, shortSha } = require("./test-pass-marker.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/** @typedef {import("./own-selection.js").OwnSet} OwnSet */
/** @typedef {import("./test-pass-marker.js").TouchedBase} TouchedBase */

// #4967
/** @type {{ file: string, checkers: (string|RegExp)[] }[]} */
const CHECKER_ONLY = [
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

/** @param {string} p @param {Set<string>} tracked @returns {string[]|null} */
function checkerTests(p, tracked) {
	const row = CHECKER_ONLY.find(({ file }) => file === p);
	if (!row) return null;
	const tests = row.checkers.flatMap((c) => checkerMatches(c, tracked));
	return tests.length > 0 ? tests : null;
}

const PY_IMPORT = /^[ \t]*import[ \t]+([\w.][\w., \t]*)/gm;
const PY_FROM =
	/^[ \t]*from(?:[ \t]+([\w.]+)|[ \t])[ \t]+import[ \t]+(?:\(|(?![ \t]))([\w, \t]*)/gm;

/** @param {string} source @returns {string[]} */
function pythonModules(source) {
	const first = (/** @type {string} */ part) =>
		part.trim().split(/[ \t]/)[0] ?? "";
	/** @type {string[]} */
	const modules = [];
	for (const [, list = ""] of source.matchAll(PY_IMPORT))
		modules.push(...list.split(",").map(first));
	for (const [, mod = "", names = ""] of source.matchAll(PY_FROM)) {
		modules.push(mod);
		const sep = mod.endsWith(".") ? "" : ".";
		for (const name of names.split(",").map(first))
			if (name) modules.push(`${mod}${sep}${name}`);
	}
	return modules;
}

/** @param {string} mod @param {string} dir @returns {string[]} */
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

const PY_LITERAL = /(["'])((?:(?!\1)[^\\\n])*)\1/g;

/**
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
		return false;
	}
};

/**
 * @param {string} root
 * @param {string[]} changed
 * @param {(name: string, stem: string) => boolean} isSibling
 * @returns {Map<string, string[]>}
 */
function readSiblingTests(root, changed, isSibling) {
	/** @type {Map<string, string[]>} */
	const out = new Map();
	for (const p of changed) {
		const dir = path.posix.dirname(p);
		const stem = path.posix.parse(p).name;
		/** @type {string[]} */
		let names;
		try {
			names = fs.readdirSync(path.join(root, dir));
		} catch {
			continue;
		}
		out.set(
			p,
			names
				.filter((name) => isSibling(name, stem))
				.map((name) => (dir === "." ? name : `${dir}/${name}`)),
		);
	}
	return out;
}

// guess, #5878
const TOUCHED_BOUND = 120;

/** @typedef {{ from: number, out: string[], own: number }} Bounded */

/**
 * @param {string[]} files
 * @param {{ own: Set<string>, selecting: Map<string, string[]>,
 *  siblings: Set<string> }} near
 * @returns {{ files: string[], bounded: Bounded|null }}
 */
function boundNearest(files, { own, selecting, siblings }) {
	if (files.length <= TOUCHED_BOUND) return { files, bounded: null };
	const inRun = new Set(files);
	/** @type {Map<string, number>} */
	const fewestReaders = new Map();
	/** @type {Map<string, number>} */
	const selectingPaths = new Map();
	for (const tests of selecting.values()) {
		const readers = [...new Set(tests)].filter((t) => inRun.has(t));
		for (const t of readers) {
			fewestReaders.set(
				t,
				Math.min(fewestReaders.get(t) ?? readers.length, readers.length),
			);
			selectingPaths.set(t, (selectingPaths.get(t) ?? 0) + 1);
		}
	}
	const kept = files.filter((f) => own.has(f));
	const ranked = files
		.filter((f) => !own.has(f))
		.sort(
			(a, b) =>
				Number(siblings.has(b)) - Number(siblings.has(a)) ||
				(fewestReaders.get(a) ?? inRun.size) -
					(fewestReaders.get(b) ?? inRun.size) ||
				(selectingPaths.get(b) ?? 0) - (selectingPaths.get(a) ?? 0) ||
				byCodeUnit(a, b),
		);
	const room = Math.max(0, TOUCHED_BOUND - kept.length);
	const out = ranked.slice(room);
	if (out.length === 0) return { files, bounded: null };
	const left = new Set(out);
	return {
		files: files.filter((f) => !left.has(f)),
		bounded: { from: files.length, out: out.sort(), own: kept.length },
	};
}

/**
 * @param {ReturnType<typeof readWorkingTree>} tree
 * @param {string[]} changed
 * @param {Pick<typeof ROUTES["vitest"], "isTest"|"edges">} route
 * @returns {Map<string, string[]>}
 */
function lexicalTests(tree, changed, { isTest, edges }) {
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
 * @param {string} root
 * @param {string[]} changed
 * @param {{ suite?: "vitest"|"pytest", execFn?: ExecFn,
 *  loadEdges?: () => Record<string, string[]>,
 *  renderEdges?: () => Record<string, string[]> }} [options]
 * @returns {{ files: string[], uncollected: string[], leftOut: string[],
 *  cut: string[], leftBy: string[], bounded: Bounded|null,
 *  fallback: unknown }}
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
	 * @param {string[]} owed
	 * @param {Map<string, string[]>} readersOf
	 * @param {[string, string[]][]} [cuts]
	 */
	const settle = (owed, readersOf, cuts = []) => {
		const collectedSet = new Set(
			collected(root, sortedUnion(owed, ...cuts.map(([, t]) => t)), execFn),
		);
		const left = cuts
			.map(([p, tests]) => ({
				p,
				tests: tests.filter((t) => collectedSet.has(t)),
			}))
			.filter(({ tests }) => tests.length > 0);
		const cut = sortedUnion(...left.map(({ tests }) => tests));
		const { files, bounded } = boundNearest(
			owed.filter((f) => collectedSet.has(f)),
			{
				own: new Set(edited),
				selecting: readersOf,
				siblings: new Set([...siblings.values()].flat()),
			},
		);
		return {
			files,
			uncollected: owed.filter((f) => !collectedSet.has(f)),
			leftOut: sortedUnion(cut, bounded?.out ?? []),
			cut,
			leftBy: left.map(({ p }) => p),
			bounded,
		};
	};
	const edited = changed.filter((p) => isTest(p) && isOnDisk(root, p));
	const tree = readWorkingTree(root);
	const lexical = lexicalTests(tree, changed, ROUTES[suite]);
	const siblings = readSiblingTests(root, changed, isSibling);
	/** @type {Record<string, string[]>} */
	let graph;
	try {
		graph = { ...loadEdges() };
		for (const [p, readers] of Object.entries(renderEdges()))
			graph[p] = [...new Set([...(graph[p] ?? []), ...readers])];
	} catch (error) {
		const selecting = new Map(
			changed.map((p) => [
				p,
				[...(lexical.get(p) ?? []), ...(siblings.get(p) ?? [])],
			]),
		);
		try {
			return {
				...settle(sortedUnion(edited, ...selecting.values()), selecting),
				fallback: error,
			};
		} catch (failed) {
			throw new Error(
				`${failed instanceof Error ? failed.message : String(failed)} (after the read graph failed: ${String(error).trim()})`,
				{ cause: failed },
			);
		}
	}
	/** @param {string} p */
	const reach = (p) => [
		...(lexical.get(p) ?? []),
		...testsReading([p], graph).filter((t) => isTest(t) && isOnDisk(root, t)),
	];
	/** @type {Map<string, string[]>} */
	const checkers = new Map();
	for (const p of changed) {
		const tests = checkerTests(p, tree.tracked);
		if (tests) checkers.set(p, tests.filter(isTest));
	}
	const selecting = new Map(
		changed.map((p) => [p, checkers.get(p) ?? reach(p)]),
	);
	const touched = sortedUnion(edited, ...selecting.values());
	const selected = new Set(touched);
	return {
		...settle(
			touched,
			selecting,
			[...checkers.keys()].map((p) => [
				p,
				reach(p).filter((t) => !selected.has(t)),
			]),
		),
		fallback: null,
	};
}

/** @returns {TouchedBase} */
const readTouchedBase = () =>
	readGateSeats().under(process.pid) ? "head" : "merge-base";

/**
 * @param {string} at
 * @param {{ from: TouchedBase, sessionId?: string|null, execFn?: ExecFn,
 *  ledger?: import("./own-work.js").CommitLedger,
 *  ownWork?: OwnSet|null, env?: NodeJS.ProcessEnv }} options
 * @returns {{ base: string, changed: string[], merge: MergeState }}
 */
function readTouchedPaths(
	at,
	{ from, execFn = execFileSync, env, ...options },
) {
	if (from === "head") {
		const head = gitRead(["rev-parse", "HEAD"], at, execFn)?.trim();
		if (!head) throw new Error("git would not name HEAD");
		const changed = readChanged(at, head, null, execFn);
		return { base: head, ...readMergeOwnContent(at, changed, env, execFn) };
	}
	const base = readDefaultChangedBase(at, execFn);
	const own =
		options.ownWork === undefined
			? readOwnWork(at, base, { ...options, execFn })
			: options.ownWork;
	return {
		base,
		changed: readChanged(at, base, own, execFn),
		merge: { parents: [] },
	};
}

/** @typedef {{ parents: string[] }|{ unread: string }} MergeState */

/**
 * @param {string} at
 * @param {string[]} changed
 * @param {NodeJS.ProcessEnv|undefined} env
 * @param {ExecFn} execFn
 * @returns {{ changed: string[], merge: MergeState }}
 */
function readMergeOwnContent(at, changed, env, execFn) {
	let parents;
	let ownContent;
	try {
		parents = readMergeParents(at, env);
		if (parents.length === 0) return { changed, merge: { parents } };
		ownContent = parents.map((p) => new Set(readChangedPaths(at, p, execFn)));
	} catch (error) {
		return { changed, merge: { unread: caught(error).message.trim() } };
	}
	const untracked = new Set(readUntrackedFiles(at, execFn) ?? []);
	return {
		changed: changed.filter(
			(p) => untracked.has(p) || ownContent.every((s) => s.has(p)),
		),
		merge: { parents },
	};
}

/**
 * @param {string} at
 * @param {string} base
 * @param {OwnSet|null|undefined} own
 * @param {ExecFn} execFn
 */
function readChanged(at, base, own, execFn) {
	return [
		...new Set([
			...(own?.paths ?? readChangedPaths(at, base, execFn)),
			...(own?.carriesUntracked ? [] : (readUntrackedFiles(at, execFn) ?? [])),
		]),
	].sort();
}
/**
 * @param {string} at
 * @param {Partial<Parameters<typeof readTouchedPaths>[1]> &
 *  Parameters<typeof resolveTouched>[2]} [options]
 */
function selectTouched(
	at,
	{ suite, loadEdges, renderEdges, from = "merge-base", ...options } = {},
) {
	const { base, changed, merge } = readTouchedPaths(at, {
		...options,
		from,
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
		boundedFrom: resolved.bounded?.from ?? null,
		banner: touchedBanner(resolved, scopeWording(base, from, merge, suite)),
	};
}

/**
 * @param {string} base
 * @param {TouchedBase} from
 * @param {MergeState} merge
 * @param {"vitest"|"pytest"} [suite]
 * @returns {{ ownWork: string, uncollectedWork: string, selected: string,
 *  coda: string|null }}
 */
function scopeWording(base, from, merge, suite = "vitest") {
	const at = shortSha(base);
	/** @param {string} work @param {string} pronoun @param {string} after */
	const selected = (work, pronoun, after) =>
		`${work} edited, or that directly import or read a file ${pronoun} changed.${after}`;
	if ("parents" in merge && merge.parents.length > 0) {
		const ownWork = `this merge's own content over HEAD ${at} and the merged-in ${merge.parents.map(shortSha).join(", ")}`;
		const nets =
			suite === "pytest"
				? "the bare `npm run test:py` before landing and the lander's full suite"
				: "the bare `npm run test` before landing, the push-coverage warning and the lander's full suite";
		return {
			ownWork,
			uncollectedWork: `${ownWork} touched`,
			selected: selected(ownWork, "it", ""),
			coda: `A path taken whole from one side of this merge was gated on that side. Tests reading one side's change through the other's are left to ${nets} (#2930, #5334).`,
		};
	}
	if (from === "head") {
		const ownWork = `this commit's changes over HEAD ${at}`;
		return {
			ownWork,
			uncollectedWork: `${ownWork} touched`,
			selected: selected(
				ownWork,
				"they",
				" The branch's earlier commits answered for themselves at their own commits, and the lander runs the full suite (#2930, #5320).",
			),
			coda:
				"unread" in merge
					? `MERGE PARENTS UNREAD — ${merge.unread}, so every change over HEAD is selected, a merge's incoming paths included (#5334).`
					: null,
		};
	}
	const ownWork = `your own work since ${at}`;
	return {
		ownWork,
		uncollectedWork: `your own work touched since ${at}`,
		selected: selected(
			ownWork,
			"it",
			" The lander runs the full suite (#2930).",
		),
		coda: null,
	};
}

/**
 * @param {ReturnType<typeof resolveTouched>} resolved
 * @param {ReturnType<typeof scopeWording>} wording
 */
function touchedBanner(
	{ files, uncollected, cut, leftBy, bounded, fallback },
	{ ownWork, uncollectedWork, selected, coda },
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
	if (cut.length > 0)
		lines.push(
			`LEFT TO THE LANDER — ${cut.length} test file(s) that only ${leftBy.join(", ")} would select. A file regenerated as a side effect of ordinary work selects its checker tests alone; the lander's full suite runs these (#4967).`,
		);
	if (bounded)
		lines.push(
			bounded.own > TOUCHED_BOUND
				? `LEFT TO THE LANDER — this work selects ${bounded.from} test files, over the touched run's bound of ${TOUCHED_BOUND}, and ${bounded.own} of them are tests it edited, so all ${bounded.own} of those run and the lander's full suite runs the other ${bounded.out.length} (#5878):`
				: `LEFT TO THE LANDER — this work selects ${bounded.from} test files, over the touched run's bound of ${TOUCHED_BOUND}; the ${files.length} nearest the change run, and the lander's full suite runs the other ${bounded.out.length} (#5878):`,
			...bounded.out.map((f) => `  ${f}`),
		);
	if (files.length === 0 && uncollected.length > 0)
		lines.push(
			`NO TOUCHED TESTS — every test file ${uncollectedWork} is one the runner does not collect, so nothing ran. The lander runs the full suite (#2952).`,
		);
	else if (files.length === 0 && cut.length > 0)
		lines.push(
			`NO TOUCHED TESTS — every test file ${ownWork} touched is left to the lander above, so nothing ran (#4967).`,
		);
	else if (files.length === 0)
		lines.push(
			`NO TOUCHED TESTS — no test file is edited, imports or reads a file ${ownWork} changed, so nothing ran. The lander runs the full suite (#2930).`,
		);
	else
		lines.push(
			`TOUCHED TESTS ONLY — ${files.length} test file(s) ${selected}`,
			...files.map((f) => `  ${f}`),
		);
	if (coda) lines.push(coda);
	return `${lines.join("\n")}\n`;
}

/** @param {string[][]} lists */
const sortedUnion = (...lists) => [...new Set(lists.flat())].sort();

module.exports = { readTouchedBase, selectTouched };
