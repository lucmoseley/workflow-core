/*
 * sweep-ledger.js — the sweep schedule's slot grid and which slots produced a
 * run (mantahostels#1024), read by check-ci-status.js's liveness report and by
 * repair-sweep-slot.js's refill-tick repair (#4447), so the slot the repair
 * fires for is the slot the report judges missed.
 */

/**
 * A sweep run, as `gh run list --json` spells the fields read here.
 * @typedef {{createdAt?: string, event?: string, displayTitle?: string}} LedgerRun
 */

const { gh } = require("./gh.js");

const SWEEP_WORKFLOW = "scheduled-checks.yml";

/* The branch the ledger reads. A scheduled run and a dispatch with no `--ref`
 * both run on the default branch; every push to a lander ref runs this
 * workflow too (#2413), and read unfiltered those push runs push the slots'
 * own runs out of the list within hours (#4447). */
const SWEEP_BRANCH = "main";

/* Four scheduled runs a day plus the repairs and hand-fires beside them, so
 * 50 reaches back well past the 24h window. */
const LEDGER_RUN_LIMIT = 50;

/* The `workflow_dispatch` input naming the slot a repair fires for; the
 * workflow's `run-name` turns it into slotRunTitle()'s title. */
const SLOT_INPUT = "slot";

/* The hours the sweep fires, UTC. Held here rather than parsed, and so able to
 * drift: `.github/workflows/scheduled-checks.yml` carries the real schedule
 * (mantahostels#3490, dropped from six slots at mantahostels#2166), and a test in check-ci-status.test.ts
 * reads its cron and fails if the two disagree. Ascending, which
 * check-ci-status.js's nextSweepAfter() relies on. */
const SWEEP_HOURS_UTC = [3, 9, 15, 21];

/* How long after a slot passes before a run's absence is read as a miss (mantahostels#1024).
 * Sweeps run late as a matter of course, and 5h cleared the latest lag measured
 * to 26 Aug 2026 by ~7 minutes (mantahostels#1816).
 *
 * IT DOES NOT CLEAR THAT TAIL — mantahostels#2204 measured GitHub delivering slots
 * 310-687 minutes late from 27 Aug 2026. The schedule is four slots at
 * 3/9/15/21 UTC (mantahostels#3490; ruled on cadence at mantahostels#2228).
 * lucmoseley/mantahostels#2241 held this at 5h, its resolution pricing the tail
 * at ~6% of delivered slots read missed first. Widening grace enough to clear that tail would sit close to the 6h gap itself, costing the
 * detector its one job of telling a dropped run from a stopped schedule.
 *
 * IT IS ALSO WHEN A MISSED SLOT IS REPAIRED (#4447): scripts/repair-sweep-slot.js
 * fires one titled for a slot this has judged missed. A slot GitHub delivers later than this gets the
 * repair AND its own late run, a sweep the day's budget pays twice.
 *
 * At the 6h gap (mantahostels#3490) only the newest slot is ever inside it —
 * grace (5h) is SHORTER than the gap. The newest becomes judgeable too in the
 * last hour of each gap, once its own age passes 5h, so sweepLedger() usually
 * holds back 1 of the window's 4 slots and holds back none in that last hour. */
const SWEEP_GRACE_MS = 5 * 60 * 60 * 1000;

/* How far back the slot ledger looks. Four slots is bounded work one gh call
 * covers, and it is what tells one missed slot (a transient drop that heals at
 * the next slot) from every judged slot missed (the schedule has stopped) — a
 * distinction the most-recent-slot form cannot make. The denominator is
 * `judgeable`, THREE OR FOUR and never fewer: SWEEP_GRACE_MS holds back the
 * newest slot except in the last hour of its 6h gap (mantahostels#3490 — see
 * SWEEP_GRACE_MS above). Reading back to the last green instead is unbounded: a
 * week away and this prints dozens of missed slots at session start. */
const SWEEP_LEDGER_MS = 24 * 60 * 60 * 1000;

/**
 * Every time the schedule fires over the two UTC days beginning with `from`'s,
 * ascending.
 *
 * Two days, for the two reasons its callers each have one of: a time past the
 * last slot of the day rolls over to the first of the next, and a 24-hour window
 * straddles midnight for all but four hours of the day.
 *
 * @param {number} from
 * @returns {number[]}
 */
function slotsFrom(from) {
	const d = new Date(from);
	/** @type {number[]} */
	const out = [];
	for (let day = 0; day <= 1; day++)
		for (const hour of SWEEP_HOURS_UTC)
			out.push(
				Date.UTC(
					d.getUTCFullYear(),
					d.getUTCMonth(),
					d.getUTCDate() + day,
					hour,
				),
			);
	return out;
}

/**
 * The cron slots that fell inside the ledger window ending at `t`, ascending.
 *
 * @param {number} t
 * @returns {number[]}
 */
function sweepSlots(t) {
	const from = t - SWEEP_LEDGER_MS;
	return slotsFrom(from).filter((at) => at > from && at <= t);
}

/**
 * The slot a run fills, or null: a scheduled run the latest slot at or before
 * it started, a dispatch the slot its title names.
 * @template {{at: number}} S
 * @param {LedgerRun} r
 * @param {number} started
 * @param {S[]} slots
 * @returns {S|null}
 */
function slotOf(r, started, slots) {
	if (r.event === "workflow_dispatch")
		return slots.find((s) => r.displayTitle === slotRunTitle(s.at)) ?? null;
	if (r.event !== "schedule") return null;
	return slots.findLast((s) => s.at <= started) ?? null;
}

/**
 * Which of the window's slots produced a run, and which did not.
 *
 * A run is attributed to the latest slot at or before it started, so a LATE run
 * still fills the slot it was queued for rather than reading as a miss beside a
 * run that plainly happened. The grace period governs only when a slot may be
 * judged at all: an empty slot says nothing until SWEEP_GRACE_MS has passed.
 *
 * @template {LedgerRun} R
 * @param {R[]} runs
 * @param {number} t
 */
function sweepLedger(runs, t) {
	/** @type {{at: number, run: R|null}[]} */
	const slots = sweepSlots(t).map((at) => ({ at, run: null }));
	/* An untitled hand-fire tests the tree, and is read as coverage in
	 * check-ci-status.js's newest-sweep line, but fills no slot: counting it
	 * would erase the very miss that prompted it. Left broken: an `event`
	 * GitHub spells some third way for a cron run would read as a miss at every
	 * slot. */
	for (const r of runs) {
		const started = Date.parse(r.createdAt || "");
		if (Number.isNaN(started)) continue;
		const owner = slotOf(r, started, slots);
		// The earliest run in a slot is the one the slot fired; a re-run is not it.
		if (
			owner &&
			(!owner.run || Date.parse(owner.run.createdAt || "") > started)
		)
			owner.run = r;
	}
	/* Judged against the slots old enough to judge, never against all four: at
	 * 15:30 the 15:00 slot is still inside the 5h grace, and counting it would
	 * read `3 of 4 slots fired` over a schedule with nothing wrong with it. */
	const judgeable = slots.filter((s) => t - s.at > SWEEP_GRACE_MS);
	return {
		slots,
		judgeable,
		pending: slots.length - judgeable.length,
		fired: judgeable.filter((s) => s.run),
		missed: judgeable.filter((s) => !s.run),
		repaired: judgeable.filter((s) => s.run?.event === "workflow_dispatch")
			.length,
	};
}

/**
 * A slot as the repair's input spells it: `2026-11-05T15:00Z`.
 * @param {number} at
 */
const slotKey = (at) => `${new Date(at).toISOString().slice(0, 16)}Z`;

/**
 * The run title `.github/workflows/scheduled-checks.yml`'s `run-name` gives a
 * dispatch whose `slot` input is `slotKey(at)`. A test pins the two together.
 * @param {number} at
 */
const slotRunTitle = (at) => `sweep slot ${slotKey(at)}`;

/**
 * Throws where gh fails or answers with no list; each caller
 * decides what an unreadable ledger means for it.
 * @param {number} timeout
 * @returns {LedgerRun[]}
 */
function readLedgerRuns(timeout) {
	const rows = JSON.parse(
		gh(
			[
				"run",
				"list",
				"--workflow",
				SWEEP_WORKFLOW,
				"--branch",
				SWEEP_BRANCH,
				"--limit",
				String(LEDGER_RUN_LIMIT),
				"--json",
				"createdAt,event,displayTitle",
			],
			{ timeout },
		),
	);
	if (!Array.isArray(rows))
		throw new Error("gh run list answered with no list");
	return rows;
}

module.exports = {
	SLOT_INPUT,
	SWEEP_WORKFLOW,
	readLedgerRuns,
	slotKey,
	slotsFrom,
	sweepLedger,
};
