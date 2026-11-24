const { localDate } = require("./local-date.js");
const { expectedRemainderUsd } = require("./session-spend.js");

/**
 * @typedef {import("./session-spend.js").CostTable} CostTable
 * @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup
 * @typedef {(mainFiles: string[]) => number} ReadChainSpendUsd
 * @typedef {object} LedgerEntry
 * @property {string} sessionId
 * @property {string|null} jobId
 * @property {number} endedAt
 * @property {number} bytes
 * @property {number} costUsd
 * @property {number} [sharedUsd]
 * @property {string} outcome
 * @property {number} [refusedAt]
 * @typedef {object} RunningRun
 * @property {string} sessionId
 * @property {number|null} spentUsd
 * @property {number} [shareUsd]
 * @typedef {{remainingUsd: number, grantUsd: number, grantedOn: string,
 *   expiresOn: string}} Credit
 * @typedef {{at: number, credits: Credit[]}} ConsoleReading
 * @typedef {object} Budget
 * @property {number} fit
 * @property {number} headroomUsd
 * @property {number} settledUsd
 * @property {number} reservedUsd
 * @property {number} creditUsd
 * @property {number} grantUsd
 * @property {number|null} readAt
 * @property {string|null} expiresOn
 * @property {number} qUsd
 * @property {number} running
 * @property {number} cycleStart
 * @property {number} nextCycleStart
 * @property {boolean} exhausted
 * @property {string} freeAgain
 */

/**
 * @param {number} now
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
 * @param {OverflowLookup} lookup
 * @param {string} sessionId
 */
const chainRootOf = (lookup, sessionId) => chainOf(lookup, sessionId).root;

/**
 * @param {OverflowLookup} lookup
 * @param {string} sessionId
 */
const offKeyOf = (lookup, sessionId) =>
	lookup({ sessionId: chainRootOf(lookup, sessionId) })?.offKeyUsd ?? 0;

/**
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
 * @param {OverflowLookup} lookup
 * @param {Iterable<LedgerEntry>} rows
 * @param {Map<string, string>} files
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
 * @param {string} root
 * @param {LedgerEntry[]} members
 * @param {Map<string, string>} files
 * @param {ReadChainSpendUsd} readListedUsd
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

/** @param {LedgerEntry} e */
const chainShareOf = (e) => Math.max(0, e.costUsd - (e.sharedUsd ?? 0));

/**
 * @param {OverflowLookup} lookup
 * @param {LedgerEntry[]} ledger
 * @param {Map<string, number>} [replyUsd]
 * @returns {Map<string, number>}
 */
function chainSpendOf(lookup, ledger, replyUsd = new Map()) {
	const spent = new Map();
	for (const members of groupByChain(lookup, ledger).values()) {
		const replies = members.reduce(
			(t, e) => t + (replyUsd.get(e.sessionId) ?? 0),
			0,
		);
		const usd =
			members.length < 2
				? 0
				: members.reduce((t, e) => t + chainShareOf(e), 0) - replies;
		for (const e of members)
			spent.set(e.sessionId, Math.max(0, usd, e.costUsd - replies));
	}
	return spent;
}

/**
 * @param {{sessionId: string, launchedAt: number, founderReply?: true}[]} runs
 * @returns {{sessionId: string, fromMs: number, toMs: number}[]}
 */
const replyWindowsOf = (runs) =>
	runs
		.filter((r) => r.founderReply === true)
		.map((reply) => ({
			sessionId: reply.sessionId,
			fromMs: reply.launchedAt,
			toMs:
				Math.min(
					...runs
						.filter(
							(r) =>
								r.sessionId === reply.sessionId &&
								r.launchedAt > reply.launchedAt,
						)
						.map((r) => r.launchedAt),
				) - 1,
		}));

/**
 * @param {LedgerEntry[]} ledger
 * @returns {LedgerEntry[]}
 */
const settleChainsOnce = (ledger) =>
	ledger.map((e) => ({ ...e, costUsd: chainShareOf(e) }));

/** @param {Budget} budget */
const isBudgetSpent = ({ exhausted, creditUsd, settledUsd, qUsd }) =>
	exhausted || creditUsd - settledUsd < qUsd;

module.exports = {
	budgetOf,
	chainRootOf,
	chainSpendOf,
	isBudgetSpent,
	offKeyOf,
	readSharedUsd,
	replyWindowsOf,
	settleChainsOnce,
};
