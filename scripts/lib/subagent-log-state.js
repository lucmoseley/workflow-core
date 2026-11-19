/*
 * subagent-log-state.js — whether a subagent's own log shows a call in flight
 * (#5421), so scripts/watch-artefact.js never calls an agent stalled that is
 * waiting on a long tool call or a long model turn.
 *
 * The log is `<session>/subagents/agent-<agentId>.jsonl`; a background
 * `Agent` launch result's `output_file` is a symlink to it. Beside it the
 * harness keeps `agent-<agentId>.meta.json`.
 *
 * STOPPED: the meta file's `"finished": true`, since a finished agent's log
 * ends on its `SubagentHandback` `tool_result` (#5421); a user record reading
 * `[Request interrupted by user]`; or an assistant record with no tool call.
 *
 * RESIDUAL: the harness wrote no `finished` flag before November 2026, so on
 * such a harness a finished agent reads in flight.
 *
 * IN FLIGHT is everything else: an assistant record calling a tool, whose
 * result is not yet written; a user record (a tool result, or the prompt)
 * the model is answering; an `api-request` with no reply.
 *
 * UNREAD is a log missing, unreadable, or holding no turn record: the caller
 * judges on growth alone and says so.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { readLastJsonlRow } = require("./jsonl.js");

/** @typedef {{state: "in-flight" | "stopped"} | {state: "unread", why: string}} LogState */

const INTERRUPTED = "[Request interrupted by user";

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
	if (isMarkedFinished(log)) return { state: "stopped" };
	return { state: isCallOpen(row) ? "in-flight" : "stopped" };
}

module.exports = { readSubagentLogState };
