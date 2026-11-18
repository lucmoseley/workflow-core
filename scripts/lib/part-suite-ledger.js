/*
 * part-suite-ledger.js — the part-suite peak (workflow-core#5366) off the run ledger of
 * the host's canonical checkout, so another repo's suite never sizes this
 * one's runs.
 *
 * CACHED PER PROCESS FOR ONE QUEUE POLL (lib/queue-poll.js).
 *
 * NEVER THROWS. An absent ledger reads as no lines, every bucket thin.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");
const { partSuitePeak } = require("./part-suite-peak.js");
const { QUEUE_POLL_MS } = require("./queue-poll.js");

/**
 * @typedef {import("./part-suite-peak.js").LedgerLine} LedgerLine
 * @typedef {import("./part-suite-peak.js").PartKind} PartKind
 * @typedef {{ lines: LedgerLine[], why: null } | { lines: null, why: string }} LedgerRead
 */

/** @type {{ file: string, at: number, read: LedgerRead } | null} */
let cache = null;

/**
 * @param {string} file
 * @returns {LedgerRead}
 */
function readLedgerLines(file) {
	try {
		const read = readJsonl(
			file,
			(raw) => raw.includes('"memory":{') && raw.includes('"wholeSlot":false'),
		);
		return { lines: /** @type {LedgerLine[]} */ (read?.rows ?? []), why: null };
	} catch (error) {
		return { lines: null, why: `the run ledger: ${caught(error).message}` };
	}
}

/**
 * @param {string} [root]
 */
function ledgerPath(root) {
	/* Lazy: the guard loads this module on every hook call, and reads the
	 * ledger only for a part-suite. */
	const { markersDir } = require("./marker-root.js");
	const { RUN_LEDGER } = require("./run-ledger.js");
	return path.join(markersDir(root), RUN_LEDGER);
}

/**
 * The peak a part-suite of `kind` resolving to `files` test files is charged
 * now, null for a thin bucket.
 * @param {{ kind: PartKind, files: number }} run
 * @param {{ root?: string, file?: string, now?: number, ttlMs?: number }} [options]
 * @returns {{ peak: import("./part-suite-peak.js").PartPeak | null } | { why: string }}
 */
function readPartSuitePeak(run, options = {}) {
	const now = options.now ?? Date.now();
	let file;
	try {
		file = options.file ?? ledgerPath(options.root);
	} catch (error) {
		return { why: `the run ledger's path: ${caught(error).message}` };
	}
	const ttlMs = options.ttlMs ?? QUEUE_POLL_MS;
	if (!cache || cache.file !== file || now - cache.at >= ttlMs)
		cache = { file, at: now, read: readLedgerLines(file) };
	const { read } = cache;
	if (read.lines === null) return { why: read.why };
	return { peak: partSuitePeak(read.lines, { ...run, now }) };
}

module.exports = { readPartSuitePeak };
