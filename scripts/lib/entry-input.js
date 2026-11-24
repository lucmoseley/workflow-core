const { caught, ignoreFailure } = require("./caught.js");
const { readFdAll } = require("./read-fd.js");

/**
 * @param {string} name
 * @param {string} [root]
 * @returns {(what: string, detail?: string) => void}
 */
function logger(name, root) {
	return (what, detail) => {
		ignoreFailure(() =>
			require("./arbiter-core.js").logError(
				name,
				what,
				detail?.replaceAll("\x01", ""),
				root,
			),
		);
	};
}

class PayloadUnreadable extends Error {
	/**
	 * @param {string} message
	 * @param {{ cause: unknown }} options
	 */
	constructor(message, options) {
		super(message, options);
		this.name = "PayloadUnreadable";
	}
}

/**
 * @param {string} noun
 * @param {(what: string, detail?: string) => void} log
 * @returns {Record<string, unknown> | null}
 */
function readPayload(noun, log) {
	let raw;
	try {
		raw = readFdAll(0).toString("utf8");
	} catch (e) {
		throw new PayloadUnreadable(`stdin unreadable: ${caught(e).message}`, {
			cause: e,
		});
	}
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		log(`payload did not parse as JSON — ${noun} allowed unchecked`);
		return null;
	}
}

module.exports = { logger, readPayload };
