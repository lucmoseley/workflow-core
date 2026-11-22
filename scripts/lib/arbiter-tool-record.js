const store = require("./arbiter-store.js");

/** @typedef {import("./arbiter-store.js").Identity} Identity */

/**
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function recordToolWrite(filePath, sessionId) {
	if (!filePath) return;
	const rel = store.recordWrite(filePath, sessionId);
	if (rel !== null && store.isWatched(rel))
		recordFor(rel, store.identify(sessionId));
}

/**
 * @param {string} rel
 * @param {Identity} me
 * @param {{viaBash?: boolean}} [options]
 */
function recordFor(rel, me, options) {
	return (
		store.recordContent(rel, me) ?? store.recordObservation(rel, me, options)
	);
}

/** @param {string} sessionId */
function refreshAfterBash(sessionId) {
	const held = store.readHeldBy(sessionId);
	const observed = store.readObservedBy(sessionId);
	if (held === null && observed === null) return;
	const me = store.identify(sessionId);
	const covered = new Set([...(held ?? []), ...(observed ?? [])]);
	for (const rel of covered) recordFor(rel, me, { viaBash: true });
	for (const rel of store.scanChanged(sessionId))
		if (!covered.has(rel)) recordFor(rel, me, { viaBash: true });
}

module.exports = { recordToolWrite, refreshAfterBash };
