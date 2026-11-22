const fs = require("node:fs");
const { caught } = require("./caught.js");
const { readTail } = require("./file-read.js");

/**
 * @typedef {{ rows: Record<string, unknown>[], entries: { row: Record<string, unknown>, line: number }[], bad: number[], torn: boolean }} Jsonl
 * @typedef {(line: string) => boolean} Keep
 */

/**
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

/** @param {string} line */
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

// guess, #4821
const TAIL_BYTES = 64 * 1024;

/**
 * @typedef {(row: Record<string, unknown>) => boolean} Match
 */

/**
 * @param {string} text
 * @param {boolean} partial
 * @param {Match} match
 */
function lastRowOf(text, partial, match) {
	const lines = text.split("\n");
	/** @type {Record<string, unknown> | undefined} */
	let found;
	for (let i = lines.length - 1; !found && i >= (partial ? 1 : 0); i--) {
		const row = parseJsonlRow(lines[i] ?? "");
		if (row && match(row)) found = row;
	}
	return found;
}

/**
 * @param {string} file
 * @param {Match} [match]
 * @returns {Record<string, unknown> | null | undefined}
 */
function readLastJsonlRow(file, match = () => true) {
	for (let want = TAIL_BYTES; ; want *= 2) {
		const tail = readTail(file, want);
		if (tail.state === "absent") return null;
		if (tail.state === "unreadable") throw tail.error;
		const { text, partial } = tail.data;
		const row = lastRowOf(text, partial, match);
		if (row || !partial) return row;
	}
}

module.exports = { parseJsonl, parseJsonlRow, readJsonl, readLastJsonlRow };
