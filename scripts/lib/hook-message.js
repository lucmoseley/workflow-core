/*
 * hook-message.js — the outgoing assistant message, as a Stop hook sees it.
 *
 * Every failure path returns empty rather than throwing: a guard that breaks
 * the session is worse than one that misses a turn.
 *
 * Every `readMessageFrom` call records what it saw in this session's breadcrumb
 * (`lib/hook-record.js`), here in the seam rather than in each guard (mantahostels#872).
 *
 * The outgoing text comes off the payload's `last_assistant_message`, which the
 * harness computes from memory at dispatch, so the transcript flush race cannot
 * reach it (mantahostels#1272, mantahostels#1273). The transcript scan below survives as a permanent
 * fallback for the turns where that field is absent or empty: it is declared
 * `.optional()` in the harness's own Stop schema, and a seam reading a bare
 * field would, on a version that omits it, hand both guards the empty string
 * and pass everything silently.
 */

const fs = require("node:fs");
const path = require("node:path");
const hookRecord = require("./hook-record");
const sessionId = require("./session-id");
const { projectSlug } = require("./project-slug.js");
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

/**
 * The outgoing message is every text part of the assistant records that follow
 * the last real user turn. It is assembled rather than taken from the final
 * record because one turn's text can be split across several.
 * @param {string} file transcript path
 * @returns {string}
 */
function readOutgoingMessage(file) {
	const { rows } = parseJsonl(fs.readFileSync(file, "utf8"));
	const parts = [];
	for (const rec of /** @type {Array<TranscriptRecord & Record<string, unknown>>} */ (
		rows
	).reverse()) {
		/* A subagent writes into the same file; its messages are not outgoing. */
		if (rec.isSidechain) continue;
		if (rec.type === "user") break;
		if (rec.type !== "assistant") continue;
		parts.unshift(...textPartsOf(rec));
	}
	return parts.join("\n");
}

/**
 * Parsed JSON, so nothing in it is guaranteed and every field read is checked
 * where it is read.
 * @typedef {{message?: {content?: unknown}}} TranscriptRecord
 */

/**
 * An assistant record's text parts, in content order.
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
 * Where this session's transcript lives when the payload does not say. The
 * project directory is `projectSlug`'s spelling of the cwd.
 *
 * This site mapped the SLASHES ALONE until mantahostels#1982, so any project root holding a
 * dot resolved to a directory that does not exist — and the caller reported
 * that as a session with no transcript rather than as a lookup sent to the
 * wrong place.
 *
 * The root is lib/config-dir.js's `configDir()` (mantahostels#872, #2095).
 * @param {string} sid
 * @returns {string}
 */
function conventionalTranscript(sid) {
	const slug = projectSlug();
	return path.join(configDir(), "projects", slug, `${sid}.jsonl`);
}

/**
 * The transcript a guard reading more than the outgoing message should open
 * (mantahostels#2487). The payload's own path first, because the harness knows where it put
 * the file; `conventionalTranscript` only where that is absent or gone, which
 * is the same order `readMessageFrom` falls back in.
 *
 * Returns the path whether or not it exists — every caller has to survive an
 * unreadable one anyway, and a null here would be a second way to say the same
 * thing.
 * @param {HookPayload|null|undefined} input the parsed hook payload
 * @param {string} sid the session id, for the fallback
 * @returns {string}
 */
function transcriptPath(input, sid) {
	const supplied = input?.transcript_path;
	if (supplied && fs.existsSync(supplied)) return supplied;
	return conventionalTranscript(sid);
}

/**
 * The hook payload on stdin, parsed.
 * @returns {HookPayload|null} null on an empty or unparseable payload
 */
function readPayload() {
	let raw;
	try {
		raw = fs.readFileSync(0, "utf8");
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
 * The outgoing message, recording nothing — for a guard that writes its own
 * breadcrumb or none, which `readMessageFrom` would otherwise double (#73).
 * @param {HookPayload|null|undefined} input the parsed hook payload
 * @param {string} transcript the fallback, read only where the payload's
 *   message is absent or whitespace
 * @param {(err: unknown) => void} [onError] told why an unreadable transcript
 *   came back empty
 * @returns {string} empty where neither route yields text
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
 * Payload in, outgoing message out.
 *
 * Each null path writes its own outcome name into the breadcrumb on the way out
 * (mantahostels#872), alongside the route that produced the message (mantahostels#1274).
 *
 * @param {HookPayload|null} input the parsed hook payload
 * @param {{root?: string, guard?: string}} [options] where the breadcrumb goes
 *   and whose name it carries; both default in `lib/hook-record.js`.
 * @returns {{sessionId: string, message: string}|null}
 */
function readMessageFrom(input, options = {}) {
	const sid = sessionId.fromPayload(input);
	/* The record's discriminators: which route the verdict came from, and what
	 * the fallback read if it ran at all (mantahostels#1274). */
	/** @type {string|null} */
	let source = null;
	/** @type {number|null} */
	let transcriptLen = null;

	/* Recording is best-effort and never throws, so it cannot cost a verdict. */
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

	/* Whitespace-only counts as empty: a guard handed it would find nothing and
	 * pass silently. */
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
