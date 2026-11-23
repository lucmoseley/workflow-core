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
