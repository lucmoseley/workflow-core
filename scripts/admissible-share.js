#!/usr/bin/env node
/*
 * admissible-share.js — the admissible-share reading mantahostels#2308 asked for: settles
 * the unit, handles the zero-selection gap, and is the runnable method itself
 * rather than prose describing one.
 *
 * OUTCOME CONTRACT: prints (or, with --json, returns) two shares, each
 * per-run and per-sha — see "THE UNIT" below — over the marker stores'
 * `test:changed` launches, refusing to headline any of them below a
 * 20-sample floor; and (mantahostels#3211) a full-runs-a-day rate split by why the run
 * was full (`flag`, `stale-manifest`, `dependency-root`, `expansion-failed`,
 * `unknown`), the reading mantahostels#3154's rethink trigger — `flag` above 18/day over
 * any 7-day window — is read against. Unlike the two shares, this rate is
 * NOT floored at 20 samples: a single-digit count over a short window is
 * still printed.
 *
 * Usage:
 *   node scripts/admissible-share.js [--since <ISO>] [--until <ISO>] [--json]
 *
 * WHY A CUTOFF IS MANDATORY, NOT AN OPTION. `scope.viaChanged` was introduced
 * by 57d036d7 (2026-08-31T16:25:51Z) under a LOOSER predicate — set whenever
 * the literal word `--changed` appeared anywhere on the command line — then
 * narrowed by 90f1e5b1 (2026-08-31T16:37:50Z) to `isChangedOnlyArgv`: argv is
 * `--changed` and its optional ref, nothing else. A marker carrying
 * `viaChanged` from the 12-minute window between those two commits was
 * written under the looser rule and belongs to the exact contaminated
 * denominator 90f1e5b1 was written to fix — the launcher review that produced
 * 90f1e5b1 found the looser flag put runs in the denominator that could never
 * reach the numerator. `--since` defaults to 90f1e5b1's commit time; do not
 * lower it.
 *
 * BOTH STORES, NEVER THE CERTIFICATE STORE ALONE (fixed after review; mantahostels#2308's spec
 * axis caught this as a 3x undercount on the two-launch sample it shipped
 * against). A `test:changed` launch that ran and then FAILED its tests is
 * still a launch this method must count in the denominator — `viaChanged` and
 * `admissible` are properties of how the run was ROUTED and whether the
 * read graph rendered, set before vitest ever reports a verdict
 * (scripts/run-vitest.js's spawn, before the child exits) — so a red run
 * carries them identically to a green one. Excluding the red store
 * (`.test-fail-markers.jsonl`) would silently drop every launch whose tests
 * failed, biasing the sample size downward with no way to tell from the
 * output alone. `gateMet` below still refuses every red-store entry — see its
 * own comment — so folding the stores widens the GATE-CLEARING denominator
 * only; `isRouted` counts a red launch in both numerator and denominator.
 *
 * THE UNIT (mantahostels#2308's first acceptance criterion). TWO DIFFERENT OBJECTS are
 * reported, each per-run and per-sha, and only one of them is comparable to
 * mantahostels#2099's commit-level projection
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/filtered-run-admissibility.md). **Compare against 87.8%,
 * not 93.9%**: mantahostels#2099 measured 93.9% before mantahostels#2122's one-hop extractor lifted
 * the staleness exception 6.1% -> 12.2%, so the live projection is 87.8% and
 * quoting the older figure overstates the gap by 6.1pp (mantahostels#2332).
 *
 *   - ROUTED-ADMISSIBLE: the launch's SCOPE was admissible — the read graph
 *     rendered and the selection was narrow — whatever the tests then did. This is
 *     the mantahostels#2099-comparable object: mantahostels#2099 simulated selections over 49 commits
 *     and never ran a test, so a red run is admissible there exactly as a
 *     green one is.
 *
 *   - GATE-CLEARING: routed-admissible AND green, which is what the push gate
 *     actually demands (mantahostels#2102). Strictly narrower, and NOT comparable to the
 *     projection: it multiplies in this machine's test-failure rate, which
 *     mantahostels#2099 never measured. An operational rate — "how often did the cheap
 *     path actually certify a push" — not a coverage one.
 *
 * PER-RUN counts launches across both stores; PER-SHA counts distinct shas
 * carrying at least one qualifying launch, over distinct shas carrying at
 * least one `test:changed` launch at all. ONLY THE ROUTED PER-SHA FIGURE IS
 * THE ONE TO SET BESIDE 87.8%: mantahostels#2099 counted commits, and routed per-run
 * counts launches, several of them often landing on one sha. The per-sha
 * figure carries three gaps mantahostels#2099 did not have, all reported alongside it
 * rather than folded in:
 *
 *     1. `sha` is END-OF-RUN HEAD (`markerFrom`'s `sha: after.head`,
 *        scripts/lib/test-pass-marker.js), not the diff base (mantahostels#2271). A
 *        per-sha figure here is "share of end-of-run HEADs", a weaker object
 *        than mantahostels#2099's per-commit one.
 *     2. mantahostels#2099's denominator was every commit on `main` in its window,
 *        independent of what any session chose to run. This store's
 *        denominator is self-selected: only shas where a session happened to
 *        launch `test:changed` at all.
 *     3. The zero-selection gap below drops some shas from BOTH figures.
 *
 * THE ZERO-SELECTION GAP (mantahostels#2308's second acceptance criterion). Where the
 * diff reaches no test file, `scripts/run-vitest.js`'s `runOnce` returns
 * before spawning vitest at all (run-vitest.js, the early return keyed to
 * `!plan.files.length`), so no marker is ever written — even though
 * `isAdmissible` is computed for that launch and simply discarded. mantahostels#2099's
 * method, by contrast, counted a zero-selection commit as vacuously
 * admissible: 4 of 4 in its window (mantahostels#2099's admissibility note, Limb 1).
 *
 * DECIDED: documented as a named bias, not instrumented. Making
 * `runOnce` write a marker on the zero-selection path would touch the same
 * early return the push gate's admissible-scope certificate depends on
 * (mantahostels#2146, mantahostels#2207) — outside a measurement ticket's blast radius. Two
 * consequences, in different directions, because the two shares fail
 * differently:
 *
 *   - PER-SHA: assuming live zero-selection launches admit at mantahostels#2099's
 *     observed rate for that shape (4 of 4), dropping them from both
 *     numerator and denominator removes only successes — biasing the
 *     reported per-sha share DOWNWARD relative to a mantahostels#2099-comparable
 *     population (mantahostels#2308).
 *   - PER-RUN: the read-graph render is a repo-wide check, independent
 *     of how many files a given diff selects, so there is no reason to
 *     expect the missing launches skew admissible either way. What is lost
 *     there is coverage — an unknown count of undercounted launches — not a
 *     directional skew.
 *
 * A THIRD OMISSION, DELIBERATE: a `test:changed` launch whose read-graph
 * render failed AND whose selection was non-empty writes `scope.admissible` absent
 * (never `false`) and `scope.changed: null` (lib/changed-selection.js's `expandChanged`
 * consumes `--changed` into an explicit file list before vitest sees it) —
 * this is exactly the ambiguity mantahostels#2303 fixed with `viaChanged`, and this
 * script's numerator/denominator split on `viaChanged` rather than on
 * `admissible` presence is what makes that fix load-bearing here.
 *
 * PREDICATES ARE THE SHIPPED ONES, never reimplemented — `isAdmissibleRun`,
 * `isFullRun` and `suiteOf` off `scripts/lib/test-pass-marker.js`, the
 * precedent mantahostels#2192's resolution set. A run wide enough to be a full run still
 * clears the push gate and is counted as meeting it here even though
 * `isAdmissibleRun` alone would say no (`isAdmissibleScope` excludes a full
 * scope by construction).
 *
 * A THRESHOLD BELOW WHICH NO FIGURE IS PRINTED. mantahostels#2308 was gated until a day
 * of sessions had run under 90f1e5b1 specifically so the store would hold
 * enough routed markers to count; a script that prints a percentage off two
 * data points would look exactly as authoritative as one off two hundred.
 * 20 is not measured — a first cut, on the discipline set out at
 * `FULL_RED_RATIO` (`scripts/lib/test-pass-marker.js`).
 */

const { writeFd } = require("./lib/write-fd.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const {
	repoRoot,
	readMarkers,
	readFailures,
	isAdmissibleRun,
	isFullRun,
	suiteOf,
	DEFAULT_SUITE,
	FULL_REASONS,
} = require("./lib/test-pass-marker.js");

/** 90f1e5b1's commit time — see the header for why this is the floor. */
const ROUTE_FIX_AT = "2026-08-31T16:37:50Z";

/** Unmeasured; see the header's closing paragraph. */
const MIN_SAMPLE = 20;

/** A private tag on a marker copy, never on the shape `test-pass-marker.js`
 * itself defines: which store this run was read from, so a red launch can
 * count toward the denominator without ever counting toward the gate. */
const FROM_RED_STORE = Symbol("fromRedStore");

/** @typedef {import("./lib/test-pass-marker.js").Marker & {[FROM_RED_STORE]?: boolean}} TaggedMarker */
/** @typedef {{markers: import("./lib/test-pass-marker.js").Marker[], failures: import("./lib/test-pass-marker.js").Marker[]}} Stores the pass and fail marker stores */

/**
 * A launch the wrapper ROUTED admissibly — rendered read graph, narrow selection —
 * green or red. The mantahostels#2099-comparable predicate: mantahostels#2099 read selections, never
 * verdicts.
 * @param {TaggedMarker} m
 */
const isRouted = (m) => isFullRun(m) || isAdmissibleRun(m);

/**
 * A run this store can show met the push gate. A red run never can, whatever
 * its scope claims: tests failing is the one thing no scope field records.
 * @param {TaggedMarker} m
 */
const gateMet = (m) => !m[FROM_RED_STORE] && isRouted(m);

/**
 * Every `test:changed` launch this suite recorded, green or red, since the
 * cutoff — see the header's "BOTH STORES" paragraph for why a red launch
 * belongs in the count.
 *
 * @param {Stores & {since: string, until?: number}} options
 */
function readViaChanged({
	since,
	until,
	markers: certificates,
	failures: red,
}) {
	/** @param {import("./lib/test-pass-marker.js").Marker} m */
	const matches = (m) =>
		suiteOf(m) === DEFAULT_SUITE &&
		m.scope?.viaChanged === true &&
		inWindow(m, since, until);
	return [
		...certificates.filter(matches),
		.../** @type {TaggedMarker[]} */ (
			red.filter(matches).map((m) => ({ ...m, [FROM_RED_STORE]: true }))
		),
	];
}

/**
 * Whether a marker's `at` falls in [since, until] — `until` unset means no
 * upper bound. Shared so `readViaChanged` and `readFullRuns` bound the same
 * way.
 * @param {import("./lib/test-pass-marker.js").Marker} m
 * @param {string} since
 * @param {number|undefined} until
 */
const inWindow = (m, since, until) =>
	(m.at ?? "") >= since &&
	(until === undefined || Date.parse(m.at ?? "") <= until);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every bucket `fullPerDay` reports, the mantahostels#3207 reasons plus the unmarked case. */
const FULL_PER_DAY_BUCKETS = [...FULL_REASONS, "unknown"];

/**
 * Every full run this suite recorded, green or red, since the cutoff — same
 * both-stores doctrine as `readViaChanged` (header, "BOTH STORES"): a full
 * run that then failed its tests still occupied the one-suite rung, and
 * dropping the red store would undercount the census exactly as it would
 * there. NEVER `readViaChanged`: a `--full` launch's argv is never
 * `isChangedOnlyArgv`, so it carries no `viaChanged` and that reader would
 * see zero full runs forever (run-vitest.js sets the launch record's
 * `viaChanged` off argv shape alone, independently of the `fullFlag` that
 * sets its `full`).
 *
 * @param {Stores & {since: string, until?: number}} options
 */
function readFullRuns({ since, until, markers: certificates, failures: red }) {
	/** @param {import("./lib/test-pass-marker.js").Marker} m */
	const matches = (m) =>
		suiteOf(m) === DEFAULT_SUITE && isFullRun(m) && inWindow(m, since, until);
	return [...certificates.filter(matches), ...red.filter(matches)];
}

/**
 * The earliest `at` either store still holds, across every suite — the real
 * coverage floor a per-day rate can be measured against. Both stores prune
 * to `KEEP` entries (test-pass-marker.js), so asking for a `since` older
 * than what survived silently divides by a window the data cannot back,
 * printing a rate under mantahostels#3154's 18/day rethink trigger by construction
 * rather than by the day's actual runs.
 *
 * @param {Stores} stores
 */
function earliestAt({ markers, failures }) {
	const ats = [...markers, ...failures]
		.map((m) => m.at)
		.filter((a) => typeof a === "string")
		.sort();
	return ats[0];
}

/**
 * Which of the four mantahostels#3207 reasons a full run's scope names — absent or
 * forged (not one of `FULL_REASONS`) reads as `"unknown"`, never as `"flag"`
 * (the ticket's AC-2).
 * @param {import("./lib/test-pass-marker.js").Marker} m
 */
const reasonOf = (m) => {
	const full = m.scope?.full;
	return full != null && FULL_REASONS.includes(full) ? full : "unknown";
};

/**
 * Full runs a day, split by `reasonOf`, over the window from `since` to
 * `now`. A RATE, not a count, to stay comparable to mantahostels#3154's own baselines
 * (both counts over elapsed days). The split always
 * sums to the unsplit total: every full run lands in exactly one of
 * `FULL_REASONS` plus `"unknown"` (AC-3).
 *
 * @param {ReturnType<typeof readFullRuns>} runs
 * @param {{since?: string, now?: number}} [options]
 */
function fullPerDay(runs, { since = ROUTE_FIX_AT, now = Date.now() } = {}) {
	const parsed = Date.parse(since);
	// An unparseable --since reads as no window, never as NaN days: `days > 0`
	// below is already false on NaN, but the printed banner is not.
	const days = Number.isNaN(parsed) ? 0 : Math.max((now - parsed) / DAY_MS, 0);
	/** @param {number} n */
	const rate = (n) => (days > 0 ? n / days : 0);
	/** @type {Record<string, number>} */
	const counts = Object.fromEntries(FULL_PER_DAY_BUCKETS.map((r) => [r, 0]));
	for (const m of runs) {
		const reason = reasonOf(m);
		const n = counts[reason];
		if (n === undefined)
			throw new Error(`reasonOf gave "${reason}", which has no bucket`);
		counts[reason] = n + 1;
	}
	return {
		since,
		days,
		total: { count: runs.length, perDay: rate(runs.length) },
		byReason: Object.fromEntries(
			Object.entries(counts).map(([r, n]) => [
				r,
				{ count: n, perDay: rate(n) },
			]),
		),
	};
}

/**
 * @param {ReturnType<typeof readViaChanged>} runs
 */
function shares(runs) {
	/** @param {(m: TaggedMarker) => boolean} qualifies */
	const share = (qualifies) => {
		const bySha = new Map();
		for (const m of runs) bySha.set(m.sha, bySha.get(m.sha) || qualifies(m));
		const shas = [...bySha.values()];
		return {
			perRun: { admissible: runs.filter(qualifies).length, total: runs.length },
			perSha: { admissible: shas.filter(Boolean).length, total: shas.length },
		};
	};
	return { routed: share(isRouted), gate: share(gateMet) };
}

/** @param {{admissible: number, total: number}} s */
const pct = (s) =>
	s.total ? `${((s.admissible / s.total) * 100).toFixed(1)}%` : "n/a";

/** @param {{since?: string, now?: number}} [options] */
function report(options = {}) {
	const since = options.since ?? ROUTE_FIX_AT;
	const root = repoRoot();
	// Both stores read exactly once; readViaChanged/readFullRuns/earliestAt all
	// take the arrays rather than re-reading (mantahostels#3247).
	const markers = readMarkers({ root });
	const failures = readFailures({ root });
	// `now` bounds the window's END exactly as `since` bounds its start, so it
	// reaches the same matches readViaChanged/readFullRuns apply.
	const until = options.now;
	const runs = readViaChanged({ since, until, markers, failures });
	const s = shares(runs);
	// The full-runs-a-day window is floored at what the stores still hold —
	// see earliestAt's header for why a bare `since` overstates the span.
	const floor = earliestAt({ markers, failures });
	const fullSince = floor && floor > since ? floor : since;
	return {
		...s,
		since,
		fullPerDay: fullPerDay(
			readFullRuns({ since: fullSince, until, markers, failures }),
			{
				since: fullSince,
				now: options.now,
			},
		),
	};
}

/** @param {string} s */
const writeOut = (s) => writeFd(1, `${s}\n`);

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage:
		"usage: node scripts/admissible-share.js [--since <ISO>] [--until <ISO>] [--json]",
	flags: { "--since": "value", "--until": "value", "--json": "boolean" },
};
const VALUE_FLAGS = new Set(["--since", "--until"]);

function main(argv = process.argv.slice(2)) {
	// A value flag with no value is dropped rather than refused, so
	// `--since --json` leaves `since` unset and still reads `--json`.
	const kept = argv.filter((t, i) => {
		const next = argv[i + 1];
		return (
			!VALUE_FLAGS.has(t) || (next !== undefined && !next.startsWith("--"))
		);
	});
	const { flags } = parseOrExit(kept, CLI);
	const since = flagValue(flags, "--since");
	const until = flagValue(flags, "--until");
	const asJson = flags["--json"] === true;
	// An unparseable --until reads as no end bound, never as "exclude
	// everything" (Date.parse's NaN would fail every marker's <= check).
	const parsedUntil = until === undefined ? undefined : Date.parse(until);
	const now = Number.isNaN(parsedUntil) ? undefined : parsedUntil;
	const r = report({
		...(since ? { since } : {}),
		...(now === undefined ? {} : { now }),
	});

	if (asJson) {
		writeOut(JSON.stringify(r));
		return 0;
	}

	const untilNote = now === undefined ? "" : ` until ${until}`;
	writeOut(`Window: viaChanged vitest launches since ${r.since}${untilNote}\n`);
	/** @param {string} label @param {{perRun: {admissible: number, total: number}, perSha: {admissible: number, total: number}}} s */
	const block = (label, s) => {
		writeOut(label);
		writeOut(
			`  per-sha  ${s.perSha.admissible}/${s.perSha.total} = ${pct(s.perSha)}`,
		);
		writeOut(
			`  per-run  ${s.perRun.admissible}/${s.perRun.total} = ${pct(s.perRun)}\n`,
		);
	};
	block(
		"ROUTED-ADMISSIBLE (per-sha is the figure to set beside mantahostels#2099's projection, 87.8% once mantahostels#2122 is applied to its 93.9%, with the caveats in this file's header; per-run counts launches, not commits):",
		r.routed,
	);
	block(
		"GATE-CLEARING (routed-admissible AND green; NOT comparable to mantahostels#2099, which ran no tests):",
		r.gate,
	);
	writeOut(
		`FULL RUNS A DAY, since ${r.fullPerDay.since} (${r.fullPerDay.days.toFixed(1)} days — floored at what the stores still hold, never above the --since window; both stores; mantahostels#3154's rethink trigger is \`flag\` above 18/day over any 7-day window):`,
	);
	writeOut(
		`  total  ${r.fullPerDay.total.count} = ${r.fullPerDay.total.perDay.toFixed(1)}/day`,
	);
	for (const [reason, b] of Object.entries(r.fullPerDay.byReason)) {
		writeOut(`    ${reason}  ${b.count} = ${b.perDay.toFixed(1)}/day`);
	}
	writeOut("");
	// Either object settles the floor for both: `shares` builds them over one
	// `runs` array, so the totals are the same and only the numerators differ.
	if (
		r.routed.perSha.total < MIN_SAMPLE ||
		r.routed.perRun.total < MIN_SAMPLE
	) {
		writeOut(
			`\nBelow the ${MIN_SAMPLE}-sample floor (unmeasured, a first cut) — no figure should be quoted from this run. Re-run once the store has more.`,
		);
	}
	return 0;
}

if (require.main === module) process.exit(main());
