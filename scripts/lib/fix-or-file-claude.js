// #5833

/** @typedef {{type: string, instructions: string, criteria: {true: string, false: string}}} Question */

const SYSTEM_PROMPT =
	"You judge one message an assistant sent at the end of its turn. Answer the " +
	"question about it with the probability, from 0 to 1, that the answer is " +
	"true. Reply with that number alone, written as a decimal such as 0.15: " +
	"no words, no true or false.";

/**
 * @param {{model: string}} spec
 * @returns {string[]}
 */
const claudeArgs = ({ model }) => [
	"-p",
	"--settings",
	JSON.stringify({ disableAllHooks: true }),
	"--tools",
	"",
	"--model",
	model,
	"--no-session-persistence",
	"--output-format",
	"json",
	"--system-prompt",
	SYSTEM_PROMPT,
];

/**
 * @param {Question} question
 * @param {string} message
 * @returns {string}
 */
const claudePrompt = (question, message) =>
	`Question: ${question.instructions}\n` +
	`True when: ${question.criteria.true}\n` +
	`False when: ${question.criteria.false}\n\n` +
	`The message:\n<message>\n${message}\n</message>`;

/**
 * @param {string} stdout
 * @returns {{p: number, costUsd: number}}
 */
function parseClaudeVerdict(stdout) {
	const out = JSON.parse(stdout);
	if (out?.is_error) throw new Error(`claude -p failed: ${String(out.result)}`);
	// measured, #5833: Haiku sometimes reasons first and ends on the number
	const last = (
		String(out?.result ?? "")
			.trim()
			.split("\n")
			.at(-1) ?? ""
	).trim();
	const p = /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(last)
		? Number(last)
		: Number.NaN;
	if (!Number.isFinite(p) || p < 0 || p > 1)
		throw new Error(`claude -p gave no probability: ${String(out?.result)}`);
	const cost = Number(out?.total_cost_usd);
	return { p, costUsd: Number.isFinite(cost) ? cost : 0 };
}

module.exports = { claudeArgs, claudePrompt, parseClaudeVerdict };
