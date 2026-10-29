/*
 * write-fd.js — the one synchronous writer that survives a full pipe (#1635,
 * #1641).
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
const writeStall = { ms: 0 };

/**
 * One pause on an fd that took or gave no bytes, added to `stall`; or, once
 * `stall` has reached the ceiling, `fault` thrown instead.
 * @param {{ ms: number }} stall accumulator: time waited since the caller's
 *   last progress, which the caller resets
 * @param {unknown} fault
 */
function pauseOrThrow(stall, fault) {
	if (stall.ms >= EAGAIN_CEILING_MS) throw fault;
	sleep.sleepSync(EAGAIN_PAUSE_MS);
	stall.ms += EAGAIN_PAUSE_MS;
}

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
		let wrote;
		try {
			wrote = fs.writeSync(fd, bytes, done);
		} catch (e) {
			if (caught(e).code !== "EAGAIN") throw e;
			pauseOrThrow(writeStall, e);
			continue;
		}
		if (wrote > 0) {
			done += wrote;
			writeStall.ms = 0;
		} else {
			pauseOrThrow(
				writeStall,
				new Error(`fd ${fd} took no bytes for ${EAGAIN_CEILING_MS} ms`),
			);
		}
	}
}

module.exports = { pauseOrThrow, writeFd };
