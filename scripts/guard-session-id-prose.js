#!/usr/bin/env node
const hookBlock = require("./lib/hook-block");
const stopGuard = require("./lib/stop-guard");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { CODE_SPAN } = require("./lib/secret-ask");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID = `(${UUID}|[0-9a-f]{8})`;
const SESSION_WORD = new RegExp(
	String.raw`\bsession\s+(?:id\s+)?${ID}(?![\w-])`,
	"gi",
);
const BARE = new RegExp(String.raw`(?<![\w/-])${ID}(?![\w-])`, "gi");
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
		"THIS REPLY NAMES A SESSION BY ITS ID. Core voice §Comprehension: name a session by its `list-sessions.js` name, never its id or pid; an id appears only where a command needs it, inside that command's code span (#2478, #3557).",
		"",
		...hits.map(
			({ id, name }) =>
				`  ${id} → ${name ?? "no name in the registry: name it by its role and what it is doing"}`,
		),
		"",
		`Rewrite each before ending the turn. Where a tool printed only an id, \`${buildArbiterCommand`list`}\` or \`node ${scriptPath("list-sessions.js")}\` gives the name.`,
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
