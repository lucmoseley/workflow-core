/*
 * guard-deny-rates.js — how often each deny-capable guard actually denies,
 * measured once and pinned here, so a report about a guard that failed open can
 * say whether the loss mattered.
 *
 * WHY IT EXISTS (mantahostels#3261, on the census at mantahostels#3260). `guard-lost-deny.js` blocks a
 * turn to say a guard failed open and prints the command that re-runs it. That
 * costs a second turn, and the rate is what tells a session whether to spend it.
 *
 * THE FIGURES ARE PINNED, NOT COMPUTED. Nothing on `main` recomputes them
 * (mantahostels#3263). Copy any change from a fresh census; never adjust a number by hand.
 * Bands are Wilson 95%. Source: `docs/data/lost-deny-census-2026-09-05/rates.md`
 * (the census's correct cut), over a corpus whose losses run 15 Aug – 5 Sep 2026.
 *
 * A GUARD WITH NO ROW IS UNKNOWN, NEVER ZERO. `guard-lost-deny.js` derives the
 * deny-capable set from each script's own source (`lib/deny-capable.js`), so a
 * guard added after the census joins that set with no edit anywhere — and this
 * table lags it by design. `guard-dispatch.js` is in that position:
 * deny-capable, no row. The census priced the issue-body, issue-close,
 * issue-create-label, issue-phase-scope, pull-form, registry-atomicity and
 * suite-concurrency guards as entries of their own, and those figures do
 * not price the dispatcher that now runs them as cores.
 *
 * NOTHING DETECTS STALENESS AUTOMATICALLY. The signal is the report itself: a
 * guard printed as "deny rate unknown" is a guard this table has not been
 * brought up to.
 */

const fs = require("node:fs");

const { cutAt } = require("./cut-at.js");

/** When the figures were measured — the end of the census's loss window. */
const AS_OF = "5 Sep 2026";

/*
 * Above this share of invocations a loss is worth a turn. A reading of one
 * census (mantahostels#3261), not a derived threshold — and the census's
 * guard-suite-concurrency entry cleared it at 1.034% on a band (0.96-1.11%)
 * that straddles it.
 */
const WORTH_REPLAYING_PCT = 1;

/**
 * One guard's measured deny rate.
 * @typedef {{denies: number, population: number, pct: number,
 *   lowPct: number, highPct: number}} Rate
 */

/** @type {Record<string, Rate>} */
const RATES = {};

/**
 * The measured rate for a guard, or null where it has none.
 *
 * The key arrives off a transcript record, and `guardKey` appends the arguments
 * that tell two registrations of one script apart — the file is the first word.
 *
 * @param {string} guard
 * @returns {Rate | null}
 */
function forGuard(guard) {
	return readRateTable()[cutAt(String(guard), " ")[0]] ?? null;
}

/**
 * The table a loss is priced from. `WFC_DENY_RATES` names a JSON file read in
 * place of `RATES`, so a test prices rows under and over the cut that no live
 * guard still carries (#3272). Pricing alone: `lost-deny-rates.js`'s staleness
 * audit reads `RATES` itself, since it judges the pinned table.
 * @returns {Record<string, Rate>}
 */
function readRateTable() {
	const file = process.env.WFC_DENY_RATES;
	return file ? JSON.parse(fs.readFileSync(file, "utf8")) : RATES;
}

/**
 * Whether a loss of this guard is worth the turn a replay costs. An unmeasured
 * guard reads as worth it: unknown is not zero.
 * @param {string} guard
 * @returns {boolean}
 */
function isWorthReplaying(guard) {
	const rate = forGuard(guard);
	return rate === null || rate.pct >= WORTH_REPLAYING_PCT;
}

/**
 * A percentage at the precision the figure actually carries — 2.192% and
 * 0.0046% both read wrongly at a fixed number of places.
 * @param {number} n
 * @returns {string}
 */
function pct(n) {
	if (n === 0) return "0%";
	if (n >= 1) return `${n.toFixed(3).replace(/\.?0+$/, "")}%`;
	/* Three significant figures below 1%, which keeps 0.0046% distinguishable
	 * from 0.0038% without printing noise digits on 0.0996%. */
	return `${Number(n.toPrecision(3))}%`;
}

/**
 * One line saying how often this guard denies, and so whether the loss is worth
 * a turn.
 * @param {string} guard
 * @returns {string}
 */
function describe(guard) {
	const rate = forGuard(guard);
	if (rate === null)
		return `${guard}: deny rate UNKNOWN — no row in the ${AS_OF} census, so treat it as worth replaying.`;
	const band = `95% CI ${pct(rate.lowPct)}-${pct(rate.highPct)}`;
	const counts = `${rate.denies.toLocaleString("en-GB")} denial${rate.denies === 1 ? "" : "s"} in ${rate.population.toLocaleString("en-GB")} calls`;
	/* Stated against the cut rather than in words: a big numerator beside "almost
	 * never mattered" reads as a contradiction to anyone who has not seen the
	 * denominator. */
	const verdict =
		rate.pct >= WORTH_REPLAYING_PCT
			? `over the ${WORTH_REPLAYING_PCT}% cut, worth the replay`
			: `under the ${WORTH_REPLAYING_PCT}% cut, so a replay rarely pays`;
	return `${guard}: denies ${pct(rate.pct)} of calls (${counts}; ${band}) — ${verdict}.`;
}

/**
 * The one line that dates the figures and says what they were priced against.
 * The date is the census's loss-window END, which is as close as it comes to
 * recording when it ran; the counts themselves are whole-corpus and unbounded,
 * so the window is not their window.
 */
const PROVENANCE = `Deny rates as of ${AS_OF}, counted whole-corpus and unbounded: every tool_use record matching each guard's own if-narrowing, not just the firings that printed something. https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md §Q2.`;

module.exports = { PROVENANCE, RATES, describe, isWorthReplaying };
