#!/usr/bin/env node
/*
 * isolated-worktree.js — the throwaway worktree `run-vitest.js` runs a frozen
 * suite in (mantahostels#2169), and `commit-paths.js` its pre-lock suite
 * (workflow-core#1760): building it at HEAD, overlaying a session's own files into it
 * (workflow-core#812) or checking a commit's tree out into it and running a suite there
 * (`runInTree`), and taking it and any leftovers down. Removing a worktree on
 * a KILL, which no `.finally()` reaches, is run-vitest.js's signal handler's
 * job; a `runInTree` run killed leaves its worktree to the next sweep.
 *
 *   node scripts/lib/isolated-worktree.js run <command>
 *
 * is `runInTree` over the tree of the index git names in $GIT_INDEX_FILE, as
 * the pre-commit hook's test gate runs it (workflow-core#1766): the suite's output on
 * stdout, exit 0 green, 3 red, 2 where no worktree could be had, saying why on
 * stderr, and 64 on a usage error — never 1, which is node's own crash.
 */

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
const { shellWord } = require("./dirty-tree.js");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { writeFd } = require("./write-fd.js");
const { readConfig } = require("./workflow-core-config.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/*
 * Where the throwaway worktree goes. `.claude/worktrees/` is gitignored AND
 * named in `vitest.config.ts`'s `exclude`, so a neighbour's shared-tree run does
 * not collect this worktree's copy of the corpus alongside its own.
 */
const WORKTREE_DIR = path.join(".claude", "worktrees");
/* Pid-scoped, so two isolated runs never share a directory and a leftover can
 * be matched back to a process that may or may not still exist. */
const ISOLATED_PREFIX = "isolated-";

/*
 * Gitignored, generated artefacts the suite reads that `git worktree add`
 * therefore does not reproduce. `createIsolated` symlinks each one the
 * canonical checkout has into the frozen worktree, exactly as it does
 * `node_modules`; `removeIsolated` unlinks each before tearing the worktree
 * down, so the canonical original is never walked. A third member costs one
 * line here (mantahostels#2213), or, for one a host's suite alone reads, one entry
 * in its `worktreeLinks` (workflow-core#1767) — `linkArtefacts` makes its parent directory
 * first, so an entry needs no tracked sibling of its own to land.
 */
const SHARED_ARTEFACTS = [
	/* The bulk of the checkout — copying it per run would dwarf the worktree's
	 * own cost, and it's what makes `.bin/vitest` findable at all (mantahostels#2153). */
	"node_modules",
	/* Husky's own generated shim directory (`.husky/_/.gitignore` is a bare
	 * `*`), which test files read directly to exercise `core.hooksPath`
	 * against the real hook runner rather than a hand-written stand-in (mantahostels#2213).
	 */
	path.join(".husky", "_"),
];

/**
 * `SHARED_ARTEFACTS` plus the gitignored paths the host declares its suite
 * reads, as `worktreeLinks` (workflow-core#1767) — read from the worktree's own config, the
 * one the commit or HEAD carries, so no neighbour's unsaved edit to the shared
 * one decides what is linked (workflow-core#1766). The shared ones alone where that config
 * cannot be read: the suite's own read of it reports the fault.
 * @param {string} dir the worktree
 * @returns {string[]}
 */
function readLinkedPaths(dir) {
	let declared;
	try {
		declared = readConfig({ root: dir, quiet: true }).worktreeLinks;
	} catch {
		declared = undefined;
	}
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
 * Tear one isolated worktree down.
 *
 * EACH `readLinkedPaths` SYMLINK GOES FIRST, against a teardown that walks
 * one into its canonical target. `git worktree remove --force` does not, so
 * the ordering is unverified belt and braces and the test asserts the outcome
 * — every target survives — rather than the order (mantahostels#2169, mantahostels#2213).
 * Only a link whose own directory resolves inside the worktree is unlinked: a
 * declared path under another linked one names a canonical file.
 *
 * Best effort throughout: a teardown failure is reported and never changes the
 * suite's exit code.
 *
 * @param {string} root
 * @param {string} dir
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown } }} [options]
 */
function removeIsolated(
	root,
	dir,
	{ execFn = execFileSync, worktreeFs = fs, err = process.stderr } = {},
) {
	for (const artefact of readLinkedPaths(dir))
		try {
			const link = path.join(dir, artefact);
			const parent = worktreeFs.realpathSync(path.dirname(link));
			if (
				isUnder(parent, [worktreeFs.realpathSync(dir)], path.sep) &&
				worktreeFs.lstatSync(link).isSymbolicLink()
			)
				worktreeFs.unlinkSync(link);
		} catch {
			/* Never created, or already gone — either way there is nothing to unlink
			 * and the remove below is still the operation that matters. */
		}
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
			`isolated worktree: could not remove the worktree at ${dir} (${error}) — remove it by hand with \`git worktree remove --force ${shellWord(dir)}\`.\n`,
		);
	}
}

/**
 * Remove isolated worktrees left by a process that is gone.
 *
 * A run killed with SIGKILL — the stall watchdog's own weapon, and `earlyoom`'s
 * — never reaches its `finally`, and each leak is a whole checkout that
 * `git worktree list` then carries forever. A leftover whose pid is ALIVE is
 * left alone: that is either a running neighbour or a reused pid.
 *
 * @param {string} root
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, alive?: (pid: number) => boolean }} [options]
 * @returns {string[]} the directories removed
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
	const base = path.join(root, WORKTREE_DIR);
	/** @type {string[]} */
	let entries;
	try {
		entries = worktreeFs.readdirSync(base);
	} catch (error) {
		/* ENOENT is the ordinary case and says nothing: no isolated run has
		 * happened yet, so there is nothing to sweep. Anything else is the sweep
		 * going BLIND — the one thing standing between a SIGKILLed run and a
		 * permanently leaked checkout — and a fail-open nobody is told about is
		 * indistinguishable from a clean tree (mantahostels#2169). */
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
		/* THIS PROCESS'S OWN NUMBER IS DEBRIS, NOT A LIVE HOLDER. A pid is not an
		 * identity over time (mantahostels#2034, which ruled the same for the queue markers),
		 * and the one reuse this sweep can resolve for certain is its own: a
		 * directory named for the pid we are running under was left by a dead
		 * predecessor, and sparing it would fail `git worktree add` on an existing
		 * path and refuse the suite outright. */
		if (pid !== process.pid && alive(pid)) continue;
		removeIsolated(root, path.join(base, name), { execFn, worktreeFs, err });
		removed.push(name);
	}
	pruneWorktreeRegistrations(root, { execFn, err });
	return removed;
}

/**
 * Drop git's administrative record of a worktree whose directory is gone.
 *
 * THE DIRECTORY SWEEP ABOVE CANNOT SEE THIS CASE. A leftover cleared by hand,
 * by an `earlyoom` kill mid-teardown or by a `.claude/` sweep leaves
 * `.git/worktrees/<id>/` registered with nothing behind it, so `readdirSync`
 * finds nothing and `git worktree list` carries the entry for ever
 * (mantahostels#2169).
 *
 * `git worktree prune` is safe here and deliberately unscoped: it removes only
 * entries whose working tree is absent, so a live neighbour's worktree is never
 * touched.
 *
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
 * Create the detached worktree and link in each of `readLinkedPaths` the
 * canonical checkout has and the worktree lacks.
 *
 * `--detach`, never a branch: `docs/agents/guard-registry.md` §Conventions and
 * the guard-branch core of `scripts/guard-dispatch.js` both require it, and a throwaway tree has no use
 * for a ref of its own.
 *
 * Given a `tree`, the worktree holds that tree, in its index and on disk,
 * over HEAD — or, on an unborn branch, over no commit, as its first commit
 * sees it — and no other file (workflow-core#1760). The unborn one is `--orphan`, whose
 * branch never gets a ref, nothing being committed in it; it needs git 2.42,
 * and an older git, or a branch already named for the worktree, refuses it.
 *
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
	const dir = path.join(root, WORKTREE_DIR, `${ISOLATED_PREFIX}${String(pid)}`);
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
			let born = true;
			try {
				run(["rev-parse", "--verify", "-q", "HEAD"], root);
			} catch {
				born = false;
			}
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
		/* Half a worktree is worse than none: lacking a member the checkout has,
		 * the run would fail on a missing vitest, or on a missing `.husky/_/h`,
		 * and either reads as a suite failure rather than as the setup fault it
		 * is. */
		removeIsolated(root, dir, { execFn, worktreeFs, err });
		return { dir: null, error: linkFault };
	}
	return { dir, error: null };
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {WorktreeFs} worktreeFs
 * @returns {string|null} why a link failed, or null where every one landed
 */
function linkArtefacts(root, dir, worktreeFs) {
	for (const artefact of readLinkedPaths(dir)) {
		/* A checkout lacking a member gets no link for it: a dangling one fails
		 * any test that stats the tree (workflow-core#822). `existsSync` follows a link, so a
		 * source that is itself dangling is skipped too. A checkout with no
		 * `node_modules` therefore runs with none, failing on a missing vitest as
		 * its shared tree would. */
		if (!worktreeFs.existsSync(path.join(root, artefact))) continue;
		const target = path.join(dir, artefact);
		/* A declared path the worktree already holds is the commit's own copy;
		 * a shared one there is a setup fault, refused below. */
		if (!SHARED_ARTEFACTS.includes(artefact) && worktreeFs.existsSync(target))
			continue;
		try {
			/* `symlinkSync` makes no parent of its own — a member whose parent is
			 * absent from a tracked-files-only checkout would ENOENT here without
			 * this, breaking every isolated run rather than just that member. */
			worktreeFs.mkdirSync(path.dirname(target), { recursive: true });
			worktreeFs.symlinkSync(path.join(root, artefact), target, "dir");
		} catch (error) {
			return `could not link ${artefact} into ${dir}: ${error}`;
		}
	}
	return null;
}

/**
 * Copy each of `paths` from the canonical checkout into the worktree at `dir`,
 * or delete it there where the session deleted it, then stage them all there.
 * A symlink is copied as a link, never followed.
 *
 * STAGED, so a new file counts as tracked inside the worktree: `git stash
 * create`, which takes `treeAtEnd`, and `git diff <base>`, which gives the
 * run's `changedPaths`, both skip an untracked one.
 *
 * @param {string} root
 * @param {string} dir
 * @param {string[]} paths repo-relative
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs }} [options]
 * @returns {string|null} why it stopped, or null where every path landed
 */
function overlayFiles(
	root,
	dir,
	paths,
	{ execFn = execFileSync, worktreeFs = fs } = {},
) {
	for (const rel of paths) {
		const from = path.join(root, rel);
		const to = path.join(dir, rel);
		try {
			let stat = null;
			try {
				stat = worktreeFs.lstatSync(from);
			} catch (error) {
				if (caught(error).code !== "ENOENT") throw error;
			}
			worktreeFs.rmSync(to, { force: true });
			if (!stat) continue;
			worktreeFs.mkdirSync(path.dirname(to), { recursive: true });
			if (stat.isSymbolicLink())
				worktreeFs.symlinkSync(worktreeFs.readlinkSync(from), to);
			else worktreeFs.copyFileSync(from, to);
		} catch (error) {
			return `could not copy ${rel} into ${dir}: ${error}`;
		}
	}
	if (paths.length === 0) return null;
	try {
		execFn(
			gitBinary(),
			["add", "-A", "--", ...paths],
			gitSpawnOptions({
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	} catch (error) {
		return `could not stage the overlay in ${dir}: ${error}`;
	}
	return null;
}

/* Inherited, any of these would point git — the worktree's own, or the
 * suite's — back at the caller's index or tree. */
const GIT_REDIRECTS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"];

/**
 * Run `command` through `sh -c`, stdin closed and stderr folded into stdout,
 * in a throwaway worktree holding `tree` over HEAD and no other file but
 * `readLinkedPaths`, so no neighbour's unsaved edit reaches it (workflow-core#1760). The
 * worktree goes when the command ends; a leftover is swept first.
 * @param {string} root
 * @param {string} tree
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, onStart?: () => void }} [options] `env`
 *   is the command's environment, less `GIT_REDIRECTS`, which no git call
 *   here sees either; `onStart` is called once the worktree stands
 * @returns {{ error: string }|{ error: null, status: number|null, output: string, spawnError: Error|undefined }}
 */
function runInTree(root, tree, command, { env = process.env, onStart } = {}) {
	/** @type {NodeJS.ProcessEnv} */
	const clean = { ...env };
	for (const k of GIT_REDIRECTS) delete clean[k];
	/** @type {ExecFn} */
	const execFn = (file, args, options) =>
		execFileSync(file, args, { ...options, env: clean });
	sweepIsolated(root, { execFn });
	const made = createIsolated(root, { execFn, tree });
	if (made.dir === null) return { error: made.error };
	try {
		onStart?.();
		const r = spawnSync(
			"sh",
			["-c", 'sh -c "$1" </dev/null 2>&1', "sh", command],
			{
				cwd: made.dir,
				env: clean,
				stdio: ["ignore", "pipe", "inherit"],
				encoding: "utf8",
				maxBuffer: CHILD_MAX_BUFFER,
			},
		);
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
	const [mode, command, ...rest] = argv;
	if (mode !== "run" || !command || rest.length > 0) {
		writeFd(2, "usage: node isolated-worktree.js run <command>\n");
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
	const r = runInTree(root, tree, command);
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
	overlayFiles,
	removeIsolated,
	runInTree,
	sweepIsolated,
};
