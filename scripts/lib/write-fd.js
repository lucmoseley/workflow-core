/*
 * write-fd.js — the one synchronous writer that survives a full pipe (workflow-core#1635,
 * workflow-core#1641).
 *
 * A script that ends in process.exit loses whatever node still has buffered
 * for a pipe, so its report goes out through fs.writeSync. A bare writeSync
 * has two gaps this closes: it drops the tail of a partial write without
 * saying so, and it throws EAGAIN on a full pipe that is non-blocking — which
 * a module the process loads makes it by touching process.stdout, as can a
 * non-node parent. A caller's fail-open catch then loses the text and the
 * exit code.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
// Through the module object, so a test can stub the pause.
const sleep = require("./sleep-sync.js");

// A guess, unmeasured: short beside any reader's drain, long enough that
// waiting on one costs no CPU to speak of.
const EAGAIN_PAUSE_MS = 10;
// A guess too: far past a live reader's drain. Past it the write throws into
// the caller's catch, since a wait stuck in sleepSync runs no signal handler
// and only SIGKILL would end it.
const EAGAIN_CEILING_MS = 10_000;

/* Time spent since a write last took a byte, across calls: a checker says one
 * line per call, so a per-call ceiling would hold it the full ceiling per line
 * on a reader that never drains. Progress resets it. */
let stalledMs = 0;

/**
 * Write all of `text` to `fd` before returning, waiting out EAGAIN — and a
 * write that takes no bytes — until the process has stalled for the ceiling.
 * @param {number} fd
 * @param {string} text
 */
function writeFd(fd, text) {
	const bytes = Buffer.from(text);
	let done = 0;
	while (done < bytes.length) {
		try {
			const wrote = fs.writeSync(fd, bytes, done);
			if (wrote > 0) {
				done += wrote;
				stalledMs = 0;
				continue;
			}
		} catch (e) {
			if (caught(e).code !== "EAGAIN" || stalledMs >= EAGAIN_CEILING_MS)
				throw e;
		}
		if (stalledMs >= EAGAIN_CEILING_MS)
			throw new Error(`fd ${fd} took no bytes for ${EAGAIN_CEILING_MS} ms`);
		sleep.sleepSync(EAGAIN_PAUSE_MS);
		stalledMs += EAGAIN_PAUSE_MS;
	}
}

module.exports = { writeFd };
