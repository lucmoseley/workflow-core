/*
 * reaper.js — the reaper's judgement and its report: which finished sessions
 * scripts/reap-finished-sessions.js stops, what the run says, and the run
 * record it opens, with every reading of the outside world and every effect
 * passed in. That program is its one caller; the gates themselves, and why
 * each exists, are in that program's header.
 *
 * WHY THIS IS A MODULE OF ITS OWN (#1369, §G6 of spec #1348: nothing is
 * exported for its tests alone). The decision table — five gates, the window a
 * failed stop opens, the per-run ceiling, the deaths a wedged run accumulates
 * — is pinned case by case against a frozen clock and injected readings: a
 * PSS figure, git's dirty answer, an unreadable claim store, a stop that
 * fails. Run end to end the program reads the real clock and /proc and spawns
 * git, and a run record's `deaths` shows only in a row left open, which takes
 * a run killed mid-read. So the logic lives here, and its tests reach it
 * through the exports the program calls.
 *
 * NO I/O: every file and process reading is the program's, handed in. The one
 * clock read is a closing run record's `finishedAt`, at `finish` below.
 */

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{since: number, failures: number, retryAt: number,
 *   lastError: string|null}} Entry One session's state-file row, as this run
 *   reads it.
 * @typedef {Record<string, number | {since?: unknown, failures?: unknown,
 *   retryAt?: unknown, lastError?: unknown}>} State The state file.
 * @typedef {{held: Map<string, string[]>, unnamed: string[], why?: undefined}
 *   | {why: string, held?: undefined, unnamed?: undefined}} Claims
 * @typedef {{mode: string, startedAt: string, openedSince?: string,
 *   deaths?: number, finishedAt?: string}} RunRecord
 * @typedef {AgentRecord & {gate: string, why: string, clock?: string,
 *   heldBack?: boolean, failures?: number, retryAt?: number}} KeptRow
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

/* How long a session must have been finished before it is reaped. ZERO
 * (mantahostels#1290, which holds why), so nothing is ever held back for age
 * alone. Its cost: a session you just watched finish is stopped, a resume
 * rather than a loss. Reasoned to, never derived: quote the 0-minute grace as
 * unchecked (docs/environment.md §5).
 *
 * At zero the state file's one load-bearing job is the stop-failure retry
 * record (mantahostels#846). Gate 1 (`kind: background` AND `state: done`) is
 * the real safety gate. */
const GRACE_MS = 0;

/* HOW LONG A JOB WHOSE TURN HAS NOT VISIBLY ENDED IS LEFT ALONE (#2980).
 *
 * A job reads `state: done` before its Stop hooks run, and a hook that blocks
 * starts a forced turn under that same `done`. A stop inside that turn kills
 * the corrected ending it would write, and can write `stopped` over the result
 * (#2977). So the transcript tail is read (lib/transcript.js's lastTurn):
 *
 * - ENDED: reaped.
 * - NOT ENDED: held until the turn ends, or for HOLD_MS from its last
 *   turn row's own timestamp — a turn that silent is hung, not running. Timed off the
 *   row, never the file's mtime, which bookkeeping rows (`cost-state`,
 *   `queue-operation`) keep moving with no turn running.
 * - UNREADABLE (no transcript, no cwd to find it by, no turn row in its
 *   tail): held for HOLD_MS from its last write.
 *
 * A clock the row does not give runs from the finish clock, `max(firstTerminalAt,
 * transcript mtime)` — the mtime being the last row written — else the first
 * sighting.
 *
 * HOLD_MS is 15 min, measured (#2983): the longest silence inside each of
 * 7,848 completed forced turns in background-job transcripts runs p99 553 s,
 * p99.9 612 s, the Bash tool's 600 s timeout cap plus its overhead; 3 (0.04%)
 * passed 900 s. Set at the p99.9 plus padding, the false-timeout rule of
 * docs/practice/capacity-planning-and-admission.md. An unreadable tail's
 * clock is never earlier than the last turn row, so it holds at least as long.
 * A missing transcript runs from the first sighting, where no silence can be
 * measured: there the window is reasoned, not derived. */
const HOLD_MS = 15 * 60_000;

/* A ceiling on one run. Whatever is left over is reaped at the next start
 * (docs/environment.md §5). */
const MAX_PER_RUN = 10;

/* What `reap` returns where it could judge no candidate at all: no session id
 * to tell itself apart by, or no seat's registry would read. Under persist
 * mode `main` turns it into a BROKEN report, so a reaper that ran and could not
 * work is distinguishable from one that ran and found nothing. */
const DEGRADED = /** @type {const} */ ("degraded");
/* What it returns from every other path: it judged the candidates. */
const CLEAN = /** @type {const} */ ("clean");

/* HOW A STOP THAT FAILED IS LEFT ALONE (mantahostels#846).
 *
 * A `claude stop` fails two ways. TRANSIENTLY: the daemon is slow or busy,
 * the stop hits its timeout, and the next run works (#2665). PERMANENTLY: the listing names a job the stop
 * cannot address at all — a job record left on disk reading `state: done`
 * whose daemon holds no job by that id, which answers "No job matching
 * '<id>'" and exit 1 however often it is asked.
 *
 * So a stop that TIMED OUT is retried at the next run, unrecorded. Any other failed stop is REMEMBERED, and the next attempt
 * is held off for a window
 * that doubles with each consecutive failure — 1 h, 2 h, 4 h … capped at a day.
 * The count sits in the state file beside the first-seen stamp, and it is dropped
 * entirely by a session that stops successfully — or that leaves the
 * listing, as a ghost eventually does, since only sessions listed this run are
 * written back.
 *
 * Both figures are reasoned, never measured — quote them as unchecked. */
const RETRY_BASE_MS = 60 * 60 * 1000;
const RETRY_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait after the nth consecutive failed stop of one session.
 * @param {number} failures
 */
function retryDelayMs(failures) {
	return Math.min(
		RETRY_BASE_MS * 2 ** (Math.max(1, failures) - 1),
		RETRY_CAP_MS,
	);
}

/* HOW MANY TIMES A MODE'S ROW HAS BEEN SEEN UNCLOSED, ACROSS SESSION STARTS
 * (mantahostels#1952): a `live` row is reopened at every session start, so a
 * single read of it never ages into `check-hook-liveness.js`'s check (the
 * program's THE RUN RECORD).
 *
 * THE RULE IS DETACHED-RUN.JS'S `deathCount` (mantahostels#1910, mantahostels#1999), whose
 * docstring gives each limb and its why. It is computed here, not in the
 * checker: only `openedRecord` sees a mode's new attempt beside its prior one.
 *
 * THE VALUE ITSELF IS NOT DERIVED HERE — it is the same 300 s as
 * `detached-run.js`'s `INFLIGHT_MS` and `check-hook-liveness.js`'s own
 * `REAP_INFLIGHT_MS`, copied rather than imported (each module gates a
 * different thing, per the program's THE RUN RECORD pointer to the checker), for
 * the reason `detached-run.js`'s `INFLIGHT_MS` docstring gives: far past what
 * this reaper's own 30 s hook timeout allows, so one burst of concurrent
 * session starts against an already-stale row cannot rack up more than one
 * death on its own. Quote it as reasoned, not measured. */
const LIVE_DEATH_GRACE_MS = 300_000;

/**
 * The start half of a run's record — mode, `startedAt`, `openedSince`,
 * `deaths` — judged against that mode's prior row. The program's `openRun`
 * writes it; nothing here touches the run file.
 *
 * `runs` IS THE CALLER'S OWN PRIOR READ, never a second read here: see the
 * program's `openRun` for why the run file is read once (mantahostels#1952).
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

/*
 * Gate 1, imported rather than restated: one predicate, in agent-liveness.js,
 * shared with every reporter of the finished pool (mantahostels#1029). `status` is
 * deliberately not read — see THE `status` LIMB in the program's header.
 */
const isFinished = isFinishedAgent;

/**
 * One session's row in the state file, in the shape the gates want.
 *
 * A session that has never failed to stop has a bare number, its
 * first-sighting stamp (mantahostels#632). One that has is `{since, failures,
 * retryAt, lastError}`.
 *
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

/**
 * Who is reaping: a session id, `null` for a caller that is no session (the
 * refill loop, #2012), and nothing where a session's id was not set.
 * @typedef {string|null|undefined} Self
 */

/** @param {Self} self */
const isSelfUnknown = (self) => self === undefined || self === "";

/**
 * Gates 2 and 3: the row a finished session is kept under where this run
 * cannot address it safely, else null.
 * @param {AgentRecord} a
 * @param {Self} self
 * @returns {KeptRow|null}
 */
function unaddressableRow(a, self) {
	/* Without a session id of our own, gate 2 cannot be applied and the run
	 * could stop the session it is running in. */
	if (isSelfUnknown(self))
		return {
			...a,
			gate: "session-id",
			why: "CLAUDE_CODE_SESSION_ID is unset, so this session cannot be told apart from any other",
		};
	if (self !== null && a.sessionId === self)
		return { ...a, gate: "self", why: "it is this very session" };
	/* `claude stop` is addressed by the short job id, never the session id.
	 * Without one there is nothing to stop, so the record is kept rather than
	 * stopped by a guess. */
	if (!a.id)
		return {
			...a,
			gate: "job-id",
			why: "its registry record names no job",
		};
	return null;
}

/**
 * The row a session is kept under while its transcript does not show its turn
 * ended, else null.
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
 * Gates 4 and 5 for a session the run can address: the row it is kept under,
 * or the row it is reaped under.
 * @param {AgentRecord} a
 * @param {Entry} entry
 * @param {{now: number, finished: number|null,
 *   turn: {ended: boolean, at: number|null}|null, claims: string[]}} at
 *   `finished` is the session's finish stamp, null where none was read;
 *   `turn` its transcript's last turn row, null where unreadable
 * @returns {{kept: KeptRow} | {reap: ReapRow}}
 */
function timedRow(a, entry, at) {
	const { since, failures, retryAt, lastError } = entry;
	const { now, finished, turn, claims } = at;
	const clock = finished === null ? "observation" : "finish-stamp";
	const idleMs = now - (finished === null ? since : finished);
	/* At the standing GRACE_MS of 0 this fires only on a finish stamp in the
	 * future — a clock the run cannot trust, so it holds back rather than
	 * reaping. */
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
	/* `heldBack` is what the report reads to name it — never the prose. */
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
 * The reap decision, as data, split from the doing in `reap` below — so a
 * `--dry-run` reap, which skips the doing, reports every branch of it and
 * stops nothing.
 *
 * `finishAt` and `lastTurn` are injected so the clock and the transcript can
 * be driven without a job dir on disk.
 *
 * @param {{agents: AgentRecord[], held: Map<string, string[]>,
 *   self: Self, now: number, state: State,
 *   finishAt?: (a: {id?: string, sessionId: string}) => number|null,
 *   lastTurn: (a: {id?: string, sessionId: string}) =>
 *     {ended: boolean, at: number|null}|null}} input
 */
function plan({
	agents,
	held,
	self,
	now,
	state,
	finishAt = () => null,
	/* Required, unlike `finishAt`: a default could only answer "ended" or
	 * "cannot say", and a caller that forgot the reader must not reap a turn
	 * still running on either. */
	lastTurn,
}) {
	/** @type {State} */
	const nextState = {};
	/* Report rows: a listing record spread flat with the decision's own fields
	 * beside it, which differ per branch. Only the printer and the --json
	 * caller read them. */
	/** @type {any[]} */
	const toReap = [];
	/** @type {any[]} */
	const kept = [];
	/* Gate 1's rejects, kept apart from `kept` because they are the whole live
	 * pool on a busy machine and the dry-run printer names every `kept` row. Only
	 * the run record (mantahostels#1920) reads them. */
	/** @type {any[]} */
	const notFinished = [];

	for (const a of agents) {
		if (!isFinished(a)) {
			notFinished.push({ ...a, gate: "finished" });
			continue;
		}
		const entry = entryOf(state, a.sessionId, now);
		const { since, failures, retryAt, lastError } = entry;
		/* The failure record rides along untouched. A session held back at gate 5
		 * is still due, so dropping it would start both its grace window and its
		 * retry window again. */
		nextState[a.sessionId] = failures
			? { since, failures, retryAt, lastError }
			: since;
		/* Carried on the record for the report alone — no branch reads it. */
		const claims = held.get(a.sessionId) ?? [];

		const unaddressable = unaddressableRow(a, self);
		if (unaddressable) {
			kept.push(unaddressable);
			continue;
		}
		/* Read only here — after gate 1 and the three gates
		 * above — because the stamp it reads is trustworthy only for a session
		 * already shown to be finished. */
		const row = timedRow(a, entry, {
			now,
			finished: finishAt(a),
			turn: lastTurn(a),
			claims,
		});
		if ("kept" in row) kept.push(row.kept);
		else toReap.push(row.reap);
	}

	return {
		reap: toReap.slice(0, MAX_PER_RUN),
		/* Over the ceiling, so reaped at the next start instead. Named in the run
		 * record only; the printer has never had a line for it. */
		capped: toReap.slice(MAX_PER_RUN).map((a) => ({ ...a, gate: "cap" })),
		kept,
		notFinished,
		nextState,
	};
}

/**
 * Stops each due session, or under a dry run only measures it.
 * @param {ReapRow[]} due
 * @param {State} nextState accumulator: a stopped row's state is deleted from it,
 *   and one that would not stop has its failure recorded in it
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
		/* plan keeps every record without a job id, at gate 3. */
		const r = stop(/** @type {string} */ (a.id), a.sessionId);
		done.push({
			...a,
			pss: size,
			stopped: r.ok,
			error: r.ok ? undefined : r.why,
		});
		/* Only a session that actually stopped loses its record. One that would
		 * not stop keeps its first-seen time — starting its grace window again
		 * would hide it — and, unless it merely timed out, gains a failure count,
		 * which holds the next attempt off for the doubling window above instead
		 * of retrying it at every session start (mantahostels#846). */
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

/* One row per session the listing named. `gate: null` is a session this run
 * took; every other value names the gate that turned it away, so a run that
 * listed sessions and reaped none says WHICH refusal it was. */
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
 * @returns {Candidate[]}  the run record's rows, in that order
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
 * What a stop leaves behind, or "" where the session held nothing. Read only
 * for a session actually being stopped, so a run that stops nothing costs no
 * `git status` at all. A dirty claim is uncommitted work that just became
 * takeable; the marker gates nothing (mantahostels#747). Judged per CLAIM, so a region
 * claim is marked on its own bytes rather than the whole file's (mantahostels#1434).
 * @param {{claims?: string[]}} a
 * @param {(subject: string) => boolean|null} isDirty
 * @returns {string}
 */
function buildClaimLine(a, isDirty) {
	if (!a.claims || a.claims.length === 0) return "";
	const named = a.claims
		.map((/** @type {string} */ f) =>
			isDirty(f) === true ? `${f} (DIRTY)` : f,
		)
		.join(", ");
	return `reap:   it held ${a.claims.length} file claim(s), now stale and breakable by the next session to claim them: ${named}`;
}

/**
 * DEGRADED where no seat's registry would read, so nothing could be judged;
 * CLEAN otherwise.
 * @param {import("./registry-agents.js").RegistryListing} listed
 * @returns {typeof DEGRADED | typeof CLEAN}
 */
const verdictOf = (listed) =>
	listed.seats.length === 0 && listed.faults.length > 0 ? DEGRADED : CLEAN;

/**
 * Where a seat would not read, carries over the state rows of every session
 * this run did not list — a failed stop's back-off above all — rather than
 * dropping them with the sessions that seat could not list.
 * @param {import("./registry-agents.js").RegistryListing} listed
 * @param {State} state
 * @param {State} nextState accumulator: each unlisted session's row is added
 */
function carryUnlisted(listed, state, nextState) {
	if (listed.faults.length === 0) return;
	const seen = new Set(listed.agents.map((a) => a.sessionId));
	for (const [id, row] of Object.entries(state))
		if (!seen.has(id)) nextState[id] = row;
}

/**
 * Names each seat whose registry would not read. It costs that seat's
 * sessions alone: every other seat was judged.
 * @param {string[]} faults
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logFaults(faults, log) {
	for (const fault of faults)
		log(`reap: ${fault}, so its sessions went unjudged`);
}

/**
 * Says where a claim this run leaves stale cannot be named, and only where it
 * stopped, or would stop, something: the line qualifies the held-claim naming
 * under a stop, so a run that stopped nothing has nothing to qualify.
 * check-stranded-file-claims.js reports a bad record under `npm run status`
 * regardless.
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
 * @param {(subject: string) => boolean|null} isDirty
 * @param {(line: string) => void} log
 * @returns {void}
 */
function logWouldStop(done, kept, isDirty, log) {
	for (const a of done) {
		log(`reap: would stop ${a.id} (${a.name}) — ${a.why}`);
		const heldLine = buildClaimLine(a, isDirty);
		if (heldLine) log(heldLine);
	}
	/* A session held back for having no job id has no `a.id` to name it by,
	 * which is the one line that must still identify what it is talking about. */
	for (const a of kept) log(`reap: keeping ${a.id ?? a.sessionId} — ${a.why}`);
	if (done.length === 0) log("reap: nothing to stop");
}

/**
 * The live run's report: what it stopped and returned, what would not stop,
 * and what it held back from retrying.
 * @param {DoneRow[]} done
 * @param {KeptRow[]} kept
 * @param {(subject: string) => boolean|null} isDirty
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
	/* Named every run it is held back, so a genuinely un-reapable session stays
	 * visible while costing neither a MAX_PER_RUN slot nor a stop call (mantahostels#846). */
	for (const a of kept.filter((k) => k.heldBack))
		log(`reap: not retrying ${a.id} (${a.name}) — ${a.why}`);
}

/**
 * The run, with every reading of the outside world and every effect passed in.
 * That is what lets a test drive the degradation paths, which run when the
 * machine is already in trouble and so are the hardest to reproduce for real
 * (mantahostels#493).
 *
 * @param {{argv: string[],
 *   listed: import("./registry-agents.js").RegistryListing,
 *   claims: Claims, self: Self, now: number, state: State,
 *   stop: (id: string, sessionId: string) => StopOutcome,
 *   readPss: (pid: number|null|undefined) => number|null,
 *   saveState: (state: State) => void,
 *   finishAt: (a: {id?: string, sessionId: string}) => number|null,
 *   lastTurn: (a: {id?: string, sessionId: string}) =>
 *     {ended: boolean, at: number|null}|null,
 *   isDirty?: (subject: string) => boolean|null,
 *   runs?: Record<string, RunRecord>,
 *   startedAt?: string,
 *   recordRun?: (record: RunRecord) => void,
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
	/* Defaulted, never required: a caller that forgot the reader must lose the
	 * DIRTY marker rather than throw. */
	isDirty = () => null,
	/* Both defaulted on the same trade: a caller that wired neither loses the run
	 * record, and reaps exactly as before. */
	runs = {},
	/* openRun's stamp, threaded through rather than taken here: this function is
	 * entered only once its arguments — the listing among them — have all been
	 * read. */
	startedAt = new Date(now).toISOString(),
	recordRun = () => {
		/* unrecorded unless a caller asks */
	},
	log,
}) {
	const dryRun = argv.includes("--dry-run");
	const asJson = argv.includes("--json");
	const mode = dryRun ? "dry" : "live";

	/* The previous run of this mode, read before this one replaces it — see the
	 * program's THE RUN RECORD. */
	const prev = runs?.[mode];
	const unfinished =
		prev && typeof prev === "object" && !prev.finishedAt ? prev : null;

	/** Closes the record this run opened. Every exit below goes through it.
	 *
	 * `finishedAt` reads the wall clock rather than the injected `now`, which
	 * `startedAt` above took: a record whose whole job is to prove the run got
	 * past the listing read cannot take both stamps from one frozen value, or
	 * every record shows zero elapsed and the contention this exists to expose
	 * (mantahostels#1920) is invisible in it.
	 * @param {Record<string, unknown>} fields */
	const finish = (fields) =>
		recordRun({
			mode,
			startedAt,
			finishedAt: new Date().toISOString(),
			...fields,
		});

	/* Not in `--json`, whose whole stdout is one object `admission.js` parses. */
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

	/* A claim decides nothing (mantahostels#747), so a store that will not read costs
	 * the report alone: the run goes ahead and says no lock can be named. */
	const claimsUnread = claims.why ?? null;
	/* Named separately from `claimsUnread`, which is the whole store going dark.
	 * These are individual records: every OTHER claim was still judged (mantahostels#1692). */
	const unnamed = claims.unnamed ?? [];
	if (isSelfUnknown(self)) {
		nothing(
			"CLAUDE_CODE_SESSION_ID is unset, so this session cannot be told apart from the ones it would stop",
			{
				listed: listed.agents.length,
				/* Named as gate 2's, not gate 1's: without an id of our own no
				 * candidate is judged at all, so this path cannot say which of them
				 * were finished. */
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
	});

	const done = stopEach(due, nextState, { dryRun, now, stop, readPss });
	carryUnlisted(listed, state, nextState);
	saveState(nextState);

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
	return verdictOf(listed);
}

module.exports = { reap, openedRecord, DEGRADED };
