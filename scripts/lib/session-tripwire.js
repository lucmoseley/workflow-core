const hookBlock = require("./hook-block");

const TRIPWIRE = 300_000;
const TRIPWIRE_PREFIX = ".session-ceiling-nagged-hard-";

/** @param {string} sid */
function isTripwireSpent(sid) {
	return hookBlock.capSpent({
		prefix: TRIPWIRE_PREFIX,
		sessionId: sid,
		max: 1,
	});
}

module.exports = { isTripwireSpent, TRIPWIRE, TRIPWIRE_PREFIX };
