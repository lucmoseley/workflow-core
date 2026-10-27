/*
 * standards-pins.js — the line pins a code-standards document carries, and the
 * one test of whether the release ships a base line pin's evidence, held here
 * for both readers: check-code-standards.js, which judges each pin against the
 * tree and warns UNSHIPPED, and the release build, which refuses a base line pin
 * naming no file, no openable file, or a file it leaves behind (#961, #1259).
 * The test lives here, not in plugin-tree.js, because this file ships and that
 * one does not.
 */

const fs = require("node:fs");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");

/**
 * A backticked span. Requiring the backticks is what keeps prose out: every
 * citation in the document is code-spanned, and `SC2086` or `(#181)` in running
 * text can never be read as a pin.
 */
const SPAN_RE = /`([^`]+)`/g;
/**
 * `path:12` or `path:12-18`, and the bare `:124-125` continuation form, whose
 * path is the last one named earlier ON THE SAME LINE.
 */
const LINE_PIN_RE = /^([\w./\-[\]]*):(\d+)(?:-(\d+))?$/;
/**
 * A backticked span naming a file and carrying no line number. It is not a
 * citation, but it is what a bare pin later on the line inherits from
 * (`scripts/lib/guard-log.sh`, then `:124-125`), and it BREAKS a quotation's
 * pairing: a quotation whose nearest preceding span is an unpinned path is
 * quoting THAT file, not the pinned one further left.
 */
const PATH_RE =
	/^[\w./\-[\]]+\.(?:ts|tsx|js|jsx|mjs|cjs|sh|md|json|ya?ml|py|html)$/;
/** An italic quotation. */
const QUOTE_RE = /\*"([^"]*)"\*/g;

/**
 * @typedef {object} LinePin
 * @property {number} line     1-based line in the document
 * @property {number} col      character offset on that line
 * @property {string} raw      the pin exactly as the document spells it
 * @property {string} rawPath  the path as cited, inherited for a bare pin
 * @property {number} from
 * @property {number} to
 * @property {string[]} quotes the quotations this pin is answerable for
 * @property {LinePin[]} siblings  every pin on the same document line, this one included
 */

/** One backticked span on a line: a line pin, or a path a later bare pin
 * inherits.
 * @typedef {{col: number, kind: "linePin" | "path", pin?: LinePin, rawPath: string}} PinSpan */

/**
 * The line with every quotation blanked to spaces, offsets intact.
 *
 * @param {string} line
 * @returns {string}
 */
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
 * The spans on one masked line, in order, and the pins among them.
 *
 * @param {string} masked the line, quotations blanked
 * @param {number} lineNo 1-based
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
 * Pairs each quotation with its pin.
 *
 * @param {{ col: number, text: string }[]} quotes
 * @param {PinSpan[]} spans
 * @param {LinePin[]} pins accumulator: each quotation lands in its pin's `quotes`,
 *   reached here or through `spans`
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
		/* before.kind === "path": the quotation names its own file without a
		 * line number, so there is no pin to check it against and nothing has
		 * gone stale. */
	}
}

/**
 * @param {string} line
 * @param {number} lineNo 1-based
 * @returns {LinePin[]}
 */
function linePins(line, lineNo) {
	const quotes = [...line.matchAll(QUOTE_RE)].map((m) => ({
		col: m.index ?? 0,
		text: requiredGroup(m, 1, QUOTE_RE),
	}));
	const { spans, pins } = lineSpans(maskQuotes(line), lineNo);
	if (pins.length === 0) return pins;

	/* The bare continuation form inherits within the line and never across
	 * one: a pin whose path came from the paragraph above would resolve
	 * silently to whatever file was last mentioned. */
	let lastPath = "";
	for (const s of spans) {
		if (s.rawPath) lastPath = s.rawPath;
		else if (s.pin) s.pin.rawPath = lastPath;
	}

	pairQuotes(quotes, spans, pins);
	return pins;
}

/**
 * Every pin in the document, each carrying the quotations paired to it.
 *
 * QUOTATIONS ARE MASKED BEFORE SPANS ARE SCANNED. A quotation quotes source
 * that itself contains backticked paths — *"… (`docs/doc-map.md` §B<n> …)"* —
 * and reading those as citations both invents pins and corrupts the
 * inheritance chain a bare pin walks.
 *
 * PAIRING IS THE NEAREST PRECEDING SPAN, falling back to the next pin along
 * where a quotation opens the sentence. Nearest-of-any-
 * kind rather than nearest-pin is what keeps a quotation off a pin that is not
 * its source.
 *
 * @param {string} text
 * @returns {LinePin[]}
 */
function parseLinePins(text) {
	/** @type {LinePin[]} */
	const all = [];
	for (const [i, line] of text.split("\n").entries())
		all.push(...linePins(line, i + 1));
	return all;
}

/**
 * Why the release refuses a base line pin, or null where it ships it — the one
 * test behind both the release's refusal and check-code-standards.js's
 * UNSHIPPED warning, so a pin cannot pass the warning and then refuse at
 * release (#1259). An adopter opens the path as cited, at the plugin root, so
 * it is judged as cited: a bare file name the checker can resolve still opens
 * nothing there.
 * @param {string} root
 * @param {LinePin} pin
 * @param {(rel: string) => boolean} shipped plugin-tree.js's isShipped, passed
 *   in because the release leaves that file behind and ships this one
 * @returns {string | null}
 */
function baseLinePinFault(root, pin, shipped) {
	if (!pin.rawPath) return "it names no file";
	let isFile = false;
	try {
		isFile = fs.statSync(path.join(root, pin.rawPath)).isFile();
	} catch {
		/* Any stat failure, not only ENOENT, reads as no file: the release then
		 * refuses, which fails closed. */
	}
	if (!isFile) return `no file opens at ${pin.rawPath}`;
	if (!shipped(pin.rawPath)) return `the release leaves ${pin.rawPath} behind`;
	return null;
}

/** The way out both readers give for a pin baseLinePinFault refuses (#961). */
const BASE_LINE_PIN_REMEDY =
	"pin a shipped file, or write the example into the text";

module.exports = {
	BASE_LINE_PIN_REMEDY,
	LINE_PIN_RE,
	baseLinePinFault,
	parseLinePins,
};
