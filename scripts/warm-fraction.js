#!/usr/bin/env node
/*
 * warm-fraction.js — reports the warm fraction of the frontier across the real
 * selection runs `pick-next.js` has recorded, which is what mantahostels#385's 60-80%
 * saving claim actually rests on (mantahostels#789, the live ticket; mantahostels#628 closed it).
 *
 * The arithmetic is one line:
 *
 *     run-level saving = warm fraction x per-ticket band-read cost
 *
 * mantahostels#611 measured the right-hand term. The warm fraction is an upper bound on the
 * saving rather than the saving itself; the report's own AGAINST block says why.
 *
 * IT REFUSES A VERDICT UNDER 10 RUNS, which is what mantahostels#628 asked for — and refuses
 * the `covered` fraction separately, under 10 runs a pre-warming build wrote,
 * since that figure rests on those alone (mantahostels#1054). ONCE THE LOG SPANS THE
 * PRE-WARMING SPLIT, IT REFUSES A DIFFERENT WAY REGARDLESS OF RUN COUNT: the
 * whole-log pooled fraction averages two mechanisms, so no verdict is quoted
 * off it at all, and a COVERED BOUND — which only ever refutes, never confirms
 * — is quoted off the after side instead (mantahostels#1327). It reports the window's SPAN
 * as well as its endpoints, because churn is what cools a ticket and a sample's
 * length bounds how much of it the sample can have seen (mantahostels#789).
 *
 * Usage: node scripts/warm-fraction.js [--json] [--runs]
 *
 * Always exits 0: a log that cannot be read at all reads as one not yet
 * written, which is the normal state before the first run.
 */

const log = require("./lib/warm-fraction-log");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");

// Overridable like `pick-next.js`'s, so the log can be read from a throwaway
// tree rather than only from this one.
const REPO_ROOT = process.env.WFC_REPO_ROOT || hostRoot();
const { flags } = parseOrExit(process.argv.slice(2), {
	usage: `usage: node ${scriptPath("warm-fraction.js")} [--json] [--runs]`,
	flags: { "--json": "boolean", "--runs": "boolean" },
});
const asJson = flags["--json"] === true;
const showRuns = flags["--runs"] === true;

const CLAIM = log.CLAIM;

/** @param {number|null} f A fraction, or null where there is nothing to report. */
const pct = (f) => (f === null ? "—" : `${(f * 100).toFixed(1)}%`);

// 48 hours before days: a first guess, and stated as one. Both windows a reader
// compares against are named in hours (mantahostels#789's 25) and days (its fortnight), so
// the cutover sits above the first and well below the second.
const SPAN_HOURS_MAX = 48;

/** @param {number|null|undefined} ms */
const span = (ms) => {
	if (ms === null || ms === undefined) return "—";
	const h = ms / 3_600_000;
	return h < SPAN_HOURS_MAX
		? `${h.toFixed(1)} hours`
		: `${(h / 24).toFixed(1)} days`;
};

const { runs, malformed } = log.readRuns(REPO_ROOT);
const s = log.summarise(runs);
const { distinct, usable } = log.partition(runs);
// The two reasons a line is not in the figures, kept apart: already counted, or
// nothing to count.
const kept = new Set(distinct);
const counted = new Set(usable);
const verdict = log.verdictOn(s);
// The covered fraction is gated on its own sample, not on `pooled`'s (mantahostels#1054).
const covered = log.coveredVerdictOn(s);
const split = log.splitAtProvisional(runs);
// Un-pooled (mantahostels#1327): `covered` read on the AFTER side alone, and the bound it
// puts on mantahostels#385's saving. `verdict`/`coveredVerdict` above still pool across
// the split where one exists — callers reading a verdict off a split log want
// this one.
const afterCoveredVerdict =
	split.splitAt === null ? null : log.coveredVerdictOn(split.after);
const boundVerdict =
	split.splitAt === null ? null : log.boundVerdictOn(split.after);
// What the text report actually asserts as the mantahostels#385 headline, so a `--json`
// caller reading `verdict` instead cannot hit the fault this ticket fixes.
const headlineVerdict =
	split.splitAt === null
		? { basis: "pooled", ...verdict }
		: { basis: "covered-bound", uninterpretablePooled: true, ...boundVerdict };

if (asJson) {
	console.log(
		JSON.stringify(
			{
				logPath: log.LOG_SUBPATH,
				minRuns: log.MIN_RUNS,
				malformedLines: malformed,
				summary: s,
				claim: CLAIM,
				verdict,
				coveredVerdict: covered,
				afterCoveredVerdict,
				boundVerdict,
				headlineVerdict,
				minProvisionalRuns: log.MIN_PROVISIONAL_RUNS,
				split,
				runs: showRuns
					? runs.map((r) => ({
							...r,
							duplicate: !kept.has(r),
							counted: counted.has(r),
						}))
					: undefined,
			},
			null,
			2,
		),
	);
	process.exit(0);
}

console.log(
	`WARM FRACTION OF THE FRONTIER — ${s.usableRuns} real re-pick(s) recorded in ${log.LOG_SUBPATH}`,
);

if (!s.usableRuns) {
	console.log(
		`\nNothing recorded yet. Every \`node ${scriptPath("pick-next.js")}\` against this repo appends a\n` +
			"line; nothing else may, since a run made to produce a figure measures the\n" +
			"harness rather than the churn (mantahostels#628).",
	);
	process.exit(0);
}

console.log(
	`  window        ${s.first} → ${s.last}  (${span(s.windowMs)})\n` +
		`  pooled        ${pct(s.pooled)}  (${s.warmTotal} warm of ${s.frontierTotal} frontier tickets)\n` +
		`  per-run mean  ${pct(s.mean)}${s.ci95 === null ? "" : ` ± ${(s.ci95 * 100).toFixed(1)} points (95%)`}\n` +
		`  per-run range ${pct(s.min)} – ${pct(s.max)}`,
);
/*
 * The pre-warming figure (mantahostels#1001), kept apart from `pooled` above and printed
 * only where some run recorded one. `pooled` is band-read warmth, which is what
 * mantahostels#385's claim is judged on; this is the share of the frontier a band read can
 * SKIP, which is what pre-warming moved.
 */
if (s.runsWithProvisional)
	console.log(
		(covered.state === "measured"
			? `  covered       ${pct(covered.point)}  (${s.warmTotal} warm + ${s.provisionalTotal} provisional of ${s.frontierTotal}),\n` +
				`  over ${covered.runs} run(s) that pre-warmed something.\n` +
				"  Provisional entries are a selection run's own grep, not an agent's\n" +
				"  judgement, so they are excluded from `pooled` above."
			: `  covered       WITHHELD — ${covered.runs} of ${covered.need} run(s) that pre-warmed\n` +
				`  something. The arithmetic would give ${pct(s.pooledCovered)}, and it is not stated:\n` +
				"  `covered` rests only on runs a pre-warming build wrote, so quoting it off\n" +
				"  `pooled`'s sample size is the fault mantahostels#789 records against the 80.0%\n" +
				"  figure. Provisional entries are a run's own grep, not an agent's\n" +
				"  judgement, so they are excluded from `pooled` above either way.") +
			(split.splitAt === null
				? ""
				: "\n  This is the WHOLE-LOG figure, pooled across the pre-warming split same as\n" +
					"  `pooled` above — read `after`'s `covered` in the split table below instead\n" +
					"  (mantahostels#1327)."),
	);
if (s.degradedRuns)
	console.log(
		`  ${s.degradedRuns} of these runs was degraded — a failed blocked_by call shrinks the\n` +
			"  frontier, so its fraction is over a smaller denominator.",
	);
if (s.unrevalidatedWarmTotal)
	console.log(
		`  ${s.unrevalidatedWarmTotal} warm hit(s) skipped the rename check (git could not list the\n` +
			"  tree), so they are counted warm without having been fully revalidated.",
	);
if (s.collapsedRuns) {
	const by = [
		`${s.collapsedSameSession} a re-run by the same session`,
		`${s.collapsedCrossSession} a parallel session over an unchanged frontier`,
	];
	if (s.collapsedUnknownSession)
		by.push(
			`${s.collapsedUnknownSession} naming no session, so unattributable`,
		);
	console.log(
		`  ${s.collapsedRuns} duplicate line(s) collapsed and excluded above — ${by.join(", ")}.\n` +
			`  A duplicate is an identical frontier and split within ${log.DUP_WINDOW_MS / 60_000} minutes with\n` +
			"  nothing put in between; none adds an observation of the churn, and counting\n" +
			"  one twice both double-weights it in `pooled` and narrows the band (mantahostels#650).\n" +
			`  ${s.collapsedQuiet} of these rested on a count of zero (itself a floor — a put whose entry\n` +
			`  was pruned since is invisible) and ${s.collapsedPutsUnknown} on a line predating the count. With\n` +
			"  nothing put, a genuine re-pick over an unchanged frontier reads exactly like\n" +
			"  a re-run, so each one collapsed pulls `pooled` DOWN (mantahostels#667).",
	);
}
if (s.runsKeptOnPuts)
	console.log(
		`  ${s.runsKeptOnPuts} line(s) inside that window were kept: entries were put between each\n` +
			`  and the run it matches, so a band read ran in the gap (mantahostels#667). ${s.runsKeptOnPutsCrossSession} of them\n` +
			"  matched a parallel session's run, which keeps `pooled` UP (mantahostels#680).",
	);
if (malformed) console.log(`  ${malformed} unreadable line(s) skipped.`);

console.log(
	"\nWHAT THIS FRACTION IS OVER\n" +
		"  The whole frontier, which is what pick-next can see. The band read covers\n" +
		"  the tie band only, so where the two differ this is a lower bound on the\n" +
		"  fraction the band read actually meets. Every run records its issue numbers,\n" +
		"  so a narrower denominator can be recomputed from the log rather than re-run.",
);

/** Runs a build boundary cannot place, which shrinks both sides silently. */
const undatedNote = split.undated
	? `\n  ${split.undated} run(s) carry an unreadable instant and sit on NEITHER side —\n` +
		"  a build boundary can only be judged in time."
	: "";

if (split.splitAt === null)
	console.log(
		"\nBEFORE AND AFTER PRE-WARMING (mantahostels#1054)\n" +
			"  No line carries a `provisional` count yet, so every run here predates\n" +
			`  pre-warming and there is nothing to split.${undatedNote}`,
	);
else {
	/**
	 * @param {string} label
	 * @param {ReturnType<typeof log.summarise>} x One side of the pre-warming split.
	 */
	const side = (label, x) =>
		`  ${label.padEnd(7)} pooled ${pct(x.pooled)}   covered ${pct(x.pooledCovered)}   ` +
		`(${x.usableRuns} run(s) over ${span(x.windowMs)})`;
	console.log(
		"\nBEFORE AND AFTER PRE-WARMING (mantahostels#1054)\n" +
			`  split at ${split.splitAt}, the first run a pre-warming build wrote.\n` +
			`${side("before", split.before)}\n${side("after", split.after)}\n` +
			"  Split on the field's PRESENCE, not on a non-zero count: a post-change run\n" +
			"  that pre-warmed nothing still belongs after the line, and dropping it\n" +
			`  would keep only the change's successes.${undatedNote}\n` +
			(covered.state === "measured"
				? "  Read `pooled` as the check that pre-warming left band-read warmth alone."
				: `  BOTH SIDES ARE STILL PROVISIONAL — ${covered.runs} of ${covered.need} run(s) pre-warmed\n` +
					"  anything, so the after side is too thin to compare against."),
	);
}

/**
 * The share of cold entries `cause` explains, as `pct` prints it.
 * @param {string} cause one of the log's CAUSES
 */
const causePct = (cause) => {
	const share = s.causeShare[cause];
	if (share === undefined) throw new Error(`the summary has no ${cause} share`);
	return pct(share);
};

console.log(
	`\nWHY THE COLD ONES WERE COLD (${s.coldTotal} cold entries over ${s.coldDistinctTickets} distinct ticket(s))\n` +
		`  never derived  ${s.causes.never} (${causePct("never")}) — no entry has ever been stored\n` +
		`  body-changed   ${s.causes["body-changed"]} (${causePct("body-changed")}) — churn\n` +
		`  path-gone      ${s.causes["path-gone"]} (${causePct("path-gone")}) — a rename invalidated the prediction\n` +
		`  unknown        ${s.causes.unknown} (${causePct("unknown")}) — a state this reader does not know\n` +
		"  Read `never derived` as an upper bound on cold starts: a band the picking\n" +
		"  session abandoned never stores an entry either, and reads the same here.",
);

console.log(
	"\nAGAINST mantahostels#385's 60-80% CLAIM (a cut in a re-pick's dominant cost)\n" +
		"  A warm ticket costs ~4 ms and no subagent against ~3.2 s and ~7.9k tokens\n" +
		"  cold (mantahostels#611), so the fraction above is an UPPER BOUND on the saving: mantahostels#385\n" +
		"  prices even a warm re-pick at 50-90k tokens against 200-400k cold, and no\n" +
		"  cache reaches that floor. A fraction inside the claim is consistent with it,\n" +
		"  never proof of it.",
);

if (boundVerdict !== null) {
	// Guarded on `boundVerdict` rather than `split.splitAt`, the same condition
	// by its ternary above, so the verdict below is known to be present.
	// `pooled` averages two regimes either side of the pre-warming build
	// (mantahostels#1054); quoting one number across that boundary is the fault mantahostels#789
	// found and mantahostels#1327 fixes. `covered`, not `pooled`, is the fraction that
	// bounds the saving, and it is read on the AFTER side only, never pooled
	// across the split either.
	console.log(
		"  UNINTERPRETABLE — `pooled` above averages before and after pre-warming\n" +
			"  (split table above); no verdict is stated off it. `covered`, not\n" +
			"  `pooled`, is the fraction that bounds the saving.",
	);
	if (boundVerdict.state === "provisional")
		console.log(
			`  COVERED BOUND — PROVISIONAL, ${boundVerdict.runs} of ${boundVerdict.need} run(s) since\n` +
				`  the split carry a provisional count. No bound is stated under ${boundVerdict.need}.`,
		);
	else if (boundVerdict.state === "refuted")
		console.log(
			`  COVERED BOUND — ${pct(boundVerdict.point)} (95% band ${pct(boundVerdict.low)} – ${pct(boundVerdict.high)}),\n` +
				`  the whole band below ${pct(CLAIM.low)}: the bound itself rules out ${CLAIM.source}'s\n` +
				"  claim — even a band read that never misses cannot reach it.",
		);
	else
		console.log(
			`  COVERED BOUND — ${pct(boundVerdict.point)} (95% band ${pct(boundVerdict.low)} – ${pct(boundVerdict.high)}).\n` +
				`  An upper bound this high rules nothing out: ${CLAIM.source}'s ${pct(CLAIM.low)} – ${pct(CLAIM.high)}\n` +
				"  needs a direct token measurement, not a warmer cache. A bound only ever\n" +
				"  refutes; it never confirms.",
		);
	console.log("  Take this to mantahostels#789 as its answer.");
} else if (verdict.state === "provisional")
	console.log(
		`  PROVISIONAL — ${s.usableRuns} of ${log.MIN_RUNS} runs. No verdict is stated under ${log.MIN_RUNS}:\n` +
			"  quoting a headline off too little data is the fault this measures.",
	);
else {
	console.log(
		`  ${verdict.state.toUpperCase()} — measured ${pct(verdict.point)} (95% band ${pct(verdict.low)} – ${pct(verdict.high)})\n` +
			`  against ${CLAIM.source}'s ${pct(CLAIM.low)} – ${pct(CLAIM.high)}.`,
	);
	// mantahostels#628's fourth criterion.
	if (verdict.side === "below")
		console.log(
			`  PLAINLY: the cache is warm on ${pct(verdict.point)} of the frontier, so it saves at\n` +
				`  most ${pct(verdict.point)} of the band read — not ${pct(CLAIM.low)} – ${pct(CLAIM.high)}. At this rate its upkeep\n` +
				"  (a `put` per derived issue, every run) may cost more than it returns, and\n" +
				`  whether to keep it at all is the question ${CLAIM.source} should be reopened on.`,
		);
	console.log("  Take this to mantahostels#789 as its answer.");
}

if (showRuns) {
	console.log("\nRUNS (oldest first)");
	for (const r of runs) {
		let mark = "*";
		if (counted.has(r)) mark = " ";
		else if (kept.has(r)) mark = "\u00b7";
		console.log(
			`  ${mark} ${r.at}  frontier ${String(r.frontier).padStart(3)}  warm ${String(r.warm).padStart(3)}  cold ${String(r.cold).padStart(3)}  ` +
				`never ${r.causes?.never ?? "?"} / changed ${r.causes?.["body-changed"] ?? "?"} / gone ${r.causes?.["path-gone"] ?? "?"}`,
		);
	}
	if (s.collapsedRuns)
		console.log(
			"  * a duplicate, collapsed into an earlier run and excluded from the figures.",
		);
	if (runs.length - s.usableRuns - s.collapsedRuns > 0)
		console.log(
			"  \u00b7 nothing takeable at the time, so it carries no fraction and is excluded too.",
		);
}
