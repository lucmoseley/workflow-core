const fs = require("node:fs");
const { caught, orFallback } = require("./caught.js");
const { readLastJsonlRow } = require("./jsonl.js");
const { readPendingTasks } = require("./pending-tasks.js");

/** @typedef {{state: "in-flight" | "paused" | "stopped"} | {state: "unread", why: string}} LogState */

const INTERRUPTED = "[Request interrupted by user";
const HANDBACK = "SubagentHandback";

/** @param {Record<string, unknown>} row */
const isTurnRecord = (row) =>
	row.type === "assistant" || row.type === "user" || row.type === "api-request";

/** @param {unknown} content @returns {unknown[]} */
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
 * @param {string} type
 * @returns {Record<string, unknown>[]}
 */
const blocksTyped = (row, type) =>
	/** @type {Record<string, unknown>[]} */ (
		blocksOf(row.message?.content).filter((b) => isBlock(b, type))
	);

/**
 * @param {import("./transcript.js").TranscriptRecord} row
 * @returns {boolean}
 */
function isCallOpen(row) {
	if (row.type === "api-request") return true;
	if (row.type === "assistant")
		return (
			row.message?.stop_reason === "tool_use" ||
			blocksTyped(row, "tool_use").length > 0
		);
	return !blocksTyped(row, "text").some((b) =>
		String(b.text ?? "").startsWith(INTERRUPTED),
	);
}

/**
 * @param {string} log
 * @param {import("./transcript.js").TranscriptRecord} row
 */
function isHandedBack(log, row) {
	const call =
		row.type === "assistant"
			? row
			: orFallback(
					() => readLastJsonlRow(log, (r) => r.type === "assistant"),
					null,
				);
	if (!call) return false;
	const handbacks = blocksTyped(call, "tool_use").filter(
		(b) => b.name === HANDBACK,
	);
	if (row === call) return handbacks.length > 0;
	const ids = new Set(handbacks.map((b) => b.id));
	const results = blocksTyped(row, "tool_result");
	return results.length > 0 && results.every((b) => ids.has(b.tool_use_id));
}

/** @param {string} log */
function isMarkedFinished(log) {
	try {
		const meta = fs.realpathSync(log).replace(/\.jsonl$/, ".meta.json");
		return JSON.parse(fs.readFileSync(meta, "utf8"))?.finished === true;
	} catch {
		return false;
	}
}

/** @type {Map<string, {stamp: string, live: boolean}>} */
const liveByLog = new Map();

/**
 * workflow-core#5554
 * @param {string} log
 */
function hasLiveChildren(log) {
	const stamp = orFallback(() => {
		const { size, mtimeMs } = fs.statSync(log);
		return `${size}:${mtimeMs}`;
	}, "");
	const known = liveByLog.get(log);
	if (stamp && known?.stamp === stamp) return known.live;
	const live = orFallback(
		() => readPendingTasks(log, { sidechain: true }).pending.length > 0,
		false,
	);
	liveByLog.set(log, { stamp, live });
	return live;
}

/** @param {string} log @returns {LogState} */
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
	if (isHandedBack(log, row)) return { state: "stopped" };
	if (!isMarkedFinished(log) && isCallOpen(row)) return { state: "in-flight" };
	return { state: hasLiveChildren(log) ? "paused" : "stopped" };
}

module.exports = { readSubagentLogState };
