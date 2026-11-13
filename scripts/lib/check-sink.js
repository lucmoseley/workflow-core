/*
 * check-sink.js — where a lib/check.js run writes its bytes (#5172). A process
 * run writes the real fds; an in-process run holds both streams as text, so
 * the pre-commit dispatcher prints each gate's output when that gate finishes.
 */
const { writeFd } = require("./write-fd.js");

/**
 * `write(fd, text)`, fd 1 or 2, or a say-fd a parent named.
 * @typedef {{ write: (fd: number, text: string) => void }} Sink
 */

/** @type {Sink} */
const FD_SINK = { write: writeFd };

/** Both streams held as text, byte for byte; a say-fd other than 1 is stderr. */
class BufferSink {
	constructor() {
		this.stdout = "";
		this.stderr = "";
	}

	/** @param {number} fd @param {string} text */
	write(fd, text) {
		if (fd === 1) this.stdout += text;
		else this.stderr += text;
	}
}

module.exports = { FD_SINK, BufferSink };
