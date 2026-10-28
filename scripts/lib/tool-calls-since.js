/*
 * tool-calls-since.js — how many tool calls, or founder messages, a session's
 * transcript holds after a moment in time, and which question rounds stand.
 * The priced-options guard's limbs ask it whether a session acted since a
 * refusal or since the founder last spoke, whether he has spoken since,
 * which rounds he has yet to answer, whether a Stop hook refused a turn
 * they passed, and which tools it called since a refusal, inputs included
 * (#486, #660, #924, #1710, #1799, #2006).
 *
 * A FOUNDER MESSAGE is a top-level user record that is text he typed. The harness writes four other things as user records, and none of
 * them is him: a tool result, a hook's `Stop hook feedback:` (a meta record), a
 * `<task-notification>` (origin kind `task-notification`), and a skill's
 * expanded body (meta). Most records carry `origin.kind`, which settles it
 * where present; an origin-less one — an older harness, or a scripted
 * `claude -p` prompt — is read by its text instead. Census on #488. The
 * refill loop's resume prompts (lib/loop-prompts.js) carry origin kind
 * `human`, so their prefix is read before the origin (#3378).
 *
 * A TRANSCRIPT TOO LARGE TO READ WHOLE IS READ BY ITS TAIL
 * (`lib/session-transcript.js`), so a moment before the tail's start counts
 * only what the tail holds.
 */

const { read } = require("./session-transcript");
const { STOP_FEEDBACK, mainChainRecords } = require("./transcript");
const { roundNumber } = require("./round-marker");
const { isLoopPrompt } = require("./loop-prompts");

/* A parsed transcript line, typed as loosely as `mainChainRecords` yields it:
 * the harness's record shapes are undocumented and vary by record type. */
/** @typedef {Record<string, any>} TranscriptRecord */

/* Origin-less text the harness wrote rather than the founder, bar Stop
 * feedback (`STOP_FEEDBACK`). */
const HARNESS_TEXT =
	/^\s*(?:<task-notification>|<local-command-|<bash-stdout>|<bash-stderr>)/;

/**
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
const isToolResult = (rec) =>
	Array.isArray(rec.message?.content) &&
	rec.message.content.some((/** @type {any} */ p) => p?.type === "tool_result");

/**
 * Whether `rec` opens a turn: a user record, but no tool result, meta record
 * (a skill's body, a Stop hook's feedback) or compaction summary.
 * @param {TranscriptRecord} rec a top-level record
 * @returns {boolean}
 */
const isTurnStart = (rec) =>
	rec.type === "user" &&
	!rec.isMeta &&
	!rec.isCompactSummary &&
	!isToolResult(rec);

/**
 * @param {TranscriptRecord} rec a top-level record
 * @returns {boolean}
 */
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
	if (!text.trim() || isLoopPrompt(text)) return false;
	return (
		Boolean(rec.origin) ||
		!(HARNESS_TEXT.test(text) || STOP_FEEDBACK.test(text))
	);
}

/** @typedef {{ name: string, input: Record<string, unknown> }} ToolCall */

/**
 * @param {TranscriptRecord} rec a top-level record
 * @returns {ToolCall[]} the `tool_use` parts it carries, where it is the
 *   assistant's; an input that is not an object reads as empty
 */
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

/**
 * @param {TranscriptRecord} rec a top-level record
 * @returns {number} the `tool_use` parts it carries, where it is the assistant's
 */
const toolUses = (rec) => toolCalls(rec).length;

/**
 * @param {string} file the session's transcript path
 * @returns {TranscriptRecord[]}
 */
const mainRecords = (file) => [...mainChainRecords(read(file), "main")];

/**
 * The main-chain records stamped later than `at`.
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {TranscriptRecord[] | null} null where the transcript parsed to
 *   nothing — no verdict, since the turn being judged is itself in that file.
 * @throws whatever reading the file throws; the caller fails open on it.
 */
function recordsSince(file, at) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	const t = new Date(at).getTime();
	return recs.filter((rec) => Date.parse(rec.timestamp) > t);
}

/**
 * The tool calls stamped later than `at`, in order, each with its input — the
 * research-ladder limb matches a Bash call's command (#2006).
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {ToolCall[] | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
const toolCallsSince = (file, at) =>
	recordsSince(file, at)?.flatMap(toolCalls) ?? null;

/**
 * The names of the tool calls stamped later than `at`, in order.
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {string[] | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
const toolNamesSince = (file, at) =>
	toolCallsSince(file, at)?.map((call) => call.name) ?? null;

/**
 * Tool calls stamped later than `at`.
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {number | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
const sinceTime = (file, at) => toolNamesSince(file, at)?.length ?? null;

/**
 * Tool calls since the founder's last message, or since the transcript's
 * start where he has sent none (#1710).
 * @param {string} file the session's transcript path
 * @returns {number | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
function sinceFounder(file) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	let n = 0;
	for (const rec of recs) n = isFounderMessage(rec) ? 0 : n + toolUses(rec);
	return n;
}

/**
 * Founder messages stamped later than `at`.
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {number | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
function founderMessagesSince(file, at) {
	return recordsSince(file, at)?.filter(isFounderMessage).length ?? null;
}

/**
 * Whether the turn that stopped at `at` is still running because a Stop hook
 * refused it: a Stop refusal stamped later, and nothing since that starts a
 * new turn (#1799).
 * @param {string} file the session's transcript path
 * @param {string | number | Date} at
 * @returns {boolean | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller fails open on it.
 */
function isTurnRefusedSince(file, at) {
	const recs = recordsSince(file, at);
	if (recs === null) return null;
	return recs.some(isStopRefusal) && !recs.some(isTurnStart);
}

/**
 * @param {TranscriptRecord} rec
 * @returns {string} its text, string or parts alike
 */
function textOf(rec) {
	const content = rec.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((p) => p?.text ?? "").join("\n");
}

/**
 * The round numbers the assistant's text has opened since the founder last
 * spoke — the rounds still standing (#924). A Stop hook refusal drops the
 * rounds of the turn it refused, so a round a guard sent back for correction
 * is never pointed at — whichever guard refused it, which costs at worst a
 * re-print.
 * @param {string} file the session's transcript path
 * @returns {string[] | null} as `recordsSince`
 * @throws whatever reading the file throws; the caller decides the fail mode.
 */
function standingRounds(file) {
	const recs = mainRecords(file);
	if (recs.length === 0) return null;
	/** @type {Set<string>} */
	const standing = new Set();
	/** @type {Set<string>} the rounds of the turn not yet known to have ended */
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

/**
 * @param {TranscriptRecord} rec
 * @returns {string[]} the round numbers its text opens, in order
 */
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
	// close-rivals.js, through refusal-limb.js's fromTranscript
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
