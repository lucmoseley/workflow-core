/*
 * guard-header.js — a guard's header comment, as the guard registry reads it.
 * The registry's annotation scan and a guard's digest
 * (lib/guard-digest.js) read one header (workflow-core#4901, workflow-core#4915).
 */

const COMMENT_LEAD = "^\\s*(?:#+|\\*|//)\\s*";

/*
 * The header comment: everything above the first line of executable code, after
 * an optional shebang. Both comment spellings and a `/* … *\/` block are read.
 *
 * Deliberately not "the first N lines". A fixed window either cuts a long header
 * in half or lets an annotation buried in the body count as a header
 * annotation.
 */
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

/** Whether a trimmed line outside a block comment still belongs to the header. */
function isHeaderLine(/** @type {string} */ t) {
	return (
		t === "" || t.startsWith("/*") || t.startsWith("#") || t.startsWith("//")
	);
}

/** Whether a block comment is open after trimmed line `t`. */
function isBlockOpenAfter(
	/** @type {string} */ t,
	/** @type {boolean} */ inBlock,
) {
	if (inBlock) return !t.includes("*/");
	return t.startsWith("/*") && !t.includes("*/");
}

module.exports = { COMMENT_LEAD, parseHeaderLines };
