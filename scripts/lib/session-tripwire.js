/*
 * session-tripwire.js — the 300,000-token tripwire guard-session-ceiling.js
 * blocks on once a session, and whether that one block is spent. Its figure
 * is docs/effort-guide.md's; guard-held-ticket.js reads both to pass a
 * session past it.
 */

const hookBlock = require("./hook-block");

const TRIPWIRE = 300_000;
const TRIPWIRE_PREFIX = ".session-ceiling-nagged-hard-";

/**
 * Whether session `sid`'s one tripwire block is spent.
 * @param {string} sid
 */
function isTripwireSpent(sid) {
	return hookBlock.capSpent({
		prefix: TRIPWIRE_PREFIX,
		sessionId: sid,
		max: 1,
	});
}

module.exports = { isTripwireSpent, TRIPWIRE, TRIPWIRE_PREFIX };
