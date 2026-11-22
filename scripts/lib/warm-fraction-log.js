const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { MARKERS_REL } = require("./marker-root.js");
const nodePath = require("node:path");
const { caught, orFallback } = require("./caught.js");

/**
 * @typedef {{frontier: number, warm: number, cold: number, at?: string|null,
 *   provisional?: number, degraded?: number, session?: string|null,
 *   puts?: number, putsSinceLastRun?: number, unrevalidatedWarm?: number,
 *   warmNumbers?: (number|null)[],
 *   coldNumbers?: ({n?: number|null, state?: string}|null)[],
 *   provisionalNumbers?: (number|null)[],
 *   causes?: Record<string, number>}} Run
 */

const LOG_SUBPATH = nodePath.join(
	MARKERS_REL,
	".pick-next",
	"warm-fraction.jsonl",
);

/** @param {string} root */
const logPath = (root) => nodePath.join(root, LOG_SUBPATH);

// lucmoseley/mantahostels#628
const MIN_RUNS = 10;

const CAUSES = ["never", "body-changed", "path-gone", "unknown"];

/** @param {unknown} state */
const causeOf = (state) => {
	if (state === "cold") return "never";
	return typeof state === "string" &&
		CAUSES.includes(state) &&
		state !== "unknown"
		? state
		: "unknown";
};

/**
 * @param {({state?: unknown}|null)[]|null|undefined} cold
 * @returns {Record<string, number>}
 */
function tallyCauses(cold) {
	const seen = (cold ?? []).map((c) => causeOf(c?.state));
	return Object.fromEntries(
		CAUSES.map((c) => [c, seen.filter((s) => s === c).length]),
	);
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
const isCount = (v) => Number.isFinite(v) && Number(v) >= 0;

/**
 * @param {string} root
 * @param {{frontier?: unknown, warm?: any[], provisional?: any[],
 *   cold?: any[], degraded?: unknown, session?: string|null,
 *   puts?: unknown}} run
 */
function appendRun(
	root,
	{ frontier, warm, provisional, cold, degraded, session, puts },
) {
	try {
		const warmList = Array.from(warm ?? []);
		const provisionalList = Array.from(provisional ?? []);
		const coldList = Array.from(cold ?? []);
		const record = {
			at: new Date().toISOString(),
			frontier: Number(frontier ?? 0),
			warm: warmList.length,
			cold: coldList.length,
			causes: tallyCauses(coldList),
			unrevalidatedWarm: warmList.filter((w) => w?.unrevalidated).length,
			provisional: provisionalList.length,
			warmNumbers: warmList.map((w) => Number(w?.number)),
			provisionalNumbers: provisionalList.map((p) => Number(p?.number)),
			coldNumbers: coldList.map((c) => ({
				n: Number(c?.number),
				state: causeOf(c?.state),
			})),
			degraded: Number(degraded ?? 0),
			session: session ?? null,
			putsSinceLastRun: isCount(puts) ? Number(puts) : null,
		};
		fs.mkdirSync(nodePath.dirname(logPath(root)), { recursive: true });
		fs.appendFileSync(logPath(root), `${JSON.stringify(record)}\n`);
		return { ok: true, path: logPath(root), record };
	} catch (e) {
		return { ok: false, error: String(caught(e).message || e) };
	}
}

/**
 * @param {string} root
 * @returns {{runs: Run[], malformed: number}}
 */
function readRuns(root) {
	const read = orFallback(() => readJsonl(logPath(root)), null);
	if (!read) return { runs: [], malformed: 0 };
	const runs = /** @type {Run[]} */ (
		read.rows.filter(
			(rec) => isCount(rec.frontier) && isCount(rec.warm) && isCount(rec.cold),
		)
	);
	const malformed = read.rows.length - runs.length + read.bad.length;
	return { runs, malformed };
}

/**
 * @param {string} root
 * @returns {string|null|undefined}
 */
function readLastRunAt(root) {
	/** @type {{t: number, at: string|null|undefined}|null} */
	let newest = null;
	for (const r of readRuns(root).runs) {
		const t = Date.parse(r?.at ?? "");
		if (Number.isFinite(t) && (newest === null || t > newest.t))
			newest = { t, at: r.at };
	}
	return newest ? newest.at : null;
}

// lucmoseley/mantahostels#650 guess
const DUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * @template T
 * @param {T[]|null|undefined} xs
 * @param {(x: T) => string|null} pick
 * @returns {string[]|null}
 */
const keyParts = (xs, pick) => {
	/** @type {string[]} */
	const parts = [];
	for (const x of xs ?? []) {
		const part = pick(x);
		if (part === null) return null;
		parts.push(part);
	}
	return parts.sort();
};

/**
 * @param {Run|null|undefined} r
 * @returns {string|null}
 */
function dupKey(r) {
	/** @param {unknown} n */
	const num = (n) => (Number.isFinite(Number(n)) ? String(Number(n)) : null);
	const warm = keyParts(r?.warmNumbers, num);
	const cold = keyParts(r?.coldNumbers, (c) =>
		num(c?.n) === null ? null : `${num(c?.n)}:${causeOf(c?.state)}`,
	);
	const prov = keyParts(r?.provisionalNumbers ?? [], num);
	if (warm === null || cold === null || prov === null) return null;
	if (warm.length === 0 && cold.length === 0 && prov.length === 0) return null;
	return `${warm.join(",")}|${prov.join(",")}|${cold.join(",")}`;
}

/**
 * @param {Run|null|undefined} r
 * @returns {number|null}
 */
const timeOf = (r) => {
	const t = Date.parse(r?.at ?? "");
	return Number.isFinite(t) ? t : null;
};

/**
 * @param {string|null} dup
 * @param {string|null|undefined} anchor
 * @returns {"unknownSession"|"sameSession"|"crossSession"}
 */
const attribute = (dup, anchor) => {
	if (dup == null || anchor == null) return "unknownSession";
	return dup === anchor ? "sameSession" : "crossSession";
};

/** @param {Run[]|null|undefined} runs */
function collapseDuplicates(runs) {
	const all = runs ?? [];
	const judged = all
		.flatMap((r, i) => {
			const key = dupKey(r);
			const at = timeOf(r);
			return key !== null && at !== null ? [{ r, i, key, at }] : [];
		})
		.sort((a, b) => a.at - b.at || a.i - b.i);
	/** @type {Map<string, DupAnchor>} */
	const anchors = new Map();
	/** @type {Set<number>} */
	const dropped = new Set();
	/** @type {Collapsed} */
	const collapsed = {
		total: 0,
		sameSession: 0,
		crossSession: 0,
		unknownSession: 0,
		quiet: 0,
		putsUnknown: 0,
		keptOnPuts: 0,
		keptOnPutsCrossSession: 0,
	};
	for (const x of judged) dropOrAnchor(x, anchors, dropped, collapsed);
	return { runs: all.filter((_, i) => !dropped.has(i)), collapsed };
}

/**
 * @typedef {{r: Run, i: number, key: string, at: number}} JudgedRun
 * @typedef {{at: number, session: string|null|undefined}} DupAnchor
 * @typedef {{total: number, sameSession: number, crossSession: number,
 *   unknownSession: number, quiet: number, putsUnknown: number,
 *   keptOnPuts: number, keptOnPutsCrossSession: number}} Collapsed
 */

/**
 * @param {JudgedRun} x
 * @param {Map<string, DupAnchor>} anchors
 * @param {Set<number>} dropped
 * @param {Collapsed} collapsed
 */
function dropOrAnchor(x, anchors, dropped, collapsed) {
	const anchor = anchors.get(x.key);
	const inWindow = anchor !== undefined && x.at - anchor.at <= DUP_WINDOW_MS;
	const raw = x.r?.putsSinceLastRun ?? x.r?.puts;
	const puts = isCount(raw) ? Number(raw) : null;
	const storedInGap = puts !== null && puts > 0;
	if (inWindow && !storedInGap) {
		dropped.add(x.i);
		collapsed.total += 1;
		collapsed[attribute(x.r.session ?? null, anchor.session)] += 1;
		collapsed[puts === 0 ? "quiet" : "putsUnknown"] += 1;
		return;
	}
	if (inWindow) {
		collapsed.keptOnPuts += 1;
		if (attribute(x.r.session ?? null, anchor.session) === "crossSession")
			collapsed.keptOnPutsCrossSession += 1;
	}
	anchors.set(x.key, { at: x.at, session: x.r.session ?? null });
}

/**
 * @param {Run|null|undefined} r
 * @returns {r is Run}
 */
const hasFrontier = (r) => Boolean(r) && isCount(r?.frontier) && r.frontier > 0;

/** @param {Run[]|null|undefined} runs */
function partition(runs) {
	const { runs: distinct, collapsed } = collapseDuplicates(runs);
	return { distinct, usable: distinct.filter(hasFrontier), collapsed };
}

/** @param {number[]} xs */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** @param {number[]} fractions */
function bandOf(fractions) {
	const m = fractions.length > 0 ? mean(fractions) : null;
	const sd =
		fractions.length > 1 && m !== null
			? Math.sqrt(
					fractions.reduce((a, f) => a + (f - m) ** 2, 0) /
						(fractions.length - 1),
				)
			: null;
	return {
		mean: m,
		sd,
		ci95:
			sd === null
				? null
				: (critical(fractions.length - 1) * sd) / Math.sqrt(fractions.length),
	};
}

/** @type {Record<number, number>} */
const T_95 = {
	1: 12.706,
	2: 4.303,
	3: 3.182,
	4: 2.776,
	5: 2.571,
	6: 2.447,
	7: 2.365,
	8: 2.306,
	9: 2.262,
	10: 2.228,
	11: 2.201,
	12: 2.179,
	13: 2.16,
	14: 2.145,
	15: 2.131,
	16: 2.12,
	17: 2.11,
	18: 2.101,
	19: 2.093,
	20: 2.086,
	21: 2.08,
	22: 2.074,
	23: 2.069,
	24: 2.064,
	25: 2.06,
	26: 2.056,
	27: 2.052,
	28: 2.048,
	29: 2.045,
	30: 2.042,
};
/** @param {number} df */
const critical = (df) => T_95[df] ?? 1.96;

/** @param {Run[]|null|undefined} runs */
function summarise(runs) {
	const { usable, collapsed } = partition(runs);
	const window = windowOf(usable);
	/** @type {[string, number][]} */
	const causeTotals = CAUSES.map((c) => [
		c,
		usable.reduce((sum, r) => sum + Number(r.causes?.[c] ?? 0), 0),
	]);
	/** @type {Record<string, number>} */
	const causes = Object.fromEntries(causeTotals);
	const coldTotal = usable.reduce((a, r) => a + r.cold, 0);
	const coldDistinctTickets = new Set(
		usable.flatMap((r) =>
			(r.coldNumbers ?? [])
				.map((c) => c?.n)
				.filter((n) => typeof n === "number" && Number.isFinite(n)),
		),
	).size;
	const frontierTotal = usable.reduce((a, r) => a + r.frontier, 0);
	const warmTotal = usable.reduce((a, r) => a + r.warm, 0);
	const provisionalTotal = usable.reduce(
		(a, r) => a + Number(r.provisional ?? 0),
		0,
	);
	const fractions = usable.map((r) => r.warm / r.frontier);
	const { mean: m, sd, ci95 } = bandOf(fractions);
	const coveredFractions = usable.map(
		(r) => (r.warm + Number(r.provisional ?? 0)) / r.frontier,
	);
	const coveredBand = bandOf(coveredFractions);
	return {
		totalRuns: (runs ?? []).length,
		usableRuns: usable.length,
		collapsedRuns: collapsed.total,
		collapsedSameSession: collapsed.sameSession,
		collapsedCrossSession: collapsed.crossSession,
		collapsedUnknownSession: collapsed.unknownSession,
		collapsedQuiet: collapsed.quiet,
		collapsedPutsUnknown: collapsed.putsUnknown,
		runsKeptOnPuts: collapsed.keptOnPuts,
		runsKeptOnPutsCrossSession: collapsed.keptOnPutsCrossSession,
		degradedRuns: usable.filter((r) => Number(r.degraded ?? 0) > 0).length,
		frontierTotal,
		warmTotal,
		coldTotal,
		coldDistinctTickets,
		provisionalTotal,
		runsWithProvisional: usable.filter((r) => Number(r.provisional ?? 0) > 0)
			.length,
		pooled: frontierTotal ? warmTotal / frontierTotal : null,
		pooledCovered: frontierTotal
			? (warmTotal + provisionalTotal) / frontierTotal
			: null,
		mean: m,
		sd,
		ci95,
		coveredMean: coveredBand.mean,
		coveredSd: coveredBand.sd,
		coveredCi95: coveredBand.ci95,
		unrevalidatedWarmTotal: usable.reduce(
			(a, r) => a + Number(r.unrevalidatedWarm ?? 0),
			0,
		),
		min: fractions.length > 0 ? Math.min(...fractions) : null,
		max: fractions.length > 0 ? Math.max(...fractions) : null,
		causes,
		causeShare: Object.fromEntries(
			causeTotals.map(([c, n]) => [c, coldTotal ? n / coldTotal : null]),
		),
		enough: usable.length >= MIN_RUNS,
		first: window.first,
		last: window.last,
		windowMs: window.ms,
	};
}

/**
 * @param {Run[]|null|undefined} usable
 */
function windowOf(usable) {
	const ts = (usable ?? [])
		.map((r) => Date.parse(r?.at ?? ""))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	const first = ts[0];
	const last = ts.at(-1);
	if (first === undefined || last === undefined)
		return { first: null, last: null, ms: null };
	/** @param {number} t */
	const iso = (t) => new Date(t).toISOString();
	return { first: iso(first), last: iso(last), ms: last - first };
}

/**
 * @typedef {ReturnType<typeof summarise>} Summary
 * @typedef {{state: "provisional"}
 *   | {state: "refuted"|"confirmed"|"inconclusive", side: "below"|"above"|null,
 *      point: number, low: number, high: number}} Verdict
 * @typedef {{state: "provisional", runs: number, need: number}
 *   | {state: "measured", runs: number, need: number, point: number}} CoveredVerdict
 * @typedef {{state: "provisional", runs: number, need: number}
 *   | {state: "refuted"|"inconclusive", point: number, low: number,
 *      high: number}} BoundVerdict
 */

// lucmoseley/mantahostels#1054
const MIN_PROVISIONAL_RUNS = 10;

/** @param {Run|null|undefined} r */
const isPostPrewarming = (r) => !!r && "provisional" in r;

/**
 * @param {Run[]} runs
 * @returns {{splitAt: null, undated: number, before: Summary, after: null}
 *   | {splitAt: string, undated: number, before: Summary, after: Summary}}
 */
function splitAtProvisional(runs) {
	const { distinct } = partition(runs);
	const dated = distinct.flatMap((r, i) => {
		const at = timeOf(r);
		return at === null ? [] : [{ r, i, at }];
	});
	const undated = distinct.length - dated.length;
	const ordered = dated
		.sort((a, b) => a.at - b.at || a.i - b.i)
		.map((x) => x.r);
	const at = ordered.findIndex(isPostPrewarming);
	const split = ordered[at];
	if (split === undefined)
		return { splitAt: null, undated, before: summarise(ordered), after: null };
	return {
		splitAt: /** @type {string} */ (split.at),
		undated,
		before: summarise(ordered.slice(0, at)),
		after: summarise(ordered.slice(at)),
	};
}

/**
 * @param {Summary|null|undefined} s
 * @returns {CoveredVerdict}
 */
function coveredVerdictOn(s) {
	const runs = Number(s?.runsWithProvisional ?? 0);
	const need = MIN_PROVISIONAL_RUNS;
	if (
		s?.pooledCovered === null ||
		s?.pooledCovered === undefined ||
		runs < need
	)
		return { state: "provisional", runs, need };
	return { state: "measured", runs, need, point: s.pooledCovered };
}

const CLAIM = { low: 0.6, high: 0.8, source: "mantahostels#385" };

/**
 * @param {Summary|null|undefined} s
 * @returns {Verdict}
 */
function verdictOn(s) {
	if (!s?.enough || s.pooled === null) return { state: "provisional" };
	const half = s.ci95 ?? 0;
	const low = s.pooled - half;
	const high = s.pooled + half;
	const point = s.pooled;
	if (high < CLAIM.low)
		return { state: "refuted", side: "below", point, low, high };
	if (low > CLAIM.high)
		return { state: "refuted", side: "above", point, low, high };
	if (low >= CLAIM.low && high <= CLAIM.high)
		return { state: "confirmed", side: null, point, low, high };
	return { state: "inconclusive", side: null, point, low, high };
}

/**
 * @param {Summary|null|undefined} s
 * @returns {BoundVerdict}
 */
function boundVerdictOn(s) {
	const cv = coveredVerdictOn(s);
	if (cv.state !== "measured")
		return { state: "provisional", runs: cv.runs, need: cv.need };
	const half = s?.coveredCi95 ?? 0;
	const low = cv.point - half;
	const high = cv.point + half;
	if (high < CLAIM.low) return { state: "refuted", point: cv.point, low, high };
	return { state: "inconclusive", point: cv.point, low, high };
}

module.exports = {
	CLAIM,
	verdictOn,
	coveredVerdictOn,
	boundVerdictOn,
	splitAtProvisional,
	LOG_SUBPATH,
	MIN_RUNS,
	MIN_PROVISIONAL_RUNS,
	DUP_WINDOW_MS,
	partition,
	logPath,
	appendRun,
	readRuns,
	readLastRunAt,
	summarise,
};
