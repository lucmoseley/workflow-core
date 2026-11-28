const fs = require("node:fs");
const { parseJsonl, readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { ignoreFailure, orFallback } = require("./caught.js");
const {
	execProgram,
	gitBinary,
	gitSpawnOptions,
	gitCommonDir,
	WIDE_SHA,
} = require("./git.js");
const { delta: cpuDelta } = require("./cpu-sample.js");
const idSeam = require("./session-id.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { shellQuote } = require("./sh-quote.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { appendLedgerLine } = require("./run-ledger.js");
const { readTreeIds, isSameContent } = require("./content-ids.js");

/**
 * @typedef {{modulesRun: number, modulesTotal: number, tests: number,
 *   skipped: number, nameFilter?: string|null,
 *   fileFilters?: string[], changed?: string|boolean|null, admissible?: boolean,
 *   viaChanged?: boolean, touched?: boolean, resolvedFiles?: number,
 *   leftOut?: string[], boundedFrom?: number, touchedBase?: TouchedBase,
 *   wholeSlot?: boolean, full?: "flag"|"stale-manifest"|"dependency-root",
 *   fullCause?: "push-gate"|"coverage"|"empty-diff"|"sha-moved"|"rule-edit"|"other"|null,
 *   shard?: {index: number, count: number},
 *   failures?: {file: string, tests: string[]}[], errors?: number}} Scope
 * @typedef {{sha: string, at?: string, suite?: string, scope?: Scope,
 *   startStateUnknown?: boolean, dirtyAtStart?: boolean, dirtyCount?: number,
 *   headMovedDuringRun?: boolean, startedAt?: string, durationMs?: number,
 *   machine?: {ceilingPct: number, busyPct: number, systemPct: number,
 *     nicePct: number, userPct: number, iowaitPct: number, load1: number|null,
 *     load1AtStart?: number|null},
 *   foreign?: {path: string, why: string}[], isolated?: boolean,
 *   treeAtEnd?: string, sessionId?: string|null, lander?: boolean, argv?: string[],
 *   closure?: "*"|string[], selected?: string[], changedPaths?: string[],
 *   imports?: Record<string, string[]>, roots?: string[],
 *   cached?: CachedSource[],
 *   base?: string, refused?: boolean, refusedWhy?: string, refusedWord?: string,
 *   stalled?: boolean, stallMs?: number,
 *   ceilingKill?: boolean, ceilingMs?: number, neverStarted?: string[]|null,
 *   touchedBase?: TouchedBase,
 *   inflight?: {module: string, stage: string}[], finished?: string[],
 *   testsInFlight?: {nodeid: string, stage: string}[]|null,
 *   testsNeverStarted?: number|null, testsFinished?: number|null,
 *   slowest?: import("./test-file-timings.js").SlowFile[],
 *   memory?: import("./run-memory.js").RunMemory|null,
 *   admission?: import("./part-suite-peak.js").PartAdmission}} Marker
 * @typedef {Omit<Marker, "scope"> & {scope?: Partial<Scope>}} RunRow
 * @typedef {RunRow & {sha: string, at: string, suite: string,
 *   startedAt: string, durationMs: number, argv: string[]}} KillRow
 * @typedef {{closure: "*"|string[], selected?: string[],
 *   changedPaths?: string[]|null, base?: string|null,
 *   imports?: Record<string, string[]>, roots?: string[],
 *   cached?: CachedSource[]}} Attestation
 * @typedef {{file: string, sha: string, at: string}} CachedSource
 * @typedef {{root?: string|null, execFn?: typeof execProgram,
 *   cache?: Map<string, string>}} GitOptions
 * @typedef {GitOptions & {countedPaths?: Set<string>|null}} JudgeOptions
 * @typedef {{git: (args: string[]) => string, countedPaths: Set<string>|null}} DiffReader
 */

const STORE = ".test-pass-markers.jsonl";

const EDGES_FILE = "docs/test-read-edges.json";

const IMPORTABLE = /\.(?:[cm]?[jt]sx?|json)$/;

const RETEST_FLAG = "--retest";

const FULL_REASONS = ["flag", "stale-manifest", "dependency-root"];

const TOUCHED_BASES = /** @type {const} */ (["merge-base", "head"]);
/** @typedef {(typeof TOUCHED_BASES)[number]} TouchedBase */

const CLOSURE_ROOTS = ["package.json"];

const FULL_CAUSES = [
	"push-gate",
	"coverage",
	"empty-diff",
	"sha-moved",
	"rule-edit",
	"other",
];

const FAIL_STORE = ".test-fail-markers.jsonl";

const EVIDENCE_NOT_LICENCE = "evidence, not a licence";
const FLAKE_NOTE =
	"a red's failing set repeats only about half the time between runs (mantahostels#2195)";

// lucmoseley/mantahostels#1256 guess one suite's 400/200 doubled for the two suites writing here
const PRUNE_AT = 800;
const KEEP = 400;

// #1231 guess holds a 3-day reading such as #816's
const ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;

const SUITES = [
	{
		id: "vitest",
		name: "VITEST",
		gate: "npm run test",
	},
	{
		id: "pytest",
		name: "PYTEST",
		gate: "npm run test:py",
		touches:
			/\.py$|^(pytest\.ini|requirements-dev\.txt|scripts\/run-pytest\.js)$/,
	},
];

const DEFAULT_SUITE = "vitest";

/** @param {RunRow} m */
const suiteOf = (m) => m.suite || DEFAULT_SUITE;

/**
 * @param {string[]} changed
 * @returns {string[]}
 */
function suitesFor(changed) {
	return SUITES.filter(
		(s) => !s.touches || changed.some((f) => s.touches.test(f)),
	).map((s) => s.id);
}

/** @param {string} id */
const suiteMeta = (id) =>
	SUITES.find((s) => s.id === id) || {
		id,
		name: String(id).toUpperCase(),
		gate: `the ${id} suite`,
	};

/**
 * @param {string} [cwd]
 * @returns {string|null}
 */
function repoRoot(cwd = process.cwd()) {
	const common = gitCommonDir(cwd);
	return common === null ? null : path.dirname(common);
}

/** @param {string} root @param {string} [store] */
const storePath = (root, store = STORE) => path.join(markersDir(root), store);

/** @param {string} root @param {string} [store] */
const archivePath = (root, store = STORE) =>
	`${storePath(root, store).replace(/\.jsonl$/, "")}.archive.jsonl`;

/**
 * @param {string} root
 * @param {string} store
 * @param {string[]} dropped
 */
function archive(root, store, dropped) {
	const file = archivePath(root, store);
	const kept = readJsonl(file)?.rows ?? [];
	const cutoff = Date.now() - ARCHIVE_MS;
	const lines = [
		...new Set(
			[...kept, ...parseJsonl(dropped.join("\n")).rows]
				.filter((row) => Date.parse(String(row.at)) >= cutoff)
				.map((row) => JSON.stringify(row)),
		),
	];
	fs.writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/**
 * @param {Marker} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean}
 */
function record(entry, options) {
	return append(STORE, entry, options);
}

/**
 * @param {RunRow} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean}
 */
function recordFailure(entry, options) {
	return append(FAIL_STORE, entry, options);
}

/**
 * @param {KillRow} kill
 * @param {{root: string|null, say: (text: string) => void}} options
 */
function recordKill(kill, { root, say }) {
	const landed = orFallback(() => recordFailure(kill, { root }), false);
	if (!landed)
		say(
			"This kill was not recorded to the fail store, so it will not be counted.\n",
		);
}

/**
 * @param {string} root
 * @param {{at: string, sha: string}} marker
 * @returns {string}
 */
function failureRecoveryCommand(root, marker) {
	const files = JSON.stringify([
		storePath(root, FAIL_STORE),
		archivePath(root, FAIL_STORE),
	]);
	const at = JSON.stringify(marker.at);
	const sha = JSON.stringify(marker.sha);
	const script = `const fs=require("fs");let n=0;for(const p of ${files}){let t="";try{t=fs.readFileSync(p,"utf8")}catch{}for(const l of t.split("\\n")){let m;try{m=JSON.parse(l)}catch{continue}if(m.at!==${at}||m.sha!==${sha})continue;n++;for(const f of (m.scope?.failures??[]))console.log(f.file,"—",f.tests.join(", "))}}if(!n)console.log("no line for this run in either store")`;
	return `node -e ${shellQuote(script)}`;
}

/**
 * @param {string} store
 * @param {RunRow} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean}
 */
function append(
	store,
	entry,
	{ root = repoRoot(), pruneAt = PRUNE_AT, keep = KEEP } = {},
) {
	if (!root || !entry?.sha) return false;
	appendLedgerLine(root, entry, store === STORE);
	const file = storePath(root, store);
	try {
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		return false;
	}
	ignoreFailure(() => {
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		if (lines.length > pruneAt) {
			archive(root, store, lines.slice(0, -keep));
			fs.writeFileSync(file, `${lines.slice(-keep).join("\n")}\n`);
		}
	});
	return true;
}

/**
 * @param {string} file
 * @returns {{markers: Marker[], malformed: number, total: number}}
 */
function parseStore(file) {
	const read = orFallback(() => readJsonl(file), null);
	if (!read) return { markers: [], malformed: 0, total: 0 };
	const markers = /** @type {Marker[]} */ (
		read.rows.filter((entry) => typeof entry.sha === "string")
	);
	const bad = read.bad.length + read.zeroed.length;
	return {
		markers,
		malformed: read.rows.length - markers.length + bad,
		total: read.rows.length + bad,
	};
}

function readMarkers({ root = repoRoot(), store = STORE } = {}) {
	if (!root) return [];
	return parseStore(storePath(root, store)).markers;
}

/** @param {string} file */
const readStoreFile = (file) => parseStore(file).markers;

/**
 * @param {{root?: string|null, store?: string}} [options]
 * @returns {{malformed: number, total: number}}
 */
function countMalformed({ root = repoRoot(), store = STORE } = {}) {
	if (!root) return { malformed: 0, total: 0 };
	const { malformed, total } = parseStore(storePath(root, store));
	return { malformed, total };
}

/**
 * @param {import("./tree-drift.js").Snapshot|null} before
 * @param {import("./tree-drift.js").Snapshot} after
 * @param {ReturnType<typeof import("./tree-drift.js").drift>} drifted
 * @param {object} [run]
 * @param {Scope|null} [run.scope]
 * @param {string} [run.suite]
 * @param {number|null} [run.startedAtMs]
 * @param {number|null} [run.elapsedMs]
 * @param {import("./cpu-sample.js").CpuSample|null} [run.machineStart]
 * @param {import("./cpu-sample.js").CpuSample|null} [run.machineEnd]
 * @param {number|null} [run.endedAtMs]
 * @param {boolean} [run.isolated]
 * @param {string|null} [run.treeAtEnd]
 * @param {string|null} [run.sessionId]
 * @param {boolean} [run.lander]
 * @param {string[]|null} [run.argv]
 * @param {Attestation|null} [run.attestation]
 * @param {import("./test-file-timings.js").SlowFile[]|null} [run.slowest]
 * @param {import("./run-memory.js").RunMemory|null} [run.memory]
 * @param {import("./part-suite-peak.js").PartAdmission|null} [run.admission]
 * @returns {Marker & {foreign: {path: string, why: string}[]}}
 */
function markerFrom(
	before,
	after,
	drifted,
	{
		scope = null,
		suite = DEFAULT_SUITE,
		startedAtMs = null,
		elapsedMs = null,
		machineStart = null,
		machineEnd = null,
		endedAtMs = null,
		isolated = false,
		treeAtEnd = null,
		sessionId = idSeam.fromEnv(),
		lander = idSeam.isLanderRun(),
		argv = null,
		attestation = null,
		slowest = null,
		memory = null,
		admission = null,
	} = {},
) {
	const attested = attestedFields(attestation);
	const dirtyCount = Object.keys(before?.files ?? {}).length;
	const finishedAtMs =
		typeof endedAtMs === "number" && Number.isFinite(endedAtMs)
			? endedAtMs
			: Date.now();
	const timed =
		typeof startedAtMs === "number" && finishedAtMs < startedAtMs
			? {}
			: timedFields(startedAtMs, elapsedMs);
	const machineDelta = cpuDelta(machineStart, machineEnd);
	const machine = machineDelta ? { machine: machineDelta } : {};
	return {
		sha: after.head,
		at: new Date(finishedAtMs).toISOString(),
		suite,
		...timed,
		...machine,
		...(scope ? { scope } : {}),
		startStateUnknown: !before,
		dirtyAtStart: dirtyCount > 0,
		dirtyCount,
		headMovedDuringRun: Boolean(drifted?.headMoved),
		isolated: Boolean(isolated),
		...(treeAtEnd ? { treeAtEnd } : {}),
		...(sessionId ? { sessionId } : {}),
		...(lander ? { lander: true } : {}),
		...(argv ? { argv } : {}),
		...attested,
		...(slowest?.length ? { slowest } : {}),
		...(memory ? { memory } : {}),
		...(admission ? { admission } : {}),
		foreign: (drifted?.moved ?? []).map((e) => ({
			path: e.path,
			why: `${e.kind} while the suite ran`,
		})),
	};
}

/**
 * @param {Pick<import("./suite-handoff.js").Launch, "base">} launch
 * @returns {Attestation & {closure: "*"}}
 */
function fullAttestationOf({ base }) {
	return { closure: "*", ...(base ? { base } : {}) };
}

/**
 * @param {Attestation|null} attestation
 * @returns {Pick<Marker, "closure"|"selected"|"changedPaths"|"base"|"imports"|"roots"|"cached">}
 */
function attestedFields(attestation) {
	if (!attestation || !isClosure(attestation.closure)) return {};
	const { closure, selected, changedPaths, base, imports, roots, cached } =
		attestation;
	const based = typeof base === "string" && base ? { base } : {};
	if (closure === "*") return { closure, ...based };
	return {
		closure,
		...(isStringList(selected) ? { selected } : {}),
		...(Array.isArray(changedPaths) ? { changedPaths } : {}),
		...based,
		...(isImportMap(imports) && isStringList(roots) ? { imports, roots } : {}),
		...(Array.isArray(cached) ? { cached } : {}),
	};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string[]>}
 */
const isImportMap = (value) =>
	value != null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.values(value).every(isStringList);

/**
 * @typedef {Marker & {closure: string[], selected: string[],
 *   imports: Record<string, string[]>, roots: string[]}} PerTestMarker
 */

/**
 * @param {Marker} m
 * @returns {m is PerTestMarker}
 */
const isPerTest = (m) =>
	Array.isArray(m.closure) &&
	isStringList(m.selected) &&
	isImportMap(m.imports) &&
	isStringList(m.roots);

/**
 * @param {unknown} closure
 * @returns {closure is "*"|string[]}
 */
const isClosure = (closure) => closure === "*" || isStringList(closure);

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringList = (value) =>
	Array.isArray(value) && value.every((p) => typeof p === "string");

/**
 * @param {number|null} startedAtMs
 * @param {number|null} elapsedMs
 * @returns {Pick<Marker, "startedAt"|"durationMs">}
 */
function timedFields(startedAtMs, elapsedMs) {
	return typeof startedAtMs === "number" &&
		Number.isFinite(startedAtMs) &&
		typeof elapsedMs === "number" &&
		Number.isFinite(elapsedMs) &&
		elapsedMs >= 0
		? {
				startedAt: new Date(startedAtMs).toISOString(),
				durationMs: elapsedMs,
			}
		: {};
}

/** @param {Marker} m */
const isClean = (m) =>
	!m.startStateUnknown &&
	!m.dirtyAtStart &&
	!m.headMovedDuringRun &&
	(m.foreign || []).length === 0;

/**
 * @param {Scope|null|undefined} scope
 * @returns {scope is Scope}
 */
const isUnnarrowedScope = (scope) =>
	scope != null &&
	!scope.nameFilter &&
	(scope.fileFilters || []).length === 0 &&
	!scope.changed;

/** @param {Scope|null|undefined} scope */
const isFullScope = (scope) =>
	isUnnarrowedScope(scope) &&
	scope.modulesTotal > 0 &&
	scope.modulesRun === scope.modulesTotal;

/** @param {Marker} m */
const isFullRun = (m) => isFullScope(m.scope);

function readFailures(options = {}) {
	return readMarkers({ ...options, store: FAIL_STORE });
}

/** @param {Scope|null|undefined} scope */
const isAdmissibleScope = (scope) =>
	scope != null &&
	scope.admissible === true &&
	scope.modulesTotal > 0 &&
	!scope.nameFilter &&
	!scope.full &&
	!isFullScope(scope);

/** @param {Marker} m */
const isAdmissibleRun = (m) => isAdmissibleScope(m.scope);

/**
 * @param {unknown} manifest
 * @param {Set<string>} tests
 * @returns {Set<string>|null}
 */
function docsReadBy(manifest, tests) {
	const byTest = docsByTest(manifest);
	return byTest ? docsOfTests(byTest, tests) : null;
}

/**
 * @param {Map<string, Set<string>>} byTest
 * @param {Iterable<string>} tests
 * @returns {Set<string>}
 */
function docsOfTests(byTest, tests) {
	/** @type {Set<string>} */
	const docs = new Set();
	for (const t of tests) for (const doc of byTest.get(t) ?? []) docs.add(doc);
	return docs;
}

/**
 * @param {unknown} manifest
 * @returns {Map<string, Set<string>>|null}
 */
function docsByTest(manifest) {
	const edges = /** @type {{edges?: unknown}|null} */ (manifest)?.edges;
	if (!edges || typeof edges !== "object" || Array.isArray(edges)) return null;
	/** @type {Map<string, Set<string>>} */
	const byTest = new Map();
	for (const [doc, readers] of Object.entries(edges)) {
		if (!Array.isArray(readers)) return null;
		for (const t of readers) {
			const docs = byTest.get(t) ?? new Set();
			docs.add(doc);
			byTest.set(t, docs);
		}
	}
	return byTest;
}

/**
 * @param {string} root
 * @returns {Map<string, Set<string>>}
 */
function readDocsByTest(root) {
	const byTest = docsByTest(
		JSON.parse(fs.readFileSync(path.join(root, EDGES_FILE), "utf8")),
	);
	if (!byTest) throw new Error(`${EDGES_FILE} is not {edges: {doc: [test]}}`);
	return byTest;
}

/**
 * @param {GitOptions} options
 * @returns {{root: string|null, execFn: typeof execProgram, cache: Map<string, string>}}
 */
function gitContext({
	root = repoRoot(),
	execFn = execProgram,
	cache = new Map(),
}) {
	return { root, execFn, cache };
}

/** @param {GitOptions} options */
function gitReader(options) {
	const { root, execFn, cache } = gitContext(options);
	/** @param {string[]} args */
	const git = (args) => {
		if (!root) throw new Error("no repository root");
		const key = args.join("\0");
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		const out = String(
			execFn(
				gitBinary(),
				args,
				gitSpawnOptions(
					/** @type {import("node:child_process").ExecFileSyncOptions} */ ({
						cwd: root,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}),
				),
			),
		);
		cache.set(key, out);
		return out;
	};
	return { git, root };
}

/** @param {string} out */
const lines = (out) =>
	out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/**
 * @typedef {{by: "sha"}|{by: "tree", tree: string, closureSize: number|"*"}} AttestationMatch
 * @param {Marker} m
 * @param {string} sha
 * @param {JudgeOptions} [options]
 * @returns {AttestationMatch|null}
 */
function holdsAt(m, sha, options = {}) {
	if (!m || typeof sha !== "string" || !sha) return null;
	if (m.sha === sha) return { by: "sha" };
	const { treeAtEnd, closure } = m;
	if (!treeAtEnd || closure == null) return null;
	if (closure !== "*" && !Array.isArray(closure)) return null;
	const { git, root } = gitReader(options);
	if (!root) return null;
	const countedPaths = options.countedPaths ?? null;
	try {
		return closure === "*"
			? holdsByTree(sha, treeAtEnd, { git, countedPaths })
			: holdsByClosure(
					sha,
					{ treeAtEnd, closure, selected: m.selected },
					{ git, countedPaths },
				);
	} catch {
		return null;
	}
}

/**
 * @param {string} tree
 * @param {string} sha
 * @param {DiffReader} by
 * @returns {string[]}
 */
function readTouchedBetween(tree, sha, { git, countedPaths }) {
	const touched = lines(
		git([
			"diff-tree",
			"--name-only",
			"-r",
			"--no-renames",
			tree,
			`${sha}^{tree}`,
		]),
	);
	return countedPaths ? touched.filter((p) => countedPaths.has(p)) : touched;
}

/**
 * @param {string} sha
 * @param {string} treeAtEnd
 * @param {DiffReader} by
 * @returns {AttestationMatch|null}
 */
function holdsByTree(sha, treeAtEnd, by) {
	const tree = by.git(["rev-parse", `${sha}^{tree}`]).trim();
	const holds =
		tree === treeAtEnd ||
		(by.countedPaths !== null &&
			readTouchedBetween(treeAtEnd, sha, by).length === 0);
	return holds ? { by: "tree", tree: treeAtEnd, closureSize: "*" } : null;
}

/**
 * @param {string} sha
 * @param {{treeAtEnd: string, closure: string[], selected?: string[]}} attested
 * @param {DiffReader} by
 * @returns {AttestationMatch|null}
 */
function holdsByClosure(sha, { treeAtEnd, closure, selected }, by) {
	const { git } = by;
	const inClosure = new Set(closure);
	if (Array.isArray(selected)) {
		const docs = docsReadBy(
			JSON.parse(git(["show", `${sha}:${EDGES_FILE}`])),
			new Set(selected),
		);
		if (!docs) return null;
		for (const doc of docs) inClosure.add(doc);
	}
	if (readTouchedBetween(treeAtEnd, sha, by).some((p) => inClosure.has(p)))
		return null;
	return { by: "tree", tree: treeAtEnd, closureSize: inClosure.size };
}

/**
 * @typedef {{sha: string, touched: (tree: string) => Set<string>,
 *   landed: (tree: string) => Set<string>,
 *   docsOf: () => Map<string, Set<string>>,
 *   readersOf: (p: string) => string[],
 *   tracked: (paths: string[]) => Set<string>}} ShaView
 * @param {string} sha
 * @param {DiffReader} by
 * @returns {ShaView}
 */
function shaView(sha, by) {
	const { git, countedPaths } = by;
	/** @type {Map<string, {touched: Set<string>, landed: Set<string>}>} */
	const diffs = new Map();
	/** @param {string} tree */
	const split = (tree) => {
		const hit = diffs.get(tree);
		if (hit) return hit;
		const all = readTouchedBetween(tree, sha, { git, countedPaths: null });
		const counts = (/** @type {string} */ p) =>
			countedPaths === null || countedPaths.has(p);
		const parts = {
			touched: new Set(all.filter(counts)),
			landed: new Set(all.filter((p) => !counts(p))),
		};
		diffs.set(tree, parts);
		return parts;
	};
	/** @type {{edges: Record<string, unknown>, byTest: Map<string, Set<string>>}|null} */
	let manifest = null;
	const read = () => {
		if (manifest) return manifest;
		const parsed = JSON.parse(git(["show", `${sha}:${EDGES_FILE}`]));
		const byTest = docsByTest(parsed);
		if (!byTest)
			throw new Error(`${EDGES_FILE} at ${shortSha(sha)} is malformed`);
		manifest = { edges: parsed.edges, byTest };
		return manifest;
	};
	return {
		sha,
		touched: (tree) => split(tree).touched,
		landed: (tree) => split(tree).landed,
		docsOf: () => read().byTest,
		readersOf: (p) => {
			const readers = read().edges[p];
			return isStringList(readers) ? readers : [];
		},
		tracked: (paths) =>
			paths.length === 0
				? new Set()
				: new Set(
						lines(git(["ls-tree", "-r", "--name-only", sha, "--", ...paths])),
					),
	};
}

/**
 * @param {PerTestMarker} m
 * @param {ShaView} view
 * @returns {{held: Set<string>, rootsHold: boolean, codeHolds: boolean,
 *   match: AttestationMatch}|null}
 */
function testsHeldAt(m, view) {
	const { selected, imports, roots } = m;
	if (m.sha === view.sha)
		return {
			held: new Set(selected),
			rootsHold: true,
			codeHolds: true,
			match: { by: "sha" },
		};
	if (!m.treeAtEnd) return null;
	try {
		const touched = view.touched(m.treeAtEnd);
		const closure = new Set(roots);
		/** @type {AttestationMatch} */
		const match = { by: "tree", tree: m.treeAtEnd, closureSize: 0 };
		if (roots.some((p) => touched.has(p)))
			return { held: new Set(), rootsHold: false, codeHolds: false, match };
		const codeHolds = !selected.some(
			(t) => touched.has(t) || (imports[t] ?? []).some((p) => touched.has(p)),
		);
		const docsOf = view.docsOf();
		const held = new Set();
		for (const t of selected) {
			const own = imports[t];
			if (!own) continue;
			const reads = [t, ...own, ...(docsOf.get(t) ?? [])];
			if (reads.some((p) => touched.has(p))) continue;
			held.add(t);
			for (const p of reads) closure.add(p);
		}
		match.closureSize = closure.size;
		return { held, rootsHold: true, codeHolds, match };
	} catch {
		return null;
	}
}

/**
 * @param {Marker} m
 * @param {string} test
 * @param {string} sha
 * @param {GitOptions} [options]
 * @returns {boolean}
 */
function holdsTestByTree(m, test, sha, options = {}) {
	if (!m.treeAtEnd) return false;
	if (!(isPerTest(m) && m.imports[test]))
		return holdsAt({ ...m, sha: "" }, sha, options) !== null;
	const { git, root } = gitReader(options);
	if (!root) return false;
	try {
		const view = shaView(sha, { git, countedPaths: null });
		const reads = [
			test,
			...m.imports[test],
			...(view.docsOf().get(test) ?? []),
			...m.roots,
		];
		return isSameContent(
			reads,
			readTreeIds(git, m.treeAtEnd, reads),
			readTreeIds(git, `${sha}^{tree}`, reads),
		);
	} catch {
		return false;
	}
}

/**
 * @typedef {{marker: Marker, match: AttestationMatch}} Member
 * @typedef {{path: string, tests?: string[]}} Unattested
 * @typedef {{suite: string, attested: true, members: Member[], note: string|null}
 *   | {suite: string, attested: false, unattested: Unattested[],
 *     why?: string}} SuiteAttestation
 * @param {string} sha
 * @param {Marker[]} markers
 * @param {GitOptions & {within?: string[]|null}} [options]
 * @returns {{judged: true, base: string, range: string[], suites: SuiteAttestation[],
 *     within?: boolean}
 *   | {judged: false, why: string}}
 */
function attestationOf(sha, markers, { within = null, ...options } = {}) {
	const ctx = gitContext(options);
	if (!ctx.root) return { judged: false, why: "no git repository to read" };
	const { git } = gitReader(ctx);
	const start = VERIFIED_REF;
	let base;
	let range;
	try {
		base = git(["merge-base", sha, start]).trim();
		range = lines(git(["diff", "--name-only", "--no-renames", base, sha]));
	} catch {
		return {
			judged: false,
			why: `git could not resolve the merge-base of ${shortSha(sha)} with ${start}`,
		};
	}
	const countedPaths = range.length > 0 ? new Set(range) : null;
	if (within) {
		const keep = new Set(within);
		range = range.filter((p) => keep.has(p));
	}
	const judging = { ...ctx, countedPaths };
	const suites = suitesFor(range).map((suite) =>
		suiteAttestation(sha, markers, { suite, range }, judging),
	);
	return {
		judged: true,
		base,
		range,
		suites,
		...(within ? { within: true } : {}),
	};
}

/**
 * @param {string} sha
 * @param {Marker[]} markers
 * @param {{ suite: string, range: string[] }} target
 * @param {JudgeOptions} ctx
 * @returns {SuiteAttestation}
 */
function suiteAttestation(sha, markers, { suite, range }, ctx) {
	const newestFirst = markers
		.filter((m) => suiteOf(m) === suite && (isFullRun(m) || isAdmissibleRun(m)))
		.reverse();
	const judge = perTestJudge(sha, ctx);
	const { sole, held, perTest } = heldMembers(sha, newestFirst, range, {
		ctx,
		judge,
	});
	if (sole) return buildAttestedVerdict(sha, suite, [sole]);
	if (range.length === 0)
		return {
			suite,
			attested: false,
			unattested: [],
			why: `no ${suite} certificate holds at ${shortSha(sha)}`,
		};
	const { members, left } = pickAttesters(held, range);
	const pairs = pairAttestation([...left], perTest, judge);
	if (pairs.unattested.length > 0)
		return { suite, attested: false, unattested: pairs.unattested };
	return buildAttestedVerdict(sha, suite, [...members, ...pairs.members]);
}

/**
 * @param {string} sha
 * @param {JudgeOptions} ctx
 * @returns {{view: () => ShaView|null, held: (m: PerTestMarker) => ReturnType<typeof testsHeldAt>}}
 */
function perTestJudge(sha, ctx) {
	/** @type {ShaView|null|undefined} */
	let view;
	const getView = () => {
		if (view === undefined) {
			const { git, root } = gitReader(ctx);
			view = root
				? shaView(sha, { git, countedPaths: ctx.countedPaths ?? null })
				: null;
		}
		return view;
	};
	/** @type {Map<Marker, ReturnType<typeof testsHeldAt>>} */
	const judged = new Map();
	return {
		view: getView,
		held: (m) => {
			if (!judged.has(m)) {
				const v = getView();
				judged.set(m, v ? testsHeldAt(m, v) : null);
			}
			return judged.get(m) ?? null;
		},
	};
}

/**
 * @typedef {Member & {selected: Set<string>}} HeldMember
 * @param {string} sha
 * @param {Marker[]} newestFirst
 * @param {string[]} range
 * @param {{ctx: JudgeOptions, judge: ReturnType<typeof perTestJudge>}} by
 * @returns {{sole: Member|null, held: HeldMember[], perTest: PerTestMarker[]}}
 */
function heldMembers(sha, newestFirst, range, { ctx, judge }) {
	const inRange = new Set(range);
	/** @type {HeldMember[]} */
	const held = [];
	/** @type {PerTestMarker[]} */
	const perTest = [];
	for (const m of newestFirst) {
		if (!isFullRun(m) && isPerTest(m)) {
			const tests = range.length === 0 ? judge.held(m) : null;
			if (tests && tests.held.size === m.selected.length)
				return { sole: { marker: m, match: tests.match }, held, perTest };
			perTest.push(m);
			continue;
		}
		const whole = wholeHolding(m, sha, { range, inRange, ctx });
		if (whole?.alone) return { sole: whole.member, held, perTest };
		if (whole) held.push(whole.member);
	}
	return { sole: null, held, perTest };
}

/**
 * @param {Marker} m
 * @param {string} sha
 * @param {{range: string[], inRange: Set<string>, ctx: JudgeOptions}} over
 * @returns {{member: HeldMember, alone: boolean}|null}
 */
function wholeHolding(m, sha, { range, inRange, ctx }) {
	const selectsAll = isFullRun(m);
	const selected = new Set(
		selectsAll ? range : (m.changedPaths ?? []).filter((p) => inRange.has(p)),
	);
	if (selected.size === 0 && range.length > 0) return null;
	const match = holdsAt(m, sha, ctx);
	if (!match) return null;
	return {
		member: { marker: m, match, selected },
		alone: selectsAll || range.length === 0,
	};
}

/**
 * @param {string[]} left
 * @param {PerTestMarker[]} perTest
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{members: Member[], unattested: Unattested[]}}
 */
function pairAttestation(left, perTest, judge) {
	/** @type {Unattested[]} */
	const unattested = [];
	/** @type {Map<Marker, AttestationMatch>} */
	const used = new Map();
	const view = left.length > 0 && perTest.length > 0 ? judge.view() : null;
	const readers = view ? readerIndex(left, perTest, view) : null;
	for (const p of left) {
		const verdict = readers
			? pathAttestation(p, readers, perTest, judge)
			: null;
		if (verdict && "members" in verdict)
			for (const { marker, match } of verdict.members) used.set(marker, match);
		else unattested.push({ path: p, ...verdict });
	}
	return {
		members: [...used].map(([marker, match]) => ({ marker, match })),
		unattested,
	};
}

/**
 * @param {string} p
 * @param {Map<string, string[]>} readers
 * @param {PerTestMarker[]} perTest
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{members: Member[]} | {tests: string[]} | null}
 */
function pathAttestation(p, readers, perTest, judge) {
	const witness = firstHolding(
		perTest,
		judge,
		(m) => (m.changedPaths ?? []).includes(p),
		(tests) => tests.rootsHold && (tests.codeHolds || !IMPORTABLE.test(p)),
	);
	if (!witness) return null;
	const view = judge.view();
	const landed =
		view && witness.match.by === "tree"
			? view.landed(witness.match.tree)
			: new Set();
	const { holders, missing } = readersHeld(
		(readers.get(p) ?? []).filter((t) => !landed.has(t)),
		perTest,
		judge,
	);
	return missing.length > 0
		? { tests: missing }
		: { members: [witness, ...holders] };
}

/**
 * @param {string[]} tests
 * @param {PerTestMarker[]} perTest
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{holders: Member[], missing: string[]}}
 */
function readersHeld(tests, perTest, judge) {
	/** @type {Member[]} */
	const holders = [];
	/** @type {string[]} */
	const missing = [];
	for (const t of tests) {
		const holder = firstHolding(
			perTest,
			judge,
			(m) => Boolean(m.selected?.includes(t)),
			(held) => held.held.has(t),
		);
		if (holder) holders.push(holder);
		else missing.push(t);
	}
	return { holders, missing: missing.sort() };
}

/**
 * @param {PerTestMarker[]} perTest
 * @param {ReturnType<typeof perTestJudge>} judge
 * @param {(m: Marker) => boolean} asks
 * @param {(tests: NonNullable<ReturnType<typeof testsHeldAt>>) => boolean} accepts
 * @returns {Member|null}
 */
function firstHolding(perTest, judge, asks, accepts) {
	for (const m of perTest) {
		if (!asks(m)) continue;
		const tests = judge.held(m);
		if (tests && accepts(tests)) return { marker: m, match: tests.match };
	}
	return null;
}

/**
 * @param {string[]} paths
 * @param {PerTestMarker[]} perTest
 * @param {ShaView} view
 * @returns {Map<string, string[]>|null}
 */
function readerIndex(paths, perTest, view) {
	/** @type {Map<string, Set<string>>} */
	const importers = new Map();
	for (const m of perTest)
		for (const [t, reached] of Object.entries(m.imports ?? {}))
			for (const p of reached) {
				const tests = importers.get(p) ?? new Set();
				tests.add(t);
				importers.set(p, tests);
			}
	try {
		/** @type {Map<string, Set<string>>} */
		const candidates = new Map();
		for (const p of paths)
			candidates.set(
				p,
				new Set([
					...view.readersOf(p),
					...(importers.get(p) ?? []),
					...(JS_TEST_FILE.test(p) ? [p] : []),
				]),
			);
		const tracked = view.tracked([
			...new Set([...candidates.values()].flatMap((s) => [...s])),
		]);
		return new Map(
			[...candidates].map(([p, tests]) => [
				p,
				[...tests].filter((t) => tracked.has(t)),
			]),
		);
	} catch {
		return null;
	}
}

/**
 * @param {HeldMember[]} held
 * @param {string[]} range
 * @returns {{members: Member[], left: Set<string>}}
 */
function pickAttesters(held, range) {
	const left = new Set(range);
	/** @type {Member[]} */
	const members = [];
	while (left.size > 0) {
		const best = widestAttester(held, left);
		if (!best) break;
		members.push({ marker: best.marker, match: best.match });
		for (const p of best.selected) left.delete(p);
	}
	return { members, left };
}

/**
 * @param {HeldMember[]} held
 * @param {Set<string>} left
 * @returns {HeldMember|null}
 */
function widestAttester(held, left) {
	let best = null;
	let bestGain = 0;
	for (const h of held) {
		let gain = 0;
		for (const p of h.selected) if (left.has(p)) gain++;
		if (gain > bestGain) {
			best = h;
			bestGain = gain;
		}
	}
	return best;
}

/**
 * @param {string} sha
 * @param {string} suite
 * @param {Member[]} members
 * @returns {SuiteAttestation}
 */
function buildAttestedVerdict(sha, suite, members) {
	const note = members
		.map(({ marker, match }) => buildTreeMatchNote(sha, marker, match, suite))
		.filter(Boolean)
		.join("");
	return { suite, attested: true, members, note: note || null };
}

/**
 * @param {string} sha
 * @param {Marker} m
 * @param {AttestationMatch} match
 * @param {string} [suite]
 */
function buildTreeMatchNote(sha, m, match, suite = DEFAULT_SUITE) {
	if (match.by !== "tree") return null;
	const { name } = suiteMeta(suite);
	const closure =
		match.closureSize === "*"
			? "closure: the whole tree"
			: `closure of ${match.closureSize} paths`;
	return `ℹ  ${name}: ${shortSha(sha)} attested by tree ${shortSha(match.tree)} from run at ${m.at ?? "an unknown time"} (${closure}) — a content match, not a sha match (#189).\n`;
}

/** @param {string} sha */
const shortSha = (sha) => String(sha).slice(0, WIDE_SHA);

/**
 * @param {string} sha
 * @param {SuiteAttestation & {attested: true}} s
 * @param {{narrowed?: boolean, redsAmongMembers?: boolean}} [wording]
 * @returns {string}
 */
function attestedReading(
	sha,
	s,
	{ narrowed = false, redsAmongMembers = false } = {},
) {
	const { name } = suiteMeta(s.suite);
	const out = [
		`✓  ${name}: ${s.members.length} ${redsAmongMembers ? "run(s) on record decide" : "certificate(s) attest"} ${narrowed ? "every file this run would test" : "the range"}:\n`,
		...s.members.map(
			({ marker: m }) =>
				`     ${m.at ?? "unknown time"} on ${shortSha(m.sha)} — ${isFullRun(m) ? "full run" : `narrowed run over ${(m.changedPaths ?? []).length} changed path(s)`}\n`,
		),
	];
	if (s.note) out.push(s.note);
	const dirty = s.members.find(
		({ marker, match }) => match.by === "sha" && !isClean(marker),
	);
	if (dirty) out.push(dirtyWarning(sha, dirty.marker, s.suite));
	return out.join("");
}

const FRESH_HINT = "(#4790; `--fresh` runs them)";

/**
 * @param {string[]} files
 * @returns {string|null}
 */
function formatCachedClause(files) {
	if (files.length === 0) return null;
	return `${files.length} cached, not run ${FRESH_HINT}: ${files.join(", ")}`;
}

/**
 * @param {Scope|null|undefined} scope
 * @param {string[]} [cachedFiles]
 * @returns {string|null}
 */
function formatFilteredRun(scope, cachedFiles = []) {
	if (!scope || isFullScope(scope)) return null;
	const bits = [
		`ran ${scope.tests - scope.skipped} of ${scope.tests} tests` +
			` in ${scope.modulesRun} of ${scope.modulesTotal} files`,
	];
	if (scope.skipped) bits.push(`${scope.skipped} skipped`);
	if (scope.nameFilter)
		bits.push(
			scope.nameFilter.startsWith("-")
				? scope.nameFilter
				: `-t ${scope.nameFilter}`,
		);
	const files = scope.fileFilters || [];
	if (files.length > 0) bits.push(`paths: ${files.join(", ")}`);
	const cached = formatCachedClause(cachedFiles);
	if (cached) bits.push(cached);
	if (scope.changed)
		bits.push(
			`--changed${typeof scope.changed === "string" ? ` ${scope.changed}` : ""}`,
		);
	if (isAdmissibleScope(scope))
		bits.push("ADMISSIBLE — the read graph rendered");
	return `FILTERED RUN — ${bits.join("; ")}`;
}

/**
 * @param {Marker} marker
 * @returns {string}
 */
function buildDirtyReason(marker) {
	const foreign = marker.foreign || [];
	if (foreign.length > 0)
		return `read ${foreign.length} file(s) that moved while it ran`;
	if (marker.startStateUnknown)
		return "began over a tree git could not read, so cleanliness is unknown";
	if (marker.headMovedDuringRun) return "ran while HEAD moved under it";
	return `read ${marker.dirtyCount || "some"} uncommitted tracked file(s)`;
}

/**
 * @param {string} sha
 * @param {Marker} marker
 * @param {string} [suite]
 */
function dirtyWarning(sha, marker, suite = DEFAULT_SUITE) {
	const { name, gate } = suiteMeta(suite);
	return `⚠  dirty tree: the ${name.toLowerCase()} certificate on ${shortSha(sha)} came from a run that ${buildDirtyReason(marker)}. Clear: ${gate} on a still tree.\n`;
}

module.exports = {
	CLOSURE_ROOTS,
	ARCHIVE_MS,
	STORE,
	EDGES_FILE,
	FAIL_STORE,
	EVIDENCE_NOT_LICENCE,
	FLAKE_NOTE,
	recordFailure,
	recordKill,
	failureRecoveryCommand,
	KEEP,
	repoRoot,
	storePath,
	record,
	readMarkers,
	readStoreFile,
	countMalformed,
	readFailures,
	markerFrom,
	isFullRun,
	isAdmissibleRun,
	isFullScope,
	fullAttestationOf,
	isUnnarrowedScope,
	gitReader,
	holdsTestByTree,
	docsOfTests,
	readDocsByTest,
	attestationOf,
	RETEST_FLAG,
	attestedReading,
	FULL_REASONS,
	FULL_CAUSES,
	TOUCHED_BASES,
	shortSha,
	DEFAULT_SUITE,
	suiteOf,
	formatFilteredRun,
	formatCachedClause,
	FRESH_HINT,
};
