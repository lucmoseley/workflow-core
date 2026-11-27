const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];

const hasLineTerminator = (/** @type {string} */ text) =>
	LINE_TERMINATORS.some((c) => text.includes(c));

const firstLineTerminator = (/** @type {string} */ text) =>
	Math.min(
		text.length,
		...LINE_TERMINATORS.map((c) => text.indexOf(c)).filter((i) => i !== -1),
	);

const lastLineTerminator = (/** @type {string} */ text) =>
	Math.max(...LINE_TERMINATORS.map((c) => text.lastIndexOf(c)));

module.exports = {
	LINE_TERMINATORS,
	firstLineTerminator,
	hasLineTerminator,
	lastLineTerminator,
};
