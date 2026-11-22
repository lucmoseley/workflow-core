const fs = require("node:fs");

const { cutAt } = require("./cut-at.js");

const AS_OF = "5 Sep 2026";

// guess, lucmoseley/mantahostels#3261
const WORTH_REPLAYING_PCT = 1;

/**
 * @typedef {{denies: number, population: number, pct: number,
 *   lowPct: number, highPct: number}} Rate
 */

// lucmoseley/mantahostels#3260
/** @type {Record<string, Rate>} */
const RATES = {
	"guard-issue-close": {
		denies: 255,
		population: 16_057,
		pct: 1.588,
		lowPct: 1.41,
		highPct: 1.79,
	},
	"guard-agent-poll": {
		denies: 881,
		population: 40_198,
		pct: 2.192,
		lowPct: 2.05,
		highPct: 2.34,
	},
	"guard-suite-concurrency": {
		denies: 736,
		population: 71_159,
		pct: 1.034,
		lowPct: 0.96,
		highPct: 1.11,
	},
	"guard-issue-create-label": {
		denies: 208,
		population: 16_057,
		pct: 1.295,
		lowPct: 1.13,
		highPct: 1.48,
	},
	"guard-issue-body": {
		denies: 16,
		population: 16_057,
		pct: 0.0996,
		lowPct: 0.06,
		highPct: 0.16,
	},
	"guard-issue-phase-scope": {
		denies: 9,
		population: 38_601,
		pct: 0.0233,
		lowPct: 0.01,
		highPct: 0.04,
	},
	"guard-self-match": {
		denies: 79,
		population: 291_734,
		pct: 0.0271,
		lowPct: 0.02,
		highPct: 0.03,
	},
	"guard-suite-background": {
		denies: 70,
		population: 291_734,
		pct: 0.024,
		lowPct: 0.02,
		highPct: 0.03,
	},
	"guard-echo-call": {
		denies: 69,
		population: 317_047,
		pct: 0.0218,
		lowPct: 0.02,
		highPct: 0.03,
	},
	"guard-root-scratch": {
		denies: 11,
		population: 291_734,
		pct: 0.0038,
		lowPct: 0,
		highPct: 0.01,
	},
	"guard-registry-atomicity": {
		denies: 3,
		population: 21_952,
		pct: 0.0137,
		lowPct: 0,
		highPct: 0.04,
	},
	"guard-commit-form": {
		denies: 1,
		population: 21_952,
		pct: 0.0046,
		lowPct: 0,
		highPct: 0.03,
	},
	"guard-pull-form": {
		denies: 0,
		population: 21_952,
		pct: 0,
		lowPct: 0,
		highPct: 0.02,
	},
	"guard-branch": {
		denies: 0,
		population: 21_952,
		pct: 0,
		lowPct: 0,
		highPct: 0.02,
	},
	"guard-sweep-fire": {
		denies: 0,
		population: 291_734,
		pct: 0,
		lowPct: 0,
		highPct: 0.001,
	},
};

/**
 * @param {string} guard
 * @returns {Rate | null}
 */
function forGuard(guard) {
	return readRateTable()[cutAt(String(guard), " ")[0]] ?? null;
}

/**
 * @returns {Record<string, Rate>}
 */
function readRateTable() {
	const file = process.env.WFC_DENY_RATES;
	return file ? JSON.parse(fs.readFileSync(file, "utf8")) : RATES;
}

/**
 * @param {string[]} lost
 * @returns {number | null}
 */
function summedPct(lost) {
	let sum = 0;
	for (const key of lost) {
		const rate = forGuard(key);
		if (rate === null) return null;
		sum += rate.pct;
	}
	return sum;
}

/**
 * @param {string[]} lost
 * @returns {boolean}
 */
function isWorthReplaying(lost) {
	const sum = summedPct(lost);
	return sum === null || sum >= WORTH_REPLAYING_PCT;
}

/**
 * @param {number} n
 * @returns {string}
 */
function pct(n) {
	if (n === 0) return "0%";
	if (n >= 1) return `${n.toFixed(3).replace(/\.?(?<!0)0+$/, "")}%`;
	return `${Number(n.toPrecision(3))}%`;
}

/**
 * @param {number} ratePct
 * @returns {string}
 */
function verdictAt(ratePct) {
	return ratePct >= WORTH_REPLAYING_PCT
		? `over the ${WORTH_REPLAYING_PCT}% cut, worth the replay`
		: `under the ${WORTH_REPLAYING_PCT}% cut, so a replay rarely pays`;
}

/**
 * @param {string} guard
 * @returns {string}
 */
function describe(guard) {
	const rate = forGuard(guard);
	if (rate === null)
		return `${guard}: deny rate UNKNOWN — no row in the ${AS_OF} census, so treat it as worth replaying.`;
	const band = `95% CI ${pct(rate.lowPct)}-${pct(rate.highPct)}`;
	const counts = `${rate.denies.toLocaleString("en-GB")} denial${rate.denies === 1 ? "" : "s"} in ${rate.population.toLocaleString("en-GB")} calls`;
	return `${guard}: denies ${pct(rate.pct)} of calls (${counts}; ${band}) — ${verdictAt(rate.pct)}.`;
}

/**
 * @param {string[]} lost
 * @returns {string | null}
 */
function describeTogether(lost) {
	const sum = summedPct(lost);
	if (sum === null) return null;
	return `Together: at most ${pct(sum)} of calls (the ${lost.length} rates summed) — ${verdictAt(sum)}.`;
}

const PROVENANCE = `Deny rates as of ${AS_OF}, counted whole-corpus and unbounded: every tool_use record matching each guard's own if-narrowing, not just the firings that printed something. https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md §Q2.`;

module.exports = {
	PROVENANCE,
	RATES,
	describe,
	describeTogether,
	isWorthReplaying,
};
