/*
 * agent-poll-host.js — the production ports lib/agent-poll.js reads, through
 * the dispatcher (workflow-core#2791, workflow-core#3224): the clock,
 * and the rolling window's file — its read, its directory, its atomic write
 * and the day-old sweep of its directory. The core names every path; this
 * file only touches them.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { makeDir } = require("./guard-entry.js");

/** A window file untouched this long is swept: one per session would
 * otherwise accumulate for the life of the host. A day, a guess never
 * measured: far past the core's 300 s window, so no live window is swept,
 * and short enough that a day's sessions are all that ever accumulate. */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

function buildHostPorts() {
	return {
		now: () => Math.floor(Date.now() / 1000),
		/**
		 * The window's text; "" where it is absent, which counts nothing, and
		 * null where it will not read, which the core logs and allows on
		 * rather than read as an empty window (workflow-core#4132).
		 * @param {string} file
		 */
		readWindow: (file) => {
			const got = readText(file);
			if (got.state === "read") return got.data;
			return got.state === "absent" ? "" : null;
		},
		makeDir,
		/**
		 * @param {string} file
		 * @param {string} text
		 */
		writeWindow: (file, text) => {
			try {
				writeFileAtomic(file, text);
				return true;
			} catch {
				/* The port's contract: false, which the core logs as an
				 * unrecorded call and allows on (mantahostels#103 §6). */
				return false;
			}
		},
		/**
		 * Every regular file directly in `dir` older than a day at `now`, the
		 * core's clock reading in unix seconds, deleted. Bounded work: only
		 * ever that one directory. Best effort.
		 * @param {string} dir
		 * @param {number} now
		 */
		sweep: (dir, now) => {
			const cutoff = now * 1000 - SWEEP_AGE_MS;
			let names;
			try {
				names = fs.readdirSync(dir);
			} catch {
				/* Best effort: an unswept directory only holds stale windows a
				 * day longer, which no count reads (mantahostels#103 §6). */
				return;
			}
			for (const name of names) {
				const p = path.join(dir, name);
				try {
					const s = fs.lstatSync(p);
					if (s.isFile() && s.mtimeMs < cutoff) fs.unlinkSync(p);
				} catch {
					/* Gone, or not ours to remove: best effort, as above (mantahostels#103 §6). */
				}
			}
		},
	};
}

module.exports = { buildHostPorts };
