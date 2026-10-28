/*
 * warm-fraction-log.js — records how much of each real selection run's frontier
 * the write-set cache already held, so the warm fraction can be measured (mantahostels#628).
 *
 * mantahostels#385's headline — a 60-80% cut in a re-pick's dominant cost — is mantahostels#611's
 * per-ticket saving times the WARM FRACTION of the frontier, and the warm
 * fraction is a property of churn, not of the cache: the key is the issue body,
 * so every body edit drops a ticket back to cold. No one run can see it, so this
 * appends a line per run and computes nothing at the time.
 *
 * `warm` MEANS BAND-READ WARM AND NOTHING ELSE (mantahostels#1001). Since selection began
 * pre-warming its own misses with a grep prediction, most of the frontier is
 * covered by an entry no agent judged; folding those in would drive every line
 * towards 100% and make mantahostels#385's claim untestable. They are counted separately,
 * as `provisional`, and the two sum to the frontier the band read can skip —
 * `pooledCovered` below.
 *
 * ONLY A RUN SOMEONE ACTUALLY MADE BELONGS HERE. `pick-next.js` appends once per
 * run it serves and nothing else writes: a band read re-run to produce a number
 * would measure the harness rather than the churn (mantahostels#628).
 *
 * NOTHING HERE THROWS: a selection run must never fail to protect a measurement.
 * A malformed line is counted and skipped, never repaired.
 */

const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { MARKERS_REL } = require("./marker-root.js");
const nodePath = require("node:path");
const { caught } = require("./caught.js");

/**
 * One line of the log. `readRuns` refuses a record missing any of the three
 * counts, so those are required here and everything else is optional — a line
 * written before a field existed simply lacks it.
 *
 * @typedef {{frontier: number, warm: number, cold: number, at?: string|null,
 *   provisional?: number, degraded?: number, session?: string|null,
 *   puts?: number, putsSinceLastRun?: number, unrevalidatedWarm?: number,
 *   warmNumbers?: (number|null)[],
 *   coldNumbers?: ({n?: number|null, state?: string}|null)[],
 *   provisionalNumbers?: (number|null)[],
 *   causes?: Record<string, number>}} Run
 */

/** Beside the write-set cache, under the same `.claude/tmp/markers/.pick-next/`. */
const LOG_SUBPATH = nodePath.join(
	MARKERS_REL,
	".pick-next",
	"warm-fraction.jsonl",
);

/** @param {string} root */
const logPath = (root) => nodePath.join(root, LOG_SUBPATH);

/**
 * Ten runs before a verdict. mantahostels#628 asks for "at least 10 real re-picks", and
 * under that the band is wider than the 60-80% claim it is meant to test.
 */
const MIN_RUNS = 10;

const CAUSES = ["never", "body-changed", "path-gone", "unknown"];

/*
 * `lookup()` calls a never-derived entry `cold`, which reads as the opposite of
 * warm rather than as one of the reasons for it.
 */
/** @param {unknown} state */
const causeOf = (state) => {
	if (state === "cold") return "never";
	return typeof state === "string" &&
		CAUSES.includes(state) &&
		state !== "unknown"
		? state
		: "unknown";
};

/** Cold entries counted by cause, every key present so a zero is recorded too. */
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
 * Appends one run. `warm` and `cold` are `lookupAll()`'s two lists, so the
 * caller passes what it already has rather than pre-counting.
 *
 * THE ISSUE NUMBERS ARE STORED, not only the counts. Counts alone cannot tell a
 * re-pick over a stable backlog from a first pick over a fresh one, which is the
 * distinction mantahostels#628 asks for, and the log cannot be re-run.
 *
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
			// git could not list the tree, so these hits skipped the rename check.
			// A stretch of them inflates the warm fraction with unchecked entries.
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
			// A count that could not be taken stays null: it is not a run that
			// nothing was stored before (mantahostels#667).
			putsSinceLastRun: isCount(puts) ? Number(puts) : null,
		};
		fs.mkdirSync(nodePath.dirname(logPath(root)), { recursive: true });
		// Appended, never rewritten: a parallel picker appending its own line
		// must not lose this one, and a single short line is written atomically.
		fs.appendFileSync(logPath(root), `${JSON.stringify(record)}\n`);
		return { ok: true, path: logPath(root), record };
	} catch (e) {
		return { ok: false, error: String(caught(e).message || e) };
	}
}

/** Every recorded run, oldest first, plus how many lines could not be read. */
/**
 * @param {string} root
 * @returns {{runs: Run[], malformed: number}}
 */
function readRuns(root) {
	let read = null;
	try {
		read = readJsonl(logPath(root));
	} catch {
		/* An unreadable log is none: the reading never fails pick-next's run. */
	}
	// No log yet is the normal state before the first run, not a fault.
	if (!read) return { runs: [], malformed: 0 };
	// A missing count is not a zero. Defaulting one would pull the pooled
	// fraction towards whatever the gap happened to be.
	const runs = /** @type {Run[]} */ (
		read.rows.filter(
			(rec) => isCount(rec.frontier) && isCount(rec.warm) && isCount(rec.cold),
		)
	);
	const malformed = read.rows.length - runs.length + read.bad.length;
	return { runs, malformed };
}

/**
 * When the most recent run was recorded, or `null` before the first — the
 * instant a caller counts puts since. The NEWEST timestamp, not the last line:
 * parallel pickers append out of order, and the last line written can predate
 * one already there.
 *
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

/*
 * A duplicate is a second record of ONE observation, not a second observation.
 * Two ways the log gets them (mantahostels#650): a run re-run for `--json`, and 10-12
 * parallel pickers over the same unchanged backlog. Both double-weight a
 * run in `pooled` and push `usableRuns` towards the 10-run verdict floor
 * without adding an observation, and the 95% band assumes independence.
 *
 * The key is the frontier ITSELF, never the session: a second re-pick usually
 * has moved, because the first run `put` the bands it derived, so tickets have
 * crossed from cold to warm. A cross-session near-duplicate is collapsed on the
 * same test and reported separately — a backlog nobody has touched says the
 * same thing about churn whoever asked it. What that gives up: two sessions
 * disagreeing about the warmth of one frontier are the only pair that could
 * show the cache answering differently to different callers, and the collapse
 * keeps one.
 *
 * A record carrying a `putsSinceLastRun` above zero had entries stored between
 * it and the run it matches, so a session was deriving bands in the gap and this
 * is a second observation, not a second record of one (mantahostels#667). It is kept, and
 * anchors the next window itself. A NULL COUNT COLLAPSES: a line predating the
 * count in either spelling cannot answer, and so does a count that failed to be
 * taken, which `collapsedPutsUnknown` is how many of.
 *
 * WHAT IS STILL WRONG, AND WHICH WAY: where nothing at all was put — no tie
 * band, an abandoned band read, a frontier already fully warm — a genuine
 * re-pick and a re-run for `--json` are identical in the log, and the collapse
 * still drops the second. That case is likelier the warmer the frontier, so it
 * biases `pooled` DOWNWARDS. `collapsedQuiet` is how many collapses sat on that
 * ambiguity, and it is a FLOOR: a put whose entry has since been pruned leaves a
 * run recording zero.
 *
 * AND IT TRADES A NEW BIAS THE OTHER WAY: any session's band read counts, so a
 * neighbour deriving anywhere in the repo keeps a pair of parallel pickers over
 * one backlog that mantahostels#650 would have collapsed, which pushes `pooled` UP.
 * `keptOnPutsCrossSession` counts exactly that population. mantahostels#680 ruled the put
 * need NOT touch the frontier; a non-zero reading of that counter reopens it.
 *
 * Ten minutes is a judgement, not a measurement (mantahostels#650): comfortably over a run
 * plus the gap before its `--json` repeat, and under any interval in which the
 * backlog plausibly sits untouched by chance. Inclusive at the boundary, so
 * exactly ten minutes collapses.
 */
const DUP_WINDOW_MS = 10 * 60 * 1000;

/** `null` where any entry is unreadable: a shrunken key would match a shorter run. */
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
 * What makes two records the same observation, or `null` where the record
 * cannot answer.
 *
 * THE LISTS ARE KEYED BY MEMBERSHIP, never merged and never by size: the same
 * tickets with two of them warm rather than cold, or cold for a new reason, is
 * the churn this measures, and a coarser key would read those two runs as one.
 * Counts alone never suffice either — they cannot tell a re-pick over a stable
 * backlog from a first pick over a fresh one — so a line carrying no issue
 * numbers is never judged a duplicate.
 *
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
	/*
	 * A line written before pre-warming existed carries no list, which is an
	 * EMPTY one rather than an unreadable one: no run before mantahostels#1001 had a
	 * provisional ticket, so treating the absence as `null` would make every
	 * historical line unjudgeable and un-collapse the whole log.
	 */
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

/** Which session a collapse is attributed to, `unknown` where either is absent. */
/**
 * @param {string|null} dup
 * @param {string|null|undefined} anchor
 * @returns {"unknownSession"|"sameSession"|"crossSession"}
 */
const attribute = (dup, anchor) => {
	if (dup == null || anchor == null) return "unknownSession";
	return dup === anchor ? "sameSession" : "crossSession";
};

/**
 * The runs with their duplicates dropped, in the order given, and how many went
 * — split by whether the duplicate came from the same session, a parallel one,
 * or a record naming no session at all.
 *
 * JUDGED IN TIME ORDER, RETURNED IN FILE ORDER. Parallel appenders can land out
 * of order, and which record a window is measured from would otherwise depend
 * on who wrote first — moving `usableRuns`, and so when a verdict is issued.
 * The window runs from the record KEPT, never the last one seen, so a long
 * stream of identical runs collapses in windows rather than chaining into one.
 *
 * @param {Run[]|null|undefined} runs
 */
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
		// Split by what the collapse rested on: a count of zero, or a line
		// predating the count and so unable to say (mantahostels#667).
		quiet: 0,
		putsUnknown: 0,
		keptOnPuts: 0,
		// Of those kept, the ones matching a PARALLEL session's run.
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
 * Drops `x` where it repeats its key's anchor inside the window with nothing
 * stored between, or no count of what was, and otherwise makes it the anchor.
 *
 * @param {JudgedRun} x
 * @param {Map<string, DupAnchor>} anchors accumulator: each kept run is set under its duplicate key
 * @param {Set<number>} dropped accumulator: each file position dropped is added here
 * @param {Collapsed} collapsed accumulator: each collapse is counted into it
 */
function dropOrAnchor(x, anchors, dropped, collapsed) {
	const anchor = anchors.get(x.key);
	const inWindow = anchor !== undefined && x.at - anchor.at <= DUP_WINDOW_MS;
	// `puts` is the field's earlier spelling, still on lines written before
	// the rename; reading it keeps those from collapsing as unable to say.
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

/** A run with nothing takeable carries no fraction; counting it 0/0 invents one. */
/**
 * @param {Run|null|undefined} r
 * @returns {r is Run}
 */
const hasFrontier = (r) => Boolean(r) && isCount(r?.frontier) && r.frontier > 0;

/**
 * The three populations, derived ONCE so a marker printed beside a line cannot
 * disagree with the figures it sits under: every run, the ones left after
 * collapsing duplicates, and the ones a fraction can be taken over at all
 * (mantahostels#650).
 *
 * @param {Run[]|null|undefined} runs
 */
function partition(runs) {
	const { runs: distinct, collapsed } = collapseDuplicates(runs);
	return { distinct, usable: distinct.filter(hasFrontier), collapsed };
}

/** @param {number[]} xs */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The run-to-run mean and 95% band of a per-run fraction, shared between
 * `pooled`'s band and `covered`'s (mantahostels#1327) so the two are computed the same
 * way rather than one getting a point estimate the other has a spread for.
 */
/** @param {number[]} fractions */
function bandOf(fractions) {
	const m = fractions.length > 0 ? mean(fractions) : null;
	// Sample standard deviation: these runs are a sample of the project's
	// churn, not the whole of it.
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

/*
 * Two-tailed 5% critical values by degrees of freedom. Student's t, not the
 * normal's 1.96: at the 10 runs mantahostels#628 asks for, df = 9 and t = 2.262. Above 30
 * the two agree to within a few percent.
 */
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

/**
 * The warm fraction across runs, with the spread that says how much to trust it.
 *
 * `pooled` is the figure that converts to a saving — total warm over total
 * frontier — because a run's contribution to the cost is its size. `mean` and
 * `ci95` describe the run-to-run spread instead, and the two diverge whenever
 * frontier sizes do, so both are reported rather than one standing for the other.
 */
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
	/*
	 * Distinct tickets, not entries: a ticket cold in two runs is one binding
	 * unit against mantahostels#1338's ≥25-ticket gate, not two. Read over the same `usable`
	 * run set `coldTotal` sums over, but not the same field: `coldTotal` sums a
	 * validated count, this reads an unvalidated list entry by entry, so the two
	 * can diverge where a cold entry's number is missing or malformed — a floor
	 * on the true count, never a ceiling. `typeof … === "number"` rather than a
	 * `Number(...)` coercion, so an unreadable `n` (stored as `null`) is dropped
	 * rather than counted as ticket `0` — `Number(null)` is `0`, not `NaN`.
	 */
	const coldDistinctTickets = new Set(
		usable.flatMap((r) =>
			(r.coldNumbers ?? [])
				.map((c) => c?.n)
				.filter((n) => typeof n === "number" && Number.isFinite(n)),
		),
	).size;
	const frontierTotal = usable.reduce((a, r) => a + r.frontier, 0);
	const warmTotal = usable.reduce((a, r) => a + r.warm, 0);
	/*
	 * `runsWithProvisional` is how many lines the figure rests on, which is what
	 * lets a reader split the log at the change rather than pooling across it.
	 */
	const provisionalTotal = usable.reduce(
		(a, r) => a + Number(r.provisional ?? 0),
		0,
	);
	const fractions = usable.map((r) => r.warm / r.frontier);
	const { mean: m, sd, ci95 } = bandOf(fractions);
	// Same shape as `fractions` above, but warm+provisional over frontier — the
	// per-run spread `boundVerdictOn` reads its band from (mantahostels#1327). Defined for
	// every run, before-split ones included: with no `provisional` field this
	// collapses to the warm fraction, which is exactly what "nothing was
	// pre-warmed yet" means.
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
		/*
		 * This is the figure mantahostels#1001 moves; `pooled` above is the one mantahostels#385's claim is
		 * judged on.
		 */
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
		/*
		 * How long the sample was taken over — a separate question from how many
		 * runs it holds, and the one mantahostels#789 turns on (see the header). `null` where
		 * no endpoint is readable, never a zero, which would read as a sample
		 * taken in an instant.
		 */
		windowMs: window.ms,
	};
}

/** The earliest and latest readable instants in a run set, and the gap between. */
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
 *
 * Left to inference these narrow nothing: TypeScript widens a returned
 * `state: "refuted"` to `string`.
 */

/**
 * Ten runs CARRYING A PROVISIONAL COUNT before the covered fraction may be
 * quoted (mantahostels#1054). The same floor as `MIN_RUNS` and for the same reason, but over
 * a different population: `pooled` rests on every usable run, `covered` only on
 * the ones a pre-warming build wrote.
 */
const MIN_PROVISIONAL_RUNS = 10;

/** A line written by a build that pre-warms, whether or not it warmed anything. */
/** @param {Run|null|undefined} r */
const isPostPrewarming = (r) => !!r && "provisional" in r;

/**
 * The log either side of where pre-warming starts (mantahostels#1001), summarised apart so
 * `covered` is never pooled across the change (mantahostels#1054).
 *
 * SPLIT ON THE FIELD'S PRESENCE, never on a non-zero count. A run made after the
 * change that pre-warmed nothing still belongs to the after population, and
 * dropping it would keep only the change's successes and bias `covered` upwards.
 * `coveredVerdictOn` counts non-zero lines instead, which answers a different
 * question: how much evidence the figure rests on, not which side it sits.
 *
 * The boundary is a build, so a line's instant is what places it — and a line
 * whose instant cannot be read is therefore UNPLACEABLE and counted out in
 * `undated` rather than defaulted. Defaulting one to the epoch sorted it to the
 * front, where a pre-warming line among them became the split point and left
 * `before` empty, voiding the comparison silently.
 *
 * Duplicates are collapsed FIRST, over the whole log: collapsing each side
 * separately would keep a re-run whose anchor sits the other side of the
 * boundary, counting one observation twice.
 *
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
		/* `dated` above kept only records whose `at` parses, so the split point
		 * has one. */
		splitAt: /** @type {string} */ (split.at),
		undated,
		before: summarise(ordered.slice(0, at)),
		after: summarise(ordered.slice(at)),
	};
}

/**
 * Whether the covered fraction — warm plus pre-warmed, the share of the frontier
 * a band read may skip — has enough behind it to be quoted at all (mantahostels#1054).
 *
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

/** mantahostels#385's headline, as the band a measurement is here to test. */
const CLAIM = { low: 0.6, high: 0.8, source: "mantahostels#385" };

/**
 * Does the measured warm fraction still support mantahostels#385's 60-80%?
 *
 * THE TWO ARE NOT THE SAME QUANTITY, and the gap is the reason this returns a
 * state rather than a number. mantahostels#385 claims a cut in a re-pick's cost; the warm
 * fraction is what that cut is proportional to, and a warm re-pick is cheap
 * rather than free (mantahostels#385), so the fraction is an UPPER BOUND on the saving.
 *
 * Judged on `pooled`, the cost-weighted figure, because a big frontier costs
 * more than a small one and the claim is about cost. The band around it is the
 * run-to-run spread.
 *
 * Compared as an overlap of intervals, never as a midpoint test: 55% carrying a
 * ±10 point band has not refuted a claim reaching down to 60%. So `confirmed`
 * means the whole band sits inside the claim, and `refuted` that the two do not
 * meet at all.
 *
 * @param {Summary|null|undefined} s
 * @returns {Verdict}
 */
function verdictOn(s) {
	if (!s?.enough || s.pooled === null || s.pooled === undefined)
		return { state: "provisional" };
	const half = s.ci95 ?? 0;
	const low = s.pooled - half;
	const high = s.pooled + half;
	// Which side a refutation falls on is the whole of mantahostels#628's fourth criterion:
	// under the claim the cache may not be paying for itself, which is a finding
	// to report plainly, and over it the claim was merely pessimistic.
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
 * Whether `covered` — the upper bound on mantahostels#385's saving — rules the claim out.
 * A BOUND ONLY EVER REFUTES: a high ceiling says nothing about where the real
 * saving sits beneath it, so nothing here ever confirms (mantahostels#1327).
 *
 * Takes a SUMMARY, not a bare `coveredVerdictOn` result: refuting off the
 * point estimate alone is the same midpoint-test mistake `verdictOn` above
 * exists to avoid — a covered fraction close to the claim's floor
 * needs its own run-to-run spread judged, not just its centre. Refutes only
 * where the WHOLE band sits under the claim; `low`/`high` are `null` off a
 * single run, where refuting on noise is exactly the risk.
 *
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
