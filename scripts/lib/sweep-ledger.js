/**
 * @typedef {{createdAt?: string, event?: string, displayTitle?: string}} LedgerRun
 */

const { gh } = require("./gh.js");

const SWEEP_WORKFLOW = "scheduled-checks.yml";

const SWEEP_BRANCH = "main";

// guess: a per-call gh cap in a sweep, lucmoseley/mantahostels#2134
const SWEEP_GH_TIMEOUT_MS = 8000;

// guess: four runs a day plus repairs, well past 24 h, #4447
const LEDGER_RUN_LIMIT = 50;

const SLOT_INPUT = "slot";

const SWEEP_HOURS_UTC = [3, 9, 15, 21];

// lucmoseley/mantahostels#1816 measured 5h cleared the latest lag to 26 Aug 2026 by ~7 min
const SWEEP_GRACE_MS = 5 * 60 * 60 * 1000;

// guess: four slots at the 6 h gap, lucmoseley/mantahostels#3490
const SWEEP_LEDGER_MS = 24 * 60 * 60 * 1000;

/**
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
 * @param {number} t
 * @returns {number[]}
 */
function sweepSlots(t) {
	const from = t - SWEEP_LEDGER_MS;
	return slotsFrom(from).filter((at) => at > from && at <= t);
}

/**
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
 * @template {LedgerRun} R
 * @param {R[]} runs
 * @param {number} t
 */
function sweepLedger(runs, t) {
	/** @type {{at: number, run: R|null}[]} */
	const slots = sweepSlots(t).map((at) => ({ at, run: null }));
	for (const r of runs) {
		const started = Date.parse(r.createdAt || "");
		if (Number.isNaN(started)) continue;
		const owner = slotOf(r, started, slots);
		if (
			owner &&
			(!owner.run || Date.parse(owner.run.createdAt || "") > started)
		)
			owner.run = r;
	}
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

/** @param {number} at */
const slotKey = (at) => `${new Date(at).toISOString().slice(0, 16)}Z`;

/** @param {number} at */
const slotRunTitle = (at) => `sweep slot ${slotKey(at)}`;

/**
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
	SWEEP_GH_TIMEOUT_MS,
	SWEEP_WORKFLOW,
	readLedgerRuns,
	slotKey,
	slotsFrom,
	sweepLedger,
};
