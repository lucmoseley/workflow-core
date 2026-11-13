/*
 * status-marker.js — which of the three job-status markers governs a turn, and
 * the one parse of a message's markers the priced-options guard's status
 * limbs share (workflow-core#1550).
 *
 * Whether the marker is TRUE — whether a `waiting:` rests on a launch still
 * out — is `lib/pending-tasks.js`'s.
 */

const { requiredGroup } = require("./regex-group.js");

/** The three status markers, with the text following the colon on the same line
 * captured, so a marker carrying nothing can be told from one carrying a
 * decision. Anchored at the head of a line, so "the result: nothing" in prose
 * is not a status line.
 * @type {{name: MarkerName, re: RegExp}[]} */
const MARKER_PAYLOAD = [
	{ name: "needs input:", re: /^[ \t]*needs input:(.*)$/gim },
	{ name: "result:", re: /^[ \t]*result:(.*)$/gim },
	{ name: "waiting:", re: /^[ \t]*waiting:(.*)$/gim },
];

/* A marker led by markdown decoration at the head of its line — `` `result:` ``,
 * `**waiting:**`, `> needs input:` (mantahostels#3426). Refused by name, never
 * accepted: the bare patterns above stay anchored on the bare form, which
 * mantahostels#3423 ruled. Unread, so told "carrying neither" instead: a `-`,
 * `#` or numbered lead, and decoration trailing the colon alone (`result:**`). */
const DECORATED_MARKER =
	/^[ \t]*([`*_>][`*_> \t]*)(result|waiting|needs input)[`*_]*:/gim;

/**
 * The LAST match of a global regexp, found on a local copy so the shared
 * module-level regexp's `lastIndex` is untouched.
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
 *   below: string, fromEnd: number}} Marker one marker's last occurrence:
 *   `line` runs to the next newline, which `payload` can stop short of at a
 *   lone `\r`; `below` is the text after it, `fromEnd` its distance from the
 *   message end
 * @typedef {{
 *   governing: Marker | null,
 *   last: Record<MarkerName, Marker | null>,
 *   decorated: {name: string, lead: string} | null,
 *   hasLaterMarker: (name: MarkerName) => boolean,
 * }} StatusReading
 */

/**
 * Every status marker in one message, read once.
 *
 * `governing` is the LATEST bare marker; an earlier one is a quotation — of a
 * guard's own block text, say. `last` holds each bare marker's last match by
 * name, for a limb that reads one marker whether or not it governs.
 * `decorated` is the last decorated marker whether or not a bare one is
 * present; a caller reads it once no bare marker it accepts is.
 * `hasLaterMarker(name)` says whether another bare marker's last match sits
 * after `name`'s.
 *
 * @param {string} message the outgoing assistant message
 * @returns {StatusReading}
 */
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
 * Which status marker governs the filing: `parseStatus`'s `governing`, in the
 * shape its outside callers read.
 *
 * @param {string} message the outgoing assistant message
 * @returns {{name: string, payload: string, at: number}} `at` is -1 where the
 *   message carries no marker at all, and `name` is '' there.
 */
function governingMarker(message) {
	const g = parseStatus(message).governing;
	return g
		? { name: g.name, payload: g.payload, at: g.at }
		: { name: "", payload: "", at: -1 };
}

module.exports = { governingMarker, parseStatus };
