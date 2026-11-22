const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const regions = require("./doc-map-regions.js");
const core = require("./arbiter-core.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */

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

	const moved = core.readRecordOrLog(aside, `drop ${rel}`);
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

	const moved = core.readRecordOrLog(aside, `update ${rel}`);
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

/** @param {() => void} [pause] */
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
	 */
	const judge = (f, settled) => {
		const full = path.join(dir, f);
		let probe;
		try {
			probe = core.probeRecord(full);
		} catch (e) {
			core.logError("list", e);
			return { file: f, unreadable: true, reason: "refused" };
		}
		if (probe.state === "absent") return null;
		if (probe.state !== "unparseable") return probe.record;
		if (!settled && !aged(full)) return { file: f, torn: true };
		return { file: f, unreadable: true, reason: "unparseable" };
	};

	const first = files.map((f) => ({ f, l: judge(f, false) }));
	if (!first.some(({ l }) => l?.torn))
		return first.map(({ l }) => l).filter(Boolean);
	pause();
	return first
		.map(({ f, l }) => (l?.torn ? judge(f, true) : l))
		.filter(Boolean);
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
	return /** @type {LockRecord[]} */ (
		locks.filter((l) => !l.unreadable && l.sessionId === sessionId)
	);
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readOwnLockOnFile(rel, sessionId) {
	const file = core.subjectPath(rel);
	const direct = core.readRecordOrLog(core.paths.lock(file), `observe ${file}`);
	if (direct?.sessionId === sessionId) return direct;
	if (regions.isRegioned(file)) {
		const all = readLocks() || [];
		const mine = all.find(
			(l) =>
				l &&
				!l.unreadable &&
				core.splitSubject(l.path).rel === file &&
				l.sessionId === sessionId,
		);
		if (mine) return mine;
		if (direct) return direct;
		return (
			all.find(
				(l) => l && !l.unreadable && core.splitSubject(l.path).rel === file,
			) || null
		);
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
