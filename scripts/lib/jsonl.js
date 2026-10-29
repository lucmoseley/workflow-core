/*
 * jsonl.js — the one JSONL reader (#3452). Every program reading a JSONL file
 * or text reads it here, so what a torn last line and an unparsable row mean
 * is decided once:
 *
 * - A TORN LAST LINE is the final line, with no newline after it, that does
 *   not parse: a writer that died or is still mid-append. It is reported as
 *   `torn`, not counted unparsable, and the rows before it stand. A final
 *   line with no newline that does parse is a whole row.
 * - AN UNPARSABLE ROW is any other non-blank line that does not parse, or
 *   that parses to anything but a JSON object. It is counted and skipped.
 * - A BLANK LINE is no row and no fault.
 *
 * A missing file is null — nothing written yet, told apart from an empty one.
 * Any other read error throws.
 *
 * Unbuilt caller: parseJsonl, for text read from `git show` or a pipe, as
 * lib/history-trim.js's hand parse reads it (#3453).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/**
 * @typedef {{ rows: Record<string, unknown>[], torn: boolean, unparsable: number }} Jsonl
 */

/**
 * @param {string} text
 * @returns {Jsonl}
 */
function parseJsonl(text) {
	/** @type {Record<string, unknown>[]} */
	const rows = [];
	let torn = false;
	let unparsable = 0;
	const lines = text.split("\n");
	const unterminated = lines.length - 1;
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			if (i === unterminated) torn = true;
			else unparsable++;
			continue;
		}
		if (row !== null && typeof row === "object" && !Array.isArray(row))
			rows.push(row);
		else unparsable++;
	}
	return { rows, torn, unparsable };
}

/**
 * @param {string} file
 * @returns {Jsonl | null}
 */
function readJsonl(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	return parseJsonl(text);
}

module.exports = { parseJsonl, readJsonl };
