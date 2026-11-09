/*
 * overflow-budget.js — how many sessions fit on an overflow seat's key this
 * billing cycle (#2609, spec #2570 §Budget gate), sized by
 * lib/overflow-budget-core.js from the key's Console reading where it has one
 * (lib/console-credit.js).
 *
 * SPEND IS TRANSCRIPTS ALONE (#3695): every read, `refill-loop.js status`
 * included, prices again each session on the key whose transcript has grown,
 * into a durable per-key ledger of one row per session beside the refill loop's
 * files. Only the launch record marks a session in the seat's dir as on the key.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { isTerminalAgent, readAgentsForBudget } = require("./agent-liveness.js");
const { CREDIT_REFUSAL, readStoredRuns } = require("./headless-runs.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readConsoleLog } = require("./console-credit.js");
const { readEveryOverflowLookup } = require("./dispatch-ledger.js");
const { hostRoot } = require("./host-root.js");
const { readJsonl } = require("./jsonl.js");
const { localDate } = require("./local-date.js");
const { pidLock, waitForLock } = require("./pid-lock.js");
const { readSeatTranscripts } = require("./project-dirs.js");
const { refillPath } = require("./refill-dir.js");
const {
	buildSeatLabel,
	findOverflowSeat,
	readDeclaredSeats,
} = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const {
	budgetOf,
	offKeyOf,
	readSharedUsd,
	settleChainsOnce,
} = require("./overflow-budget-core.js");
const {
	fileSpend,
	readChainSpendUsd,
	readCostTableIn,
	readSessionFiles,
	sessionSpendUsd,
} = require("./session-spend.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {import("./refill-seats.js").OverflowSeat} OverflowSeat
 * @typedef {import("./overflow-budget-core.js").LedgerEntry} LedgerEntry
 * @typedef {import("./overflow-budget-core.js").RunningRun} RunningRun
 * @typedef {import("./overflow-budget-core.js").Budget} Budget
 * @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup
 * @typedef {Budget & {readFailure: string|null, lastAttemptAt: number|null,
 *   runningReadAt: number|null}} SeatBudget `runningReadAt`, ms, when the
 *   listing that counted `running` was read; null where it carried no time
 */

/* The API's refusal for credit, as the harness writes it into a transcript:
 * `isApiErrorMessage` with `error: "billing_error"`, or lib/headless-runs.js's
 * CREDIT_REFUSAL text. The flag keeps out a session merely quoting the words. */
/* The `entrypoint` an interactive session's transcript rows carry, a `--bg`
 * job's included; a `claude -p` run's carry `sdk-cli` (2.1.319, measured
 * 2026-11-06). */
const INTERACTIVE_ENTRYPOINT = "cli";

/* The scripts a ledger's lock holder runs; any other's lock reads as stale. */
const BUDGET_READERS = [
	"overflow-budget.js",
	"overflow-view.js",
	"refill-loop.js",
];

/** @param {OverflowSeat} seat */
const ledgerFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.jsonl`));

/**
 * The key's ledger, by session.
 * @param {OverflowSeat} seat
 * @returns {Map<string, LedgerEntry>}
 */
function readLedger(seat) {
	const rows = /** @type {LedgerEntry[]} */ (
		readJsonl(ledgerFile(seat))?.rows ?? []
	);
	return new Map(rows.map((e) => [e.sessionId, e]));
}

/**
 * Each session's main transcript under the dir.
 * @param {string} dir a config dir
 * @returns {{sessionId: string, file: string}[]}
 * @throws where a project dir will not read: its sessions must not read as free
 */
function readTranscripts(dir) {
	const { files, unreadable } = readSeatTranscripts([dir]);
	if (unreadable.length > 0)
		throw new Error(`cannot list ${unreadable.join(", ")}`);
	return files.map((file) => ({
		sessionId: path.basename(file, ".jsonl"),
		file,
	}));
}

/**
 * The session's transcripts' size, and their latest write.
 * @param {string} mainFile
 */
function readTranscriptStat(mainFile) {
	const stats = readSessionFiles(mainFile).flatMap((f) => {
		const stat = fs.statSync(f, { throwIfNoEntry: false });
		return stat ? [stat] : [];
	});
	return {
		bytes: stats.reduce((t, s) => t + s.size, 0),
		endedAt: Math.max(...stats.map((s) => s.mtimeMs)),
	};
}

/**
 * Whether an API error row is a credit refusal of the key: never one from an
 * interactive session (readFileCreditRefusal).
 * @param {Record<string, unknown>} row
 * @param {{content?: unknown}} message
 */
const isKeyRefusal = (row, message) =>
	row.entrypoint !== INTERACTIVE_ENTRYPOINT &&
	(row.error === "billing_error" ||
		CREDIT_REFUSAL.test(JSON.stringify(message.content ?? "")));

/**
 * When a transcript's latest answer from the API was a credit refusal, or null
 * for none: a model turn since means the key had credit after it, and a
 * synthetic line is no answer. A refusal in an interactive session, a `--bg`
 * job among them, is none: a plan's API credits never cover that route
 * (#4578), so its refusal says nothing of what the key has left.
 * @param {string} file
 * @returns {{at: number}|null} `at` is NaN for a refusal that carries no timestamp
 */
function readFileCreditRefusal(file) {
	/** @type {{at: number}|null} */
	let refused = null;
	for (const row of readJsonl(file)?.rows ?? []) {
		if (row.type !== "assistant") continue;
		const message = /** @type {{model?: string, content?: unknown}} */ (
			row.message ?? {}
		);
		if (row.isApiErrorMessage === true) {
			if (isKeyRefusal(row, message))
				refused = { at: Date.parse(String(row.timestamp)) };
		} else if (message.model !== "<synthetic>") refused = null;
	}
	return refused;
}

/**
 * A session's ledger outcome from its transcripts, a subagent's as well as its
 * own. A later line must not carry a refusal into a later cycle, so the mark's
 * time is the refusal's own; one with no timestamp falls to the row's `endedAt`.
 * @param {string} mainFile
 * @returns {Pick<LedgerEntry, "outcome"|"refusedAt">}
 */
function readRefusalOutcome(mainFile) {
	const refusals = readSessionFiles(mainFile).flatMap((f) => {
		const refusal = readFileCreditRefusal(f);
		return refusal ? [refusal.at] : [];
	});
	if (refusals.length === 0) return { outcome: "priced" };
	const stamped = refusals.filter((at) => !Number.isNaN(at));
	return {
		outcome: "key-exhausted",
		...(stamped.length > 0 ? { refusedAt: Math.max(...stamped) } : {}),
	};
}

/**
 * Price again each session on the key whose transcript has grown, and what it
 * repeats from its chain (`sharedUsd`), under the ledger's lock: a row a
 * concurrent read dropped could not be priced back once its transcript has
 * gone. A row outlives its transcript.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @returns {LedgerEntry[]}
 * @throws where a transcript or the ledger cannot be read, written or locked
 */
function priceSessions(seat, lookup) {
	fs.mkdirSync(path.dirname(ledgerFile(seat)), { recursive: true });
	const lock = pidLock(`${ledgerFile(seat)}.lock`, BUDGET_READERS);
	if (!waitForLock(lock))
		throw new Error(`pid ${lock.holder()} holds ${ledgerFile(seat)}.lock`);
	try {
		const ledger = readLedger(seat);
		const transcripts = readTranscripts(seat.dir);
		let changed = false;
		for (const { sessionId, file } of transcripts) {
			const launch = lookup({ sessionId });
			if (launch?.keyVar !== seat.keyVar) continue;
			const stat = readTranscriptStat(file);
			const prior = ledger.get(sessionId);
			if (prior?.bytes === stat.bytes) continue;
			ledger.set(sessionId, {
				...(prior?.sharedUsd === undefined
					? {}
					: { sharedUsd: prior.sharedUsd }),
				sessionId,
				jobId: launch.jobId,
				...stat,
				costUsd: Math.max(
					0,
					sessionSpendUsd(file) - offKeyOf(lookup, sessionId),
				),
				...readRefusalOutcome(file),
			});
			changed = true;
		}
		const files = new Map(transcripts.map((t) => [t.sessionId, t.file]));
		for (const [row, sharedUsd] of readSharedUsd(
			lookup,
			ledger.values(),
			files,
			readChainSpendUsd,
		)) {
			if (row.sharedUsd === sharedUsd) continue;
			ledger.set(row.sessionId, { ...row, sharedUsd });
			changed = true;
		}
		if (changed)
			writeFileAtomic(
				ledgerFile(seat),
				[...ledger.values()].map((e) => `${JSON.stringify(e)}\n`).join(""),
			);
		return [...ledger.values()];
	} finally {
		lock.release();
	}
}

/**
 * What the founder's replies on the key spent, by the session each resumed
 * (#4668): its transcripts' requests from the reply's launch to the next run
 * of that session, or to now. A request with no timestamp counts as the
 * session's own.
 * @param {OverflowSeat} seat
 * @returns {Map<string, number>}
 * @throws where the run store or a transcript dir cannot be read
 */
function readReplyUsd(seat) {
	const runs = readStoredRuns().filter((r) => r.keyVar === seat.keyVar);
	const replies = runs.filter((r) => r.founderReply === true);
	/** @type {Map<string, number>} */
	const usd = new Map();
	if (replies.length === 0) return usd;
	const files = new Map(
		readTranscripts(seat.dir).map((t) => [t.sessionId, t.file]),
	);
	for (const reply of replies) {
		const file = files.get(reply.sessionId);
		if (file === undefined) continue;
		const window = {
			fromMs: reply.launchedAt,
			toMs: Math.min(
				...runs
					.filter(
						(r) =>
							r.sessionId === reply.sessionId &&
							r.launchedAt > reply.launchedAt,
					)
					.map((r) => r.launchedAt),
			),
		};
		const spent = readSessionFiles(file).reduce(
			(t, f) => t + fileSpend(f, { window }).usd,
			0,
		);
		usd.set(reply.sessionId, (usd.get(reply.sessionId) ?? 0) + spent);
	}
	return usd;
}

/**
 * The key's sessions the listing holds running, and when it was read.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @param {() => import("./agent-liveness.js").Listing} readAgents
 * @returns {{sessionIds: string[], readAt: number|null}}
 * @throws where the listing cannot be read: a key's running sessions must not
 *   read as none
 */
function readRunning(seat, lookup, readAgents) {
	const listing = readAgents();
	if (listing.why !== undefined) throw new Error(listing.why);
	return {
		sessionIds: listing.agents
			.filter(
				(a) =>
					!isTerminalAgent(a) &&
					lookup({ jobId: a.id, sessionId: a.sessionId })?.keyVar ===
						seat.keyVar,
			)
			.map((a) => a.sessionId),
		readAt: listing.readAt ?? null,
	};
}

/**
 * Running sessions, each at its ledger row's spend and its chain share (#4369).
 * @param {string[]} sessionIds
 * @param {LedgerEntry[]} ledger
 * @param {LedgerEntry[]} chainPriced the ledger, its chain members at their
 *   shares
 * @returns {RunningRun[]}
 */
function priceRunning(sessionIds, ledger, chainPriced) {
	const spent = new Map(ledger.map((e) => [e.sessionId, e.costUsd]));
	const share = new Map(chainPriced.map((e) => [e.sessionId, e.costUsd]));
	return sessionIds.map((sessionId) => ({
		sessionId,
		spentUsd: spent.get(sessionId) ?? null,
		shareUsd: share.get(sessionId),
	}));
}

/**
 * Price the seat, then size its budget; why not where either cannot be read.
 * The cost table is read in `root`, never the working directory's checkout:
 * the loop's daemon runs from the home directory (#3683).
 * @param {OverflowSeat} seat
 * @param {string|undefined} root the checkout whose cost table sizes the seat
 * @param {() => import("./agent-liveness.js").Listing} [readAgents] the
 *   listing's reader, `readAgentsForDisplay` where the budget is only shown
 * @returns {SeatBudget|{why: string}}
 */
function seatBudget(seat, root, readAgents = readAgentsForBudget) {
	if (root === undefined)
		return { why: "the loop serves no checkout to read the cost table in" };
	const table = readCostTableIn(root);
	if (!table) return { why: "the session cost table is unreadable" };
	let ledger;
	let running;
	let settled;
	let log;
	let listed;
	try {
		const lookup = readEveryOverflowLookup();
		ledger = priceSessions(seat, lookup);
		settled = settleChainsOnce(ledger);
		listed = readRunning(seat, lookup, readAgents);
		running = priceRunning(listed.sessionIds, ledger, settled);
		log = readConsoleLog(seat);
	} catch (err) {
		return { why: caught(err).message };
	}
	return {
		...budgetOf({
			grantUsd: seat.grantUsd,
			cycleDay: seat.cycleDay,
			table,
			now: Date.now(),
			reading: log.reading,
			ledger: settled,
			running,
		}),
		readFailure: log.failure,
		lastAttemptAt: log.lastAttemptAt,
		runningReadAt: listed.readAt,
	};
}

/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2)}`;

/**
 * @param {OverflowSeat} seat
 * @param {SeatBudget|{why: string}} budget
 */
function buildBudgetLine(seat, budget) {
	const label = `overflow ${buildSeatLabel(seat)}`;
	if ("why" in budget) return `${label}: unread — ${budget.why}`;
	const failed = budget.readFailure
		? `; last Console read failed: ${budget.readFailure}`
		: "";
	const headroom = `headroom ${dollars(budget.headroomUsd)} (${dollars(budget.reservedUsd)} held by ${budget.running} running)`;
	if (budget.readAt !== null) {
		const spent = `${dollars(budget.creditUsd)} of ${dollars(budget.grantUsd)} on the Console at ${new Date(budget.readAt).toISOString()}, ${dollars(budget.settledUsd)} spent since`;
		const expires = budget.expiresOn ? `; expires ${budget.expiresOn}` : "";
		const state = budget.exhausted
			? `exhausted until ${budget.freeAgain}`
			: `fits ${budget.fit}`;
		return `${label}: ${state}; ${headroom}; ${spent}${expires}${failed}`;
	}
	const spent = `spent ${dollars(budget.settledUsd)} of ${dollars(budget.grantUsd)} since ${localDate(new Date(budget.cycleStart))}`;
	if (budget.exhausted)
		return `${label}: exhausted until ${budget.freeAgain}; headroom ${dollars(budget.headroomUsd)}; ${spent}${failed}`;
	return `${label}: fits ${budget.fit}; ${headroom}; ${spent}; resets ${budget.freeAgain}${failed}`;
}

/*
 * CLI mode, for the dispatcher and status. Exit 0 sized, 2 usage, 1 otherwise:
 * a seat file that refuses, a key no overflow seat has, an unreadable table.
 *
 *   [--json] <key var>   the seat's status line, or its Budget as JSON
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
	const keyVar = parsed?.positionals[0];
	if (!parsed || !keyVar || parsed.positionals.length !== 1) {
		writeFd(
			2,
			`usage: node ${scriptPath("lib/overflow-budget.js")} [--json] <key var>\n`,
		);
		return 2;
	}
	const list = readDeclaredSeats();
	if (list.errors.length > 0) {
		writeFd(2, `${list.errors.join("\n")}\n`);
		return 1;
	}
	const seat = findOverflowSeat(list, keyVar);
	if (!seat) {
		writeFd(2, `${keyVar} is not an overflow seat's key in the seat file\n`);
		return 1;
	}
	const budget = seatBudget(seat, hostRoot());
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

module.exports = {
	buildBudgetLine,
	dollars,
	priceSessions,
	readReplyUsd,
	seatBudget,
};
