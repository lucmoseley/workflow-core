const fs = require("node:fs");
const { caught } = require("./caught.js");
const { readLastJsonlRow } = require("./jsonl.js");

/** @typedef {{state: "in-flight" | "stopped"} | {state: "unread", why: string}} LogState */

const INTERRUPTED = "[Request interrupted by user";
const HANDBACK = "SubagentHandback";

/** @param {Record<string, unknown>} row */
const isTurnRecord = (row) =>
	row.type === "assistant" || row.type === "user" || row.type === "api-request";

/**
 * @param {unknown} content a message's content, string or blocks
 * @returns {unknown[]}
 */
const blocksOf = (content) =>
	Array.isArray(content) ? content : [{ type: "text", text: content }];

/**
 * @param {unknown} block
 * @param {string} type
 */
const isBlock = (block, type) =>
	block !== null &&
	typeof block === "object" &&
	/** @type {{type?: unknown}} */ (block).type === type;

/**
 * @param {import("./transcript.js").TranscriptRecord} row
 * @returns {boolean}
 */
function isCallOpen(row) {
	if (row.type === "api-request") return true;
	const blocks = blocksOf(row.message?.content);
	if (row.type === "assistant")
		return (
			row.message?.stop_reason === "tool_use" ||
			blocks.some((b) => isBlock(b, "tool_use"))
		);
	return !blocks.some(
		(b) =>
			isBlock(b, "text") &&
			String(/** @type {{text?: unknown}} */ (b).text ?? "").startsWith(
				INTERRUPTED,
			),
	);
}

/**
 * @param {import("./transcript.js").TranscriptRecord} row
 * @param {string} type
 * @returns {Record<string, unknown>[]}
 */
const blocksTyped = (row, type) =>
	/** @type {Record<string, unknown>[]} */ (
		blocksOf(row.message?.content).filter((b) => isBlock(b, type))
	);

/**
 * @param {string} log
 * @param {import("./transcript.js").TranscriptRecord} row
 */
function isHandedBack(log, row) {
	let call = row.type === "assistant" ? row : null;
	if (row.type === "user")
		try {
			call = readLastJsonlRow(log, (r) => r.type === "assistant") ?? null;
		} catch {
			return false;
		}
	if (!call) return false;
	const handbacks = blocksTyped(call, "tool_use").filter(
		(b) => b.name === HANDBACK,
	);
	if (row === call) return handbacks.length > 0;
	const ids = new Set(handbacks.map((b) => b.id));
	const results = blocksTyped(row, "tool_result");
	return results.length > 0 && results.every((b) => ids.has(b.tool_use_id));
}

/**
 * The meta file is read beside the log's real path, so a launch result's
 * symlink finds it.
 * @param {string} log
 */
function isMarkedFinished(log) {
	try {
		const meta = fs.realpathSync(log).replace(/\.jsonl$/, ".meta.json");
		return JSON.parse(fs.readFileSync(meta, "utf8"))?.finished === true;
	} catch {
		/* Fail-open to in flight (#5421): no meta file, or none that reads,
		 * leaves the log's own record to judge, and a finished agent read live
		 * costs only a watch its completion notification stops. */
		return false;
	}
}

/**
 * @param {string} log the subagent's own log
 * @returns {LogState}
 */
function readSubagentLogState(log) {
	let row;
	try {
		row = readLastJsonlRow(log, isTurnRecord);
	} catch (e) {
		const { code, message } = caught(e);
		return { state: "unread", why: `cannot read ${log}: ${code ?? message}` };
	}
	if (row === null) return { state: "unread", why: `${log} does not exist` };
	if (row === undefined)
		return { state: "unread", why: `${log} holds no turn record` };
	if (isMarkedFinished(log) || isHandedBack(log, row))
		return { state: "stopped" };
	return { state: isCallOpen(row) ? "in-flight" : "stopped" };
}

module.exports = { readSubagentLogState };
