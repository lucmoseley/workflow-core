const fs = require("node:fs");
const path = require("node:path");
const { readJsonl, readLastJsonlRow } = require("./jsonl.js");
const { refillPath } = require("./refill-dir.js");

const RECORD_NAME = ".stale-run-record.jsonl";

const recordPath = () => refillPath(RECORD_NAME);

/** @typedef {import("./stale-run-plan.js").RunRow} RunRow */

/**
 * @param {string} file
 * @returns {RunRow[] | null}
 */
const readRows = (file) =>
	/** @type {RunRow[] | undefined} */ (readJsonl(file)?.rows) ?? null;

/**
 * @param {string} file
 * @returns {RunRow | null}
 */
const readNewestRow = (file) =>
	/** @type {RunRow | null} */ (readLastJsonlRow(file));

/**
 * @param {string} file
 * @param {RunRow} row
 */
function appendRow(file, row) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

module.exports = { appendRow, readNewestRow, readRows, recordPath };
