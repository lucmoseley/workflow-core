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
 *
 * THE PER-SESSION CAP (#3698): `--max-budget-usd` works only with `--print`, so
 * each refill tick stops a listed session whose spend, with its chain of
 * resumed copies' (#4195), has reached the allowance its launch recorded, with
 * `claude stop` on the seat's dir, which keeps the conversation. Each chain is
 * capped once, so a founder's reply to it afterwards runs uncapped (spec #3691
 * §Out of Scope). Residual: one that
 * ended on its own, reaped before a tick saw it, carries no mark, so the
 * first reply that takes it past its allowance is stopped once (#4174).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { isTerminalAgent, readAgentsForBudget } = require("./agent-liveness.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { stopOn } = require("./claude-stop.js");
const { readConsoleLog } = require("./console-credit.js");
const { readEveryOverflowLookup } = require("./dispatch-ledger.js");
const { hostRoot } = require("./host-root.js");
const { shortJobId } = require("./job-paths.js");
const { readJsonl } = require("./jsonl.js");
const { localDate } = require("./morning-review.js");
const { pidLock, waitForLock } = require("./pid-lock.js");
const { readSeatTranscripts } = require("./project-dirs.js");
const { refillPath } = require("./refill-dir.js");
const { findOverflowSeat, readDeclaredSeats } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { budgetOf } = require("./overflow-budget-core.js");
const {
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
 * @typedef {ReturnType<typeof readEveryOverflowLookup>} OverflowLookup
 * @typedef {Budget & {readFailure: string|null, lastAttemptAt: number|null}} SeatBudget
 */

/* The API's refusal for credit, as the harness writes it into a transcript:
 * `isApiErrorMessage` with `error: "billing_error"`, the text below. The flag
 * keeps out a session merely quoting the words. */
const CREDIT_REFUSAL = /credit balance is too low/i;

/* The scripts a ledger's lock holder runs; any other's lock reads as stale. */
const BUDGET_READERS = ["overflow-budget.js", "refill-loop.js"];

/** @param {OverflowSeat} seat */
const ledgerFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.jsonl`));

/** @param {OverflowSeat} seat */
const cappedFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.capped.jsonl`));

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
 * When a transcript's latest answer from the API was a credit refusal, or null
 * for none: a model turn since means the key had credit after it, and a
 * synthetic line is no answer.
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
			if (
				row.error === "billing_error" ||
				CREDIT_REFUSAL.test(JSON.stringify(message.content ?? ""))
			)
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
 * Price again each session on the key whose transcript has grown, under the
 * ledger's lock: a row a concurrent read dropped could not be priced back once
 * its transcript has gone. A row outlives its transcript.
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
		let changed = false;
		for (const { sessionId, file } of readTranscripts(seat.dir)) {
			const launch = lookup({ sessionId });
			if (launch?.keyVar !== seat.keyVar) continue;
			const stat = readTranscriptStat(file);
			if (ledger.get(sessionId)?.bytes === stat.bytes) continue;
			ledger.set(sessionId, {
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
 * The key's sessions the listing holds running.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @param {() => import("./agent-liveness.js").Listing} readAgents
 * @returns {string[]}
 * @throws where the listing cannot be read: a key's running sessions must not
 *   read as none
 */
function readRunning(seat, lookup, readAgents) {
	const listing = readAgents();
	if (listing.why !== undefined) throw new Error(listing.why);
	return listing.agents
		.filter(
			(a) =>
				!isTerminalAgent(a) &&
				lookup({ jobId: a.id, sessionId: a.sessionId })?.keyVar === seat.keyVar,
		)
		.map((a) => a.sessionId);
}

/**
 * Running sessions, each at its ledger row's spend and its chain share (#4369).
 * @param {string[]} sessionIds
 * @param {LedgerEntry[]} ledger
 * @param {LedgerEntry[]} settled the ledger, its chain members at their shares
 * @returns {RunningRun[]}
 */
function priceRunning(sessionIds, ledger, settled) {
	const spent = new Map(ledger.map((e) => [e.sessionId, e.costUsd]));
	const share = new Map(settled.map((e) => [e.sessionId, e.costUsd]));
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
	try {
		const lookup = readEveryOverflowLookup();
		ledger = priceSessions(seat, lookup);
		settled = settleChainsOnce(seat, lookup, ledger);
		running = priceRunning(
			readRunning(seat, lookup, readAgents),
			ledger,
			settled,
		);
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
	};
}

/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2)}`;

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
 * The key's sessions grouped by chain root, each chain's root first and every
 * copy after its parent, with each session's transcript where it is listed and
 * its ledger row's spend.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @param {LedgerEntry[]} ledger
 * @throws where the dir's project dirs will not list
 */
function readChains(seat, lookup, ledger) {
	const files = new Map(
		readTranscripts(seat.dir).map((t) => [t.sessionId, t.file]),
	);
	const spent = new Map(ledger.map((e) => [e.sessionId, e.costUsd]));
	/** @type {Map<string, {sessionId: string, depth: number}[]>} */
	const byRoot = new Map();
	for (const sessionId of new Set([...files.keys(), ...spent.keys()])) {
		if (lookup({ sessionId })?.keyVar !== seat.keyVar) continue;
		const { root, depth } = chainOf(lookup, sessionId);
		byRoot.set(root, [...(byRoot.get(root) ?? []), { sessionId, depth }]);
	}
	/** @type {Map<string, string[]>} */
	const chains = new Map();
	for (const [root, members] of byRoot)
		chains.set(
			root,
			members
				.sort(
					(x, y) => x.depth - y.depth || x.sessionId.localeCompare(y.sessionId),
				)
				.map((m) => m.sessionId),
		);
	return { files, spent, chains };
}

/**
 * The spend of a chain's listed transcripts, each request once, less what its
 * root's move repeats from off the key.
 * @param {OverflowLookup} lookup
 * @param {string} root
 * @param {string[]} listed
 */
const readListedChainUsd = (lookup, root, listed) =>
	Math.max(0, readChainSpendUsd(listed) - offKeyOf(lookup, root));

/**
 * Each session's spend with every copy in its chain, by session: a copy
 * repeats its parent's main-thread requests up to the fork, but neither the
 * parent's subagents nor what the parent spends after it, so a copy priced
 * alone could spend its allowance again (#4195). A member whose transcript is
 * gone counts at its ledger row, which may count the repeated requests twice.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @param {LedgerEntry[]} ledger
 * @returns {Map<string, number>}
 * @throws where the dir's project dirs will not list
 */
function readChainSpend(seat, lookup, ledger) {
	const { files, spent, chains } = readChains(seat, lookup, ledger);
	for (const [root, members] of chains) {
		if (members.length < 2) continue;
		const listed = members.flatMap((m) => files.get(m) ?? []);
		const gone = members
			.filter((m) => !files.has(m))
			.reduce((t, m) => t + (spent.get(m) ?? 0), 0);
		const usd = readListedChainUsd(lookup, root, listed) + gone;
		for (const m of members) spent.set(m, Math.max(usd, spent.get(m) ?? 0));
	}
	return spent;
}

/**
 * The ledger with each chain member's row at what it adds to the members
 * before it, so a parent and its copies settle the requests they share once
 * (#4208). Rows stay one per session, each settled or held by its own last
 * write. A member whose transcript is gone keeps its row, which may count the
 * repeated requests twice.
 * @param {OverflowSeat} seat
 * @param {OverflowLookup} lookup
 * @param {LedgerEntry[]} ledger
 * @returns {LedgerEntry[]}
 * @throws where the dir's project dirs will not list
 */
function settleChainsOnce(seat, lookup, ledger) {
	const { files, chains } = readChains(seat, lookup, ledger);
	/** @type {Map<string, number>} */
	const added = new Map();
	for (const [root, members] of chains) {
		if (members.length < 2) continue;
		/** @type {string[]} */
		const listed = [];
		let before = 0;
		for (const m of members) {
			const file = files.get(m);
			if (file === undefined) continue;
			listed.push(file);
			const after = readListedChainUsd(lookup, root, listed);
			added.set(m, after - before);
			before = after;
		}
	}
	return ledger.map((e) => {
		const costUsd = added.get(e.sessionId);
		return costUsd === undefined ? e : { ...e, costUsd };
	});
}

/**
 * The key's listed background sessions whose chain's spend has reached the
 * allowance their launch recorded. An `ended` one is past it but no longer
 * running: capped without a stop.
 * @param {OverflowSeat} seat
 * @param {import("./agent-liveness.js").AgentRecord[]} agents
 * @param {OverflowLookup} lookup
 * @throws where a transcript or the ledger cannot be read
 */
function readOverAllowance(seat, agents, lookup) {
	const spent = readChainSpend(seat, lookup, priceSessions(seat, lookup));
	const capped = new Set(
		(readJsonl(cappedFile(seat))?.rows ?? []).map((r) =>
			chainRootOf(lookup, String(r.sessionId)),
		),
	);
	return agents.flatMap((a) => {
		if (a.kind !== "background" || capped.has(chainRootOf(lookup, a.sessionId)))
			return [];
		const launch = lookup({ jobId: a.id, sessionId: a.sessionId });
		const spentUsd = spent.get(a.sessionId);
		if (
			launch?.keyVar !== seat.keyVar ||
			spentUsd === undefined ||
			spentUsd < launch.allowanceUsd
		)
			return [];
		return [
			{
				jobId: a.id ?? shortJobId(a.sessionId),
				sessionId: a.sessionId,
				name: a.name ?? null,
				spentUsd,
				allowanceUsd: launch.allowanceUsd,
				ended: isTerminalAgent(a),
			},
		];
	});
}

/**
 * Stop every listed overflow session past its allowance (#3698): one log line
 * per stop and one per seat that could not be judged.
 * A failed stop is not marked capped, so the next tick tries again. Residual:
 * one the daemon holds no job for ("No job matching") logs its failure every
 * tick for as long as the listing shows it.
 * @param {import("./refill-seats.js").SeatList} declared
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents the tick's
 *   listing, null where it is unread
 * @returns {string[]}
 */
function stopOverAllowance(declared, agents) {
	if (declared.errors.length > 0)
		return [`overflow allowances unjudged: ${declared.errors.join("; ")}`];
	const seats = declared.seats.filter(
		/** @returns {s is OverflowSeat} */ (s) => s.kind === "overflow",
	);
	if (seats.length === 0) return [];
	if (!agents) return ["overflow allowances unjudged: the listing is unread"];
	let lookup;
	try {
		lookup = readEveryOverflowLookup();
	} catch (err) {
		return [`overflow allowances unjudged: ${caught(err).message}`];
	}
	return seats.flatMap((seat) => {
		let over;
		try {
			over = readOverAllowance(seat, agents, lookup);
		} catch (err) {
			return [
				`overflow allowances on ${seat.keyVar} unjudged: ${caught(err).message}`,
			];
		}
		return over.flatMap((s) => capSession(seat, s));
	});
}

/**
 * Stop one session at or past its allowance, unless it has ended, and mark
 * it capped.
 * @param {OverflowSeat} seat
 * @param {ReturnType<typeof readOverAllowance>[number]} s
 * @returns {string[]}
 */
function capSession(seat, s) {
	const who = `overflow session ${s.name ? `${s.name} (${s.jobId})` : s.jobId} on ${seat.dir}`;
	/* A malformed launch row must not read as an allowance of nothing. */
	if (!Number.isFinite(s.allowanceUsd))
		return [`${who} unjudged: its launch records no allowance`];
	const r = s.ended ? null : stopOn(seat.dir, s.jobId);
	const figures = `spent ${dollars(s.spentUsd)} of its ${dollars(s.allowanceUsd)} allowance`;
	if (r && !r.ok) return [`could not stop ${who}, ${figures}: ${r.why}`];
	const row = {
		sessionId: s.sessionId,
		jobId: s.jobId,
		at: new Date().toISOString(),
		spentUsd: s.spentUsd,
		allowanceUsd: s.allowanceUsd,
	};
	try {
		fs.appendFileSync(cappedFile(seat), `${JSON.stringify(row)}\n`);
	} catch (err) {
		return [
			`${r ? "stopped" : "ended"} ${who}, ${figures}, not marked capped: ${caught(err).message}`,
		];
	}
	return r ? [`stopped ${who}: ${figures}`] : [];
}

/**
 * @param {OverflowSeat} seat
 * @param {SeatBudget|{why: string}} budget
 */
function buildBudgetLine(seat, budget) {
	if ("why" in budget) return `overflow ${seat.dir}: unread — ${budget.why}`;
	const failed = budget.readFailure
		? `; last Console read failed: ${budget.readFailure}`
		: "";
	const headroom = `headroom ${dollars(budget.headroomUsd)} (${dollars(budget.reservedUsd)} held by ${budget.running} running)`;
	if (budget.readAt !== null) {
		const spent = `${dollars(budget.creditUsd)} on the Console at ${new Date(budget.readAt).toISOString()}, ${dollars(budget.settledUsd)} spent since`;
		return `overflow ${seat.dir}: ${budget.exhausted ? "exhausted" : `fits ${budget.fit}`}; ${headroom}; ${spent}${failed}`;
	}
	const resets = localDate(new Date(budget.nextCycleStart));
	const spent = `spent ${dollars(budget.settledUsd)} of ${dollars(budget.grantUsd)} since ${localDate(new Date(budget.cycleStart))}`;
	if (budget.exhausted)
		return `overflow ${seat.dir}: exhausted until ${resets}; headroom ${dollars(budget.headroomUsd)}; ${spent}${failed}`;
	return `overflow ${seat.dir}: fits ${budget.fit}; ${headroom}; ${spent}; resets ${resets}${failed}`;
}

module.exports = { buildBudgetLine, seatBudget, stopOverAllowance };

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
