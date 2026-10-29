#!/usr/bin/env node
/*
 * guard-session-id-prose.js — Stop hook. Sends a reply back once where its
 * prose names a session by id rather than by name (#3557).
 *
 * WHY. Core voice §Comprehension: a session is named by its `claude agents
 * --json` name, never its id or pid, and an id appears only where a command
 * needs it.
 *
 * WHAT IS READ. The outgoing message with every fenced block and code span
 * removed, but for a span holding an id alone: a command carrying an id sits
 * in one. In what is left it finds:
 *   - `session <id>`, the id a full UUID or its 8-hex prefix, whatever the
 *     registry holds;
 *   - a bare full UUID, or a bare 8-hex word, that is the id or the id's
 *     prefix of a session in the sessions registry. A bare UUID the registry
 *     does not know is passed.
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
const ID = `(${UUID}|[0-9a-f]{8})`;
const SESSION_WORD = new RegExp(
	String.raw`\bsession\s+(?:id\s+)?${ID}(?![\w-])`,
	"gi",
);
const BARE = new RegExp(String.raw`(?<![\w/-])${ID}(?![\w-])`, "gi");
/* A span holding an id and nothing else carries no command, so it is prose. */
const ID_ALONE = new RegExp(String.raw`^\`\s*${ID}\s*\`$`, "i");

/**
 * @param {string} message
 * @returns {{id: string, name: string|null}[]}
 */
function namedIds(message) {
	const prose = message.replace(
		CODE_SPAN,
		(span) => span.match(ID_ALONE)?.[1] ?? " ",
	);
	const bare = [...prose.matchAll(BARE)].map(([, id = ""]) => id);
	if (bare.length === 0) return [];
	/* Required here, so a reply with no hex word never loads the arbiter. */
	const lookup = require("./lib/arbiter-core.js").registryLookup();
	/** @type {Map<string, string|null>} */
	const found = new Map();
	for (const [, id = ""] of prose.matchAll(SESSION_WORD))
		found.set(id, lookup(id)?.name ?? null);
	for (const id of bare) {
		if (found.has(id)) continue;
		const hit = lookup(id);
		if (hit) found.set(id, hit.name);
	}
	return [...found].map(([id, name]) => ({ id, name }));
}

/**
 * @param {{id: string, name: string|null}[]} hits
 * @returns {string}
 */
function buildRefusal(hits) {
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
		reason: buildRefusal(hits),
	});
}

if (require.main === module) stopGuard.onMessage({ review });
