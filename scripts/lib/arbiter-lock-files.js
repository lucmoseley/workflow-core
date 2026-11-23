const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const regions = require("./doc-map-regions.js");
const core = require("./arbiter-core.js");
const { isLockRecord, isReadableLock } = require("./arbiter-records.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ReadLock} ReadLock */

// guess, #5529
const DEBRIS_AGE_MS = 60 * 60 * 1000;

/** @param {string} lockPath */
function renameAside(lockPath) {
	const aside = `${lockPath}.stale-${crypto.randomBytes(6).toString("hex")}`;
	try {
		fs.renameSync(lockPath, aside);
	} catch {
		return null;
	}
	ignoreFailure(() => {
		const now = new Date();
		fs.utimesSync(aside, now, now);
	});
	return aside;
}

/**
 * @param {string} aside
 * @param {string} lockPath
 */
function restoreAside(aside, lockPath) {
	try {
		fs.linkSync(aside, lockPath);
	} catch {
		return false;
	}
	ignoreFailure(() => fs.unlinkSync(aside));
	return true;
}

/**
 * @param {string} rel
 * @param {(lock: LockRecord) => boolean} isDroppable
 */
function dropIfUnchanged(rel, isDroppable) {
	const aside = renameAside(core.paths.lock(rel));
	if (aside === null) return { outcome: "contended", moved: null };

	const moved = core.readRecordOrLogAs(aside, `drop ${rel}`, isLockRecord);
	if (moved !== null && isDroppable(moved)) {
		ignoreFailure(() => fs.unlinkSync(aside));
		return { outcome: "dropped", moved };
	}
	return {
		outcome: "kept",
		moved,
		restored: restoreAside(aside, core.paths.lock(rel)),
	};
}

/**
 * @param {string} rel
 * @param {(lock: LockRecord) => boolean} isOurs
 * @param {(lock: LockRecord) => LockRecord} mutate
 */
function updateIfUnchanged(rel, isOurs, mutate) {
	const lockPath = core.paths.lock(rel);
	const aside = renameAside(lockPath);
	if (aside === null) return { outcome: "contended", lock: null };

	const moved = core.readRecordOrLogAs(aside, `update ${rel}`, isLockRecord);
	if (moved !== null && isOurs(moved)) {
		const updated = mutate({ ...moved });
		if (core.createOnce(lockPath, updated)) {
			ignoreFailure(() => fs.unlinkSync(aside));
			return { outcome: "updated", lock: updated };
		}
	}
	return {
		outcome: "kept",
		lock: moved,
		restored: restoreAside(aside, lockPath),
	};
}

// guess, lucmoseley/mantahostels#1691
const TORN_SETTLE_MS = 50;

function settle(ms = TORN_SETTLE_MS) {
	sleepSync(ms);
}

/**
 * @param {() => void} [pause]
 * @returns {ReadLock[]|null}
 */
function readLocks(pause = settle) {
	const dir = core.paths.locksDir();
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		core.logError("list", e);
		return null;
	}
	/** @param {string} full */
	const aged = (full) => {
		try {
			return Date.now() - fs.statSync(full).mtimeMs > DEBRIS_AGE_MS;
		} catch {
			return false;
		}
	};
	/**
	 * @param {string} f
	 * @param {boolean} settled
	 * @returns {ReadLock|{file: string, torn: true}|null}
	 */
	const judge = (f, settled) => {
		const full = path.join(dir, f);
		let probe;
		try {
			probe = core.probeRecord(full, isLockRecord);
		} catch (e) {
			core.logError("list", e);
			return { file: f, unreadable: true, reason: "refused" };
		}
		if (probe.state === "absent") return null;
		if (probe.state === "ok") return probe.record;
		if (!settled && !aged(full)) return { file: f, torn: true };
		return { file: f, unreadable: true, reason: "unparseable" };
	};

	const first = files.map((f) => ({ f, l: judge(f, false) }));
	const anyTorn = first.some(({ l }) => l && "torn" in l);
	if (anyTorn) pause();
	/** @type {ReadLock[]} */
	const locks = [];
	for (const { f, l } of first) {
		const judged = l && "torn" in l ? judge(f, true) : l;
		if (judged && !("torn" in judged)) locks.push(judged);
	}
	return locks;
}

/** @param {string|null} sessionId */
function readHeldBy(sessionId) {
	return readLocksHeldBy(sessionId)?.map((l) => l.path) ?? null;
}

/**
 * @param {string|null} sessionId
 * @returns {LockRecord[]|null}
 */
function readLocksHeldBy(sessionId) {
	if (!sessionId) return null;
	const locks = readLocks();
	if (locks === null) return null;
	return locks.filter(isReadableLock).filter((l) => l.sessionId === sessionId);
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {LockRecord|null}
 */
function readOwnLockOnFile(rel, sessionId) {
	const file = core.subjectPath(rel);
	const direct = core.readRecordOrLogAs(
		core.paths.lock(file),
		`observe ${file}`,
		isLockRecord,
	);
	if (direct?.sessionId === sessionId) return direct;
	if (regions.isRegioned(file)) {
		const onFile = (readLocks() || [])
			.filter(isReadableLock)
			.filter((l) => core.splitSubject(l.path).rel === file);
		const mine = onFile.find((l) => l.sessionId === sessionId);
		if (mine) return mine;
		if (direct) return direct;
		return onFile[0] ?? null;
	}
	return direct;
}

module.exports = {
	DEBRIS_AGE_MS,
	dropIfUnchanged,
	readHeldBy,
	readLocks,
	readLocksHeldBy,
	readOwnLockOnFile,
	renameAside,
	restoreAside,
	settle,
	updateIfUnchanged,
};
