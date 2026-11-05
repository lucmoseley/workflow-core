/*
 * session-checkout.js — the one owner of a session worktree's lifecycle
 * (#4229): every launcher and session goes through it, and no caller runs
 * `git worktree` itself.
 *
 * CUT fetches `landing`, adds a worktree detached at `origin/landing` under
 * `.claude/worktrees/<session-name>/` of the main checkout, and attaches its
 * dependencies.
 *
 * LAUNCH-DIR is the directory a launcher starts a session in (#4245): a
 * worktree cut for it where the repository lands through `landing`, else the
 * main checkout, since a repository without the `landing` module has no
 * `origin/landing` to cut from. Its name is the prompt's words and a random
 * suffix, so a session's worktree reads as its task. A resume runs in
 * the directory its job recorded, so it reopens the same worktree.
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
 * REAP clears landed worktrees and unlinked stores.
 *
 * REOPEN gives a finished background job its worktree back so `claude attach`
 * can wake it: an open from the agents view fails before any hook runs where
 * the tree is gone (#4368).
 */

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
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
const { readJsonl } = require("./jsonl.js");
const { mainCheckout } = require("./main-checkout.js");
const { pidLock } = require("./pid-lock.js");
const { REAL_PROC } = require("./proc-root.js");
const { scriptPath } = require("./script-path.js");
const {
	readJobCwds,
	readLinkedWorktrees,
	worktreeHolding,
} = require("./session-worktrees.js");
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
	return addWorktree(root, dir, "origin/landing");
}

/**
 * Add a worktree at `dir` detached at `rev`, its dependencies attached; one
 * whose attach fails is removed.
 * @param {string} root the main checkout
 * @param {string} dir
 * @param {string} rev
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function addWorktree(root, dir, rev) {
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	git(["worktree", "add", "--quiet", "--detach", dir, rev], root);
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
 * LAUNCH-DIR, above.
 * @param {string} cwd anywhere in the repository
 * @param {string} prompt
 * @returns {string}
 */
function launchDir(cwd, prompt) {
	const root = rootOf(cwd);
	return moduleOn("landing", { root })
		? cut(root, buildSessionName(prompt)).dir
		: root;
}

/*
 * REAP, run on each refill-loop tick, clears what the worktrees folder no
 * longer needs and names what it may not clear:
 *   - a session worktree whose every `HEAD` commit is on a freshly fetched
 *     `origin/landing`, whose tree is clean, and whose session is neither live
 *     (a process's cwd lies in it), resumable (a job record whose cwd lies in
 *     it is in any state but `done` or `failed`) nor finished under `KEEP_MS`
 *     ago is removed, its path, `HEAD` sha, and each job's id and seat whose
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
const ISOLATED = /^isolated-/;
const STORE_KEY = new RegExp(`^[0-9a-f]{${KEY_HEX}}$`);
const BUILD_LOCK = /^\.build-([0-9a-f]+)\.lock$/;
const BUILD_STAGING = /^\.build-[0-9a-f]+-(\d+)$/;
const ENDED = new Set(["done", "failed"]);
/* The script a reap pass runs as; a pidfile naming any other is stale. */
const REAP_HOLDERS = ["session-checkout.js"];

/**
 * @typedef {{ dir: string, idleMs: number, last: string, dirty: number,
 *   unlanded: number }} Stranded
 * @typedef {{ removed: string[], stranded: Stranded[], unregistered: string[],
 *   pruned: string[], strays: string[], stores: string[], failed: string[],
 *   fetchFailed: string | null }} Reaped
 * @typedef {{ now: number, cwds: string[], record: string }} Pass when the
 *   pass runs, every live process's cwd, and the REAPED_RECORD path
 * @typedef {{ job: string, seat: string, path: string, head: string,
 *   at: string }} ReapedTree one line of REAPED_RECORD
 */

/**
 * Every directory some process on this machine has as its cwd. The real
 * /proc, whatever a test stands in.
 * @returns {string[]}
 */
function readProcessCwds() {
	/** @type {string[]} */
	const out = [];
	for (const pid of fs.readdirSync(REAL_PROC))
		if (/^\d+$/.test(pid)) {
			const cwd = readProcCwd(pid, REAL_PROC);
			if (cwd) out.push(cwd.replace(/ \(deleted\)$/, ""));
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
 * A worktree's dirty paths, its commits not on `origin/landing`, its last
 * commit, and how long since that commit or an index write, the later. The
 * status takes no optional lock, so it never rewrites the index whose age it
 * reads; it leaves out the store link, which an adopter's `node_modules/`
 * ignore, matching directories only, would show untracked.
 * @param {string} dir
 * @param {number} now
 * @returns {Stranded}
 */
function readWorktreeState(dir, now) {
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
		git(["rev-list", "--count", "HEAD", "--not", "origin/landing"], dir),
	);
	const [at = "0", ...subject] = git(
		["log", "-1", "--format=%ct %h %s"],
		dir,
	).split(" ");
	const index = path.join(
		git(["rev-parse", "--absolute-git-dir"], dir),
		"index",
	);
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
function reapWorktrees(root, base, { cwds, now, record }, out) {
	const registered = readWorktreesOrThrow(root);
	const jobs = readJobCwds();
	const held = [
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
	/** @type {string[]} */
	const standing = [];
	for (const dir of registered) {
		if (
			path.dirname(dir) !== base ||
			ISOLATED.test(path.basename(dir)) ||
			!fs.existsSync(dir) ||
			ageOf(dir, now) < YOUNG_MS ||
			held.some((cwd) => worktreeHolding(cwd, [dir]))
		) {
			standing.push(dir);
			continue;
		}
		try {
			const admin = git(["rev-parse", "--absolute-git-dir"], dir);
			if (fs.existsSync(path.join(admin, "locked"))) {
				standing.push(dir);
				continue;
			}
			const state = readWorktreeState(dir, now);
			if (state.dirty > 0 || state.unlanded > 0) {
				out.stranded.push(state);
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
		let holder = 0;
		try {
			holder = Number(fs.readFileSync(lock, "utf8").trim());
		} catch {
			/* Released since the listing. */
		}
		if (holder > 0 && pidAlive(holder)) building.add(key);
		else if (ageOf(lock, now) >= YOUNG_MS) fs.rmSync(lock, { force: true });
	}
	return building;
}

/**
 * Every store no worktree in `standing` links, and every dead build's
 * staging directory, removed.
 * @param {string} storesDir
 * @param {string[]} standing
 * @param {number} now
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 */
function reapStores(storesDir, standing, now, out) {
	if (!fs.existsSync(storesDir)) return;
	const names = fs.readdirSync(storesDir);
	const linked = readLinkedStores(standing);
	const building = sweepBuildLocks(storesDir, names, now);
	for (const name of names) {
		const at = path.join(storesDir, name);
		const builder = BUILD_STAGING.exec(name)?.[1];
		const unused =
			builder === undefined
				? STORE_KEY.test(name) &&
					!building.has(name) &&
					!linked.has(at) &&
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
				fetchLanding(root);
			} catch (err) {
				/* A stale `origin/landing` only reads more work as unlanded. */
				out.fetchFailed = caught(err).message.trim();
			}
		out.pruned = prune(root);
		const base = path.join(root, WORKTREES);
		if (!fs.existsSync(base)) return out;
		const pass = { now, cwds: readProcessCwds().map(deref), record };
		const standing = judged
			? reapWorktrees(root, base, pass, out)
			: readWorktreesOrThrow(root);
		reapStrays(base, standing, pass, out);
		reapStores(path.join(root, STORES), standing, now, out);
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
	land,
	launchDir,
	reap,
	reopen,
	STORES,
};
