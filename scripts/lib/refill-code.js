/*
 * refill-code.js — the code the refill loop runs (#2361): a detached worktree
 * the loop owns per sha of the verified ref (lib/landing-refs.js's
 * VERIFIED_REF), under loopFiles()'s code directory: lib/pinned-code.js's
 * first instance.
 *
 * Only a loop whose scripts sit in a git checkout does this. A plugin install
 * has none.
 *
 * THE CLOSURE a tip must change to be adopted: every module the loop has
 * loaded, and everything under scripts/ bar the tests. The second stands in
 * for the scripts the loop spawns each tick, whose own requires and sourced
 * files (dispatch-sessions.sh's) no static reading follows.
 *
 * ADOPTION checks the tip out into its own worktree, has a child node require
 * the new program, and only on its exit 0 calls process.execve: same pid, so
 * the pidfile stays held, and no exit handler runs to release it. Any failure
 * leaves the running image as it was, and that sha is not tried again.
 *
 * THE BOOT LINK (#3891): a symlink beside the code directory to the worktree
 * the loop last ran, which the boot unit starts from, as a restart can leave
 * the checkout's working copy mid-edit. Nothing removes the worktree it names:
 * an image moves it first, and a refused tip's removal spares it.
 *
 * A WORKTREE A LIVE PROCESS RUNS FROM is kept until it exits (#4548): a queue
 * lander or levelling pass an older image started spawns its children from
 * its own worktree, and they fail to load where that is gone.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isUnder } = require("./is-under.js");
const { readProcCwd } = require("./claude-sessions.js");
const { procRoot } = require("./proc-root.js");
const { readProcTable } = require("./proc-table.js");
const {
	PROGRAM,
	PROGRAM_NAME,
	bootLinkOf,
	bootLinkProgram,
	readRunningProgram,
} = require("./refill-control-code.js");
const {
	LOAD_TIMEOUT_MS,
	checkoutOf,
	fetchVerified,
	git,
	pointLink,
	readLink,
	readVerifiedSha,
	removeWorktree,
	short,
	whyOf,
	worktreeAt,
} = require("./pinned-code.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { isTestKind } = require("./test-kind.js");

/** @param {string} program a loop program's path @returns {string} its checkout's root */
const rootOf = (program) => path.dirname(path.dirname(program));

/**
 * @param {string} repo
 * @param {string} codeDir
 */
const instance = (repo, codeDir) => ({ repo, codeDir, program: PROGRAM });

/**
 * Null where the program at `dir` loads, else why not.
 * @param {string} dir
 */
function loadFailure(dir) {
	const r = spawnSync(
		process.execPath,
		["-e", "require(process.argv[1])", path.join(dir, PROGRAM)],
		{
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
			timeout: LOAD_TIMEOUT_MS,
		},
	);
	if (r.status === 0) return null;
	return r.error ? r.error.message : `exit ${r.status}, ${whyOf(r)}`;
}

/**
 * Whether `from..to` changes a file of the closure.
 * @param {string} repo
 * @param {string} from
 * @param {string} to
 * @param {Set<string>} loaded the loop's loaded modules, relative to its root
 */
function closureChanged(repo, from, to, loaded) {
	return git(repo, ["diff", "--name-only", "--no-renames", from, to])
		.split("\n")
		.some((f) => loaded.has(f) || (isUnder(f, ["scripts"]) && !isTestKind(f)));
}

/**
 * `scriptsDir`'s checkout; else its own program, a plugin install; or why git
 * would not say.
 * @param {string} scriptsDir
 * @returns {{repo: string}|{program: string}|{error: string}}
 */
function locateCode(scriptsDir) {
	try {
		const repo = checkoutOf(scriptsDir);
		return repo === null
			? { program: path.join(scriptsDir, PROGRAM_NAME) }
			: { repo };
	} catch (err) {
		return { error: `git would not read ${scriptsDir}: ${whyOf(err)}` };
	}
}

/**
 * The program `start` spawns `run` from: the verified tip's worktree, fetched
 * first and shown to load, where `scriptsDir` is in a checkout; else
 * `scriptsDir`'s own.
 * @param {{scriptsDir: string, codeDir: string}} where
 * @returns {{program: string, fetchError?: string|null}|{error: string}}
 */
function launchProgram({ scriptsDir, codeDir }) {
	const found = locateCode(scriptsDir);
	if (!("repo" in found)) return found;
	const { repo } = found;
	const fetchError = fetchVerified(repo);
	const sha = readVerifiedSha(repo);
	if (sha === null)
		return {
			error: `no ${VERIFIED_REF} in ${repo}${fetchError ? ` (fetch: ${fetchError})` : ""}`,
		};
	let dir;
	try {
		dir = worktreeAt(instance(repo, codeDir), sha);
	} catch (err) {
		return { error: `no worktree at ${short(sha)}: ${whyOf(err)}` };
	}
	const why = loadFailure(dir);
	if (why !== null)
		return { error: `${short(sha)}'s program does not load: ${why}` };
	return { program: path.join(dir, PROGRAM), fetchError };
}

/**
 * `dir` with symlinks resolved, as node resolves the running program's path;
 * `dir` itself where it does not exist.
 * @param {string} dir
 */
function realPathOf(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		// No code directory: an image outside it, which the comparison then finds.
		return dir;
	}
}

/**
 * The program a boot unit names: its own in a plugin install; else through the
 * boot link, which outlives any tip the loop adopts. A link that resolves stays
 * as it is, a running loop's own to move.
 * @param {{scriptsDir: string, codeDir: string}} where
 * @returns {{program: string, fetchError?: string|null}|{error: string}}
 */
function bootProgram({ scriptsDir, codeDir }) {
	const found = locateCode(scriptsDir);
	if (!("repo" in found)) return found;
	const program = bootLinkProgram(codeDir);
	if (fs.existsSync(program)) return { program };
	const launch = launchProgram({ scriptsDir, codeDir });
	if ("error" in launch) return launch;
	const root = rootOf(launch.program);
	try {
		pointLink(bootLinkOf(codeDir), root);
	} catch (err) {
		return { error: `no boot link to ${root}: ${whyOf(err)}` };
	}
	return { program, fetchError: launch.fetchError };
}

/**
 * What `status` names as the code the loop at `pid` runs: the sha its program
 * is checked out at, and the directory where it is not one of `codeDir`'s;
 * null where its command line will not read.
 * @param {number} pid
 * @param {string} codeDir
 */
function readRunningCode(pid, codeDir) {
	try {
		const program = readRunningProgram(pid);
		if (program === null) return null;
		const root = rootOf(program);
		if (checkoutOf(root) === null) return "a plugin install";
		const sha = short(git(root, ["rev-parse", "HEAD"]));
		return path.dirname(root) === codeDir ? sha : `${sha} in ${root}`;
	} catch {
		// A process unreadable or a git read failed mid-status: nothing to name.
		return null;
	}
}

/**
 * Each of `stale` a live process other than this one runs from, mapped to its
 * pid: its cwd, or a path its command line names resolved against that cwd,
 * sits in it, spelt through the real code directory or through `codeDir`.
 * Null where /proc will not be read, which keeps them all.
 * Residual: a process holding a tree only through a module it loaded or a
 * file it holds open, with neither its cwd nor an argument there (`node -e
 * "require(…)"`), holds none; so does one whose cwd will not read, another
 * user's.
 * @param {string[]} stale real paths, each a child of the code directory
 * @param {string} codeDir
 * @returns {Map<string, number>|null}
 */
function readHeldDirs(stale, codeDir) {
	const table = readProcTable(procRoot());
	if (table === null || (table.listed > 0 && table.unreadable === table.listed))
		return null;
	/** @type {Map<string, number>} */
	const held = new Map();
	for (const { pid, argv } of table.procs.values()) {
		if (pid === process.pid) continue;
		const cwd = readProcCwd(String(pid));
		if (cwd === null) continue;
		const paths = [cwd, ...argv.map((a) => path.resolve(cwd, a))];
		for (const dir of stale) {
			const spellings = [dir, path.join(codeDir, path.basename(dir))];
			if (!held.has(dir) && paths.some((p) => isUnder(p, spellings, path.sep)))
				held.set(dir, pid);
		}
	}
	return held;
}

/**
 * Remove every worktree in the code directory but `root` and those a live
 * process runs from, logging each of those once; true where none was kept.
 * @param {{root: string, codeDir: string, realCodeDir: string,
 *   kept: Set<string>, log: (line: string) => void}} o `kept` accumulator:
 *   the directories already logged as kept
 */
function pruneCodeDir({ root, codeDir, realCodeDir, kept, log }) {
	const stale = fs
		.readdirSync(realCodeDir)
		.map((name) => path.join(realCodeDir, name))
		.filter((dir) => dir !== root);
	if (stale.length === 0) return true;
	const held = readHeldDirs(stale, codeDir);
	if (held === null) {
		if (!kept.has(realCodeDir))
			log(`keeping every worktree in ${realCodeDir}: /proc will not read`);
		kept.add(realCodeDir);
		return false;
	}
	for (const dir of stale) {
		const pid = held.get(dir);
		if (pid === undefined) removeWorktree(root, dir);
		else if (!kept.has(dir)) {
			kept.add(dir);
			log(`keeping ${dir} while pid ${pid} runs from it`);
		}
	}
	return held.size === 0;
}

/**
 * process.execve, missing from the Node types this repo pins; it returns only
 * by throwing.
 * @typedef {(file: string, args: string[], env: NodeJS.ProcessEnv) => void} Exec
 */
const proc = /** @type {NodeJS.Process & {execve: Exec}} */ (process);

/**
 * The running loop's updater, or null where its program is in no checkout or
 * git would not say, which it logs.
 * @param {{program: string, codeDir: string, log: (line: string) => void}} opts
 */
function codeUpdater({ program, codeDir, log }) {
	const root = rootOf(program);
	let running;
	try {
		if (checkoutOf(root) === null) return null;
		running = git(root, ["rev-parse", "HEAD"]);
	} catch (err) {
		log(`code update off: git would not read ${root}, ${whyOf(err)}`);
		return null;
	}
	/** @type {string|null} */
	let refused = null;
	/** @type {string|null} */
	let fetchFailed = null;
	let linked = false;
	let settled = false;
	/** @type {Set<string>} */
	const kept = new Set();

	const loaded = () =>
		new Set(
			Object.keys(require.cache)
				.filter((f) => isUnder(f, [root], path.sep))
				.map((f) => path.relative(root, f).split(path.sep).join("/")),
		);

	/** The fetched tip where it is new, not refused, and changes the closure. */
	const newTip = () => {
		const fetchError = fetchVerified(root);
		if (fetchError !== null && fetchError !== fetchFailed)
			log(
				`code update: fetching ${VERIFIED_REF} failed, ${fetchError}; running ${short(running)}`,
			);
		fetchFailed = fetchError;
		const tip = readVerifiedSha(root);
		if (tip === null || tip === running || tip === refused) return null;
		return closureChanged(root, running, tip, loaded()) ? tip : null;
	};

	/** @param {string} tip */
	const adopt = (tip) => {
		/** @type {string|null} */
		let dir = null;
		try {
			dir = worktreeAt(instance(root, codeDir), tip);
			const why = loadFailure(dir);
			if (why !== null) throw new Error(`its program does not load: ${why}`);
			log(`adopting ${short(running)}..${short(tip)}`);
			proc.execve(
				process.execPath,
				[
					process.execPath,
					...process.execArgv,
					path.join(dir, PROGRAM),
					...process.argv.slice(2),
				],
				process.env,
			);
		} catch (err) {
			refused = tip;
			log(
				`not adopting ${short(tip)}: ${whyOf(err)}; running ${short(running)}`,
			);
			if (dir !== null && dir !== readLink(bootLinkOf(codeDir)))
				removeWorktree(root, dir);
		}
	};

	return {
		/**
		 * Fetch the verified ref and adopt its tip where it changes the
		 * closure, unless `hold`: a gate sweep or review runner the loop
		 * started still runs, or a stop is pending.
		 * @param {{hold: boolean}} opts
		 */
		adoptIfMoved({ hold }) {
			const tip = hold ? null : newTip();
			if (tip !== null) adopt(tip);
		},
		/**
		 * After the first tick of an image from the code directory, point the
		 * boot link at it; then, each tick until none is left, remove every
		 * worktree there but its own and those a live process runs from. A
		 * link that will not move keeps the worktree it names.
		 */
		afterTick() {
			if (settled) return;
			const realCodeDir = realPathOf(codeDir);
			if (path.dirname(root) !== realCodeDir) {
				settled = true;
				return;
			}
			if (!linked) {
				try {
					pointLink(bootLinkOf(codeDir), root);
				} catch (err) {
					settled = true;
					log(`boot link not moved to ${root}: ${whyOf(err)}`);
					return;
				}
				linked = true;
			}
			settled = pruneCodeDir({ root, codeDir, realCodeDir, kept, log });
		},
	};
}

module.exports = {
	bootProgram,
	codeUpdater,
	launchProgram,
	readRunningCode,
};
