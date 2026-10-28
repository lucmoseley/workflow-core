/*
 * caught.js — the fields a handler reads off a caught value, each narrowed
 * from `unknown` (#1329, ruled at #1317 Q3 (A)).
 *
 * A handler reads through this or `instanceof Error`, never a binding typed
 * `any` (docs/code-standards-base.md §N8).
 */

/**
 * @typedef {object} Caught
 * @property {string | undefined} code Node's error code (`ENOENT`, `ETIMEDOUT`)
 * @property {string} message the thrown value's message, or the value itself
 *   as a string where it carries none
 * @property {number | undefined} status a child process's exit status
 * @property {string | undefined} stderr a child process's stderr, decoded
 * @property {string | undefined} stdout a child process's stdout, decoded
 */

/**
 * A field read off a thrown object, or undefined where `e` is no object.
 *
 * @param {unknown} e
 * @param {string} key
 * @returns {unknown}
 */
function field(e, key) {
	return typeof e === "object" && e !== null
		? /** @type {Record<string, unknown>} */ (e)[key]
		: undefined;
}

/**
 * execFileSync attaches a child's output as a string or a Buffer, by its
 * `encoding`.
 *
 * @param {unknown} v
 * @returns {string | undefined}
 */
function text(v) {
	if (typeof v === "string") return v;
	return Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
}

/**
 * `String(e)`, which itself throws on an object with no usable `toString`.
 *
 * @param {unknown} e
 * @returns {string}
 */
function printable(e) {
	try {
		return String(e);
	} catch {
		return Object.prototype.toString.call(e);
	}
}

/**
 * @param {unknown} e a catch binding
 * @returns {Caught}
 */
function caught(e) {
	const code = field(e, "code");
	const message = field(e, "message");
	const status = field(e, "status");
	return {
		code: typeof code === "string" ? code : undefined,
		message: typeof message === "string" ? message : printable(e),
		status: typeof status === "number" ? status : undefined,
		stderr: text(field(e, "stderr")),
		stdout: text(field(e, "stdout")),
	};
}

/**
 * What a failed call said: the child's stderr where it printed any, else the
 * message, as a timed-out spawn's stderr is empty (#2673).
 *
 * @param {unknown} e a catch binding
 * @returns {string}
 */
function parseErrorText(e) {
	const c = caught(e);
	return c.stderr || c.message;
}

/**
 * A thrown value as a log line carries it: an Error's stack, which opens with
 * its message, else the value itself.
 *
 * @param {unknown} e a catch binding
 * @returns {string}
 */
const buildErrorText = (e) =>
	e instanceof Error ? (e.stack ?? e.message) : String(e);

module.exports = { buildErrorText, caught, parseErrorText };
