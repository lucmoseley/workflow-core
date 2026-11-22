const { caught } = require("./caught.js");

/**
 * @param {string} text
 */
function parseFirstLine(text) {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return end === -1 ? trimmed : trimmed.slice(0, end);
}

const LOCATION = /^\S+:\d+$/;
const THROWN = /^(?:Uncaught )?[A-Za-z]*(?:Error|Exception)\b[^:]*: \S/;

/**
 * @param {string} text
 */
function parseMessageLine(text) {
	const first = parseFirstLine(text);
	if (!LOCATION.test(first)) return first;
	const thrown = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => THROWN.test(l));
	return thrown ?? first;
}

/**
 * @param {unknown} e
 */
const parseErrorFirstLine = (e) => parseFirstLine(caught(e).message);

module.exports = { parseErrorFirstLine, parseFirstLine, parseMessageLine };
