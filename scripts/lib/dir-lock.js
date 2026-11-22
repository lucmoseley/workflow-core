const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { sleepSync } = require("./sleep-sync.js");

// guess, #5529
const LOCK_WAIT_MS = 2000;

// guess, #5529
const LOCK_STALE_MS = 10_000;

// guess, #5529
const POLL_MS = 5;

/**
 * @template T
 * @param {string} lock
 * @param {(held: boolean) => T} fn
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
		return fn(held);
	} finally {
		if (held) fs.rmSync(lock, { recursive: true, force: true });
	}
}

/**
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
