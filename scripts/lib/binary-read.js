/*
 * binary-read.js — reads of the installed Claude Code binary: the file a
 * command name runs, and the text around a literal in it. Its minified names
 * change every release, so a reader anchors on a literal (lib/agent-id-probe.js)
 * or asks only whether a name is there (check-retry-watchdog.js). Moved out of
 * lib/agent-id-probe.js (#1837) for the retry-watchdog check (#4815).
 */

const fs = require("node:fs");
const path = require("node:path");

/** The binary is read in pieces, as 2.1.310's is 291 MB; the size is a guess. */
const CHUNK = 16 * 1024 * 1024;

/**
 * The file `bin` runs, as `readlink -f $(which <bin>)` gives it; null where
 * none is found.
 * @param {string} bin
 */
function binaryOf(bin) {
	const dirs = bin.includes("/")
		? [""]
		: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const d of dirs) {
		try {
			return fs.realpathSync(d ? path.join(d, bin) : bin);
		} catch {
			/* Not in this PATH entry. */
		}
	}
	return null;
}

/**
 * The text around each occurrence of `needle` in the file, with the
 * needle's offset in it.
 * @param {string} file
 * @param {string} needle
 * @param {number} window bytes kept either side of each occurrence
 * @returns {{ text: string, at: number }[]}
 */
function readWindowsOf(file, needle, window) {
	const want = Buffer.from(needle, "latin1");
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(CHUNK + want.length - 1);
		/** @type {number[]} */
		const hits = [];
		for (let off = 0; off < size; off += CHUNK) {
			const n = fs.readSync(fd, buf, 0, buf.length, off);
			const view = buf.subarray(0, n);
			/* A hit starting in the overlap is the next chunk's to find. */
			let i = view.indexOf(want);
			while (i !== -1 && i < CHUNK) {
				hits.push(off + i);
				i = view.indexOf(want, i + 1);
			}
		}
		return hits.map((hit) => {
			const start = Math.max(0, hit - window);
			const out = Buffer.alloc(Math.min(size, hit + window) - start);
			fs.readSync(fd, out, 0, out.length, start);
			return { text: out.toString("latin1"), at: hit - start };
		});
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = { binaryOf, readWindowsOf };
