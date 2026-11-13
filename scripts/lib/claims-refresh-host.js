/*
 * claims-refresh-host.js — the production port lib/claims-refresh.js
 * records through (workflow-core#2787): the arbiter's refresh after a Bash call.
 */

function buildHostPorts() {
	return {
		/** @param {string} session */
		refreshClaims: (session) =>
			require("./arbiter-tool-record.js").refreshAfterBash(session),
	};
}

module.exports = { buildHostPorts };
