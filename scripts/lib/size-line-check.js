/*
 * size-line-check.js — which open `takes:implement` tickets a new one must be
 * weighed against under rule:size-line before it is filed (#4450): the ones
 * this session already filed, and the open siblings naming a source file the
 * new body names. A pure module; file-issue.js does the reads.
 */

const { takesLabel } = require("./takes-label.js");

const IMPLEMENT_LABEL = takesLabel("implement");

/* A repo path with at least one directory and a code extension: a shared doc
 * or config file says nothing about co-change. */
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
 * The issues the new ticket must be weighed against, each with the source
 * files it shares (none for an earlier filing of this session's) — empty
 * where the new ticket is no `takes:implement` or every one is confirmed.
 * @param {{labels: string[], body: string, filed: Candidate[],
 *   siblings: Candidate[], confirmed: Set<number>}} at
 * @returns {Overlap[]}
 */
function sizeLineCandidates({ labels, body, filed, siblings, confirmed }) {
	if (!labels.includes(IMPLEMENT_LABEL)) return [];
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
 * The refusal, after the rule text.
 * @param {string} rule rule:size-line's text
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

module.exports = { buildSizeLineRefusal, sizeLineCandidates, sourcePaths };
