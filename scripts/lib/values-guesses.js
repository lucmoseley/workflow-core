const { buildLineRe } = require("./marker-line.js");
const { takesLabel } = require("./takes-label.js");

const BUILD_LABELS = ["wayfinder:task", takesLabel("implement")];

const VALUES_LINES = buildLineRe("Values", "(.*)$", "gm");

// #5619
const GUESS = /\b(?:untraced|guess(?:es|ed)?|estimate[sd]?)\b/i;

const TAG = /\bdelegated[ \t]*—[ \t]*\S|\bhouse:[ \t]*[\w./-]*#\d+/i;

const CODE_SPAN = /`[^`\n]*`/g;

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
const buildMarks = (labels) => labels.filter((l) => BUILD_LABELS.includes(l));

/**
 * @param {string} comment
 * @returns {string[]}
 */
function untaggedGuesses(comment) {
	/** @type {string[]} */
	const found = [];
	for (const m of comment.matchAll(VALUES_LINES))
		for (const raw of String(m[1]).split(";")) {
			const entry = raw.trim();
			if (GUESS.test(entry.replace(CODE_SPAN, "")) && !TAG.test(entry))
				found.push(entry);
		}
	return found;
}

/**
 * @param {number} n
 * @param {string[]} labels
 * @param {string} comment
 * @returns {string}
 */
function guessRefusal(n, labels, comment) {
	const marks = buildMarks(labels);
	if (marks.length === 0) return "";
	const entries = untaggedGuesses(comment);
	if (entries.length === 0) return "";
	return `#${n} is a build ticket (${marks.join(", ")}), and its **Values:** line marks ${entries.length === 1 ? "a value" : `${entries.length} values`} untraced, a guess or an estimate with no tag:\n${entries.map((e) => `  - ${e}`).join("\n")}\nA build sets no value a goal of the founder's decides unless he was asked. Put the value to him, or tag the entry "<entry> — delegated — <why no goal of the founder's turns on it>" or "<entry> — house: #<the ruling that set it>". Only a --reason "not planned" close is exempt.`;
}

module.exports = { guessRefusal, untaggedGuesses };
