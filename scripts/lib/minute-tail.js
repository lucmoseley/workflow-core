/*
 * minute-tail.js — memwatch's minute log (`~/memwatch-minute.jsonl`) read
 * forward, for a long-running reader that must see each line once: the
 * away-only load (scripts/away-load.js) counts #5346's precondition minutes
 * on it as they are written.
 */

const fs = require("node:fs");
const { isPreconditionMinute, parseRow } = require("./away-load.js");

/**
 * The minute log read forward from an offset, so each line is counted once;
 * a file shorter than the offset was pruned, so it is read again whole.
 */
class MinuteTail {
	/** @param {string} file */
	constructor(file) {
		this.file = file;
		this.offset = 0;
		this.rest = "";
		this.count = 0;
		this.lastTs = "";
		/** @type {Record<string, unknown>|null} */
		this.last = null;
	}

	/** Reads what was appended since the last call; true where a line was. */
	advance() {
		let fd;
		try {
			fd = fs.openSync(this.file, "r");
		} catch {
			return false;
		}
		try {
			return this.readFrom(fd, fs.fstatSync(fd).size);
		} finally {
			fs.closeSync(fd);
		}
	}

	/**
	 * @param {number} fd
	 * @param {number} size
	 */
	readFrom(fd, size) {
		if (size < this.offset) {
			this.offset = 0;
			this.rest = "";
			this.count = 0;
			this.lastTs = "";
		}
		const buf = Buffer.alloc(1 << 20);
		let fresh = false;
		while (this.offset < size) {
			const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
			if (n <= 0) break;
			this.offset += n;
			const lines = (this.rest + buf.toString("utf8", 0, n)).split("\n");
			this.rest = lines.pop() ?? "";
			for (const line of lines) fresh = this.take(line) || fresh;
		}
		return fresh;
	}

	/** @param {string} line */
	take(line) {
		const row = parseRow(line);
		if (!row || typeof row.ts !== "string" || row.ts <= this.lastTs)
			return false;
		this.lastTs = row.ts;
		this.last = row;
		if (isPreconditionMinute(row)) this.count += 1;
		return true;
	}
}

module.exports = { MinuteTail };
