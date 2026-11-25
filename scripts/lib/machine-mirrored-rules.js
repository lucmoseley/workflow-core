const MIRRORED_FILE = ".claude/workflow-core.md";

const MIRRORED_SECTIONS = [
	"Removal means gone",
	"Leading practice",
	"Reports and paid data",
];

const HEADING = /^#{1,2} (.*)/s;

/**
 * @param {string} text
 * @returns {number}
 */
function mirroredBytes(text) {
	let bytes = 0;
	let inside = false;
	for (const line of text.split(/(?<=\n)/)) {
		const heading = line.match(HEADING);
		if (heading)
			inside = MIRRORED_SECTIONS.includes(heading[1]?.trimEnd() ?? "");
		if (inside) bytes += Buffer.byteLength(line);
	}
	return bytes;
}

/**
 * @param {string} rel
 * @param {number} size
 * @param {() => string} read
 * @returns {number}
 */
const pooledSize = (rel, size, read) =>
	rel === MIRRORED_FILE && size > 0 ? size - mirroredBytes(read()) : size;

module.exports = {
	MIRRORED_FILE,
	MIRRORED_SECTIONS,
	mirroredBytes,
	pooledSize,
};
