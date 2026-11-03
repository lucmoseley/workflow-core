/*
 * guard-core-load.js — the dispatcher's cores of one event, each row's module
 * required only where the row passes the caller's filter (#3141), and a
 * module that throws on require kept as a fault for dispatch to answer by the
 * row's policy (#4125). Its own module, apart from lib/guard-dispatch.js, so
 * a test loads the cores the entry would through the export the entry itself
 * uses (#4136, base §G6).
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { corePath, readDispatchRows } = require("./guard-cores.js");

/**
 * @typedef {import("./guard-cores.js").CoreRow} CoreRow
 * @typedef {import("./guard-dispatch.js").Core} Core
 */

/**
 * One row with its module's exports, or with the fault its require threw, left
 * for dispatch so a disabled or off-module core's fault says nothing (#4125).
 * A row naming no file is the manifest's fault, so it crashes the entry.
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
 * The cores of `event`'s rows that `keep` passes, each row filtered before its
 * module is required, so a call loads only the cores that can fire on it
 * (#3141).
 * @param {string} event
 * @param {(row: CoreRow) => boolean} [keep]
 * @returns {Core[]}
 */
function loadCores(event, keep = () => true) {
	return readDispatchRows(event).filter(keep).map(loadCore);
}

module.exports = { loadCores };
