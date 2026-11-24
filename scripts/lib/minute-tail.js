const fs = require("node:fs");
const { parseJsonlRow } = require("./jsonl.js");
const { writeFd } = require("./write-fd.js");

// guess, workflow-core#5472
const READ_BYTES = 1 << 20;

class MinuteTail {
	/**
	 * @param {string} file
	 * @param {(row: Record<string, unknown>) => boolean} counts
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

	advance() {
		let fd;
		try {
			fd = fs.openSync(this.file, "r");
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (code !== "ENOENT") writeFd(2, `${this.file}: ${String(err)}\n`);
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
