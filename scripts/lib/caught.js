/**
 * @typedef {object} Caught
 * @property {string | undefined} code
 * @property {string} message
 * @property {number | undefined} status
 * @property {string | undefined} stderr
 * @property {string | undefined} stdout
 */

/**
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
 * @param {unknown} v
 * @returns {string | undefined}
 */
function text(v) {
	if (typeof v === "string") return v;
	return Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
}

/**
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
 * @param {unknown} e
 * @returns {string}
 */
function parseErrorText(e) {
	const c = caught(e);
	return c.stderr || c.message;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
const buildErrorText = (e) =>
	e instanceof Error ? (e.stack ?? e.message) : String(e);

/**
 * @template T
 * @param {(line: string) => void} log
 * @param {string} what
 * @param {() => T} read
 * @returns {T|null}
 */
function readLogged(log, what, read) {
	try {
		return read();
	} catch (e) {
		log(`${what} unread: ${buildErrorText(e)}`);
		return null;
	}
}

/**
 * `read()`'s value, or `fallback` where it throws.
 *
 * @template T
 * @template F
 * @param {() => T} read
 * @param {F} fallback
 * @returns {T | F}
 */
function orFallback(read, fallback) {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/**
 * Runs `act`, dropping anything it throws: for a side effect whose failure
 * leaves nothing to do, such as removing a file that may be gone already.
 *
 * @param {() => unknown} act
 * @returns {void}
 */
function ignoreFailure(act) {
	orFallback(act, undefined);
}

module.exports = {
	buildErrorText,
	caught,
	ignoreFailure,
	orFallback,
	parseErrorText,
	readLogged,
};
