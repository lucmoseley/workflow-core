/*
 * headless-options.js — the options `claude --help` lists (#4586), which
 * record-headless-run.js records into scripts/fixtures/headless-run.json and
 * the headless-run contract reads off the installed binary.
 */

/**
 * @typedef {"none"|"required"|"optional"|"variadic"} Arity
 * @typedef {{names: string[], value: Arity, flags: string}} HelpOption
 *   `flags` as the binary's own refusals spell it: `-n, --name <name>`
 */

/* `  -n, --name <name>   Set a…`: the names, then at most one placeholder. */
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

/* A guess: a free `claude` call answers in well under a second, and a hang
 * should fail or skip. */
const LIVE_CALL_TIMEOUT_MS = 30_000;

module.exports = { LIVE_CALL_TIMEOUT_MS, parseHelpOptions };
