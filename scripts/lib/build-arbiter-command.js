const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

/**
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
