/*
 * pass-store.js — the per-file pass store (#4790): every vitest run records
 * each file it ran with that file's outcome and the content of every input
 * its verdict rests on, and `npm run test` skips a file whose newest
 * recorded result on identical inputs is a pass.
 *
 * A FILE'S INPUTS are the file; its runtime import closure off vitest's
 * module graph, with every file it or that closure reaches through a relative
 * require, import or `__dirname`-spelled spawn, read lexically and transitively, since
 * the graph records no `createRequire` load; the documents the read-edge manifest maps to it, spawned
 * scripts' loads included (#1113); the Vitest config, its `setupFiles`
 * closure, `package.json` and the lockfiles; a snapshot file beside it; and,
 * as values, the Node version and the architecture, and python3's version
 * where its inputs hold a Python file. Each path a relative
 * specifier on the way tried before the file it resolved to is an input with
 * the id `absent` (#4814), so a file that appears there and takes the import
 * over voids the row. `globalSetup`'s closure
 * is in no row (#2818: it runs once, outside every file); a test that breaks only through it is the lander's to catch.
 *
 * THE LOOKUP IS BY CONTENT (lib/content-ids.js, the classifier's judge): the
 * newest result whose every input holds unchanged in the working tree
 * decides, a pass caching the file and a fail running it.
 *
 * EVERY DOUBT RUNS THE FILE. An unreadable store, tree or manifest gives
 * "run" with one notice, and a line that will not parse runs the files it
 * names; a row whose input list is missing or empty never matches; a run
 * that errored outside its files, was interrupted or filtered by name
 * records its failures alone; a spawned Python import the reach cannot
 * place, a JSX or TSX file on the reach, or a spawn on it of an interpreter
 * handed its program inline (lib/code-edges.js's `inlineCodeSpawns`), records
 * no row for the files it reaches; an input rewritten while the run ran, untracked, gitignored
 * or that will not read records none for the files it reaches: the drift
 * watch sees tracked paths alone, so an untracked or ignored one may hold
 * other content than the run read. A file whose header carries `uncached: <reason>`
 * is never cached; one carrying the pragma with no reason refuses the run.
 *
 * THE STORE is a directory beside the marker stores, in the canonical
 * checkout's `.claude/tmp/markers`, so every worktree shares it: one
 * append-only JSONL shard per test file, a line per run that ran it. A
 * lookup reads only the selected files' shards (#4792).
 * Each shard is appended, pruned and swept under its lock
 * (lib/retained-jsonl.js), on the pass-marker archive's retention. The lander's tester neither reads nor writes it.
 */

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
const { relativeUnder } = require("./is-under.js");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const {
	ABSENT,
	absentAsId,
	readTreeIds,
	readWorkingIds,
	isSameContent,
} = require("./content-ids.js");
const { caught } = require("./caught.js");
const {
	inlineCodeSpawns,
	isCodeFile,
	isFile,
	pythonVersion,
	reachOf,
} = require("./code-edges.js");
const {
	ARCHIVE_MS,
	readDocsByTest,
	shortSha,
} = require("./test-pass-marker.js");
const idSeam = require("./session-id.js");

const STORE = ".test-file-results";

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

/* The row layout: a run line of another, or none, never decides (#4814). */
const FORMAT = 4;

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
 * @typedef {{values?: Record<string, string>, lander?: boolean}} Seams
 *   `values` today's, python3's read off the machine where it names none
 * @typedef {{base: Record<string, string>, python: () => string|null}} Values
 *   today's: the node and arch every row rests on, and python3's version,
 *   read only for a row that rests on it, null where python3 will not answer
 */

/** @param {string} storeRoot the canonical checkout */
const storeDir = (storeRoot) => path.join(markersDir(storeRoot), STORE);

/**
 * The shard holding `file`'s rows: named by a hash of its path, so any path
 * makes one flat, safe file name. 16 hex digits are 64 bits: two of a repo's
 * few thousand test files share a shard with odds near 1 in 10^12.
 * @param {string} storeRoot
 * @param {string} file repo-relative
 */
const shardFile = (storeRoot, file) =>
	path.join(
		storeDir(storeRoot),
		`${crypto.createHash("sha256").update(file).digest("hex").slice(0, 16)}.jsonl`,
	);

/** @returns {Record<string, string>} */
const currentValues = () => ({ node: process.version, arch: process.arch });

/**
 * Today's values under `seams`.
 * @param {Seams} seams
 * @returns {Values}
 */
function todayValues(seams) {
	const { python, ...base } = seams.values ?? currentValues();
	return { base, python: () => python ?? readPythonVersion() };
}

/** python3's version, or null where it will not answer. */
function readPythonVersion() {
	try {
		return pythonVersion();
	} catch {
		return null;
	}
}

/**
 * The values a row with input paths `paths` rests on: a Python file among
 * them was walked against python3's stdlib and runs under python3, so its
 * version joins node and arch. Null where python3 will not answer.
 * @param {string[]} paths
 * @param {Values} today
 * @returns {Record<string, string>|null}
 */
function rowValues(paths, today) {
	if (!paths.some((p) => p.endsWith(".py"))) return today.base;
	const python = today.python();
	return python === null ? null : { ...today.base, python };
}

/**
 * Options for a git in `root` fed `input` on stdin.
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
 * `git hash-object --stdin-paths` in `root`.
 * @param {string} root
 * @returns {(args: string[], input: string) => string}
 */
const gitHasher = (root) => (args, input) =>
	String(execGit(args, stdinOptions(root, input)));

/**
 * Which of `paths` git ignores at `root`, or will not judge: a path through a
 * tracked symlink fails the whole call, so a failed call is asked again a path
 * at a time, and only the paths git refuses count. A tracked path is never
 * ignored.
 * @param {string} root
 * @param {string[]} paths
 * @returns {Set<string>}
 */
function readIgnored(root, paths) {
	const ask = (/** @type {string[]} */ some) => {
		try {
			return String(
				execGit(
					["check-ignore", "--stdin", "-z"],
					stdinOptions(root, some.map((p) => `${p}\0`).join("")),
				),
			)
				.split("\0")
				.filter(Boolean);
		} catch (e) {
			// 1: none of them is ignored.
			return caught(e).status === 1 ? [] : null;
		}
	};
	const all = ask(paths);
	if (all) return new Set(all);
	return new Set(paths.filter((p) => (ask([p])?.length ?? 1) > 0));
}

/**
 * The manifest at `root`'s documents for each of `files`. Throws where it
 * cannot be read or is malformed.
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

/* A Python import code-edges.js cannot place, such as a third-party package
 * or one found after a sys.path edit it cannot read, leaves the reach
 * unknown: the file records no row (#4790, #4864). Residual: a test spawning
 * such a script is never cached, and no notice says so. */
const refuseFault = (/** @type {string} */ why) => {
	throw new Error(why);
};

/**
 * @typedef {{edges: string[], shadows: string[]}} Reach repo-relative: the
 *   files reached, and the paths a specifier on the way tried before the file
 *   it resolved to
 */

/**
 * Every in-repo file `file` reaches through relative `require`s, imports and
 * `__dirname`-spelled spawns, transitively, read lexically off the working
 * tree at `root` (lib/code-edges.js): the edges vitest's module graph never
 * records, since this repo's tests reach their subjects through
 * `createRequire` and spawns. Memoised across the files of one run. Null
 * where any file on the way will not read: an input left unknown records no
 * row.
 * @param {string} root
 * @returns {(file: string) => Reach|null} `file` left out of `edges`
 */
function lexicalReach(root) {
	/** @type {Map<string, Reach|null>} */
	const memo = new Map();
	/** @param {string} rel */
	const reachFrom = (rel) => {
		if (memo.has(rel)) return memo.get(rel) ?? null;
		const found = isCodeFile(rel)
			? readEdges(root, rel)
			: { edges: [], shadows: [] };
		memo.set(rel, found);
		return found;
	};
	return (file) => {
		const seen = new Set([file]);
		/** @type {Set<string>} */
		const shadows = new Set();
		const queue = [file];
		for (const rel of queue) {
			const found = reachFrom(rel);
			if (!found) return null;
			for (const p of found.shadows) shadows.add(p);
			for (const next of found.edges)
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
		}
		seen.delete(file);
		return { edges: [...seen], shadows: [...shadows] };
	};
}

/**
 * The in-repo files `rel` names lexically and the paths its specifiers tried
 * before them, or null where it will not read, faults, or spawns inline code
 * whose loads no walk reads.
 * @param {string} root
 * @param {string} rel
 * @returns {Reach|null}
 */
function readEdges(root, rel) {
	const abs = path.join(root, rel);
	const read = readText(abs);
	if (read.state !== "read") return null;
	try {
		if (inlineCodeSpawns(abs, read.data).length > 0) return null;
		const { edges, shadows } = reachOf(abs, read.data, refuseFault);
		return {
			edges: repoRelative(root, edges.filter(isFile)),
			shadows: repoRelative(root, shadows),
		};
	} catch {
		return null;
	}
}

/**
 * `paths` under `root` and outside every `node_modules`, repo-relative.
 * @param {string} root
 * @param {string[]} paths absolute
 */
const repoRelative = (root, paths) =>
	paths.flatMap((e) => {
		const under = relativeUnder(root, e);
		if (!under) return [];
		const posix = under.split(path.sep).join("/");
		return posix.split("/").includes("node_modules") ? [] : [posix];
	});

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
 * Append one row per file `run` ran. A run that was not clean — filtered,
 * bailed, interrupted, or erred outside its files — records its failures
 * alone: its passes cannot be trusted, but a fail row only ever makes a file
 * run. Never throws: a store that cannot be written costs the rows, never the
 * run, and says why on `err`. Returns how many rows landed.
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
	if (seams.lander ?? idSeam.isLanderRun()) return 0;
	try {
		const reads = readManifestReads(
			run.root,
			files.map((f) => f.file),
		);
		const shared = sharedInputs(run.root, run.shared);
		const reach = lexicalReach(run.root);
		const own = files.flatMap((f) => {
			/* A script the manifest says the file spawns is reached too: its own
			 * requires are inputs that no import and no `__dirname` join names. */
			const spawned = (reads.get(f.file) ?? []).filter(isCodeFile);
			const reaches = [f.file, ...f.imports, ...spawned].map(reach);
			if (reaches.includes(null)) return [];
			const reached = /** @type {Reach[]} */ (reaches);
			const paths = [
				...new Set([
					f.file,
					...f.imports,
					...reached.flatMap((r) => r.edges),
					...(reads.get(f.file) ?? []),
					...snapshotOf(run.root, f.file),
				]),
			];
			const absent = [...new Set(reached.flatMap((r) => r.shadows))].filter(
				(p) => !paths.includes(p),
			);
			return [{ ...f, paths, absent }];
		});
		const all = [...shared, ...own.flatMap((f) => f.paths)];
		const ids = readWorkingIds(gitHasher(run.root), run.root, [
			...all,
			...own.flatMap((f) => f.absent),
		]);
		const ignored = readIgnored(run.root, [...new Set(all)]);
		const drifted = run.drifted === null ? null : new Set(run.drifted);
		const known = (/** @type {string[]} */ paths) =>
			drifted !== null &&
			paths.every(
				(p) =>
					typeof ids.get(p) === "string" && !drifted.has(p) && !ignored.has(p),
			);
		/* A path tried before the resolved file must read as no file: one that
		 * appeared since the reach was read, or a symlink, which no id answers,
		 * leaves the resolution the run used unknown. */
		const areAllAbsent = (/** @type {string[]} */ paths) =>
			paths.every((p) => ids.has(p) && ids.get(p) === null);
		if (!known(shared)) return 0;
		const today = todayValues(seams);
		const rows = own
			.filter((f) => known(f.paths) && areAllAbsent(f.absent))
			.flatMap((f) => {
				const values = rowValues([...f.paths, ...f.absent], today);
				if (values === null) return [];
				const inputs = Object.fromEntries([
					...f.paths.map((p) => [p, ids.get(p)]),
					...f.absent.map((p) => [p, ABSENT]),
				]);
				return [{ values, row: { file: f.file, outcome: f.outcome, inputs } }];
			});
		if (rows.length === 0) return 0;
		fs.mkdirSync(storeDir(storeRoot), { recursive: true });
		const line = {
			format: FORMAT,
			at: run.at,
			sha: run.sha,
			tree: run.tree,
			shared: Object.fromEntries(shared.map((p) => [p, ids.get(p)])),
		};
		const landed = rows.filter(({ values, row }) =>
			appendRetained(
				shardFile(storeRoot, row.file),
				{ ...line, values, files: [row] },
				ARCHIVE_MS,
				// The prune drops a line that will not parse, after which rows
				// older than it decide again, and it may have been a newer fail.
				{ dropOnBadLine: true },
			),
		).length;
		sweepOrSay(storeRoot, err);
		return landed;
	} catch (e) {
		err.write(
			`pass-store.js: no row recorded for this run (${caught(e).message ?? e}) (#4790)\n`,
		);
		return 0;
	}
}

/**
 * `sweepShards`, a fault said on `err`: the rows have landed by then, and a
 * failed sweep costs only disk.
 * @param {string} storeRoot
 * @param {{write: (s: string) => unknown}} err
 */
function sweepOrSay(storeRoot, err) {
	try {
		sweepShards(storeRoot);
	} catch (e) {
		err.write(
			`pass-store.js: stale shards not swept (${caught(e).message ?? e}) (#4790)\n`,
		);
	}
}

/**
 * Delete every shard untouched for a day past the retention: a test file
 * deleted or never run again leaves one, which no append would prune. The
 * day past the retention is the prune's own slack (lib/retained-jsonl.js), so
 * a shard goes no sooner than an append to it would have emptied it.
 * @param {string} storeRoot
 */
function sweepShards(storeRoot) {
	sweepRetained(storeDir(storeRoot), Date.now() - ARCHIVE_MS - DAY_MS);
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
 * Which of `files` a recorded pass attests on the working tree at `root`.
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
	let found;
	try {
		found = readCached(candidates, { root, storeRoot, ...seams });
	} catch (e) {
		return {
			...none,
			notice: `pass store: ${caught(e).message ?? e} — every selected file runs (#4790).`,
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

/**
 * @typedef {{row: Record<string, unknown>, run: Record<string, unknown>}} Entry
 *   one file's row and the run line holding it
 */

/**
 * The cached files among `candidates`. Throws, naming the cause, where the
 * store, the working tree or the manifest will not read; a line that will
 * not parse runs the files it names, with `notice` saying so.
 * @param {string[]} candidates
 * @param {{root: string, storeRoot: string} & Seams} options
 * @returns {{cached: Cached[], notice: string|null}}
 */
function readCached(candidates, { root, storeRoot, ...seams }) {
	const { byFile, unparsed } = readEntries(storeRoot, candidates);
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
	const cached = candidates.flatMap((file) => {
		if (unparsed.has(file)) return [];
		const held = (byFile.get(file) ?? []).find(({ row, run }) =>
			isRowHolding(row, run, {
				file,
				now,
				values,
				reads: reads.get(file) ?? [],
			}),
		);
		return held?.row.outcome === "pass" ? [cachedFrom(file, held)] : [];
	});
	const notice =
		unparsed.size > 0
			? `pass store: a line that would not parse names ${[...unparsed].join(", ")}, which run (#4790).`
			: null;
	return { cached, notice };
}

/**
 * Each candidate's recorded rows inside the retention, newest first, and the
 * candidates whose shard holds a line that will not parse: its lost row may
 * be the file's newest, so none of its older rows may decide. Throws where
 * the store will not read; an absent shard holds none.
 * @param {string} storeRoot
 * @param {string[]} candidates
 * @returns {{byFile: Map<string, Entry[]>, unparsed: Set<string>}}
 */
function readEntries(storeRoot, candidates) {
	/** @type {Record<string, unknown>[]} */
	const runs = [];
	/** @type {Set<string>} */
	const unparsed = new Set();
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
		/* A shard prunes only when appended, so a file left unrun keeps rows
		 * past the retention: none of them decides. */
		const since = Date.now() - ARCHIVE_MS;
		runs.push(
			...(read?.rows ?? []).filter((r) => Date.parse(String(r.at)) >= since),
		);
	}
	return { byFile: groupByFile(runs), unparsed };
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
	reads: readsOf({ row, run }),
});

/**
 * The paths a cached file's row read, its `absent` inputs left out: they are
 * no file, so no certificate reader judges them.
 * @param {Entry} entry
 */
function readsOf({ row, run }) {
	const own = asIds(row.inputs);
	return [...new Set(entryReads({ row, run }))].filter(
		(p) => own?.get(p) !== ABSENT,
	);
}

/**
 * A recorded row's input paths, its own and its run's shared ones.
 * @param {Entry} entry
 */
const entryReads = ({ row, run }) => [
	...inputPaths(row.inputs),
	...inputPaths(run.shared),
];

/** @param {unknown} v */
const inputPaths = (v) =>
	v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];

/**
 * Whether one recorded row's verdict holds now: its file is `file`, it
 * recorded a non-empty input list with every id unchanged, the values it
 * rests on equal today's, it is in this store's `FORMAT`, and every document the manifest now maps to the file is
 * among its inputs.
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} run
 * @param {{file: string, now: Map<string, string|null>,
 *   values: Values, reads: string[]}} at
 */
function isRowHolding(row, run, { file, now, values, reads }) {
	if (run.format !== FORMAT) return false;
	const own = asIds(row.inputs);
	const shared = asIds(run.shared);
	if (!own || !shared || own.size === 0 || !own.has(file)) return false;
	const recordedValues = /** @type {Record<string, unknown>} */ (
		run.values ?? {}
	);
	const wanted = rowValues([...own.keys()], values);
	if (
		wanted === null ||
		Object.entries(wanted).some(([k, v]) => recordedValues[k] !== v)
	)
		return false;
	const then = new Map([...shared, ...own]);
	if (reads.some((p) => !then.has(p))) return false;
	return isSameContent([...then.keys()], then, now);
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
	return `CACHED — ${cached.length} selected file(s) not run: a recorded pass attests each on identical inputs (#4790; \`--fresh\` runs them):\n${cached
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
 * Write the cached files a run that looked the store up carries for its
 * vitest child — none cached included, which the run's records count — and
 * the environment entry naming them. Null where the file cannot be written,
 * which leaves the cached files out of the certificate: the unattested
 * direction.
 * @param {Cached[]|null} cached null where the run looked nothing up
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
			`pass-store.js: the cached files' hand-off was not written (${caught(e).message}), so this run's certificate leaves them out (#4790)\n`,
		);
		return null;
	}
}

/**
 * The cached files the launcher handed this vitest child, or null where it
 * looked nothing up or the hand-off will not read.
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
			`pass-store.js: the cached files' hand-off will not read (${caught(e).message}), so this run's certificate leaves them out (#4790)\n`,
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
 * A narrowed run's attestation with its cached files folded in, each as a
 * selected test whose imports are the reads its source row held (#4790).
 * The certificate readers then judge a cached file by content against this
 * run's tree, as they judge one it ran: lookup found every one of those
 * reads unchanged in the tree this run read. A full run's, or one that looked nothing up, is returned as is.
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
 * Each of `files`' newest row, recorded before `before`, whose verdict holds
 * at `sha`'s tree by content under this machine's values: the per-file
 * evidence the already-red classifier reads beside the marker stores
 * (#4790). The manifest's reads at `sha` go unasked, the row's own inputs
 * standing for them. Empty on any fault.
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
		const { byFile, unparsed } = readEntries(storeRoot, files);
		for (const file of files.filter((f) => !unparsed.has(f))) {
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
 * The newest of `entries` before `before` that holds at `sha`'s tree.
 * @param {string} file
 * @param {Entry[]} entries newest first
 * @param {{ sha: string, before: string, git: (args: string[]) => string,
 *   values: Values }} at
 */
function heldRow(file, entries, { sha, before, git, values }) {
	const earlier = entries.filter(({ run }) => String(run.at) < before);
	const paths = [...new Set(earlier.flatMap(entryReads))];
	if (paths.length === 0) return;
	const now = absentAsId(readTreeIds(git, `${sha}^{tree}`, paths));
	return earlier.find(({ row, run }) =>
		isRowHolding(row, run, { file, now, values, reads: [] }),
	);
}

module.exports = {
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
