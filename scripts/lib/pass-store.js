/*
 * pass-store.js — the per-file pass store (#4790): every vitest run records
 * each file it ran with that file's outcome and the content of every input
 * its verdict rests on, and `npm run test` skips a file whose newest
 * recorded result on identical inputs is a pass. Bazel, Gradle and
 * Turborepo cache a test's result on a hash of its inputs the same way
 * (`docs/practice/test-and-ci-performance.md` §Cache test results by a hash
 * of their inputs).
 *
 * A FILE'S INPUTS are the file; its runtime import closure off vitest's
 * module graph, with every file it reaches through a relative require,
 * import or `__dirname`-spelled spawn, read lexically and transitively, since
 * the graph records no `createRequire` load; the documents the read-edge manifest maps to it, spawned
 * scripts' loads included (#1113); the Vitest config, its `setupFiles`
 * closure, `package.json` and the lockfiles; a snapshot file beside it; and,
 * as values, the Node version and the architecture. `globalSetup`'s closure
 * is in no row (#2818: it decided 85% of all misses and runs once, outside
 * every file); a test that breaks only through it is the lander's to catch.
 *
 * THE LOOKUP IS BY CONTENT (lib/content-ids.js, the classifier's judge): the
 * newest result whose every input holds unchanged in the working tree
 * decides, a pass caching the file and a fail running it. The manifest is
 * re-read at lookup, so a read it maps to the file now and the row never
 * recorded holds nothing.
 *
 * EVERY DOUBT RUNS THE FILE. An unreadable store, row, tree or manifest gives
 * "run" with one notice; a row whose input list is missing or empty never
 * matches; a run that errored outside its files, was interrupted or filtered
 * by name records no row; an input rewritten while the run ran records none
 * for the files it reaches. A file whose header carries `uncached: <reason>`
 * is never cached; one carrying the pragma with no reason refuses the run.
 *
 * THE STORE is one append-only JSONL beside the marker stores, in the
 * canonical checkout's `.claude/tmp/markers`, so every worktree shares it:
 * one line per run, holding a row per file it ran. Appended and pruned as
 * the run ledger is (lib/retained-jsonl.js), on the pass-marker archive's
 * retention. The lander's tester neither reads nor writes it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { markersDir } = require("./marker-root.js");
const { appendRetained } = require("./retained-jsonl.js");
const { readJsonl } = require("./jsonl.js");
const { gitBinary, gitSpawnOptions, GIT_TIMEOUT_MS } = require("./git.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { readWorkingIds, sameContent } = require("./content-ids.js");
const { caught } = require("./caught.js");
const { edgesOf } = require("./code-edges.js");
const {
	ARCHIVE_MS,
	EDGES_FILE,
	docsReadBy,
	shortSha,
} = require("./test-pass-marker.js");
const idSeam = require("./session-id.js");

const STORE = ".test-file-results.jsonl";

/* The paths every file's verdict rests on beside its own, where they exist. */
const PACKAGE_INPUTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
];

/* The header pragma: `uncached: <reason>`, a reason being a word. */
const PRAGMA = /\buncached:(.*)$/;
const PRAGMA_REASON = /^\s*\w/;

/* The environment key naming the cached hand-off file a vitest child reads. */
const CACHED_ENV = "WFC_PASS_STORE_CACHED";

/**
 * @typedef {"pass"|"fail"} Outcome
 * @typedef {{file: string, outcome: Outcome, imports: string[]}} FileResult
 * @typedef {{sha: string, at: string, tree: string|null, root: string,
 *   files: FileResult[], shared: string[], clean: boolean,
 *   drifted: string[]|null}} Run
 *   `root` the tree vitest ran in, paths relative to it; `shared` the config
 *   file and its `setupFiles` closure; `clean` false where the run errored
 *   outside its files, was interrupted or filtered by name; `drifted` the
 *   paths rewritten while it ran, null where that is unknown
 * @typedef {{sha: string, at: string, tree: string|null}} Source
 * @typedef {{file: string, source: Source, reads: string[]}} Cached
 *   `reads` the row's input paths, the file's own and the shared ones
 * @typedef {{cached: Cached[], run: string[], refused: string[],
 *   notice: string|null}} Lookup
 * @typedef {(args: string[], input: string) => string} HashObjects
 * @typedef {{hashObjects?: HashObjects, values?: Record<string, string>,
 *   lander?: boolean}} Seams
 */

/** @param {string} storeRoot the canonical checkout */
const storeFile = (storeRoot) => path.join(markersDir(storeRoot), STORE);

/** @returns {Record<string, string>} */
const currentValues = () => ({ node: process.version, arch: process.arch });

/**
 * `git hash-object --stdin-paths` in `root`.
 * @param {string} root
 * @returns {HashObjects}
 */
const gitHasher = (root) => (args, input) =>
	String(
		execFileSync(
			gitBinary(),
			args,
			gitSpawnOptions({
				cwd: root,
				input,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: CHILD_MAX_BUFFER,
			}),
		),
	);

/**
 * The manifest at `root`'s documents for each of `files`. Throws where it
 * cannot be read or is malformed.
 * @param {string} root
 * @param {string[]} files
 * @returns {Map<string, string[]>}
 */
function readManifestReads(root, files) {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(root, EDGES_FILE), "utf8"),
	);
	/** @type {Map<string, string[]>} */
	const reads = new Map();
	for (const file of files) {
		const docs = docsReadBy(manifest, new Set([file]));
		if (!docs) throw new Error(`${EDGES_FILE} is not {edges: {doc: [test]}}`);
		reads.set(file, [...docs].sort());
	}
	return reads;
}

/**
 * A snapshot file beside `file` where one stands, in vitest's default place.
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

/* A foreign Python module bounds no edge of the reach's. */
const ignoreFault = () => undefined;

/* A file whose lexical edges the reach follows: code a test loads or spawns. */
const FOLLOWED = /\.(?:[cm]?[jt]sx?|sh)$/;

/**
 * Every in-repo file `file` reaches through relative `require`s, imports and
 * `__dirname`-spelled spawns, transitively, read lexically off the working
 * tree at `root` (lib/code-edges.js): the edges vitest's module graph never
 * records, since this repo's tests reach their subjects through
 * `createRequire` and spawns. Memoised across the files of one run.
 * @param {string} root
 * @returns {(file: string) => string[]} repo-relative, `file` left out
 */
function lexicalReach(root) {
	/** @type {Map<string, string[]>} */
	const edges = new Map();
	/** @param {string} rel */
	const edgesFrom = (rel) => {
		const hit = edges.get(rel);
		if (hit) return hit;
		const abs = path.join(root, rel);
		/** @type {string[]} */
		let found = [];
		if (FOLLOWED.test(rel))
			try {
				found = edgesOf(abs, fs.readFileSync(abs, "utf8"), ignoreFault)
					.map((e) => path.relative(root, e).split(path.sep).join("/"))
					.filter(
						(e) =>
							!e.startsWith("..") &&
							!path.isAbsolute(e) &&
							!e.split("/").includes("node_modules") &&
							fs
								.statSync(path.join(root, e), { throwIfNoEntry: false })
								?.isFile(),
					);
			} catch {
				found = [];
			}
		edges.set(rel, found);
		return found;
	};
	return (file) => {
		const seen = new Set([file]);
		const queue = [file];
		while (queue.length > 0)
			for (const next of edgesFrom(/** @type {string} */ (queue.shift())))
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
		seen.delete(file);
		return [...seen];
	};
}

/**
 * The input paths beside every file's own: the run's shared inputs and the
 * package files that exist at `root`.
 * @param {string} root
 * @param {string[]} shared
 */
const sharedInputs = (root, shared) => [
	...new Set([
		...shared,
		...PACKAGE_INPUTS.filter((p) => fs.existsSync(path.join(root, p))),
	]),
];

/**
 * Append one row per file `run` ran. Never throws: a store that cannot be
 * written costs the rows, never the run. Returns how many rows landed.
 * @param {Run} run
 * @param {{storeRoot: string|null} & Seams} options
 * @returns {number}
 */
function record(run, { storeRoot, ...seams }) {
	if (!storeRoot || !run.clean || run.files.length === 0) return 0;
	if (seams.lander ?? idSeam.isLanderRun()) return 0;
	try {
		const reads = readManifestReads(
			run.root,
			run.files.map((f) => f.file),
		);
		const shared = sharedInputs(run.root, run.shared);
		const reach = lexicalReach(run.root);
		const own = run.files.map((f) => ({
			...f,
			paths: [
				...new Set([
					f.file,
					...f.imports,
					...reach(f.file),
					...(reads.get(f.file) ?? []),
					...snapshotOf(run.root, f.file),
				]),
			],
		}));
		const ids = readWorkingIds(
			seams.hashObjects ?? gitHasher(run.root),
			run.root,
			[...shared, ...own.flatMap((f) => f.paths)],
		);
		const drifted = run.drifted === null ? null : new Set(run.drifted);
		const known = (/** @type {string[]} */ paths) =>
			drifted !== null &&
			paths.every((p) => typeof ids.get(p) === "string" && !drifted.has(p));
		if (!known(shared)) return 0;
		const rows = own
			.filter((f) => known(f.paths))
			.map((f) => ({
				file: f.file,
				outcome: f.outcome,
				inputs: Object.fromEntries(f.paths.map((p) => [p, ids.get(p)])),
			}));
		if (rows.length === 0) return 0;
		const landed = appendRetained(
			storeFile(storeRoot),
			{
				at: run.at,
				sha: run.sha,
				tree: run.tree,
				values: seams.values ?? currentValues(),
				shared: Object.fromEntries(shared.map((p) => [p, ids.get(p)])),
				files: rows,
			},
			ARCHIVE_MS,
		);
		return landed ? rows.length : 0;
	} catch {
		return 0;
	}
}

/**
 * The pragma in `file`'s header — its leading comment lines — at `root`:
 * `none`, `reasoned`, or `bare` where it names no reason. An unreadable file
 * reads as reasoned, which runs it.
 * @param {string} root
 * @param {string} file
 * @returns {"none"|"reasoned"|"bare"}
 */
function readPragma(root, file) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, file), "utf8");
	} catch {
		return "reasoned";
	}
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t && !/^(?:\/\/|\/\*|\*|#!)/.test(t)) break;
		const m = PRAGMA.exec(t);
		if (m) return PRAGMA_REASON.test(m[1] ?? "") ? "reasoned" : "bare";
	}
	return "none";
}

/**
 * Which of `files` a recorded pass covers on the working tree at `root`.
 * Never throws: every fault runs the files it reaches and says so once.
 * @param {string[]} files repo-relative test files, in plan order
 * @param {{root: string, storeRoot: string|null} & Seams} options
 * @returns {Lookup}
 */
function lookup(files, { root, storeRoot, ...seams }) {
	/** @type {Lookup} */
	const none = { cached: [], run: [...files], refused: [], notice: null };
	if (files.length === 0 || !storeRoot) return none;
	if (seams.lander ?? idSeam.isLanderRun()) return none;
	const pragmas = new Map(files.map((f) => [f, readPragma(root, f)]));
	const refused = files.filter((f) => pragmas.get(f) === "bare");
	if (refused.length > 0) return { ...none, refused };
	const candidates = files.filter((f) => pragmas.get(f) === "none");
	if (candidates.length === 0) return none;
	let cached;
	try {
		cached = readCached(candidates, { root, storeRoot, ...seams });
	} catch (e) {
		return {
			...none,
			notice: `pass store: ${caught(e).message ?? e} — every selected file runs (#4790).`,
		};
	}
	const hit = new Set(cached.map((c) => c.file));
	return { ...none, cached, run: files.filter((f) => !hit.has(f)) };
}

/**
 * @typedef {{row: Record<string, unknown>, run: Record<string, unknown>}} Entry
 *   one file's row and the run line holding it
 */

/**
 * The cached files among `candidates`. Throws, naming the cause, where the
 * store, a row, the working tree or the manifest will not read.
 * @param {string[]} candidates
 * @param {{root: string, storeRoot: string} & Seams} options
 * @returns {Cached[]}
 */
function readCached(candidates, { root, storeRoot, ...seams }) {
	const byFile = readEntries(storeRoot, candidates);
	const wanted = new Set(
		[...byFile.values()]
			.flat()
			.flatMap(({ row, run }) => [
				...inputPaths(row.inputs),
				...inputPaths(run.shared),
			]),
	);
	let now;
	let reads;
	try {
		now = readWorkingIds(seams.hashObjects ?? gitHasher(root), root, [
			...wanted,
		]);
		reads = readManifestReads(root, candidates);
	} catch (e) {
		throw new Error(
			`the working tree could not be read (${caught(e).message ?? e})`,
			{ cause: e },
		);
	}
	const values = seams.values ?? currentValues();
	return candidates.flatMap((file) => {
		const held = (byFile.get(file) ?? []).find(({ row, run }) =>
			holds(row, run, { file, now, values, reads: reads.get(file) ?? [] }),
		);
		return held?.row.outcome === "pass" ? [cachedFrom(file, held)] : [];
	});
}

/**
 * Each candidate's recorded rows, newest first. Throws where the store will
 * not read or a line naming a candidate will not parse; an absent store
 * holds none.
 * @param {string} storeRoot
 * @param {string[]} candidates
 * @returns {Map<string, Entry[]>}
 */
function readEntries(storeRoot, candidates) {
	const keys = candidates.map((f) => `"file":${JSON.stringify(f)}`);
	let read;
	try {
		read = readJsonl(storeFile(storeRoot), (line) =>
			keys.some((k) => line.includes(k)),
		);
	} catch (e) {
		throw new Error(`the store could not be read (${caught(e).message ?? e})`, {
			cause: e,
		});
	}
	if (read && read.bad.length > 0)
		throw new Error(`${read.bad.length} store line(s) would not parse`);
	return groupByFile(read?.rows ?? []);
}

/**
 * The store's run lines turned into each file's rows, newest first.
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
	reads: [...new Set([...inputPaths(row.inputs), ...inputPaths(run.shared)])],
});

/** @param {unknown} v */
const inputPaths = (v) =>
	v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];

/**
 * Whether one recorded row's verdict holds now: its file is `file`, it
 * recorded a non-empty input list with every id unchanged, the run's values
 * equal today's, and every document the manifest now maps to the file is
 * among its inputs.
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} run
 * @param {{file: string, now: Map<string, string|null>,
 *   values: Record<string, string>, reads: string[]}} at
 */
function holds(row, run, { file, now, values, reads }) {
	const own = asIds(row.inputs);
	const shared = asIds(run.shared);
	if (!own || !shared || own.size === 0 || !own.has(file)) return false;
	const recordedValues = /** @type {Record<string, unknown>} */ (
		run.values ?? {}
	);
	if (Object.entries(values).some(([k, v]) => recordedValues[k] !== v))
		return false;
	const then = new Map([...shared, ...own]);
	if (reads.some((p) => !then.has(p))) return false;
	return sameContent([...then.keys()], then, now);
}

/**
 * @param {unknown} v
 * @returns {Map<string, string|null>|null} null where `v` is no path-to-id map
 */
function asIds(v) {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const entries = Object.entries(v);
	if (entries.some(([, id]) => typeof id !== "string")) return null;
	return new Map(entries);
}

/**
 * The banner lines naming each cached file with the run it came from.
 * @param {Cached[]} cached
 * @param {number} [nowMs]
 * @returns {string}
 */
function buildCachedBanner(cached, nowMs = Date.now()) {
	if (cached.length === 0) return "";
	return `CACHED — ${cached.length} selected file(s) not run: a recorded pass covers each on identical inputs (#4790; \`--no-cache\` runs them):\n${cached
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

/**
 * The refusal for files whose `uncached:` pragma names no reason.
 * @param {string[]} files
 */
const buildPragmaRefusal = (files) =>
	`\nUNCACHED PRAGMA WITH NO REASON — ${files.join(", ")}: \`uncached:\` keeps a file from ever being cached, and must say why, as \`uncached: <reason>\` (#4790). Nothing ran.\n\n`;

/**
 * Write the cached files a run carries for its vitest child, and the
 * environment entry naming them. Null where none are cached or the file
 * cannot be written, which leaves the cached files out of the certificate:
 * the unattested direction.
 * @param {Cached[]} cached
 * @param {string} [file]
 * @returns {Record<string, string>|null}
 */
function writeCachedHandoff(
	cached,
	file = path.join(os.tmpdir(), `wfc-cached-${process.pid}.json`),
) {
	if (cached.length === 0) return null;
	try {
		fs.writeFileSync(file, JSON.stringify(cached));
		return { [CACHED_ENV]: file };
	} catch {
		return null;
	}
}

/**
 * The cached files the launcher handed this vitest child; none where it
 * handed none or the hand-off will not read.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Cached[]}
 */
function readCachedHandoff(env = process.env) {
	const file = env[CACHED_ENV];
	if (!file) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(parsed)
			? parsed.filter(
					(c) =>
						c &&
						typeof c.file === "string" &&
						Array.isArray(c.reads) &&
						c.source &&
						typeof c.source.sha === "string",
				)
			: [];
	} catch {
		return [];
	}
}

module.exports = {
	CACHED_ENV,
	STORE,
	buildCachedBanner,
	buildPragmaRefusal,
	lookup,
	readCachedHandoff,
	record,
	storeFile,
	writeCachedHandoff,
};
