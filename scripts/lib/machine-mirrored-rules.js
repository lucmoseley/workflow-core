const MIRRORED_FILE = ".claude/workflow-core.md";

/* #5344, #5683 */
const MIRRORED_SECTIONS = [
	"Removal means gone",
	"Leading practice",
	"Reports and paid data",
];

/**
 * @param {string} text
 * @returns {number}
 */
function mirroredBytes(text) {
	let bytes = 0;
	let inside = false;
	for (const line of text.split(/(?<=\n)/)) {
		if (line.startsWith("## "))
			inside = MIRRORED_SECTIONS.includes(line.slice(3).trimEnd());
		if (inside) bytes += Buffer.byteLength(line);
	}
	return bytes;
}

module.exports = { MIRRORED_FILE, MIRRORED_SECTIONS, mirroredBytes };
