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
	readSpare,
	readVerifiedSha,
	removeWorktree,
	reregister,
	short,
	whyOf,
	worktreeAt,
} = require("./pinned-code.js");
const { readRegistrationFault } = require("./git-file.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { isTestKind } = require("./test-kind.js");

/**
 * @param {string} program
 * @returns {string}
 */
const rootOf = (program) => path.dirname(path.dirname(program));

/**
 * @param {string} repo
 * @param {string} codeDir
 * @param {(line: string) => void} log
 */
const instance = (repo, codeDir, log) => ({
	repo,
	codeDir,
	program: PROGRAM,
	log,
});

/** @param {string} line */
const toStderr = (line) => process.stderr.write(`${line}\n`);

/** @param {string} dir */
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
 * @param {string} repo
 * @param {string} from
 * @param {string} to
 * @param {Set<string>} loaded
 */
function closureChanged(repo, from, to, loaded) {
	return git(repo, ["diff", "--name-only", "--no-renames", from, to])
		.split("\n")
		.some((f) => loaded.has(f) || (isUnder(f, ["scripts"]) && !isTestKind(f)));
}

/**
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
 * @param {{scriptsDir: string, codeDir: string, log?: (line: string) => void}} where
 * @returns {{program: string, fetchError?: string|null}|{error: string}}
 */
function launchProgram({ scriptsDir, codeDir, log = toStderr }) {
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
		dir = worktreeAt(
			instance(repo, codeDir, log),
			sha,
			readKeptWorktrees(codeDir),
		);
	} catch (err) {
		return { error: `no worktree at ${short(sha)}: ${whyOf(err)}` };
	}
	const why = loadFailure(dir);
	if (why !== null)
		return { error: `${short(sha)}'s program does not load: ${why}` };
	return { program: path.join(dir, PROGRAM), fetchError };
}

/** @param {string} dir */
function realPathOf(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * @param {{scriptsDir: string, codeDir: string, log?: (line: string) => void}} where
 * @returns {{program: string, fetchError?: string|null}|{error: string}}
 */
function bootProgram({ scriptsDir, codeDir, log = toStderr }) {
	const found = locateCode(scriptsDir);
	if (!("repo" in found)) return found;
	const program = bootLinkProgram(codeDir);
	if (fs.existsSync(program)) return { program };
	const launch = launchProgram({ scriptsDir, codeDir, log });
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
 * @param {number} pid
 * @param {string} codeDir
 */
function readRunningCode(pid, codeDir) {
	try {
		const program = readRunningProgram(pid);
		if (program === null) return null;
		const root = rootOf(program);
		if (path.dirname(root) === codeDir) return short(path.basename(root));
		if (checkoutOf(root) === null) return "a plugin install";
		return `${short(git(root, ["rev-parse", "HEAD"]))} in ${root}`;
	} catch {
		return null;
	}
}

/**
 * @param {string[]} stale
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
 * @param {string} codeDir
 * @param {string|null} [own]
 * @returns {Array<string|null>|null}
 */
function readKeptWorktrees(codeDir, own = null) {
	const realCodeDir = realPathOf(codeDir);
	const keep = [own, readLink(bootLinkOf(codeDir))];
	let names;
	try {
		names = fs.readdirSync(realCodeDir);
	} catch {
		return keep;
	}
	const held = readHeldDirs(
		names.map((n) => path.join(realCodeDir, n)),
		codeDir,
	);
	return held === null ? null : [...keep, ...held.keys()];
}

/**
 * @param {{root: string, codeDir: string, realCodeDir: string,
 *   kept: Set<string>, log: (line: string) => void}} o
 */
function pruneCodeDir({ root, codeDir, realCodeDir, kept, log }) {
	const others = fs
		.readdirSync(realCodeDir)
		.map((name) => path.join(realCodeDir, name))
		.filter((dir) => dir !== root);
	if (others.length === 0) return true;
	const held = readHeldDirs(others, codeDir);
	if (held === null) {
		if (!kept.has(realCodeDir))
			log(`keeping every worktree in ${realCodeDir}: /proc will not read`);
		kept.add(realCodeDir);
		return false;
	}
	const spare = readSpare({ codeDir: realCodeDir, program: PROGRAM }, [
		root,
		...held.keys(),
	]);
	for (const dir of others.filter((d) => d !== spare)) {
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
 * @param {string} root
 * @param {string} codeDir
 * @param {(line: string) => void} log
 * @returns {() => void}
 */
function registrationKeeper(root, codeDir, log) {
	if (path.dirname(root) !== realPathOf(codeDir)) return () => undefined;
	/** @type {string|null} */
	let failed = null;
	return () => {
		const fault = readRegistrationFault(root);
		if (fault === null) return;
		try {
			reregister(root, path.basename(root));
			failed = null;
			log(`registered ${root} with git again: ${fault}`);
		} catch (err) {
			const line = `${root} is not registered with git (${fault}), and registering it again failed: ${whyOf(err)}`;
			if (line !== failed) log(line);
			failed = line;
		}
	};
}

/** @typedef {(file: string, args: string[], env: NodeJS.ProcessEnv) => void} Exec */
const proc = /** @type {NodeJS.Process & {execve: Exec}} */ (process);

/** @param {{program: string, codeDir: string, log: (line: string) => void}} opts */
function codeUpdater({ program, codeDir, log }) {
	const root = rootOf(program);
	const keepRegistered = registrationKeeper(root, codeDir, log);
	keepRegistered();
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
			dir = worktreeAt(
				instance(root, codeDir, log),
				tip,
				readKeptWorktrees(codeDir, root),
			);
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
		/** @param {{hold: boolean}} opts */
		adoptIfMoved({ hold }) {
			const tip = hold ? null : newTip();
			if (tip !== null) adopt(tip);
		},
		afterTick() {
			keepRegistered();
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
