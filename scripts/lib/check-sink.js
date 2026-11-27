const { writeFd } = require("./write-fd.js");

/** @typedef {{ write: (fd: number, text: string) => void }} Sink */

/** @type {Sink} */
const FD_SINK = { write: writeFd };

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
 * @param {(write: import("./write-fd.js").Write) => number} run
 * @returns {{ exit: number, stdout: string, stderr: string }}
 */
function capture(run) {
	const sink = new BufferSink();
	const exit = run((fd, text) => sink.write(fd, text));
	return { exit, stdout: sink.stdout, stderr: sink.stderr };
}

module.exports = { FD_SINK, BufferSink, capture };
