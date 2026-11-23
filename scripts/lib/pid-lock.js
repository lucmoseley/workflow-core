const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
	readOwnIdentity,
	pidAlive,
	readCurrentBootId,
	readProcStartOf,
} = require("./arbiter-proc.js");
const { asidePath } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { REAL_PROC } = require("./proc-root.js");
const { sleepSync } = require("./sleep-sync.js");

// guess, #3539
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

/** @param {string} file */
function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

class NotALock extends Error {
	/** @param {string} file */
	constructor(file) {
		super(
			`${file} is neither a regular file nor a symlink to one or to nothing, so no lock can be taken there`,
		);
	}
}

/**
 * @param {string} file
 * @returns {fs.Stats | null}
 */
function readTargetStat(file) {
	try {
		return fs.statSync(file, { throwIfNoEntry: false }) ?? null;
	} catch {
		return null;
	}
}

/**
 * @typedef {{pid: number, procStart?: string|null, bootId?: string|null}} HolderRecord
 */

const buildOwnRecord = () => JSON.stringify(readOwnIdentity(REAL_PROC));

/**
 * @param {string|null} text
 * @returns {HolderRecord|null}
 */
function parseRecord(text) {
	let parsed;
	try {
		parsed = JSON.parse(String(text));
	} catch {
		return null;
	}
	const record = typeof parsed === "number" ? { pid: parsed } : parsed;
	return Number.isInteger(record?.pid) && record.pid > 0 ? record : null;
}

/** @param {HolderRecord} record */
function isOtherProcess({ pid, procStart, bootId }) {
	const boot = readCurrentBootId();
	if (bootId && boot && bootId !== boot) return true;
	const start = readProcStartOf(pid, REAL_PROC);
	return Boolean(procStart) && start !== null && start !== String(procStart);
}

/**
 * @param {string} file
 * @param {string | string[]} marker
 */
function pidLock(file, marker) {
	const markers = [marker].flat();
	/**
	 * @param {string|null} text
	 * @returns {number|null}
	 */
	const liveHolder = (text) => {
		const record = parseRecord(text);
		if (!record || !pidAlive(record.pid) || isOtherProcess(record)) return null;
		const { pid } = record;
		const cmdline = readText(`${REAL_PROC}/${pid}/cmdline`);
		if (cmdline === null) return pidAlive(pid) ? pid : null;
		const runs = cmdline
			.split("\0")
			.some((arg) => markers.includes(path.basename(arg)));
		return runs ? pid : null;
	};

	const readPidfile = () => {
		const st = fs.lstatSync(file, { throwIfNoEntry: false });
		const target = st?.isSymbolicLink() ? readTargetStat(file) : st;
		if (target && !target.isFile()) throw new NotALock(file);
		return readText(file);
	};

	const aside = () =>
		asidePath(file, process.pid, crypto.randomBytes(4).toString("hex"));

	const writeReady = () => {
		const ready = aside();
		fs.writeFileSync(ready, buildOwnRecord(), { flag: "wx" });
		return ready;
	};

	const create = () => {
		const ready = writeReady();
		try {
			fs.linkSync(ready, file);
			return true;
		} catch (err) {
			if (caught(err).code !== "EEXIST") throw err;
			return false;
		} finally {
			fs.rmSync(ready, { force: true });
		}
	};

	/** @param {string|null} seen */
	const removeStale = (seen) => {
		const moved = aside();
		try {
			fs.renameSync(file, moved);
		} catch (err) {
			if (caught(err).code === "ENOENT") return true;
			throw err;
		}
		if (readText(moved) === seen) {
			fs.rmSync(moved, { force: true });
			return true;
		}
		fs.renameSync(moved, file);
		return false;
	};

	/** @param {string|null} seen */
	const keepOwn = (seen) => {
		if (seen !== buildOwnRecord()) fs.renameSync(writeReady(), file);
		return true;
	};

	return {
		holder: () => liveHolder(readText(file)),
		/** @returns {boolean} */
		acquire() {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (create()) return true;
				const seen = readPidfile();
				const held = liveHolder(seen);
				if (held === process.pid) return keepOwn(seen);
				if (held !== null || !removeStale(seen)) return false;
			}
			return false;
		},
		release() {
			const record = parseRecord(readText(file));
			if (record?.pid === process.pid && !isOtherProcess(record))
				fs.rmSync(file, { force: true });
		},
	};
}

/**
 * @param {ReturnType<typeof pidLock>} lock
 * @param {number} [waitMs]
 * @returns {boolean}
 */
function waitForLock(lock, waitMs = LOCK_WAIT_MS) {
	const deadline = performance.now() + waitMs;
	while (!lock.acquire()) {
		if (performance.now() > deadline) return false;
		sleepSync(LOCK_POLL_MS);
	}
	return true;
}

module.exports = { LOCK_WAIT_MS, NotALock, pidLock, waitForLock };
