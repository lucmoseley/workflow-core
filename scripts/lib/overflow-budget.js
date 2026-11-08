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
 * capped once, and a founder's reply to it runs uncapped (spec #3691 §Out of
 * Scope): the reply is a headless run of its own, which its run record marks
 * (lib/overflow-actions.js, #4174); the loop's resumes carry no mark.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { isTerminalAgent, readAgentsForBudget } = require("./agent-liveness.js");
const { CREDIT_REFUSAL } = require("./headless-runs.js");
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
const {
	buildSeatLabel,
	findOverflowSeat,
	overflowSeatsOf,
	readDeclaredSeats,
} = require("./refill-seats.js");
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

/* The listing kinds an overflow launch runs as: a `--bg` job, or a headless
 * run (lib/headless-runs.js, #4580), which lib/claude-stop.js also stops. */
const LAUNCHED_KINDS = new Set(["background", "headless"]);

/* The scripts a ledger's lock holder runs; any other's lock reads as stale. */
const BUDGET_READERS = [
	"overflow-budget.js",
	"overflow-view.js",
	"refill-loop.js",
];

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
 * The spend of a chain's listed transcripts, each request once, less what its
 * root's move repeats from off the key.
 * @param {OverflowLookup} lookup
 * @param {string} root
 * @param {string[]} listed
 */
const readListedChainUsd = (lookup, root, listed) =>
	Math.max(0, readChainSpendUsd(listed) - offKeyOf(lookup, root));

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
 * @returns {[LedgerEntry, number][]}
 */
function readSharedUsd(lookup, rows, files) {
	return [...groupByChain(lookup, rows)].flatMap(([root, members]) =>
		members.length < 2 ? [] : readChainSharedUsd(lookup, root, members, files),
	);
}

/**
 * `readSharedUsd` for one chain, its members in chain order.
 * @param {OverflowLookup} lookup
 * @param {string} root
 * @param {LedgerEntry[]} members
 * @param {Map<string, string>} files
 * @returns {[LedgerEntry, number][]}
 */
function readChainSharedUsd(lookup, root, members, files) {
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
		const after = readListedChainUsd(lookup, root, listed);
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
 * The key's listed background sessions and headless runs whose chain's spend
 * has reached the allowance their launch recorded, a founder's reply aside,
 * once priceSessions has priced the key's ledger again. An `ended` one is past
 * it but no longer running: capped without a stop.
 * @param {OverflowSeat} seat
 * @param {import("./agent-liveness.js").AgentRecord[]} agents
 * @param {OverflowLookup} lookup
 * @throws where a transcript or the ledger cannot be read, written or locked
 */
function priceOverAllowance(seat, agents, lookup) {
	const spent = chainSpendOf(lookup, priceSessions(seat, lookup));
	const capped = new Set(
		(readJsonl(cappedFile(seat))?.rows ?? []).map((r) =>
			chainRootOf(lookup, String(r.sessionId)),
		),
	);
	return agents.flatMap((a) => {
		if (
			!LAUNCHED_KINDS.has(a.kind ?? "") ||
			capped.has(chainRootOf(lookup, a.sessionId)) ||
			a.founderReply === true
		)
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
	const seats = overflowSeatsOf(declared.seats);
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
			over = priceOverAllowance(seat, agents, lookup);
		} catch (err) {
			return [
				`overflow allowances on ${buildSeatLabel(seat)} unjudged: ${caught(err).message}`,
			];
		}
		return over.flatMap((s) => capSession(seat, s));
	});
}

/**
 * Stop one session at or past its allowance, unless it has ended, and mark
 * it capped.
 * @param {OverflowSeat} seat
 * @param {ReturnType<typeof priceOverAllowance>[number]} s
 * @returns {string[]}
 */
function capSession(seat, s) {
	const who = `overflow session ${s.name ? `${s.name} (${s.jobId})` : s.jobId} on ${buildSeatLabel(seat)}`;
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
			? "exhausted until a newer Console reading"
			: `fits ${budget.fit}`;
		return `${label}: ${state}; ${headroom}; ${spent}${expires}${failed}`;
	}
	const resets = localDate(new Date(budget.nextCycleStart));
	const spent = `spent ${dollars(budget.settledUsd)} of ${dollars(budget.grantUsd)} since ${localDate(new Date(budget.cycleStart))}`;
	if (budget.exhausted)
		return `${label}: exhausted until ${resets}; headroom ${dollars(budget.headroomUsd)}; ${spent}${failed}`;
	return `${label}: fits ${budget.fit}; ${headroom}; ${spent}; resets ${resets}${failed}`;
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

module.exports = { buildBudgetLine, seatBudget, stopOverAllowance };
