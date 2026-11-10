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
 * included; `entries` pairs each row with its own.
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
 *
 * A reader that wants only the newest row of a log takes it from
 * readLastJsonlRow, which reads the file's end and never the whole.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/**
 * @typedef {{ rows: Record<string, unknown>[], entries: { row: Record<string, unknown>, line: number }[], bad: number[], torn: boolean }} Jsonl
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
	/** @type {Jsonl["entries"]} */
	const entries = [];
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
			entries.push({ row, line: i + 1 });
			continue;
		}
		bad.push(i + 1);
		if (i === unterminated && !isJson(line)) torn = true;
	}
	return { rows, entries, bad, torn };
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

/* The bytes read from the file's end at first, doubled until a row is found;
 * untraced, set past any row a log here writes. */
const TAIL_BYTES = 64 * 1024;

/**
 * The last row among `text`'s lines, undefined where none holds one. Its
 * first line is left out where `partial`, the text starting mid-file.
 * @param {string} text
 * @param {boolean} partial
 */
function lastRowOf(text, partial) {
	const lines = text.split("\n");
	/** @type {Record<string, unknown> | undefined} */
	let row;
	for (let i = lines.length - 1; !row && i >= (partial ? 1 : 0); i--)
		row = parseJsonlRow(lines[i] ?? "") || undefined;
	return row;
}

/**
 * The file's last row, as `readJsonl(file).rows.at(-1)` gives it: null where
 * the file is missing, undefined where it holds no row.
 * @param {string} file
 * @returns {Record<string, unknown> | null | undefined}
 */
function readLastJsonlRow(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (e) {
		/* lib/file-read.js reads a file whole, and this one must not be. */
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	try {
		const { size } = fs.fstatSync(fd);
		for (let want = TAIL_BYTES; ; want *= 2) {
			const start = Math.max(0, size - want);
			const tail = Buffer.alloc(size - start);
			const read = fs.readSync(fd, tail, 0, tail.length, start);
			const row = lastRowOf(tail.toString("utf8", 0, read), start > 0);
			if (row || start === 0) return row;
		}
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = { parseJsonl, parseJsonlRow, readJsonl, readLastJsonlRow };
