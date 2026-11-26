const { escapeRe } = require("./regex-group");

const CAUSED_BY = "**Caused by:**";

const HEX = "[0-9a-f]{7,40}";
const SHA = new RegExp(`^${HEX}$`);
const LINE = new RegExp(`^\\s*(?:[-*]\\s+)?${escapeRe(CAUSED_BY)}(.*)$`);
const NEXT_SHA = new RegExp(`^\\s*\`?(${HEX})\`?(?![0-9A-Za-z])\\s*(,?)`);

/**
 * @param {string[]} shas
 * @returns {string}
 */
const buildCauseLine = (shas) => `${CAUSED_BY} ${shas.join(", ")}`;

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseCauseShas(text) {
	return text.split(/\r?\n/).flatMap((line) => {
		/** @type {string[]} */
		const shas = [];
		let rest = LINE.exec(line)?.[1] ?? "";
		for (;;) {
			const [token, sha, comma] = NEXT_SHA.exec(rest) ?? [];
			if (token === undefined || sha === undefined) return shas;
			shas.push(sha);
			if (!comma) return shas;
			rest = rest.slice(token.length);
		}
	});
}

module.exports = { SHA, buildCauseLine, parseCauseShas };
