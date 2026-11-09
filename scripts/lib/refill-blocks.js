/*
 * refill-blocks.js — the refill loop's blocked and resumed-idle launches
 * (#2848, spec #2695): their block and resume records, the act
 * lib/block-act.js's table returns for each, and each act done through the
 * I/O the program passes in (BlockIo). The limit-blocked ones' acts are
 * lib/refill-limits.js's; what both share is lib/refill-block-core.js's.
 */

const { isTerminalAgent } = require("./agent-liveness.js");
const { blockCause, hasEndedUnblocked } = require("./block-cause.js");
const { newestMarkerListing } = require("./parked.js");
const { swapHoldText } = require("./admission.js");
const {
	IDLE_TRIES,
	RESUME_CAP,
	blockAct,
	isFounderWait,
	nextTryAt,
	resumeDueAt,
} = require("./block-act.js");
const {
	API_PROMPT,
	HOLD_PROMPT,
	IDLE_PROMPT,
	BOOT_PROMPT,
	BOOT_UNREAD_PROMPT,
} = require("./loop-prompts.js");
const { buildResumeWaitLine } = require("./refill-decide.js");
const { seatIdOf } = require("./refill-seats.js");
const {
	PARKED_STATE,
	blockedIdsOf,
	buildResumedHow,
	isActionable,
	isHeld,
	isLimitHeld,
	isLive,
	isResuming,
	isStepResume,
	iso,
	launchName,
	ledgerOf,
	relaunched,
	stopJob,
	stopPark,
} = require("./refill-block-core.js");
const {
	adoptTargetOf,
	isLimitBlocked,
	settleStartedLimit,
} = require("./refill-limits.js");

/* #2359's "within one tick": a typed line reaches the timeline at once
 * (#2354 F8), so a minute is ample; untraced. */
const ATTACH_VERDICT_MS = 60 * 1000;
const ATTACH_ROUTE = "typing into the live session";
const FALLBACK_ROUTE = "stop and --bg --resume";
/* The hand-offs of a stopped resumed-idle session tried before the loop gives
 * up on posting it and finishes the launch; untraced. */
const HAND_OFF_TRIES = 3;
/* The resumes of a session stopped under the swap hold that fail before the
 * loop hands it off instead: untraced (#3093). */
const SWAP_RESUME_TRIES = 3;
/* A finished session drops off the listing; one just launched may not be on
 * it yet, so a launch younger than this is never judged finished. Untraced. */
const LISTING_GRACE_MS = 2 * 60 * 1000;

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {LoopLaunch & {jobId: string}} JobLaunch
 * @typedef {JobLaunch & {block: import("./block-act.js").Block}} BlockedLaunch
 * @typedef {import("./block-act.js").Act} Act
 * @typedef {{id: string, issue: number|null}} HoldRef  a repo hold a park is
 *   attached to
 * @typedef {{act: Act, whyEnded?: string, limitParks?: number,
 *   hold?: HoldRef}} ParkWhy  `act`, stop-and-park,
 *   park-at-morning or attach-to-hold; `limitParks`, a limit-cap park's count in
 *   a row, for the marker
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-limits.js").LimitHeld} LimitHeld
 * @typedef {import("./refill-limits.js").LimitAct} LimitAct
 * @typedef {import("./refill-limits.js").MoveTarget} MoveTarget
 * @typedef {{tries: number, triedAt: number, nextAt: number,
 *   attachAt?: number, heldAt?: number}} Resumes  a launch's resumes after an
 *   API error, kept across spells so the cap is the session's (#2705)
 * @typedef {{tries: number, triedAt: number}} IdleResumes  its typed
 *   resumes while resumed-idle (#2659), cleared once it takes a turn
 * @typedef {{at: number, sessionId: string, cwd: string, tries: number,
 *   resumeStartedAt?: number}} StepHeld  a stopped session due back through
 *   the tick's resume step: when, the session and directory its resume runs
 *   in, and the resumes since tried that failed. `resumeStartedAt`, when the
 *   step ran `--bg --resume` on it, on record before the launcher runs and
 *   gone with the hold (#4157)
 * @typedef {{
 *   swapHeld: StepHeld,
 *   holdCleared: StepHeld & {hold: string},
 *   bootKilled: Omit<StepHeld, "sessionId"> & {sessionId: string|null,
 *     flags?: string[]},
 * }} StepPayloads  each step-resume cause's record (STEP_CAUSES).
 *   `swapHeld`, a resumed-idle session the loop stopped under the swap hold
 *   (#3093), `at` the stop, its session read before it. `holdCleared`, a
 *   session parked on a repo hold since cleared (#3863): `at`, when it
 *   parked, and `hold`, that hold's id. `bootKilled`, a session a restart
 *   killed mid-work (#3880): `at`, when it was launched, which sets its turn
 *   among the resumes; `sessionId`, null unread; `flags`, its job's saved
 *   launch flags, read on the tick it is queued, before any resume removes its
 *   job record (#4098)
 * @typedef {keyof StepPayloads} StepCause
 * @typedef {(l: LoopLaunch, row: AgentRecord) =>
 *   import("./block-cause.js").Reading} CauseOf
 * @typedef {{root: string, job: import("./parked.js").ParkJob|null,
 *   limitParks?: number, cause?: string}} ParkRecord  what a park marker
 *   records: the seat, job and cwd a normal-mode loop resumes (#3709), a
 *   limit-cap park's count in a row (#3804) and the block's cause
 * @typedef {{sessionId: string|null, cwd: string, flags?: string[]}}
 *   ResumeTarget  a job's full session id, null unread, the directory its
 *   resume runs in, and the launch flags its job record saved, where it saved
 *   any (#4098)
 * @typedef {(root: string, sessionId: string) =>
 *   NonNullable<LoopLaunch["actsBefore"]>} ReadActsBefore  the acts a session
 *   made before a new launch row wakes it, which are not that launch's (#3942)
 * @typedef {{agents: AgentRecord[]|null, now: number, io: BlockIo,
 *   swapHold: import("./admission.js").SwapHold, barred?: boolean,
 *   net?: NetGate}} Tick  a
 *   tick's listing, null unread; its clock; the program's I/O; the swap hold
 *   (#2690) as read this tick; whether launching is barred, by a pause or a
 *   live launch hold (#4354); its network gate (netGateOf)
 * @typedef {{seat: string, sessionId: string, cwd: string,
 *   copyJobId: string, tries: number}} Unretired  a copy's original whose job
 *   would not stop or leave the job store (#4646): its seat, session and cwd,
 *   the copy it left, and the retirements tried
 * @typedef {{failed: string}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: false}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: true, why: string,
 *   unretired?: Unretired}} Resumed  a
 *   `--bg --resume`: why it failed, else the job it runs on as, its full
 *   session id, null unread, and whether that job is a copy (#2963), with the
 *   reason the harness gave for it (#4098) and its original where that would
 *   not retire, rather than the one woken in place
 * @typedef {Extract<Resumed, {failed: null}>|{unread: string}|null} Adopted
 *   the job a resume started, woken in place or a copy handed what the session
 *   held; why the job store could not tell, or null where it holds neither
 * @typedef {{kind: "api", route: string, again: boolean}|
 *   (LimitAct & {held: LimitHeld})} StartedAct  the act a resume was made for:
 *   an API-error fallBack, told by `route`, `again` its typed resume's
 *   fallback; or a limit act, `held` its hold as the stop leaves it
 * @typedef {{at: number, sessionId: string, cwd: string, act: StartedAct}}
 *   ResumeStarted  a stop and `--bg --resume` of `sessionId` from `cwd` the
 *   loop made at `at` (#4180)
 */

/**
 * A launch's step-resume record, its `cause` naming its STEP_CAUSES row; one
 * cause's alone where `C` names it.
 * @template {StepCause} [C=StepCause]
 * @typedef {{[K in C]: {cause: K} & StepPayloads[K]}[C]} StepResume
 */

/** @typedef {JobLaunch & {stepResume: StepResume}} SteppedLaunch */

/**
 * The program's reads for the acts on blocked and resumed-idle launches. A
 * port that writes or spawns goes in BlockActs, where a dry tick answers it.
 * @typedef {object} BlockReads
 * @property {(l: JobLaunch) => ResumeTarget} resumeTargetOf  read before
 *   its stop, which may rewrite the job record
 * @property {() => string|null} admitResume  the dispatcher's per-member
 *   memory, load and session-ceiling re-read: null where it admits one more
 *   session, else why not
 * @property {(l: JobLaunch) => {state?: unknown, detail?: unknown}|null}
 *   jobStateOf  its job's state.json, null unread
 * @property {(l: JobLaunch) => unknown[]|null} readTimeline  its job's
 *   timeline rows, null unread
 * @property {(l: JobLaunch) => import("./block-cause.js").IdleReading}
 *   idleSince  lib/block-cause.js's resumedIdleSince on its records
 * @property {(l: JobLaunch, at: number) => boolean} hasTurnedSince
 *   lib/block-cause.js's hasTurnedSince on its transcript, false unread
 * @property {(l: JobLaunch, at: number) => boolean|null} hasRepliedSince
 *   lib/block-cause.js's hasRepliedSince on its transcript, null unread
 * @property {(seat: string, jobId: string) => string|null} readJobCwd  the cwd
 *   job `jobId`'s record on `seat` names, null where it names none
 * @property {(root: string) => import("./parked.js").ParkMarkerRead[]|null}
 *   readParkMarkers  those in `root`'s checkout, null where they will not read
 * @property {(marker: import("./parked.js").ParkMarkerRead) =>
 *   {file: string, mtimeMs: number}|null} findParkTranscript  its session's newest
 *   transcript, null where none is found
 * @property {(file: string, who: string) => Record<string, unknown>[]|null}
 *   readMainChain  that transcript's main-chain rows, null where it will not read
 * @property {(l: LoopLaunch) => object} progressOf  a finishing launch's
 *   progress fields, logged
 * @property {ReadActsBefore} readActsBefore
 * @property {() => string|null} probeNetwork  lib/net-probe.js's: null where
 *   the API host is reachable, else why not
 * @property {(l: JobLaunch) => boolean} isResumedSinceStop  whether its
 *   session took a prompt after its API-error stop: its job's `tempo` reads
 *   `active`, or lib/block-cause.js's promptsAfterApiStop reads one; false
 *   unread
 * @property {() => import("./refill-outside.js").Outside[]} readOutside
 *   lib/refill-outside.js's records, none where its file is absent or will
 *   not read
 * @property {(l: JobLaunch) => boolean|null} hasFounderTypedSinceStop
 *   lib/block-cause.js's hasFounderTypedSinceApiStop on its transcript, null
 *   unread
 * @property {(line: string) => void} log
 */

/**
 * The program's writes and child processes for those acts. Each returns why it
 * failed, or null once done, unless said otherwise.
 * @typedef {object} BlockActs
 * @property {(l: JobLaunch, target: ResumeTarget & {sessionId: string},
 *   since: number, move?: MoveTarget) => Adopted} adoptResumed  the job a
 *   resume of its session on `l`'s seat started from `since`, `move` the
 *   target of a move onto that seat
 * @property {(seat: string, jobId: string) =>
 *   import("./claude-stop.js").StopOutcome} stop  `claude stop` on a seat's
 *   job (lib/claude-stop.js's stopOn)
 * @property {(l: JobLaunch, prompt: string) => string|null} type  type
 *   `prompt` into the live session
 * @property {(l: JobLaunch, prompt: string, target: ResumeTarget &
 *   {sessionId: string}) => Resumed} resumeStopped  `claude --bg
 *   --resume` of the stopped job
 * @property {(l: JobLaunch, prompt: string, target: ResumeTarget &
 *   {sessionId: string}) => Resumed} resumeOwnId  `claude --bg --resume` of
 *   a job a restart killed, its record removed first so it keeps its id
 *   (#4098)
 * @property {(l: LoopLaunch) => void} writeLaunch  write the state file with
 *   `l` in place of the launch it was: a resume's stamp before its stop, and its
 *   outcome after (#4180)
 * @property {() => void} stagger  the dispatcher's pause between one launch
 *   and the next member's re-read
 * @property {(l: JobLaunch, target: MoveTarget, prompt: string, ids: ResumeTarget &
 *   {sessionId: string}) => Resumed} moveSession  the stopped session carried
 *   to `target` and resumed there, on an overflow seat recorded as a launch on
 *   its key with its allowance
 * @property {(seat: string, sessionId: string, cwd: string) => string|null}
 *   removeJobRecord  `claude rm` of any job record for it on `seat`, which
 *   keeps transcripts
 * @property {(seat: string, sessionId: string, cwd: string) => string|null}
 *   retireJob  its own job on `seat` stopped and its record removed, unless
 *   that record names another session (lib/refill-resume.js's retireJob)
 * @property {(l: LoopLaunch, until?: number) => boolean} writeLedgerHold  a
 *   dispatch-ledger row on its issues, held past the window to `until` where
 *   given; whether it was written
 * @property {(l: JobLaunch, lockout: import("./block-cause.js").Lockout,
 *   now: number) => {hold: HoldRef}|{why: string}}
 *   holdLockedOut  attach its locked-out session to its checkout's probe
 *   hold, raised where none stands: the hold, else why not
 * @property {(l: LoopLaunch) => {n: number, why: string}[]} labelParked
 *   each of its issues the `parked` label would not go on, with why
 * @property {(sessionId: string, numbers: number[], record: ParkRecord) =>
 *   string|null} recordParked  add `numbers` to the session's `.parked-`
 *   marker in `record.root` (lib/parked.js), with the rest of `record`; null,
 *   else why not, which may carry a stack
 * @property {(root: string, sessionId: string, issues: number[]) => string|null} unparkSession
 *   take the `parked` label and marker off its issues, as its session has gone back
 * @property {(l: LoopLaunch, body: string) => void} comment  on each of its
 *   issues, a failure logged
 * @property {(root: string, args: string[]) => {failed: string|null, out: string}}
 *   postHandOff  `rescue-sessions.js` run with `args` in `root`'s checkout
 * @property {(ledger: {jobId: string, root: string}) => boolean} release  the
 *   dispatch-ledger hold of job `jobId`; whether it went
 * @property {(records: import("./refill-outside.js").Outside[]) => void}
 *   writeOutside  lib/refill-outside.js's records, in place of its file's
 */

/** @typedef {BlockReads & BlockActs} BlockIo */

/**
 * `rescue-sessions.js hand-off` of `l`'s stopped session, `l.sessionId`
 * standing in for a job record that is gone (#3988).
 * @param {JobLaunch} l
 */
const buildHandOffArgs = (l) => [
	"hand-off",
	"--from",
	l.seat,
	"--job",
	l.jobId,
	...(l.sessionId ? ["--session", l.sessionId] : []),
	...l.issues.flatMap((n) => ["--issue", String(n)]),
];

/** @param {string} text */
const indented = (text) => text.replace(/\n/g, "\n  ");

/**
 * A child run's log line: its label, its failure or `exit 0`, then its output
 * indented under it.
 * @param {string} label
 * @param {{out: string, failed?: string|null}} ran
 */
const buildChildLine = (label, ran) =>
	`${label}: ${ran.failed ?? "exit 0"}\n  ${indented(ran.out)}`;

/**
 * @template {LoopLaunch} L
 * @template {StepCause} C
 * @param {L} l
 * @param {C} cause
 * @returns {l is L & {stepResume: StepResume<C>}}
 */
const isStepResumeFor = (l, cause) => l.stepResume?.cause === cause;

/**
 * @typedef {{admit: (name: string) => boolean, waitedLine: () => string|null}}
 *   NetGate  a tick's one network probe (#4815): `admit`, whether a due
 *   resume named `name` may go ahead; and the
 *   log line naming each that waited, null where none did
 */

/**
 * Tick `seen`'s NetGate, made on the first ask and kept on `seen`, so one
 * probe serves the tick.
 * @param {Tick} seen accumulator: the gate is kept on its `net`
 * @returns {NetGate}
 */
function netGateOf(seen) {
	if (seen.net) return seen.net;
	/** @type {string|null|undefined} */
	let why;
	/** @type {string[]} */
	const waited = [];
	const gate = {
		admit: (/** @type {string} */ name) => {
			if (why === undefined) why = seen.io.probeNetwork();
			if (why !== null) waited.push(name);
			return why === null;
		},
		waitedLine: () =>
			waited.length === 0
				? null
				: `the API host is unreachable (${why}), so these due resumes wait for the next tick, no try spent: ${waited.join(", ")}`,
	};
	seen.net = gate;
	return gate;
}

/**
 * Log the due resumes tick `seen` held back for the network, once a tick
 * (#4815).
 * @param {Tick} seen
 */
function logNetWaits(seen) {
	const line = seen.net?.waitedLine();
	if (line) seen.io.log(line);
}

/**
 * `l`'s block with its resume record, as lib/block-act.js reads it.
 * @param {LoopLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const blockOf = (l) => ({
	...l.block,
	tries: l.resumes?.tries ?? 0,
	nextAt: l.resumes?.nextAt,
	triedAt: l.resumes?.triedAt,
	held: l.resumes?.heldAt !== undefined,
	typing: l.resumes?.attachAt !== undefined,
});

/**
 * When the loop's next resume of a launch it resumes after an API error is
 * due.
 * @param {LoopLaunch & {block: import("./block-act.js").Block}} l
 */
const nextResumeAt = (l) => resumeDueAt(blockOf(l));

/**
 * The launches with `parked` read off the listing alone, whether or not the
 * `parked` label is on its issues, and each parked one's `block`: its cause
 * this tick, and since when it has been parked, kept across a change of cause.
 * A parked session is neither finished nor working: it waits in its own thread
 * for the founder's answer (#1995 stories 52, 55). Off an unread listing, for an
 * unlisted launch, for one whose row carries no `state`, or for a held one
 * (isHeld) whose session has ended, each keeps what the last read said; one held under the swap hold whose session
 * the listing shows live again is no longer held (#3093), as one due back off a
 * cleared repo hold, its founder's answer having woken it (#3863), or off a
 * restart, its harness having brought it back (#3880).
 * @param {LoopLaunch[]} launches
 * @param {AgentRecord[]|null} agents
 * @param {CauseOf} causeOf
 * @param {number} now
 */
function markParked(launches, agents, causeOf, now) {
	if (!agents) return launches;
	const rows = new Map(agents.flatMap((a) => (a.id ? [[a.id, a]] : [])));
	return launches.map((l) => {
		const row = l.jobId === null ? undefined : rows.get(l.jobId);
		if (l.finishedAt !== null || !row) return l;
		if (isHeld(l) && isTerminalAgent(row)) return l;
		/* causeOf reads a row carrying no `state` UNKNOWN, and logs why
		 * (#3200). */
		if (row.state == null) {
			causeOf(l, row);
			return l;
		}
		const { block: _, stepResume: __, limitHeld: ___, ...rest } = l;
		if (row.state !== PARKED_STATE) return { ...rest, parked: false };
		const reading = causeOf(l, row);
		return {
			...rest,
			parked: true,
			block: buildBlock(reading, l.block?.since ?? now),
		};
	});
}

/**
 * The block a cause `reading` read first at `since` makes: its cause, and
 * an API_ERROR's kind or the bar a LIMIT's text names.
 * @param {import("./block-cause.js").Reading} reading
 * @param {number} since
 * @returns {import("./block-act.js").Block}
 */
const buildBlock = (reading, since) => ({
	cause: reading.cause,
	...("sub" in reading ? { sub: reading.sub } : {}),
	...("bar" in reading ? { bar: reading.bar } : {}),
	...("lockout" in reading ? { lockout: reading.lockout } : {}),
	since,
});

/**
 * The launches the table acts on this tick, each with its act: those the
 * listing shows blocked, and the held ones (isHeld) whatever it shows, bar
 * the limit-blocked, whose act waits on the seats (actOnLimits). None off an
 * unread listing, which cannot tell a live session from a stopped one.
 * @param {LoopLaunch[]} launches markParked's, off `seen`'s listing
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{l: BlockedLaunch, act: Act}[]}
 */
function blockedActs(launches, mode, { agents, now }) {
	if (!agents) return [];
	const blocked = blockedIdsOf(agents);
	return launches.flatMap((l) => {
		if (
			!isActionable(l) ||
			!l.block ||
			isLimitBlocked(l) ||
			!(blocked.has(l.jobId) || isHeld(l))
		)
			return [];
		const b = { ...l, block: l.block };
		return [{ l: b, act: blockAct(blockOf(b), mode, now) }];
	});
}

/**
 * A resume record after a try made at `now`, `typed` where it went into the
 * live session, so the next tick checks it arrived.
 * @param {{tries: number}|undefined} was
 * @param {number} now
 * @param {boolean} typed
 */
const nextTry = (was, now, typed) => ({
	tries: (was?.tries ?? 0) + 1,
	triedAt: now,
	...(typed ? { attachAt: now } : {}),
});

/**
 * `l` after a resume made at `now`: one more try, the next due on the
 * schedule; `attachAt` where it was typed into the live session; `heldAt`
 * kept where it failed, its session being stopped still.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {{typed: boolean, failed: boolean}} how
 * @returns {L}
 */
function afterResume(l, now, { typed, failed }) {
	const { attachAt, ...tried } = nextTry(l.resumes, now, typed);
	return {
		...l,
		resumes: {
			...tried,
			nextAt: nextTryAt(tried.tries, now),
			...(attachAt === undefined ? {} : { attachAt }),
			...(failed ? { heldAt: l.resumes?.heldAt ?? now } : {}),
		},
	};
}

/**
 * `l` after a typed resume of its resumed-idle session at `now`.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const afterIdleResume = (l, now) => ({
	...l,
	idleResumes: { tries: (l.idleResumes?.tries ?? 0) + 1, triedAt: now },
});

/**
 * Whether a resume typed at `attachAt` arrived (#2354 F8): the timeline has a
 * row after it whose detail is the typed prompt, or the start of it, a long
 * detail being cut short.
 * @param {number} attachAt ms
 * @param {string} prompt
 * @param {unknown[]|null} timeline  the job's timeline rows, null unread
 */
function isResumeArrived(attachAt, prompt, timeline) {
	return (timeline ?? []).some((r) => {
		const row = /** @type {{at?: unknown, detail?: unknown}} */ (r);
		const detail =
			typeof row.detail === "string" ? row.detail.replace(/…$/, "") : "";
		return (
			typeof row.at === "string" &&
			Date.parse(row.at) > attachAt &&
			detail.length > 0 &&
			prompt.startsWith(detail)
		);
	});
}

/**
 * `l` with its resumed-idle episode ended.
 * @template {LoopLaunch} L
 * @param {L} l
 */
function endedIdle(l) {
	const {
		idleResumes: _,
		idleSince: __,
		bootResumedAt: ___,
		blockUnread: ____,
		...rest
	} = l;
	return rest;
}

/**
 * Whether `l`, resumed after a restart killed it, has left the listing with no turn
 * since, past the listing's grace.
 * @param {LoopLaunch} l
 * @param {Tick} seen
 */
const isDeadAfterBootResume = (l, { agents, now, io }) =>
	isLive(l) &&
	l.bootResumedAt !== undefined &&
	agents !== null &&
	now - l.bootResumedAt >= LISTING_GRACE_MS &&
	!isLiveIn(l, agents) &&
	!io.hasTurnedSince(l, l.bootResumedAt);

/**
 * Whether `l`, resumed after a restart killed it, still reads working with no turn
 * since: the harness writes no restart row for a resume, so resumedIdleSince cannot
 * see it (#3880).
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {l is JobLaunch & {bootResumedAt: number}}
 */
const isIdleSinceBootResume = (l, io) =>
	l.bootResumedAt !== undefined &&
	!io.hasTurnedSince(l, l.bootResumedAt) &&
	io.jobStateOf(l)?.state === "working";

/**
 * `l`'s resumed-idle reading off its job store and transcript: "turned"
 * where it took a turn after the loop's last typed resume (#2978), "ended"
 * where its job no longer reads idle, "unread" where its records will not
 * read, else when it went idle, for one resumed after a restart its resume.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {"turned"|"ended"|"unread"|number}
 */
function idleReading(l, io) {
	const at = l.idleResumes?.triedAt;
	if (at !== undefined && io.hasTurnedSince(l, at)) return "turned";
	const since = io.idleSince(l);
	if (since !== null) return since;
	return isIdleSinceBootResume(l, io) ? l.bootResumedAt : "ended";
}

/**
 * The resumed-idle launches (#2659) and the RESUMED_IDLE row's act on each:
 * every actionable launch the loop does not resume after an API error nor
 * hold stopped under the swap hold, whose
 * job `idleSince` reads resumed-idle off the job store and transcript alone,
 * never the listing. Each launch read resumed-idle is returned with its
 * `idleSince` set, kept from the first such reading; one read taking a turn
 * again, an `api-request` or assistant row after the loop's last typed
 * resume included (#2978), with that and its `idleResumes` cleared; one
 * whose records will not read, unchanged (#2847).
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[], acts: {l: BlockedLaunch, act: Act}[]}}
 */
function idleActs(launches, mode, { now, io, swapHold }) {
	/** @type {{l: BlockedLaunch, act: Act}[]} */
	const acts = [];
	const read = launches.map((l) => {
		if (
			!isActionable(l) ||
			isResuming(l) ||
			l.handOffTries !== undefined ||
			isStepResume(l) ||
			isLimitHeld(l)
		)
			return l;
		const since = idleReading(l, io);
		if (since === "unread") return l;
		if (typeof since === "string") return endedIdle(l);
		const idle = { ...l, idleSince: l.idleSince ?? since };
		/* From the loop's own typed resume where later, so each gets its
		 * window. */
		/** @type {import("./block-act.js").Block} */
		const block = {
			cause: "RESUMED_IDLE",
			since: Math.max(since, l.idleResumes?.triedAt ?? 0),
			tries: l.idleResumes?.tries ?? 0,
			swapHeld: swapHold.held,
		};
		acts.push({ l: { ...idle, block }, act: blockAct(block, mode, now) });
		return idle;
	});
	return { launches: read, acts };
}

/**
 * The loop log's line for a resume after an API error, or one that could not
 * be made.
 * @param {LoopLaunch} l  afterResume's
 * @param {string} route  how it went in
 * @param {string|null} failed
 */
function buildResumeLine(l, route, failed) {
	const what = `resume ${l.resumes?.tries ?? 0} of ${RESUME_CAP} after an API error, ${launchName(l)}, by ${route}`;
	if (failed) return `could not ${what}: ${failed}`;
	return l.resumes ? `${what}; next due ${iso(l.resumes.nextAt)}` : what;
}

/**
 * The loop log's line for a typed resume of a resumed-idle session, or one
 * that could not be made.
 * @param {LoopLaunch} l  afterIdleResume's
 * @param {string|null} failed
 */
const buildIdleResumeLine = (l, failed) =>
	`${failed ? "could not resume" : "resumed"} ${launchName(l)}, idle since its host's restart, by ${ATTACH_ROUTE}, try ${l.idleResumes?.tries ?? 0} of ${IDLE_TRIES}${failed ? `: ${failed}` : ""}`;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isAwayPark = (l) => l.parkedAway === true && l.jobId !== null;

/**
 * `launches` once normal mode is live, each stopped for a park in away mode with
 * its dispatch-ledger row released, so its ticket reaches the frontier now and
 * not at the window's end (#3872). A park made in normal mode keeps the window:
 * its session was stopped at a block with the founder there, and an instant
 * relaunch would meet the same block. A release that fails, the ledger
 * unwritable, is logged and tried again next tick.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {string[]} served the checkouts this tick can resume in; another's
 *   row waits, as nothing would take its ticket up
 * @param {Pick<BlockIo, "release"|"log">} io
 * @returns {LoopLaunch[]}
 */
function releaseAwayParks(launches, mode, served, io) {
	if (mode !== "normal") return launches;
	return launches.map((l) => {
		if (!isAwayPark(l) || !served.includes(l.root)) return l;
		if (!io.release(ledgerOf(l))) {
			io.log(
				`could not release ${launchName(l)}'s dispatch-ledger row: its park waits out the window unless a later tick's release takes`,
			);
			return l;
		}
		const { parkedAway: _, ...released } = l;
		return released;
	});
}

/**
 * Attach locked-out `l` to its checkout's probe hold, raised where none stands,
 * then stop and park it there, its issues labelled and in its marker for the
 * hold's resume step (#4228).
 * @param {BlockedLaunch} l
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function parkLockedOut(l, mode, seen) {
	const { lockout } = l.block;
	if (!lockout) return l;
	const held = seen.io.holdLockedOut(l, lockout, seen.now);
	if ("why" in held) {
		seen.io.log(
			`could not attach locked-out ${launchName(l)} to its probe hold, the next tick retries: ${held.why}`,
		);
		return l;
	}
	return stopPark(l, { act: "attach-to-hold", hold: held.hold }, mode, seen);
}

/**
 * `l` with its session marked stopped at `now` until its next resume.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const withHeld = (l, now) =>
	l.resumes ? { ...l, resumes: { ...l.resumes, heldAt: now } } : l;

/**
 * Stop `l`'s resuming session until its next resume (#2359). `l`, marked
 * held once stopped.
 * @param {BlockedLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdForResume(l, { now, io }) {
	const failed = stopJob(l, io);
	io.log(
		failed
			? `could not stop ${launchName(l)} until its next resume: ${failed}`
			: `stopped ${launchName(l)} until its next resume, due ${iso(l.resumes?.nextAt ?? now)}`,
	);
	return failed ? l : withHeld(l, now);
}

/**
 * Stop `l`'s job, then `claude --bg --resume <full id> "<API_PROMPT>"`
 * (#2354 F6). The resume's
 * outcome; `fromSessionId`, the session it resumed.
 * @param {JobLaunch} l
 * @param {Extract<StartedAct, {kind: "api"}>} act
 * @param {Tick} seen
 * @returns {{failed: string}|(Resumed & {fromSessionId: string})}
 */
function relaunchResume(l, act, { now, io }) {
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) return { failed: "no session id read for it" };
	io.writeLaunch({ ...l, resumeStarted: { at: now, sessionId, cwd, act } });
	const stopFailed = stopJob(l, io);
	if (stopFailed) return { failed: `stop: ${stopFailed}` };
	return {
		...io.resumeStopped(l, API_PROMPT, { sessionId, cwd }),
		fromSessionId: sessionId,
	};
}

/**
 * One resume, or one that could not be made, logged and commented on `l`'s
 * issues.
 * @param {LoopLaunch} l  after the try
 * @param {string} line  its cause's line
 * @param {BlockIo} io
 */
function reportResume(l, line, io) {
	io.log(line);
	io.comment(l, `Refill loop: ${line}.`);
}

/**
 * `l` after a resume by stop and `--bg --resume` at `now`: a try of its own,
 * or, the fallback of a typed one, that same try, held where it failed.
 * @param {JobLaunch} l
 * @param {number} now
 * @param {{failed: boolean, again: boolean}} how
 */
function afterFallBack(l, now, { failed, again }) {
	if (!again) return afterResume(l, now, { typed: false, failed });
	return failed ? withHeld(l, now) : l;
}

/**
 * Resume `l`'s API-error stop by stop and `--bg --resume`, never off an
 * unread listing ("doubt never stops a session"), nor where its session took a
 * prompt since the stop (isTakenSinceStop). One whose
 * resume failed is held, its `heldAt` set, for the next on the schedule.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @param {{route: string, again: boolean}} how  how the resume is told in
 *   the log and comment; whether it is the fallback of a typed resume
 *   already made, and so the same try
 * @returns {LoopLaunch}
 */
function fallBack(l, seen, { route, again }) {
	if (!seen.agents) {
		reportResume(
			l,
			buildResumeLine(l, route, "the listing is unread, so it is not stopped"),
			seen.io,
		);
		return l;
	}
	if (isTakenSinceStop(l, launchName(l), seen.io)) {
		if (!l.resumes) return l;
		const { heldAt: _, ...resumes } = l.resumes;
		return { ...l, resumes };
	}
	const act = /** @type {const} */ ({ kind: "api", route, again });
	const out = settleFallBack(l, relaunchResume(l, act, seen), seen, act);
	seen.io.writeLaunch(out);
	return out;
}

/**
 * `l` after fallBack's resume `r` at `now`, reported.
 * @param {JobLaunch} l
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{now: number, io: BlockIo}} seen
 * @param {{route: string, again: boolean}} how  as fallBack's
 * @returns {LoopLaunch}
 */
function settleFallBack(l, r, { now, io }, { route, again }) {
	let resumed = l;
	let told = route;
	if (r.failed === null) {
		resumed = relaunched(l, r, now);
		told = `${route}, ${buildResumedHow(r)}`;
	}
	const tried = {
		...afterFallBack(resumed, now, { failed: r.failed !== null, again }),
		jobId: resumed.jobId,
	};
	reportResume(tried, buildResumeLine(tried, told, r.failed), io);
	return tried;
}

/**
 * The launches with each API-error resume typed a tick ago checked (#2359's
 * route): where its line never reached the timeline, the same try falls back
 * to stop and `--bg --resume`, once the network is up (#4815). None off an unread listing, which could not
 * tell the session's state, the fallback being a stop.
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 */
function settleTyped(launches, seen) {
	const { agents, now, io } = seen;
	if (!agents) return launches;
	return launches.map((l) => {
		const resumes = l.resumes;
		const at = resumes?.attachAt;
		if (!resumes || at === undefined || !isActionable(l)) return l;
		const verdict = typedVerdict(at, l, { now, io });
		if (verdict === "pending") return l;
		const { attachAt: _, ...rest } = resumes;
		const settled = /** @type {JobLaunch} */ ({ ...l, resumes: rest });
		if (!isResuming(settled) || verdict === "arrived") return settled;
		if (!netGateOf(seen).admit(launchName(l))) return l;
		return fallBack(settled, seen, {
			route: `${FALLBACK_ROUTE}, the typed one unseen`,
			again: true,
		});
	});
}

/**
 * A resume typed into `l`'s session at `attachAt`, judged (#2354 F8):
 * `pending` inside the verdict window, `arrived` where the timeline shows it,
 * else `unseen`, for its fallback.
 * @param {number} attachAt
 * @param {JobLaunch} l
 * @param {{now: number, io: BlockIo}} seen
 * @returns {"pending"|"arrived"|"unseen"}
 */
function typedVerdict(attachAt, l, { now, io }) {
	if (now - attachAt < ATTACH_VERDICT_MS) return "pending";
	return isResumeArrived(attachAt, API_PROMPT, io.readTimeline(l))
		? "arrived"
		: "unseen";
}

/**
 * Whether `l`'s session, told as `name`, took a prompt since its API-error
 * stop: the founder's own resume, or a typed one the arrival check missed. A
 * stop and relaunch then would make two sessions of one (#4815), so the
 * resume counts as arrived.
 * @param {JobLaunch} l
 * @param {string} name
 * @param {BlockIo} io
 */
function isTakenSinceStop(l, name, io) {
	if (!io.isResumedSinceStop(l)) return false;
	io.log(
		`${name}'s session took a prompt since its API-error stop, so it is neither stopped nor copied: its resume counts as arrived`,
	);
	return true;
}

/**
 * Whether `l`'s session is live, or the listing unread.
 * @param {JobLaunch} l
 * @param {AgentRecord[]|null} agents
 */
const isLiveIn = (l, agents) =>
	!agents || agents.some((a) => a.id === l.jobId && !isTerminalAgent(a));

/**
 * Resume `l`'s API-error stop (#2705): typed into its session where it is
 * live or the listing is unread; else, or where the typing failed, by
 * fallBack. Never while the network is down (#4815).
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function makeResume(l, seen) {
	const { agents, now, io } = seen;
	if (!netGateOf(seen).admit(launchName(l))) return l;
	const live = isLiveIn(l, agents);
	const typeFailed = live ? io.type(l, API_PROMPT) : null;
	if (typeFailed)
		io.log(`could not type the resume into ${l.jobId}: ${typeFailed}`);
	if (!live || typeFailed)
		return fallBack(l, seen, { route: FALLBACK_ROUTE, again: false });
	const tried = afterResume(l, now, { typed: true, failed: false });
	reportResume(tried, buildResumeLine(tried, ATTACH_ROUTE, null), io);
	return tried;
}

/**
 * The prompt that resumes `l`: `plain`, unless a restart killed it on a block the
 * loop could not read and it has taken no turn since (#3980).
 * @param {LoopLaunch} l
 * @param {string} plain
 */
const resumePromptOf = (l, plain) =>
	l.blockUnread ? BOOT_UNREAD_PROMPT : plain;

/**
 * Type the resume into `l`'s resumed-idle session (#2978): never a stop, so
 * an unread listing types too. A try that could not be typed still counts,
 * so a session the loop cannot reach is handed off on the table's schedule;
 * a later tick reads the transcript for its turn (idleActs).
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function typeIdleResume(l, { agents, now, io }) {
	const failed = isLiveIn(l, agents)
		? io.type(l, resumePromptOf(l, IDLE_PROMPT))
		: "its session is not live";
	const tried = afterIdleResume(l, now);
	reportResume(tried, buildIdleResumeLine(tried, failed), io);
	return tried;
}

/** Why idleSpared spares a launch, by its idleReading. */
const SPARED_WHY = {
	turned: "it took a turn after its resume",
	ended: "its job is no longer idle",
	unread: "its resumed-idle records are unread",
};

/**
 * `l` where its records, read again just before a stop, no longer read
 * resumed-idle (#2979): an `api-request` or assistant row after the loop's
 * last resume, or a job no longer working, ends the episode (endedIdle), and
 * records that will not read stop nothing ("doubt never stops a session"),
 * each logged. Null where it still reads idle.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {LoopLaunch|null}
 */
function idleSpared(l, io) {
	const since = idleReading(l, io);
	if (typeof since === "number") return null;
	io.log(`not stopping ${launchName(l)}: ${SPARED_WHY[since]}`);
	return since === "unread" ? l : endedIdle(l);
}

/**
 * Stop `b`'s resumed-idle session, still idle after its typed resumes, and
 * hand its issues to a fresh launch (#2659): `io.postHandOff`, which posts
 * its snapshot as a `**Hand-off:**` comment on each and releases its claim.
 * Its launch is finished and its dispatch-ledger hold released (#2744), so
 * the next tick may relaunch its issues within the ledger's hour; a failed
 * hand-off is retried on the next tick, the session left stopped, up to
 * HAND_OFF_TRIES. One given up keeps its hold, as its claim may still stand
 * and no snapshot was posted, so its issues wait out the hour. Never off an
 * unread listing ("doubt never stops a session"), nor where idleSpared
 * spares it.
 * @param {JobLaunch} b
 * @param {Tick} seen
 * @param {boolean} [stopped]  its stop already held, on a retried hand-off
 * @returns {LoopLaunch}
 */
function handOff(b, { agents, now, io }, stopped = false) {
	const { block: _, ...l } = b;
	if (!agents) {
		io.log(`not handing off ${launchName(l)}: the listing is unread`);
		return l;
	}
	const spared = stopped ? null : idleSpared(l, io);
	if (spared) return spared;
	const failed = stopped ? null : stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${launchName(l)} to hand it off: ${failed}`);
		return l;
	}
	const r = io.postHandOff(b.root, buildHandOffArgs(b));
	io.log(
		buildChildLine(
			`stopped ${launchName(l)}, idle after its resume, and handed it off`,
			r,
		),
	);
	const tries = (l.handOffTries ?? 0) + 1;
	if (r.failed && tries < HAND_OFF_TRIES) return { ...l, handOffTries: tries };
	if (r.failed)
		io.log(`gave up handing off ${launchName(l)} after ${tries} tries`);
	else if (!io.release(ledgerOf(b)))
		io.log(
			`could not release ${launchName(l)}'s dispatch-ledger hold: its issues wait out the hour (#2744)`,
		);
	const { handOffTries: __, ...done } = l;
	return {
		...done,
		...io.progressOf(done),
		finishedAt: now,
		handedOff: now,
	};
}

/**
 * Stop `b`'s resumed-idle session under the swap hold until it clears
 * (#3093, #3084). Its resume target is read first, the stop being free to
 * rewrite the job record; one with no session id is not stopped, as nothing
 * could resume it. A stop that fails, a job not found included, is logged
 * and never held, so the next tick tries again; never off an unread listing,
 * nor where idleSpared spares it. Its typed resumes are kept across the
 * hold, so one idle by its own fault still meets its hand-off.
 * @param {BlockedLaunch} b
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdIdle(b, { agents, now, io, swapHold }) {
	const { block: _, ...l } = b;
	const what = `${launchName(l)}, restarted by its host, under the swap hold${swapHold.held ? ` (${swapHoldText(swapHold)})` : ""}`;
	if (!agents) {
		io.log(`not stopping ${what}: the listing is unread`);
		return l;
	}
	const spared = idleSpared(l, io);
	if (spared) return spared;
	const { sessionId, cwd } = io.resumeTargetOf(b);
	if (!sessionId) {
		io.log(`not stopping ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${what}: ${failed}`);
		return l;
	}
	io.log(`stopped ${what}, until the hold clears`);
	const { idleSince: __, ...stopped } = l;
	return {
		...stopped,
		stepResume: { cause: "swapHeld", at: now, sessionId, cwd, tries: 0 },
	};
}

/**
 * The resume step's handling of one cause: `what`, the launch as its lines
 * name it; `why`, what brings it back; `prompt`, what its resume types;
 * `isParked`, whether it waits parked, so its resume unparks it;
 * `watchesTurn`, whether the launch is watched from its resume for a turn
 * (isIdleSinceBootResume); `resume`, its `--bg --resume`; `status`, its state
 * in `status`, under `kind`; `isUnsettled`, whether `status` lists it past its
 * launch window.
 * @template {StepCause} C
 * @typedef {{kind: string, isUnsettled: boolean,
 *   what: (l: LoopLaunch, held: StepResume<C>) => string,
 *   why: string, prompt: (l: LoopLaunch) => string, isParked: boolean,
 *   watchesTurn: boolean,
 *   resume: (io: BlockIo, step: {l: JobLaunch, prompt: string,
 *     target: ResumeTarget & {sessionId: string}, held: StepResume<C>}) =>
 *     Resumed,
 *   status: (held: StepResume<C>) => string}} StepCauseRow
 */

/** @type {StepCauseRow<"swapHeld"|"holdCleared">["resume"]} */
const resumeStopped = (io, { l, prompt, target }) =>
	io.resumeStopped(l, prompt, target);

/** @type {{[C in StepCause]: StepCauseRow<C>}} */
const STEP_CAUSES = {
	swapHeld: {
		kind: "swap-held",
		isUnsettled: true,
		what: (l, held) =>
			`${launchName(l)}, stopped under the swap hold at ${iso(held.at)}`,
		why: "the hold cleared",
		prompt: (l) => resumePromptOf(l, IDLE_PROMPT),
		isParked: false,
		watchesTurn: false,
		resume: resumeStopped,
		status: (held) =>
			`stopped under the swap hold since ${iso(held.at)}, resumed through admission once it clears`,
	},
	holdCleared: {
		kind: "hold-cleared",
		isUnsettled: false,
		what: (l, held) =>
			`${launchName(l)}, parked at ${iso(held.at)} on repo hold ${held.hold}`,
		why: "the hold cleared",
		prompt: () => HOLD_PROMPT,
		isParked: true,
		watchesTurn: false,
		resume: resumeStopped,
		status: (held) =>
			`parked on repo hold ${held.hold}, since cleared, resumed through admission`,
	},
	bootKilled: {
		kind: "boot-killed",
		isUnsettled: false,
		what: (l) => `${launchName(l)}, launched at ${iso(l.launchedAt)}`,
		why: "killed by a restart",
		prompt: (l) => resumePromptOf(l, BOOT_PROMPT),
		isParked: false,
		watchesTurn: true,
		resume: (io, { l, prompt, target, held }) =>
			io.resumeOwnId(l, prompt, {
				...target,
				...(held.flags ? { flags: held.flags } : {}),
			}),
		status: () => "killed by a restart, resumed through admission",
	},
};

/**
 * @template {StepCause} C
 * @param {StepResume<C>} held
 * @returns {StepCauseRow<C>}
 */
const stepCauseOf = (held) => STEP_CAUSES[held.cause];

/**
 * @param {StepResume} held
 */
const buildStepStatus = (held) => stepCauseOf(held).status(held);

/**
 * @param {StepResume} held
 */
const stepKindOf = (held) => stepCauseOf(held).kind;

/* The step kinds `status` lists past its launch window. */
const UNSETTLED_STEP_KINDS = Object.values(STEP_CAUSES)
	.filter((row) => row.isUnsettled)
	.map((row) => row.kind);

/**
 * `held`'s row with `l` and its hold bound, for the resume step.
 * @template {StepCause} C
 * @param {StepResume<C>} held
 * @param {JobLaunch} l
 */
function bindStepCause(held, l) {
	const row = stepCauseOf(held);
	const prompt = row.prompt(l);
	return {
		what: row.what(l, held),
		why: row.why,
		prompt,
		isParked: row.isParked,
		watchesTurn: row.watchesTurn,
		/**
		 * @param {BlockIo} io
		 * @param {ResumeTarget & {sessionId: string}} target
		 */
		resume: (io, target) => row.resume(io, { l, prompt, target, held }),
	};
}

/**
 * What the resume step needs of `l`: its cause's handling with its hold bound,
 * `rest`, `l` off its hold; `withStarted`, `l` with its hold's resume stamped
 * `at`.
 * @param {SteppedLaunch} l
 */
function stepResumeOf(l) {
	const held = l.stepResume;
	const { stepResume: _, ...rest } = l;
	return {
		...bindStepCause(held, l),
		held,
		/** @type {JobLaunch} */ rest,
		/** @param {number} tries @returns {JobLaunch} */
		withTries: (tries) => ({ ...l, stepResume: { ...held, tries } }),
		/** @param {number} at @returns {JobLaunch} */
		withStarted: (at) => ({
			...l,
			stepResume: { ...held, resumeStartedAt: at },
		}),
	};
}

/**
 * The sessions due back through the tick's resume step, for its decision to pace
 * (#3855): those stopped under the swap hold, those parked on a cleared repo hold
 * (#3863) and those a restart killed (#3880), none while the swap hold stands, and
 * none off an unread listing, as one live again is not yet told from one still
 * stopped.
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @returns {import("./refill-decide.js").HeldResume[]}
 */
function resumableOf(launches, { agents, io, swapHold }) {
	if (swapHold.held) return [];
	const due = launches.filter(isActionable).filter(isStepResume);
	if (!agents) {
		for (const l of due)
			io.log(`not resuming ${stepResumeOf(l).what}: the listing is unread`);
		return [];
	}
	return due.map((l) => {
		const { held, what } = stepResumeOf(l);
		return {
			jobId: l.jobId,
			...seatIdOf(l),
			root: l.root,
			at: held.at,
			line: `${l.jobId} ${what}`,
		};
	});
}

/**
 * `l` after its step resume `r` of session `from` at `at`: one a restart killed
 * is watched from the resume for a turn, however many holds it meets on the way
 * (isIdleSinceBootResume).
 * @param {JobLaunch} l
 * @param {ReturnType<typeof stepResumeOf>} step
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} r
 * @param {number} at
 * @returns {LoopLaunch}
 */
function afterStepResume(l, { rest, watchesTurn }, r, at) {
	const resumed = relaunched(rest, r, at);
	return watchesTurn || l.bootResumedAt !== undefined
		? { ...resumed, bootResumedAt: at }
		: resumed;
}

/**
 * Take `parked` off a step-resumed session parked on a repo hold; logged where
 * it stays.
 * @param {JobLaunch} l
 * @param {string} sessionId
 * @param {ReturnType<typeof stepResumeOf>} step
 * @param {BlockIo} io
 */
function unparkStepped(l, sessionId, { isParked, what }, io) {
	if (!isParked) return;
	const failed = io.unparkSession(l.root, sessionId, l.issues);
	if (failed) io.log(`${what}: still labelled parked: ${failed}`);
}

/**
 * `l` tracking the job its last step resume started, woken in place or a copy,
 * where a kill came between that resume and the state write that would have
 * recorded it (#4157); null where it carries no such resume or no job is found,
 * so the step resumes it.
 * Where the job store will not tell, that is logged and the step resumes it too.
 * @param {SteppedLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch|null}
 */
function adoptUnrecordedCopy(l, seen) {
	const step = stepResumeOf(l);
	const { held, what, why } = step;
	const { sessionId, cwd, resumeStartedAt: at } = held;
	if (at === undefined || !sessionId) return null;
	const r = seen.io.adoptResumed(l, { sessionId, cwd }, at);
	if (r === null) return null;
	if ("unread" in r) {
		seen.io.log(
			`${what}: whether its resume at ${iso(at)} started a copy is unread, so it is resumed again: ${r.unread}`,
		);
		return null;
	}
	const launch = afterStepResume(
		l,
		step,
		{ ...r, fromSessionId: sessionId },
		at,
	);
	seen.io.log(
		`resumed ${what}, ${why}, by --bg --resume at ${iso(at)}, ${buildResumedHow(r)}, which a kill left out of the state: tracking it, not resuming again`,
	);
	unparkStepped(l, sessionId, step, seen.io);
	return launch;
}

/**
 * Resume `l`: `claude --bg --resume` of its session with its cause's prompt. One
 * whose resume fails stays held for the next tick, and after SWAP_RESUME_TRIES
 * failures is handed off instead. One parked on a repo hold no longer waits on the
 * founder either way, so its `parked` label and marker go.
 * @param {SteppedLaunch} l
 * @param {Tick} seen
 * @returns {{launch: LoopLaunch, started: boolean}}
 */
function resumeStepHeld(l, seen) {
	const { now, io } = seen;
	const step = stepResumeOf(l);
	const { held, what, why, rest, withTries } = step;
	const { sessionId, cwd } = held;
	if (!sessionId) {
		io.log(`${what}, ${why}: no session id read to resume it by`);
		return { launch: handOff(rest, seen, true), started: false };
	}
	const unpark = () => unparkStepped(l, sessionId, step, io);
	const r = step.resume(io, { sessionId, cwd });
	if (r.failed === null) {
		const launch = afterStepResume(
			l,
			step,
			{ ...r, fromSessionId: sessionId },
			now,
		);
		io.log(`resumed ${what}, ${why}, by --bg --resume, ${buildResumedHow(r)}`);
		unpark();
		return { launch, started: true };
	}
	const tries = held.tries + 1;
	io.log(
		`could not resume ${what}, try ${tries} of ${SWAP_RESUME_TRIES}: ${r.failed}`,
	);
	if (tries < SWAP_RESUME_TRIES)
		return { launch: withTries(tries), started: false };
	unpark();
	return { launch: handOff(rest, seen, true), started: false };
}

/**
 * lib/block-cause.js's hasEndedUnblocked for `marker`'s session. A transcript
 * untouched since the park is not read, so a tick costs a stat per waiting park.
 * No transcript, or one that will not read, is false: the label stays (#3940).
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {BlockIo} io
 */
function hasParkEndedUnblocked(marker, io) {
	const found = io.findParkTranscript(marker);
	if (!found || found.mtimeMs <= marker.writtenAt) return false;
	const rows = io.readMainChain(found.file, marker.sessionId);
	return rows !== null && hasEndedUnblocked(rows, marker.writtenAt);
}

/**
 * Take `parked` off what each park marker in `roots` holds, where its session is
 * no longer running and took a turn since the park that left it unblocked: a `!`
 * answer fires no hook, so that turn is the only sign the question was answered
 * (#3940). Off the markers, not the launches, so a session reopened by `claude
 * attach`, one no loop launched and a failed label write are all met on a later
 * tick. An issue a newer park holds waits on that park's session. Off an unread
 * listing, nothing.
 * @param {string[]} roots
 * @param {Pick<Tick, "agents"|"io">} seen
 */
function unparkAnswered(roots, { agents, io }) {
	if (!agents) return;
	const running = new Set(
		agents
			.filter((a) => !isTerminalAgent(a))
			.flatMap((a) => [a.sessionId, a.id])
			.filter(Boolean),
	);
	for (const root of roots) {
		const markers = io.readParkMarkers(root) ?? [];
		for (const marker of markers) {
			if (running.has(marker.sessionId) || running.has(marker.job?.jobId))
				continue;
			const issues = marker.issues.filter(
				(n) => newestMarkerListing(markers, n) === marker,
			);
			if (issues.length > 0 && hasParkEndedUnblocked(marker, io))
				unparkAndLog(root, marker.sessionId, issues, io);
		}
	}
}

/**
 * Unpark `issues` for session `sessionId`, logged.
 * @param {string} root
 * @param {string} sessionId
 * @param {number[]} issues
 * @param {BlockIo} io
 */
function unparkAndLog(root, sessionId, issues, io) {
	const named = issues.map((n) => `#${n}`).join(", ");
	const failed = io.unparkSession(root, sessionId, issues);
	io.log(
		failed
			? `session ${sessionId} ended unblocked: ${named} still labelled parked: ${failed}`
			: `session ${sessionId} ended unblocked: parked off ${named}`,
	);
}

/**
 * The tick's one resume step (#3855): each of the decision's resumes, in its
 * order, past the dispatcher's per-member re-read, as a stopped session is
 * charged nothing by admission and so counts as new draw. The first the re-read
 * refuses waits for a later tick with all behind it, charged no try, so none
 * overtakes it, and `waiting` holds the tick's launches back behind it; all
 * wait once a stop lands. As in the dispatcher, the next re-read, a resume's or
 * a launch's, waits out a started session's spare.
 * @param {import("./refill-decide.js").HeldResume[]} resumes
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @param {{isStopped: () => boolean,
 *   record: (launches: LoopLaunch[]) => void}} step  `record` writes the state
 *   with `launches`, before each resume's launcher runs and after it (#4157)
 * @returns {{launches: LoopLaunch[], started: number, waiting: boolean}}
 */
function resumeHeldLaunches(resumes, launches, seen, { isStopped, record }) {
	const { io } = seen;
	/** @type {Map<LoopLaunch, LoopLaunch>} */
	const acted = new Map();
	const current = () => launches.map((l) => acted.get(l) ?? l);
	let started = 0;
	let waiting = false;
	for (const { jobId, line } of resumes) {
		const l = launches.filter(isStepResume).find((x) => x.jobId === jobId);
		if (!l || !isActionable(l) || isStopped()) break;
		const adopted = adoptUnrecordedCopy(l, seen);
		if (adopted) {
			acted.set(l, adopted);
			record(current());
			continue;
		}
		const refused = io.admitResume();
		if (refused) {
			io.log(buildResumeWaitLine(line, refused));
			waiting = true;
			break;
		}
		acted.set(l, stepResumeOf(l).withStarted(seen.now));
		record(current());
		const out = resumeStepHeld(l, seen);
		acted.set(l, out.launch);
		record(current());
		if (out.started) {
			started += 1;
			io.stagger();
		}
	}
	return { launches: current(), started, waiting };
}

/**
 * The launch record for a session the loop never launched (#3709), off the park
 * marker that lists its issues, counting only the acts it makes from here (#3942).
 * @param {string} job
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {ReadActsBefore} readActsBefore
 * @returns {LoopLaunch}
 */
const buildMarkerLaunch = (job, marker, hold, readActsBefore) => ({
	root: hold.root,
	issues: marker.issues,
	prompt: `parked ${marker.issues.map((n) => `#${n}`).join(" ")}`,
	...seatIdOf({ seat: marker.job?.seat ?? "", keyVar: marker.job?.keyVar }),
	reason: /** @type {const} */ ("parked session's seat"),
	jobId: job,
	sessionId: marker.sessionId,
	launchedAt: marker.writtenAt,
	finishedAt: null,
	actsBefore: readActsBefore(hold.root, marker.sessionId),
});

/**
 * The launch due back for job `job`, parked on lifted hold `hold`, off the park
 * marker that lists its issues: `from`, its launch record, made unfinished again
 * until the resume step takes it.
 * @param {string} job
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {LoopLaunch} from
 * @returns {JobLaunch}
 */
function buildClearedLaunch(job, marker, hold, from) {
	const {
		block: _,
		parked: __,
		parkStopped: ___,
		parkedAway: ____,
		handOffTries: _____,
		handedOff: ______,
		nothingToRepeat: _______,
		...base
	} = from;
	return {
		...base,
		issues: [...new Set([...base.issues, ...marker.issues])],
		jobId: job,
		finishedAt: null,
		stepResume: {
			cause: "holdCleared",
			at: marker.writtenAt,
			sessionId: marker.sessionId,
			cwd: marker.job?.cwd ?? hold.root,
			tries: 0,
			hold: hold.id,
		},
	};
}

/**
 * One session parked on a lifted hold, judged: whether it is settled, and its launch
 * where the resume step is to take it. Only a marker listing its issues reads as
 * still parked: the founder's answer empties it (unpark-on-prompt.js), as does a
 * resume to a copy. A session listed live with no block is awake already, and one
 * handed off, or whose ticket another live launch holds, has been replaced. One
 * blocked, in a normal-mode loop that leaves its round waiting, is stopped first,
 * as `--bg --resume` takes a stopped job; a stop that fails is tried next tick.
 * RESIDUAL: a park the loop could not label has no marker, so it is left alone, its
 * ticket coming back through the ledger's window.
 * @param {string} job
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {{launches: LoopLaunch[],
 *   markers: import("./parked.js").ParkMarkerRead[]}} read
 * @param {Tick} seen
 * @returns {{isSettled: boolean, launch?: JobLaunch}}
 */
function judgeClearedJob(job, hold, { launches, markers }, { agents, io }) {
	const known = launches.findLast((l) => l.jobId === job);
	if (known && isStepResumeFor(known, "holdCleared"))
		return { isSettled: true };
	const row = agents?.find((a) => a.id === job);
	const isBlocked = row?.state === PARKED_STATE;
	const marker =
		markers.find((m) => m.job?.jobId === job) ??
		markers.find((m) => m.sessionId === known?.sessionId);
	const name = `session ${job}, parked on repo hold ${hold.id} now cleared`;
	if (!marker) {
		io.log(`left ${name} alone: no park marker lists its issues`);
		return { isSettled: true };
	}
	if (row && !isTerminalAgent(row) && !isBlocked) {
		io.log(`left ${name} alone: it is live`);
		return { isSettled: true };
	}
	if (known?.handedOff !== undefined) {
		io.log(`left ${name} alone: it was handed off`);
		return { isSettled: true };
	}
	const holder = launches.find(
		(l) =>
			isLive(l) &&
			l.jobId !== job &&
			l.root === hold.root &&
			l.issues.some((n) => marker.issues.includes(n)),
	);
	if (holder) {
		io.log(`left ${name} alone: ${launchName(holder)} now holds its ticket`);
		return { isSettled: true };
	}
	const launch = buildClearedLaunch(
		job,
		marker,
		hold,
		known ?? buildMarkerLaunch(job, marker, hold, io.readActsBefore),
	);
	if (isBlocked) {
		const r = io.stop(launch.seat, job);
		if (!r.ok && !r.noJob) {
			io.log(`could not stop ${name}, the next tick retries: ${r.why}`);
			return { isSettled: false };
		}
	}
	io.log(`${name}: due back through the resume step`);
	return { isSettled: true, launch };
}

/**
 * The launches with each session parked on a lifted repo hold queued for the resume
 * step, and each one due back whose founder has since answered it finished (#3863):
 * `settled` says what of each hold the caller may drop once the state is written, a
 * crash before then reading it again and queuing none twice. Nothing is judged off an
 * unread listing or marker directory.
 * @param {LoopLaunch[]} launches
 * @param {import("./repo-holds.js").LiftedHold[]} lifted
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[],
 *   settled: {hold: import("./repo-holds.js").LiftedHold, jobs: string[]}[]}}
 */
function queueLifted(launches, lifted, seen) {
	const { agents, io, now } = seen;
	if (!agents) return { launches, settled: [] };
	/** @type {Map<string, import("./parked.js").ParkMarkerRead[]|null>} */
	const byRoot = new Map();
	/** @param {string} root */
	const readMarkersIn = (root) => {
		const read = byRoot.get(root);
		if (read !== undefined) return read;
		const fresh = io.readParkMarkers(root);
		byRoot.set(root, fresh);
		return fresh;
	};
	let next = launches.map((l) => {
		if (!isActionable(l) || !isStepResumeFor(l, "holdCleared")) return l;
		const markers = readMarkersIn(l.root);
		if (!markers || markers.some((m) => m.sessionId === l.stepResume.sessionId))
			return l;
		io.log(
			`not resuming ${STEP_CAUSES.holdCleared.what(l, l.stepResume)}: its park marker no longer lists its issues`,
		);
		const { stepResume: _, ...rest } = l;
		return { ...rest, ...io.progressOf(rest), finishedAt: now };
	});
	const settled = lifted.flatMap((hold) => {
		const markers = readMarkersIn(hold.root);
		if (!markers) return [];
		const jobs = hold.jobs.filter((job) => {
			const { isSettled, launch } = judgeClearedJob(
				job,
				hold,
				{ launches: next, markers },
				seen,
			);
			if (launch) {
				const newest = next.findLastIndex((l) => l.jobId === job);
				next = newest < 0 ? [...next, launch] : next.with(newest, launch);
			}
			return isSettled;
		});
		return [{ hold, jobs }];
	});
	return { launches: next, settled };
}

/* The job states of a session that ended on its own before the restart. Not
 * `failed`, which a killed job may read, and a failed resume costs only its tries;
 * an unread record is resumed for the same reason. */
const ENDED_JOB_STATES = new Set(["done", "stopped"]);

/**
 * Whether the saved state alone leaves `l` one a restart may have killed: not
 * already held or being handed off and not waiting on the founder (#3983).
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isBootKillCandidate = (l) =>
	isActionable(l) &&
	!isHeld(l) &&
	l.handOffTries === undefined &&
	!(l.parked && isFounderWait(l.block?.cause));

/**
 * Whether `l`'s job record reads it ended on its own (ENDED_JOB_STATES).
 * @param {JobLaunch} l
 * @param {Pick<BlockReads, "jobStateOf">} io
 */
const hasJobEnded = (l, io) => {
	const state = io.jobStateOf(l)?.state;
	return typeof state === "string" && ENDED_JOB_STATES.has(state);
};

/**
 * Whether `l`'s session was at work when a restart killed it: a candidate not
 * listed live, not ended on its own between the last tick and the restart, and not
 * launched since it (#3971).
 * @param {LoopLaunch} l
 * @param {Tick} seen
 * @param {number} bootedAt
 * @returns {l is JobLaunch}
 */
function isBootKillable(l, { agents, io }, bootedAt) {
	if (l.launchedAt > bootedAt) return false;
	return isBootKillCandidate(l) && !isLiveIn(l, agents) && !hasJobEnded(l, io);
}

/**
 * The launches on the first tick after a boot, with each its restart killed queued
 * for the resume step by session id, keeping its context and claim (#3880). One
 * with no session id to resume by meets its hand-off at that step, so a pause holds
 * it too.
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @param {number} bootedAt when `boot-resume` saw the restart
 * @param {(l: LoopLaunch) => boolean} [isSpared] left as it is, though killable
 * @returns {LoopLaunch[]}
 */
function queueBootKilled(launches, seen, bootedAt, isSpared = () => false) {
	const { io } = seen;
	return launches.map((l) => {
		if (isSpared(l) || !isBootKillable(l, seen, bootedAt)) return l;
		const { block: _, parked: __, ...rest } = l;
		const { sessionId, cwd, flags } = io.resumeTargetOf(l);
		io.log(
			`${launchName(l)}, killed by a restart: due back through the resume step`,
		);
		return {
			...rest,
			...(l.block?.cause === "UNKNOWN" ? { blockUnread: true } : {}),
			stepResume: {
				cause: "bootKilled",
				at: l.launchedAt,
				sessionId,
				cwd,
				...(flags ? { flags } : {}),
				tries: 0,
			},
		};
	});
}

/**
 * @typedef {{mode: "away"|"normal", resume: (l: BlockedLaunch, seen: Tick)
 *   => LoopLaunch, hold: (l: BlockedLaunch, seen: Tick) => LoopLaunch}}
 *   ActHow  `resume` and `hold`, the acts of those names for the cause
 */

/**
 * Each act's handler, for blocked and resumed-idle launches alike; `wait` and
 * `none` have none.
 * @type {Partial<Record<Act, (l: BlockedLaunch, seen: Tick, how: ActHow) =>
 *   LoopLaunch>>}
 */
const ACTS = {
	"stop-and-park": (l, seen, { mode }) =>
		stopPark(l, { act: "stop-and-park" }, mode, seen),
	"park-at-morning": (l, seen, { mode }) =>
		stopPark(l, { act: "park-at-morning" }, mode, seen),
	"attach-to-hold": (l, seen, { mode }) => parkLockedOut(l, mode, seen),
	hold: (l, seen, { hold }) => hold(l, seen),
	resume: (l, seen, { resume }) => resume(l, seen),
	"handoff-relaunch": (l, seen) => handOff(l, seen),
};

/* The acts that set a session running, which spends allowance, so a barred
 * tick leaves them for the tick after the resume (#3856). */
const RUNNING_ACTS = new Set(["resume", "handoff-relaunch"]);

/**
 * Each of `acts` done through ACTS, by job id.
 * @param {{l: BlockedLaunch, act: Act}[]} acts
 * @param {Tick} seen
 * @param {ActHow} how
 * @returns {Map<string, LoopLaunch>}
 */
function actedOn(acts, seen, how) {
	const acted = new Map();
	for (const { l, act } of acts) {
		const handler = ACTS[act];
		if (handler && !(seen.barred && RUNNING_ACTS.has(act)))
			acted.set(l.jobId, handler(l, seen, how));
	}
	return acted;
}

/**
 * The launches with each launch in `acted` put in, by job id.
 * @param {LoopLaunch[]} launches
 * @param {Map<string, LoopLaunch>} acted
 */
const withActed = (launches, acted) =>
	launches.map((l) => (l.jobId && acted.get(l.jobId)) || l);

/**
 * The tick's acts on blocked launches: each typed resume checked, then the
 * table's act on each (blockedActs). A barred tick checks none, as a failed
 * check falls back to a resume.
 * @param {LoopLaunch[]} launches markParked's, off `seen`'s listing
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnBlocks(launches, mode, seen) {
	const settled = seen.barred ? launches : settleTyped(launches, seen);
	const acts = blockedActs(settled, mode, seen);
	return withActed(
		settled,
		actedOn(acts, seen, { mode, resume: makeResume, hold: holdForResume }),
	);
}

/**
 * The launches with each resume a kill left out of the state settled (#4180):
 * one carrying `resumeStarted` gets the outcome its act would have given it,
 * the job the resume started where the job store holds one, else a failed try,
 * which its act's own schedule tries again. Where the store will not tell, the
 * try counts failed too, and says why, as #4157's step resumes it. `settled`,
 * whether any was.
 * @param {LoopLaunch[]} launches
 * @param {BlockIo} io
 * @returns {{launches: LoopLaunch[], settled: boolean}}
 */
function settleStartedResumes(launches, io) {
	let settled = false;
	const out = launches.map((launch) => {
		const { resumeStarted: started, ...l } = launch;
		if (!started || l.jobId === null) return launch;
		settled = true;
		return settleStarted({ ...l, jobId: l.jobId }, started, io);
	});
	return { launches: out, settled };
}

/**
 * `l` after the resume `started`, which a kill left with no outcome on record:
 * the job it started tracked; else, where `l`'s own job reads stopped, a failed
 * try; else the kill came before the stop, and `l` is left to its act.
 * @param {JobLaunch} l  as it was before the stop
 * @param {ResumeStarted} started
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function settleStarted(l, { at, sessionId, cwd, act }, io) {
	const { on, move } = adoptTargetOf(l, act);
	const found = io.adoptResumed(on, { sessionId, cwd }, at, move);
	const killed = "a kill came between it and the state write";
	const what = `${launchName(l)}'s resume at ${iso(at)}`;
	/** @type {{failed: string}|(Resumed & {fromSessionId: string})} */
	let r;
	if (found && !("unread" in found)) {
		io.log(
			`${what} started a job ${buildResumedHow(found)}, which ${killed} left out of the state: tracking it, not resuming again`,
		);
		r = { ...found, fromSessionId: sessionId };
	} else if (io.jobStateOf(l)?.state === "stopped")
		r = {
			failed: found
				? `${killed}, and whether it started a job is unread: ${found.unread}`
				: `${killed}, and it started no job`,
		};
	else {
		io.log(`${what}: ${killed} before its stop, so it is left to its act`);
		return l;
	}
	if (act.kind === "api") return settleFallBack(l, r, { now: at, io }, act);
	return settleStartedLimit(l, act, r, { what, at, io });
}

/**
 * The tick's acts on resumed-idle launches (#2659), read off the job store
 * and transcripts whether or not the listing read: each owed hand-off
 * retried, each typed resume checked, then the RESUMED_IDLE row's act, its
 * block made up for the act and so not kept.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnIdle(launches, mode, seen) {
	const owed = launches.map((l) =>
		isActionable(l) &&
		(l.handOffTries !== undefined || isDeadAfterBootResume(l, seen)) &&
		!seen.barred
			? handOff(l, seen, true)
			: l,
	);
	const read = idleActs(owed, mode, seen);
	const acted = actedOn(read.acts, seen, {
		mode,
		resume: typeIdleResume,
		hold: holdIdle,
	});
	const unblocked = new Map(
		[...acted].map(([jobId, { block: _, ...l }]) => [jobId, l]),
	);
	return withActed(read.launches, unblocked);
}

/**
 * The why of launch `key`'s UNKNOWN reading where it is news to log, else
 * null: once for each why, forgotten once a cause reads (#3200). Updates
 * `logged`, the loop's record, one entry per launch the loop process has seen
 * unread.
 * @param {Map<string, string>} logged
 * @param {string} key
 * @param {import("./block-cause.js").Reading} reading
 * @returns {string|null}
 */
function unknownNews(logged, key, reading) {
	if (reading.cause !== "UNKNOWN") {
		logged.delete(key);
		return null;
	}
	if (logged.get(key) === reading.why) return null;
	logged.set(key, reading.why);
	return reading.why;
}

/**
 * The job record's fields the classifier reads, for an UNKNOWN's log line.
 * @param {unknown} job
 */
function jobShape(job) {
	if (typeof job !== "object" || job === null) return job;
	const rec = /** @type {Record<string, unknown>} */ (job);
	return Object.fromEntries(
		[
			"state",
			"tempo",
			"detail",
			"needs",
			"needsOverlay",
			"block",
			"inFlight",
			"cliVersion",
		].map((k) => [k, rec[k]]),
	);
}

/**
 * The loop's CauseOf: a parked launch's block cause (lib/block-cause.js) from
 * its listing row, its job record and its transcript's user and assistant
 * rows; an unread transcript reads UNKNOWN and acts on nothing (#2358 F9),
 * and an UNKNOWN is logged with why, once per launch for each why (#3200).
 * @param {{readJob: (l: LoopLaunch) => unknown,
 *   readTail: (l: LoopLaunch, job: unknown) => Record<string, unknown>[]|null,
 *   log: (line: string) => void}} io  the job record, null unread; its
 *   transcript's rows, null unread
 * @returns {CauseOf}
 */
function causeReader(io) {
	/** @type {Map<string, string>} */
	const logged = new Map();
	return (l, row) => {
		const job = io.readJob(l);
		const tail =
			io
				.readTail(l, job)
				?.filter((r) => r.type === "user" || r.type === "assistant") ?? null;
		const reading = blockCause({
			row,
			job: /** @type {Parameters<typeof blockCause>[0]["job"]} */ (job),
			tail,
		});
		const why = unknownNews(logged, l.jobId ?? launchName(l), reading);
		if (why !== null)
			io.log(
				`block unread ${launchName(l)}: ${why}; row ${JSON.stringify(row)}; job ${JSON.stringify(jobShape(job))}`,
			);
		return reading;
	};
}

module.exports = {
	ATTACH_VERDICT_MS,
	isTakenSinceStop,
	typedVerdict,
	causeReader,
	actOnBlocks,
	logNetWaits,
	netGateOf,
	actOnIdle,
	unparkAnswered,
	buildChildLine,
	indented,
	hasJobEnded,
	isBootKillCandidate,
	isBootKillable,
	buildStepStatus,
	stepKindOf,
	UNSETTLED_STEP_KINDS,
	isStepResumeFor,
	LISTING_GRACE_MS,
	markParked,
	nextResumeAt,
	releaseAwayParks,
	queueBootKilled,
	queueLifted,
	resumableOf,
	resumeHeldLaunches,
	settleStartedResumes,
	unknownNews,
};
