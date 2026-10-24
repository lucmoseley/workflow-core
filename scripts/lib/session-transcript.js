/*
 * session-transcript.js — finding and reading the transcript of the session a
 * `Stop` hook was handed, so that every Stop guard resolves the same file the
 * same way.
 *
 * It sits beside `lib/transcript.js` rather than inside it because it reaches
 * for `lib/arbiter-store.js`'s config-dir list, and transcript.js is
 * deliberately dependency-light.
 */

const fs = require("node:fs");

const store = require("./arbiter-store");
const { findTranscript } = require("./transcript");

/* A whole-file read is affordable at the handful of Stops a session has. The
 * tail exists so a transcript that grows an order of magnitude cannot make a
 * Stop hook the thing that runs the machine out of memory. */
const WHOLE_FILE_LIMIT = 16 * 1024 * 1024;
/* The tail path is reached: top-level transcripts here exceed the limit above
 * (mantahostels#3311), so a caller's needle sitting further back than 8 MB is a real way to
 * lose one. Still a first guess — nothing has measured how far back a needle can
 * sit. It is half the limit above. */
const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Where a session's transcript is, preferring the path its payload names.
 *
 * @param {{transcript_path?: unknown}} payload
 * @param {string} sessionId
 * @returns {string | null}
 */
function resolve(payload, sessionId) {
	const named = payload?.transcript_path;
	if (typeof named === "string" && named !== "") {
		try {
			fs.accessSync(named, fs.constants.R_OK);
			return named;
		} catch {
			/* Fall through to the lookup — a payload path that cannot be read is
			 * no reason to say nothing at all. */
		}
	}
	/* Every config dir on the machine, not just this session's: three Claude
	 * plans run here, and a transcript found under any of them is this
	 * session's. */
	for (const dir of store.configDirs()) {
		const found = findTranscript(dir, sessionId);
		if (found) return found;
	}
	return null;
}

/**
 * The transcript text, whole for a small file and the tail for a large one.
 *
 * Both callers want the END of the transcript — the last usage record, the
 * newest hook attachments — so a truncated read loses the oldest material,
 * which is the right way round.
 *
 * THE HALF-EATEN FIRST LINE IS TRIMMED HERE, NOT LEFT TO THE PARSER. Leaving it
 * was defensible while nobody could tell it from a real skip; `mainChainRecords`
 * now COUNTS what it skips and `guard-lost-deny.js` reports that count to the
 * founder, so left in, the cut would read as corruption on every Stop of an
 * oversize session — an alarm this function caused and the session cannot
 * explain (mantahostels#3311).
 *
 * @param {string} file
 * @returns {string}
 */
function read(file) {
	const size = fs.statSync(file).size;
	if (size <= WHOLE_FILE_LIMIT) return fs.readFileSync(file, "utf8");

	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(TAIL_BYTES);
		const got = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
		const text = buf.subarray(0, got).toString("utf8");
		const cut = text.indexOf("\n");
		/* No newline in 8 MB means the whole tail is one line's tail and there is
		 * no whole record in it — an empty read says that, where returning the
		 * fragment would have the caller skip it and report corruption. */
		return cut === -1 ? "" : text.slice(cut + 1);
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = { resolve, read };
