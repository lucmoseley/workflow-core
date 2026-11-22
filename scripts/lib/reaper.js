/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{since: number, failures: number, retryAt: number,
 *   lastError: string|null}} Entry
 * @typedef {Record<string, number | {since?: unknown, failures?: unknown,
 *   retryAt?: unknown, lastError?: unknown}>} State
 * @typedef {{held: Map<string, string[]>, unnamed: string[], why?: undefined}
 *   | {why: string, held?: undefined, unnamed?: undefined}} Claims
 * @typedef {{mode: string, startedAt: string, openedSince?: string,
 *   deaths?: number, finishedAt?: string}} RunRecord
 * @typedef {AgentRecord & {gate: string, why: string, clock?: string,
 *   heldBack?: boolean, waiting?: boolean, failures?: number,
 *   retryAt?: number}} KeptRow
 * @typedef {AgentRecord & {claims: string[], clock: string, why: string}} ReapRow
 * @typedef {AgentRecord & {gate: string}} GatedRow
 * @typedef {ReapRow & {pss: number|null, stopped: boolean, dryRun?: boolean,
 *   error?: string}} DoneRow
 * @typedef {{sessionId: unknown, id: unknown, name: unknown, kind: unknown,
 *   state: unknown, gate: string|null, why: unknown}} Candidate
 * @typedef {import("./claude-stop.js").StopOutcome} StopOutcome
 */
const { isFinishedAgent } = require("./agent-liveness.js");
const { deathCount } = require("./detached-run.js");
const { noop } = require("./noop.js");

// guess, lucmoseley/mantahostels#1290
const GRACE_MS = 0;

// measured p99.9 612 s, #2983
const HOLD_MS = 15 * 60_000;

// guess, lucmoseley/mantahostels#846
const MAX_PER_RUN = 10;

const DEGRADED = /** @type {const} */ ("degraded");
const CLEAN = /** @type {const} */ ("clean");

// guess, lucmoseley/mantahostels#846
const RETRY_BASE_MS = 60 * 60 * 1000;
const RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/** @param {number} failures */
function retryDelayMs(failures) {
	return Math.min(
		RETRY_BASE_MS * 2 ** (Math.max(1, failures) - 1),
		RETRY_CAP_MS,
	);
}

// guess, lucmoseley/mantahostels#1952
const LIVE_DEATH_GRACE_MS = 300_000;

/**
 * @param {string[]} argv
 * @param {Record<string, RunRecord>} runs
 * @param {number} now
 * @returns {RunRecord}
 */
function openedRecord(argv, runs, now) {
	const mode = argv.includes("--dry-run") ? "dry" : "live";
	const { deaths, openedSince } = deathCount(
		runs?.[mode],
		LIVE_DEATH_GRACE_MS,
		now,
	);
	const record = {
		mode,
		startedAt: new Date(now).toISOString(),
		openedSince,
		deaths,
	};
	return record;
}

const isFinished = isFinishedAgent;

/**
 * @param {State} state
 * @param {string} sessionId
 * @param {number} now
 * @returns {Entry}
 */
function entryOf(state, sessionId, now) {
	const row = state[sessionId];
	if (typeof row === "number" && Number.isFinite(row))
		return { since: row, failures: 0, retryAt: 0, lastError: null };
	if (row && typeof row === "object" && !Array.isArray(row)) {
		/** @param {unknown} v */
		const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return {
			since: num(row.since) || now,
			failures: num(row.failures),
			retryAt: num(row.retryAt),
			lastError: typeof row.lastError === "string" ? row.lastError : null,
		};
	}
	return { since: now, failures: 0, retryAt: 0, lastError: null };
}

/** @typedef {string|null|undefined} Self */

/** @param {Self} self */
const isSelfUnknown = (self) => self === undefined || self === "";

/**
 * @param {AgentRecord} a
 * @param {Self} self
 * @returns {KeptRow|null}
 */
function unaddressableRow(a, self) {
	if (isSelfUnknown(self))
		return {
			...a,
			gate: "session-id",
			why: "CLAUDE_CODE_SESSION_ID is unset, so this session cannot be told apart from any other",
		};
	if (self !== null && a.sessionId === self)
		return { ...a, gate: "self", why: "it is this very session" };
	if (!a.id)
		return {
			...a,
			gate: "job-id",
			why: "its registry record names no job",
		};
	return null;
}

/**
 * @param {AgentRecord} a
 * @param {{now: number, idleMs: number, clock: string,
 *   turn: {ended: boolean, at: number|null}|null}} at
 * @returns {KeptRow|null}
 */
function turnHold(a, { now, idleMs, clock, turn }) {
	if (turn === null)
		return idleMs < HOLD_MS
			? {
					...a,
					clock,
					gate: "unreadable",
					why: `its transcript does not show whether its turn ended, and it finished ${Math.round(idleMs / 1000)}s ago, inside the ${HOLD_MS / 60_000}-minute hold`,
				}
			: null;
	if (turn.ended) return null;
	const turnMs = turn.at === null ? idleMs : now - turn.at;
	return turnMs < HOLD_MS
		? {
				...a,
				clock: turn.at === null ? clock : "turn-row",
				gate: "turn",
				why: `its transcript shows a turn still running — a Stop hook or the turn it forced — its last turn row ${Math.round(turnMs / 1000)}s ago`,
			}
		: null;
}

/**
 * @param {AgentRecord} a
 * @param {Entry} entry
 * @param {{now: number, finished: number|null,
 *   turn: {ended: boolean, at: number|null}|null, claims: string[]}} at
 * @returns {{kept: KeptRow} | {reap: ReapRow}}
 */
function timedRow(a, entry, at) {
	const { since, failures, retryAt, lastError } = entry;
	const { now, finished, turn, claims } = at;
	const clock = finished === null ? "observation" : "finish-stamp";
	const idleMs = now - (finished === null ? since : finished);
	if (idleMs < GRACE_MS)
		return {
			kept: {
				...a,
				clock,
				gate: "grace",
				why:
					GRACE_MS === 0
						? `its finish stamp is ${Math.round(-idleMs / 1000)}s in the future, so its clock cannot be trusted`
						: `finished ${Math.round(idleMs / 1000)}s ago, inside the ${GRACE_MS / 1000}s grace window`,
			},
		};
	const held = turnHold(a, { now, idleMs, clock, turn });
	if (held) return { kept: held };
	if (failures && now < retryAt)
		return {
			kept: {
				...a,
				clock,
				gate: "retry",
				heldBack: true,
				failures,
				retryAt,
				why: `\`claude stop\` has failed ${failures} time(s)${lastError ? ` (${lastError})` : ""}; not retried for another ${Math.round((retryAt - now) / 60_000)} minute(s)`,
			},
		};
	return {
		reap: {
			...a,
			claims,
			clock,
			why: `finished ${Math.round(idleMs / 60_000)} minute(s) ago`,
		},
	};
}

/**
 * @param {AgentRecord} a
 * @param {{name: string}[]|null} out
 * @returns {KeptRow|null}
 */
function pendingHold(a, out) {
	if (out === null)
		return {
			...a,
			gate: "pending-unreadable",
			waiting: true,
			why: "its transcript will not read for launches still out, so a `waiting:` cannot be ruled out",
		};
	if (out.length === 0) return null;
	const names = out.map((l) => l.name || "an unnamed launch").join("; ");
	return {
		...a,
		gate: "pending",
		waiting: true,
		why: `its transcript shows ${out.length} launch(es) still out (${names}), so it is waiting rather than finished`,
	};
}

/**
 * @param {{agents: AgentRecord[], held: Map<string, string[]>,
 *   self: Self, now: number, state: State,
 *   finishAt?: (a: {id?: string, sessionId: string}) => number|null,
 *   lastTurn: (a: {id?: string, sessionId: string}) =>
 *     {ended: boolean, at: number|null}|null,
 *   pending: (a: {id?: string, sessionId: string}) =>
 *     {name: string}[]|null}} input
 */
function plan({
	agents,
	held,
	self,
	now,
	state,
	finishAt = () => null,
	lastTurn,
	pending,
}) {
	/** @type {State} */
	const nextState = {};
	/** @type {any[]} */
	const toReap = [];
	/** @type {any[]} */
	const kept = [];
	/** @type {any[]} */
	const notFinished = [];

	for (const a of agents) {
		if (!isFinished(a)) {
			notFinished.push({ ...a, gate: "finished" });
			continue;
		}
		const entry = entryOf(state, a.sessionId, now);
		const { since, failures, retryAt, lastError } = entry;
		nextState[a.sessionId] = failures
			? { since, failures, retryAt, lastError }
			: since;
		const claims = held.get(a.sessionId) ?? [];

		const unaddressable = unaddressableRow(a, self);
		if (unaddressable) {
			kept.push(unaddressable);
			continue;
		}
		const row = timedRow(a, entry, {
			now,
			finished: finishAt(a),
			turn: lastTurn(a),
			claims,
		});
		if ("kept" in row) {
			kept.push(row.kept);
			continue;
		}
		const waiting = pendingHold(a, pending(a));
		if (waiting) kept.push(waiting);
		else toReap.push(row.reap);
	}

	return {
		reap: toReap.slice(0, MAX_PER_RUN),
		capped: toReap.slice(MAX_PER_RUN).map((a) => ({ ...a, gate: "cap" })),
		kept,
		notFinished,
		nextState,
	};
}

/**
 * @param {ReapRow[]} due
 * @param {State} nextState
 * @param {{dryRun: boolean, now: number,
 *   stop: (id: string, sessionId: string) => StopOutcome,
 *   readPss: (pid: number|null|undefined) => number|null}} how
 * @returns {DoneRow[]}
 */
function stopEach(due, nextState, how) {
	const { dryRun, now, stop, readPss } = how;
	/** @type {DoneRow[]} */
	const done = [];
	for (const a of due) {
		const size = readPss(a.pid);
		if (dryRun) {
			done.push({ ...a, pss: size, stopped: false, dryRun: true });
			continue;
		}
		const r = stop(/** @type {string} */ (a.id), a.sessionId);
		done.push({
			...a,
			pss: size,
			stopped: r.ok,
			error: r.ok ? undefined : r.why,
		});
		if (r.ok) {
			delete nextState[a.sessionId];
			continue;
		}
		const prior = entryOf(nextState, a.sessionId, now);
		if (r.timedOut) {
			nextState[a.sessionId] = prior.since;
			continue;
		}
		const failures = prior.failures + 1;
		nextState[a.sessionId] = {
			since: prior.since,
			failures,
			retryAt: now + retryDelayMs(failures),
			lastError: r.why,
		};
	}
	return done;
}

/**
 * @param {Record<string, unknown>} a
 * @param {string|null} gate
 * @returns {Candidate}
 */
const candidate = (a, gate) => ({
	sessionId: a.sessionId,
	id: a.id ?? null,
	name: a.name ?? null,
	kind: a.kind ?? null,
	state: a.state ?? null,
	gate,
	why: a.why ?? null,
});

/**
 * @param {{done: DoneRow[], capped: GatedRow[], kept: KeptRow[],
 *   notFinished: GatedRow[]}} rows
 * @returns {Candidate[]}
 */
function candidatesOf({ done, capped, kept, notFinished }) {
	return [
		...done.map((d) => ({
			...candidate(d, d.dryRun || d.stopped ? null : "stop-failed"),
			error: d.error ?? null,
		})),
		...capped.map((a) => candidate(a, a.gate)),
		...kept.map((a) => candidate(a, a.gate ?? null)),
		...notFinished.map((a) => candidate(a, a.gate)),
	];
}

/**
 * @param {{claims?: string[], sessionId: string}} a
 * @param {(subject: string, sessionId: string) => boolean|null} isDirty
 * @returns {string}
 */
function buildClaimLine(a, isDirty) {
	if (!a.claims || a.claims.length === 0) return "";
	const named = a.claims
		.map((/** @type {string} */ f) =>
			isDirty(f, a.sessionId) === true ? `${f} (DIRTY)` : f,
		)
		.join(", ");
	return `reap:   it held ${a.claims.length} file claim(s), now stale and breakable by the next session to claim them: ${named}`;
}

/**
 * @param {import("./registry-agents.js").RegistryListing} listed
 * @returns {typeof DEGRADED | typeof CLEAN}
 */
const verdictOf = (listed) =>
	listed.seats.length === 0 && listed.faults.length > 0 ? DEGRADED : CLEAN;

/**
 * @param {import("./registry-agents.js").RegistryListing} listed
 * @param {State} state
 * @param {State} nextState
 */
function carryUnlisted(listed, state, nextState) {
	if (listed.faults.length === 0) return;
	const seen = new Set(listed.agents.map((a) => a.sessionId));
	for (const [id, row] of Object.entries(state))
		if (!seen.has(id)) nextState[id] = row;
}

/**
 * @param {string[]} faults
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logFaults(faults, log) {
	for (const fault of faults)
		log(`reap: ${fault}, so its sessions went unjudged`);
}

/**
 * @param {string|null} claimsUnread
 * @param {string[]} unnamed
 * @param {number} doneCount
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logClaimsCaveat(claimsUnread, unnamed, doneCount, log) {
	if (doneCount === 0) return;
	if (claimsUnread)
		log(
			`reap: the claim store could not be read (${claimsUnread}), so no lock this run leaves stale can be named`,
		);
	else if (unnamed.length > 0)
		log(
			`reap: ${unnamed.length} lock record(s) name no holder this run could read, so a claim ` +
				`held under them cannot be named — every other claim below was judged: ${unnamed.join(", ")}`,
		);
}

/**
 * @param {DoneRow[]} done
 * @param {KeptRow[]} kept
 * @param {(subject: string, sessionId: string) => boolean|null} isDirty
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logWouldStop(done, kept, isDirty, log) {
	for (const a of done) {
		log(`reap: would stop ${a.id} (${a.name}) — ${a.why}`);
		const heldLine = buildClaimLine(a, isDirty);
		if (heldLine) log(heldLine);
	}
	for (const a of kept) log(`reap: keeping ${a.id ?? a.sessionId} — ${a.why}`);
	if (done.length === 0) log("reap: nothing to stop");
}

/**
 * @param {DoneRow[]} done
 * @param {KeptRow[]} kept
 * @param {(subject: string, sessionId: string) => boolean|null} isDirty
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logStopped(done, kept, isDirty, log) {
	const stopped = done.filter((d) => d.stopped);
	for (const a of stopped) {
		const size = a.pss === null ? "size unread" : `${a.pss} MB`;
		log(
			`reap: stopped ${a.name} (${size}) — ${a.why}. Its conversation is kept: \`claude attach ${a.id}\`.`,
		);
		const heldLine = buildClaimLine(a, isDirty);
		if (heldLine) log(heldLine);
	}
	const measured = stopped.filter((s) => s.pss !== null);
	if (measured.length > 0)
		log(
			`reap: ${measured.length} of ${stopped.length} session(s) returned ${measured.reduce((n, s) => n + /** @type {number} */ (s.pss), 0)} MB.`,
		);
	for (const a of done.filter((d) => !d.stopped))
		log(`reap: could not stop ${a.id} (${a.error})`);
	for (const a of kept.filter((k) => k.heldBack))
		log(`reap: not retrying ${a.id} (${a.name}) — ${a.why}`);
	for (const a of kept.filter((k) => k.waiting))
		log(`reap: keeping ${a.id} (${a.name}) — ${a.why}`);
}

/**
 * @param {{argv: string[],
 *   listed: import("./registry-agents.js").RegistryListing,
 *   claims: Claims, self: Self, now: number, state: State,
 *   stop: (id: string, sessionId: string) => StopOutcome,
 *   readPss: (pid: number|null|undefined) => number|null,
 *   saveState: (state: State) => void,
 *   finishAt: (a: {id?: string, sessionId: string}) => number|null,
 *   lastTurn: (a: {id?: string, sessionId: string}) =>
 *     {ended: boolean, at: number|null}|null,
 *   pending: (a: {id?: string, sessionId: string}) =>
 *     {name: string}[]|null,
 *   isDirty?: (subject: string, sessionId: string) => boolean|null,
 *   runs?: Record<string, RunRecord>,
 *   startedAt?: string,
 *   recordRun?: (record: RunRecord) => void,
 *   recordStopped?: (stopped: DoneRow[], now: number) => string|null,
 *   log: (line: string) => void}} input
 * @returns {typeof DEGRADED | typeof CLEAN}
 */
function reap({
	argv,
	listed,
	claims,
	self,
	now,
	state,
	stop,
	readPss,
	saveState,
	finishAt,
	lastTurn,
	pending,
	isDirty = () => null,
	runs = {},
	startedAt = new Date(now).toISOString(),
	recordRun = noop,
	recordStopped = () => null,
	log,
}) {
	const dryRun = argv.includes("--dry-run");
	const asJson = argv.includes("--json");
	const mode = dryRun ? "dry" : "live";

	const prev = runs?.[mode];
	const unfinished =
		prev && typeof prev === "object" && !prev.finishedAt ? prev : null;

	/** @param {Record<string, unknown>} fields */
	const finish = (fields) =>
		recordRun({
			mode,
			startedAt,
			finishedAt: new Date().toISOString(),
			...fields,
		});

	if (unfinished && !asJson)
		log(
			`reap: the previous ${dryRun ? "dry " : ""}run started ${unfinished.startedAt} and never finished — ` +
				"it was cancelled or died mid-run, so anything it should have stopped is still resident. " +
				"A SessionStart hook is cancelled at its own timeout (its hook registration).",
		);

	/** @param {string} why @param {Record<string, unknown>} [fields] */
	const nothing = (why, fields = {}) => {
		finish({ why, ...fields });
		log(
			asJson
				? JSON.stringify({
						reaped: [],
						why,
						previousRunUnfinished: unfinished?.startedAt ?? null,
					})
				: `reap: nothing — ${why}`,
		);
	};

	const claimsUnread = claims.why ?? null;
	const unnamed = claims.unnamed ?? [];
	if (isSelfUnknown(self)) {
		nothing(
			"CLAUDE_CODE_SESSION_ID is unset, so this session cannot be told apart from the ones it would stop",
			{
				listed: listed.agents.length,
				candidates: listed.agents.map((a) => ({
					sessionId: a.sessionId,
					id: a.id ?? null,
					state: a.state ?? null,
					gate: "session-id",
				})),
			},
		);
		return DEGRADED;
	}

	const {
		reap: due,
		capped,
		kept,
		notFinished,
		nextState,
	} = plan({
		agents: listed.agents,
		held: claims.held ?? new Map(),
		self,
		now,
		state,
		finishAt,
		lastTurn,
		pending,
	});

	const done = stopEach(due, nextState, { dryRun, now, stop, readPss });
	carryUnlisted(listed, state, nextState);
	saveState(nextState);
	const unjournalled = recordStopped(
		done.filter((d) => d.stopped),
		now,
	);

	finish({
		source: "registry",
		listed: listed.agents.length,
		faults: listed.faults,
		stopped: done.filter((d) => d.stopped).length,
		dryRun,
		candidates: candidatesOf({ done, capped, kept, notFinished }),
	});

	if (asJson) {
		log(
			JSON.stringify(
				{
					reaped: done,
					kept,
					claimsUnread,
					source: "registry",
					faults: listed.faults,
					unnamedRecords: unnamed,
					previousRunUnfinished: unfinished?.startedAt ?? null,
				},
				null,
				"\t",
			),
		);
		return verdictOf(listed);
	}
	logFaults(listed.faults, log);
	logClaimsCaveat(claimsUnread, unnamed, done.length, log);
	if (dryRun) {
		logWouldStop(done, kept, isDirty, log);
		return verdictOf(listed);
	}
	logStopped(done, kept, isDirty, log);
	if (unjournalled)
		log(
			`reap: could not journal the jobs it stopped (${unjournalled}), so the refill loop cannot resume one the harness ended on a synthetic reply; check-ghost-jobs still reports it`,
		);
	return verdictOf(listed);
}

module.exports = { reap, openedRecord, DEGRADED };
