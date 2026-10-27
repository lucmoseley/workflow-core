/*
 * overflow-budget.js — how many sessions fit on an overflow seat's key this
 * billing cycle (workflow-core#2609, spec workflow-core#2570 §Budget gate), sized by
 * lib/overflow-budget-core.js.
 *
 * SETTLEMENT: every read, `refill-loop.js status` included, first settles
 * each ended run of the seat (lib/headless-sessions.js) once into a durable
 * per-key ledger beside the refill loop's files.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { endResultOf, readStoredRuns } = require("./headless-sessions.js");
const { localDate } = require("./morning-review.js");
const { refillPath } = require("./refill-dir.js");
const { readDeclaredSeats, seatOf } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { budgetOf } = require("./overflow-budget-core.js");
const { readCostTable, sessionSpendUsd } = require("./session-spend.js");
const { findTranscript } = require("./transcript.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {import("./refill-seats.js").OverflowSeat} OverflowSeat
 * @typedef {import("./session-spend.js").CostTable} CostTable
 * @typedef {import("./headless-sessions.js").RunRecord} RunRecord
 * @typedef {import("./overflow-budget-core.js").LedgerEntry} LedgerEntry
 * @typedef {import("./overflow-budget-core.js").RunningRun} RunningRun
 * @typedef {import("./overflow-budget-core.js").Budget} Budget
 */

/** @param {OverflowSeat} seat */
const ledgerFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.jsonl`));

/**
 * The key's ledger.
 * @param {OverflowSeat} seat
 * @returns {LedgerEntry[]}
 */
function readLedger(seat) {
	let text;
	try {
		text = fs.readFileSync(ledgerFile(seat), "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	/** @type {Map<string, LedgerEntry>} */
	const bySession = new Map();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		/** @type {LedgerEntry} */
		const e = JSON.parse(line);
		if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, e);
	}
	return [...bySession.values()];
}

/**
 * The run's last log write. The launch creates the log, so one that cannot be
 * stat'd falls to the settle time: an exhaustion read late still marks the
 * cycle it was read in, never an earlier one.
 * @param {RunRecord} run
 */
function endedAtOf(run) {
	const times = [run.log, run.stderr].flatMap((f) => {
		try {
			return [fs.statSync(f).mtimeMs];
		} catch {
			return [];
		}
	});
	return times.length > 0 ? Math.max(...times) : Date.now();
}

/**
 * @param {OverflowSeat} seat
 * @param {string} sessionId
 */
function transcriptSpendUsd(seat, sessionId) {
	const file = findTranscript(seat.dir, sessionId);
	return file ? sessionSpendUsd(file) : null;
}

/**
 * An ended run's cost: its last `result`'s, else its transcript priced, else Q.
 * @param {OverflowSeat} seat
 * @param {string} sessionId
 * @param {number|null} resultUsd
 * @param {CostTable} table
 * @returns {Pick<LedgerEntry, "costUsd"|"costSource">}
 */
function settledCost(seat, sessionId, resultUsd, table) {
	if (resultUsd !== null) return { costUsd: resultUsd, costSource: "result" };
	const transcriptUsd = transcriptSpendUsd(seat, sessionId);
	if (transcriptUsd !== null)
		return { costUsd: transcriptUsd, costSource: "transcript" };
	return { costUsd: table.meanUsd, costSource: "reservation" };
}

/**
 * Settle the seat's ended runs into its ledger. Two callers settling one run
 * at once each append a line; the read keeps the first.
 * @param {OverflowSeat} seat
 * @param {CostTable} table
 * @returns {{ledger: LedgerEntry[], running: RunningRun[]}}
 * @throws where the run store or the ledger cannot be read or written
 */
function settle(seat, table) {
	const ledger = readLedger(seat);
	const settled = new Set(ledger.map((e) => e.sessionId));
	/** @type {RunningRun[]} */
	const running = [];
	for (const run of readStoredRuns()) {
		if (run.seat !== seat.dir || settled.has(run.sessionId)) continue;
		const end = endResultOf(run);
		if (end.outcome === "running") {
			/* A `-p` run's `result` usually comes only at its end, so the
			 * transcript is the live figure. */
			running.push({
				sessionId: run.sessionId,
				spentUsd: transcriptSpendUsd(seat, run.sessionId) ?? end.costUsd,
			});
			continue;
		}
		/** @type {LedgerEntry} */
		const entry = {
			sessionId: run.sessionId,
			jobId: run.jobId,
			launchedAt: run.launchedAt,
			endedAt: endedAtOf(run),
			...settledCost(seat, run.sessionId, end.costUsd, table),
			outcome: end.outcome,
		};
		fs.mkdirSync(path.dirname(ledgerFile(seat)), { recursive: true });
		fs.appendFileSync(ledgerFile(seat), `${JSON.stringify(entry)}\n`);
		ledger.push(entry);
	}
	return { ledger, running };
}

/**
 * Settle the seat, then size its budget; why not where either cannot be read.
 * @param {OverflowSeat} seat
 * @returns {Budget|{why: string}}
 */
function seatBudget(seat) {
	const table = readCostTable();
	if (!table) return { why: "the session cost table is unreadable" };
	let settled;
	try {
		settled = settle(seat, table);
	} catch (err) {
		return { why: caught(err).message };
	}
	return budgetOf({
		grantUsd: seat.grantUsd,
		cycleDay: seat.cycleDay,
		table,
		now: Date.now(),
		...settled,
	});
}

/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2)}`;

/**
 * @param {OverflowSeat} seat
 * @param {Budget|{why: string}} budget
 */
function buildBudgetLine(seat, budget) {
	if ("why" in budget) return `overflow ${seat.dir}: unread — ${budget.why}`;
	const resets = localDate(new Date(budget.nextCycleStart));
	const spent = `spent ${dollars(budget.settledUsd)} of ${dollars(budget.grantUsd)} since ${localDate(new Date(budget.cycleStart))}`;
	if (budget.exhausted)
		return `overflow ${seat.dir}: exhausted until ${resets}; headroom ${dollars(budget.headroomUsd)}; ${spent}`;
	return `overflow ${seat.dir}: fits ${budget.fit}; headroom ${dollars(budget.headroomUsd)} (${dollars(budget.reservedUsd)} held by ${budget.running} running); ${spent}; resets ${resets}`;
}

module.exports = { buildBudgetLine, seatBudget };

/*
 * CLI mode, for the dispatcher and status. Exit 0 sized, 2 usage, 1 otherwise:
 * a seat file that refuses, a seat that is not overflow, an unreadable table.
 *
 *   [--json] <config dir>   the seat's status line, or its Budget as JSON
 */
/**
 * @param {string[]} args
 * @returns {number}
 */
function main(args) {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: { json: { type: "boolean" } },
		});
	} catch {
		parsed = null;
	}
	const dir = parsed?.positionals[0];
	if (!parsed || !dir || parsed.positionals.length !== 1) {
		writeFd(
			2,
			`usage: node ${scriptPath("lib/overflow-budget.js")} [--json] <config dir>\n`,
		);
		return 2;
	}
	const list = readDeclaredSeats();
	if (list.errors.length > 0) {
		writeFd(2, `${list.errors.join("\n")}\n`);
		return 1;
	}
	const seat = seatOf(list, dir);
	if (seat.kind !== "overflow") {
		writeFd(2, `${seat.dir} is not an overflow seat in the seat file\n`);
		return 1;
	}
	const budget = seatBudget(seat);
	if ("why" in budget) {
		writeFd(2, `${budget.why}\n`);
		return 1;
	}
	const out = parsed.values.json
		? JSON.stringify(budget)
		: buildBudgetLine(seat, budget);
	writeFd(1, `${out}\n`);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
