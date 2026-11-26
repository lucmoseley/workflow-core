#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const {
	execGit,
	gitBinary,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { shellQuote } = require("./sh-quote.js");
const { caught, ignoreFailure, orFallback } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { writeFd } = require("./write-fd.js");
const { readConfig } = require("./workflow-core-config.js");
const { WORKTREES } = require("./worktree-dirs.js");
const { withMergeParents } = require("./merge-heads.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

const ISOLATED_PREFIX = "isolated-";

const SHARED_ARTEFACTS = ["node_modules"];

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readLinkedPaths(dir) {
	const declared = orFallback(
		() => readConfig({ root: dir, quiet: true }).worktreeLinks,
		undefined,
	);
	return [...SHARED_ARTEFACTS, ...(declared ?? [])];
}

/**
 * @typedef {{ mkdirSync: typeof import("node:fs").mkdirSync,
 *   symlinkSync: typeof import("node:fs").symlinkSync,
 *   readdirSync: typeof import("node:fs").readdirSync,
 *   unlinkSync: typeof import("node:fs").unlinkSync,
 *   lstatSync: typeof import("node:fs").lstatSync,
 *   readlinkSync: typeof import("node:fs").readlinkSync,
 *   realpathSync: typeof import("node:fs").realpathSync,
 *   rmSync: typeof import("node:fs").rmSync,
 *   copyFileSync: typeof import("node:fs").copyFileSync,
 *   existsSync: typeof import("node:fs").existsSync }} WorktreeFs
 */

/**
 * @param {string} root
 * @param {string} dir
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown } }} [options]
 */
function removeIsolated(
	root,
	dir,
	{ execFn = execFileSync, worktreeFs = fs, err = process.stderr } = {},
) {
	unlinkArtefacts(dir, worktreeFs);
	try {
		execFn(
			gitBinary(),
			["worktree", "remove", "--force", dir],
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	} catch (error) {
		err.write(
			`isolated worktree: could not remove the worktree at ${dir} (${error}) — remove it by hand with \`git worktree remove --force ${shellQuote(dir)}\`.\n`,
		);
	}
}

/**
 * @param {string} dir
 * @param {WorktreeFs} [worktreeFs]
 */
function unlinkArtefacts(dir, worktreeFs = fs) {
	for (const artefact of readLinkedPaths(dir))
		ignoreFailure(() => {
			const link = path.join(dir, artefact);
			const parent = worktreeFs.realpathSync(path.dirname(link));
			if (
				isUnder(parent, [worktreeFs.realpathSync(dir)], path.sep) &&
				worktreeFs.lstatSync(link).isSymbolicLink()
			)
				worktreeFs.unlinkSync(link);
		});
}

/**
 * @param {string} root
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, alive?: (pid: number) => boolean }} [options]
 * @returns {string[]}
 */
function sweepIsolated(
	root,
	{
		execFn = execFileSync,
		worktreeFs = fs,
		err = process.stderr,
		alive = pidAlive,
	} = {},
) {
	const base = path.join(root, WORKTREES);
	/** @type {string[]} */
	let entries;
	try {
		entries = worktreeFs.readdirSync(base);
	} catch (error) {
		if (caught(error).code !== "ENOENT")
			err.write(
				`isolated worktree: could not read ${base} (${error}) — leftover worktrees are NOT being swept.\n`,
			);
		pruneWorktreeRegistrations(root, { execFn, err });
		return [];
	}
	/** @type {string[]} */
	const removed = [];
	for (const name of entries) {
		if (!name.startsWith(ISOLATED_PREFIX)) continue;
		const pid = Number(name.slice(ISOLATED_PREFIX.length));
		if (!Number.isInteger(pid) || pid <= 0) continue;
		// lucmoseley/mantahostels#2034
		if (pid !== process.pid && alive(pid)) continue;
		removeIsolated(root, path.join(base, name), { execFn, worktreeFs, err });
		removed.push(name);
	}
	pruneWorktreeRegistrations(root, { execFn, err });
	return removed;
}

/**
 * @param {string} root
 * @param {{ execFn?: ExecFn, err?: { write: (s: string) => unknown } }} [options]
 */
function pruneWorktreeRegistrations(
	root,
	{ execFn = execFileSync, err = process.stderr } = {},
) {
	try {
		execFn(
			gitBinary(),
			["worktree", "prune"],
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	} catch (error) {
		err.write(
			`isolated worktree: could not prune stale worktree records (${error}).\n`,
		);
	}
}

/**
 * @param {string} root
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, pid?: number, err?: { write: (s: string) => unknown }, tree?: string }} [options]
 * @returns {{ dir: string, error: null }|{ dir: null, error: string }}
 */
function createIsolated(
	root,
	{
		execFn = execFileSync,
		worktreeFs = fs,
		pid = process.pid,
		err = process.stderr,
		tree,
	} = {},
) {
	const dir = path.join(root, WORKTREES, `${ISOLATED_PREFIX}${String(pid)}`);
	/** @type {(args: string[], cwd: string) => void} */
	const run = (args, cwd) => {
		execFn(
			gitBinary(),
			args,
			gitSpawnOptions({
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	};
	try {
		worktreeFs.mkdirSync(path.dirname(dir), { recursive: true });
		/** @type {string[]} */
		let add = ["--detach", dir, "HEAD"];
		if (tree !== undefined) {
			const born = orFallback(() => {
				run(["rev-parse", "--verify", "-q", "HEAD"], root);
				return true;
			}, false);
			add = born
				? ["--detach", "--no-checkout", dir, "HEAD"]
				: ["--orphan", dir];
		}
		run(["worktree", "add", ...add], root);
	} catch (error) {
		return {
			dir: null,
			error: `could not create a worktree at ${dir}: ${error}`,
		};
	}
	if (tree !== undefined)
		try {
			run(["read-tree", "-u", "--reset", tree], dir);
		} catch (error) {
			removeIsolated(root, dir, { execFn, worktreeFs, err });
			return {
				dir: null,
				error: `could not check ${tree} out into ${dir}: ${error}`,
			};
		}
	const linkFault = linkArtefacts(root, dir, worktreeFs);
	if (linkFault !== null) {
		removeIsolated(root, dir, { execFn, worktreeFs, err });
		return { dir: null, error: linkFault };
	}
	return { dir, error: null };
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {WorktreeFs} [worktreeFs]
 * @returns {string|null}
 */
function linkArtefacts(root, dir, worktreeFs = fs) {
	for (const artefact of readLinkedPaths(dir)) {
		if (!worktreeFs.existsSync(path.join(root, artefact))) continue;
		const target = path.join(dir, artefact);
		if (!SHARED_ARTEFACTS.includes(artefact) && worktreeFs.existsSync(target))
			continue;
		try {
			worktreeFs.mkdirSync(path.dirname(target), { recursive: true });
			worktreeFs.symlinkSync(path.join(root, artefact), target, "dir");
		} catch (error) {
			return `could not link ${artefact} into ${dir}: ${error}`;
		}
	}
	return null;
}

const QUEUE_RUN = path.join(__dirname, "..", "queue-run.js");

const GIT_REDIRECTS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"];

/**
 * @param {string} root
 * @param {string} tree
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, onStart?: () => void, gate?: boolean }} [options]
 * @returns {{ error: string }|{ error: null, status: number|null, output: string, spawnError: Error|undefined }}
 */
function runInTree(
	root,
	tree,
	command,
	{ env = process.env, onStart, gate = false } = {},
) {
	/** @type {NodeJS.ProcessEnv} */
	const clean = withMergeParents(root, env);
	for (const k of GIT_REDIRECTS) delete clean[k];
	/** @type {ExecFn} */
	const execFn = (file, args, options) =>
		execFileSync(file, args, { ...options, env: clean });
	sweepIsolated(root, { execFn });
	const made = createIsolated(root, { execFn, tree });
	if (made.dir === null) return { error: made.error };
	try {
		onStart?.();
		const [file, args] = gate
			? [process.execPath, [QUEUE_RUN, "--gate", "--tree", tree, "--", command]]
			: ["sh", ["-c", 'sh -c "$1" </dev/null 2>&1', "sh", command]];
		const r = spawnSync(file, args, {
			cwd: made.dir,
			env: clean,
			stdio: ["ignore", "pipe", "inherit"],
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
		return {
			error: null,
			status: r.status,
			output: r.stdout ?? "",
			spawnError: r.error,
		};
	} finally {
		removeIsolated(root, made.dir, { execFn });
	}
}

/** @param {string[]} argv */
function main(argv) {
	const [mode, ...rest] = argv;
	const gate = rest[0] === "--gate";
	const [command, ...extra] = gate ? rest.slice(1) : rest;
	if (mode !== "run" || !command || extra.length > 0) {
		writeFd(2, "usage: node isolated-worktree.js run [--gate] <command>\n");
		return 64;
	}
	/** @type {(args: string[]) => string} */
	const git = (args) =>
		execGit(args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		}).trim();
	let tree;
	let root;
	try {
		tree = git(["write-tree"]);
	} catch (error) {
		writeFd(2, `git could not write the commit's tree: ${error}\n`);
		return 2;
	}
	try {
		root = fs.realpathSync(git(["rev-parse", "--show-toplevel"]));
	} catch (error) {
		writeFd(2, `git could not name this checkout's top level: ${error}\n`);
		return 2;
	}
	const r = runInTree(root, tree, command, { gate });
	if (r.error !== null) {
		writeFd(2, `${r.error.trim()}\n`);
		return 2;
	}
	writeFd(1, r.output);
	if (r.spawnError) writeFd(1, `${r.spawnError.message}\n`);
	return r.status === 0 ? 0 : 3;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		writeFd(2, `isolated worktree: ${caught(error).message}\n`);
		process.exitCode = 2;
	}
}

module.exports = {
	createIsolated,
	linkArtefacts,
	readLinkedPaths,
	removeIsolated,
	runInTree,
	sweepIsolated,
	unlinkArtefacts,
};
