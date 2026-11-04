/*
 * session-checkout.js — the one owner of a session worktree's lifecycle
 * (#4229): every launcher and session goes through it, and no caller runs
 * `git worktree` itself.
 *
 * CUT fetches `landing`, adds a worktree detached at `origin/landing` under
 * `.claude/worktrees/<session-name>/` of the main checkout, and attaches its
 * dependencies.
 *
 * ATTACH points the worktree's `node_modules` at the dependency store keyed by
 * the hash of the worktree's own `package-lock.json`, building that store
 * first where none exists. A store is built once, by `npm ci --ignore-scripts`
 * (docs/practice/dependency-and-release-management.md), into a staging
 * directory renamed into place whole, and is never installed into again. One build runs per key: a cut finding a live builder's lock waits for
 * its store rather than running a second `npm ci` against the memory cap.
 *
 * A STORE IS READ-ONLY: its `node_modules` loses every write bit before the
 * rename, so a tool caching under `node_modules` fails or falls back rather
 * than writing under each neighbour on the lockfile (#4255). Vite falls back
 * on its own, bundling its config beside the source; vitest's cache sits in
 * the worktree (vitest.config.ts `cacheDir`); guard-npm-install refuses an
 * install through the link. A frozen tree is removed by giving its
 * directories their owner's write bit back first (`removeTree`).
 * Residual: the owner's own `chmod`, or a root process, still writes through.
 *
 * LAND merges a freshly fetched `origin/landing` into the worktree's `HEAD` and
 * pushes `HEAD:landing`, then starts the lander. A merge, never a rebase: git
 * runs `pre-merge-commit`, and so the whole pre-commit stack, on a merge
 * commit, and no hook at all on a rebase (#3106), which would skip the
 * re-anchor the merge owes. A registry-anchor conflict is settled by the
 * per-row merge driver git config names (#4171). Neither the merge nor the
 * push carries a timeout of its own: every checker their hooks run is bounded
 * already (#4187).
 *
 * THE STORES LIVE UNDER `.claude/worktrees/.dep-stores/`, so the ignores every
 * tool already carries for the worktrees folder cover them too. A session name may not start with a dot, so none collides with it.
 *
 * Residual: nothing removes a store no worktree links; the reaper does that
 * (#4247).
 */

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { execGit, GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { runStartLander } = require("./lander-start.js");
const { mainCheckout } = require("./main-checkout.js");
const { scriptPath } = require("./script-path.js");
const { sleepSync } = require("./sleep-sync.js");
const { buildModuleOffLine, moduleOn } = require("./workflow-core-config.js");
const { writeFd } = require("./write-fd.js");

const WORKTREES = path.join(".claude", "worktrees");
const STORES = path.join(WORKTREES, ".dep-stores");
const LOCKFILE = "package-lock.json";
/* What `npm ci` reads besides the lockfile; `.npmrc` only where present. */
const MANIFESTS = ["package.json", LOCKFILE, ".npmrc"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/* 64 bits of sha256: a collision among even 10^4 live lockfiles is ~3e-12
 * likely, and the name stays short enough to read in a path. */
const KEY_HEX = 16;
/* Untraced: room for a cold `npm ci` over a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/* Untraced: a neighbour's fetch holds the ref lock for well under a second. */
const FETCH_TRIES = 3;
const POLL_MS = 1000;

/** A refusal the CLI prints as it stands. */
class CheckoutError extends Error {}

/**
 * `npm ci` into `dir`, its output on stderr so a caller's stdout stays the
 * path. `WFC_NPM` names the program.
 * @param {string} dir
 */
function npmCi(dir) {
	const r = spawnSync(
		process.env.WFC_NPM || "npm",
		["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: dir, stdio: ["ignore", 2, 2], timeout: INSTALL_TIMEOUT_MS },
	);
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(
			`npm ci exited ${r.status ?? r.signal} building a store in ${dir} — its output is above; fix the lockfile or the network, then attach again`,
		);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
const git = (args, cwd) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	}).trim();

/**
 * The main checkout `cwd` belongs to, symlinks dereferenced.
 * @param {string} cwd
 * @returns {string}
 */
function rootOf(cwd) {
	const root = mainCheckout(cwd);
	if (root === null)
		throw new CheckoutError(
			`${cwd} is in no main checkout git can name — run this from inside the repository`,
		);
	return fs.realpathSync(root);
}

/**
 * Fetch `landing` into `origin/landing`, again where a neighbour's fetch held
 * the ref's lock.
 * @param {string} root
 */
function fetchLanding(root) {
	for (let tries = 1; ; tries++)
		try {
			git(
				[
					"fetch",
					"--quiet",
					"origin",
					"+refs/heads/landing:refs/remotes/origin/landing",
				],
				root,
			);
			return;
		} catch (err) {
			if (tries >= FETCH_TRIES || !/cannot lock ref/.test(String(err)))
				throw err;
			sleepSync(POLL_MS);
		}
}

/**
 * Take the build lock for a store, or wait out a live holder. True where the
 * lock is ours; false where the holder's store now stands.
 * @param {string} lock
 * @param {string} store
 * @returns {boolean}
 */
function takeBuildLock(lock, store) {
	const deadline = Date.now() + INSTALL_TIMEOUT_MS;
	for (;;) {
		try {
			fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
			return true;
		} catch (err) {
			if (caught(err).code !== "EEXIST") throw err;
		}
		if (fs.existsSync(path.join(store, "node_modules"))) return false;
		let holder = 0;
		try {
			holder = Number(fs.readFileSync(lock, "utf8").trim());
		} catch {
			continue;
		}
		if (!(holder > 0) || !pidAlive(holder)) {
			fs.rmSync(lock, { force: true });
			continue;
		}
		if (Date.now() > deadline)
			throw new Error(
				`pid ${holder} has held ${lock} past the install timeout — end that process, or remove the lock if it is gone, then attach again`,
			);
		sleepSync(POLL_MS);
	}
}

/**
 * Every write bit off under `dir`, or its owner's back on. A mode is changed
 * with no write bit on its directory, so the order is free. Links are left:
 * their modes are never read.
 * @param {string} dir
 * @param {boolean} on
 */
function setWriteBits(dir, on) {
	/** @param {string} at */
	const set = (at) => {
		const { mode } = fs.statSync(at);
		fs.chmodSync(at, on ? mode | 0o200 : mode & ~0o222);
	};
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const at = path.join(dir, entry.name);
		if (entry.isDirectory()) setWriteBits(at, on);
		else if (entry.isFile()) set(at);
	}
	set(dir);
}

/**
 * Remove `dir`, absent or frozen.
 * @param {string} dir
 */
function removeTree(dir) {
	if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory())
		setWriteBits(dir, true);
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The store for the lockfile in `from`, built from its manifests where absent.
 * @param {string} root the main checkout
 * @param {string} from
 * @returns {{ store: string, built: boolean }}
 */
function ensureStore(root, from) {
	const key = crypto
		.createHash("sha256")
		.update(fs.readFileSync(path.join(from, LOCKFILE)))
		.digest("hex")
		.slice(0, KEY_HEX);
	const store = path.join(root, STORES, key);
	if (fs.existsSync(path.join(store, "node_modules")))
		return { store, built: false };
	fs.mkdirSync(path.dirname(store), { recursive: true });
	const lock = path.join(root, STORES, `.build-${key}.lock`);
	if (!takeBuildLock(lock, store)) return { store, built: false };
	const staging = path.join(root, STORES, `.build-${key}-${process.pid}`);
	try {
		if (fs.existsSync(path.join(store, "node_modules")))
			return { store, built: false };
		/* A store directory without `node_modules` is a dead build's leftover. */
		fs.rmSync(store, { recursive: true, force: true });
		removeTree(staging);
		fs.mkdirSync(staging);
		for (const name of MANIFESTS)
			if (fs.existsSync(path.join(from, name)))
				fs.copyFileSync(path.join(from, name), path.join(staging, name));
		npmCi(staging);
		if (!fs.existsSync(path.join(staging, "node_modules")))
			throw new Error(
				`npm ci exited 0 but left no node_modules in ${staging} — check what WFC_NPM or npm names, then attach again`,
			);
		setWriteBits(path.join(staging, "node_modules"), false);
		fs.renameSync(staging, store);
		return { store, built: true };
	} finally {
		removeTree(staging);
		fs.rmSync(lock, { force: true });
	}
}

/**
 * Point the `node_modules` of the worktree holding `cwd` at the store for its
 * lockfile, building the store where none exists. A worktree with no lockfile
 * gets no link.
 * @param {string} cwd anywhere in the worktree
 * @returns {{ dir: string, store: string | null, built: boolean }}
 */
function attach(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const root = rootOf(dir);
	if (dir === root)
		throw new CheckoutError(
			"the main checkout installs its own dependencies — run attach from a session worktree, or name one",
		);
	if (!fs.existsSync(path.join(dir, LOCKFILE)))
		return { dir, store: null, built: false };
	const link = path.join(dir, "node_modules");
	let held = null;
	try {
		held = fs.lstatSync(link);
	} catch (err) {
		if (caught(err).code !== "ENOENT") throw err;
	}
	if (held && !held.isSymbolicLink())
		throw new CheckoutError(
			`${link} is a directory, not a store link — move it aside, then attach again`,
		);
	const made = ensureStore(root, dir);
	/* One rename, so no reader of the worktree sees `node_modules` absent. */
	const tmp = `${link}.attach-${process.pid}`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(path.join(made.store, "node_modules"), tmp, "dir");
	fs.renameSync(tmp, link);
	return { dir, ...made };
}

/**
 * Cut the session worktree for `name`: detached at a freshly fetched
 * `origin/landing`, its dependencies attached. A worktree whose attach fails
 * is removed.
 * @param {string} cwd anywhere in the repository
 * @param {string} name the session's name
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function cut(cwd, name) {
	if (!NAME.test(name))
		throw new CheckoutError(
			`${JSON.stringify(name)} is no session name: letters, digits, '.', '_' and '-', starting with a letter or digit`,
		);
	const root = rootOf(cwd);
	const dir = path.join(root, WORKTREES, name);
	if (fs.existsSync(dir))
		throw new CheckoutError(
			`${dir} already exists — pick another session name, or resume the session that worktree belongs to`,
		);
	fetchLanding(root);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	git(["worktree", "add", "--quiet", "--detach", dir, "origin/landing"], root);
	try {
		const head = git(["rev-parse", "HEAD"], dir);
		const { store, built } = attach(dir);
		return { dir, head, store, built };
	} catch (err) {
		try {
			git(["worktree", "remove", "--force", dir], root);
		} catch (removeErr) {
			throw new Error(
				`${caught(err).message}; and the half-cut worktree would not go (${caught(removeErr).message}) — remove it with \`git worktree remove --force ${dir}\``,
				{ cause: removeErr },
			);
		}
		throw err;
	}
}

/**
 * A git command whose output the session reads — hook output included — on
 * stderr, so a caller's stdout stays clean.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, output: string }}
 */
function gitShown(args, cwd) {
	const r = spawnGitSync(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) throw r.error;
	const output = `${r.stdout}${r.stderr}`;
	if (output) writeFd(2, output);
	return { ok: r.status === 0, output };
}

/**
 * Whether `a` is an ancestor of `b`, or the same commit.
 * @param {string} a
 * @param {string} b
 * @param {string} cwd
 */
const isAncestor = (a, b, cwd) =>
	spawnGitSync(["merge-base", "--is-ancestor", a, b], {
		cwd,
		stdio: "ignore",
		timeout: GIT_TIMEOUT_MS,
	}).status === 0;

/** git's words for a push refused because the remote ref moved past ours. */
const MOVED = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/;

/**
 * Start the lander after a push: the post-push hook sees no push made inside
 * a script. The main checkout's start-lander.js where this code runs from a
 * linked worktree of it, so no lander runs from a tree the reaper may remove.
 * @param {string} root the main checkout
 * @param {string} dir the worktree
 * @returns {string} start-lander.js's line, or why it did not start
 */
function startLanderFor(root, dir) {
	const own = path.join(__dirname, "..", "start-lander.js");
	const inTree = path.relative(dir, own);
	const script = inTree.startsWith("..") ? own : path.join(root, inTree);
	try {
		const r = runStartLander(root, { script });
		return r.ok
			? r.line
			: `the lander did not start (${r.line}) — run \`node ${script}\``;
	} catch (err) {
		return `the lander did not start (${caught(err).message}) — run \`node ${script}\``;
	}
}

/**
 * @param {string} dir
 * @param {string} root
 */
function refuseUnlandable(dir, root) {
	if (dir === root)
		throw new CheckoutError(
			`the main checkout is never landed from — land from your session worktree, or cut one with \`node ${scriptPath("session-checkout.js")} cut <session-name>\``,
		);
	if (!moduleOn("landing", { root }))
		throw new CheckoutError(
			`${buildModuleOffLine("landing")}, so nothing lands through it — push to main as \`rule:branch-publish\` says`,
		);
	if (fs.existsSync(git(["rev-parse", "--git-path", "MERGE_HEAD"], dir)))
		throw new CheckoutError(
			"a merge is in progress in this worktree — resolve it and `git commit`, or `git merge --abort`, then land again",
		);
	const dirty = git(["diff", "--name-only", "HEAD"], dir);
	if (dirty)
		throw new CheckoutError(
			`uncommitted changes to ${dirty.split("\n").join(", ")} would not land — commit them, or set them aside, then land again`,
		);
}

/**
 * Merge `origin/landing` into `HEAD`.
 * @param {string} dir
 */
function mergeLanding(dir) {
	if (gitShown(["merge", "--no-edit", "origin/landing"], dir).ok) return;
	if (!fs.existsSync(git(["rev-parse", "--git-path", "MERGE_HEAD"], dir)))
		throw new CheckoutError(
			"git did not start the merge of origin/landing, its output above — clear what it names, then land again",
		);
	const conflicted = git(["diff", "--name-only", "--diff-filter=U"], dir);
	throw new CheckoutError(
		conflicted
			? `merging origin/landing conflicts in ${conflicted.split("\n").join(", ")} — resolve them and \`git commit\` (it runs the pre-commit gates), or \`git merge --abort\`, then land again`
			: "the merge of origin/landing was refused, its output above — fix the finding and `git commit` (it runs the same gates), or `git merge --abort`, then land again",
	);
}

/**
 * @param {string} cwd anywhere in the worktree
 * @returns {{ dir: string, head: string, merged: boolean, pushed: boolean, lander: string | null }}
 */
function land(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const root = rootOf(dir);
	refuseUnlandable(dir, root);
	fetchLanding(root);
	if (isAncestor("HEAD", "origin/landing", dir))
		return {
			dir,
			head: git(["rev-parse", "HEAD"], dir),
			merged: false,
			pushed: false,
			lander: null,
		};
	const merged = !isAncestor("origin/landing", "HEAD", dir);
	if (merged) mergeLanding(dir);
	const head = git(["rev-parse", "HEAD"], dir);
	const push = gitShown(["push", "origin", "HEAD:landing"], dir);
	if (!push.ok)
		throw new CheckoutError(
			MOVED.test(push.output)
				? "landing moved after the fetch: a neighbour pushed first — land again, which merges the newer origin/landing into HEAD and pushes"
				: "the push to landing was refused, its output above — fix the finding, then land again",
		);
	return { dir, head, merged, pushed: true, lander: startLanderFor(root, dir) };
}

module.exports = { attach, CheckoutError, cut, land, STORES };
