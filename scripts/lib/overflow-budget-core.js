/*
 * overflow-budget-core.js — the budget gate's pure core: how many sessions fit
 * on an overflow key, from its ledger, its running runs, the session cost
 * table and the time (#2609, spec #2570 story 45).
 *
 * ANCHOR: with a Console reading (lib/console-credit.js) the key has what the
 * reading's unexpired grants held, less the sessions last written since, and one
 * ended on a credit refusal since then marks it exhausted until a newer reading.
 * A grant expires at 00:00 UTC on its expiry date, the Console's dates being UTC.
 *
 * CYCLE: with no reading yet, the key has its configured grant, less the sessions
 * last written since the most recent `cycle-day` at local midnight, where their
 * last requests were billed, and a credit refusal marks it exhausted until the
 * next cycle.
 *
 * RESERVATIONS, against requests and never live usage
 * (docs/practice/capacity-planning-and-admission.md): each running session holds
 * max(Q, spent so far + session-spend's expected remainder), and a new launch
 * holds Q, the cost table's `meanUsd` — read, never a constant (#2570). A running
 * session's ledger row is held, not settled, so a session counts once (#3695); a
 * resumed copy's spend there is its chain share, the remainder still read from
 * its own spend (#4369). One
 * whose row falls outside the basis holds Q alone: that spend came off another
 * cycle or is already in the reading.
 *
 *   headroom = credit − settled spend − Σ running reservations
 *   fit      = floor(headroom / Q), or 0 on an exhausted key
 */

const { expectedRemainderUsd } = require("./session-spend.js");

/**
 * @typedef {import("./session-spend.js").CostTable} CostTable
 *
 * @typedef {object} LedgerEntry
 * @property {string} sessionId
 * @property {string|null} jobId
 * @property {number} endedAt ms, the session's latest transcript write
 * @property {number} bytes its transcripts' size when priced
 * @property {number} costUsd its cumulative cost at that size
 * @property {string} outcome `key-exhausted`: its latest API answer was a credit
 *   refusal
 * @property {number} [refusedAt] ms, that refusal's time; absent, `endedAt` stands
 *
 * @typedef {object} RunningRun
 * @property {string} sessionId
 * @property {number|null} spentUsd its cumulative spend, null before a transcript
 * @property {number} [shareUsd] what it adds to the members of its chain of
 *   resumed copies before it (#4369); absent, `spentUsd` stands
 *
 * @typedef {{remainingUsd: number, grantUsd: number, grantedOn: string,
 *   expiresOn: string}} Credit a Promotional credits row, its dates YYYY-MM-DD
 * @typedef {{at: number, credits: Credit[]}} ConsoleReading
 *
 * @typedef {object} Budget
 * @property {number} fit sessions that fit on the key now
 * @property {number} headroomUsd
 * @property {number} settledUsd settled spend since the reading, else this cycle
 * @property {number} reservedUsd held by running runs
 * @property {number} creditUsd the unexpired credit at the reading, else the grant
 * @property {number} grantUsd the unexpired grants' size, else the configured grant
 * @property {number|null} readAt ms, the reading's time; null with none
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
		(run.shareUsd ?? run.spentUsd) + expectedRemainderUsd(run.spentUsd, table),
	);
}

/**
 * What the key holds and which runs come off it, with a reading.
 * @param {ConsoleReading} reading
 * @param {number} now
 */
function anchoredBasis({ at, credits }, now) {
	const live = credits.filter(
		(c) => Date.parse(`${c.expiresOn}T00:00:00Z`) > now,
	);
	return {
		creditUsd: live.reduce((t, c) => t + c.remainingUsd, 0),
		grantUsd: live.reduce((t, c) => t + c.grantUsd, 0),
		isCounted: (/** @type {number} */ endedAt) => endedAt > at,
	};
}

/**
 * @param {{grantUsd: number, cycleDay: number, ledger: LedgerEntry[],
 *   running: RunningRun[], table: CostTable, now: number,
 *   reading?: ConsoleReading|null}} opts
 * @returns {Budget}
 */
function budgetOf({
	grantUsd,
	cycleDay,
	ledger,
	running,
	table,
	now,
	reading,
}) {
	const cycle = cycleOf(now, cycleDay);
	const basis = reading
		? anchoredBasis(reading, now)
		: {
				creditUsd: grantUsd,
				grantUsd,
				isCounted: (/** @type {number} */ endedAt) =>
					endedAt >= cycle.start && endedAt < cycle.next,
			};
	const { creditUsd, isCounted } = basis;
	const held = new Set(running.map((r) => r.sessionId));
	const settledUsd = ledger
		.filter((e) => !held.has(e.sessionId) && isCounted(e.endedAt))
		.reduce((t, e) => t + e.costUsd, 0);
	const exhausted = ledger.some(
		(e) => e.outcome === "key-exhausted" && isCounted(e.refusedAt ?? e.endedAt),
	);
	const lastWrite = new Map(ledger.map((e) => [e.sessionId, e.endedAt]));
	const reservedUsd = running.reduce((t, r) => {
		const at = lastWrite.get(r.sessionId);
		const spentUsd = at === undefined || isCounted(at) ? r.spentUsd : null;
		return t + reservationUsd({ ...r, spentUsd }, table);
	}, 0);
	const headroomUsd = creditUsd - settledUsd - reservedUsd;
	const qUsd = table.meanUsd;
	return {
		fit: exhausted ? 0 : Math.max(0, Math.floor(headroomUsd / qUsd)),
		headroomUsd,
		settledUsd,
		reservedUsd,
		creditUsd,
		grantUsd: basis.grantUsd,
		readAt: reading?.at ?? null,
		qUsd,
		running: running.length,
		cycleStart: cycle.start,
		nextCycleStart: cycle.next,
		exhausted,
	};
}

/**
 * Whether the key has no launch left, running runs aside: a credit refusal, or
 * less unsettled credit than one launch's reservation.
 * @param {Budget} budget
 */
const isBudgetSpent = ({ exhausted, creditUsd, settledUsd, qUsd }) =>
	exhausted || creditUsd - settledUsd < qUsd;

module.exports = { budgetOf, isBudgetSpent };
