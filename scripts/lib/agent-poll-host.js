const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { ignoreFailure } = require("./caught.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { makeDir } = require("./guard-entry.js");

// guess, #5529
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

function buildHostPorts() {
	return {
		now: () => Math.floor(Date.now() / 1000),
		/** @param {string} file */
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
				return false;
			}
		},
		/**
		 * @param {string} dir
		 * @param {number} now
		 */
		sweep: (dir, now) => {
			const cutoff = now * 1000 - SWEEP_AGE_MS;
			let names;
			try {
				names = fs.readdirSync(dir);
			} catch {
				return;
			}
			for (const name of names) {
				const p = path.join(dir, name);
				ignoreFailure(() => {
					const s = fs.lstatSync(p);
					if (s.isFile() && s.mtimeMs < cutoff) fs.unlinkSync(p);
				});
			}
		},
	};
}

module.exports = { buildHostPorts };
