/*
 * dir-lock.js — a short read-modify-write lock for a hook's scratch store,
 * where Node has no flock(2): a directory beside the store, made by the one
 * caller that gets it (#2787). lib/echo-record-host.js's echo-chain store
 * takes it for the recorder's writes and the guard's alike.
 *
 * Waits up to LOCK_WAIT_MS, then runs `fn` unserialised, as `flock -w` failing
 * did: a store write is never skipped for want of the lock. A lock older than
 * LOCK_STALE_MS is a crashed holder's and is taken over.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { sleepSync } = require("./sleep-sync.js");

/** ec_store's `flock -w 2` before the port: the wait a store write had. */
const LOCK_WAIT_MS = 2000;

/** Far past any store's read-modify-write, which is one small file. */
const LOCK_STALE_MS = 10_000;

/* That read-modify-write takes well under a millisecond, so a waiter polls
 * often and a full wait is about 400 tries. */
const POLL_MS = 5;

/**
 * @template T
 * @param {string} lock the lock directory's path
 * @param {() => T} fn
 * @param {() => number} [now]
 * @returns {T}
 */
function withDirLock(lock, fn, now = Date.now) {
	const deadline = now() + LOCK_WAIT_MS;
	let held = false;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			held = true;
			break;
		} catch (e) {
			if (caught(e).code !== "EEXIST") break;
		}
		const age =
			now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? now());
		if (age > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
		else if (now() > deadline) break;
		else sleepSync(POLL_MS);
	}
	try {
		return fn();
	} finally {
		if (held) fs.rmSync(lock, { recursive: true, force: true });
	}
}

/**
 * Delete each file in `dir` last written over `ageMs` ago: a per-agent store
 * would otherwise pile up for the host's life.
 * @param {string} dir
 * @param {number} ageMs
 */
function sweepFiles(dir, ageMs) {
	const cutoff = Date.now() - ageMs;
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p, { throwIfNoEntry: false });
		if (st?.isFile() && st.mtimeMs < cutoff) fs.rmSync(p, { force: true });
	}
}

module.exports = { sweepFiles, withDirLock };
