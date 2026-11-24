const fs = require("node:fs");
const path = require("node:path");
const { readFdAll } = require("./read-fd.js");
const hookRecord = require("./hook-record");
const sessionId = require("./session-id");
const { transcriptPath: seatTranscriptPath } = require("./project-slug.js");
const { configDir } = require("./config-dir.js");
const { parseJsonl } = require("./jsonl.js");

/**
 * @typedef {{
 *   session_id?: string,
 *   last_assistant_message?: string,
 *   prompt?: string,
 *   source?: string,
 *   transcript_path?: string,
 * }} HookPayload
 */

// lucmoseley/mantahostels#1273
/**
 * @param {string} file
 * @returns {string}
 */
function readOutgoingMessage(file) {
	const { rows } = parseJsonl(fs.readFileSync(file, "utf8"));
	const parts = [];
	for (const rec of /** @type {Array<TranscriptRecord & Record<string, unknown>>} */ (
		rows
	).reverse()) {
		if (rec.isSidechain) continue;
		if (rec.type === "user") break;
		if (rec.type !== "assistant") continue;
		parts.unshift(...textPartsOf(rec));
	}
	return parts.join("\n");
}

/** @typedef {{message?: {content?: unknown}}} TranscriptRecord */

/**
 * @param {TranscriptRecord} rec
 * @returns {string[]}
 */
function textPartsOf(rec) {
	const content = rec.message?.content || [];
	if (!Array.isArray(content)) return [];
	/** @type {string[]} */
	const texts = [];
	for (const part of content) {
		if (part && part.type === "text" && part.text) texts.push(part.text);
	}
	return texts;
}

/**
 * @param {string} sid
 * @returns {string}
 */
function conventionalTranscript(sid) {
	// workflow-core#4236
	const { corpusDirs } = require("./project-dirs.js");
	const name = `${sid}.jsonl`;
	for (const dir of corpusDirs()) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return seatTranscriptPath(configDir(), process.cwd(), sid);
}

/**
 * @param {HookPayload|null|undefined} input
 * @param {string} sid
 * @returns {string}
 */
function transcriptPath(input, sid) {
	const supplied = input?.transcript_path;
	if (supplied && fs.existsSync(supplied)) return supplied;
	return conventionalTranscript(sid);
}

/** @returns {HookPayload|null} */
function readPayload() {
	let raw;
	try {
		raw = readFdAll(0).toString("utf8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * @param {HookPayload|null|undefined} input
 * @param {string} transcript
 * @param {(err: unknown) => void} [onError]
 * @returns {string}
 */
function readMessageText(input, transcript, onError) {
	const supplied = input?.last_assistant_message;
	if (typeof supplied === "string" && supplied.trim()) return supplied;
	try {
		return readOutgoingMessage(transcript);
	} catch (err) {
		onError?.(err);
		return "";
	}
}

/**
 * @param {HookPayload|null} input
 * @param {{root?: string, guard?: string}} [options]
 * @returns {{sessionId: string, message: string}|null}
 */
function readMessageFrom(input, options = {}) {
	const sid = sessionId.fromPayload(input);
	/** @type {string|null} */
	let source = null;
	/** @type {number|null} */
	let transcriptLen = null;

	const done = (
		/** @type {string} */ outcome,
		/** @type {{sessionId: string, message: string}|null} */ result,
	) => {
		hookRecord.record({
			root: options.root,
			guard: options.guard,
			sessionId: sid,
			outcome,
			payload: input,
			source,
			transcriptLen,
		});
		return result;
	};

	if (!input) return done("no-payload", null);
	if (!sid) return done("no-session-id", null);

	const supplied = input.last_assistant_message;
	if (typeof supplied === "string" && supplied.trim()) {
		source = hookRecord.SOURCE_PAYLOAD;
		return done("message", { sessionId: sid, message: supplied });
	}

	let transcript = input.transcript_path;
	if (!transcript || !fs.existsSync(transcript))
		transcript = conventionalTranscript(sid);
	if (!fs.existsSync(transcript)) return done("no-transcript", null);

	let message;
	try {
		message = readOutgoingMessage(transcript);
	} catch {
		return done("unreadable-transcript", null);
	}
	transcriptLen = message.length;
	if (!message) return done("empty-message", null);
	source = hookRecord.SOURCE_TRANSCRIPT;
	return done("message", { sessionId: sid, message });
}

module.exports = {
	transcriptPath,
	readPayload,
	readMessageText,
	readMessageFrom,
};
