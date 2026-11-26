const { requiredGroup } = require("./regex-group");

/**
 * @typedef {{ number: string, lines: string[], recommended: string | null }} HandoverRound
 */

const RECURRENCE_LINE = /^\s{0,3}(?:\*\*)?Recurrence(?:\*\*)?:(?:\*\*)?(.*)$/i;
const NONE_FOUND = /^\s*(?:\*\*)?none\b/i;
const ISSUE_REF = /^((?:[\w.-]+\/)?[\w.-]*#\d+)(?:'s|[.:])?$/;
const REPEAT_LETTER = /\(([A-Z])\)/;

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
 * @param {string} payload
 * @returns {string[]}
 */
function issueRefs(payload) {
	return payload.split(/[\s,;()]+/).flatMap((token) => {
		const m = token.replace(/’/g, "'").match(ISSUE_REF);
		return m ? [requiredGroup(m, 1, ISSUE_REF)] : [];
	});
}

/**
 * @param {HandoverRound} round
 * @param {() => boolean | null} searched
 * @returns {string | null}
 */
function defectOf({ lines, recommended }, searched) {
	const payload = recurrencePayload(lines);
	if (!payload) return "it carries no `Recurrence:` line";
	const none = NONE_FOUND.test(payload);
	const refs = none ? [] : issueRefs(payload);
	if (!none && refs.length === 0)
		return "its `Recurrence:` line neither opens `none` nor names an earlier issue";
	if (searched() === false)
		return "its `Recurrence:` line stands on no search of closed issues this session";
	if (none) return null;
	const repeat = payload.match(REPEAT_LETTER);
	if (!repeat)
		return (
			`its \`Recurrence:\` line names an earlier occurrence (${refs.join(", ")}) ` +
			"but not the option that repeats the hand-over"
		);
	const letter = requiredGroup(repeat, 1, REPEAT_LETTER);
	if (recommended !== letter) return null;
	return (
		`its \`Recurrence:\` line names an earlier occurrence (${refs.join(", ")}), ` +
		`yet it recommends (${letter}), the option that repeats the hand-over`
	);
}

/**
 * @param {HandoverRound[]} rounds
 * @param {() => boolean | null} searched
 * @param {() => string} rule
 * @returns {string}
 */
function recurrenceRefusal(rounds, searched, rule) {
	/** @type {string[]} */
	const flagged = [];
	for (const round of rounds) {
		const defect = defectOf(round, searched);
		if (defect) flagged.push(`Q${round.number}: ${defect}.`);
	}
	if (flagged.length === 0) return "";
	return (
		"This turn hands the founder an act and has not settled whether the " +
		"same act was handed to him before:\n\n" +
		flagged.join("\n") +
		`\n\n${rule()}\n\nRE-SEND ONLY THE CORRECTED QUESTION, not the whole round.`
	);
}

module.exports = { recurrenceRefusal };
