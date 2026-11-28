const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { caught, ignoreFailure } = require("./caught.js");
const {
	CheckoutError,
	fetchShared,
	POLL_MS,
	rootOf,
} = require("./checkout-repo.js");
const { readBytes, readText } = require("./file-read.js");
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
const { STORES } = require("./worktree-dirs.js");

// guess, #5529
const KEY_HEX = 16;
// guess, #5529
const YOUNG_MS = 5 * 60_000;
const STORE_KEY = new RegExp(`^[0-9a-f]{${KEY_HEX}}$`);
const BUILD_LOCK = /^\.build-([0-9a-f]+)\.lock$/;
const BUILD_STAGING = /^\.build-[0-9a-f]+-(\d+)$/;
const BUILD_FAILED = /^\.build-([0-9a-f]+)\.failed$/;
const WARM_FAILED = ".warm.failed";

/** @typedef {import("./worktree-reaper.js").Reaped} Reaped */

/**
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
 * @param {string} lock
 * @returns {number | null}
 */
function readLockHolder(lock) {
	return readOrThrow(lock, (text) => Number(text.trim()) || 0);
}

/**
 * @param {string} failed
 * @returns {string | null}
 */
function readBuildFailure(failed) {
	return readOrThrow(failed, (text) => text.trim());
}

/**
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

/** @param {string} dir */
function removeTree(dir) {
	if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory())
		setWriteBits(dir, true);
	fs.rmSync(dir, { recursive: true, force: true });
}

/** @typedef {import("./npm-ci-staging.js").ManifestSource} ManifestSource */

/**
 * @param {string} dir
 * @returns {ManifestSource}
 */
const buildWorktreeSource = (dir) => (name) => {
	const r = readBytes(path.join(dir, name));
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? r.data : null;
};

/**
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

/** @param {Buffer} lockfile */
const storeKeyOf = (lockfile) =>
	crypto.createHash("sha256").update(lockfile).digest("hex").slice(0, KEY_HEX);

/**
 * @typedef {{ store: string, state: "built" | "standing" | "building" }} Ensured
 */

/**
 * @param {string} key
 * @param {string} lock
 * @param {string} failed
 */
function buildNoStoreRefusal(key, lock, failed) {
	const head = `no dependency store stands for this lockfile yet (${key}), and this cut builds none`;
	const buildFailure = readBuildFailure(failed);
	const warmFailure = readBuildFailure(
		path.join(path.dirname(failed), WARM_FAILED),
	);
	const last =
		buildFailure === null
			? warmFailure !== null && `its last warm pass failed — ${warmFailure}`
			: `its last build failed — ${buildFailure}`;
	if (last)
		return new CheckoutError(
			`${head}; ${last} — so no tick launches this member until a warm pass (\`node ${scriptPath("session-checkout.js")} warm\`) builds it`,
		);
	const holder = readLockHolder(lock);
	return new CheckoutError(
		`${head}${holder && pidAlive(holder) ? ` — pid ${holder} is building it` : ""}; the refill tick's warm pass (\`node ${scriptPath("session-checkout.js")} warm\`) builds it, and the next tick launches this member`,
	);
}

/**
 * @param {string} root
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
 * @param {string} staging
 * @param {Buffer} lockfile
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
 * @param {string} cwd
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
	const tmp = `${link}.attach-${process.pid}`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(path.join(made.store, "node_modules"), tmp, "dir");
	fs.renameSync(tmp, link);
	return { dir, store: made.store, built: made.state === "built" };
}

/**
 * @param {string} dir
 * @param {string} storesDir
 * @returns {string | null}
 */
function readLinkedStore(dir, storesDir) {
	let target;
	try {
		target = fs.readlinkSync(path.join(dir, "node_modules"));
	} catch (err) {
		if (["ENOENT", "EINVAL"].includes(String(caught(err).code))) return null;
		throw err;
	}
	const store = path.dirname(path.resolve(dir, target));
	return path.dirname(store) === storesDir ? store : null;
}

/**
 * @param {string} cwd
 * @returns {{ dir: string, store: string | null }}
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
 * @param {string} cwd
 * @returns {Ensured | null}
 */
function warm(cwd) {
	const root = rootOf(cwd);
	const failed = path.join(root, STORES, WARM_FAILED);
	try {
		fetchShared(root);
	} catch (err) {
		const oneLine = caught(err)
			.message.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.join(" ");
		ignoreFailure(() => {
			fs.mkdirSync(path.dirname(failed), { recursive: true });
			fs.writeFileSync(failed, `${oneLine}\n`);
		});
		throw err;
	}
	fs.rmSync(failed, { force: true });
	return ensureStore(root, buildStartSource(root), { noWait: true });
}

/**
 * @param {string} at
 * @param {number} now
 */
function ageOf(at, now) {
	const st = fs.lstatSync(at, { throwIfNoEntry: false });
	return st ? now - Math.max(st.mtimeMs, st.ctimeMs) : Number.POSITIVE_INFINITY;
}

/**
 * @param {string[]} standing
 * @returns {Set<string>}
 */
function readLinkedStores(standing) {
	const linked = new Set();
	for (const dir of standing)
		ignoreFailure(() => {
			const target = fs.readlinkSync(path.join(dir, "node_modules"));
			linked.add(path.dirname(path.resolve(dir, target)));
		});
	return linked;
}

/**
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
		const holder = readLockHolder(lock) ?? 0;
		if (holder > 0 && pidAlive(holder)) building.add(key);
		else if (ageOf(lock, now) >= YOUNG_MS) fs.rmSync(lock, { force: true });
	}
	return building;
}

/**
 * @param {string} storesDir
 * @param {Set<string>} kept
 * @param {number} now
 * @param {Reaped} out
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
 * @param {string} storesDir
 * @param {Set<string>} kept
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
 * @param {string} root
 * @param {string[]} standing
 * @param {number} now
 * @param {Reaped} out
 */
function reapStores(root, standing, now, out) {
	const storesDir = path.join(root, STORES);
	const kept = readLinkedStores(standing);
	const startLock = buildStartSource(root)(LOCKFILE);
	if (startLock !== null) kept.add(path.join(storesDir, storeKeyOf(startLock)));
	removeUnusedStores(storesDir, kept, now, out);
	sweepBuildFailures(storesDir, kept);
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isDepLink(dir) {
	return (
		fs
			.lstatSync(path.join(dir, "node_modules"), { throwIfNoEntry: false })
			?.isSymbolicLink() ?? false
	);
}

/** @param {string} dir */
function unlinkDepLink(dir) {
	if (isDepLink(dir)) fs.unlinkSync(path.join(dir, "node_modules"));
}

module.exports = {
	ageOf,
	attach,
	reapStores,
	relink,
	removeTree,
	warm,
	isDepLink,
	unlinkDepLink,
	YOUNG_MS,
};
