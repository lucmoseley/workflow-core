const crypto = require("node:crypto");
const { canonicalJson } = require("./canonical-json.js");
const { NOOP, SLEEP } = require("./agent-poll.js");

// guess, #5529
const MAX_AGE_S = 3600;
// guess, #5529
const MAX_LINES = 200;

const EC_CLEARED = "-";

const VOLATILE = /duration|elapsed|timestamp|startTime|endTime|_ms$|Millis/i;

// #5726
const WAIT =
	/^[ \t\n\v\f\r]*(?:timeout[ \t]+[0-9]+[smhd]?[ \t]+)?(?:(?:node|bash|sh)[ \t]+)?(?:[^\s;&|<>`$()]*\/)?(?:in-flight-runs\.js[ \t]+wait|bg-run\.sh[ \t]+wait|watch-artefact\.js)(?:[ \t][^\n;&|<>`$()]*)?\n*$/;

/**
 * @param {string | undefined} tool
 * @param {string} command
 */
const isNeighbours = (tool, command) =>
	tool === "Bash" &&
	(SLEEP.test(command) || NOOP.test(command) || WAIT.test(command));

/** @param {string} text */
const hash24 = (text) =>
	crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 24);

/**
 * @param {string} tool
 * @param {unknown} input
 * @param {string | null} fileState
 */
function signature(tool, input, fileState) {
	const signed = canonicalJson(
		input === null || input === undefined || input === false ? {} : input,
		true,
	);
	return hash24(
		`${tool}\x1f${signed}${fileState === null ? "" : `\x1f${fileState}`}`,
	);
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {(file: string) => string | null} fileState
 */
function callSignature(tool, input, fileState) {
	const file = input.file_path;
	return signature(
		tool,
		input,
		tool === "Read" && typeof file === "string" ? fileState(file) : null,
	);
}

/** @param {unknown} r */
function responseHash(r) {
	if (r === undefined || r === null) return null;
	const projected =
		r && typeof r === "object" && !Array.isArray(r)
			? Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k)))
			: r;
	return hash24(canonicalJson(projected, false));
}

/**
 * #1004
 * @param {{ agent: string, sid: string }} key
 */
const chainName = (key) => `${key.sid}.${key.agent}`;

/**
 * @typedef {{ sig: string, hash: string, run: number, at: number,
 *   denies: number }} ChainRecord
 */

/**
 * @param {string} text
 * @param {number} now
 * @returns {ChainRecord[]}
 */
function parseRecords(text, now) {
	/** @type {ChainRecord[]} */
	const out = [];
	for (const line of text.split("\n")) {
		const [sig = "", hash = "", run = "", at = "", denies = ""] =
			line.split(/\t+/);
		if (!/^\d+$/.test(run) || !/^\d+$/.test(at) || !/^\d+$/.test(denies))
			continue;
		if (now - Number(at) >= MAX_AGE_S) continue;
		out.push({
			sig,
			hash,
			run: Number(run),
			at: Number(at),
			denies: Number(denies),
		});
	}
	return out;
}

/**
 * @param {string} text
 * @param {string} sig
 * @param {number} now
 */
const lookup = (text, sig, now) =>
	parseRecords(text, now).find((r) => r.sig === sig) ?? null;

/**
 * The store with `next` in place of its signature's record, the newest
 * MAX_LINES kept.
 * @param {ChainRecord[]} records
 * @param {ChainRecord} next
 */
function storeText(records, next) {
	const kept = [...records.filter((r) => r.sig !== next.sig), next].slice(
		-MAX_LINES,
	);
	return kept
		.map((r) => `${r.sig}\t${r.hash}\t${r.run}\t${r.at}\t${r.denies}\n`)
		.join("");
}

module.exports = {
	EC_CLEARED,
	callSignature,
	chainName,
	isNeighbours,
	lookup,
	parseRecords,
	responseHash,
	signature,
	storeText,
};
