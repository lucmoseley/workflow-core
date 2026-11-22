const fs = require("node:fs");
const { parseJsonl } = require("./jsonl.js");
const { requiredGroup } = require("./regex-group.js");

const NOTIFICATION =
	/<task-notification>((?:(?!<task-notification>)[\s\S])*?)<\/task-notification>/g;
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;

const INTERIM =
	/the result below may be interim|<result>This agent has not reported yet/;

const HANDED_BACK = /"prompt":"<agent-message from=\\"(\w+)\\"/g;

const ANNOUNCES_HANDLE =
	/running in background with ID|Async agent launched successfully|agent is working in the background/i;

const MOVED_TO_BACKGROUND =
	/^Command did not complete within its \d+s timeout and was moved to the background/;

const FORKED_SKILL =
	/^Skill "[^"]*" launched \(forked execution, running in the background\)/;

const HANDLE =
	/(?:running in background with ID: |moved to the background \(ID: |agentId: )(\w+)/;

const STOPPED = /Successfully stopped task: (\w+)/;

/**
 * @typedef {{ id: string, kind: string, name: string }} Launch
 * @typedef {{ records: number, launches: Launch[], pending: Launch[] }} Pending
 */

/** @param {{input?: {description?: unknown, command?: unknown, skill?: unknown}}} part */
function callName(part) {
	const i = part.input ?? {};
	const raw = [i.description, i.command, i.skill].find(
		(v) => typeof v === "string" && v.trim(),
	);
	return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @typedef {{
 *   launches: Map<string, Launch>,
 *   settled: Set<string>,
 *   settledHandles: Set<string>,
 *   results: Map<string, {error: boolean, announced: boolean}>,
 *   handles: Map<string, string>,
 *   stopped: Set<string>,
 *   taskStopCalls: Set<string>,
 *   bashCallNames: Map<string, string>,
 *   skillCallNames: Map<string, string>,
 * }} Census
 */

/**
 * @param {string} file
 * @param {{sidechain?: boolean}} [opts] #5554
 * @returns {Pending}
 */
function readPendingTasks(file, { sidechain = false } = {}) {
	/** @type {Census} */
	const census = {
		launches: new Map(),
		settled: new Set(),
		settledHandles: new Set(),
		results: new Map(),
		handles: new Map(),
		stopped: new Set(),
		taskStopCalls: new Set(),
		bashCallNames: new Map(),
		skillCallNames: new Map(),
	};
	const text = fs.readFileSync(file, "utf8");

	readSettlements(census, text);

	const { rows } = parseJsonl(text);
	for (const rec of /** @type {TranscriptRecord[]} */ (rows))
		if (sidechain || !rec.isSidechain) readRecord(census, rec);
	const records = rows.length;

	const all = [...census.launches.values()];
	return {
		records,
		launches: all,
		pending: all.filter((l) => isStillOut(census, l)),
	};
}

/**
 * @param {Census} census
 * @param {string} text
 */
function readSettlements(census, text) {
	for (const m of text.matchAll(NOTIFICATION)) {
		const block = requiredGroup(m, 1, NOTIFICATION);
		if (INTERIM.test(block)) continue;
		const id = TOOL_USE_ID.exec(block)?.[1];
		if (id !== undefined) census.settled.add(id);
		const handle = TASK_ID.exec(block)?.[1];
		if (handle !== undefined) census.settledHandles.add(handle);
	}
	for (const m of text.matchAll(HANDED_BACK))
		census.settledHandles.add(requiredGroup(m, 1, HANDED_BACK));
}

/**
 * @param {Census} census
 * @param {TranscriptRecord} rec
 */
function readRecord(census, rec) {
	const content = rec.message?.content;
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "tool_result" && part.tool_use_id) {
			readResult(census, part, rec.toolUseResult);
			continue;
		}
		if (part?.type !== "tool_use" || !part.id) continue;
		readCall(census, part);
	}
}

/**
 * @param {Census} census
 * @param {TranscriptBlock} part
 * @param {TranscriptRecord["toolUseResult"]} toolUseResult
 */
function readResult(census, part, toolUseResult) {
	const id = part.tool_use_id;
	const body =
		typeof part.content === "string"
			? part.content
			: JSON.stringify(part.content ?? "");
	census.results.set(id, {
		error: part.is_error === true,
		announced: ANNOUNCES_HANDLE.test(body),
	});
	const text =
		typeof part.content === "string"
			? part.content
			: (part.content?.[0]?.text ?? "");
	readHandle(census, id, text, toolUseResult);
	if (census.taskStopCalls.has(id) && part.is_error !== true)
		readStop(census, text, toolUseResult);
	const moved =
		MOVED_TO_BACKGROUND.test(text) || toolUseResult?.backgroundTaskId;
	if (moved && census.bashCallNames.has(id) && !census.launches.has(id))
		census.launches.set(id, {
			id,
			kind: "background command",
			name: census.bashCallNames.get(id) ?? "",
		});
	const forked =
		FORKED_SKILL.test(text) ||
		(toolUseResult?.status === "forked" && toolUseResult?.background === true);
	if (forked && census.skillCallNames.has(id))
		census.launches.set(id, {
			id,
			kind: "forked skill",
			name: census.skillCallNames.get(id) ?? "",
		});
}

/**
 * @param {Census} census
 * @param {string} id
 * @param {string} text
 * @param {TranscriptRecord["toolUseResult"]} toolUseResult
 */
function readHandle(census, id, text, toolUseResult) {
	const handle =
		toolUseResult?.backgroundTaskId ??
		toolUseResult?.agentId ??
		HANDLE.exec(text)?.[1];
	if (typeof handle === "string") census.handles.set(id, handle);
}

/**
 * @param {Census} census
 * @param {string} text
 * @param {TranscriptRecord["toolUseResult"]} toolUseResult
 */
function readStop(census, text, toolUseResult) {
	const stopped = toolUseResult?.task_id ?? STOPPED.exec(text)?.[1];
	if (typeof stopped === "string") census.stopped.add(stopped);
}

/**
 * @param {Census} census
 * @param {TranscriptBlock} part
 */
function readCall(census, part) {
	const name = callName(part);
	if (part.name === "Bash") census.bashCallNames.set(part.id, name);
	if (part.name === "Skill") census.skillCallNames.set(part.id, name);
	if (part.name === "TaskStop") census.taskStopCalls.add(part.id);
	if (part.name === "Agent")
		census.launches.set(part.id, { id: part.id, kind: "subagent", name });
	else if (part.name === "Bash" && part.input?.run_in_background)
		census.launches.set(part.id, {
			id: part.id,
			kind: "background command",
			name,
		});
}

/**
 * @param {Census} census
 * @param {Launch} l
 * @returns {boolean}
 */
function isStillOut(census, l) {
	if (census.settled.has(l.id)) return false;
	const handle = census.handles.get(l.id);
	if (handle !== undefined && census.stopped.has(handle)) return false;
	if (
		l.kind === "subagent" &&
		handle !== undefined &&
		census.settledHandles.has(handle)
	)
		return false;
	const res = census.results.get(l.id);
	if (!res) return true;
	if (res.error) return false;
	if (l.kind === "subagent") return res.announced;
	return true;
}

module.exports = { readPendingTasks };
