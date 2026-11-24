const { takesLabel } = require("./takes-label.js");

const IMPLEMENT_LABEL = takesLabel("implement");

const SOURCE_PATH =
	/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]+\.(?:[cm]?js|jsx|tsx?|sh|py)(?![\w/-])/g;

/** @param {string} body @returns {Set<string>} */
const sourcePaths = (body) => new Set(body.match(SOURCE_PATH) ?? []);

/**
 * @typedef {{number: number, labels: string[], state: string, body?: string}} Candidate
 * @typedef {{number: number, shared: string[]}} Overlap
 */

/** @param {Candidate} c */
const isOpenImplement = (c) =>
	c.state === "open" && c.labels.includes(IMPLEMENT_LABEL);

/**
 * @param {{body: string, filed: Candidate[], siblings: Candidate[],
 *   confirmed: Set<number>}} at
 * @returns {Overlap[]}
 */
function sizeLineCandidates({ body, filed, siblings, confirmed }) {
	const named = sourcePaths(body);
	/** @type {Map<number, Overlap>} */
	const found = new Map();
	for (const c of filed.filter(isOpenImplement))
		found.set(c.number, { number: c.number, shared: [] });
	for (const c of siblings.filter(isOpenImplement)) {
		const shared = [...sourcePaths(c.body ?? "")].filter((p) => named.has(p));
		if (shared.length > 0) found.set(c.number, { number: c.number, shared });
	}
	return [...found.values()]
		.filter((o) => !confirmed.has(o.number))
		.sort((a, b) => a.number - b.number);
}

/**
 * @param {string} rule
 * @param {Overlap[]} overlaps
 * @param {Set<number>} confirmed
 */
function buildSizeLineRefusal(rule, overlaps, confirmed) {
	const lines = overlaps.map(
		(o) =>
			`  #${o.number} — ${o.shared.length > 0 ? `an open sibling also naming ${o.shared.join(", ")}` : "filed by this session"}\n`,
	);
	const all = [...new Set([...confirmed, ...overlaps.map((o) => o.number)])];
	return `${rule}\n\nThis takes:implement ticket may belong to the same build unit as:\n${lines.join("")}Nothing filed. Apply the independence test above to each: where they share a build unit, add this work to that ticket as a slice instead. Where each is its own unit, re-run with --size-line-checked ${all.join(",")}, and chain any pair that fails the test with a blocked_by edge once filed.`;
}

module.exports = { IMPLEMENT_LABEL, buildSizeLineRefusal, sizeLineCandidates };
