/*
 * network-fault.js — whether a thrown git or `gh` call failed on the network
 * or on the remote's own fault rather than on what it asked, so a caller
 * retries it instead of reading it as an answer, and the backoff it retries
 * on. GitHub names an internal fault in a push's refusal as
 * `fatal error in <its step>` (workflow-core#4497).
 * Residual: a refusal GitHub keeps phrasing so costs every try, and is then
 * reported as a fault, never as a refusal that holds a batch.
 */

const { caught } = require("./caught.js");

const NETWORK =
	/Could not resolve host|Connection timed out|Connection reset|returned error: 5\d\d|HTTP 5\d\d|server sent GOAWAY|\[remote rejected\][^\n]*\(fatal error in /;

/* Untraced: five tries over about a minute, outlasting a DNS or connection
 * blip (workflow-core#2673); whether it outlasts the GitHub fault workflow-core#4497 met, whose third
 * try minutes later landed, is unmeasured. A foreground land so waits 30-90 s
 * at worst. The backoff is exponential and
 * randomised, as the Google SRE book's "Addressing Cascading Failures"
 * chapter sets for a retrying client. `WFC_REMOTE_BACKOFF_MS` sets the base
 * for a test that retries through a real child. */
const REMOTE_TRIES = 5;
const REMOTE_BACKOFF_MS = 4 * 1000;

/**
 * The pause before retry `attempt` + 1 of a remote call.
 * @param {number} attempt the try that failed, from 1
 */
const remoteBackoffMs = (attempt) =>
	Number(process.env.WFC_REMOTE_BACKOFF_MS ?? REMOTE_BACKOFF_MS) *
	2 ** (attempt - 1) *
	(0.5 + Math.random());

/**
 * Whether `text`, a failed call's own words, names a network or remote fault.
 * @param {string} text
 */
const isNetworkFaultText = (text) => NETWORK.test(text);

/**
 * git's own refusal lines in `text`, as against a hook's output, which may
 * quote anything.
 * @param {string} text
 * @returns {string[]}
 */
const readGitLines = (text) =>
	text.match(/^(?:error|fatal):.*|^ ! \[.*/gm) ?? [];

/**
 * Whether a failed push's output names a network or remote fault in git's own
 * lines, never in its pre-push hook's (workflow-core#4497).
 * @param {string} output
 */
const isPushFaultText = (output) =>
	isNetworkFaultText(readGitLines(output).join("\n"));

/**
 * A push git refused, its hook's output in `stderr` with git's own: a retry
 * would only repeat it, even where the hook quotes a network fault (workflow-core#4513).
 */
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
