/*
 * pid-lock.js — a single-instance lock held as a pidfile, for a daemon only
 * one copy of may run per machine or checkout: the refill loop and the
 * lander (#2402); for one run of a program that takes a live holder's lock
 * from no one however long it runs (#4016); and for a short read-to-rename
 * write, write-secret.js's (#3539) and the refill control's (#3856), which
 * waitForLock takes.
 *
 * The pidfile is linked into place from a file already holding the record, so
 * no reader ever sees it empty. It records the holder's pid, start time and
 * boot id (#4083): a start time alone can recur across boots. A pidfile whose
 * process is gone, whose record names another process than the one now on its
 * pid, or whose command line runs no file named as the daemon's script, is stale
 * and taken over. A bare pid, as a daemon started before the record holds, has only the
 * command line to go on, until that holder re-acquires and rewrites it. A process
 * re-exec'd under its own pid (the refill loop's adoption, #2361) keeps its start
 * time, so already holds it. A directory, FIFO or socket at the lock's path,
 * or a symlink to one, is no pidfile, and taking it over would fail midway or
 * block on the read: `acquire` throws `NotALock`, moving nothing (#3663,
 * #3715). A symlink to a regular file or to nothing is moved aside like any
 * stale pidfile.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
	pidAlive,
	readCurrentBootId,
	readProcStartOf,
} = require("./arbiter-proc.js");
const { asidePath } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { REAL_PROC } = require("./proc-root.js");
const { sleepSync } = require("./sleep-sync.js");

/* First guesses, and stated as ones: a short write holds its lock for
 * milliseconds, so a run waits 10 s for another's before refusing, polling
 * every 20 ms. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

/**
 * A file's text, or null where it cannot be read.
 * @param {string} file
 */
function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** Thrown where the lock's path holds something no pidfile is. */
class NotALock extends Error {
	/** @param {string} file */
	constructor(file) {
		super(
			`${file} is neither a regular file nor a symlink to one or to nothing, so no lock can be taken there`,
		);
	}
}

/**
 * What `file` names once a symlink is followed: null where nothing, or where
 * the link cannot be followed, which the read then meets as nothing too.
 * @param {string} file
 * @returns {fs.Stats | null}
 */
function readTargetStat(file) {
	try {
		return fs.statSync(file, { throwIfNoEntry: false }) ?? null;
	} catch {
		/* A symlink loop or an unreadable hop: readText reads nothing there, so
		 * it is taken over as a dangling link is (#3715). */
		return null;
	}
}

/**
 * @typedef {{pid: number, procStart?: string|null, bootId?: string|null}} HolderRecord
 */

/** The record this process holds a pidfile under, read off the real kernel. */
const buildOwnRecord = () =>
	JSON.stringify({
		pid: process.pid,
		procStart: readProcStartOf(process.pid, REAL_PROC),
		bootId: readCurrentBootId(),
	});

/**
 * A pidfile's record, a bare pid reading as one with only that; null where the
 * text names no pid.
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

/**
 * Whether the record proves the process on its pid is not the one that wrote it.
 * What cannot be read proves nothing, so a lock is never taken from a live holder
 * on doubt: arbiter-proc.js's holderAlive answers doubt the other way, so it does
 * not fit.
 * @param {HolderRecord} record
 */
function isOtherProcess({ pid, procStart, bootId }) {
	const boot = readCurrentBootId();
	if (bootId && boot && bootId !== boot) return true;
	const start = readProcStartOf(pid, REAL_PROC);
	return Boolean(procStart) && start !== null && start !== String(procStart);
}

/**
 * The lock at `file` for the script or scripts named `marker`: a holder's
 * command line must carry an argument whose basename is one of them, so
 * `start-lander.js` never passes for `queue-lander.js` (#2675).
 * @param {string} file
 * @param {string | string[]} marker
 */
function pidLock(file, marker) {
	const markers = [marker].flat();
	/** @param {string|null} text @returns {number|null} the live holder's pid */
	const liveHolder = (text) => {
		const record = parseRecord(text);
		if (!record || !pidAlive(record.pid) || isOtherProcess(record)) return null;
		const { pid } = record;
		/* pidAlive asked the real kernel, so its cmdline is read there too (#3587). */
		const cmdline = readText(`${REAL_PROC}/${pid}/cmdline`);
		/* A process that ended since the check above is no holder. Residual: a live
		 * pid's unreadable cmdline counts as the daemon's, so a lock is never taken
		 * from a live holder on doubt. */
		if (cmdline === null) return pidAlive(pid) ? pid : null;
		const runs = cmdline
			.split("\0")
			.some((arg) => markers.includes(path.basename(arg)));
		return runs ? pid : null;
	};

	/** The pidfile's text, or null where it cannot be read. @throws {NotALock} */
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

	/**
	 * Moves the stale pidfile reading `seen` aside. Where another taker has
	 * replaced it since it was read, that file is put back and false returned.
	 * Residual: a third taker linking in between the two renames is clobbered.
	 * @param {string|null} seen
	 */
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

	/**
	 * This process already holds the file reading `seen`, which may be a bare pid.
	 * @param {string|null} seen
	 */
	const keepOwn = (seen) => {
		if (seen !== buildOwnRecord()) fs.renameSync(writeReady(), file);
		return true;
	};

	return {
		holder: () => liveHolder(readText(file)),
		/**
		 * @returns {boolean} false where a live holder has the lock
		 * @throws {NotALock}
		 */
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
 * Takes `lock`, one held only around a short write, waiting up to LOCK_WAIT_MS
 * for a live holder.
 * @param {ReturnType<typeof pidLock>} lock
 * @param {number} [waitMs]
 * @returns {boolean} whether it is held
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
