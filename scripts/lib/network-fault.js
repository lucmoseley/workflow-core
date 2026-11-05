/*
 * network-fault.js — whether a thrown git or `gh` call failed on the network
 * or on the remote's own fault rather than on what it asked, so a caller
 * retries it instead of reading it as an answer. GitHub names an internal
 * fault in a push's refusal as `fatal error in <its step>`: on 5 Nov 2026 it
 * refused one twice so and took the third, unchanged (#4497).
 */

const { caught } = require("./caught.js");

const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d|server sent GOAWAY|\[remote rejected\][^\n]*\(fatal error in /;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNetworkFault(err) {
	const e = caught(err);
	return e.code === "ETIMEDOUT" || NETWORK.test(String(e.stderr ?? ""));
}

module.exports = { isNetworkFault };
