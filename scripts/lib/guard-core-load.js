// code-edges loads: guard-cores.json core

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { corePath, readDispatchRows } = require("./guard-cores.js");

/**
 * @typedef {import("./guard-cores.js").CoreRow} CoreRow
 * @typedef {import("./core-contract.js").Core} Core
 */

/**
 * @param {CoreRow} row
 * @returns {Core}
 */
function loadCore(row) {
	const file = corePath(row.core);
	try {
		return { ...row, ...require(file) };
	} catch (e) {
		if (!fs.existsSync(file)) throw e;
		return {
			...row,
			loadFault: `scripts/lib/${row.core} failed to load — fix that module: ${caught(e).message}`,
		};
	}
}

/**
 * @param {string} event
 * @param {{ keep?: (row: CoreRow) => boolean, manifest?: string }} [options]
 * @returns {Core[]}
 */
function loadCores(event, { keep = () => true, manifest } = {}) {
	return readDispatchRows(event, manifest).filter(keep).map(loadCore);
}

module.exports = { loadCores };
