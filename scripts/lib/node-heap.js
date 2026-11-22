const HEAP_FLAG = /max[-_]old[-_]space[-_]size/;

/**
 * @param {string} command
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command) {
	return HEAP_FLAG.test(command) ? { injectRules: ["node-heap"] } : null;
}

module.exports = { field: "command", noun: "command", decide };
