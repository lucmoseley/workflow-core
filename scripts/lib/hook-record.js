const fs = require("node:fs");
const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");

/**
 * @typedef {{hook_event_name?: string, last_assistant_message?: unknown, stop_hook_active?: unknown}} HookPayload
 */

const PREFIX = ".hook-ran-";

const DIR_NAME = ".hook-breadcrumbs";

/**
 * @param {string} root
 * @returns {string}
 */
function recordsDir(root) {
	return path.join(markersDir(root), DIR_NAME);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const NO_SESSION = "unknown-session";

// guess, lucmoseley/mantahostels#1274
const CAP_BYTES = 32_768;

/**
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function safeId(sessionId) {
	return sessionId && SAFE_ID.test(sessionId) ? sessionId : NO_SESSION;
}

const VERDICT_OUTCOMES = ["message", "no-finding", "inventory-stand-down"];

const OUTCOMES = [
	...VERDICT_OUTCOMES,
	"empty-message",
	"no-transcript",
	"unreadable-transcript",
	"no-session-id",
	"no-payload",
];

const SOURCE_PAYLOAD = "payload";
const SOURCE_TRANSCRIPT = "transcript";
const SOURCES = [SOURCE_PAYLOAD, SOURCE_TRANSCRIPT];

/**
 * @param {string} [argv1]
 * @returns {string}
 */
function guardName(argv1 = process.argv[1] || "") {
	const base = normaliseGuardName(path.basename(argv1));
	return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? base : "unknown-guard";
}

/**
 * @param {string} name
 * @returns {string}
 */
function normaliseGuardName(name) {
	return String(name).replace(/\.(js|cjs|mjs)$/, "");
}

/**
 * @param {string} root
 * @param {string} guard
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function recordPath(root, guard, sessionId) {
	return path.join(recordsDir(root), `${PREFIX + guard}-${safeId(sessionId)}`);
}

/**
 * @param {string} file
 * @returns {number}
 */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isCapped(file) {
	try {
		return readJsonl(file)?.rows.at(-1)?.capped === true;
	} catch {
		return false;
	}
}

/**
 * @param {{root?: string, guard?: string, sessionId?: string|null, outcome: string, payload?: HookPayload|null, source?: string|null, transcriptLen?: number|null}} spec
 * @returns {boolean}
 */
function record({
	root = process.cwd(),
	guard = guardName(),
	sessionId,
	outcome,
	payload,
	source = null,
	transcriptLen = null,
}) {
	if (!OUTCOMES.includes(outcome)) return false;
	const event = payload?.hook_event_name;
	if (event && event !== "Stop") return false;

	const file = recordPath(root, guard, sessionId);
	const session = safeId(sessionId);
	try {
		fs.mkdirSync(recordsDir(root), { recursive: true });
		if (sizeOf(file) >= CAP_BYTES) {
			if (isCapped(file)) return false;
			const sentinel = { guard, session, capped: true, at: nowISO() };
			fs.appendFileSync(file, `${JSON.stringify(sentinel)}\n`);
			return false;
		}
		const fromPayload = payload?.last_assistant_message;
		const line = {
			guard,
			session,
			outcome,
			source: source !== null && SOURCES.includes(source) ? source : null,
			// lucmoseley/mantahostels#1274
			payloadLen: typeof fromPayload === "string" ? fromPayload.length : null,
			transcriptLen: Number.isInteger(transcriptLen) ? transcriptLen : null,
			stopHookActive: !!payload?.stop_hook_active,
			at: nowISO(),
		};
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		return false;
	}
	return true;
}

/** @returns {string} */
function nowISO() {
	return new Date().toISOString();
}

module.exports = {
	record,
	guardName,
	normaliseGuardName,
	SOURCE_PAYLOAD,
	SOURCE_TRANSCRIPT,
	VERDICT_OUTCOMES,
	PREFIX,
	recordsDir,
};
