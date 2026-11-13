/*
 * dispatch-compliance.js — does a subagent dispatch prompt tell the agent to
 * write its artefact incrementally? (mantahostels#766)
 *
 * `docs/agents/guard-registry.md` §Subagent dispatch clause 1 — "a subagent prompt names an
 * artefact path the agent writes incrementally" — was left UNENFORCED at mantahostels#689,
 * on the strength of compliance jumping 15% -> 95% the day the rule landed.
 * mantahostels#689 could not tell a stable rate from novelty, so mantahostels#766 re-measures.
 *
 * REPORTS ONLY. Nothing here throws on a malformed transcript row: the corpus
 * is thousands of files written by live sessions, and one half-written line
 * must not void a run.
 */

const { parseJsonlRow } = require("./jsonl.js");

/* The four phrases mantahostels#689 counted. Kept verbatim: changing the needle changes
 * what the figure means, and the 8.6% / 15% / 95% reference points were all
 * measured with exactly these. */
const COMPLIANCE_RE = /incrementally|as you go|as they land|append each/i;

/* Below this share, mantahostels#766 reopens enforcement as mantahostels#689's option (C) — a literal
 * `Artefact: <path>` line and a PreToolUse hook denying its absence. At or
 * above it, the rule holds unenforced. Set by mantahostels#766, not measured. */
const HOLD_THRESHOLD = 0.8;

/* The two spellings of the dispatch tool across the corpus's lifetime. */
const DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/**
 * Does this prompt instruct incremental writing?
 * @param {unknown} prompt
 */
function isCompliant(prompt) {
	if (typeof prompt !== "string") return false;
	return COMPLIANCE_RE.test(prompt);
}

/**
 * Pull every dispatch out of raw JSONL rows.
 *
 * Deduplicated by `tool_use` id: a resumed session can replay earlier rows into
 * a new transcript file. As of 22 Aug 2026 it removes nothing — 2,535 blocks,
 * 2,535 distinct ids — so it is insurance against a format that starts
 * duplicating, not a correction being applied today.
 *
 * @param {Iterable<string>} lines raw JSONL rows, from any number of files
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
 * Each row of `lines` carrying message content, with that content.
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
 * Parse a timestamp to epoch ms, or null where it is unreadable.
 * @param {unknown} value
 * @returns {number|null}
 */
function toMs(value) {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * A dispatch whose timestamp will not parse is dropped whenever a window is
 * set — it cannot be placed on either side of the boundary, and counting it
 * would silently widen the window. With no window it is counted, there being
 * nothing to place it against.
 *
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
 * Compliance over a half-open window [since, until).
 *
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
 * Per-UTC-day breakdown, filtered by the SAME predicate as `summarise`, so the
 * days always sum to the headline. They did not when this filtered on a
 * 10-character date prefix and `summarise` on `Date.parse`: a `since` carrying
 * a time component put the two out of step silently.
 *
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
 * Yield every line of the corpus, one file's contents in memory at a time.
 *
 * The corpus is ~2 GB across ~1,950 transcripts against the 4 GB heap cap
 * `~/.bashrc` sets, so reading it all into one array is a machine-freeze risk
 * that grows every day (CLAUDE.md §Machine limits). `extractDispatches` takes
 * any iterable, so it consumes this directly.
 *
 * @param {string[]} names file names to read, in order
 * @param {(name: string) => string} read returns one file's contents
 * @param {{unreadable: number}} [stats] accumulator: counts files that could not be read
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
 * mantahostels#766's decision rule.
 *
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
