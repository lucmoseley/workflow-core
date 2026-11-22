const fs = require("node:fs");
const path = require("node:path");
const { orFallback } = require("./caught.js");

// guess, #5529
const CHUNK = 16 * 1024 * 1024;

/** @param {string} bin */
function binaryOf(bin) {
	const dirs = bin.includes("/")
		? [""]
		: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const d of dirs) {
		const real = orFallback(
			() => fs.realpathSync(d ? path.join(d, bin) : bin),
			null,
		);
		if (real !== null) return real;
	}
	return null;
}

/**
 * @param {string} file
 * @param {string} needle
 * @param {number} window
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
