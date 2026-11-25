const COMMENT_LEAD = "^\\s*(?:#+|\\*|//)\\s*";

/** @param {string} text */
function parseHeaderLines(text) {
	const lines = text.split("\n");
	/** @type {string[]} */
	const out = [];
	const start = lines[0]?.startsWith("#!") ? 1 : 0;
	let inBlock = false;
	for (const line of lines.slice(start)) {
		const t = line.trim();
		if (!(inBlock || isHeaderLine(t))) break;
		out.push(line);
		inBlock = isBlockOpenAfter(t, inBlock);
	}
	return out;
}

function isHeaderLine(/** @type {string} */ t) {
	return (
		t === "" || t.startsWith("/*") || t.startsWith("#") || t.startsWith("//")
	);
}

function isBlockOpenAfter(
	/** @type {string} */ t,
	/** @type {boolean} */ inBlock,
) {
	if (inBlock) return !t.includes("*/");
	return t.startsWith("/*") && !t.includes("*/");
}

module.exports = { COMMENT_LEAD, parseHeaderLines };
