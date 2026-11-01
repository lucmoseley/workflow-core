/*
 * pid-lock.js — a single-instance lock held as a pidfile, for a daemon only
 * one copy of may run per machine or checkout: the refill loop and the
 * lander (#2402); and for a short read-to-rename write, write-secret.js's
 * (#3539) and the refill control's (#3856), which waitForLock takes.
 *
 * The pidfile is linked into place from a file already holding the pid, so
 * no reader ever sees it empty. A pidfile whose process is gone, or whose
 * command line runs no file named as the daemon's script, is stale and taken
 * over. A process re-exec'd under its own pid (the refill loop's adoption,
 * #2361) already holds it.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
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

/**
 * The lock at `file` for the script or scripts named `marker`: a holder's
 * command line must carry an argument whose basename is one of them, so
 * `start-lander.js` never passes for `lander.js` (#2675).
 * @param {string} file
 * @param {string | string[]} marker
 */
function pidLock(file, marker) {
	const markers = [marker].flat();
	/** @param {string|null} text @returns {number|null} the live holder's pid */
	const liveHolder = (text) => {
		const pid = Number(String(text).trim());
		if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
		/* pidAlive asked the real kernel, so its cmdline is read there too (#3587). */
		const cmdline = readText(`${REAL_PROC}/${pid}/cmdline`);
		/* Residual: an unreadable cmdline counts as the daemon's, so a lock is
		 * never taken from a live holder on doubt. */
		if (cmdline === null) return pid;
		const runs = cmdline
			.split("\0")
			.some((arg) => markers.includes(path.basename(arg)));
		return runs ? pid : null;
	};

	const aside = () =>
		asidePath(file, process.pid, crypto.randomBytes(4).toString("hex"));

	const create = () => {
		const ready = aside();
		fs.writeFileSync(ready, String(process.pid), { flag: "wx" });
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

	return {
		holder: () => liveHolder(readText(file)),
		/** @returns {boolean} false where a live holder has the lock */
		acquire() {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (create()) return true;
				const seen = readText(file);
				const held = liveHolder(seen);
				if (held === process.pid) return true;
				if (held !== null || !removeStale(seen)) return false;
			}
			return false;
		},
		release() {
			if (String(readText(file)).trim() === String(process.pid))
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

module.exports = { LOCK_WAIT_MS, pidLock, waitForLock };
