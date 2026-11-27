const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const {
	DAY_MS,
	appendRetained,
	sweepRetained,
} = require("./retained-jsonl.js");
const { readJsonl } = require("./jsonl.js");
const { readText } = require("./file-read.js");
const { isUnder } = require("./is-under.js");
const { isSteadyUnder, readSteady } = require("./run-steadiness.js");
const { execGit, spawnGitSync, GIT_TIMEOUT_MS } = require("./git.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const {
	ABSENT,
	absentAsId,
	readTreeIds,
	readWorkingIds,
	isSameContent,
} = require("./content-ids.js");
const { caught } = require("./caught.js");
const { readRunReach } = require("./code-edges.js");
const { isScript, languageOf, pythonVersion } = require("./file-reach.js");
const {
	ARCHIVE_MS,
	FRESH_HINT,
	readDocsByTest,
	shortSha,
} = require("./test-pass-marker.js");
const { readWorkingTree } = require("./test-read-edges.js");
const { listingId } = require("./listing-id.js");
const { pathKind } = require("./path-kind.js");
const { buildGitRunner, keyOf } = require("./read-audit-git.js");
const idSeam = require("./session-id.js");

const STORE = ".test-file-results";

const RUN_INPUTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"tsconfig.json",
	".claude/workflow-core.json",
];

const PRAGMA = /\buncached:(.*)$/;
const PRAGMA_REASON = /^\s*\w/;

const FORMAT = 19;

const BLOB_ID = /^\d{6} ([0-9a-f]{40}|[0-9a-f]{64})$/;

const CACHED_ENV = "WFC_PASS_STORE_CACHED";

/**
 * @typedef {"pass"|"fail"} Outcome
 * @typedef {{file: string, outcome: Outcome, imports: string[]}} FileResult
 * @typedef {{sha: string, at: string, tree: string|null, root: string,
 *   files: FileResult[], shared: string[], clean: boolean,
 *   steadiness: import("./run-steadiness.js").Steadiness|null,
 *   audits: Map<string, import("./read-audit.js").Audit>|null}} Run
 * @typedef {{sha: string, at: string, tree: string|null}} Source
 * @typedef {{file: string, source: Source, reads: string[]}} Cached
 * @typedef {{cached: Cached[], run: string[], refused: string[],
 *   notice: string|null}} Lookup
 * @typedef {{values?: Record<string, string>, rowless?: boolean}} Seams
 * @typedef {{base: Record<string, string>, python: () => string|null}} Values
 */

/** @param {string} storeRoot */
const storeDir = (storeRoot) => path.join(markersDir(storeRoot), STORE);

/**
 * @param {string} storeRoot
 * @param {string} file
 */
const shardFile = (storeRoot, file) =>
	path.join(
		storeDir(storeRoot),
		`${crypto.createHash("sha256").update(file).digest("hex").slice(0, 16)}.jsonl`,
	);

/** @returns {Record<string, string>} */
const currentValues = () => ({ node: process.version, arch: process.arch });

/**
 * @param {Seams} seams
 * @returns {Values}
 */
function todayValues(seams) {
	const { python, ...base } = seams.values ?? currentValues();
	return { base, python: () => python ?? readPythonVersion() };
}

function readPythonVersion() {
	try {
		return pythonVersion();
	} catch {
		return null;
	}
}

/**
 * @param {boolean} runsPython
 * @param {Values} today
 * @returns {Record<string, string>|null}
 */
function rowValues(runsPython, today) {
	if (!runsPython) return today.base;
	const python = today.python();
	return python === null ? null : { ...today.base, python };
}

/** @param {string[]} paths */
const holdsPython = (paths) => paths.some((p) => languageOf(p) === "python");

/**
 * @param {string} root
 * @param {string} input
 */
const stdinOptions = (root, input) => ({
	cwd: root,
	input,
	encoding: /** @type {const} */ ("utf8"),
	stdio: /** @type {import("node:child_process").StdioOptions} */ ([
		"pipe",
		"pipe",
		"ignore",
	]),
	timeout: GIT_TIMEOUT_MS,
	maxBuffer: CHILD_MAX_BUFFER,
});

/**
 * @param {string} root
 * @returns {(args: string[], input: string) => string}
 */
const gitHasher = (root) => (args, input) =>
	String(execGit(args, stdinOptions(root, input)));

/**
 * @param {string} root
 * @param {string[]} files
 * @returns {Map<string, string[]>}
 */
function readManifestReads(root, files) {
	const byTest = readDocsByTest(root);
	return new Map(
		files.map((file) => [file, [...(byTest.get(file) ?? [])].sort()]),
	);
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string[]}
 */
function snapshotOf(root, file) {
	const snap = path.posix.join(
		path.posix.dirname(file),
		"__snapshots__",
		`${path.posix.basename(file)}.snap`,
	);
	return fs.existsSync(path.join(root, snap)) ? [snap] : [];
}

/** @typedef {{edges: string[], shadows: string[], python: boolean}} Reach */

/**
 * @param {string} root
 * @returns {(file: string, ownReadsJudged?: boolean) => Reach|null}
 */
function lexicalReach(root) {
	const runReach = readRunReach(root);
	return (file, ownReadsJudged = false) => {
		let faulted = false;
		let reach;
		try {
			reach = runReach(file, () => {
				faulted = true;
			});
		} catch {
			return null;
		}
		const unknown = reach.unknown.some(
			(rel) => !(ownReadsJudged && rel === file),
		);
		const gone = reach.missing.some(
			(m) => m.from === null && isScript(path.join(root, file)),
		);
		if (faulted || unknown || gone || reach.unread.length > 0) return null;
		return {
			edges: reach.files.filter((rel) => rel !== file),
			shadows: reach.shadows,
			python: reach.python,
		};
	};
}

/**
 * @param {string} root
 * @param {string[]} shared
 */
const sharedInputs = (root, shared) => [
	...new Set([
		...shared,
		...RUN_INPUTS.filter((p) => fs.existsSync(path.join(root, p))),
	]),
];

/**
 * @typedef {{listing: (dir: string) => string|null,
 *   isDir: (dir: string) => boolean,
 *   git: (key: string) => string|null}} TreeAt
 */

/**
 * @param {string} root
 * @returns {TreeAt}
 */
function buildWorkingAt(root) {
	return {
		git: buildGitRunner(root, (args, opts) =>
			spawnGitSync(args, { ...opts, timeout: GIT_TIMEOUT_MS }),
		),
		listing: (dir) => {
			try {
				return listingId(fs.readdirSync(path.join(root, dir)));
			} catch {
				return null;
			}
		},
		isDir: (dir) => pathKind(path.join(root, dir)) === "dir",
	};
}

/**
 * @param {(args: string[]) => string} git
 * @param {string} treeish
 * @returns {TreeAt}
 */
function buildCommitAt(git, treeish) {
	const names = (/** @type {string} */ dir) => {
		try {
			const spec = `${treeish}:${dir === "." ? "" : dir}`;
			if (git(["cat-file", "-t", spec]).trim() !== "tree") return null;
			return git(["ls-tree", "-z", "--name-only", spec])
				.split("\0")
				.filter(Boolean);
		} catch {
			return null;
		}
	};
	return {
		listing: (dir) => {
			const found = names(dir);
			return found === null ? null : listingId(found);
		},
		isDir: (dir) => names(dir) !== null,
		git: () => null,
	};
}

/**
 * @param {{listings?: unknown, dirs?: unknown, git?: unknown}} rested
 * @param {TreeAt} at
 */
function isTreeHolding({ listings, dirs, git }, at) {
	const lists = asIds(listings);
	const calls = asIds(git);
	if (!lists || !calls || !Array.isArray(dirs)) return false;
	return (
		[...lists].every(([dir, id]) => at.listing(dir) === id) &&
		dirs.every((dir) => typeof dir === "string" && at.isDir(dir)) &&
		[...calls].every(([key, id]) => at.git(key) === id)
	);
}

/**
 * @param {string} root
 * @returns {() => Map<string, Set<string>>}
 */
function buildTrackedListings(root) {
	/** @type {Map<string, Set<string>> | undefined} */
	let byDir;
	return () => {
		if (byDir) return byDir;
		/** @type {Map<string, Set<string>>} */
		const found = new Map([[".", new Set()]]);
		for (const p of readWorkingTree(root).tracked) {
			const parts = p.split("/");
			for (let i = 0; i < parts.length; i++) {
				const dir = i === 0 ? "." : parts.slice(0, i).join("/");
				const names = found.get(dir) ?? new Set();
				names.add(/** @type {string} */ (parts[i]));
				found.set(dir, names);
			}
		}
		byDir = found;
		return found;
	};
}

/**
 * @param {import("./read-audit.js").Reads} reads
 * @param {() => Map<string, Set<string>>} listings
 * @param {TreeAt} working
 * @param {(top: string) => boolean} steadyUnder
 * @returns {{files: string[], absent: string[], dirs: string[],
 *   logged: Record<string, string>, listings: Record<string, string>,
 *   git: Record<string, string>}|null}
 */
function auditInputs(reads, listings, working, steadyUnder) {
	const lists = Object.entries(reads.lists);
	const tracked =
		lists.length + reads.trees.length > 0 ? listings() : new Map();
	const idOf = (/** @type {string} */ dir) =>
		listingId([...(tracked.get(dir) ?? [])]);
	/** @type {Record<string, string>} */
	const logged = {};
	for (const [dir, id] of lists) {
		if (idOf(dir) !== id) return null;
		logged[dir] = id;
	}
	/** @type {Record<string, string>} */
	const walked = {};
	const files = [...reads.files];
	for (const top of reads.trees) {
		const tree = steadyUnder(top) ? treeInputs(top, tracked, working) : null;
		if (!tree) return null;
		files.push(...tree.files);
		Object.assign(walked, tree.listings);
	}
	/** @type {Record<string, string>} */
	const git = {};
	for (const { cwd, args, answer } of reads.git) {
		const key = keyOf({ cwd, args });
		const id = working.git(key);
		if (id !== answer) return null;
		git[key] = id;
	}
	return {
		files: [...new Set(files)],
		absent: reads.absent,
		dirs: reads.dirs,
		logged,
		listings: { ...logged, ...walked },
		git,
	};
}

/**
 * @param {string} top
 * @param {Map<string, Set<string>>} tracked
 * @param {TreeAt} working
 * @returns {{files: string[], listings: Record<string, string>}|null}
 */
function treeInputs(top, tracked, working) {
	const files = tracked.has(top) ? [] : [top];
	/** @type {Record<string, string>} */
	const listings = {};
	for (const [dir, names] of tracked) {
		if (top !== "." && !isUnder(dir, [top])) continue;
		const id = listingId([...names]);
		if (working.listing(dir) !== id) return null;
		listings[dir] = id;
		for (const name of names) {
			const p = dir === "." ? name : `${dir}/${name}`;
			if (!tracked.has(p)) files.push(p);
		}
	}
	return { files, listings };
}

/**
 * @typedef {{logged: Record<string, string>,
 *   listings: Record<string, string>, dirs: string[],
 *   git: Record<string, string>}} Seen
 * @typedef {Reach & {from: string}} Reached
 * @typedef {FileResult & {direct: string[], reached: Reached[],
 *   probed: string[], seen: Seen|null, whole: boolean}} Gathered
 */

/**
 * @param {FileResult} f
 * @param {{run: Run, reads: Map<string, string[]>,
 *   reach: (file: string, ownReadsJudged?: boolean) => Reach|null,
 *   listings: () => Map<string, Set<string>>, working: TreeAt,
 *   steadyUnder: (top: string) => boolean}} ctx
 * @returns {Gathered}
 */
function gatherInputs(
	f,
	{ run, reads, reach, listings, working, steadyUnder },
) {
	const audit = run.audits?.get(f.file);
	const audited = audit && "reads" in audit ? audit.reads : null;
	const found = audited && auditInputs(audited, listings, working, steadyUnder);
	const seen = found && isTreeHolding(found, working) ? found : null;
	const spawned = reads.get(f.file) ?? [];
	const scripts = audited?.scripts ?? [];
	const roots = [...f.imports, ...spawned, ...run.shared, ...scripts];
	/** @type {Reached[]} */
	const reached = [];
	const walk = (/** @type {string} */ from, /** @type {boolean} */ own) => {
		const r = reach(from, own);
		if (r) reached.push({ from, ...r });
	};
	walk(f.file, true);
	for (const p of roots) walk(p, false);
	return {
		...f,
		direct: [
			...new Set([
				f.file,
				...f.imports,
				...spawned,
				...snapshotOf(run.root, f.file),
				...scripts,
				...(found?.files ?? audited?.files ?? []),
			]),
		],
		reached,
		probed: audited?.absent ?? [],
		seen,
		whole: seen !== null && reached.length === roots.length + 1,
	};
}

/**
 * @typedef {{file: string, outcome: string, voiding?: boolean,
 *   inputs: Record<string, string|null|undefined>,
 *   listings: Record<string, string>, dirs: string[],
 *   git: Record<string, string>}} Row
 * @typedef {{values: Record<string, string>, shared: Record<string, unknown>,
 *   row: Row}} Recorded
 * @typedef {{gathered: Gathered[], shared: string[],
 *   ids: Map<string, string|null>, steady: import("./run-steadiness.js").Steady,
 *   isKnown: (p: string) => boolean, isAbsent: (p: string) => boolean}} RunInputs
 */

/**
 * @param {Run} run
 * @param {FileResult[]} files
 * @returns {RunInputs}
 */
function readRunInputs(run, files) {
	const reads = readManifestReads(
		run.root,
		files.map((f) => f.file),
	);
	const shared = sharedInputs(run.root, run.shared);
	const reach = lexicalReach(run.root);
	const listings = buildTrackedListings(run.root);
	const working = buildWorkingAt(run.root);
	const steadyUnder = (/** @type {string} */ top) =>
		isSteadyUnder(run.steadiness, top);
	const gathered = files.map((f) =>
		gatherInputs(f, {
			run,
			reads,
			reach,
			listings,
			working,
			steadyUnder,
		}),
	);
	const edges = (/** @type {Gathered} */ g) =>
		g.reached.flatMap((r) => r.edges);
	const all = [
		...shared,
		...gathered.flatMap((g) => [...g.direct, ...edges(g)]),
	];
	const tried = [
		...all,
		...gathered.flatMap((g) => [
			...g.probed,
			...g.reached.flatMap((r) => r.shadows),
		]),
	];
	const ids = readWorkingIds(gitHasher(run.root), run.root, tried);
	const steady = readSteady(run.steadiness, run.root, tried);
	const { isSteady } = steady;
	return {
		gathered,
		shared,
		ids,
		steady,
		isKnown: (p) => isSteady(p) && typeof ids.get(p) === "string",
		isAbsent: (p) => isSteady(p) && ids.has(p) && ids.get(p) === null,
	};
}

/**
 * @param {string[]} paths
 * @param {Map<string, string|null>} ids
 */
const idsOf = (paths, ids) =>
	Object.fromEntries(paths.map((p) => [p, ids.get(p)]));

/**
 * @param {RunInputs} inputs
 * @param {Seams} seams
 * @returns {Recorded[]}
 */
function buildKnownRows({ gathered, shared, ids, isKnown, isAbsent }, seams) {
	if (!shared.every(isKnown)) return [];
	const today = todayValues(seams);
	const sharedIds = idsOf(shared, ids);
	return gathered.flatMap((g) => {
		if (!g.whole || !g.seen) return [];
		const paths = [
			...new Set([
				g.file,
				...g.imports,
				...g.reached.flatMap((r) => r.edges),
				...g.direct,
			]),
		];
		const absent = [
			...new Set([...g.reached.flatMap((r) => r.shadows), ...g.probed]),
		].filter((p) => !paths.includes(p));
		if (!paths.every(isKnown) || !absent.every(isAbsent)) return [];
		const values = rowValues(
			g.reached.some((r) => r.python) || holdsPython([...paths, ...absent]),
			today,
		);
		if (values === null) return [];
		const row = {
			file: g.file,
			outcome: g.outcome,
			inputs: Object.assign(
				idsOf(paths, ids),
				Object.fromEntries(absent.map((p) => [p, ABSENT])),
			),
			listings: g.seen.listings,
			dirs: g.seen.dirs,
			git: g.seen.git,
		};
		return [{ values, shared: sharedIds, row }];
	});
}

/**
 * @param {string} file
 * @param {{inputs?: Row["inputs"], listings?: Row["listings"],
 *   dirs?: Row["dirs"]}} [keyed]
 * @returns {Row}
 */
const buildVoidingRow = (
	file,
	{ inputs = {}, listings = {}, dirs = [] } = {},
) => ({
	file,
	outcome: "fail",
	voiding: true,
	inputs,
	listings,
	dirs,
	git: {},
});

/**
 * @param {Gathered[]} failed
 * @param {RunInputs} inputs
 * @param {Seams} seams
 * @returns {Recorded[]}
 */
function buildVoidingRows(failed, inputs, seams) {
	const values = todayValues(seams).base;
	const { ids, isKnown, isAbsent } = inputs;
	return failed.map((g) => {
		const sound = g.reached.filter((r) => [r.from, ...r.edges].every(isKnown));
		const paths = [
			...new Set([...g.direct, ...sound.flatMap((r) => r.edges)]),
		].filter(isKnown);
		const absent = [
			...new Set([...sound.flatMap((r) => r.shadows), ...g.probed]),
		].filter(isAbsent);
		const seen = inputs.steady.known ? g.seen : null;
		return {
			values,
			shared: idsOf(inputs.shared.filter(isKnown), ids),
			row: buildVoidingRow(g.file, {
				inputs: {
					...idsOf(paths, ids),
					...Object.fromEntries(absent.map((p) => [p, ABSENT])),
				},
				listings: seen?.logged,
				dirs: seen?.dirs,
			}),
		};
	});
}

/**
 * @param {FileResult[]} failed
 * @param {Seams} seams
 * @returns {Recorded[]}
 */
function buildUnkeyedVoidingRows(failed, seams) {
	const values = todayValues(seams).base;
	return failed.map(({ file }) => ({
		values,
		shared: {},
		row: buildVoidingRow(file),
	}));
}

/**
 * @param {RunInputs} inputs
 * @param {Seams} seams
 * @returns {Recorded[]}
 */
function buildRows(inputs, seams) {
	if (!inputs.steady.settled) {
		return buildUnkeyedVoidingRows(
			inputs.gathered.filter((g) => g.outcome === "fail"),
			seams,
		);
	}
	const known = buildKnownRows(inputs, seams);
	const keyed = new Set(known.map(({ row }) => row.file));
	const failed = inputs.gathered.filter(
		(g) => g.outcome === "fail" && !keyed.has(g.file),
	);
	return [...known, ...buildVoidingRows(failed, inputs, seams)];
}

const ROWLESS_RUN = "WFC_ROWLESS_RUN";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isRowlessRun(env = process.env) {
	return idSeam.isLanderRun(env) || env[ROWLESS_RUN] === "1";
}

/**
 * @param {Run} run
 * @param {{storeRoot: string|null,
 *   err?: {write: (s: string) => unknown}} & Seams} options
 * @returns {number}
 */
function record(run, { storeRoot, err = process.stderr, ...seams }) {
	const files = run.clean
		? run.files
		: run.files.filter((f) => f.outcome === "fail");
	if (!storeRoot || files.length === 0) return 0;
	if (seams.rowless ?? isRowlessRun()) return 0;
	/** @type {RunInputs|null} */
	let inputs = null;
	try {
		inputs = readRunInputs(run, files);
	} catch (e) {
		err.write(
			`pass-store.js: this run's inputs will not read (${caught(e).message ?? e}), so it records no pass (workflow-core#4790)\n`,
		);
	}
	try {
		const rows = inputs
			? buildRows(inputs, seams)
			: buildUnkeyedVoidingRows(
					files.filter((f) => f.outcome === "fail"),
					seams,
				);
		if (rows.length === 0) return 0;
		fs.mkdirSync(storeDir(storeRoot), { recursive: true });
		const line = { format: FORMAT, at: run.at, sha: run.sha, tree: run.tree };
		const landed = rows.filter(({ values, shared, row }) =>
			appendRetained(
				shardFile(storeRoot, row.file),
				{ ...line, shared, values, files: [row] },
				ARCHIVE_MS,
				{ dropOnBadLine: true },
			),
		).length;
		sweepOrSay(storeRoot, err);
		return landed;
	} catch (e) {
		err.write(
			`pass-store.js: no row recorded for this run (${caught(e).message ?? e}) (workflow-core#4790)\n`,
		);
		return 0;
	}
}

/**
 * @param {string} storeRoot
 * @param {{write: (s: string) => unknown}} err
 */
function sweepOrSay(storeRoot, err) {
	try {
		sweepShards(storeRoot);
	} catch (e) {
		err.write(
			`pass-store.js: stale shards not swept (${caught(e).message ?? e}) (workflow-core#4790)\n`,
		);
	}
}

/** @param {string} storeRoot */
function sweepShards(storeRoot) {
	sweepRetained(storeDir(storeRoot), ARCHIVE_MS + DAY_MS);
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {"none"|"reasoned"|"bare"}
 */
function readPragma(root, file) {
	const read = readText(path.join(root, file));
	if (read.state !== "read") return "reasoned";
	for (const line of read.data.split("\n")) {
		const t = line.trim();
		if (t && !/^(?:\/\/|\/\*|\*|#!)/.test(t)) break;
		const m = PRAGMA.exec(t);
		if (m) return PRAGMA_REASON.test(m[1] ?? "") ? "reasoned" : "bare";
	}
	return "none";
}

/**
 * @param {string[]} files
 * @param {{root: string, storeRoot: string|null} & Seams} options
 * @returns {Lookup}
 */
function lookup(files, { root, storeRoot, ...seams }) {
	/** @type {Lookup} */
	const none = { cached: [], run: [...files], refused: [], notice: null };
	if (files.length === 0 || !storeRoot) return none;
	if (seams.rowless ?? isRowlessRun()) return none;
	const pragmas = new Map(files.map((f) => [f, readPragma(root, f)]));
	const refused = files.filter((f) => pragmas.get(f) === "bare");
	if (refused.length > 0) return { ...none, refused };
	const candidates = files.filter((f) => pragmas.get(f) === "none");
	if (candidates.length === 0) return none;
	let found;
	try {
		found = readCached(candidates, { root, storeRoot, ...seams });
	} catch (e) {
		return {
			...none,
			notice: `pass store: ${caught(e).message ?? e} — every selected file runs (workflow-core#4790).`,
		};
	}
	const hit = new Set(found.cached.map((c) => c.file));
	return {
		...none,
		cached: found.cached,
		run: files.filter((f) => !hit.has(f)),
		notice: found.notice,
	};
}

/** @typedef {{row: Record<string, unknown>, run: Record<string, unknown>}} Entry */

/**
 * @param {string[]} candidates
 * @param {{root: string, storeRoot: string} & Seams} options
 * @returns {{cached: Cached[], notice: string|null}}
 */
function readCached(candidates, { root, storeRoot, ...seams }) {
	const { byFile, unparsed, zeroed } = readEntries(storeRoot, candidates);
	const wanted = new Set([...byFile.values()].flat().flatMap(entryReads));
	let now;
	let reads;
	try {
		now = absentAsId(readWorkingIds(gitHasher(root), root, [...wanted]));
		reads = readManifestReads(root, candidates);
	} catch (e) {
		throw new Error(
			`the working tree could not be read (${caught(e).message ?? e})`,
			{ cause: e },
		);
	}
	const values = todayValues(seams);
	const tree = buildWorkingAt(root);
	const cached = candidates.flatMap((file) => {
		if (unparsed.has(file) || zeroed.has(file)) return [];
		const held = findDeciding(byFile.get(file) ?? [], now, (row, run) =>
			isRowHolding(row, run, {
				file,
				now,
				values,
				reads: reads.get(file) ?? [],
				tree,
			}),
		);
		return held?.row.outcome === "pass" ? [cachedFrom(file, held)] : [];
	});
	const faults = [
		...(unparsed.size > 0
			? [`a line that would not parse names ${[...unparsed].join(", ")}`]
			: []),
		...(zeroed.size > 0
			? [`a record zeroed by a crash names ${[...zeroed].join(", ")}`]
			: []),
	];
	const notice =
		faults.length > 0
			? `pass store: ${faults.join("; ")}, which run (workflow-core#4790).`
			: null;
	return { cached, notice };
}

/**
 * @param {string} storeRoot
 * @param {string[]} candidates
 * @returns {{byFile: Map<string, Entry[]>, unparsed: Set<string>, zeroed: Set<string>}}
 */
function readEntries(storeRoot, candidates) {
	/** @type {Record<string, unknown>[]} */
	const runs = [];
	/** @type {Set<string>} */
	const unparsed = new Set();
	/** @type {Set<string>} */
	const zeroed = new Set();
	for (const file of candidates) {
		let read;
		try {
			read = readJsonl(shardFile(storeRoot, file));
		} catch (e) {
			throw new Error(
				`the store could not be read (${caught(e).message ?? e})`,
				{ cause: e },
			);
		}
		if (read && read.bad.length > 0) unparsed.add(file);
		if (read && read.zeroed.length > 0) zeroed.add(file);
		const since = Date.now() - ARCHIVE_MS;
		runs.push(
			...(read?.rows ?? [])
				.filter((r) => Date.parse(String(r.at)) >= since)
				.map((r) => asReadableRun(r, file)),
		);
	}
	return { byFile: groupByFile(runs), unparsed, zeroed };
}

/**
 * @param {Record<string, unknown>} line
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function asReadableRun(line, file) {
	if (line.format === FORMAT) return line;
	const rows = Array.isArray(line.files) ? line.files : [];
	if (rows.some((r) => r && typeof r.file === "string")) return line;
	return {
		at: line.at,
		format: line.format,
		files: [buildVoidingRow(file)],
	};
}

/**
 * @param {Entry[]} entries
 * @param {Map<string, string|null>} now
 * @param {(row: Record<string, unknown>, run: Record<string, unknown>) => boolean} holds
 * @returns {Entry|undefined}
 */
function findDeciding(entries, now, holds) {
	let voided = false;
	return entries.find(({ row, run }) => {
		if (run.format === FORMAT)
			return holds(row, run) && (!voided || row.outcome === "fail");
		voided ||= row.outcome !== "pass" && !isOtherContent(row, run, now);
		return false;
	});
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} run
 * @param {Map<string, string|null>} now
 */
function isOtherContent(row, run, now) {
	return [row.inputs, run.shared].some((ids) =>
		Object.entries(asRecord(ids) ?? {}).some(([p, id]) => {
			const then = parseBlobId(id);
			const here = now.get(p);
			return (
				then !== null &&
				(here === ABSENT || (parseBlobId(here) ?? then) !== then)
			);
		}),
	);
}

/**
 * @param {unknown} id
 * @returns {string|null}
 */
const parseBlobId = (id) =>
	typeof id === "string" ? (BLOB_ID.exec(id)?.[1] ?? null) : null;

/**
 * @param {unknown} v
 * @returns {Record<string, unknown>|null}
 */
const asRecord = (v) =>
	v && typeof v === "object" && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: null;

/**
 * @param {Record<string, unknown>[]} runs
 * @returns {Map<string, Entry[]>}
 */
function groupByFile(runs) {
	/** @type {Map<string, Entry[]>} */
	const byFile = new Map();
	for (const run of runs)
		for (const row of Array.isArray(run.files) ? run.files : []) {
			if (!row || typeof row.file !== "string") continue;
			byFile.set(row.file, [...(byFile.get(row.file) ?? []), { row, run }]);
		}
	for (const list of byFile.values())
		list.sort((a, b) => String(b.run.at).localeCompare(String(a.run.at)));
	return byFile;
}

/**
 * @param {string} file
 * @param {Entry} held
 * @returns {Cached}
 */
const cachedFrom = (file, { row, run }) => ({
	file,
	source: {
		sha: String(run.sha),
		at: String(run.at),
		tree: typeof run.tree === "string" ? run.tree : null,
	},
	reads: readsOf({ row, run }),
});

/** @param {Entry} entry */
function readsOf({ row, run }) {
	const own = asIds(row.inputs);
	return [...new Set(entryReads({ row, run }))].filter(
		(p) => own?.get(p) !== ABSENT,
	);
}

/** @param {Entry} entry */
const entryReads = ({ row, run }) => [
	...inputPaths(row.inputs),
	...inputPaths(run.shared),
];

/** @param {unknown} v */
const inputPaths = (v) => Object.keys(asRecord(v) ?? {});

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} run
 * @param {{file: string, now: Map<string, string|null>,
 *   values: Values, reads: string[], tree: TreeAt}} at
 */
function isRowHolding(row, run, { file, now, values, reads, tree }) {
	if (run.format !== FORMAT) return false;
	const own = asIds(row.inputs);
	const shared = asIds(run.shared);
	if (!own || !shared) return false;
	const then = new Map([...shared, ...own]);
	if (row.voiding === true)
		return (
			row.outcome === "fail" &&
			(then.size === 0 || isSameContent([...then.keys()], then, now)) &&
			isTreeHolding(row, tree)
		);
	if (own.size === 0 || !own.has(file)) return false;
	const recordedValues = /** @type {Record<string, unknown>} */ (
		run.values ?? {}
	);
	const wanted = rowValues(
		"python" in recordedValues || holdsPython([...own.keys()]),
		values,
	);
	if (
		wanted === null ||
		Object.entries(wanted).some(([k, v]) => recordedValues[k] !== v)
	)
		return false;
	if (reads.some((p) => !then.has(p))) return false;
	return isSameContent([...then.keys()], then, now) && isTreeHolding(row, tree);
}

/**
 * @param {unknown} v
 * @returns {Map<string, string|null>|null}
 */
function asIds(v) {
	const ids = asRecord(v);
	if (!ids) return null;
	/** @type {[string, string][]} */
	const entries = [];
	for (const [p, id] of Object.entries(ids)) {
		if (typeof id !== "string") return null;
		entries.push([p, id]);
	}
	return new Map(entries);
}

/**
 * @param {Cached[]} cached
 * @param {number} [nowMs]
 * @returns {string}
 */
function buildCachedBanner(cached, nowMs = Date.now()) {
	if (cached.length === 0) return "";
	return `CACHED — ${cached.length} selected file(s) not run: a recorded pass attests each on identical inputs ${FRESH_HINT}:\n${cached
		.map(
			({ file, source }) =>
				`  ${file} — passed at ${shortSha(source.sha)}, ${age(nowMs - Date.parse(source.at))} ago\n`,
		)
		.join("")}`;
}

/** @param {number} ms */
function age(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m} min`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** @param {string[]} files */
const buildPragmaRefusal = (files) =>
	`\nUNCACHED PRAGMA WITH NO REASON — ${files.join(", ")}: \`uncached:\` keeps a file from ever being cached, and must say why, as \`uncached: <reason>\` (workflow-core#4790). Nothing ran.\n\n`;

/**
 * @param {Cached[]|null} cached
 * @param {string} file
 * @param {{write: (s: string) => unknown}} [err]
 * @returns {Record<string, string>|null}
 */
function writeCachedHandoff(cached, file, err = process.stderr) {
	if (cached === null) return null;
	try {
		fs.writeFileSync(file, JSON.stringify(cached));
		return { [CACHED_ENV]: file };
	} catch (e) {
		err.write(
			`pass-store.js: the cached files' hand-off was not written (${caught(e).message}), so this run's certificate leaves them out (workflow-core#4790)\n`,
		);
		return null;
	}
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {{write: (s: string) => unknown}} [err]
 * @returns {Cached[]|null}
 */
function readCachedHandoff(env = process.env, err = process.stderr) {
	const file = env[CACHED_ENV];
	if (!file) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (Array.isArray(parsed)) return parsed.filter(isCached);
		throw new Error("it holds no list");
	} catch (e) {
		err.write(
			`pass-store.js: the cached files' hand-off will not read (${caught(e).message}), so this run's certificate leaves them out (workflow-core#4790)\n`,
		);
		return null;
	}
}

/**
 * @param {unknown} c
 * @returns {c is Cached}
 */
const isCached = (c) => {
	const v = /** @type {Partial<Cached>|null} */ (c);
	return (
		typeof v?.file === "string" &&
		Array.isArray(v.reads) &&
		typeof v.source?.sha === "string" &&
		typeof v.source?.at === "string"
	);
};

/**
 * @template {import("./test-pass-marker.js").Attestation} A
 * @param {A} attestation
 * @param {Cached[]|null} cached
 * @returns {A}
 */
function foldCached(attestation, cached) {
	if (cached === null || attestation.closure === "*") return attestation;
	const closure = new Set(attestation.closure);
	const selected = new Set(attestation.selected ?? []);
	const imports = { ...(attestation.imports ?? {}) };
	for (const { file, reads } of cached) {
		selected.add(file);
		imports[file] = reads.filter((p) => p !== file).sort();
		for (const p of [file, ...reads]) closure.add(p);
	}
	return {
		...attestation,
		closure: [...closure].sort(),
		selected: [...selected].sort(),
		imports: Object.fromEntries(
			Object.entries(imports).sort(([a], [b]) => a.localeCompare(b)),
		),
		cached: cached.map(({ file, source }) => ({
			file,
			sha: source.sha,
			at: source.at,
		})),
	};
}

/**
 * @param {string[]} files
 * @param {{ storeRoot: string|null, sha: string, before: string,
 *   git: (args: string[]) => string, values?: Record<string, string> }} at
 * @returns {Map<string, {sha: string, at: string, red: boolean}>}
 */
function heldAtSha(files, { storeRoot, sha, before, git, values }) {
	/** @type {Map<string, {sha: string, at: string, red: boolean}>} */
	const held = new Map();
	if (!storeRoot || files.length === 0) return held;
	try {
		const { byFile, unparsed, zeroed } = readEntries(storeRoot, files);
		for (const file of files.filter(
			(f) => !unparsed.has(f) && !zeroed.has(f),
		)) {
			const hit = heldRow(file, byFile.get(file) ?? [], {
				sha,
				before,
				git,
				values: todayValues({ values }),
			});
			if (hit)
				held.set(file, {
					sha: String(hit.run.sha),
					at: String(hit.run.at),
					red: hit.row.outcome === "fail",
				});
		}
	} catch {
		return new Map();
	}
	return held;
}

/**
 * @param {string} file
 * @param {Entry[]} entries
 * @param {{ sha: string, before: string, git: (args: string[]) => string,
 *   values: Values }} at
 */
function heldRow(file, entries, { sha, before, git, values }) {
	const earlier = entries.filter(
		({ row, run }) =>
			String(run.at) < before &&
			(row.voiding !== true || run.format !== FORMAT),
	);
	const paths = [...new Set(earlier.flatMap(entryReads))];
	if (paths.length === 0) return;
	const now = absentAsId(readTreeIds(git, `${sha}^{tree}`, paths));
	const tree = buildCommitAt(git, sha);
	return findDeciding(earlier, now, (row, run) =>
		isRowHolding(row, run, { file, now, values, reads: [], tree }),
	);
}

module.exports = {
	isRowlessRun,
	heldAtSha,
	CACHED_ENV,
	foldCached,
	buildCachedBanner,
	buildPragmaRefusal,
	lookup,
	readCachedHandoff,
	record,
	writeCachedHandoff,
};
