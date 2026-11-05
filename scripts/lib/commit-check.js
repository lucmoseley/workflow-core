/*
 * commit-check.js — the arbiter store's answer about a commit (#2882): what
 * this session wrote.
 */

const { caught } = require("./caught.js");

/**
 * The require sits inside the try so a store that will not load fails this
 * advisory check open, as mantahostels#3278 has it, rather than reaching
 * refuse-on-throw's deny.
 * @type {import("./commit-form.js").CommitFormPorts["commitCheck"]}
 */
function readCommitCheck(sessionId) {
	try {
		const store = require("./arbiter-store.js");
		const written = store.readWritesBy(sessionId);
		return {
			written,
			fault: written === null ? "the write ledger could not be read" : "",
		};
	} catch (e) {
		return {
			written: null,
			fault: `the arbiter store threw: ${caught(e).message}`,
		};
	}
}

module.exports = { readCommitCheck };
