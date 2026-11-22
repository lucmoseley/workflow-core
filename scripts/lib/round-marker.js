const { requiredGroup } = require("./regex-group.js");

const Q_MARKER = /^\u2753\s*\*\*Q(\d+)\*\*/u;

/**
 * @param {string} line
 * @returns {string|null}
 */
function roundNumber(line) {
	const m = String(line).match(Q_MARKER);
	return m ? requiredGroup(m, 1, Q_MARKER) : null;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function hasRoundMarker(message) {
	return String(message)
		.split("\n")
		.some((line) => roundNumber(line) !== null);
}

const OPTION_LABEL_PREFIX = /^\s{0,3}\(([A-Z])\)\s+/;
const OPTION_LABEL = new RegExp(`${OPTION_LABEL_PREFIX.source}\\S`);

const PRICED =
	/Confidence:\s*(\d{1,3})\s*%\s*\(\s*(\d{1,3})\s*%\s*[-–—]\s*(\d{1,3})\s*%\s*\)/;
const CONFIDENCE_ANY = /Confidence:\s*\d{1,3}\s*%/;

const RELATION_LINE = /^\s{0,3}(?:\*\*)?Relation(?:\*\*)?:\s*\S.*$/i;
const RIVALS =
	/\b(?:rivals?|mutually exclusive|all (?:two|three|four|five) conflict|all conflict)\b/i;
const COMBINABLE =
	/\b(?:independent|combin\w*|together|alongside|any combination|compatible)\b/i;

/** @typedef {{ number: string, lines: string[] }} QuestionBlock */

/**
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

/** @param {string[]} lines */
function parseRelationLine(lines) {
	return lines.find((l) => RELATION_LINE.test(l)) ?? "";
}

/** @param {string[]} lines */
function isRivalSet(lines) {
	const relation = parseRelationLine(lines);
	return RIVALS.test(relation) && !COMBINABLE.test(relation);
}

/**
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
