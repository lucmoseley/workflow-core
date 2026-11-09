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
 * its own spend (#4369). One whose row falls outside the basis holds Q alone:
 * that spend came off another cycle or is already in the reading.
 *
 *   headroom = credit − settled spend − Σ running reservations
 *   fit      = floor(headroom / Q), or 0 on an exhausted key
 */

const { localDate } = require("./morning-review.js");
const { expectedRemainderUsd } = require("./session-spend.js");

/**
 * @typedef {import("./session-spend.js").CostTable} CostTable
 * @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup
 * @typedef {(mainFiles: string[]) => number} ReadChainSpendUsd the spend of
 *   transcripts, each request once: session-spend.js's readChainSpendUsd
 *
 * @typedef {object} LedgerEntry
 * @property {string} sessionId
 * @property {string|null} jobId
 * @property {number} endedAt ms, the session's latest transcript write
 * @property {number} bytes its transcripts' size when priced
 * @property {number} costUsd its cumulative cost at that size
 * @property {number} [sharedUsd] what that cost repeats from the members
 *   before it in its chain of resumed copies (#4370)
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
 * @property {string|null} expiresOn the earliest unexpired credit's expiry,
 *   YYYY-MM-DD; null with no reading or none unexpired
 * @property {number} qUsd the launch reservation
 * @property {number} running
 * @property {number} cycleStart ms
 * @property {number} nextCycleStart ms
 * @property {boolean} exhausted
 * @property {string} freeAgain when a spent key frees: the next cycle's local
 *   date, YYYY-MM-DD, with no reading, else `a newer Console reading`
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
		expiresOn: live.map((c) => c.expiresOn).sort()[0] ?? null,
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
				expiresOn: null,
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
		expiresOn: basis.expiresOn,
		qUsd,
		running: running.length,
		cycleStart: cycle.start,
		nextCycleStart: cycle.next,
		exhausted,
		freeAgain: reading
			? "a newer Console reading"
			: localDate(new Date(cycle.next)),
	};
}

/**
 * The session a chain of `--bg --resume` copies started from, and how many
 * copies deep a session is in it (#4195).
 * @param {OverflowLookup} lookup
 * @param {string} sessionId
 * @returns {{root: string, depth: number}}
 */
function chainOf(lookup, sessionId) {
	const seen = new Set([sessionId]);
	let id = sessionId;
	for (;;) {
		const parent = lookup({ sessionId: id })?.copyOf;
		if (!parent || seen.has(parent)) return { root: id, depth: seen.size - 1 };
		seen.add(parent);
		id = parent;
	}
}

/**
 * The session a chain of `--bg --resume` copies started from (#4195).
 * @param {OverflowLookup} lookup
 * @param {string} sessionId
 */
const chainRootOf = (lookup, sessionId) => chainOf(lookup, sessionId).root;

/**
 * What a session's transcript repeats from before a move put its chain on the
 * key, which a plan paid: its chain root's record, as each copy repeats the
 * root's history (#3736).
 * @param {OverflowLookup} lookup
 * @param {string} sessionId
 */
const offKeyOf = (lookup, sessionId) =>
	lookup({ sessionId: chainRootOf(lookup, sessionId) })?.offKeyUsd ?? 0;

/**
 * The ledger's rows grouped by chain root, each chain's root first and every
 * copy after its parent; copies at one depth by session id.
 * @param {OverflowLookup} lookup
 * @param {Iterable<LedgerEntry>} rows
 * @returns {Map<string, LedgerEntry[]>}
 */
function groupByChain(lookup, rows) {
	/** @type {Map<string, {row: LedgerEntry, depth: number}[]>} */
	const byRoot = new Map();
	for (const row of rows) {
		const { root, depth } = chainOf(lookup, row.sessionId);
		byRoot.set(root, [...(byRoot.get(root) ?? []), { row, depth }]);
	}
	/** @type {Map<string, LedgerEntry[]>} */
	const chains = new Map();
	for (const [root, members] of byRoot)
		chains.set(
			root,
			members
				.sort(
					(x, y) =>
						x.depth - y.depth || x.row.sessionId.localeCompare(y.row.sessionId),
				)
				.map((m) => m.row),
		);
	return chains;
}

/**
 * What each listed chain member's cost repeats from the members before it. A
 * copy repeats only history from before its fork, so the figure is fixed once
 * read with every member before it listed: where one of those has gone, the
 * row's last figure stands (#4370). A chain's root repeats nothing and gets
 * none. Residual: a member first read after an earlier member's transcript
 * went, or gone before it was ever read with them, has no figure, so its
 * repeated requests count twice.
 * @param {OverflowLookup} lookup
 * @param {Iterable<LedgerEntry>} rows
 * @param {Map<string, string>} files each listed session's main transcript
 * @param {ReadChainSpendUsd} readChainSpendUsd
 * @returns {[LedgerEntry, number][]}
 */
function readSharedUsd(lookup, rows, files, readChainSpendUsd) {
	return [...groupByChain(lookup, rows)].flatMap(([root, members]) => {
		if (members.length < 2) return [];
		const offKeyUsd = offKeyOf(lookup, root);
		return readChainSharedUsd(root, members, files, (listed) =>
			Math.max(0, readChainSpendUsd(listed) - offKeyUsd),
		);
	});
}

/**
 * `readSharedUsd` for one chain, its members in chain order.
 * @param {string} root
 * @param {LedgerEntry[]} members
 * @param {Map<string, string>} files
 * @param {ReadChainSpendUsd} readListedUsd the listed transcripts' spend, each
 *   request once, less what the root's move repeats from off the key
 * @returns {[LedgerEntry, number][]}
 */
function readChainSharedUsd(root, members, files, readListedUsd) {
	/** @type {[LedgerEntry, number][]} */
	const shared = [];
	/** @type {string[]} */
	const listed = [];
	let before = 0;
	let everyEarlierListed = true;
	for (const row of members) {
		const file = files.get(row.sessionId);
		if (file === undefined) {
			everyEarlierListed = false;
			continue;
		}
		listed.push(file);
		const after = readListedUsd(listed);
		if (row.sessionId !== root)
			shared.push([
				row,
				everyEarlierListed || row.sharedUsd === undefined
					? row.costUsd - (after - before)
					: row.sharedUsd,
			]);
		before = after;
	}
	return shared;
}

/**
 * A row's spend less what it repeats from its chain.
 * @param {LedgerEntry} e
 */
const chainShareOf = (e) => Math.max(0, e.costUsd - (e.sharedUsd ?? 0));

/**
 * Each session's spend with every copy in its chain, by session: a copy
 * repeats its parent's main-thread requests up to the fork, but neither the
 * parent's subagents nor what the parent spends after it, so a copy priced
 * alone could spend its allowance again (#4195).
 * @param {OverflowLookup} lookup
 * @param {LedgerEntry[]} ledger
 * @returns {Map<string, number>}
 */
function chainSpendOf(lookup, ledger) {
	const spent = new Map(ledger.map((e) => [e.sessionId, e.costUsd]));
	for (const members of groupByChain(lookup, ledger).values()) {
		if (members.length < 2) continue;
		const usd = members.reduce((t, e) => t + chainShareOf(e), 0);
		for (const e of members) spent.set(e.sessionId, Math.max(usd, e.costUsd));
	}
	return spent;
}

/**
 * The ledger with each row at its chain share, so a parent and its copies
 * settle the requests they share once (#4208), with one row per session.
 * @param {LedgerEntry[]} ledger
 * @returns {LedgerEntry[]}
 */
const settleChainsOnce = (ledger) =>
	ledger.map((e) => ({ ...e, costUsd: chainShareOf(e) }));

/**
 * Whether the key has no launch left, running runs aside: a credit refusal, or
 * less unsettled credit than one launch's reservation.
 * @param {Budget} budget
 */
const isBudgetSpent = ({ exhausted, creditUsd, settledUsd, qUsd }) =>
	exhausted || creditUsd - settledUsd < qUsd;

module.exports = {
	budgetOf,
	chainRootOf,
	chainSpendOf,
	isBudgetSpent,
	offKeyOf,
	readSharedUsd,
	settleChainsOnce,
};
