/*
 * minute-tail.js — memwatch's minute log (`~/memwatch-minute.jsonl`) read
 * forward, for a long-running reader that must count each line once and keep
 * the newest: the away-only load (scripts/away-load.js) counts #5346's
 * precondition minutes on it as they are written.
 */

const fs = require("node:fs");
const { parseJsonlRow } = require("./jsonl.js");

/* Untraced: a read's buffer, about 800 minute lines; the first read of a
 * month's log takes some 60 of them. */
const READ_BYTES = 1 << 20;

/**
 * Read forward from an offset; a file shorter than the offset was pruned, so
 * it is read again whole and the count starts over.
 */
class MinuteTail {
	/**
	 * @param {string} file
	 * @param {(row: Record<string, unknown>) => boolean} counts which rows count
	 */
	constructor(file, counts) {
		this.file = file;
		this.counts = counts;
		this.offset = 0;
		this.rest = "";
		this.count = 0;
		/** @type {Record<string, unknown>|null} */
		this.last = null;
	}

	/** Reads what was appended since the last call; true where a row was. */
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
		}
		const buf = Buffer.alloc(READ_BYTES);
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
		const row = parseJsonlRow(line);
		if (!row) return false;
		this.last = row;
		if (this.counts(row)) this.count += 1;
		return true;
	}
}

module.exports = { MinuteTail };
