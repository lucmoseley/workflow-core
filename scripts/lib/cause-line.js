// #5781
const CAUSED_BY = "**Caused by:**";

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * @param {string[]} shas
 * @returns {string}
 */
const buildCauseLine = (shas) => `${CAUSED_BY} ${shas.join(", ")}`;

/**
 * @param {string} text
 * @returns {string[]}
 */
function causeShas(text) {
	return text.split("\n").flatMap((line) => {
		const at = line.indexOf(CAUSED_BY);
		if (at === -1) return [];
		return line
			.slice(at + CAUSED_BY.length)
			.split(/[\s,]+/)
			.map((t) => t.replace(/^`|`$/g, ""))
			.filter((t) => SHA.test(t));
	});
}

module.exports = { CAUSED_BY, buildCauseLine, causeShas };
