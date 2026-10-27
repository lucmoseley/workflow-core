/*
 * node-heap.js — guard-node-heap.js's core (workflow-core#2784): a command naming the V8
 * heap cap is handed `rule:node-heap` before it runs (workflow-core#2025).
 *
 * The raw command is matched, anywhere in it: a raise cannot be told from a
 * lowering without parsing every way NODE_OPTIONS can be built, and V8 takes
 * either spelling.
 */

const HEAP_FLAG = /max[-_]old[-_]space[-_]size/;

/**
 * @param {string} command
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command) {
	return HEAP_FLAG.test(command) ? { injectRules: ["node-heap"] } : null;
}

module.exports = { decide };
