/**
 * @typedef {"none"|"required"|"optional"|"variadic"} Arity
 * @typedef {{names: string[], value: Arity, flags: string}} HelpOption
 */

const OPTION_LINE =
	/^ {2}(-[\w-]+(?:, -[\w-]+)*)(?: ([<[][^>\]]+[>\]]))?(?: {2,}|$)/;

/**
 * @param {string} help
 * @returns {HelpOption[]}
 */
function parseHelpOptions(help) {
	/** @type {HelpOption[]} */
	const options = [];
	for (const line of help.split("\n")) {
		const m = line.match(OPTION_LINE);
		if (!m?.[1]) continue;
		const placeholder = m[2] ?? "";
		/** @type {Arity} */
		let value = "none";
		if (placeholder.endsWith("...>") || placeholder.endsWith("...]"))
			value = "variadic";
		else if (placeholder.startsWith("<")) value = "required";
		else if (placeholder.startsWith("[")) value = "optional";
		options.push({
			names: m[1].split(", "),
			value,
			flags: placeholder ? `${m[1]} ${placeholder}` : m[1],
		});
	}
	return options;
}

const HIDDEN_FLAGS = ["--max-turns"];

/**
 * @param {string} stderr
 * @returns {HelpOption | null}
 */
function parseMissingValueRefusal(stderr) {
	const m = stderr.match(/^error: option '(.+)' argument missing$/m);
	return (m && parseHelpOptions(`  ${m[1]}`)[0]) || null;
}

// guess, workflow-core#4586
const LIVE_CALL_TIMEOUT_MS = 30_000;

module.exports = {
	HIDDEN_FLAGS,
	LIVE_CALL_TIMEOUT_MS,
	parseHelpOptions,
	parseMissingValueRefusal,
};
