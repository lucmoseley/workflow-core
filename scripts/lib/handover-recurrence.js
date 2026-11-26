const { OPTION_LABEL, CONFIDENCE_ANY } = require("./round-marker");
const { requiredGroup } = require("./regex-group");

/**
 * @typedef {import("./round-marker").QuestionBlock} QuestionBlock
 * @typedef {{ block: QuestionBlock, founderLetters: Set<string> }} HandoverRound
 */

const RECURRENCE_LINE = /^\s{0,3}(?:\*\*)?Recurrence(?:\*\*)?:(?:\*\*)?(.*)$/i;
const NONE_FOUND = /^(?:\*\*)?none\b/i;
const ISSUE_REF = /^((?:[\w.-]+\/[\w.-]+)?#\d+)[.:]?$/;
const RECOMMENDS = /^\s{0,3}➡|\brecommend(?:s|ation|ed)?\b/iu;
const LETTER_REF = /\(([A-Z])\)/g;
const FIGURE = /Confidence:\s*(\d{1,3})\s*%/;

/**
 * @param {string[]} lines
 * @returns {string | null}
 */
function recurrencePayload(lines) {
	for (const line of lines) {
		const m = line.match(RECURRENCE_LINE);
		if (m) return requiredGroup(m, 1, RECURRENCE_LINE).trim();
	}
	return null;
}

/**
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function recommendedLetters(lines) {
	const named = new Set(
		lines
			.filter(
				(line) =>
					RECOMMENDS.test(line) &&
					!OPTION_LABEL.test(line) &&
					!CONFIDENCE_ANY.test(line),
			)
			.flatMap((line) =>
				[...line.matchAll(LETTER_REF)].map((m) =>
					requiredGroup(m, 1, LETTER_REF),
				),
			),
	);
	return named.size > 0 ? named : topPriced(lines);
}

/**
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function topPriced(lines) {
	let best = { letter: "", figure: -1 };
	let letter = "";
	for (const line of lines) {
		const label = line.match(OPTION_LABEL);
		if (label) letter = requiredGroup(label, 1, OPTION_LABEL);
		const fig = line.match(FIGURE);
		if (letter && fig && Number(fig[1]) > best.figure)
			best = { letter, figure: Number(fig[1]) };
	}
	return new Set(best.letter ? [best.letter] : []);
}

/**
 * @param {string} payload
 * @returns {string[]}
 */
function issueRefs(payload) {
	return payload.split(/[\s,;()]+/).flatMap((token) => {
		const m = token.match(ISSUE_REF);
		return m ? [requiredGroup(m, 1, ISSUE_REF)] : [];
	});
}

/**
 * @param {HandoverRound} round
 * @param {() => boolean | null} searched
 * @returns {string | null}
 */
function defectOf({ block, founderLetters }, searched) {
	const payload = recurrencePayload(block.lines);
	if (!payload) return "it carries no `Recurrence:` line";
	const refs = NONE_FOUND.test(payload) ? [] : issueRefs(payload);
	if (refs.length === 0 && !NONE_FOUND.test(payload))
		return "its `Recurrence:` line neither opens `none` nor names an earlier issue";
	if (searched() === false)
		return "its `Recurrence:` line stands on no search of closed issues this session";
	if (refs.length === 0) return null;
	const manual = [...recommendedLetters(block.lines)].filter((l) =>
		founderLetters.has(l),
	);
	if (manual.length === 0) return null;
	return (
		`its \`Recurrence:\` line names an earlier occurrence (${refs.join(", ")}), ` +
		`yet it recommends (${manual.join("), (")}), the founder doing it by hand again`
	);
}

/**
 * @param {HandoverRound[]} rounds
 * @param {() => boolean | null} searched
 * @returns {string}
 */
function recurrenceRefusal(rounds, searched) {
	/** @type {string[]} */
	const flagged = [];
	for (const round of rounds) {
		const defect = defectOf(round, searched);
		if (defect) flagged.push(`Q${round.block.number}: ${defect}.`);
	}
	if (flagged.length === 0) return "";
	return (
		'This turn hands the founder an act in a "you or me?" round and has ' +
		"not settled whether the same act was handed to him before:\n\n" +
		flagged.join("\n") +
		"\n\nFirst search the closed issues for the same act — a deploy, a " +
		"migration, a grant, a paste: `gh search issues --state closed " +
		"'<the act>'`. Then give the round a line of its own: `Recurrence: " +
		"none — <the search you ran>`, or `Recurrence: #<n>, #<n> — <the act " +
		"each ended on>`. One earlier occurrence makes it recurring, and then " +
		"the recommended option is the durable fix, led by what you build — " +
		"a script, a narrow permission rule — so no later session hands it " +
		"over again. Doing it by hand again stays an option, never the " +
		"recommended one; a past hand-over is evidence the act recurs, never " +
		"a reason to repeat it.\n\nRE-SEND ONLY THE CORRECTED QUESTION, not " +
		"the whole round."
	);
}

module.exports = { recurrenceRefusal };
