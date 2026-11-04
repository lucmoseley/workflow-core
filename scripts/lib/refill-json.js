/*
 * refill-json.js — the refill loop's JSON files, read and written atomically: a
 * leaf, so lib/refill-state.js reads the state file without loading the arbiter
 * store lib/refill-files.js does (#4232).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { writeFileAtomic } = require("./atomic-write.js");

/**
 * The file's read: `found` false where it is absent, else its parsed `value`,
 * or why it would not read or parse in `damage`.
 * @param {string} file
 * @returns {{found: boolean, value: unknown, damage: string|null}}
 */
function readJsonOutcome(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return { found: true, value, damage: null };
	} catch (err) {
		const { code, message } = caught(err);
		return code === "ENOENT"
			? { found: false, value: null, damage: null }
			: /* One line: JSON.parse's message can quote a multi-line source (#3814). */
				{ found: true, value: null, damage: message.replace(/\s*\n\s*/g, " ") };
	}
}

/**
 * The parsed file, or null where it is absent or damaged. A damaged file is a
 * fault, so `log` gets a line naming it and the error (#3380).
 * @param {string} file
 * @param {(line: string) => void} log
 * @returns {unknown}
 */
function readJson(file, log) {
	/* Fail open (#2012): each caller's parse reads null as its defaults, so a
	 * damaged file costs the remembered state rather than stopping the loop;
	 * the control alone stops it, through readControlChecked. */
	const { value, damage } = readJsonOutcome(file);
	if (damage !== null)
		log(
			`${file} is damaged (${damage}); read as absent, so its defaults stand until its next write replaces it`,
		);
	return value;
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, "\t")}\n`, {
		mkdir: true,
	});
}

module.exports = { readJson, readJsonOutcome, writeJson };
