/*
 * subagent-log-state.js — whether a subagent's own log shows a call in flight
 * (#5421), so scripts/watch-artefact.js never calls an agent stalled that is
 * waiting on a long tool call or a long model turn.
 *
 * The log is `<session>/subagents/agent-<agentId>.jsonl`; a background
 * `Agent` launch result's `output_file` is a symlink to it. Beside it the
 * harness keeps `agent-<agentId>.meta.json`.
 *
 * STOPPED, MEASURED over 300 subagent logs on this machine (2026-11-18, #5421):
 * 294 finished agents each carry `"finished": true` in their meta file and
 * end on the `tool_result` of their `SubagentHandback` call; the 2 killed
 * ones end on a user record reading `[Request interrupted by user]`; the 4
 * running ones ended on an `api-request`. So a log's last turn record alone
 * reads a finished agent as mid-turn: the meta flag is what says finished.
 * An assistant record with no tool call is an agent that stopped too — the
 * end of a turn on a harness that hands back without a tool.
 *
 * RESIDUAL: the harness wrote no `finished` flag before November 2026 (all
 * 1,486 logs read in flight on this machine date from October), so there a
 * finished agent reads in flight. The completion notification stops the
 * watcher first; only a dead, unreported agent costs the wait to the ceiling.
 *
 * IN FLIGHT is everything else: an assistant record calling a tool, whose
 * result is not yet written; a user record (a tool result, or the prompt)
 * the model is answering; an `api-request` with no reply. A hung call reads
 * in flight for ever, which the watcher's ceiling bounds.
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
 * Whether one turn record leaves a call in flight.
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
function leavesCallOpen(row) {
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
 * Whether the harness has marked the agent finished in its meta file, read
 * beside the log's real path so a launch result's symlink finds it.
 * @param {string} log
 */
function markedFinished(log) {
	try {
		const meta = fs.realpathSync(log).replace(/\.jsonl$/, ".meta.json");
		return JSON.parse(fs.readFileSync(meta, "utf8"))?.finished === true;
	} catch {
		return false;
	}
}

/**
 * @param {string} log the subagent's own log
 * @returns {LogState}
 */
function subagentLogState(log) {
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
	if (markedFinished(log)) return { state: "stopped" };
	return { state: leavesCallOpen(row) ? "in-flight" : "stopped" };
}

module.exports = { subagentLogState };
