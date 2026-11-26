const { parseJsonl } = require("../lib/jsonl.js");

// lucmoseley/mantahostels#287
/**
 * @param {string} p
 */
const tier1 = (p) =>
	/^(docs\/|\.claude\/)/.test(p) || p === "CLAUDE.md" || p === "AGENTS.md";

/**
 * @param {string} p
 */
const claimable = (p) => tier1(p) && !p.startsWith(".claude/tmp/");

/**
 * @param {string} text
 * @returns {string[]}
 */
function quotedTokens(text) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const q of ["'", '"', "`"]) {
		for (const m of text.match(new RegExp(`${q}[^${q}\\s]+${q}`, "g")) ?? []) {
			out.add(m.slice(1, -1));
		}
	}
	return [...out];
}

const WRITE_CALL = [
	/\.write_text\s*\(/,
	/\.write_bytes\s*\(/,
	/\.writelines\s*\(/,
	/\bopen\s*\([^)]*,\s*['"`][wax]/,
	/\bjson\.dump\s*\(/,
	/\bwriteFileSync\b/,
	/\bappendFileSync\b/,
	/\bcreateWriteStream\b/,
	/\bfs\.promises\.(writeFile|appendFile)\b/,
	/\bwriteFile\s*\(/,
	/\bshutil\.(copy|move)/,
	/\bos\.(replace|rename|remove|unlink)\b/,
	/\bfs\.(renameSync|unlinkSync|copyFileSync|rmSync)\b/,
	/\.mkdir/,
	/\bsys\.stdout\.write/,
];

/** @param {string} cmd */
const writesSomething = (cmd) => WRITE_CALL.some((re) => re.test(cmd));

/**
 * @param {string} text
 * @returns {{rows: {s: string, c: string}[], unparsed: number, zeroed: number}}
 */
function parseRows(text) {
	const { rows, bad, zeroed } = parseJsonl(text);
	return {
		rows: /** @type {{s: string, c: string}[]} */ (rows),
		unparsed: bad.length,
		zeroed: zeroed.length,
	};
}

module.exports = {
	claimable,
	parseRows,
	quotedTokens,
	writesSomething,
};
