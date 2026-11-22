const { caught } = require("./caught.js");

const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d|server sent GOAWAY|\[remote rejected\][^\n]*\(fatal error in /;

// guess, #2673
const REMOTE_TRIES = 5;
const REMOTE_BACKOFF_MS = 4 * 1000;

/**
 * @param {number} attempt
 */
const remoteBackoffMs = (attempt) =>
	Number(process.env.WFC_REMOTE_BACKOFF_MS ?? REMOTE_BACKOFF_MS) *
	2 ** (attempt - 1) *
	(0.5 + Math.random());

/**
 * @param {string} text
 */
const isNetworkFaultText = (text) => NETWORK.test(text);

/**
 * @param {string} text
 * @returns {string[]}
 */
const readGitLines = (text) =>
	text.match(/^(?:error|fatal):.*|^ ! \[.*/gm) ?? [];

/**
 * @param {string} output
 */
const isPushFaultText = (output) =>
	isNetworkFaultText(readGitLines(output).join("\n"));

class PushRefused extends Error {
	/**
	 * @param {string} message
	 * @param {{ cause: unknown }} options
	 */
	constructor(message, options) {
		super(message, options);
		const e = caught(options.cause);
		this.status = e.status;
		this.stderr = e.stderr;
		this.stdout = e.stdout;
	}
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNetworkFault(err) {
	if (err instanceof PushRefused) return false;
	const e = caught(err);
	return e.code === "ETIMEDOUT" || isNetworkFaultText(String(e.stderr ?? ""));
}

module.exports = {
	isNetworkFault,
	isPushFaultText,
	PushRefused,
	readGitLines,
	REMOTE_TRIES,
	remoteBackoffMs,
};
