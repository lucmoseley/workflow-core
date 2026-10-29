/*
 * refill-code.js — the code the refill loop runs (#2361): a detached worktree
 * the loop owns per sha of the verified ref (lib/landing-refs.js's
 * VERIFIED_REF), under loopFiles()'s code directory.
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
 */

const { spawnSync } = require("node:child_process");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { commitSha } = require("./commit-sha.js");
const { isUnder } = require("./is-under.js");
const { procRoot } = require("./proc-root.js");
const {
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");
const { isTestKind } = require("./test-kind.js");

const PROGRAM_NAME = "refill-loop.js";
const PROGRAM = path.join("scripts", PROGRAM_NAME);
/* Untraced: git log --oneline's width in this repo, unique across its
 * history, so a logged sha can be pasted into git as it is. */
const SHA_SHOWN = 9;
/* Untraced: a fetch over a slow link, and a cold node start requiring the
 * loop's libs at the machine's worst load. */
const FETCH_TIMEOUT_MS = 120 * 1000;
const LOAD_TIMEOUT_MS = 60 * 1000;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeout]
 */
const git = (cwd, args, timeout = GIT_TIMEOUT_MS) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	}).trim();

/** @param {string} sha */
const short = (sha) => sha.slice(0, SHA_SHOWN);

/**
 * A failure's one telling line: an Error line in its stderr, else its last.
 * @param {unknown} err
 */
function whyOf(err) {
	const e = caught(err);
	const text = (e.stderr ?? "").trim() || e.message;
	const lines = text.split("\n").filter((l) => l.trim());
	return (lines.find((l) => /^\S*Error\b/.test(l)) ?? lines.pop() ?? "").trim();
}

/**
 * `dir` where it sits in a git checkout, every git call below running from
 * there; else null, a plugin install. Not hostRoot(): the checkout asked
 * about is the loop's code's, never the host's.
 * @param {string} dir
 * @throws where git itself fails, which is no answer either way
 */
function checkoutOf(dir) {
	try {
		return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true"
			? dir
			: null;
	} catch (err) {
		if (/not a git repository/.test(caught(err).stderr ?? "")) return null;
		throw err;
	}
}

/** @param {string} program a loop program's path @returns {string} its checkout's root */
const rootOf = (program) => path.dirname(path.dirname(program));

/**
 * Fetch the verified ref into `repo`: null, or why it failed. FETCH_HEAD is
 * left alone, being shared with every session in the checkout.
 * @param {string} repo
 */
function fetchVerified(repo) {
	try {
		git(
			repo,
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				REMOTE,
				trackingRefspec(VERIFIED_BRANCH),
			],
			FETCH_TIMEOUT_MS,
		);
		return null;
	} catch (err) {
		return whyOf(err);
	}
}

/**
 * The verified ref's sha as `repo` last fetched it, or null.
 * @param {string} repo
 */
const readVerifiedSha = (repo) => commitSha(repo, VERIFIED_REF);

/**
 * The worktree at `sha` in `codeDir`, checked out where it is not yet.
 * @param {string} repo
 * @param {string} codeDir
 * @param {string} sha
 */
function worktreeAt(repo, codeDir, sha) {
	const dir = path.join(codeDir, sha);
	if (fs.existsSync(path.join(dir, PROGRAM))) return dir;
	/* A checkout a kill cut short: --force takes over its registration. */
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(codeDir, { recursive: true });
	git(repo, ["worktree", "add", "--force", "--detach", dir, sha]);
	return dir;
}

/**
 * @param {string} repo
 * @param {string} dir
 */
function removeWorktree(repo, dir) {
	try {
		git(repo, ["worktree", "remove", "--force", dir]);
	} catch {
		/* A directory git no longer registers, or a half-made one: removed by
		 * hand, the registration left to the next `git worktree prune`. */
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

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
 * The program `start` spawns `run` from: the verified tip's worktree, fetched
 * first, where `scriptsDir` is in a checkout; else `scriptsDir`'s own.
 * @param {{scriptsDir: string, codeDir: string}} where
 * @returns {{program: string, fetchError?: string|null}|{error: string}}
 */
function launchProgram({ scriptsDir, codeDir }) {
	let repo;
	try {
		repo = checkoutOf(scriptsDir);
	} catch (err) {
		return { error: `git would not read ${scriptsDir}: ${whyOf(err)}` };
	}
	if (repo === null) return { program: path.join(scriptsDir, PROGRAM_NAME) };
	const fetchError = fetchVerified(repo);
	const sha = readVerifiedSha(repo);
	if (sha === null)
		return {
			error: `no ${VERIFIED_REF} in ${repo}${fetchError ? ` (fetch: ${fetchError})` : ""}`,
		};
	try {
		return {
			program: path.join(worktreeAt(repo, codeDir, sha), PROGRAM),
			fetchError,
		};
	} catch (err) {
		return { error: `no worktree at ${short(sha)}: ${whyOf(err)}` };
	}
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
		const args = fs
			.readFileSync(`${procRoot()}/${pid}/cmdline`, "utf8")
			.split("\0");
		const arg = args.find((a) => path.basename(a) === PROGRAM_NAME);
		if (!arg) return null;
		const root = rootOf(
			path.resolve(fs.readlinkSync(`${procRoot()}/${pid}/cwd`), arg),
		);
		if (checkoutOf(root) === null) return "a plugin install";
		const sha = short(git(root, ["rev-parse", "HEAD"]));
		return path.dirname(root) === codeDir ? sha : `${sha} in ${root}`;
	} catch {
		// A process gone or a git read failed mid-status: nothing to name.
		return null;
	}
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
	let pruned = false;

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
			dir = worktreeAt(root, codeDir, tip);
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
			if (dir !== null) removeWorktree(root, dir);
		}
	};

	return {
		/**
		 * Fetch the verified ref and adopt its tip where it changes the
		 * closure, unless `hold`: a gate sweep the loop started still runs, or
		 * a stop is pending.
		 * @param {{hold: boolean}} opts
		 */
		adoptIfMoved({ hold }) {
			const tip = hold ? null : newTip();
			if (tip !== null) adopt(tip);
		},
		/**
		 * After the image's first tick, remove every worktree in the code
		 * directory but its own.
		 */
		afterTick() {
			if (pruned) return;
			pruned = true;
			let names;
			try {
				names = fs.readdirSync(codeDir);
			} catch {
				// No code directory: a loop started outside one, nothing to prune.
				return;
			}
			for (const name of names) {
				const dir = path.join(codeDir, name);
				if (dir !== root) removeWorktree(root, dir);
			}
		},
	};
}

module.exports = { codeUpdater, launchProgram, readRunningCode, SHA_SHOWN };
