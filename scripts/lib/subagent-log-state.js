const fs = require("node:fs");
const { caught, orFallback } = require("./caught.js");
const { readJsonl, readLastJsonlRow } = require("./jsonl.js");

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

const LAUNCHED =
	/(?:running in background with ID: |moved to the background \(ID: )([a-z0-9]+)/g;
const NOTIFIED = /<task-id>([a-z0-9]+)<\/task-id>/g;
const STOPS = new Set(["TaskStop", "KillShell"]);

/**
 * @param {string} text
 * @param {RegExp} pattern
 */
const idsIn = (text, pattern) =>
	[...text.matchAll(pattern)].map((m) => String(m[1]));

/**
 * @param {import("./transcript.js").TranscriptRecord} row
 * @returns {string[]}
 */
const launchedBy = (row) =>
	row.type === "user"
		? blocksTyped(row, "tool_result").flatMap((b) =>
				idsIn(JSON.stringify(b.content), LAUNCHED),
			)
		: [];

/**
 * @param {import("./transcript.js").TranscriptRecord} row
 * @returns {string[]}
 */
function settledBy(row) {
	if (row.type === "assistant")
		return blocksTyped(row, "tool_use")
			.filter((b) => STOPS.has(String(b.name)))
			.map((b) => {
				const input = /** @type {{task_id?: unknown, shell_id?: unknown}} */ (
					b.input ?? {}
				);
				return String(input.task_id ?? input.shell_id ?? "");
			});
	return row.type === "user" || row.type === "attachment"
		? idsIn(JSON.stringify(row), NOTIFIED)
		: [];
}

/**
 * #5554
 * @param {string} log
 * @returns {boolean}
 */
function hasLiveChildren(log) {
	const read = readJsonl(
		log,
		(line) =>
			line.includes("background") ||
			line.includes("<task-id>") ||
			[...STOPS].some((name) => line.includes(name)),
	);
	const live = new Set();
	for (const row of read?.rows ?? []) {
		for (const id of launchedBy(row)) live.add(id);
		for (const id of settledBy(row)) live.delete(id);
	}
	return live.size > 0;
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
