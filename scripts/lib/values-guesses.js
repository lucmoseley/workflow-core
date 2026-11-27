const { buildLineRe } = require("./marker-line.js");
const { requiredGroup } = require("./regex-group.js");
const { takesLabel } = require("./takes-label.js");

const BUILD_LABELS = ["wayfinder:task", takesLabel("implement")];

const VALUES_LINES = buildLineRe("Values", "(.*)$", "gm");

// workflow-core#5619
const GUESS = /\b(?:untraced|guess(?:es|ed)?|estimate[sd]?)\b/i;

const TAG = /\bdelegated[ \t]*—[ \t]*\S|\bhouse:[ \t]*[\w./-]*#\d+/i;

const CODE_SPAN = /`[^`\n]*`/g;

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * @param {string} text
 * @returns {string}
 */
function withoutFences(text) {
	/** @type {string[]} */
	const kept = [];
	let fence = "";
	for (const line of text.split("\n")) {
		const open = FENCE_OPEN.exec(line)?.[1];
		if (fence) {
			if (open && open[0] === fence[0] && open.length >= fence.length)
				fence = "";
		} else if (open) fence = open;
		else kept.push(line);
	}
	return kept.join("\n");
}

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
const buildTicketMarks = (labels) =>
	labels.filter((l) => BUILD_LABELS.includes(l));

/**
 * @param {string} line
 * @returns {string[]}
 */
function splitEntries(line) {
	/** @type {string[]} */
	const entries = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		else if (c === ";" && depth === 0) {
			entries.push(line.slice(start, i));
			start = i + 1;
		}
	}
	entries.push(line.slice(start));
	return entries.map((e) => e.trim());
}

/**
 * @param {string} comment
 * @returns {string[]}
 */
function untaggedGuesses(comment) {
	/** @type {string[]} */
	const found = [];
	for (const m of withoutFences(comment).matchAll(VALUES_LINES))
		for (const entry of splitEntries(requiredGroup(m, 1, VALUES_LINES)))
			if (GUESS.test(entry.replace(CODE_SPAN, "")) && !TAG.test(entry))
				found.push(entry);
	return found;
}

/**
 * @param {number} n
 * @param {string[]} labels
 * @param {string} comment
 * @returns {string}
 */
function guessRefusal(n, labels, comment) {
	const marks = buildTicketMarks(labels);
	if (marks.length === 0) return "";
	const entries = untaggedGuesses(comment);
	if (entries.length === 0) return "";
	return `#${n} is a build ticket (${marks.join(", ")}), and its **Values:** line holds untagged entries marked untraced, a guess or an estimate:\n${entries.map((e) => `  - ${e}`).join("\n")}\nA build sets no value a goal of the founder's decides unless he was asked. Put the value to him, or tag the entry "<entry> — delegated — <why no goal of the founder's turns on it>" or "<entry> — house: #<the ruling that set it>". Only a --reason "not planned" close is exempt.`;
}

module.exports = { guessRefusal };
