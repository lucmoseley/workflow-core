const fs = require("node:fs");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");
const { orFallback } = require("./caught.js");

const SPAN_RE = /`([^`]+)`/g;
const LINE_PIN_RE = /^([\w./\-[\]]*):(\d+)(?:-(\d+))?$/;
const PATH_RE =
	/^[\w./\-[\]]+\.(?:ts|tsx|js|jsx|mjs|cjs|sh|md|json|ya?ml|py|html)$/;
const QUOTE_RE = /\*"([^"]*)"\*/g;

/**
 * @typedef {object} LinePin
 * @property {number} line
 * @property {number} col
 * @property {string} raw
 * @property {string} rawPath
 * @property {number} from
 * @property {number} to
 * @property {string[]} quotes
 * @property {LinePin[]} siblings
 */

/**
 * @typedef {{col: number, kind: "linePin" | "path", pin?: LinePin, rawPath: string}} PinSpan
 */

/** @param {string} line @returns {string} */
function maskQuotes(line) {
	let masked = line;
	for (const m of line.matchAll(QUOTE_RE)) {
		const at = m.index ?? 0;
		masked =
			masked.slice(0, at) +
			" ".repeat(m[0].length) +
			masked.slice(at + m[0].length);
	}
	return masked;
}

/**
 * @param {string} masked
 * @param {number} lineNo
 * @returns {{ spans: PinSpan[], pins: LinePin[] }}
 */
function lineSpans(masked, lineNo) {
	/** @type {PinSpan[]} */
	const spans = [];
	/** @type {LinePin[]} */
	const pins = [];
	for (const m of masked.matchAll(SPAN_RE)) {
		const col = m.index ?? 0;
		const span = requiredGroup(m, 1, SPAN_RE);
		const hit = LINE_PIN_RE.exec(span);
		if (hit) {
			const rawPath = requiredGroup(hit, 1, LINE_PIN_RE);
			const from = Number(requiredGroup(hit, 2, LINE_PIN_RE));
			/** @type {LinePin} */
			const pin = {
				line: lineNo,
				col,
				raw: span,
				rawPath,
				from,
				to: hit[3] ? Number(hit[3]) : from,
				quotes: [],
				siblings: pins,
			};
			pins.push(pin);
			spans.push({ col, kind: "linePin", pin, rawPath });
		} else if (PATH_RE.test(span)) {
			spans.push({ col, kind: "path", rawPath: span });
		}
	}
	return { spans, pins };
}

/**
 * @param {{ col: number, text: string }[]} quotes
 * @param {PinSpan[]} spans
 * @param {LinePin[]} pins
 */
function pairQuotes(quotes, spans, pins) {
	for (const q of quotes) {
		const before = spans.filter((s) => s.col < q.col).pop();
		if (!before) {
			const after = pins.find((p) => p.col > q.col);
			if (after) after.quotes.push(q.text);
		} else if (before.pin) {
			before.pin.quotes.push(q.text);
		}
	}
}

/** @param {string} line @param {number} lineNo @returns {LinePin[]} */
function linePins(line, lineNo) {
	const quotes = [...line.matchAll(QUOTE_RE)].map((m) => ({
		col: m.index ?? 0,
		text: requiredGroup(m, 1, QUOTE_RE),
	}));
	const { spans, pins } = lineSpans(maskQuotes(line), lineNo);
	if (pins.length === 0) return pins;

	let lastPath = "";
	for (const s of spans) {
		if (s.rawPath) lastPath = s.rawPath;
		else if (s.pin) s.pin.rawPath = lastPath;
	}

	pairQuotes(quotes, spans, pins);
	return pins;
}

/** @param {string} text @returns {LinePin[]} */
function parseLinePins(text) {
	/** @type {LinePin[]} */
	const all = [];
	for (const [i, line] of text.split("\n").entries())
		all.push(...linePins(line, i + 1));
	return all;
}

/**
 * @param {string} root
 * @param {LinePin} pin
 * @param {(rel: string) => boolean} shipped
 * @returns {string | null}
 */
function baseLinePinFault(root, pin, shipped) {
	if (!pin.rawPath) return "it names no file";
	const isFile = orFallback(
		() => fs.statSync(path.join(root, pin.rawPath)).isFile(),
		false,
	);
	if (!isFile) return `no file opens at ${pin.rawPath}`;
	if (!shipped(pin.rawPath)) return `the release leaves ${pin.rawPath} behind`;
	return null;
}

const BASE_LINE_PIN_REMEDY =
	"pin a shipped file, or write the example into the text";

module.exports = {
	BASE_LINE_PIN_REMEDY,
	LINE_PIN_RE,
	baseLinePinFault,
	parseLinePins,
};
