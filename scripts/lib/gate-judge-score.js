/*
 * gate-judge-score.js — how measure-gate-judge.js scores the gate judge
 * (lib/gate-judge.js, #4964): a stored reply read against its body, a
 * labelled case counted over its runs, a corpus body's two readings set side
 * by side, and the interval and quantile the rates are printed with. No call
 * and no file: the command does both.
 */

const {
	holdsOther,
	mergeFaults,
	parseReading,
	readingFaults,
} = require("./gate-judge.js");
const { basisFaults, gateFacts, otherIssueRefs } = require("./issue-gate.js");

/**
 * @typedef {import("./gate-judge.js").JudgedFault} JudgedFault
 * @typedef {{key: string, ms: number, fallback: string|null, reading: unknown}} Row
 *   one call as stored: `reading` as the model gave it, null with `fallback`
 * @typedef {{replied: number, dropped: number, waits: string[],
 *   bases: {basis: string, class: string}[],
 *   model: import("./gate-judge.js").ModelFault[], added: JudgedFault[]}} Judged
 *   `replied`: the quotes the model gave; `dropped`: those the code dropped;
 *   `waits` and `bases`: those kept; `model`: the faults they raise; `added`:
 *   those the patterns do not already raise
 * @typedef {{id: string, label: string, kind: string, text: string, own: number|null}} Case
 */

/**
 * A stored reply read against its body, null where the call fell back.
 *
 * @param {string} body
 * @param {number|null} own
 * @param {Row} row
 * @returns {Judged|null}
 */
function judgeRow(body, own, row) {
	const reading = row.fallback === null ? parseReading(row.reading) : null;
	if (!reading) return null;
	const judged = readingFaults(body, reading, own ?? undefined);
	return {
		replied: reading.waits.length + reading.bases.length,
		dropped: judged.dropped,
		waits: judged.waits.map((w) => w.sentence),
		bases: judged.bases,
		model: judged.faults,
		added: mergeFaults(
			basisFaults(body, own ?? undefined),
			judged.faults,
		).filter((f) => f.by === "model"),
	};
}

const GATE_OR_BASIS_LINE =
	/^[ \t]{0,3}\*\*(?:Gated until|Gated on|Gate basis):\*\*.*$/gim;

/**
 * The prose waits the patterns read in `body`, whatever basis it carries.
 * @param {string} body
 */
const patternWaits = (body) =>
	basisFaults(body.replace(GATE_OR_BASIS_LINE, "")).map((f) => f.text);

/**
 * The group a case is counted in: its label, but an inherited basis naming no
 * issue other than its own is `inherited-unsourced`, which the judge refuses
 * by rule whatever class it reads.
 * @param {Case} c
 */
function groupOf(c) {
	const own = c.own ?? undefined;
	return c.label === "inherited" &&
		gateFacts(c.text).bases.every((b) => otherIssueRefs(b, own).length === 0)
		? "inherited-unsourced"
		: c.label;
}

/**
 * Whether a reading flags a case: a wait read, for a wait or non-wait case; a
 * basis refused for its warrant, where a refusal is the right answer; any
 * fault the reading raises, for a derived or sourced inherited basis.
 * @param {string} group
 * @param {Judged} judged
 */
function isFlagged(group, judged) {
	if (group === "wait" || group === "non-wait") return judged.waits.length > 0;
	if (group === "derived" || group === "inherited")
		return judged.model.length > 0;
	return judged.model.some((f) => f.kind === "no-warrant");
}

/**
 * The same question put to the patterns alone.
 * @param {string} group
 * @param {Case} c
 */
function isPatternFlagged(group, c) {
	if (group === "wait" || group === "non-wait")
		return patternWaits(c.text).length > 0;
	const faults = basisFaults(c.text, c.own ?? undefined);
	return group === "derived" || group === "inherited"
		? faults.length > 0
		: faults.some((f) => f.kind === "no-warrant");
}

/**
 * One case over its runs. It is flagged by the majority of the runs that
 * replied, and its runs agree only where every one replied and all flag it
 * or none does.
 *
 * @param {Case} c
 * @param {Row[]} rows the case's runs, a fallen-back one included
 */
function scoreCase(c, rows) {
	const group = groupOf(c);
	const replies = rows.flatMap((r) => judgeRow(c.text, c.own, r) ?? []);
	const flags = replies.filter((j) => isFlagged(group, j)).length;
	return {
		id: c.id,
		label: c.label,
		kind: c.kind,
		group,
		runs: rows.length,
		ran: replies.length,
		flags,
		flagged: flags * 2 > replies.length,
		agree:
			replies.length === rows.length &&
			(flags === 0 || flags === replies.length),
		patterns: isPatternFlagged(group, c),
	};
}

/** @param {string} text */
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * One corpus body's two readings side by side, as the rows of the lists to
 * classify by hand.
 *
 * @param {{number: number, state: string}} issue
 * @param {string} body
 * @param {Judged} judged
 */
function compareReadings(issue, body, judged) {
	const patterns = patternWaits(body);
	const at = `| #${issue.number} | ${issue.state} |`;
	const patternBases = basisFaults(body, issue.number)
		.filter((f) => f.kind === "no-warrant")
		.map((f) => f.text);
	const isPatterns = (/** @type {string} */ w) =>
		patterns.some((p) => holdsOther(p, w));
	return {
		both: judged.waits.filter(isPatterns).length,
		modelOnly: judged.waits
			.filter((w) => !isPatterns(w))
			.map((w) => `${at} ${cell(w)} | |`),
		patternOnly: patterns
			.filter((p) => !judged.waits.some((w) => holdsOther(p, w)))
			.map((p) => `${at} ${cell(p)} | |`),
		basesFlagged: judged.model
			.filter((f) => f.kind === "no-warrant")
			.map(
				(f) =>
					`${at} ${judged.bases.find((b) => b.basis === f.text)?.class ?? "?"} | ${patternBases.includes(f.text) ? "yes" : "no"} | ${cell(f.text)} | |`,
			),
		bodyFlagged:
			judged.added.length > 0
				? [
						`${at} ${judged.added.map((f) => `${f.kind}: ${cell(f.text)}`).join("<br>")} | |`,
					]
				: [],
	};
}

/**
 * The Wilson 95% interval of `k` in `n`, as shares.
 * @param {number} k
 * @param {number} n
 * @returns {[number, number]}
 */
function wilson(k, n) {
	if (n === 0) return [0, 1];
	const z = 1.959_964;
	const p = k / n;
	const mid = p + (z * z) / (2 * n);
	const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	const denom = 1 + (z * z) / n;
	return [Math.max(0, (mid - half) / denom), Math.min(1, (mid + half) / denom)];
}

/**
 * @param {number[]} sorted ascending
 * @param {number} q
 */
const quantile = (sorted, q) =>
	sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

module.exports = {
	compareReadings,
	judgeRow,
	quantile,
	scoreCase,
	wilson,
};
