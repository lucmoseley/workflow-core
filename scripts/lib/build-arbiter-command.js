const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {(text: TemplateStringsArray, ...words: (string | number | string[])[]) => string}
 */
const arbiterCommandIn =
	(env) =>
	(text, ...words) => {
		const quoted = words.map((word) =>
			[word]
				.flat()
				.map((w) => shellQuote(String(w)))
				.join(" "),
		);
		return `node ${scriptPath("session-arbiter.js", env)} ${String.raw({ raw: text }, ...quoted)}`;
	};

const buildArbiterCommand = arbiterCommandIn(process.env);

module.exports = { arbiterCommandIn, buildArbiterCommand };
