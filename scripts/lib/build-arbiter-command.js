/*
 * build-arbiter-command.js — the one spelling of a printed session-arbiter command
 * carrying a word (workflow-core#3990). A template tag, so a word reaches the command only
 * through an interpolation, and every interpolation is quoted. Fixed text, a
 * `<placeholder>` among it, stays as written; prose after the command stays
 * outside the tag, or it is quoted as a word.
 *
 * scripts/check-arbiter-commands.js refuses a command spelt any other way.
 */

const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * The tagged arguments as a line to run: `buildArbiterCommand\`wait ${path}\``. An
 * array word is several words.
 * @param {TemplateStringsArray} text
 * @param {...(string | number | string[])} words
 * @returns {string}
 */
function buildArbiterCommand(text, ...words) {
	const quoted = words.map((word) =>
		[word]
			.flat()
			.map((w) => shellQuote(String(w)))
			.join(" "),
	);
	return `node ${scriptPath("session-arbiter.js")} ${String.raw({ raw: text }, ...quoted)}`;
}

module.exports = { buildArbiterCommand };
