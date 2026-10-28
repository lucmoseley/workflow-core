/*
 * jsonl.js — the one JSONL reader (#3452, #3453). Every program reading a
 * JSONL file or text reads it here, so what a torn last line and an
 * unparsable row mean is decided once:
 *
 * - A TORN LAST LINE is the final line, with no newline after it, that does
 *   not parse: a writer that died or is still mid-append. The rows before it
 *   stand, and `torn` says the last of the bad lines is this one.
 * - AN UNPARSABLE ROW is any other non-blank line that does not parse, or
 *   that parses to anything but a JSON object. It is skipped.
 * - A BLANK LINE is no row and no fault.
 *
 * `bad` lists the 1-based number of every line that held no row, a torn one
 * included; `rowLines` gives each row's own, by index.
 *
 * A missing file is null — nothing written yet, told apart from an empty one.
 * Any other read error throws.
 *
 * `keep` is a test on a line's raw text, run before its parse: a line it
 * refuses is never parsed and is neither a row nor a fault. It is for a reader
 * that wants a sliver of a large log, such as one time window.
 *
 * A reader that streams a log line by line, never holding it whole, takes
 * each line's answer from parseJsonlRow.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/**
 * @typedef {{ rows: Record<string, unknown>[], rowLines: number[], bad: number[], torn: boolean }} Jsonl
 * @typedef {(line: string) => boolean} Keep
 */

/**
 * The row on one line: its object, null where the line is blank, undefined
 * where it is no JSON object.
 * @param {string} line
 * @returns {Record<string, unknown> | null | undefined}
 */
function parseJsonlRow(line) {
	if (!line.trim()) return null;
	let row;
	try {
		row = JSON.parse(line);
	} catch {
		return;
	}
	return row !== null && typeof row === "object" && !Array.isArray(row)
		? row
		: undefined;
}

/**
 * @param {string} text
 * @param {Keep} [keep]
 * @returns {Jsonl}
 */
function parseJsonl(text, keep) {
	/** @type {Record<string, unknown>[]} */
	const rows = [];
	/** @type {number[]} */
	const rowLines = [];
	/** @type {number[]} */
	const bad = [];
	let torn = false;
	const lines = text.split("\n");
	const unterminated = lines.length - 1;
	for (const [i, line] of lines.entries()) {
		if (keep && !keep(line)) continue;
		const row = parseJsonlRow(line);
		if (row === null) continue;
		if (row) {
			rows.push(row);
			rowLines.push(i + 1);
			continue;
		}
		bad.push(i + 1);
		if (i === unterminated && !isJson(line)) torn = true;
	}
	return { rows, rowLines, bad, torn };
}

/**
 * An unterminated last line that parses to no object is unparsable, not
 * torn.
 * @param {string} line
 */
function isJson(line) {
	try {
		JSON.parse(line);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} file
 * @param {Keep} [keep]
 * @returns {Jsonl | null}
 */
function readJsonl(file, keep) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	return parseJsonl(text, keep);
}

module.exports = { parseJsonl, parseJsonlRow, readJsonl };
