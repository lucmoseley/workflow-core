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
 *
 * writeTerminal is the same writer, named for a path only a person at a
 * terminal reads (#5484).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const sleep = require("./sleep-sync.js");

// #1641 guess
const EAGAIN_PAUSE_MS = 10;
// #1641 guess
const EAGAIN_CEILING_MS = 10_000;

const writeStall = { ms: 0 };

/** @param {{ ms: number }} stall @param {unknown} fault */
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

/**
 * @param {number} fd
 * @param {string} text
 */
function writeTerminal(fd, text) {
	writeFd(fd, text);
}

/** @typedef {(fd: number, text: string) => void} Write */

module.exports = { pauseOrThrow, writeFd, writeTerminal };
