const { readJsonl } = require("./jsonl.js");

// guess, #5827: brackets the 0.5 default and the 0.7 to 0.8 knee the labelled set shows
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * @typedef {{id: string, repo: string, label: boolean|null, kind: string,
 *   text?: string, transcript?: string, textHash?: string, p?: number}} Row
 * @typedef {{id: string, label: boolean|null, kind: string, p: number}} Scored
 */

/**
 * @param {Record<string, unknown>} row
 * @param {string} where
 * @returns {Row}
 */
function parseLabelRow(row, where) {
	const { id, repo, label, kind, text, transcript, textHash, p } = row;
	if (typeof id !== "string") throw new Error(`${where}: no string id`);
	if (typeof repo !== "string") throw new Error(`${where}: no string repo`);
	if (label !== null && typeof label !== "boolean")
		throw new Error(`${where}: label is neither a boolean nor null`);
	if (typeof kind !== "string") throw new Error(`${where}: no string kind`);
	if (text !== undefined && typeof text !== "string")
		throw new Error(`${where}: text is not a string`);
	if (transcript !== undefined && typeof transcript !== "string")
		throw new Error(`${where}: transcript is not a string`);
	if (textHash !== undefined && typeof textHash !== "string")
		throw new Error(`${where}: textHash is not a string`);
	if (p !== undefined && typeof p !== "number")
		throw new Error(`${where}: p is not a number`);
	return { id, repo, label, kind, text, transcript, textHash, p };
}

/**
 * @param {string} file
 * @returns {Row[]}
 */
function readLabelRows(file) {
	const read = readJsonl(file);
	if (!read) throw new Error(`${file}: no such file`);
	if (read.bad.length > 0)
		throw new Error(`${file}: lines ${read.bad.join(", ")} are not JSON`);
	return read.entries.map(({ row, line }) =>
		parseLabelRow(row, `${file}:${line}`),
	);
}

/**
 * @param {Row[]} rows
 * @returns {Scored[]}
 */
function recordedScores(rows) {
	/** @type {Scored[]} */
	const scored = [];
	for (const { id, label, kind, p } of rows)
		if (p !== undefined) scored.push({ id, label, kind, p });
	return scored;
}

/**
 * @param {Scored[]} scored
 * @param {number} threshold
 */
function rates(scored, threshold) {
	const fires = (/** @type {Scored} */ s) => s.p >= threshold;
	const pos = scored.filter((s) => s.label === true);
	const neg = scored.filter((s) => s.label === false);
	const fired = scored.filter(fires).length;
	const tp = pos.filter(fires).length;
	const fp = neg.filter(fires).length;
	return {
		threshold,
		fires: fired,
		tp,
		fp,
		unjudged: fired - tp - fp,
		tpr: pos.length > 0 ? tp / pos.length : null,
		tnr: neg.length > 0 ? (neg.length - fp) / neg.length : null,
		effectiveFp: tp + fp > 0 ? fp / (tp + fp) : null,
	};
}

/** @param {number|null} r */
const pct = (r) =>
	r === null ? "  n/a" : `${(r * 100).toFixed(0)}%`.padStart(5);

/**
 * @param {Scored[]} scored
 * @returns {string[]}
 */
function report(scored) {
	const count = (/** @type {boolean|null} */ label) =>
		scored.filter((s) => s.label === label).length;
	const lines = [
		`${scored.length} replies scored: ${count(true)} positive, ${count(false)} negative, ${count(null)} unjudged.`,
		"threshold   TPR   TNR  fires  tp fp unjudged  effective FP",
	];
	for (const t of THRESHOLDS) {
		const r = rates(scored, t);
		lines.push(
			`   ${t.toFixed(1)}     ${pct(r.tpr)} ${pct(r.tnr)}  ${String(r.fires).padStart(5)}  ${r.tp} ${r.fp} ${r.unjudged}  ${pct(r.effectiveFp)}`,
		);
	}
	return lines;
}

module.exports = { readLabelRows, recordedScores, rates, report };
