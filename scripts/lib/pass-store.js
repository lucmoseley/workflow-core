/*
 * pass-store.js — the per-file pass store (#4790): every vitest run records
 * each file it ran with that file's outcome and the content of every input
 * its verdict rests on, and `npm run test` skips a file whose newest
 * recorded result on identical inputs is a pass.
 *
 * A FILE'S INPUTS are the file; its runtime import closure off vitest's
 * module graph, with every file it or that closure reaches through a relative
 * require, import, `__dirname`-spelled spawn or read, or declared load,
 * read lexically and transitively, since
 * the graph records no `createRequire` load; the documents the read-edge manifest maps to it, spawned
 * scripts' loads included (#1113); the Vitest config, its `setupFiles`
 * closure and what those reach lexically, as the git shim the setup puts on
 * every test's `PATH`; `package.json`, the lockfiles, `tsconfig.json` and
 * `.claude/workflow-core.json`, which the setup exports to every test; a snapshot file beside it; and,
 * as values, the Node version and the architecture, and python3's version
 * where its inputs hold a Python file or a file on its reach runs Python
 * inline. Each path a relative
 * specifier on the way tried before the file it resolved to is an input with
 * the id `absent` (#4814), so a file that appears there and takes the import
 * over voids the row. `globalSetup`'s closure
 * is in no row (#2818: it runs once, outside every file); a test that breaks only through it is the lander's to catch.
 *
 * AND WHAT THE READ AUDIT SAW IT READ (lib/read-audit.js, #4916): a path built
 * at run time — a helper's default root, a listing of the live tree — that no
 * lexical rule can find. Each file it read or probed is an input; each path it
 * found absent is `absent`; each directory it found must still be one; each
 * directory it listed keeps its listing's id, judged on the names git tracks
 * when recorded and on the names standing at lookup; a tree it walked whole
 * stands for every tracked file and listing under it; a script a shell
 * child ran is reached as a spawned script is.
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
 * place, a JSX or TSX file on the reach, or a load on it the walk cannot
 * read (lib/code-edges.js's `unread`: an inline program's, a JS load of no
 * literal, or a shell load spelled off anything but the script's own
 * directory), or a join off a file's own directory naming a file the walk
 * cannot tell (its `unknown`), records no row for the files it reaches,
 * a test file's own such join aside, which its audit saw; a file the audit
 * holds no reads for, or doubts, records none; an input rewritten while the run ran, or changed and put back since it began (#5018), untracked, gitignored
 * or that will not read records none for the files it reaches: the drift
 * watch sees tracked paths alone, so an untracked or ignored one may hold
 * other content than the run read. A FAILED file that would record none
 * records a voiding row, resting on each of its inputs whose content as the
 * run read it is known: a fail wherever those stand as they did, whatever
 * the rest hold, so no older pass on what may be the same content caches,
 * and no evidence of a red at a commit. A file whose header carries `uncached: <reason>`
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
const { isUnder } = require("./is-under.js");
const { isSteadyUnder, readSteady } = require("./run-steadiness.js");
const {
	execGit,
	spawnGitSync,
	GIT_DIR_VARS,
	GIT_TIMEOUT_MS,
} = require("./git.js");
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
	isScript,
	languageOf,
	pythonVersion,
	readRunReach,
} = require("./code-edges.js");
const {
	ARCHIVE_MS,
	FRESH_HINT,
	readDocsByTest,
	shortSha,
} = require("./test-pass-marker.js");
const { readWorkingTree } = require("./test-read-edges.js");
const { listingId } = require("./listing-id.js");
const { pathKind } = require("./path-kind.js");
const idSeam = require("./session-id.js");

const STORE = ".test-file-results";

/* The paths every file's verdict rests on beside its own, where they exist:
 * the package files; `tsconfig.json`, which vite's transform reads for every
 * file; and `.claude/workflow-core.json`, which vitest.setup.ts reads through
 * `readConfig` off a root no walk reads, and exports to every test as
 * `WFC_ALWAYS_LOADED` and `WFC_OUTPUT_STYLE`. */
const RUN_INPUTS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"tsconfig.json",
	".claude/workflow-core.json",
];

/* The header pragma: `uncached: <reason>`, a reason being a word. */
const PRAGMA = /\buncached:(.*)$/;
const PRAGMA_REASON = /^\s*\w/;

/* The row layout: a run line of another, or none, never caches (#4814),
 * though its red still voids an older pass (#4995). */
const FORMAT = 19;

/* A content id as every layout since #4814 writes it: a mode and a blob id. */
const BLOB_ID = /^\d{6} ([0-9a-f]{40}|[0-9a-f]{64})$/;

/* The environment key naming the cached hand-off file a vitest child reads. */
const CACHED_ENV = "WFC_PASS_STORE_CACHED";

/**
 * @typedef {"pass"|"fail"} Outcome
 * @typedef {{file: string, outcome: Outcome, imports: string[]}} FileResult
 * @typedef {{sha: string, at: string, tree: string|null, root: string,
 *   files: FileResult[], shared: string[], clean: boolean,
 *   steadiness: import("./run-steadiness.js").Steadiness|null,
 *   audits: Map<string, import("./read-audit.js").Audit>|null}} Run
 *   `root` the tree vitest ran in, paths relative to it; `shared` the config
 *   file and its `setupFiles` closure; `clean` false where the run errored
 *   outside its files, was interrupted or filtered by name; `steadiness`
 *   what its tree watch saw (lib/run-steadiness.js), null where none
 *   watched; `audits` each
 *   file's reads as the read audit saw them (lib/read-audit.js), null where
 *   the run was not audited
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
		// No python3 that answers is no version: a row that would rest on
		// one is not recorded, and none recorded under one holds (#4790).
		return null;
	}
}

/**
 * The values a row rests on: one whose reach holds a Python file, walked
 * against python3's stdlib, or runs inline Python, runs under python3, so
 * its version joins node and arch. Null where python3 will not answer.
 * @param {boolean} runsPython
 * @param {Values} today
 * @returns {Record<string, string>|null}
 */
function rowValues(runsPython, today) {
	if (!runsPython) return today.base;
	const python = today.python();
	return python === null ? null : { ...today.base, python };
}

/**
 * Whether `paths` hold a Python file.
 * @param {string[]} paths
 */
const holdsPython = (paths) => paths.some((p) => languageOf(p) === "python");

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

/**
 * @typedef {{edges: string[], shadows: string[], python: boolean}} Reach
 *   repo-relative: the files reached, the paths a specifier on the way tried
 *   before the file it resolved to, and whether a file on the way runs inline
 *   Python
 */

/**
 * Every in-repo file `file` reaches, transitively, read lexically off the
 * working tree at `root` (lib/code-edges.js's `readRunReach`): the edges
 * vitest's module graph never records, since this repo's tests reach their
 * subjects through `createRequire` and spawns. Memoised across the files of
 * one run. Null where the reach is unknown, which records no row (#4790,
 * #4864): a file on the way will not read, faults, holds a load the walk
 * cannot read or joins a path off its own directory it cannot tell, or
 * `file` is a script that is gone. A test file's own such join is excused
 * (`ownReadsJudged`): the read audit saw its reads. Residual: a test
 * spawning a script with such a Python import, as a third-party package, is
 * never cached, and no notice says so.
 * @param {string} root
 * @returns {(file: string, ownReadsJudged?: boolean) => Reach|null} `file`
 *   left out of `edges`
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
			// A file on the way that will not read leaves the reach unknown:
			// no row is recorded for a file reaching it (#4790).
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
 * The input paths beside every file's own: the run's shared inputs and the
 * `RUN_INPUTS` that exist at `root`.
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
 *   what a tree answers beyond its files: each directory's listing id, null
 *   where none stands; whether one stands; and a git call's output id, by its
 *   key (lib/read-audit.js's `GitCall` as JSON, the key a row stores), null
 *   where it cannot run
 */

/**
 * A git call run again at `root`: the id of its exit status and output.
 * Memoised, as many rows rest on one call. Null where its key will not
 * parse or the call will not run.
 * @param {string} root
 * @returns {(key: string) => string|null}
 */
function buildGitRunner(root) {
	/** @type {Map<string, string|null>} */
	const memo = new Map();
	/* A test's call ran with no variable pointing git at a repository
	 * (vitest.setup.ts), so its run again does too. */
	const env = { ...process.env };
	for (const v of GIT_DIR_VARS) delete env[v];
	return (key) => {
		if (memo.has(key)) return memo.get(key) ?? null;
		let id = null;
		try {
			const { cwd, args } = JSON.parse(key);
			const r = spawnGitSync(args, {
				cwd: path.join(root, cwd),
				env,
				timeout: GIT_TIMEOUT_MS,
			});
			if (!r.error && r.status !== null)
				id = `${r.status}:${crypto.createHash("sha1").update(r.stdout).digest("hex")}`;
		} catch {
			// A key that will not parse is a call that cannot run: no id, so
			// the row resting on it is not recorded and never holds (#4916).
			id = null;
		}
		memo.set(key, id);
		return id;
	};
}

/**
 * The working tree at `root`, beyond its files.
 * @param {string} root
 * @returns {TreeAt}
 */
function buildWorkingAt(root) {
	return {
		git: buildGitRunner(root),
		listing: (dir) => {
			try {
				return listingId(fs.readdirSync(path.join(root, dir)));
			} catch {
				// No directory to list is no listing: a row resting on one
				// there never holds (#4916).
				return null;
			}
		},
		isDir: (dir) => pathKind(path.join(root, dir)) === "dir",
	};
}

/**
 * What `treeish` holds beyond its files, read through `git`.
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
			// A path the commit holds no tree at, or a git that will not
			// answer, is no directory there: the row never holds (#4916).
			return null;
		}
	};
	return {
		listing: (dir) => {
			const found = names(dir);
			return found === null ? null : listingId(found);
		},
		isDir: (dir) => names(dir) !== null,
		/* A commit's tree runs no command: a row resting on one never holds there. */
		git: () => null,
	};
}

/**
 * Whether everything beyond its files a row rests on stands in `at` as it
 * did.
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
 * Each tracked directory's names at `root`, off git's index: the listing a
 * test may rest on, since an untracked or ignored name is no input.
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
 * The inputs a file's audited reads add. Null where a listing the test
 * made, or a tree it walked, held a name git does not track, a path under a
 * tree it walked moved while the run ran, or a git call it made answers
 * other than it did for the test.
 * @param {import("./read-audit.js").Reads} reads
 * @param {() => Map<string, Set<string>>} listings
 * @param {TreeAt} working the working tree: its directories and git calls
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
		const key = JSON.stringify({ cwd, args });
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
 * What a tree walked or copied whole rests on: every tracked file under
 * `top`, or `top` itself where it is no tracked directory, and every tracked
 * directory's listing under it. Null where a listing on working holds a name
 * git does not track.
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
 *   what a file's audit saw it rest on beyond files, each as the working
 *   tree answered it once the run ended: `logged` the listings the test
 *   made, each under the id it got, `listings` those and every listing of a
 *   tree it walked, and each git call's answer, run again
 * @typedef {Reach & {from: string}} Reached the reach of the path `from`
 * @typedef {FileResult & {direct: string[], reached: Reached[],
 *   probed: string[], seen: Seen|null, whole: boolean}} Gathered
 *   one ran file's inputs as far as they can be told: `direct` the paths
 *   named for it outright, `reached` each reach that read whole, `probed`
 *   the paths its audit found absent, `seen` null where its audit is missing,
 *   in doubt or rests on a listing holding an untracked name; `whole` false
 *   where any of it is unknown
 */

/**
 * One ran file's inputs, as far as they can be told.
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
	/* A script the manifest says the file reads is reached too, as it
	 * may spawn it: its own requires are inputs that no import and no
	 * `__dirname` join names. A read holding no script reaches none.
	 * The config and setup files run before every file, so what they
	 * reach, which vite's graph never records, is each file's too. */
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
 *   one file's verdict and what it rests on, as its shard line carries it
 * @typedef {{values: Record<string, string>, shared: Record<string, unknown>,
 *   row: Row}} Recorded
 *   one file's row with the values and shared inputs its run line carries
 * @typedef {{gathered: Gathered[], shared: string[],
 *   ids: Map<string, string|null>, steady: import("./run-steadiness.js").Steady,
 *   isKnown: (p: string) => boolean, isAbsent: (p: string) => boolean}} RunInputs
 *   a run's inputs as read off the tree once it ended: each file's, the
 *   shared ones, every path's content id, the run's steadiness asked once
 *   those were read, and whether a path's content as the run read it is
 *   known, or known to be none
 */

/**
 * The inputs of each of `files` and of the run, with what the tree tells of
 * each path. Throws where the tree or the manifest will not read.
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
	/* Asked after the ids, so a change before they were read is seen (#5018). */
	const steady = readSteady(run.steadiness, run.root, tried);
	const { isSteady } = steady;
	return {
		gathered,
		shared,
		ids,
		steady,
		isKnown: (p) => isSteady(p) && typeof ids.get(p) === "string",
		/* A path tried before the resolved file must read as no file: one that
		 * appeared since the reach was read, or a symlink, which no id answers,
		 * leaves the resolution the run used unknown, as does one that held a
		 * file while the run ran and is gone now. */
		isAbsent: (p) => isSteady(p) && ids.has(p) && ids.get(p) === null,
	};
}

/**
 * `paths` with each one's content id.
 * @param {string[]} paths
 * @param {Map<string, string|null>} ids
 */
const idsOf = (paths, ids) =>
	Object.fromEntries(paths.map((p) => [p, ids.get(p)]));

/**
 * The row of each file whose every input is known.
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
 * A failed file's voiding row, resting on `keyed`: the inputs, logged
 * listings and directories it names, and nothing where it names none.
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
 * A voiding row for each of `failed`, the failed files no known row holds:
 * a red whose inputs are unknown still voids an older pass (#4790). Its row
 * keys every input whose content as the run read it is known, and leaves
 * the rest unkeyed, so it decides wherever those stand as they did,
 * whatever the rest hold. A file reached only through one whose content is
 * unknown is unkeyed too, the run's reach being that file's as it then
 * stood. Beyond files it keys only what the audit logged
 * as the test got it, a listing it made and a directory it found: a git
 * call's answer and a walked tree's listings are read once the run ended,
 * and one that moved since the test read it would key the row off the
 * content the red ran on.
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
		/* Where the watch did not see the run through, nothing says what the
		 * audit logged beyond files stood so while the run ran. */
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
 * A voiding row for each of `failed` where the tree would not read: it keys
 * nothing, and decides at any content (#4790).
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
 * A run's rows off its inputs: each file's known row, and a voiding row for
 * each failed file that has none. Where the tree moved after the run's end
 * snapshot, every id was read off content no test saw, so it keys no row
 * and its failures void unkeyed.
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

/**
 * Append one row per file `run` ran. A run that was not clean — filtered,
 * bailed, interrupted, or erred outside its files — records its failures
 * alone: its passes cannot be trusted, but a fail row only ever makes a file
 * run. Never throws: a store that cannot be written costs the rows, never
 * the run, and says why on `err`. Returns how many rows landed.
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
	/** @type {RunInputs|null} */
	let inputs = null;
	try {
		inputs = readRunInputs(run, files);
	} catch (e) {
		err.write(
			`pass-store.js: this run's inputs will not read (${caught(e).message ?? e}), so it records no pass (#4790)\n`,
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
	const tree = buildWorkingAt(root);
	const cached = candidates.flatMap((file) => {
		if (unparsed.has(file)) return [];
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
			...(read?.rows ?? [])
				.filter((r) => Date.parse(String(r.at)) >= since)
				.map((r) => asReadableRun(r, file)),
		);
	}
	return { byFile: groupByFile(runs), unparsed };
}

/**
 * A line of another layout naming no row `groupByFile` can read stands as a
 * red on unknown inputs of `file`, whose shard holds it: its outcome may have
 * been a fail (#4995).
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
 * The row of this layout that decides its file among `entries`: the newest
 * that `holds`, or, behind a red of another layout no input proves was on
 * other content, the newest that holds and failed. That red's layout is one
 * this checkout cannot fully read, so it never decides a verdict itself, but
 * no pass older than it stands (#4995).
 * @param {Entry[]} entries newest first
 * @param {Map<string, string|null>} now each read path's content id here
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
 * Whether some input a row of another layout keys held other content than
 * it does `now`: a blob id that differs, or a file that has gone since. A
 * mode alone, an id of any other shape, or a path the row found absent
 * proves nothing: layouts up to 10 recorded as absent a path the run may yet
 * have read.
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
 * @returns {string|null} the blob id, null where `id` names none
 */
const parseBlobId = (id) =>
	typeof id === "string" ? (BLOB_ID.exec(id)?.[1] ?? null) : null;

/**
 * @param {unknown} v
 * @returns {Record<string, unknown>|null} null where `v` is no plain object
 */
const asRecord = (v) =>
	v && typeof v === "object" && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: null;

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
const inputPaths = (v) => Object.keys(asRecord(v) ?? {});

/**
 * Whether one recorded row's verdict holds now: its file is `file`, it
 * recorded a non-empty input list with every id unchanged, the values it
 * rests on equal today's, it is in this store's `FORMAT`, and every document the manifest now maps to the file is
 * among its inputs. A voiding row, which only ever records a
 * fail, holds wherever every input it keyed stands as recorded, the file's
 * own among them or not.
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
 * @returns {Map<string, string|null>|null} null where `v` is no path-to-id map
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
 * The banner lines naming each cached file with the run it came from.
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
		// A store or a commit that will not read is no evidence of a red at
		// `sha`: the classifier is left the marker stores alone (#4790).
		return new Map();
	}
	return held;
}

/**
 * The row of `entries` before `before` that decides at `sha`'s tree.
 * @param {string} file
 * @param {Entry[]} entries newest first
 * @param {{ sha: string, before: string, git: (args: string[]) => string,
 *   values: Values }} at
 */
function heldRow(file, entries, { sha, before, git, values }) {
	/* A voiding row of this layout says what its file's content failed on
	 * beside unknown inputs: no evidence of a red at a commit. Another
	 * layout's only ever voids an older pass. */
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
