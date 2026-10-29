/*
 * read-fd.js — all of an fd, read to its end through a non-blocking pipe.
 *
 * `fs.readFileSync(0)` throws EAGAIN where fd 0 is a non-blocking pipe whose
 * writer has not yet written everything (#3663). This waits that out on
 * lib/write-fd.js's pause and ceiling.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { pauseOrThrow } = require("./write-fd.js");

/* So one read takes what a pipe buffer holds. */
const CHUNK = 64 * 1024;

/**
 * @param {number} fd
 * @returns {Buffer}
 * @throws where a read fails other than by EAGAIN, or EAGAIN outlasts the
 *   ceiling with no byte taken
 */
function readFdAll(fd) {
	/** @type {Buffer[]} */
	const chunks = [];
	const buf = Buffer.alloc(CHUNK);
	const stall = { ms: 0 };
	for (;;) {
		let n;
		try {
			n = fs.readSync(fd, buf, 0, buf.length, null);
		} catch (e) {
			if (caught(e).code !== "EAGAIN") throw e;
			pauseOrThrow(stall, e);
			continue;
		}
		if (n === 0) return Buffer.concat(chunks);
		chunks.push(Buffer.from(buf.subarray(0, n)));
		stall.ms = 0;
	}
}

module.exports = { readFdAll };
