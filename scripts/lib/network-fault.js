/*
 * network-fault.js — whether a thrown git or `gh` call failed on the network
 * rather than on what it asked, so a caller retries it instead of reading it
 * as an answer.
 */

const { caught } = require("./caught.js");

const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d|server sent GOAWAY/;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNetworkFault(err) {
	const e = caught(err);
	return e.code === "ETIMEDOUT" || NETWORK.test(String(e.stderr ?? ""));
}

module.exports = { isNetworkFault };
