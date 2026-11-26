const fs = require("node:fs");
const path = require("node:path");
const { parseJsonl } = require("./jsonl.js");
const { orFallback } = require("./caught.js");

/** @typedef {Record<string, any>} TranscriptRecord */

/** @typedef {Record<string, any>} TranscriptBlock */

/**
 * @typedef {object} Usage
 * @property {number} [input_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [output_tokens]
 */

/** @param {Usage} usage @returns {number} */
function standingContext(usage) {
	return (
		(usage.input_tokens || 0) +
		(usage.cache_creation_input_tokens || 0) +
		(usage.cache_read_input_tokens || 0)
	);
}

/** @param {string} file @returns {boolean} */
function isSubagentTranscript(file) {
	return file.split(path.sep).includes("subagents");
}

/** @param {string} mainFile */
function subagentDirOf(mainFile) {
	return path.join(mainFile.replace(/\.jsonl$/, ""), "subagents");
}

const STOP_FEEDBACK = /^\s*Stop hook feedback/;

/** @param {unknown} content */
function parseContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (b?.type === "text" && typeof b.text === "string") return b.text;
			if (b?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

/**
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @param {{skipped: number, zeroed: number}} [stats]
 * @returns {Generator<TranscriptRecord>}
 */
function* mainChainRecords(text, tier, stats) {
	if (tier !== "main" && tier !== "subagent")
		throw new TypeError(
			`mainChainRecords needs tier "main" or "subagent", got ${JSON.stringify(tier)}.`,
		);
	const { rows, bad, zeroed } = parseJsonl(text);
	if (stats) {
		stats.skipped += bad.length;
		stats.zeroed += zeroed.length;
	}
	for (const record of rows) {
		if (tier === "main" && record.isSidechain) continue;
		yield record;
	}
}

/**
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {{ tokens: number, at: string | null } | null}
 */
function lastStandingContext(text, tier) {
	let last = null;
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		if (!usage) continue;
		const tokens = standingContext(usage);
		if (tokens > 0) last = { tokens, at: record.timestamp || null };
	}
	return last;
}

/** @param {string} text @param {"main" | "subagent"} tier @returns {number} */
function countTurns(text, tier) {
	const seen = new Set();
	let unkeyed = 0;
	for (const { key } of turnRecords(text, tier)) {
		if (key) seen.add(key);
		else unkeyed += 1;
	}
	return seen.size + unkeyed;
}

/**
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {Generator<{record: TranscriptRecord, usage: Usage,
 *  key: string | null}>}
 */
function* turnRecords(text, tier) {
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		if (!usage || standingContext(usage) <= 0) continue;
		let key = null;
		if (record.requestId) key = `req:${record.requestId}`;
		else if (record.uuid) key = `uuid:${record.uuid}`;
		yield { record, usage, key };
	}
}

/** @param {string} text @param {"main" | "subagent"} tier @returns {string[]} */
function autocompactions(text, tier) {
	const keys = [];
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "system" || record.subtype !== "compact_boundary")
			continue;
		if (record.compactMetadata?.trigger === "manual") continue;
		const key = record.uuid || record.timestamp;
		if (key) keys.push(String(key));
	}
	return keys;
}

/** @param {string} text @returns {{ended: boolean, at: number | null} | null} */
function lastTurn(text) {
	let last = null;
	for (const record of mainChainRecords(text, "main")) {
		if (isTurnRow(record)) {
			const at = Date.parse(record.timestamp ?? "");
			last = { ended: isTurnEnd(record), at: Number.isFinite(at) ? at : null };
		}
	}
	return last;
}

/** @param {TranscriptRecord} record */
const isTurnEnd = (record) =>
	record.type === "system" && record.subtype === "turn_duration";

/** @param {TranscriptRecord} record */
const isTurnRow = (record) =>
	isTurnEnd(record) ||
	record.type === "assistant" ||
	record.type === "user" ||
	record.type === "api-request" ||
	(record.type === "attachment" &&
		record.attachment?.type === "hook_blocking_error" &&
		record.attachment?.hookEvent === "Stop");

/** @param {string} configDir @param {string} sessionId @returns {string | null} */
function findTranscript(configDir, sessionId) {
	const root = path.join(configDir, "projects");
	let projects;
	try {
		projects = fs.readdirSync(root);
	} catch {
		return null;
	}
	for (const project of projects) {
		const file = path.join(root, project, `${sessionId}.jsonl`);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

/**
 * @param {string[]} dirs
 * @param {string} sessionId
 * @returns {{file: string, mtimeMs: number}|null}
 */
function findNewestTranscript(dirs, sessionId) {
	/** @type {{file: string, mtimeMs: number}|null} */
	let newest = null;
	for (const dir of dirs) {
		const file = findTranscript(dir, sessionId);
		if (!file) continue;
		const mtimeMs = orFallback(() => fs.statSync(file).mtimeMs, null);
		if (mtimeMs !== null && (!newest || mtimeMs > newest.mtimeMs))
			newest = { file, mtimeMs };
	}
	return newest;
}

module.exports = {
	findNewestTranscript,
	standingContext,
	isSubagentTranscript,
	subagentDirOf,
	parseContentText,
	STOP_FEEDBACK,
	mainChainRecords,
	lastStandingContext,
	countTurns,
	turnRecords,
	autocompactions,
	lastTurn,
	isTurnRow,
	findTranscript,
};
