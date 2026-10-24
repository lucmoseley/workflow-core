/*
 * overflow-budget-core.js — the budget gate's pure core: how many sessions fit
 * on an overflow key, from its ledger, its running runs, the session cost
 * table and the time (#2609, spec #2570 story 45).
 *
 * CYCLE: spend counts from the most recent `cycle-day` at local midnight. A
 * settled run counts in the cycle it ended in, where its last requests were
 * billed, as a running run's reservation holds the current cycle. A run that
 * ended on a credit refusal marks the key exhausted until the next cycle.
 *
 * RESERVATIONS, against requests and never live usage
 * (docs/practice/capacity-planning-and-admission.md): each running run holds
 * max(Q, spent so far + session-spend's expected remainder), and a new launch
 * holds Q, the cost table's `meanUsd` — read, never a constant (#2570).
 *
 *   headroom = grant − settled spend − Σ running reservations
 *   fit      = floor(headroom / Q), or 0 on an exhausted key
 */

const { expectedRemainderUsd } = require("./session-spend.js");

/**
 * @typedef {import("./session-spend.js").CostTable} CostTable
 *
 * @typedef {object} LedgerEntry
 * @property {string} sessionId
 * @property {string} jobId
 * @property {number} launchedAt ms
 * @property {number} endedAt ms, the run's last log write
 * @property {number} costUsd
 * @property {"result"|"transcript"|"reservation"} costSource `reservation`:
 *   neither a `result` nor a transcript priced the run, so it is charged Q
 * @property {string} outcome lib/headless-sessions.js's EndResult outcome
 *
 * @typedef {{sessionId: string, spentUsd: number|null}} RunningRun
 *
 * @typedef {object} Budget
 * @property {number} fit sessions that fit on the key now
 * @property {number} headroomUsd
 * @property {number} settledUsd this cycle's settled spend
 * @property {number} reservedUsd held by running runs
 * @property {number} grantUsd
 * @property {number} qUsd the launch reservation
 * @property {number} running
 * @property {number} cycleStart ms
 * @property {number} nextCycleStart ms
 * @property {boolean} exhausted
 */

/**
 * The billing cycle `now` falls in: from the most recent `cycleDay` at local
 * midnight to the next. cycleDay is 1–28, so every month holds it.
 * @param {number} now ms
 * @param {number} cycleDay
 * @returns {{start: number, next: number}}
 */
function cycleOf(now, cycleDay) {
	const d = new Date(now);
	let start = new Date(d.getFullYear(), d.getMonth(), cycleDay);
	if (start.getTime() > now)
		start = new Date(d.getFullYear(), d.getMonth() - 1, cycleDay);
	const next = new Date(start.getFullYear(), start.getMonth() + 1, cycleDay);
	return { start: start.getTime(), next: next.getTime() };
}

/**
 * @param {RunningRun} run
 * @param {CostTable} table
 */
function reservationUsd(run, table) {
	if (run.spentUsd === null) return table.meanUsd;
	return Math.max(
		table.meanUsd,
		run.spentUsd + expectedRemainderUsd(run.spentUsd, table),
	);
}

/**
 * @param {{grantUsd: number, cycleDay: number, ledger: LedgerEntry[],
 *   running: RunningRun[], table: CostTable, now: number}} opts
 * @returns {Budget}
 */
function budgetOf({ grantUsd, cycleDay, ledger, running, table, now }) {
	const cycle = cycleOf(now, cycleDay);
	const inCycle = (/** @type {number} */ at) =>
		at >= cycle.start && at < cycle.next;
	const settledUsd = ledger
		.filter((e) => inCycle(e.endedAt))
		.reduce((t, e) => t + e.costUsd, 0);
	const exhausted = ledger.some(
		(e) => e.outcome === "key-exhausted" && inCycle(e.endedAt),
	);
	const reservedUsd = running.reduce((t, r) => t + reservationUsd(r, table), 0);
	const headroomUsd = grantUsd - settledUsd - reservedUsd;
	const qUsd = table.meanUsd;
	return {
		fit: exhausted ? 0 : Math.max(0, Math.floor(headroomUsd / qUsd)),
		headroomUsd,
		settledUsd,
		reservedUsd,
		grantUsd,
		qUsd,
		running: running.length,
		cycleStart: cycle.start,
		nextCycleStart: cycle.next,
		exhausted,
	};
}

module.exports = { budgetOf };
