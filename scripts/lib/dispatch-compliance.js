const { parseJsonlRow } = require("./jsonl.js");

const COMPLIANCE_RE = /incrementally|as you go|as they land|append each/i;

// guess, lucmoseley/mantahostels#766
const HOLD_THRESHOLD = 0.8;

const DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/** @param {unknown} prompt */
function isCompliant(prompt) {
	if (typeof prompt !== "string") return false;
	return COMPLIANCE_RE.test(prompt);
}

/**
 * @param {Iterable<string>} lines
 * @returns {{id: string, timestamp: string, prompt: string}[]}
 */
function extractDispatches(lines) {
	const seen = new Set();
	const out = [];
	for (const { row, content } of messageRows(lines)) {
		for (const block of content) {
			if (!isDispatch(block)) continue;
			const id = block.id;
			if (id && seen.has(id)) continue;
			if (id) seen.add(id);
			out.push({
				id,
				timestamp: row.timestamp,
				prompt: block?.input?.prompt,
			});
		}
	}
	return out;
}

/**
 * @param {Iterable<string>} lines
 * @returns {Generator<{ row: { timestamp: string }, content: any[] }>}
 */
function* messageRows(lines) {
	for (const line of lines) {
		const row =
			/** @type {{ timestamp: string, message?: { content?: unknown } } | null | undefined} */ (
				parseJsonlRow(line)
			);
		const content = row?.message?.content;
		if (row && Array.isArray(content)) yield { row, content };
	}
}

/**
 * @param {{ type?: string, name?: string } | null | undefined} block
 * @returns {boolean}
 */
function isDispatch(block) {
	return block?.type === "tool_use" && DISPATCH_TOOLS.has(block.name ?? "");
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toMs(value) {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {{timestamp: string}} dispatch
 * @param {{since?: string, until?: string}} [window]
 * @returns {boolean}
 */
function inWindow(dispatch, window = {}) {
	const since = toMs(window.since);
	const until = toMs(window.until);
	if (since === null && until === null) return true;

	const ms = toMs(dispatch.timestamp);
	if (ms === null) return false;
	if (since !== null && ms < since) return false;
	if (until !== null && ms >= until) return false;
	return true;
}

/**
 * @param {{timestamp: string, prompt: string}[]} dispatches
 * @param {{since?: string, until?: string}} [window]
 * @returns {{total: number, compliant: number, rate: number|null}}
 */
function summarise(dispatches, window = {}) {
	let total = 0;
	let compliant = 0;
	for (const d of dispatches) {
		if (!inWindow(d, window)) continue;
		total += 1;
		if (isCompliant(d.prompt)) compliant += 1;
	}
	return { total, compliant, rate: total === 0 ? null : compliant / total };
}

/**
 * @param {{timestamp: string, prompt: string}[]} dispatches
 * @param {{since?: string, until?: string}} [window]
 * @returns {{day: string, total: number, compliant: number, rate: number|null}[]}
 */
function groupByDay(dispatches, window = {}) {
	const byDay = new Map();
	for (const d of dispatches) {
		if (!inWindow(d, window)) continue;
		if (typeof d.timestamp !== "string") continue;
		const day = d.timestamp.slice(0, 10);
		if (!byDay.has(day)) byDay.set(day, []);
		byDay.get(day).push(d);
	}
	return [...byDay.keys()]
		.sort()
		.map((day) => ({ day, ...summarise(byDay.get(day)) }));
}

/**
 * @param {string[]} names
 * @param {(name: string) => string} read
 * @param {{unreadable: number}} [stats]
 */
function* readCorpusLines(names, read, stats = { unreadable: 0 }) {
	for (const name of names) {
		let text;
		try {
			text = read(name);
		} catch {
			stats.unreadable += 1;
			continue;
		}
		for (const line of text.split("\n")) yield line;
	}
}

/**
 * @param {number|null} rate
 * @returns {{hold: boolean|null, threshold: number}}
 */
function verdict(rate) {
	if (typeof rate !== "number" || Number.isNaN(rate)) {
		return { hold: null, threshold: HOLD_THRESHOLD };
	}
	return { hold: rate >= HOLD_THRESHOLD, threshold: HOLD_THRESHOLD };
}

module.exports = {
	HOLD_THRESHOLD,
	extractDispatches,
	groupByDay,
	readCorpusLines,
	summarise,
	verdict,
};
