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
 * stands for every tracked file and listing under it; a script a shell or
 * Python child ran is reached as a spawned script is.
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
 * holds no reads for, or doubts, records none; an input rewritten while the run ran, untracked, gitignored
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

const { spawnSync } = require("node:child_process");
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
const { isUnder, relativeUnder } = require("./is-under.js");
const {
	execGit,
	gitBinary,
	gitSpawnOptions,
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
	isFile,
	isScript,
	languageOf,
	pythonVersion,
	reachOf,
} = require("./code-edges.js");
const {
	ARCHIVE_MS,
	FRESH_HINT,
	readDocsByTest,
	shortSha,
} = require("./test-pass-marker.js");
const { readWorkingTree } = require("./test-read-edges.js");
const { listingId } = require("./listing-id.js");
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

/* The row layout: a run line of another, or none, never decides (#4814). */
const FORMAT = 8;

/* The environment key naming the cached hand-off file a vitest child reads. */
const CACHED_ENV = "WFC_PASS_STORE_CACHED";

/**
 * @typedef {"pass"|"fail"} Outcome
 * @typedef {{file: string, outcome: Outcome, imports: string[]}} FileResult
 * @typedef {{sha: string, at: string, tree: string|null, root: string,
 *   files: FileResult[], shared: string[], clean: boolean,
 *   drifted: string[]|null,
 *   audits: Map<string, import("./read-audit.js").Audit>|null}} Run
 *   `root` the tree vitest ran in, paths relative to it; `shared` the config
 *   file and its `setupFiles` closure; `clean` false where the run errored
 *   outside its files, was interrupted or filtered by name; `drifted` the
 *   paths rewritten while it ran, null where that is unknown; `audits` each
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
 * @typedef {{edges: string[], shadows: string[], python: boolean}} Reach
 *   repo-relative: the files reached, the paths a specifier on the way tried
 *   before the file it resolved to, and whether a file on the way runs inline
 *   Python
 * @typedef {Reach & {unknown: boolean}} FileReach one file's own: with
 *   whether it joins a path off its directory the walk cannot tell
 *   (lib/code-edges.js's `unknown`)
 */

/**
 * Every in-repo file `file` reaches through relative `require`s, imports and
 * `__dirname`-spelled spawns, transitively, read lexically off the working
 * tree at `root` (lib/code-edges.js): the edges vitest's module graph never
 * records, since this repo's tests reach their subjects through
 * `createRequire` and spawns. Memoised across the files of one run. Null
 * where any file on the way will not read, or joins a path off its own
 * directory the walk cannot tell: an input left unknown records no row. A
 * test file's own such join is excused (`ownReadsJudged`): the read audit
 * saw its reads.
 * @param {string} root
 * @returns {(file: string, ownReadsJudged?: boolean) => Reach|null} `file`
 *   left out of `edges`
 */
function lexicalReach(root) {
	/** @type {Map<string, FileReach|null>} */
	const memo = new Map();
	/** @param {string} rel */
	const readFrom = (rel) => {
		if (memo.has(rel)) return memo.get(rel) ?? null;
		const found = isScript(path.join(root, rel))
			? readEdges(root, rel)
			: { edges: [], shadows: [], python: false, unknown: false };
		memo.set(rel, found);
		return found;
	};
	/**
	 * `rel`'s own reach, null where it will not read or, its reads not
	 * `judged` by the selector, it joins a path the walk cannot tell.
	 * @param {string} rel
	 * @param {boolean} judged
	 */
	const reachFrom = (rel, judged) => {
		const found = readFrom(rel);
		return found?.unknown && !judged ? null : found;
	};
	return (file, ownReadsJudged = false) =>
		walkReach(file, (rel) => reachFrom(rel, ownReadsJudged && rel === file));
}

/**
 * The files `file` reaches, each file's own reach read by `reachOne`; null
 * where any is null.
 * @param {string} file
 * @param {(rel: string) => FileReach|null} reachOne
 * @returns {Reach|null} `file` left out of `edges`
 */
function walkReach(file, reachOne) {
	const seen = new Set([file]);
	/** @type {Set<string>} */
	const shadows = new Set();
	const queue = [file];
	let python = false;
	for (const rel of queue) {
		const found = reachOne(rel);
		if (!found) return null;
		python ||= found.python;
		for (const p of found.shadows) shadows.add(p);
		for (const next of found.edges)
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
	}
	seen.delete(file);
	return { edges: [...seen], shadows: [...shadows], python };
}

/**
 * The in-repo files `rel` names lexically, the paths its specifiers tried
 * before them, whether it runs inline Python and whether it joins a path
 * the walk cannot tell; or null where it will not read, faults, or holds a
 * load the walk cannot read.
 * @param {string} root
 * @param {string} rel
 * @returns {FileReach|null}
 */
function readEdges(root, rel) {
	const abs = path.join(root, rel);
	const read = readText(abs);
	if (read.state !== "read") return null;
	try {
		const reach = reachOf(abs, read.data, refuseFault);
		if (reach.unread.length > 0) return null;
		return {
			edges: repoRelative(
				root,
				[...reach.edges, ...reach.reads].filter(isFile),
			),
			shadows: repoRelative(root, reach.shadows),
			python: reach.python,
			unknown: reach.unknown.length > 0,
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

/* The variables that point git at a repository: a test's call ran with
 * none (vitest.setup.ts), so its run again does too. */
const GIT_DIR_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
];

/**
 * A git call run again at `root`: the id of its exit status and output.
 * Memoised, as many rows rest on one call. Null where its key will not
 * parse or the call will not run.
 * @param {string} root
 * @returns {(key: string) => string|null}
 */
function gitRunner(root) {
	/** @type {Map<string, string|null>} */
	const memo = new Map();
	const env = { ...process.env };
	for (const v of GIT_DIR_VARS) delete env[v];
	return (key) => {
		if (memo.has(key)) return memo.get(key) ?? null;
		let id = null;
		try {
			const { cwd, args } = JSON.parse(key);
			const r = spawnSync(
				gitBinary(),
				args,
				gitSpawnOptions({
					cwd: path.join(root, cwd),
					env,
					timeout: GIT_TIMEOUT_MS,
				}),
			);
			if (!r.error && r.status !== null)
				id = crypto
					.createHash("sha1")
					.update(`${r.status}\0`)
					.update(r.stdout)
					.digest("hex");
		} catch {
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
function workingAt(root) {
	return {
		git: gitRunner(root),
		listing: (dir) => {
			try {
				return listingId(fs.readdirSync(path.join(root, dir)));
			} catch {
				return null;
			}
		},
		isDir: (dir) => {
			try {
				return fs.statSync(path.join(root, dir)).isDirectory();
			} catch {
				return false;
			}
		},
	};
}

/**
 * What `treeish` holds beyond its files, read through `git`.
 * @param {(args: string[]) => string} git
 * @param {string} treeish
 * @returns {TreeAt}
 */
function commitAt(git, treeish) {
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
		/* A commit's tree runs no command: a row resting on one never holds there. */
		git: () => null,
	};
}

/**
 * Whether everything beyond its files a row rests on stands in `at` as it
 * did: each listing with its id, each probed directory a directory still,
 * each git call answering as it did.
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
 * test may rest on, since an untracked or ignored name is no input. Read
 * once, where a file first needs it.
 * @param {string} root
 * @returns {() => Map<string, Set<string>>}
 */
function trackedListings(root) {
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
 * The inputs a file's audited reads add: its files, absent paths and
 * probed directories, and each listing with its id, a tree walked whole
 * standing for every tracked file and listing under it. Null where a
 * listing the test made, or a tree it walked, held a name git does not
 * track: an untracked input records no row.
 * @param {import("./read-audit.js").Reads} reads
 * @param {() => Map<string, Set<string>>} listings
 * @param {TreeAt} working the working tree: its directories and git calls
 * @returns {{files: string[], absent: string[], dirs: string[],
 *   listings: Record<string, string>, git: Record<string, string>}|null}
 */
function auditInputs(reads, listings, working) {
	const lists = Object.entries(reads.lists);
	const tracked =
		lists.length + reads.trees.length > 0 ? listings() : new Map();
	const idOf = (/** @type {string} */ dir) =>
		listingId([...(tracked.get(dir) ?? [])]);
	/** @type {Record<string, string>} */
	const listed = {};
	for (const [dir, id] of lists) {
		if (idOf(dir) !== id) return null;
		listed[dir] = id;
	}
	const files = [...reads.files];
	for (const top of reads.trees) {
		const tree = treeInputs(top, tracked, working);
		if (!tree) return null;
		files.push(...tree.files);
		Object.assign(listed, tree.listings);
	}
	/** @type {Record<string, string>} */
	const git = {};
	for (const call of reads.git) {
		const key = JSON.stringify(call);
		const id = working.git(key);
		if (id === null) return null;
		git[key] = id;
	}
	return {
		files: [...new Set(files)],
		absent: reads.absent,
		dirs: reads.dirs,
		listings: listed,
		git,
	};
}

/**
 * What a tree walked or copied whole rests on: every tracked file under
 * `top`, or `top` itself where it is no tracked directory, and every tracked
 * directory's listing under it. Null where a listing on working holds a name
 * git does not track, which the walk saw.
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
 * One ran file's inputs, or null where any is unknown: its audit is missing
 * or in doubt, a listing it rests on holds an untracked name, or a file on
 * its reach will not read.
 * @param {FileResult} f
 * @param {{run: Run, reads: Map<string, string[]>,
 *   reach: (file: string, ownReadsJudged?: boolean) => Reach|null,
 *   listings: () => Map<string, Set<string>>, working: TreeAt}} ctx
 */
function fileInputs(f, { run, reads, reach, listings, working }) {
	const audit = run.audits?.get(f.file);
	if (!audit || !("reads" in audit)) return null;
	const seen = auditInputs(audit.reads, listings, working);
	if (!seen) return null;
	/* A script the manifest says the file reads is reached too, as it
	 * may spawn it: its own requires are inputs that no import and no
	 * `__dirname` join names. A read holding no script reaches none.
	 * The config and setup files run before every file, so what they
	 * reach, which vite's graph never records, is each file's too, as
	 * is what a script the audit saw a child run reaches. */
	const spawned = reads.get(f.file) ?? [];
	const reaches = [
		reach(f.file, true),
		...[...f.imports, ...spawned, ...run.shared, ...audit.reads.scripts].map(
			(p) => reach(p),
		),
	];
	if (reaches.includes(null)) return null;
	const reached = /** @type {Reach[]} */ (reaches);
	const paths = [
		...new Set([
			f.file,
			...f.imports,
			...reached.flatMap((r) => r.edges),
			...(reads.get(f.file) ?? []),
			...snapshotOf(run.root, f.file),
			...audit.reads.scripts,
			...seen.files,
		]),
	];
	const absent = [
		...new Set([...reached.flatMap((r) => r.shadows), ...seen.absent]),
	].filter((p) => !paths.includes(p));
	const python = reached.some((r) => r.python);
	if (!isTreeHolding(seen, working)) return null;
	return { ...f, paths, absent, python, seen };
}

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
		const listings = trackedListings(run.root);
		const working = workingAt(run.root);
		const own = files.flatMap((f) => {
			const found = fileInputs(f, { run, reads, reach, listings, working });
			return found ? [found] : [];
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
				const values = rowValues(
					f.python || holdsPython([...f.paths, ...f.absent]),
					today,
				);
				if (values === null) return [];
				const inputs = Object.fromEntries([
					...f.paths.map((p) => [p, ids.get(p)]),
					...f.absent.map((p) => [p, ABSENT]),
				]);
				const row = {
					file: f.file,
					outcome: f.outcome,
					inputs,
					listings: f.seen.listings,
					dirs: f.seen.dirs,
					git: f.seen.git,
				};
				return [{ values, row }];
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
	const dirs = workingAt(root);
	const cached = candidates.flatMap((file) => {
		if (unparsed.has(file)) return [];
		const held = (byFile.get(file) ?? []).find(({ row, run }) =>
			isRowHolding(row, run, {
				file,
				now,
				values,
				reads: reads.get(file) ?? [],
				dirs,
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
 *   values: Values, reads: string[], dirs: TreeAt}} at
 */
function isRowHolding(row, run, { file, now, values, reads, dirs }) {
	if (run.format !== FORMAT) return false;
	const own = asIds(row.inputs);
	const shared = asIds(run.shared);
	if (!own || !shared || own.size === 0 || !own.has(file)) return false;
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
	const then = new Map([...shared, ...own]);
	if (reads.some((p) => !then.has(p))) return false;
	return isSameContent([...then.keys()], then, now) && isTreeHolding(row, dirs);
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
	const dirs = commitAt(git, sha);
	return earlier.find(({ row, run }) =>
		isRowHolding(row, run, { file, now, values, reads: [], dirs }),
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
