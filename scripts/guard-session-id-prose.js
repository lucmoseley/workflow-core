#!/usr/bin/env node
/*
 * guard-session-id-prose.js — Stop hook. Sends a reply back once where its
 * prose names a session by id rather than by name (#3557).
 *
 * WHY. Core voice §Comprehension: a session is named by its `claude agents
 * --json` name, never its id or pid, and an id appears only where a command
 * needs it. #2478 restored that rule with no guard, and on 29 Oct a session
 * copied three holder ids out of arbiter output into four replies. The
 * arbiter now names holders from the registry when the oracle refuses, so a
 * tool printing a bare id is rarer; this catches the copy into prose.
 *
 * WHAT IS READ. The outgoing message with every fenced block and code span
 * removed: a command carrying an id sits in one. In what is left it finds:
 *   - `session <id>`, the id a full UUID or its 8-hex prefix, whatever the
 *     registry holds;
 *   - a bare full UUID, or a bare 8-hex word, that is the id or the id's
 *     prefix of a session in the sessions registry. A bare UUID the registry
 *     does not know is passed: artifact links and request ids are UUIDs too.
 * The refusal names each session the registry can, so the rewrite needs no
 * lookup.
 *
 * IMPLICIT:  scans every outgoing message, and reads the sessions registry
 *            where one holds a UUID or an 8-hex word.
 * JUSTIFIED: fail-safe — the miss is the reader left with an id to look up,
 *            the founder's standing complaint (#2478, #3557).
 * DEFEAT:    one send-back a reply: a turn already sent back by a Stop hook
 *            (`stop_hook_active`) passes. MAX_BLOCKS a session on its own
 *            counter. Silent on every failure path.
 */

const hookBlock = require("./lib/hook-block");
const stopGuard = require("./lib/stop-guard");
const { CODE_SPAN } = require("./lib/secret-ask");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_WORD = new RegExp(
	String.raw`\bsession\s+(?:id\s+)?(${UUID}|[0-9a-f]{8})(?![\w-])`,
	"gi",
);
const BARE = new RegExp(
	String.raw`(?<![\w/-])(${UUID}|[0-9a-f]{8})(?![\w-])`,
	"gi",
);

/**
 * The registered sessions, read once, as `[id, name]` pairs.
 * @returns {[string, string|null][]}
 */
function registered() {
	const core = require("./lib/arbiter-core.js");
	return (core.readSessionEntries("best-effort") ?? []).map(({ entry }) => [
		String(entry.sessionId).toLowerCase(),
		entry.name ? String(entry.name) : null,
	]);
}

/**
 * Every session id the message's prose names, each with the session's
 * registry name where one is known.
 * @param {string} message
 * @param {() => [string, string|null][]} readRegistry
 * @returns {{id: string, name: string|null}[]}
 */
function namedIds(message, readRegistry = registered) {
	const prose = message.replace(CODE_SPAN, " ");
	/** @type {[string, string|null][]|undefined} */
	let sessions;
	/** @param {string} id */
	const lookup = (id) => {
		sessions ??= readRegistry();
		const key = id.toLowerCase();
		return sessions.find(([sid]) => sid === key || sid.startsWith(`${key}-`));
	};
	/** @type {Map<string, string|null>} */
	const found = new Map();
	for (const [, id] of prose.matchAll(SESSION_WORD))
		found.set(id, lookup(id)?.[1] ?? null);
	for (const [, id] of prose.matchAll(BARE)) {
		if (found.has(id)) continue;
		const hit = lookup(id);
		if (hit) found.set(id, hit[1]);
	}
	return [...found].map(([id, name]) => ({ id, name }));
}

/**
 * @param {{id: string, name: string|null}[]} hits
 * @returns {string}
 */
function refusal(hits) {
	return [
		"THIS REPLY NAMES A SESSION BY ITS ID. Core voice §Comprehension: name a session by its `claude agents --json` name, never its id or pid; an id appears only where a command needs it, inside that command's code span (#2478, #3557).",
		"",
		...hits.map(
			({ id, name }) =>
				`  ${id} → ${name ?? "no name in the registry: name it by its role and what it is doing"}`,
		),
		"",
		"Rewrite each before ending the turn. Where a tool printed only an id, `node scripts/session-arbiter.js list` or `claude agents --json` gives the name.",
	].join("\n");
}

/**
 * @param {{sessionId: string, message: string,
 *   payload: import("./lib/stop-guard").StopPayload|null}} ctx
 */
function review({ sessionId, message, payload }) {
	if (payload?.stop_hook_active === true) return;
	const hits = namedIds(message);
	if (hits.length === 0) return;
	hookBlock.blockStop({
		prefix: ".session-id-prose-nagged-",
		sessionId,
		reason: refusal(hits),
	});
}

module.exports = { namedIds };

if (require.main === module) stopGuard.onMessage({ review });
