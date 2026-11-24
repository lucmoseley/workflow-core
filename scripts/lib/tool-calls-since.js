const { read } = require("./session-transcript");
const { STOP_FEEDBACK, mainChainRecords } = require("./transcript");
const { roundNumber } = require("./round-marker");
const { isPrefixedPrompt } = require("./loop-prompts");

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

const HARNESS_TEXT =
	/^\s*(?:<task-notification>|<local-command-|<bash-stdout>|<bash-stderr>)/;

/**
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
const isToolResult = (rec) =>
	Array.isArray(rec.message?.content) &&
	rec.message.content.some(
		(/** @type {TranscriptBlock} */ p) => p?.type === "tool_result",
	);

/** @param {TranscriptRecord} rec @returns {boolean} */
const isTurnStart = (rec) =>
	rec.type === "user" &&
	!rec.isMeta &&
	!rec.isCompactSummary &&
	!isToolResult(rec);

/** @param {TranscriptRecord} rec @returns {boolean} */
function isFounderMessage(rec) {
	if (!isTurnStart(rec)) return false;
	if (rec.origin && rec.origin.kind !== "human") return false;
	const content = rec.message?.content;
	let text;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter((p) => p?.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	} else return false;
	if (!text.trim() || isPrefixedPrompt(text)) return false;
	return (
		Boolean(rec.origin) ||
		!(HARNESS_TEXT.test(text) || STOP_FEEDBACK.test(text))
	);
}

/** @typedef {{ name: string, input: Record<string, unknown> }} ToolCall */

/** @param {TranscriptRecord} rec @returns {ToolCall[]} */
function toolCalls(rec) {
	if (rec.type !== "assistant") return [];
	const content = rec.message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((p) => p?.type === "tool_use")
		.map((p) => ({
			name: String(p.name ?? ""),
			input:
				typeof p.input === "object" &&
				p.input !== null &&
				!Array.isArray(p.input)
					? p.input
					: {},
		}));
}

/** @param {TranscriptRecord} rec @returns {number} */
const toolUses = (rec) => toolCalls(rec).length;

/** @param {string} file @returns {TranscriptRecord[]} */
const mainRecords = (file) => [...mainChainRecords(read(file), "main")];

/**
 * @param {string} file
 * @param {string | number | Date} at
 * @returns {TranscriptRecord[] | null}
 */
function recordsSince(file, at) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	const t = new Date(at).getTime();
	return recs.filter((rec) => Date.parse(rec.timestamp) > t);
}

/** @param {string} file @param {string | number | Date} at @returns {ToolCall[] | null} */
const toolCallsSince = (file, at) =>
	recordsSince(file, at)?.flatMap(toolCalls) ?? null;

/** @param {string} file @param {string | number | Date} at @returns {string[] | null} */
const toolNamesSince = (file, at) =>
	toolCallsSince(file, at)?.map((call) => call.name) ?? null;

/** @param {string} file @param {string | number | Date} at @returns {number | null} */
const sinceTime = (file, at) => toolNamesSince(file, at)?.length ?? null;

/** @param {string} file @returns {number | null} */
function sinceFounder(file) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	let n = 0;
	for (const rec of recs) n = isFounderMessage(rec) ? 0 : n + toolUses(rec);
	return n;
}

/** @param {string} file @param {string | number | Date} at @returns {number | null} */
function founderMessagesSince(file, at) {
	return recordsSince(file, at)?.filter(isFounderMessage).length ?? null;
}

/** @param {string} file @param {string | number | Date} at @returns {boolean | null} */
function isTurnRefusedSince(file, at) {
	const recs = recordsSince(file, at);
	if (recs === null) return null;
	return recs.some(isStopRefusal) && !recs.some(isTurnStart);
}

/** @param {TranscriptRecord} rec @returns {string} */
function textOf(rec) {
	const content = rec.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => p?.text ?? "").join("\n");
}

/** @param {string} file @returns {string[] | null} */
function standingRounds(file) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	/** @type {Set<string>} */
	const standing = new Set();
	/** @type {Set<string>} */
	let turn = new Set();
	const settle = () => {
		for (const n of turn) standing.add(n);
		turn = new Set();
	};
	for (const rec of recs) {
		if (rec.type === "assistant") for (const n of roundsIn(rec)) turn.add(n);
		else if (isFounderMessage(rec)) {
			standing.clear();
			turn = new Set();
		} else if (isStopRefusal(rec)) turn = new Set();
		else if (rec.type === "user" && !isToolResult(rec)) settle();
	}
	settle();
	return [...standing];
}

/** @param {TranscriptRecord} rec @returns {string[]} */
function roundsIn(rec) {
	/** @type {string[]} */
	const rounds = [];
	for (const line of textOf(rec).split("\n")) {
		const n = roundNumber(line);
		if (n !== null) rounds.push(n);
	}
	return rounds;
}

/**
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
const isStopRefusal = (rec) =>
	rec.type === "user" && STOP_FEEDBACK.test(textOf(rec));

module.exports = {
	sinceTime,
	toolCallsSince,
	toolNamesSince,
	sinceFounder,
	founderMessagesSince,
	isTurnRefusedSince,
	standingRounds,
	isFounderMessage,
	textOf,
};
