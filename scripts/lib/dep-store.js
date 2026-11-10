/*
 * dep-store.js — the dependency stores session worktrees link their
 * `node_modules` to (#4229).
 *
 * ATTACH points the worktree's `node_modules` at the dependency store keyed by
 * the hash of the worktree's own `package-lock.json`, building that store
 * first where none exists. A store is built once, into a staging directory
 * (lib/npm-ci-staging.js) renamed into place whole, and is never installed
 * into again. One build runs per key: a cut finding a live builder's lock waits for
 * its store rather than running a second `npm ci` against the memory cap.
 *
 * RELINK re-points a worktree whose lockfile a merge, pull or checkout
 * changed at the store standing for the new one, building none (#4702);
 * `.husky/post-merge`, `post-checkout` and, on a commit changing the lockfile,
 * `post-commit` run it, through lib/relink-store.sh. Nothing relinks after a
 * `git reset`, `stash` or `restore` run by hand: `relink` or `attach` does. A merge's `pre-merge-commit` gates run before it, on the
 * store linked before the merge: the lander's install keys on the merged
 * lockfile, and its full suite is what moves `main`.
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
 * THE STORES LIVE UNDER lib/worktree-dirs.js `STORES`, inside the worktrees
 * folder, so the ignores every tool already carries for that folder cover
 * them too.
 *
 * REAP-STORES, run by each reap pass, removes a store no standing worktree
 * links, save `origin/main`'s, and a dead build's lock, staging directory and
 * failure record.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const {
	CheckoutError,
	fetchShared,
	POLL_MS,
	rootOf,
} = require("./checkout-repo.js");
const { readText } = require("./file-read.js");
const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const {
	INSTALL_TIMEOUT_MS,
	LOCKFILE,
	stageInstall,
} = require("./npm-ci-staging.js");
const { scriptPath } = require("./script-path.js");
const { sleepSync } = require("./sleep-sync.js");
const { moduleOn } = require("./workflow-core-config.js");
const { STORES } = require("./worktree-dirs.js");

/* 64 bits of sha256: a collision among even 10^4 live lockfiles is ~3e-12
 * likely, and the name stays short enough to read in a path. */
const KEY_HEX = 16;
/* Untraced: five minutes is room for a loaded machine. A cut registers its
 * directory, and a build renames its store into place, moments before the
 * link that names it, so nothing younger is reaped. */
const YOUNG_MS = 5 * 60_000;
const STORE_KEY = new RegExp(`^[0-9a-f]{${KEY_HEX}}$`);
const BUILD_LOCK = /^\.build-([0-9a-f]+)\.lock$/;
const BUILD_STAGING = /^\.build-[0-9a-f]+-(\d+)$/;
const BUILD_FAILED = /^\.build-([0-9a-f]+)\.failed$/;

/** @typedef {import("./worktree-reaper.js").Reaped} Reaped */

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
	return readOrThrow(lock, (text) => Number(text.trim()) || 0);
}

/**
 * The failure the last build of a store left, or null where none did.
 * @param {string} failed the store's failure record
 * @returns {string | null}
 */
function readBuildFailure(failed) {
	return readOrThrow(failed, (text) => text.trim());
}

/**
 * `file`'s text through `parse`; null where it is absent, a throw where it
 * will not read.
 * @template T
 * @param {string} file
 * @param {(text: string) => T} parse
 * @returns {T | null}
 */
function readOrThrow(file, parse) {
	const r = readText(file);
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? parse(r.data) : null;
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

/** @typedef {import("./npm-ci-staging.js").ManifestSource} ManifestSource */

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
	let built;
	try {
		built = stageInstall(staging, (name) =>
			name === LOCKFILE ? lockfile : source(name),
		);
	} catch (err) {
		throw new Error(`${caught(err).message}, then attach again`, {
			cause: err,
		});
	}
	setWriteBits(built, false);
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
	const held = fs.lstatSync(link, { throwIfNoEntry: false });
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
 * The store a session worktree's `node_modules` links, or null where it links none.
 * @param {string} dir
 * @param {string} storesDir
 * @returns {string | null}
 */
function readLinkedStore(dir, storesDir) {
	let target;
	try {
		target = fs.readlinkSync(path.join(dir, "node_modules"));
	} catch (err) {
		/* ENOENT: never attached; EINVAL: a real directory, as the lander's. */
		if (["ENOENT", "EINVAL"].includes(String(caught(err).code))) return null;
		throw err;
	}
	const store = path.dirname(path.resolve(dir, target));
	return path.dirname(store) === storesDir ? store : null;
}

/**
 * Re-point a worktree whose `node_modules` links a store at the one standing
 * for the lockfile it now carries (#4702). Builds none, as git hooks run it within
 * HOOK_LIMIT_MS and a build takes up to INSTALL_TIMEOUT_MS, so a missing store
 * refuses naming `attach`, which builds it.
 * @param {string} cwd anywhere in the worktree
 * @returns {{ dir: string, store: string | null }} the store newly linked, or
 *   null where the worktree links no store or its link still matches
 */
function relink(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const storesDir = path.join(rootOf(dir), STORES);
	const linked = readLinkedStore(dir, storesDir);
	const lockfile = buildWorktreeSource(dir)(LOCKFILE);
	if (linked === null || lockfile === null) return { dir, store: null };
	const key = storeKeyOf(lockfile);
	if (path.basename(linked) === key) return { dir, store: null };
	if (!fs.existsSync(path.join(storesDir, key, "node_modules")))
		throw new CheckoutError(
			`${dir}'s lockfile changed, and no dependency store stands for it yet (${key}), so its node_modules still links the store built for the old one (${path.basename(linked)}) — run \`node ${scriptPath("session-checkout.js")} attach\` to build that store, up to ${INSTALL_TIMEOUT_MS / 60_000} min`,
		);
	return { dir, store: attach(dir, { noBuild: true }).store };
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
function removeUnusedStores(storesDir, kept, now, out) {
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
 * @param {Set<string>} kept as removeUnusedStores's
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
 * REAP-STORES, above.
 * @param {string} root the main checkout
 * @param {string[]} standing every registered worktree the pass left standing
 * @param {{ judged: boolean, now: number }} pass `judged` where `origin/main`
 *   names the next cut's store
 * @param {Reaped} out accumulator: what the pass removed and failed on is pushed here
 */
function reapStores(root, standing, { judged, now }, out) {
	const storesDir = path.join(root, STORES);
	const kept = readLinkedStores(standing);
	/* Residual: after a failed fetch this keeps the store of a stale
	 * `origin/main`'s lockfile, one store more than the next cut uses,
	 * until a pass whose fetch succeeds. */
	const startLock = judged ? buildStartSource(root)(LOCKFILE) : null;
	if (startLock !== null) kept.add(path.join(storesDir, storeKeyOf(startLock)));
	removeUnusedStores(storesDir, kept, now, out);
	sweepBuildFailures(storesDir, kept);
}

module.exports = {
	ageOf,
	attach,
	reapStores,
	relink,
	removeTree,
	warm,
	YOUNG_MS,
};
