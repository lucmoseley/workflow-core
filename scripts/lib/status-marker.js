const { requiredGroup } = require("./regex-group.js");

/** @type {{name: MarkerName, re: RegExp}[]} */
const MARKER_PAYLOAD = [
	{ name: "needs input:", re: /^[ \t]*needs input:(.*)$/gim },
	{ name: "result:", re: /^[ \t]*result:(.*)$/gim },
	{ name: "waiting:", re: /^[ \t]*waiting:(.*)$/gim },
];

const DECORATED_MARKER =
	/^[ \t]*([`*_>][`*_> \t]*)(result|waiting|needs input)[`*_]*:/gim;

/**
 * @param {RegExp} re
 * @param {string} text
 * @returns {RegExpExecArray|null}
 */
function lastMatch(re, text) {
	const local = new RegExp(re);
	let found = null;
	for (let m = local.exec(text); m; m = local.exec(text)) found = m;
	return found;
}

/**
 * @typedef {"needs input:" | "result:" | "waiting:"} MarkerName
 * @typedef {{name: MarkerName, payload: string, at: number, line: string,
 *   below: string, fromEnd: number}} Marker
 * @typedef {{
 *   governing: Marker | null,
 *   last: Record<MarkerName, Marker | null>,
 *   decorated: {name: string, lead: string} | null,
 *   hasLaterMarker: (name: MarkerName) => boolean,
 * }} StatusReading
 */

/** @param {string} message @returns {StatusReading} */
function parseStatus(message) {
	/** @type {Record<MarkerName, Marker | null>} */
	const last = { "needs input:": null, "result:": null, "waiting:": null };
	/** @type {Marker | null} */
	let governing = null;
	for (const marker of MARKER_PAYLOAD) {
		const m = lastMatch(marker.re, message);
		if (!m) continue;
		const lineEnd = message.indexOf("\n", m.index);
		const found = {
			name: marker.name,
			payload: requiredGroup(m, 1, marker.re),
			at: m.index,
			line:
				lineEnd === -1
					? message.slice(m.index)
					: message.slice(m.index, lineEnd),
			below: lineEnd === -1 ? "" : message.slice(lineEnd + 1),
			fromEnd: message.length - m.index,
		};
		last[marker.name] = found;
		if (!governing || found.at > governing.at) governing = found;
	}

	const d = lastMatch(DECORATED_MARKER, message);
	const decorated = d && {
		name: `${requiredGroup(d, 2, DECORATED_MARKER).toLowerCase()}:`,
		lead: requiredGroup(d, 1, DECORATED_MARKER).replace(/[ \t]/g, ""),
	};

	/** @type {(name: MarkerName) => boolean} */
	const hasLaterMarker = (name) => {
		const self = last[name];
		return Boolean(self && governing && governing.at > self.at);
	};

	return { governing, last, decorated, hasLaterMarker };
}

/**
 * @param {string} message
 * @returns {{name: string, payload: string, at: number}}
 */
function governingMarker(message) {
	const g = parseStatus(message).governing;
	return g
		? { name: g.name, payload: g.payload, at: g.at }
		: { name: "", payload: "", at: -1 };
}

module.exports = { governingMarker, parseStatus };
