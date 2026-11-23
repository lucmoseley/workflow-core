const fs = require("node:fs");
const { caught } = require("./caught.js");
const { pauseOrThrow } = require("./write-fd.js");

// https://man7.org/linux/man-pages/man7/pipe.7.html
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
