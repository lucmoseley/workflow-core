/*
 * session-checkout.js — the one owner of a session worktree's lifecycle
 * (#4229): every launcher and session goes through it, and no caller runs
 * `git worktree` itself.
 *
 * CUT fetches `main`, adds a worktree detached at `origin/main` under
 * `.claude/worktrees/<session-name>/` of the main checkout, and attaches its
 * dependencies. A session that cuts one names itself its holder, in
 * `HOLDER_RECORD` in the worktree's git directory, so a tree it hands to an
 * in-process subagent, where no process's cwd lies, stands while it lives.
 *
 * LAUNCH-DIR is the directory a launcher starts a session in (#4245): a
 * worktree cut for it where the repository has the `landing` module, else the
 * main checkout, since without it no session pushes a queue ref of its own. Its name is the prompt's words and a random
 * suffix, so a session's worktree reads as its task. A resume runs in
 * the directory its job recorded, so it reopens the same worktree.
 *
 * LAUNCH-INTO is the directory a successor starts in to finish a dead
 * session's orphaned edits: that session's own worktree, named by the
 * caller, refused where git does not list it under the worktrees folder or
 * any live process still has its cwd inside it (#4385).
 *
 * ATTACH points the worktree's `node_modules` at the dependency store keyed by
 * the hash of the worktree's own `package-lock.json`, building that store
 * first where none exists. A store is built once, by `npm ci --ignore-scripts`
 * (docs/practice/dependency-and-release-management.md), into a staging
 * directory renamed into place whole, and is never installed into again. One build runs per key: a cut finding a live builder's lock waits for
 * its store rather than running a second `npm ci` against the memory cap.
 *
 * WARM builds the store for a freshly fetched `origin/main`'s lockfile
 * where none stands, so a cut needs no build of its own (#4318). The refill
 * tick runs it, detached, ahead of its launches, and its dispatcher cuts with
 * `noBuild`: a cut finding no store refuses at once rather than build inside
 * the dispatcher's time budget (lib/refill-batch.js).
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
 * LAND merges a freshly fetched `origin/main` into the worktree's `HEAD` and
 * pushes `HEAD:refs/heads/queue/<worktree name>`, the session's own queue ref
 * (#4458), then starts the queue lander, which tests it with every other
 * waiting ref and moves `main` on green. The merge keeps a conflict with
 * `main` in the session's hands, where the lander would drop the ref for it.
 * A merge, never a rebase: git runs `pre-merge-commit`, and so the whole
 * pre-commit stack, on a merge commit, and no hook at all on a rebase (#3106),
 * which would skip the re-anchor the merge owes. A registry-anchor conflict is
 * settled by the per-row merge driver git config names (#4171). Neither the
 * merge nor the push carries a timeout of its own: every checker their hooks
 * run is bounded already (#4187). A push refused as no fast-forward is filed
 * as a `land` row in the divergence log (#4446), the push running here where
 * no Bash hook sees it. One failing on a network or remote fault is retried
 * with backoff (#4497).
 *
 * THE STORES LIVE UNDER `.claude/worktrees/.dep-stores/`, so the ignores every
 * tool already carries for the worktrees folder cover them too. A session name may not start with a dot, so none collides with it.
 *
 * REAP clears landed worktrees and unlinked stores, save `origin/main`'s.
 *
 * REOPEN gives a finished background job its worktree back so `claude attach`
 * can wake it: an open from the agents view fails before any hook runs where
 * the tree is gone (#4368).
 */

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readLiveOrLog, readSessionEntries } = require("./arbiter-core.js");
const { holderAlive, pidAlive, readProcStartOf } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { readProcCwd } = require("./claude-sessions.js");
const { deref } = require("./deref.js");
const {
	execGit,
	GIT_TIMEOUT_MS,
	gitCommonDirOrThrow,
	spawnGitSync,
} = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { runStartLander } = require("./lander-start.js");
const { MOVED_LINE } = require("./land-refusal.js");
const { readJsonl } = require("./jsonl.js");
const { mainCheckout } = require("./main-checkout.js");
const {
	isPushFaultText,
	REMOTE_TRIES,
	remoteBackoffMs,
} = require("./network-fault.js");
const { readWorktreeDirt, readWorktreeFiling } = require("./orphan-filings.js");
const { pidLock } = require("./pid-lock.js");
const { REAL_PROC } = require("./proc-root.js");
const { buildCutCommand } = require("./cutover.js");
const { scriptPath } = require("./script-path.js");
const {
	readJobCwds,
	worktreeHolding,
	worktreeLabel,
} = require("./session-worktrees.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");
const { sleepSync } = require("./sleep-sync.js");
const {
	ownQueueRef,
	pushedRef,
	QUEUE_REFSPEC,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");
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
/* Untraced: enough of a prompt to name its task in a directory listing. */
const SLUG_MAX = 40;
/* 24 bits: two live worktrees for one prompt collide ~6e-8 of the time, and a
 * collision costs one refused member, which the next tick launches again. */
const SUFFIX_BYTES = 3;
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
 * Fetch `main` and every queue ref, pruning the queue refs gone from the
 * remote, again where a neighbour's fetch held a ref's lock.
 * @param {string} root
 */
function fetchShared(root) {
	for (let tries = 1; ; tries++)
		try {
			git(
				[
					"fetch",
					"--quiet",
					"--prune",
					REMOTE,
					trackingRefspec(VERIFIED_BRANCH),
					QUEUE_REFSPEC,
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
 * lock is ours; false where the holder's store now stands, or, under `noWait`,
 * where a live holder is still building it.
 * @param {string} lock
 * @param {string} store
 * @param {boolean} noWait
 * @returns {boolean}
 */
function takeBuildLock(lock, store, noWait) {
	const deadline = Date.now() + INSTALL_TIMEOUT_MS;
	for (;;) {
		if (writeLock(lock)) return true;
		if (fs.existsSync(path.join(store, "node_modules"))) return false;
		const holder = readLockHolder(lock);
		if (holder === null) continue;
		if (!(holder > 0) || !pidAlive(holder)) {
			fs.rmSync(lock, { force: true });
			continue;
		}
		if (noWait) return false;
		if (Date.now() > deadline)
			throw new Error(
				`pid ${holder} has held ${lock} past the install timeout — end that process, or remove the lock if it is gone, then attach again`,
			);
		sleepSync(POLL_MS);
	}
}

/**
 * Create the build lock naming this process; false where it exists already.
 * @param {string} lock
 * @returns {boolean}
 */
function writeLock(lock) {
	try {
		fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
		return true;
	} catch (err) {
		if (caught(err).code !== "EEXIST") throw err;
		return false;
	}
}

/**
 * The pid a build lock names: null where the lock is gone, 0 where it names
 * none.
 * @param {string} lock
 * @returns {number | null}
 */
function readLockHolder(lock) {
	try {
		return Number(fs.readFileSync(lock, "utf8").trim()) || 0;
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * The failure the last build of a store left, or null where none did.
 * @param {string} failed the store's failure record
 * @returns {string | null}
 */
function readBuildFailure(failed) {
	try {
		return fs.readFileSync(failed, "utf8").trim();
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
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
 * Where a store's manifests are read from: each manifest's bytes, or null
 * where the source has none.
 * @typedef {(name: string) => Buffer | null} ManifestSource
 */

/**
 * The manifests of the worktree `dir`.
 * @param {string} dir
 * @returns {ManifestSource}
 */
const buildWorktreeSource = (dir) => (name) => {
	const at = path.join(dir, name);
	return fs.existsSync(at) ? fs.readFileSync(at) : null;
};

/**
 * The manifests `origin/main` carries, read from the main checkout `root`.
 * @param {string} root
 * @returns {ManifestSource}
 */
const buildStartSource = (root) => (name) => {
	const r = spawnGitSync(["cat-file", "blob", `${VERIFIED_REF}:${name}`], {
		cwd: root,
		stdio: ["ignore", "pipe", "ignore"],
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	return r.status === 0 ? r.stdout : null;
};

/**
 * The store key of a lockfile's bytes.
 * @param {Buffer} lockfile
 */
const storeKeyOf = (lockfile) =>
	crypto.createHash("sha256").update(lockfile).digest("hex").slice(0, KEY_HEX);

/**
 * What ensureStore found or did: `built` now, already `standing`, or left to
 * the live process `building` it.
 * @typedef {{ store: string, state: "built" | "standing" | "building" }} Ensured
 */

/**
 * The refusal of a no-build cut whose store stands nowhere: the last build's
 * failure where one is recorded, else the live builder, else the warm route.
 * @param {string} key
 * @param {string} lock
 * @param {string} failed
 */
function buildNoStoreRefusal(key, lock, failed) {
	const head = `no dependency store stands for this lockfile yet (${key}), and this cut builds none`;
	const failure = readBuildFailure(failed);
	if (failure !== null)
		return new CheckoutError(
			`${head}; its last build failed — ${failure} — so no tick launches this member until a warm pass (\`node ${scriptPath("session-checkout.js")} warm\`) builds it`,
		);
	const holder = readLockHolder(lock);
	return new CheckoutError(
		`${head}${holder && pidAlive(holder) ? ` — pid ${holder} is building it` : ""}; the refill tick's warm pass (\`node ${scriptPath("session-checkout.js")} warm\`) builds it, and the next tick launches this member`,
	);
}

/**
 * The store for the lockfile `source` carries, built from its manifests where
 * absent; null where `source` has no lockfile. Under `noBuild` an absent store
 * refuses (buildNoStoreRefusal); under `noWait` a live builder is left to
 * finish. A failed build is recorded beside the store's lock, and cleared by
 * the next build that succeeds.
 * @param {string} root the main checkout
 * @param {ManifestSource} source
 * @param {{ noBuild?: boolean, noWait?: boolean }} [how]
 * @returns {Ensured | null}
 */
function ensureStore(root, source, { noBuild = false, noWait = false } = {}) {
	const lockfile = source(LOCKFILE);
	if (lockfile === null) return null;
	const key = storeKeyOf(lockfile);
	const store = path.join(root, STORES, key);
	if (fs.existsSync(path.join(store, "node_modules")))
		return { store, state: "standing" };
	const lock = path.join(root, STORES, `.build-${key}.lock`);
	const failed = path.join(root, STORES, `.build-${key}.failed`);
	if (noBuild) throw buildNoStoreRefusal(key, lock, failed);
	fs.mkdirSync(path.dirname(store), { recursive: true });
	if (!takeBuildLock(lock, store, noWait))
		return {
			store,
			state: fs.existsSync(path.join(store, "node_modules"))
				? "standing"
				: "building",
		};
	const staging = path.join(root, STORES, `.build-${key}-${process.pid}`);
	try {
		if (fs.existsSync(path.join(store, "node_modules")))
			return { store, state: "standing" };
		buildStore(staging, lockfile, source);
		/* A store directory without `node_modules` is a dead build's leftover. */
		fs.rmSync(store, { recursive: true, force: true });
		fs.renameSync(staging, store);
		fs.rmSync(failed, { force: true });
		return { store, state: "built" };
	} catch (err) {
		fs.writeFileSync(failed, `${caught(err).message.trim()}\n`);
		throw err;
	} finally {
		removeTree(staging);
		fs.rmSync(lock, { force: true });
	}
}

/**
 * Build a frozen `node_modules` in `staging` from `source`'s manifests.
 * @param {string} staging
 * @param {Buffer} lockfile `source`'s, read once already
 * @param {ManifestSource} source
 */
function buildStore(staging, lockfile, source) {
	removeTree(staging);
	fs.mkdirSync(staging);
	for (const name of MANIFESTS) {
		const bytes = name === LOCKFILE ? lockfile : source(name);
		if (bytes !== null) fs.writeFileSync(path.join(staging, name), bytes);
	}
	npmCi(staging);
	if (!fs.existsSync(path.join(staging, "node_modules")))
		throw new Error(
			`npm ci exited 0 but left no node_modules in ${staging} — check what WFC_NPM or npm names, then attach again`,
		);
	setWriteBits(path.join(staging, "node_modules"), false);
}

/**
 * Point the `node_modules` of the worktree holding `cwd` at the store for its
 * lockfile, building the store where none exists. A worktree with no lockfile
 * gets no link.
 * @param {string} cwd anywhere in the worktree
 * @param {{ noBuild?: boolean }} [how]
 * @returns {{ dir: string, store: string | null, built: boolean }}
 */
function attach(cwd, { noBuild = false } = {}) {
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
	const made = ensureStore(root, buildWorktreeSource(dir), { noBuild });
	if (made === null) return { dir, store: null, built: false };
	/* One rename, so no reader of the worktree sees `node_modules` absent. */
	const tmp = `${link}.attach-${process.pid}`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(path.join(made.store, "node_modules"), tmp, "dir");
	fs.renameSync(tmp, link);
	return { dir, store: made.store, built: made.state === "built" };
}

/**
 * Cut the session worktree for `name`: detached at a freshly fetched
 * `origin/main`, its dependencies attached. A worktree whose attach fails
 * is removed.
 * @param {string} cwd anywhere in the repository
 * @param {string} name the session's name
 * @param {{ noBuild?: boolean, holder?: string | null }} [how] `holder` the
 *   id of the session the worktree is held for
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function cut(cwd, name, how = {}) {
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
	fetchShared(root);
	return addWorktree(root, dir, VERIFIED_REF, how);
}

/**
 * The git directory of the worktree at `dir`.
 * @param {string} dir
 */
function adminDirOf(dir) {
	return git(["rev-parse", "--absolute-git-dir"], dir);
}

/**
 * Name session `sessionId` the holder of the worktree whose git directory is
 * `admin`, with the pid and start token of its live registry entry where one
 * stands: a session id its process later trades for another, as `/clear`
 * does, still holds through that process.
 * @param {string} admin
 * @param {string} sessionId
 */
function writeHolder(admin, sessionId) {
	const own = (readSessionEntries("own") ?? []).find(
		({ entry }) =>
			entry.sessionId === sessionId &&
			entry.pid &&
			entry.procStart &&
			readProcStartOf(entry.pid) === String(entry.procStart),
	)?.entry;
	fs.writeFileSync(
		path.join(admin, HOLDER_RECORD),
		`${JSON.stringify({ sessionId, pid: own?.pid ?? null, procStart: own?.procStart ?? null })}\n`,
	);
}

/**
 * Whether the worktree whose git directory is `admin` names a holder session
 * `live` holds or whose recorded process still runs, or names one where `live`
 * is null: an unread registry proves no session dead (#4496). Residual: while
 * the registry stays unreadable, every held tree stands on every pass, the
 * read failure logged. A record naming no session throws, so its tree stands,
 * reported as one the pass could not reap.
 * @param {string} admin
 * @param {Set<string> | null} live
 */
function isHeldByLiveSession(admin, live) {
	const file = path.join(admin, HOLDER_RECORD);
	let record;
	try {
		record = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		if (caught(err).code === "ENOENT") return false;
		throw new Error(`${file} will not parse: ${caught(err).message}`, {
			cause: err,
		});
	}
	if (typeof record?.sessionId !== "string")
		throw new Error(`${file} names no holder session`);
	return live === null || live.has(record.sessionId) || holderAlive(record);
}

/**
 * Add a worktree at `dir` detached at `rev`, its holder named before its
 * dependencies are attached, since a cold build can outlast `YOUNG_MS`; one
 * whose attach fails is removed.
 * @param {string} root the main checkout
 * @param {string} dir
 * @param {string} rev
 * @param {{ noBuild?: boolean, holder?: string | null }} [how] `noBuild`
 *   passed to the attach
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function addWorktree(root, dir, rev, how = {}) {
	const { holder, ...build } = how;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	git(["worktree", "add", "--quiet", "--detach", dir, rev], root);
	try {
		if (holder) writeHolder(adminDirOf(dir), holder);
		const head = git(["rev-parse", "HEAD"], dir);
		const { store, built } = attach(dir, build);
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

/** git's words for a push refused because the remote ref holds a commit ours lacks. */
const MOVED = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/;

/**
 * Start the queue lander after a push: the post-push hook sees no push made
 * inside a script. The main checkout's start-lander.js where this code runs from a
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
			`the main checkout is never landed from — land from your session worktree, or cut one with ${buildCutCommand()}`,
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
 * Merge `origin/main` into `HEAD`.
 * @param {string} dir
 */
function mergeMain(dir) {
	if (gitShown(["merge", "--no-edit", VERIFIED_REF], dir).ok) return;
	if (!fs.existsSync(git(["rev-parse", "--git-path", "MERGE_HEAD"], dir)))
		throw new CheckoutError(
			`git did not start the merge of ${VERIFIED_REF}, its output above — clear what it names, then land again`,
		);
	const conflicted = git(["diff", "--name-only", "--diff-filter=U"], dir);
	throw new CheckoutError(
		conflicted
			? `merging ${VERIFIED_REF} conflicts in ${conflicted.split("\n").join(", ")} — resolve them and \`git commit\` (it runs the pre-commit gates), or \`git merge --abort\`, then land again`
			: `the merge of ${VERIFIED_REF} was refused, its output above — fix the finding and \`git commit\` (it runs the same gates), or \`git merge --abort\`, then land again`,
	);
}

/**
 * The session worktree `dir`'s queue ref, refused where it is none.
 * @param {string} dir
 * @param {string} root
 * @returns {string}
 */
function queueRefOrRefuse(dir, root) {
	const queue = ownQueueRef(dir, root);
	if (queue === null)
		throw new CheckoutError(
			`${dir} is no session worktree under ${path.join(root, WORKTREES)}/, so it has no queue ref to land through — land from a worktree ${buildCutCommand()} cuts`,
		);
	return queue;
}

/**
 * @param {string} cwd anywhere in the worktree
 * @returns {{ dir: string, queue: string, head: string, merged: boolean, pushed: boolean, lander: string | null }}
 */
function land(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const root = rootOf(dir);
	refuseUnlandable(dir, root);
	const queue = queueRefOrRefuse(dir, root);
	fetchShared(root);
	const pushed = pushedRef({ root, tree: dir });
	if (isAncestor("HEAD", VERIFIED_REF, dir) || isAncestor("HEAD", pushed, dir))
		return {
			dir,
			queue,
			head: git(["rev-parse", "HEAD"], dir),
			merged: false,
			pushed: false,
			lander: null,
		};
	const merged = !isAncestor(VERIFIED_REF, "HEAD", dir);
	if (merged) mergeMain(dir);
	const head = git(["rev-parse", "HEAD"], dir);
	const push = pushQueueRef(dir, queue);
	if (!push.ok && MOVED.test(push.output)) {
		recordMoved(root, dir, push.output);
		throw new CheckoutError(
			`${MOVED_LINE} — merge \`${REMOTE}/${queue}\` into HEAD, then land again`,
		);
	}
	if (push.faulted)
		throw new CheckoutError(
			`the push to ${queue} met a remote fault on all ${REMOTE_TRIES} tries, its output above — nothing in the worktree causes it, so land again later`,
		);
	if (!push.ok)
		throw new CheckoutError(
			`the push to ${queue} was refused, its output above — fix the finding, then land again`,
		);
	return {
		dir,
		queue,
		head,
		merged,
		pushed: true,
		lander: startLanderFor(root, dir),
	};
}

/**
 * The push of `HEAD` to the queue ref, retried with lib/network-fault.js's
 * backoff while git's own words name a fault it names, GitHub's own among
 * them; `faulted` where the last try failed so.
 * @param {string} dir
 * @param {string} queue
 * @returns {{ ok: boolean, output: string, faulted: boolean }}
 */
function pushQueueRef(dir, queue) {
	for (let attempt = 1; ; attempt++) {
		const push = gitShown(["push", REMOTE, `HEAD:refs/heads/${queue}`], dir);
		const faulted = !push.ok && isPushFaultText(push.output);
		if (!faulted || attempt >= REMOTE_TRIES) return { ...push, faulted };
		const ms = remoteBackoffMs(attempt);
		writeFd(
			2,
			`session checkout: the push to ${queue} met a remote fault, retrying in ${Math.round(ms / 1000)} s\n`,
		);
		sleepSync(ms);
	}
}

/**
 * Files the refused push's divergence row, counted against freshly fetched
 * refs.
 * @param {string} root
 * @param {string} dir
 * @param {string} output the refused push's output
 */
function recordMoved(root, dir, output) {
	try {
		fetchShared(root);
	} catch (err) {
		writeFd(
			2,
			`session checkout: queue refs not re-fetched, so the divergence row's behind is a lower bound (${caught(err).message})\n`,
		);
	}
	try {
		/* Loaded here, so a divergence lib that will not load costs the row
		 * and never the land. */
		const { landRow } = require("./divergence-row.js");
		const { appendRow, buildHostPorts } = require("./divergence-row-host.js");
		appendRow(landRow(dir, output, buildHostPorts(process.env)));
	} catch (err) {
		writeFd(
			2,
			`session checkout: divergence row not recorded (${caught(err).message})\n`,
		);
	}
}

/**
 * The worktree name for a session launched on `prompt`: its words joined by
 * `-`, then random hex, as `/implement 4245` → `implement-4245-3fa9c1`.
 * @param {string} prompt
 * @returns {string}
 */
function buildSessionName(prompt) {
	const slug = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, SLUG_MAX)
		.replace(/^-+|-+$/g, "");
	return `${slug || "session"}-${crypto.randomBytes(SUFFIX_BYTES).toString("hex")}`;
}

/**
 * LAUNCH-DIR, above; with `into`, LAUNCH-INTO.
 * @param {string} cwd anywhere in the repository
 * @param {string} prompt
 * @param {{ noBuild?: boolean, into?: string }} [how] `noBuild` passed to
 *   the cut or attach
 * @returns {string}
 */
function launchDir(cwd, prompt, how = {}) {
	const root = rootOf(cwd);
	const { into, ...build } = how;
	if (into !== undefined) return launchInto(root, into, build);
	return moduleOn("landing", { root })
		? cut(root, buildSessionName(prompt), build).dir
		: root;
}

/**
 * `dir` sits where a cut puts a session's worktree, directly under `root`'s
 * worktrees folder.
 * @param {string} root the main checkout
 * @param {string} dir
 */
function isSessionWorktreeDir(root, dir) {
	return path.dirname(path.resolve(dir)) === path.join(root, WORKTREES);
}

/**
 * LAUNCH-INTO, above: `into`, dereferenced, where it is a registered session
 * worktree of `root` no process works in, its dependencies re-attached.
 * @param {string} root the main checkout
 * @param {string} into
 * @param {{ noBuild?: boolean }} how passed to the attach
 * @returns {string}
 */
function launchInto(root, into, how) {
	const dir = deref(path.resolve(into));
	if (
		!isSessionWorktreeDir(root, dir) ||
		!readWorktreesOrThrow(root).includes(dir)
	)
		throw new CheckoutError(
			`${dir} is no session worktree of ${root} — name a directory \`git worktree list\` shows under ${path.join(root, WORKTREES)}`,
		);
	if (!fs.existsSync(dir))
		throw new CheckoutError(
			`${dir} is registered but gone — \`node ${scriptPath("session-checkout.js")} reopen <job-id>\` rebuilds a reaped one`,
		);
	const holders = readProcesses().filter((p) =>
		worktreeHolding(deref(p.cwd), [dir]),
	);
	if (holders.length > 0)
		throw new CheckoutError(
			`a live process still works in ${dir} (pid ${holders.map((p) => p.pid).join(", ")}) — stop the session that holds it first, or launch from outside it`,
		);
	attach(dir, how);
	return dir;
}

/**
 * WARM, above. Null where the repository has no `landing` module or
 * `origin/main` carries no lockfile.
 * @param {string} cwd anywhere in the repository
 * @returns {Ensured | null}
 */
function warm(cwd) {
	const root = rootOf(cwd);
	if (!moduleOn("landing", { root })) return null;
	fetchShared(root);
	return ensureStore(root, buildStartSource(root), { noWait: true });
}

/*
 * REAP, run on each refill-loop tick, clears what the worktrees folder no
 * longer needs and names what it may not clear:
 *   - a session worktree whose every `HEAD` commit is on a freshly fetched
 *     `origin/main` or its own queue ref, whose tree is clean, and whose session is neither live
 *     (a process's cwd lies in it), resumable (a job record whose cwd lies in
 *     it is in any state but `done` or `failed`), held (its `HOLDER_RECORD`
 *     names a live session) nor finished under `KEEP_MS` ago is removed, its path, `HEAD` sha, and each job's id and seat whose
 *     cwd lies in it appended first to `REAPED_RECORD` in git's common
 *     directory;
 *   - one dirty or unlanded, of a dead and non-resumable session, is reported
 *     with its idle time and last commit, never removed;
 *   - registrations whose directory is gone are pruned, and a directory there
 *     with no registration is removed, save one still carrying a `.git` file:
 *     git can no longer read its uncommitted work, so it is reported as an
 *     unregistered checkout;
 *   - a dependency store no registered worktree links is removed, and so is a
 *     dead build's lock and staging directory.
 * Left alone: a locked worktree (the harness's agent trees), the suite's
 * `isolated-*` trees, which lib/isolated-worktree.js sweeps, a live build's
 * lock, staging and store, and anything changed within `YOUNG_MS` — a cut
 * registers its directory, and a build renames its store into place, moments
 * before the link that names it.
 */

/* Untraced: five minutes is room for a loaded machine. */
const YOUNG_MS = 5 * 60_000;
/* House: #4366. A finished job's own `updatedAt` is its finish clock, which
 * a resume that finishes again moves (#4368); a record without one holds its
 * tree. */
const KEEP_MS = 3 * 24 * 60 * 60_000;
const REAPED_RECORD = "wfc-reaped-worktrees.jsonl";
const HOLDER_RECORD = "wfc-holder.json";
const ISOLATED = /^isolated-/;
const STORE_KEY = new RegExp(`^[0-9a-f]{${KEY_HEX}}$`);
const BUILD_LOCK = /^\.build-([0-9a-f]+)\.lock$/;
const BUILD_STAGING = /^\.build-[0-9a-f]+-(\d+)$/;
const BUILD_FAILED = /^\.build-([0-9a-f]+)\.failed$/;
const ENDED = new Set(["done", "failed"]);
/* The script a reap pass runs as; a pidfile naming any other is stale. */
const REAP_HOLDERS = ["session-checkout.js"];
/* A dirt no marker records: an unread worktree defers to no issue. */
const UNREAD_DIRT = "\0unread";

/**
 * @typedef {{ dir: string, idleMs: number, last: string, dirty: number,
 *   unlanded: number, filed: string | null }} Stranded `filed` the
 *   orphaned-edit issue check-orphaned-edits.js filed for it while its dirt
 *   stood as it stands now, which carries its decision (#4439)
 * @typedef {{ removed: string[], stranded: Stranded[], unregistered: string[],
 *   pruned: string[], strays: string[], stores: string[], failed: string[],
 *   fetchFailed: string | null }} Reaped
 * @typedef {{ now: number, cwds: string[], record: string, common: string }}
 *   Pass when the pass runs, every live process's cwd, the REAPED_RECORD
 *   path, and the git common dir
 * @typedef {{ job: string, seat: string, path: string, head: string,
 *   at: string }} ReapedTree one line of REAPED_RECORD
 */

/**
 * Every process on this machine with a readable cwd, and that cwd. The real
 * /proc, whatever a test stands in.
 * @returns {{ pid: string, cwd: string }[]}
 */
function readProcesses() {
	/** @type {{ pid: string, cwd: string }[]} */
	const out = [];
	for (const pid of fs.readdirSync(REAL_PROC))
		if (/^\d+$/.test(pid)) {
			const cwd = readProcCwd(pid, REAL_PROC);
			if (cwd) out.push({ pid, cwd: cwd.replace(/ \(deleted\)$/, "") });
		}
	return out;
}

/**
 * Milliseconds since `at` was last written or renamed; Infinity where it is
 * gone.
 * @param {string} at
 * @param {number} now
 */
function ageOf(at, now) {
	const st = fs.lstatSync(at, { throwIfNoEntry: false });
	return st ? now - Math.max(st.mtimeMs, st.ctimeMs) : Number.POSITIVE_INFINITY;
}

/**
 * A worktree's dirty paths, its commits on neither `origin/main` nor its queue
 * ref, its last commit, and how long since that commit or an index write, the
 * later. The status takes no optional lock, so it never rewrites the index
 * whose age it reads; it leaves out the store link, which an adopter's
 * `node_modules/` ignore, matching directories only, would show untracked.
 * @param {string} dir
 * @param {number} now
 * @param {string} root the main checkout
 * @returns {Omit<Stranded, "filed">}
 */
function readWorktreeState(dir, now, root) {
	const dirty = git(
		[
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--",
			".",
			":(top,exclude)node_modules",
		],
		dir,
	);
	const unlanded = Number(
		git(
			[
				"rev-list",
				"--count",
				"HEAD",
				"--not",
				...new Set([VERIFIED_REF, pushedRef({ root, tree: dir })]),
			],
			dir,
		),
	);
	const [at = "0", ...subject] = git(
		["log", "-1", "--format=%ct %h %s"],
		dir,
	).split(" ");
	const index = path.join(adminDirOf(dir), "index");
	const written = fs.statSync(index, { throwIfNoEntry: false })?.mtimeMs ?? 0;
	return {
		dir,
		idleMs: now - Math.max(written, Number(at) * 1000),
		last: subject.join(" "),
		dirty: dirty ? dirty.split("\n").length : 0,
		unlanded,
	};
}

/**
 * Every linked worktree of `root`; a throw where git will not list them, as
 * each would then read unregistered.
 * @param {string} root
 * @returns {string[]}
 */
function readWorktreesOrThrow(root) {
	const registered = readLinkedWorktrees(root);
	if (registered === null)
		throw new Error(
			`git would not list the worktrees of ${root}, so none can be judged — run \`git worktree list\` there to see why`,
		);
	return registered;
}

/**
 * The session worktrees in `base`, judged by REAP's rules.
 * @param {string} root
 * @param {string} base the worktrees folder
 * @param {Pass} pass
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 * @returns {string[]} every registered worktree still standing
 */
function reapWorktrees(root, base, { cwds, now, record, common }, out) {
	const registered = readWorktreesOrThrow(root);
	const jobs = readJobCwds();
	const occupied = [
		...cwds,
		...jobs
			.filter(
				(j) =>
					j.state === null ||
					!ENDED.has(j.state) ||
					j.at === 0 ||
					now - j.at < KEEP_MS,
			)
			.map((j) => j.cwd),
	];
	const live = readLiveOrLog("session-checkout reap");
	/** @type {string[]} */
	const standing = [];
	for (const dir of registered) {
		if (
			path.dirname(dir) !== base ||
			ISOLATED.test(path.basename(dir)) ||
			!fs.existsSync(dir) ||
			ageOf(dir, now) < YOUNG_MS ||
			occupied.some((cwd) => worktreeHolding(cwd, [dir]))
		) {
			standing.push(dir);
			continue;
		}
		try {
			const admin = adminDirOf(dir);
			if (
				fs.existsSync(path.join(admin, "locked")) ||
				isHeldByLiveSession(admin, live)
			) {
				standing.push(dir);
				continue;
			}
			const state = readWorktreeState(dir, now, root);
			if (state.dirty > 0 || state.unlanded > 0) {
				out.stranded.push({
					...state,
					filed: readWorktreeFiling(
						common,
						worktreeLabel(root, dir),
						readWorktreeDirt(dir) ?? [UNREAD_DIRT],
					),
				});
				standing.push(dir);
				continue;
			}
			recordReaped(
				{ record, now },
				dir,
				jobs.filter((j) => worktreeHolding(j.cwd, [dir])),
			);
			const link = path.join(dir, "node_modules");
			if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink())
				fs.unlinkSync(link);
			git(["worktree", "remove", dir], root);
			out.removed.push(dir);
		} catch (err) {
			out.failed.push(`${dir}: ${caught(err).message.trim()}`);
			standing.push(dir);
		}
	}
	return standing;
}

/**
 * Append a line to REAPED_RECORD for each job whose cwd lies in `dir`, with
 * its `HEAD` sha.
 * @param {Pick<Pass, "record" | "now">} pass
 * @param {string} dir
 * @param {import("./session-worktrees.js").JobCwd[]} owners
 */
function recordReaped({ record, now }, dir, owners) {
	if (owners.length === 0) return;
	const head = git(["rev-parse", "HEAD"], dir);
	const at = new Date(now).toISOString();
	fs.appendFileSync(
		record,
		owners
			.map(
				(j) =>
					`${JSON.stringify(/** @type {ReapedTree} */ ({ job: j.id, seat: j.seat, path: dir, head, at }))}\n`,
			)
			.join(""),
	);
}

/**
 * The last REAPED_RECORD line for job `id`; null where none names it.
 * @param {string} record
 * @param {string} id
 * @returns {ReapedTree | null}
 */
function readReaped(record, id) {
	/** @type {ReapedTree | null} */
	let last = null;
	for (const r of readJsonl(record)?.rows ?? []) {
		const { job, seat, path: dir, head, at } = r;
		if (
			job === id &&
			typeof seat === "string" &&
			typeof dir === "string" &&
			typeof head === "string" &&
			typeof at === "string"
		)
			last = { job, seat, path: dir, head, at };
	}
	return last;
}

/**
 * Every directory in `base` git has no registration for and no live process
 * works in.
 * @param {string} base
 * @param {string[]} standing
 * @param {Pass} pass
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 */
function reapStrays(base, standing, { cwds, now }, out) {
	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		const dir = path.join(base, entry.name);
		if (
			!entry.isDirectory() ||
			dir === path.join(base, path.basename(STORES)) ||
			ISOLATED.test(entry.name) ||
			standing.includes(dir) ||
			ageOf(dir, now) < YOUNG_MS ||
			cwds.some((cwd) => worktreeHolding(cwd, [dir]))
		)
			continue;
		if (fs.existsSync(path.join(dir, ".git"))) {
			out.unregistered.push(dir);
			continue;
		}
		try {
			removeTree(dir);
			out.strays.push(dir);
		} catch (err) {
			out.failed.push(`${dir}: ${caught(err).message.trim()}`);
		}
	}
}

/**
 * The store each of `standing` links its `node_modules` to.
 * @param {string[]} standing
 * @returns {Set<string>}
 */
function readLinkedStores(standing) {
	const linked = new Set();
	for (const dir of standing)
		try {
			const target = fs.readlinkSync(path.join(dir, "node_modules"));
			linked.add(path.dirname(path.resolve(dir, target)));
		} catch {
			/* No link: a worktree with no lockfile, or a real directory. */
		}
	return linked;
}

/**
 * Remove each dead build's lock; the store keys a live build holds.
 * @param {string} storesDir
 * @param {string[]} names
 * @param {number} now
 * @returns {Set<string>}
 */
function sweepBuildLocks(storesDir, names, now) {
	const building = new Set();
	for (const name of names) {
		const key = BUILD_LOCK.exec(name)?.[1];
		if (key === undefined) continue;
		const lock = path.join(storesDir, name);
		/* Null: released since the listing. */
		const holder = readLockHolder(lock) ?? 0;
		if (holder > 0 && pidAlive(holder)) building.add(key);
		else if (ageOf(lock, now) >= YOUNG_MS) fs.rmSync(lock, { force: true });
	}
	return building;
}

/**
 * Every store not in `kept`, and every dead build's staging directory,
 * removed.
 * @param {string} storesDir
 * @param {Set<string>} kept the stores a standing worktree links, and the one
 *   WARM keeps for the next cut
 * @param {number} now
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 */
function reapStores(storesDir, kept, now, out) {
	if (!fs.existsSync(storesDir)) return;
	const names = fs.readdirSync(storesDir);
	const building = sweepBuildLocks(storesDir, names, now);
	for (const name of names) {
		const at = path.join(storesDir, name);
		const builder = BUILD_STAGING.exec(name)?.[1];
		const unused =
			builder === undefined
				? STORE_KEY.test(name) &&
					!building.has(name) &&
					!kept.has(at) &&
					ageOf(at, now) >= YOUNG_MS &&
					ageOf(path.join(at, "node_modules"), now) >= YOUNG_MS
				: !pidAlive(Number(builder));
		if (!unused) continue;
		try {
			removeTree(at);
			if (builder === undefined) out.stores.push(at);
		} catch (err) {
			out.failed.push(`${at}: ${caught(err).message.trim()}`);
		}
	}
}

/**
 * Remove each build failure record of a store no longer kept.
 * @param {string} storesDir
 * @param {Set<string>} kept as reapStores's
 */
function sweepBuildFailures(storesDir, kept) {
	if (!fs.existsSync(storesDir)) return;
	for (const name of fs.readdirSync(storesDir)) {
		const key = BUILD_FAILED.exec(name)?.[1];
		if (key !== undefined && !kept.has(path.join(storesDir, key)))
			fs.rmSync(path.join(storesDir, name), { force: true });
	}
}

/**
 * Prune every registration whose directory is gone; the worktree name each
 * pruned, from git's report, which it writes on stderr.
 * @param {string} root
 * @returns {string[]}
 */
function prune(root) {
	const r = spawnGitSync(["worktree", "prune", "--verbose"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(`git worktree prune exited ${r.status}: ${r.stderr}`);
	return [
		...`${r.stdout}${r.stderr}`.matchAll(/^Removing worktrees\/([^:]+):/gm),
	].map((m) => m[1] ?? "");
}

/**
 * REAP, above. One pass runs at a time per repository; another finds it busy.
 * @param {string} cwd anywhere in the repository
 * @returns {Reaped | { busy: number | null }}
 */
function reap(cwd) {
	const now = Date.now();
	const root = rootOf(cwd);
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const lock = pidLock(path.join(common, "wfc-reap.pid"), REAP_HOLDERS);
	if (!lock.acquire()) return { busy: lock.holder() };
	try {
		/** @type {Reaped} */
		const out = {
			removed: [],
			stranded: [],
			unregistered: [],
			pruned: [],
			strays: [],
			stores: [],
			failed: [],
			fetchFailed: null,
		};
		const record = path.join(common, REAPED_RECORD);
		/* With `landing` off no session worktree is cut, and none can be
		 * judged landed. */
		const judged = moduleOn("landing", { root });
		if (judged)
			try {
				fetchShared(root);
			} catch (err) {
				/* A stale `origin/main` only reads more work as unlanded. */
				out.fetchFailed = caught(err).message.trim();
			}
		out.pruned = prune(root);
		const base = path.join(root, WORKTREES);
		if (!fs.existsSync(base)) return out;
		const pass = {
			now,
			cwds: readProcesses().map((p) => deref(p.cwd)),
			record,
			common,
		};
		const standing = judged
			? reapWorktrees(root, base, pass, out)
			: readWorktreesOrThrow(root);
		reapStrays(base, standing, pass, out);
		const storesDir = path.join(root, STORES);
		const kept = readLinkedStores(standing);
		/* Residual: after a failed fetch this keeps the store of a stale
		 * `origin/main`'s lockfile, one store more than the next cut uses,
		 * until a pass whose fetch succeeds. */
		const startLock = judged ? buildStartSource(root)(LOCKFILE) : null;
		if (startLock !== null)
			kept.add(path.join(storesDir, storeKeyOf(startLock)));
		reapStores(storesDir, kept, now, out);
		sweepBuildFailures(storesDir, kept);
		return out;
	} finally {
		lock.release();
	}
}

/**
 * Job `id`'s worktree, re-added at the sha REAPED_RECORD holds
 * for it where the reaper removed it, and the seat to attach the job on.
 * @param {string} cwd anywhere in the repository
 * @param {string} id the job id, as `claude attach` takes it
 * @returns {{ dir: string, seat: string, restored: boolean }}
 */
function reopen(cwd, id) {
	const root = rootOf(cwd);
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const reaped = readReaped(path.join(common, REAPED_RECORD), id);
	const job = readJobCwds()
		.filter((j) => j.id === id)
		.sort((a, b) => b.at - a.at)
		.at(0);
	/** @type {{ seat: string, dir: string } | null} */
	let found = null;
	if (reaped) found = { seat: job?.seat ?? reaped.seat, dir: reaped.path };
	else if (job) found = { seat: job.seat, dir: job.cwd };
	if (found === null)
		throw new CheckoutError(
			`no seat holds job ${id} and the reaper recorded no worktree for it — check the id against \`claude agents\``,
		);
	const { seat, dir } = found;
	if (fs.existsSync(dir)) return { dir, seat, restored: false };
	if (!reaped)
		throw new CheckoutError(
			`job ${id}'s directory ${dir} is gone and the reaper recorded no sha for it, so nothing can rebuild it`,
		);
	/* A registration whose directory went by hand would refuse the add. */
	prune(root);
	addWorktree(root, dir, reaped.head);
	return { dir, seat, restored: true };
}

module.exports = {
	attach,
	CheckoutError,
	cut,
	isSessionWorktreeDir,
	land,
	launchDir,
	reap,
	reopen,
	STORES,
	warm,
};
