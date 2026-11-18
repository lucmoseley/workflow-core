/*
 * round-marker.js — the `❓ **Qn**` round marker, read the one way.
 *
 * Two Stop guards must agree on what opens a round: guard-priced-options.js
 * judges the rounds, and guard-jev-advisory.js fires only on the messages that
 * open none (workflow-core#200). The spelling lives here and neither declares its own
 * (workflow-core#218).
 *
 * Also the round's parts, which several of guard-priced-options.js's limbs and
 * lib/close-rivals.js read alike (workflow-core#1474).
 */

const { requiredGroup } = require("./regex-group.js");

/* U+2753 BLACK QUESTION MARK ORNAMENT, then **Qn**. Written as an escape rather
 * than a literal so the file survives a round trip through a shell heredoc. */
const Q_MARKER = /^\u2753\s*\*\*Q(\d+)\*\*/u;

/**
 * The round number one line opens, or null where it opens none.
 * @param {string} line
 * @returns {string|null}
 */
function roundNumber(line) {
	const m = String(line).match(Q_MARKER);
	return m ? requiredGroup(m, 1, Q_MARKER) : null;
}

/**
 * Does any line of a message open a round?
 * @param {string} message
 * @returns {boolean}
 */
function hasRoundMarker(message) {
	return String(message)
		.split("\n")
		.some((line) => roundNumber(line) !== null);
}

/* An option label at the head of its own line. Anchored per line: an inline
 * "(a)" mid-sentence is prose, not an option. */
const OPTION_LABEL_PREFIX = /^\s{0,3}\(([A-Z])\)\s+/;
const OPTION_LABEL = new RegExp(`${OPTION_LABEL_PREFIX.source}\\S`);

/* Confidence: 62% (55% - 70%). The band separator may be a hyphen, an en dash
 * or an em dash — all three are written by hand and none changes the meaning.
 * Captures the headline figure and both band ends. */
const PRICED =
	/Confidence:\s*(\d{1,3})\s*%\s*\(\s*(\d{1,3})\s*%\s*[-–—]\s*(\d{1,3})\s*%\s*\)/;
const CONFIDENCE_ANY = /Confidence:\s*\d{1,3}\s*%/;

/* The independence declaration. Presence is the whole test since
 * mantahostels#1807, which took out the word list and the letter cross-check;
 * the tail still has to be non-empty, so a bare `Relation:` blocks. */
const RELATION_LINE = /^\s{0,3}(?:\*\*)?Relation(?:\*\*)?:\s*\S.*$/i;
/* A relation line declaring every option a rival for one slot (workflow-core#38), and the
 * words that mark a combinable pair inside one, which switch the sum off. */
const RIVALS =
	/\b(?:rivals?|mutually exclusive|all (?:two|three|four|five) conflict|all conflict)\b/i;
const COMBINABLE =
	/\b(?:independent|combin\w*|together|alongside|any combination|compatible)\b/i;

/** @typedef {{ number: string, lines: string[] }} QuestionBlock */

/**
 * Split a message into its question blocks. A block runs from its own round
 * marker to the next one, so any preamble before the first marker is dropped.
 * @param {string} text
 * @returns {QuestionBlock[]}
 */
function splitQuestions(text) {
	/** @type {QuestionBlock[]} */
	const blocks = [];
	/** @type {QuestionBlock | null} */
	let current = null;
	for (const line of String(text).split("\n")) {
		const number = roundNumber(line);
		if (number !== null) {
			current = { number, lines: [] };
			blocks.push(current);
		}
		if (current) current.lines.push(line);
	}
	return blocks;
}

/**
 * Each lettered option in a block, owning the lines up to the next label.
 * `line` is the label's own line, the span's first.
 * @param {string[]} lines
 * @returns {{ letter: string, at: number, line: string, span: string }[]}
 */
function optionSpans(lines) {
	/** @type {{ letter: string, at: number, line: string }[]} */
	const labels = [];
	lines.forEach((line, i) => {
		const m = line.match(OPTION_LABEL);
		if (m)
			labels.push({ letter: requiredGroup(m, 1, OPTION_LABEL), at: i, line });
	});
	return labels.map((o, k) => {
		const next = labels[k + 1];
		return {
			...o,
			span: lines.slice(o.at, next ? next.at : lines.length).join("\n"),
		};
	});
}

/**
 * The block's `Relation:` line, or '' where it has none.
 * @param {string[]} lines
 */
function parseRelationLine(lines) {
	return lines.find((l) => RELATION_LINE.test(l)) ?? "";
}

/**
 * Does the block's `Relation:` line declare every option a rival, naming no
 * combinable pair?
 * @param {string[]} lines
 */
function isRivalSet(lines) {
	const relation = parseRelationLine(lines);
	return RIVALS.test(relation) && !COMBINABLE.test(relation);
}

/**
 * An option's own text: its label through its Confidence line, or through its
 * first blank line where it has none — never the `Relation:`, recommendation
 * or status lines that trail the last option of a block.
 * @param {string} span
 * @returns {string}
 */
function parseOptionBody(span) {
	const lines = span.split("\n");
	const priced = lines.findIndex((l) => CONFIDENCE_ANY.test(l));
	const end = priced >= 0 ? priced + 1 : lines.indexOf("", 1);
	return lines.slice(0, end < 0 ? lines.length : end).join("\n");
}

module.exports = {
	Q_MARKER,
	roundNumber,
	hasRoundMarker,
	OPTION_LABEL_PREFIX,
	OPTION_LABEL,
	PRICED,
	CONFIDENCE_ANY,
	RELATION_LINE,
	COMBINABLE,
	splitQuestions,
	optionSpans,
	parseOptionBody,
	parseRelationLine,
	isRivalSet,
};
