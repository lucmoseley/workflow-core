/*
 * check-sink.js — where a pre-commit dispatcher member writes its bytes
 * (#5172): a lib/check.js run, or a program row's CLI core through capture().
 * A process run writes the real fds; an in-process run holds both streams as
 * text, so the dispatcher prints each gate's output when that gate finishes.
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

/**
 * Runs `run` against a BufferSink's writer, for a CLI core the pre-commit
 * dispatcher runs as a program row in its own process.
 * @param {(write: import("./write-fd.js").Write) => number} run
 * @returns {{ exit: number, stdout: string, stderr: string }}
 */
function capture(run) {
	const sink = new BufferSink();
	const exit = run((fd, text) => sink.write(fd, text));
	return { exit, stdout: sink.stdout, stderr: sink.stderr };
}

module.exports = { FD_SINK, BufferSink, capture };
