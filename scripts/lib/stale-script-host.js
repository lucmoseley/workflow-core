/*
 * stale-script-host.js — the production ports lib/stale-script.js reads
 * through the dispatcher (workflow-core#2789): the claim store's locks and its reading of a
 * path as a watched repo-relative one. The store loads on first use, so a
 * Bash call naming no script pays nothing.
 */

/** @returns {typeof import("./arbiter-store.js")} */
const store = () => require("./arbiter-store.js");

function buildHostPorts() {
	return {
		/** @returns {import("./arbiter-store").ListedLock[] | null} */
		listLocks: () => store().listLocks(),
		/** @param {string} p */
		relativeToRepo: (p) => store().relativeToRepo(p),
		/** @param {string} rel */
		isWatched: (rel) => store().isWatched(rel),
	};
}

module.exports = { buildHostPorts };
