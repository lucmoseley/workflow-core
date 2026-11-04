/*
 * refill-blocks.js — the refill loop's blocked and resumed-idle launches
 * (#2848, spec #2695): their block and resume records, the act
 * lib/block-act.js's table returns for each, and each act done through the
 * I/O the program passes in (BlockIo).
 */

const path = require("node:path");
const { isTerminalAgent } = require("./agent-liveness.js");
const { hasEndedUnblocked } = require("./block-cause.js");
const { newestMarkerListing } = require("./parked.js");
const { swapHoldText } = require("./admission.js");
const {
	IDLE_TRIES,
	RESUME_CAP,
	blockAct,
	buildLimitParkWhy,
	holdBoundAt,
	nextTryAt,
	resumeDueAt,
} = require("./block-act.js");
const {
	API_PROMPT,
	HOLD_PROMPT,
	IDLE_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
	BOOT_PROMPT,
	BOOT_UNREAD_PROMPT,
} = require("./loop-prompts.js");
const {
	buildLimitCapText,
	buildResumeWaitLine,
	isAtLimitCap,
	pickMoveSeat,
} = require("./refill-decide.js");
const { buildSeatName, isSameSeat, seatIdOf } = require("./refill-seats.js");
const { ledgerJobOf } = require("./refill-state.js");

/* #2359's "within one tick": a typed line reaches the timeline at once
 * (#2354 F8), so a minute is ample; untraced. */
const ATTACH_VERDICT_MS = 60 * 1000;
const ATTACH_ROUTE = "typing into the live session";
const LIMIT_LOSS_TEXT =
	"Lost: its in-flight subagents, background tasks and monitors, and the warm prompt cache (one cache rewrite of its context).";
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
/* The listed state of a session parked on a question
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F1). */
const PARKED_STATE = "blocked";

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {LoopLaunch & {jobId: string}} JobLaunch
 * @typedef {JobLaunch & {block: import("./block-act.js").Block}} BlockedLaunch
 * @typedef {import("./block-act.js").Act} Act
 * @typedef {{act: Act, whyEnded?: string, limitParks?: number}} ParkWhy  `act`,
 *   stop-and-park or park-at-morning; `limitParks`, a limit-cap park's count in
 *   a row, for the marker
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{tries: number, triedAt: number, nextAt: number,
 *   attachAt?: number, heldAt?: number}} Resumes  a launch's resumes after an
 *   API error, kept across spells so the cap is the session's (#2705)
 * @typedef {{tries: number, triedAt: number}} IdleResumes  its typed
 *   resumes while resumed-idle (#2659), cleared once it takes a turn
 * @typedef {{at: number, sessionId: string, cwd: string, tries: number,
 *   resumeStartedAt?: number}} SwapHeld  a resumed-idle session the loop
 *   stopped under the swap hold (#3093): when, the session and directory its
 *   resume runs in, read before the stop, and the resumes since tried that
 *   failed. `resumeStartedAt`, on every step hold, when the step ran `--bg
 *   --resume` on it, on record before the launcher runs and gone with the
 *   hold (#4157)
 * @typedef {SwapHeld & {hold: string}} HoldCleared  a session parked on a repo
 *   hold since cleared (#3863): `at`, when it parked, and `hold`, that hold's id
 * @typedef {Omit<SwapHeld, "sessionId"> & {sessionId: string|null}} BootKilled  a
 *   session a restart killed mid-work (#3880): `at`, when it was launched, which
 *   sets its turn among the resumes; `sessionId`, null unread
 * @typedef {{bar: "weekly"|"5-hour"|null, resets: string|null}} LimitRead  the
 *   limit a seat's reading shows a session stopped on, null where neither bar
 *   read, with its reset as read; from the reading, never the limit's text
 * @typedef {{at: number, sessionId: string, cwd: string, limit: LimitRead,
 *   resumedAt?: number, ledgerHeldUntil?: number, failedTries?: number,
 *   movedFrom?: MovedFrom}}
 *   LimitHeld  a limit-blocked session the loop stopped (#3735): when, the
 *   session and directory its resume runs in, read before the stop, and its
 *   limit, read then, as a reset seat no longer shows it; `resumedAt`, a
 *   resume not yet judged; `ledgerHeldUntil`, when the ledger hold written for
 *   it ends;
 *   `failedTries`, its failed resumes this hold, which park it at the cap;
 *   `movedFrom`, the launch a move not yet judged left, for a failed one to go
 *   back to
 * @typedef {Partial<Pick<LoopLaunch, (typeof MOVED_FIELDS)[number]>> &
 *   {seat: string, jobId: string}} MovedFrom  what a move rewrites: its seat, reason and key, and the job and
 *   session a copy replaced
 * @typedef {{tries: number, triedAt: number, nextAt: number, failed?: string,
 *   takenAt?: number, dryResumes?: number}}
 *   LimitResumes  its resumes and moves, kept for the launch's life, each
 *   spacing the next; `failed`, why the last one failed; `takenAt`, when the
 *   last one took, until judged at its next limit block (judgeTakenResume);
 *   `dryResumes`, those in a row that took and bought no reply, which park it
 *   at the cap (#3792)
 * @typedef {(l: LoopLaunch, row: AgentRecord) =>
 *   import("./block-cause.js").Reading} CauseOf
 * @typedef {{sessionId: string|null, cwd: string}} ResumeTarget  a job's
 *   full session id, null unread, and the directory its resume runs in
 * @typedef {(root: string, sessionId: string) =>
 *   NonNullable<LoopLaunch["actsBefore"]>} ReadActsBefore  the acts a session
 *   made before a new launch row wakes it, which are not that launch's (#3942)
 * @typedef {{agents: AgentRecord[]|null, now: number, io: BlockIo,
 *   swapHold: import("./admission.js").SwapHold, paused?: boolean}} Tick  a
 *   tick's listing, null unread; its clock; the program's I/O; the swap hold
 *   (#2690) as read this tick; whether the loop is paused
 * @typedef {Tick & {typedSeat: string|null, slots: number,
 *   readMoveSeats: () => MoveSeats,
 *   seatListRead: boolean}} LimitTick  `seatListRead`, whether the seats read
 *   are the loop's own list, not a damaged or empty control's stand-in
 *   a tick read further for its limit-blocked launches: the plan seats sized
 *   for one session each, the overflow seats on those readings, and
 *   admission's free slots
 * @typedef {{seats: import("./refill-decide.js").SizedSeat[],
 *   overflow: import("./refill-decide.js").OverflowReading[]}} MoveSeats
 * @typedef {{seat: string, keyVar?: string, allowanceUsd?: number}} MoveTarget
 *   a move's seat: on an overflow seat, its key and the allowance the session
 *   takes there, the key's headroom at the move (#3736)
 * @typedef {{failed: string}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: boolean}} Resumed  a `--bg --resume`: why
 *   it failed, else the job it runs on as, its full session id, null unread,
 *   and whether that job is a copy (#2963) rather than the one woken in place
 * @typedef {Extract<Resumed, {failed: null}>|{unread: string}|null} Adopted
 *   the job a resume started, woken in place or a copy handed what the session
 *   held; why the job store could not tell, or null where it holds neither
 * @typedef {{kind: "in-place"}|{kind: "move", to: MoveTarget}} LimitAct  a
 *   limit resume on its own seat, or a move to `to`
 * @typedef {{kind: "api", route: string, again: boolean}|
 *   (LimitAct & {held: LimitHeld})} StartedAct  the act a resume was made for:
 *   an API-error fallBack, told by `route`, `again` its typed resume's
 *   fallback; or a limit act, `held` its hold as the stop leaves it
 * @typedef {{at: number, sessionId: string, cwd: string, act: StartedAct}}
 *   ResumeStarted  a stop and `--bg --resume` of `sessionId` from `cwd` the
 *   loop made at `at` (#4180)
 */

/**
 * The program's I/O for the acts on blocked and resumed-idle launches. Each
 * returns why it failed, or null once done, unless said otherwise.
 * @typedef {object} BlockIo
 * @property {(seat: string, jobId: string) =>
 *   import("./claude-stop.js").StopOutcome} stop  `claude stop` on a seat's
 *   job (lib/claude-stop.js's stopOn)
 * @property {(l: JobLaunch, prompt: string) => string|null} type  type
 *   `prompt` into the live session
 * @property {(l: JobLaunch) => ResumeTarget} resumeTargetOf  read before
 *   its stop, which may rewrite the job record
 * @property {(l: JobLaunch, prompt: string, target: ResumeTarget &
 *   {sessionId: string}) => Resumed} resumeStopped  `claude --bg
 *   --resume` of the stopped job
 * @property {(l: JobLaunch, target: ResumeTarget & {sessionId: string},
 *   since: number, move?: MoveTarget) => Adopted} adoptResumed  the job a
 *   resume of its session on `l`'s seat started from `since`, `move` the
 *   target of a move onto that seat
 * @property {(l: LoopLaunch) => void} writeLaunch  write the state file with
 *   `l` in place of the launch it was: a resume's stamp before its stop, and its
 *   outcome after (#4180)
 * @property {() => string|null} admitResume  the dispatcher's per-member
 *   memory, load and session-ceiling re-read: null where it admits one more
 *   session, else why not
 * @property {() => void} stagger  the dispatcher's pause between one launch
 *   and the next member's re-read
 * @property {(l: JobLaunch, target: MoveTarget, prompt: string, ids: ResumeTarget &
 *   {sessionId: string}) => Resumed} moveSession  the stopped session carried
 *   to `target` and resumed there, on an overflow seat recorded as a launch on
 *   its key with its allowance
 * @property {(seat: string, sessionId: string, cwd: string) => string|null}
 *   removeJobRecord  `claude rm` of any job record for it on `seat`, which
 *   keeps transcripts
 * @property {(l: JobLaunch) => {state?: unknown, detail?: unknown}|null}
 *   jobStateOf  its job's state.json, null unread
 * @property {(l: LoopLaunch, until?: number) => boolean} writeLedgerHold  a
 *   dispatch-ledger row on its issues, held past the window to `until` where
 *   given; whether it was written
 * @property {(l: JobLaunch) => unknown[]|null} readTimeline  its job's
 *   timeline rows, null unread
 * @property {(l: JobLaunch) => import("./block-cause.js").IdleReading}
 *   idleSince  lib/block-cause.js's resumedIdleSince on its records
 * @property {(l: JobLaunch, at: number) => boolean} hasTurnedSince
 *   lib/block-cause.js's hasTurnedSince on its transcript, false unread
 * @property {(l: JobLaunch, at: number) => boolean|null} hasRepliedSince
 *   lib/block-cause.js's hasRepliedSince on its transcript, null unread
 * @property {(l: LoopLaunch) => {n: number, why: string}[]} labelParked
 *   each of its issues the `parked` label would not go on, with why
 * @property {(l: LoopLaunch, sessionId: string, numbers: number[],
 *   limitParks?: number) => string|null} recordParked  add `numbers` to the
 *   session's `.parked-` marker in its checkout (lib/parked.js), with a
 *   limit-cap park's count in a row; null, else why not, which may carry a stack
 * @property {(root: string) => import("./parked.js").ParkMarkerRead[]|null}
 *   readParkMarkers  those in `root`'s checkout, null where they will not read
 * @property {(marker: import("./parked.js").ParkMarkerRead) =>
 *   {file: string, mtimeMs: number}|null} findParkTranscript  its session's newest
 *   transcript, null where none is found
 * @property {(file: string, who: string) => Record<string, unknown>[]|null}
 *   readMainChain  that transcript's main-chain rows, null where it will not read
 * @property {(root: string, sessionId: string, issues: number[]) => string|null} unparkSession
 *   take the `parked` label and marker off its issues, as its session has gone back
 * @property {(l: LoopLaunch, body: string) => void} comment  on each of its
 *   issues, a failure logged
 * @property {(l: JobLaunch) => {failed: string|null, out: string}}
 *   postHandOff  `rescue-sessions.js hand-off` of the stopped session
 * @property {(l: JobLaunch) => boolean} release  its dispatch-ledger hold;
 *   whether it went
 * @property {(l: LoopLaunch) => object} progressOf  a finishing launch's
 *   progress fields, logged
 * @property {ReadActsBefore} readActsBefore
 * @property {(line: string) => void} log
 */

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** @param {{root: string, prompt: string}} l */
const launchName = (l) => `${path.basename(l.root)} ${l.prompt}`;

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
 * Whether `l` is unfinished and tied to a job. A launch with no job id is never
 * judged, so it never finishes and is not live.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isLive = (l) => l.finishedAt === null && l.jobId !== null;

/**
 * Whether the loop may act on `l`'s session: live and not stopped already for
 * a park.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isActionable = (l) => isLive(l) && l.parkStopped === undefined;

/**
 * Whether `l` waits on the loop's resumes after a transient API stop.
 * @param {LoopLaunch} l
 */
const isResuming = (l) =>
	l.block?.cause === "API_ERROR" &&
	l.block.sub === "transient" &&
	l.parkStopped === undefined;

/**
 * Whether the loop stopped `l`'s resumed-idle session under the swap hold
 * (#3093).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {swapHeld: SwapHeld}}
 */
const isSwapHeld = (l) => l.swapHeld !== undefined;

/**
 * Whether `l`'s session is parked on a repo hold since lifted, due back through
 * the resume step (#3863).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {holdCleared: HoldCleared}}
 */
const isHoldCleared = (l) => l.holdCleared !== undefined;

/**
 * Whether `l`'s session, killed by a restart, is due back through the resume step
 * (#3880).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {bootKilled: BootKilled}}
 */
const isBootKilled = (l) => l.bootKilled !== undefined;

/**
 * Whether `l`'s stopped session waits on the tick's resume step.
 * @param {LoopLaunch} l
 */
const isStepResume = (l) =>
	isSwapHeld(l) || isHoldCleared(l) || isBootKilled(l);

/**
 * Whether the loop stopped `l`'s session on its seat's limit (#3735).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isLimitHeld = (l) => l.limitHeld !== undefined;

/**
 * Whether `l` was resumed from its limit hold and not yet judged.
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isResumeUnjudged = (l) =>
	isLimitHeld(l) && l.limitHeld.resumedAt !== undefined;

/**
 * Whether `l` waits on its seat's limit, its session live or held.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {block: import("./block-act.js").Block}}
 */
const isLimitBlocked = (l) => isActionable(l) && l.block?.cause === "LIMIT";

/**
 * Whether the loop stopped `l`'s session to wait for its next resume, for
 * the swap hold to clear (#3093) or for a seat with room (#3735): the launch
 * stays unfinished until a resume takes, it parks or it is handed off.
 * @param {LoopLaunch} l
 */
const isHeld = (l) =>
	(isResuming(l) && l.resumes?.heldAt !== undefined) ||
	isStepResume(l) ||
	isLimitHeld(l);

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
 * The launches with `parked` read off the listing, and each parked one's
 * `block`: its cause this tick, and since when it has been parked, kept across
 * a change of cause. A parked
 * session is neither finished nor working: it waits in its own thread for the
 * founder's answer (#1995 stories 52, 55). It is the glossary's Parked as the
 * listing sees it, before or without the `parked` label, which the Stop hook
 * adds only on a house-decision round. Off an unread listing, for an
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
		const {
			block: _,
			swapHeld: __,
			limitHeld: ___,
			holdCleared: ____,
			bootKilled: _____,
			...rest
		} = l;
		if (row.state !== PARKED_STATE) return { ...rest, parked: false };
		const reading = causeOf(l, row);
		return {
			...rest,
			parked: true,
			block: blockFrom(reading, l.block?.since ?? now),
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
const blockFrom = (reading, since) => ({
	cause: reading.cause,
	...("sub" in reading ? { sub: reading.sub } : {}),
	...("bar" in reading ? { bar: reading.bar } : {}),
	since,
});

/**
 * The job ids the listing shows blocked.
 * @param {AgentRecord[]} agents
 */
const blockedIdsOf = (agents) =>
	new Set(agents.filter((a) => a.state === PARKED_STATE).map((a) => a.id));

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
 * The loop log's line for a park it stopped, or could not; `brief`, the
 * issue comment's, each reason cut to its first line, never a stack (#3670).
 * @param {BlockedLaunch & {act?: Act, whyEnded?: string}} l  `whyEnded`, why a
 *   held session's wait ended
 * @param {"away"|"normal"} mode
 * @param {{failed: string|null, unlabelled: {n: number, why: string}[],
 *   unmarkedWhy?: string|null}} outcome  `unmarkedWhy`, why the labelled issues are
 *   not in the session's marker
 * @param {{brief?: boolean}} [opts]
 */
function buildParkStopLine(
	l,
	mode,
	{ failed, unlabelled, unmarkedWhy = null },
	{ brief = false } = {},
) {
	const reason = (/** @type {string} */ why) =>
		brief ? why.split(/\r?\n/)[0] : why;
	const tried = l.resumes ? `, ${l.resumes.tries} resumes` : "";
	const morning = l.act === "park-at-morning" ? ", at the morning cut-off" : "";
	const ended = l.whyEnded ? `, ${l.whyEnded}` : "";
	const what = `${l.block.cause} park ${launchName(l)} (${mode} mode, blocked since ${iso(l.block.since)}${tried}${morning}${ended})`;
	if (failed) return `could not stop ${what}: ${failed}`;
	const labelled = labelledOf(l, unlabelled);
	return [
		`stopped ${what}`,
		`labelled parked: ${labelled.map((n) => `#${n}`).join(", ") || "none"}`,
		...unlabelled.map((u) => `not labelled #${u.n}: ${reason(u.why)}`),
		...(unmarkedWhy
			? [`left parked until claimed, not on his typing: ${reason(unmarkedWhy)}`]
			: []),
	].join("; ");
}

/**
 * @param {{issues: number[]}} l
 * @param {{n: number}[]} unlabelled
 */
function labelledOf(l, unlabelled) {
	const missed = new Set(unlabelled.map((u) => u.n));
	return l.issues.filter((n) => !missed.has(n));
}

/**
 * Add `l`'s labelled issues to its session's `.parked-` marker, so the
 * founder's typing there takes the label off (unpark-on-prompt.js, #3584);
 * null once recorded or with none labelled, else why not.
 * @param {LoopLaunch} l
 * @param {number[]} labelled
 * @param {number|undefined} limitParks
 * @param {BlockIo} io
 */
function markLabelled(l, labelled, limitParks, io) {
	if (labelled.length === 0) return null;
	if (!l.sessionId) return "no session id read";
	return io.recordParked(l, l.sessionId, labelled, limitParks);
}

/**
 * The park's closing words on the issue: where this limit-cap park ends the
 * loop's relaunches, says so (#3804).
 * @param {number|undefined} limitParks
 */
const buildRelaunchEndText = (limitParks) =>
	isAtLimitCap(limitParks)
		? ` The loop will not relaunch it: ${buildLimitCapText(limitParks)}.`
		: "";

/**
 * `claude stop` on `l`'s job; null once stopped, else why not. A job the loop
 * already stopped to wait for its next resume (isHeld) may be gone, so a
 * stop that finds no job is that stop, not a failure.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 */
function stopJob(l, io) {
	const r = io.stop(l.seat, l.jobId);
	if (r.ok) return null;
	return isHeld(l) && r.noJob ? null : r.why;
}

/**
 * Park `l`, its session stopped: label its issues `parked`, record them in its
 * session's marker and comment its cause on them, since a stopped session's own
 * words may not say why it waits (#2846). `l`, marked `parkStopped`, and
 * `parkedAway` in away mode.
 * @param {BlockedLaunch} l
 * @param {ParkWhy} why
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function parkOnceStopped(l, why, mode, { now, io }) {
	const parking = { ...l, ...why };
	const unlabelled = io.labelParked(l);
	const outcome = {
		failed: null,
		unlabelled,
		unmarkedWhy: markLabelled(l, labelledOf(l, unlabelled), why.limitParks, io),
	};
	io.log(buildParkStopLine(parking, mode, outcome));
	io.comment(
		l,
		`Refill loop: ${buildParkStopLine(parking, mode, outcome, { brief: true })}. The conversation is kept: \`claude attach\` reopens it.${outcome.unmarkedWhy ? "" : buildRelaunchEndText(why.limitParks)}`,
	);
	return {
		...l,
		parkStopped: now,
		...(mode === "away" ? { parkedAway: true } : {}),
	};
}

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
		if (!io.release(l)) {
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
 * Stop `l`'s park and, where the stop held, park it (parkOnceStopped).
 * @param {BlockedLaunch} l
 * @param {ParkWhy} why
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function stopPark(l, why, mode, seen) {
	const failed = stopJob(l, seen.io);
	if (failed) {
		seen.io.log(
			buildParkStopLine({ ...l, ...why }, mode, { failed, unlabelled: [] }),
		);
		return l;
	}
	return parkOnceStopped(l, why, mode, seen);
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
 * `l` after a resume that restarted its job at `now`: `relaunchedAt` set,
 * from which it has the listing's grace. Where the job is a copy, `l` tracks
 * the copy's job and session id, its dispatch-ledger hold still the job
 * first launched (#2963), and `fromSessionId`, the session it resumed, kept
 * among its past ones for actsOf (#2969); a job woken in place keeps both.
 * @param {JobLaunch} l
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} resumed
 * @param {number} now
 * @returns {JobLaunch}
 */
function relaunched(l, { jobId, sessionId, copy, fromSessionId }, now) {
	if (!copy)
		return { ...l, ...(sessionId ? { sessionId } : {}), relaunchedAt: now };
	const { sessionId: _, ...rest } = l;
	const past = new Set([...(l.pastSessionIds ?? []), fromSessionId]);
	return {
		...rest,
		jobId,
		copiedFrom: l.copiedFrom ?? l.jobId,
		relaunchedAt: now,
		...(sessionId ? { sessionId } : {}),
		pastSessionIds: [...past],
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
 * unread listing ("doubt never stops a session"). One whose resume failed
 * is held, its `heldAt` set, for the next on the schedule.
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
		told = `${route}, ${r.copy ? `as its copy ${resumed.jobId}` : "woken in place"}`;
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
 * to stop and `--bg --resume`. None off an unread listing, which could not
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
		if (
			!resumes ||
			at === undefined ||
			now - at < ATTACH_VERDICT_MS ||
			!isActionable(l)
		)
			return l;
		const { attachAt: _, ...rest } = resumes;
		const settled = /** @type {JobLaunch} */ ({ ...l, resumes: rest });
		if (
			!isResuming(settled) ||
			isResumeArrived(at, API_PROMPT, io.readTimeline(settled))
		)
			return settled;
		return fallBack(settled, seen, {
			route: `${FALLBACK_ROUTE}, the typed one unseen`,
			again: true,
		});
	});
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
 * fallBack.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function makeResume(l, seen) {
	const { agents, now, io } = seen;
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
	const r = io.postHandOff(b);
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
	else if (!io.release(b))
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
	return { ...stopped, swapHeld: { at: now, sessionId, cwd, tries: 0 } };
}

/** @param {LoopLaunch & {swapHeld: SwapHeld}} l */
const buildSwapHeldText = (l) =>
	`${launchName(l)}, stopped under the swap hold at ${iso(l.swapHeld.at)}`;

/** @param {LoopLaunch & {holdCleared: HoldCleared}} l */
const buildHoldClearedText = (l) =>
	`${launchName(l)}, parked at ${iso(l.holdCleared.at)} on repo hold ${l.holdCleared.hold}`;

/**
 * What the resume step needs of `l`: `why`, what brings it back; `withStarted`,
 * `l` with its hold's resume stamped `at`.
 * @param {JobLaunch} l
 * @returns {{held: SwapHeld|BootKilled, what: string, why: string, prompt: string,
 *   isParked: boolean, rest: JobLaunch, withTries: (tries: number) => JobLaunch,
 *   withStarted: (at: number) => JobLaunch}}
 */
function stepResumeOf(l) {
	if (isBootKilled(l)) {
		const { bootKilled, ...rest } = l;
		return {
			held: bootKilled,
			what: `${launchName(l)}, launched at ${iso(l.launchedAt)}`,
			why: "killed by a restart",
			prompt: resumePromptOf(l, BOOT_PROMPT),
			isParked: false,
			rest,
			withTries: (tries) => ({ ...l, bootKilled: { ...bootKilled, tries } }),
			withStarted: (at) => ({
				...l,
				bootKilled: { ...bootKilled, resumeStartedAt: at },
			}),
		};
	}
	if (isSwapHeld(l)) {
		const { swapHeld, ...rest } = l;
		return {
			held: swapHeld,
			what: buildSwapHeldText(l),
			why: "the hold cleared",
			prompt: resumePromptOf(l, IDLE_PROMPT),
			isParked: false,
			rest,
			withTries: (tries) => ({ ...l, swapHeld: { ...swapHeld, tries } }),
			withStarted: (at) => ({
				...l,
				swapHeld: { ...swapHeld, resumeStartedAt: at },
			}),
		};
	}
	const { holdCleared, ...rest } =
		/** @type {JobLaunch & {holdCleared: HoldCleared}} */ (l);
	return {
		held: holdCleared,
		what: buildHoldClearedText({ ...l, holdCleared }),
		why: "the hold cleared",
		prompt: HOLD_PROMPT,
		isParked: true,
		rest,
		withTries: (tries) => ({ ...l, holdCleared: { ...holdCleared, tries } }),
		withStarted: (at) => ({
			...l,
			holdCleared: { ...holdCleared, resumeStartedAt: at },
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
 * `l` after its step resume `r` of session `from` at `at`, `rest` being `l` off
 * its hold: one a restart killed is watched from the resume for a turn, however
 * many holds it meets on the way (isIdleSinceBootResume).
 * @param {JobLaunch} l
 * @param {JobLaunch} rest
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} r
 * @param {number} at
 * @returns {LoopLaunch}
 */
function afterStepResume(l, rest, r, at) {
	const resumed = relaunched(rest, r, at);
	return isBootKilled(l) || l.bootResumedAt !== undefined
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
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch|null}
 */
function adoptUnrecordedCopy(l, seen) {
	const step = stepResumeOf(l);
	const { held, what, why, rest } = step;
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
		rest,
		{ ...r, fromSessionId: sessionId },
		at,
	);
	seen.io.log(
		`resumed ${what}, ${why}, by --bg --resume at ${iso(at)}, ${r.copy ? `as its copy ${launch.jobId}` : "woken in place"}, which a kill left out of the state: tracking it, not resuming again`,
	);
	unparkStepped(l, sessionId, step, seen.io);
	return launch;
}

/**
 * Resume `l`: `claude --bg --resume` of its session with its cause's prompt. One
 * whose resume fails stays held for the next tick, and after SWAP_RESUME_TRIES
 * failures is handed off instead. One parked on a repo hold no longer waits on the
 * founder either way, so its `parked` label and marker go.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {{launch: LoopLaunch, started: boolean}}
 */
function resumeStepHeld(l, seen) {
	const { now, io } = seen;
	const step = stepResumeOf(l);
	const { held, what, why, prompt, rest, withTries } = step;
	const { sessionId, cwd } = held;
	if (!sessionId) {
		io.log(`${what}, ${why}: no session id read to resume it by`);
		return { launch: handOff(rest, seen, true), started: false };
	}
	const unpark = () => unparkStepped(l, sessionId, step, io);
	const r = io.resumeStopped(l, prompt, { sessionId, cwd });
	if (r.failed === null) {
		const launch = afterStepResume(
			l,
			rest,
			{ ...r, fromSessionId: sessionId },
			now,
		);
		io.log(
			`resumed ${what}, ${why}, by --bg --resume, ${r.copy ? `as its copy ${launch.jobId}` : "woken in place"}`,
		);
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
		const l = launches.find((x) => x.jobId === jobId && isStepResume(x));
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
		holdCleared: {
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
	if (known && isHoldCleared(known)) return { isSettled: true };
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
		if (!isActionable(l) || !isHoldCleared(l)) return l;
		const markers = readMarkersIn(l.root);
		if (
			!markers ||
			markers.some((m) => m.sessionId === l.holdCleared.sessionId)
		)
			return l;
		io.log(
			`not resuming ${buildHoldClearedText(l)}: its park marker no longer lists its issues`,
		);
		const { holdCleared: _, ...rest } = l;
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

/* The blocks that wait on the founder, in a thread his answer resumes (#3584). */
const FOUNDER_BLOCKS = new Set(["QUESTION", "PERMISSION", "OTHER_DIALOG"]);

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
	!(l.parked && FOUNDER_BLOCKS.has(l.block?.cause ?? ""));

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
	if (!isBootKillCandidate(l) || isLiveIn(l, agents)) return false;
	const state = io.jobStateOf(l)?.state;
	return typeof state !== "string" || !ENDED_JOB_STATES.has(state);
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
		const { sessionId, cwd } = io.resumeTargetOf(l);
		io.log(
			`${launchName(l)}, killed by a restart: due back through the resume step`,
		);
		return {
			...rest,
			...(l.block?.cause === "UNKNOWN" ? { blockUnread: true } : {}),
			bootKilled: { at: l.launchedAt, sessionId, cwd, tries: 0 },
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
	hold: (l, seen, { hold }) => hold(l, seen),
	resume: (l, seen, { resume }) => resume(l, seen),
	"handoff-relaunch": (l, seen) => handOff(l, seen),
};

/* The acts that set a session running, which spends allowance, so a paused
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
		if (handler && !(seen.paused && RUNNING_ACTS.has(act)))
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
 * table's act on each (blockedActs). A paused tick checks none, as a failed
 * check falls back to a resume.
 * @param {LoopLaunch[]} launches markParked's, off `seen`'s listing
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnBlocks(launches, mode, seen) {
	const settled = seen.paused ? launches : settleTyped(launches, seen);
	const acts = blockedActs(settled, mode, seen);
	return withActed(
		settled,
		actedOn(acts, seen, { mode, resume: makeResume, hold: holdForResume }),
	);
}

/**
 * The limit `l` hit, its reset off its seat's reading `s`: the bar its block
 * text names, else the one the reading shows, a full bar, the weekly first,
 * as it outlasts the 5-hour one, else the fuller, a session reaching its
 * limit ahead of the cached reading.
 * @param {import("./refill-decide.js").SizedSeat} s
 * @param {import("./block-cause.js").LimitBar} [named]  the bar the block
 *   text names
 * @returns {LimitRead}
 */
function limitReadOf(s, named) {
	if (
		!named &&
		s.week === null &&
		s.session === null &&
		!s.weekFull &&
		!s.sessionFull
	)
		return { bar: null, resets: null };
	const isWeekly = named
		? named === "weekly"
		: s.weekFull || (!s.sessionFull && (s.week ?? 0) >= (s.session ?? 0));
	return isWeekly
		? {
				bar: "weekly",
				resets: s.weekResets === null ? null : iso(s.weekResets),
			}
		: { bar: "5-hour", resets: s.sessionResets };
}

/** @param {LimitRead} limit */
const buildLimitText = ({ bar, resets }) =>
	`${bar ?? "unread"} limit (reset ${resets ?? "unread"})`;

/**
 * What `l` waits on, and since when, where it waits on its limit and no resume
 * is being judged; null otherwise. One the loop could not stop stays live with
 * no hold, so no bound parks it (#3838).
 * @param {LoopLaunch} l
 * @returns {{why: string, since: number}|null}
 */
function limitWaitOf(l) {
	if (!isLive(l) || isResumeUnjudged(l)) return null;
	if (isLimitHeld(l))
		return {
			why: `stopped on its ${buildLimitText(l.limitHeld.limit)}`,
			since: l.limitHeld.at,
		};
	return isLimitBlocked(l)
		? {
				why: "blocked on its limit, its session not stopped",
				since: l.block.since,
			}
		: null;
}

/**
 * `l` with one more resume or move counted, `failed` why it failed, which a
 * held one's hold counts towards its park at the cap (#3790); one that took
 * is judged at the launch's next limit block (#3792).
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {string} [failed]
 * @returns {L & {limitResumes: LimitResumes}}
 */
function afterLimitTry(l, now, failed) {
	const tries = (l.limitResumes?.tries ?? 0) + 1;
	const held = l.limitHeld;
	const dryResumes = l.limitResumes?.dryResumes;
	return {
		...l,
		...(failed !== undefined && held
			? {
					limitHeld: {
						...held,
						failedTries: (held.failedTries ?? 0) + 1,
					},
				}
			: {}),
		limitResumes: {
			tries,
			triedAt: now,
			nextAt: nextTryAt(tries, now),
			...(dryResumes === undefined ? {} : { dryResumes }),
			...(failed === undefined ? { takenAt: now } : { failed }),
		},
	};
}

/**
 * Log a resume or move that failed, and comment it where its failure is news,
 * so one that keeps failing does not comment on every try.
 * @param {LoopLaunch} l
 * @param {string} line
 * @param {string} why
 * @param {BlockIo} io
 */
function reportLimitFailure(l, line, why, io) {
	io.log(`${line}: ${why}`);
	if (l.limitResumes?.failed === why) return;
	io.comment(
		l,
		`Refill loop: ${line}: ${why.split(/\r?\n/)[0]}. It stays held on its seat, its conversation kept, and is judged again on a later tick.`,
	);
}

/**
 * Stop `l`'s limit-blocked session until a seat has room: it keeps its
 * conversation and its launch, and holds no memory or slot. Told in the log
 * alone. One with no session id is not stopped, as nothing could resume it.
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function holdForLimit(l, limit, { now, io }) {
	const what = `${l.jobId} ${launchName(l)} on ${l.seat}, at its ${buildLimitText(limit)}`;
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) {
		io.log(`not holding ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(l, io);
	if (failed) {
		io.log(`could not hold ${what}: ${failed}`);
		return l;
	}
	io.log(`held ${what}: stopped until a seat has room`);
	return { ...l, limitHeld: { at: now, sessionId, cwd, limit } };
}

/**
 * Limit act `act` on `l`: its session stopped, unless held already, and held
 * from now on, then `resume` run on it and the launch it leaves written. Where
 * no session id read or the stop failed, `l` after that failed try, reported
 * under `failedLine` of the limit it is held at.
 * @param {JobLaunch} l
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {{act: LimitAct, failedLine: (held: LimitRead) => string,
 *   resume: (stopped: JobLaunch & {limitHeld: LimitHeld},
 *   ids: ResumeTarget & {sessionId: string}) => LoopLaunch}} how
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function runLimitAct(l, limit, { act, failedLine, resume }, { now, io }) {
	const held = l.limitHeld ?? { ...io.resumeTargetOf(l), at: now, limit };
	const { sessionId, cwd } = held;
	/** @param {string} why */
	const gaveUp = (why) => {
		reportLimitFailure(l, failedLine(held.limit), why, io);
		return afterLimitTry(l, now, why);
	};
	if (!sessionId) return gaveUp("no session id read for it");
	io.writeLaunch({
		...l,
		resumeStarted: {
			at: now,
			sessionId,
			cwd,
			act: { ...act, held: { ...held, sessionId } },
		},
	});
	const stopFailed = isLimitHeld(l) ? null : stopJob(l, io);
	if (stopFailed) return gaveUp(`stop: ${stopFailed}`);
	const out = resume(
		{ ...l, limitHeld: { ...held, sessionId } },
		{ sessionId, cwd },
	);
	io.writeLaunch(out);
	return out;
}

/**
 * Resume `l`'s limit-blocked session on its own seat (#3735): stopped, unless
 * held already, then `--bg --resume` under its own session id. A resume stays
 * held until settleLimitResume, as a failed one can show only seconds later
 * (#2159). One the launcher ran as a copy tracks the copy, as
 * lib/refill-tick.js's resumeStopped moves the claims to it (#2963).
 * @param {JobLaunch} l
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function resumeInPlace(l, limit, seen) {
	const { now, io } = seen;
	return runLimitAct(
		l,
		limit,
		{
			act: { kind: "in-place" },
			failedLine: (at) => `could not resume ${buildInPlaceWhat(l, at)}`,
			resume: (stopped, ids) =>
				settleInPlace(
					stopped,
					{
						...io.resumeStopped(stopped, LIMIT_PROMPT, ids),
						fromSessionId: ids.sessionId,
					},
					now,
					io,
				),
		},
		seen,
	);
}

/**
 * What resumeInPlace's lines call its resume of `l` after `limit`.
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 */
const buildInPlaceWhat = (l, limit) =>
	`${l.jobId} ${launchName(l)} on ${l.seat}, after its ${buildLimitText(limit)}`;

/**
 * `l`, stopped, after resumeInPlace's resume `r` at `now`, reported.
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {number} now
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function settleInPlace(l, r, now, io) {
	const limitText = buildLimitText(l.limitHeld.limit);
	const what = buildInPlaceWhat(l, l.limitHeld.limit);
	if (r.failed !== null) {
		reportLimitFailure(l, `could not resume ${what}`, r.failed, io);
		return afterLimitTry(l, now, r.failed);
	}
	const resumed = relaunched(
		{
			...l,
			parked: false,
			limitHeld: { ...l.limitHeld, resumedAt: now },
		},
		r,
		now,
	);
	const how = r.copy ? `as its copy ${resumed.jobId}` : "woken in place";
	io.log(`resumed ${what}: same seat, ${how}`);
	io.comment(
		l,
		`Refill loop: resumed this session after its ${limitText}: same seat, ${l.seat}, ${how}. ${LIMIT_LOSS_TEXT}`,
	);
	return afterLimitTry(resumed, now);
}

const MOVED_FIELDS = /** @type {const} */ ([
	"seat",
	"reason",
	"keyVar",
	"jobId",
	"sessionId",
	"copiedFrom",
	"pastSessionIds",
	"movedAt",
]);

/**
 * @param {JobLaunch} l
 * @returns {MovedFrom}
 */
const movedFromOf = (l) => ({
	...Object.fromEntries(
		MOVED_FIELDS.flatMap((k) => (l[k] === undefined ? [] : [[k, l[k]]])),
	),
	seat: l.seat,
	jobId: l.jobId,
});

/**
 * @template {JobLaunch} L
 * @param {L} l
 * @param {MovedFrom} from
 * @returns {L}
 */
function unmoved(l, from) {
	const back = { ...l };
	for (const k of MOVED_FIELDS) delete back[k];
	return { ...back, ...from };
}

/**
 * @template {JobLaunch} L
 * @param {L} l
 * @param {MoveTarget} target
 * @returns {L}
 */
const movedOnto = (l, { seat, keyVar }) => ({
	...l,
	...seatIdOf({ seat, keyVar }),
});

/** @param {MoveTarget} target */
const buildTargetText = (target) =>
	target.keyVar
		? `${target.seat} on overflow key ${target.keyVar}`
		: target.seat;

/**
 * Move `l`'s limit-blocked session to `target` under its own session id:
 * stopped on its seat, unless held already, then carried and resumed
 * there, from its own cwd. The launch stays the same launch, its seat, key
 * and reason rewritten, so stop, reap, status and the allowance stop address
 * `target` from here, and its block dated now, so no reading older than the
 * move sends it back. A failure leaves it held on its seat; a resume that the
 * launcher ran as a copy tracks the copy, as an overflow seat's always does
 * (#3692 (d)).
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function moveToSeat(l, target, limit, seen) {
	const { now, io } = seen;
	return runLimitAct(
		l,
		limit,
		{
			act: { kind: "move", to: target },
			failedLine: (at) => `could not move ${buildMoveWhat(l, target, at)}`,
			resume: (stopped, ids) =>
				settleMove(
					{ ...stopped, block: l.block },
					target,
					{
						...io.moveSession(stopped, target, MOVED_PROMPT, ids),
						fromSessionId: ids.sessionId,
					},
					{ now, io },
				),
		},
		seen,
	);
}

/**
 * What moveToSeat's lines call its move of `l` to `target` at `limit`.
 * @param {JobLaunch} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit
 */
const buildMoveWhat = (l, target, limit) =>
	`${l.jobId} ${launchName(l)} from ${l.seat} to ${buildTargetText(target)}, at its ${buildLimitText(limit)}`;

/**
 * `l`, stopped, after moveToSeat's resume `r` on `target` at `now`, reported.
 * @param {JobLaunch & {block: import("./block-act.js").Block,
 *   limitHeld: LimitHeld}} l
 * @param {MoveTarget} target
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{now: number, io: BlockIo}} seen
 * @returns {LoopLaunch}
 */
function settleMove(l, target, r, { now, io }) {
	const limitText = buildLimitText(l.limitHeld.limit);
	const what = buildMoveWhat(l, target, l.limitHeld.limit);
	if (r.failed !== null) {
		reportLimitFailure(l, `could not move ${what}`, r.failed, io);
		return afterLimitTry(l, now, r.failed);
	}
	const moved = relaunched(
		{
			...movedOnto(l, target),
			reason: `moved from ${buildSeatName(l.seat)}`,
			movedAt: now,
			parked: false,
			block: { ...l.block, since: now },
			limitLeft: [
				...(l.limitLeft ?? []).filter((x) => x.seat !== l.seat),
				{ seat: l.seat, since: l.block.since },
			],
			limitHeld: {
				...l.limitHeld,
				resumedAt: now,
				movedFrom: movedFromOf(l),
			},
		},
		r,
		now,
	);
	const how = r.copy
		? `as its copy ${moved.jobId}`
		: "under its own session id";
	const charged =
		target.allowanceUsd === undefined
			? ""
			: `, its allowance there $${target.allowanceUsd.toFixed(2)}`;
	io.log(`moved ${what}: ${how}${charged}`);
	io.comment(
		l,
		`Refill loop: moved this session after its ${limitText}: from ${l.seat} to ${buildTargetText(target)}, ${how}${charged}. ${LIMIT_LOSS_TEXT}`,
	);
	/* Spacing is for tries that fail: one that took may move again at once. */
	const tried = afterLimitTry(moved, now);
	return { ...tried, limitResumes: { ...tried.limitResumes, nextAt: now } };
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
	const move = act.kind === "move" ? act.to : undefined;
	const on = move ? movedOnto(l, move) : l;
	const found = io.adoptResumed(on, { sessionId, cwd }, at, move);
	const killed = "a kill came between it and the state write";
	const what = `${launchName(l)}'s resume at ${iso(at)}`;
	/** @type {{failed: string}|(Resumed & {fromSessionId: string})} */
	let r;
	if (found && !("unread" in found)) {
		io.log(
			`${what} started ${found.copy ? `copy ${found.jobId}` : "its job in place"}, which ${killed} left out of the state: tracking it, not resuming again`,
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
	if (!l.block) {
		io.log(`${what} is dropped: its launch is no longer blocked`);
		return l;
	}
	const held = { ...l, block: l.block, limitHeld: act.held };
	return syncLedgerHold(
		act.kind === "in-place"
			? settleInPlace(held, r, at, io)
			: settleMove(held, act.to, r, { now: at, io }),
		io,
	);
}

/**
 * Judge a resume or move a tick on, its session not listed live or markParked
 * would have let it go. A job record reading failed or unread goes back to
 * held, a move back on the seat it left, named; any other is let go, for the
 * listing to judge finished. A move that took has its job record gone from
 * the seat it left.
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function settleLimitResume(l, { now, io }) {
	const job = io.jobStateOf(l);
	if (job && job.state !== "failed") {
		const { limitHeld: _, block: __, ...rest } = l;
		const { movedFrom, sessionId } = l.limitHeld;
		/* The job it left, unless it woke in that job, in the dir it shares. */
		const left =
			movedFrom && (movedFrom.seat !== l.seat || movedFrom.jobId !== l.jobId);
		const failed = left
			? io.removeJobRecord(movedFrom.seat, sessionId, l.limitHeld.cwd)
			: null;
		if (failed) io.log(`${launchName(l)}: ${failed}`);
		return rest;
	}
	const { resumedAt: _, movedFrom, ...limitHeld } = l.limitHeld;
	const why = job
		? `state failed after its resume: ${job.detail}`
		: "its job record is unread after its resume";
	const name = `${l.jobId} ${launchName(l)}`;
	if (!movedFrom) {
		reportLimitFailure(l, `could not resume ${name} on ${l.seat}`, why, io);
		return afterLimitTry({ ...l, limitHeld }, now, why);
	}
	reportLimitFailure(
		l,
		`could not move ${name} from ${movedFrom.seat} to ${l.seat}`,
		why,
		io,
	);
	const stopFailed = stopJob(l, io);
	if (stopFailed) io.log(`could not stop ${name}'s failed move: ${stopFailed}`);
	return afterLimitTry(unmoved({ ...l, limitHeld }, movedFrom), now, why);
}

/**
 * `l`, limit-blocked again, with its last resume that took judged, once: no
 * reply since adds to its dry resumes, a reply clears them (#3792). An unread
 * transcript judges nothing, and the next resume replaces what it would have
 * judged.
 * Residual: a launch whose transcript never reads is never counted, though one
 * that reads LIMIT has read its transcript that tick.
 * @template {JobLaunch} L
 * @param {L} l
 * @param {BlockIo} io
 * @returns {L}
 */
function judgeTakenResume(l, io) {
	if (l.limitResumes?.takenAt === undefined) return l;
	const { takenAt, dryResumes = 0, ...rest } = l.limitResumes;
	const replied = io.hasRepliedSince(l, takenAt);
	if (replied === null) return l;
	return {
		...l,
		limitResumes: replied ? rest : { ...rest, dryResumes: dryResumes + 1 },
	};
}

/**
 * `l`, held, with a dispatch-ledger hold written to the hold's bound: its
 * stopped session leaves the listing and its claim unread, so nothing else
 * keeps a direct dispatch off its issues, and the hold must outlast the run,
 * which may end with no tick left to write another (#3785).
 * Residual: a session the founder resumes by hand while the loop is stopped
 * keeps its ticket refused, once it ends, until the next `start` or the bound;
 * `--force` is the way out.
 * @param {LoopLaunch & {limitHeld: LimitHeld}} l
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function writeLedgerHold(l, io) {
	if (l.limitHeld.ledgerHeldUntil !== undefined) return l;
	const until = holdBoundAt(l.limitHeld.at);
	if (io.writeLedgerHold(l, until))
		return { ...l, limitHeld: { ...l.limitHeld, ledgerHeldUntil: until } };
	io.log(`could not write ${launchName(l)}'s dispatch-ledger hold`);
	return l;
}

/**
 * `l` with the ledger state its hold owes: a session stopped holds past the
 * window; one resumed and unjudged is live and may end while the loop is
 * stopped, so it gives the hold up (releaseEndedHolds).
 * @param {LoopLaunch} l
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function syncLedgerHold(l, io) {
	if (!isLimitHeld(l)) return l;
	if (!isResumeUnjudged(l)) return writeLedgerHold(l, io);
	const { ledgerHeldUntil: _, ...limitHeld } = l.limitHeld;
	return { ...l, limitHeld };
}

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {limitHeld: LimitHeld & {ledgerHeldUntil: number}}}
 */
const isLedgerHolding = (l) =>
	l.jobId !== null &&
	l.finishedAt === null &&
	l.limitHeld?.ledgerHeldUntil !== undefined;

/**
 * Release the ledger hold of each launch in `before` whose hold ended by
 * `after`. One whose session runs on takes an ordinary row in its place, so its
 * ticket has the window any launch has. A release that fails, the ledger
 * unwritable, is logged and not retried (#3785): its issues wait to the hold's
 * bound or a `--force`.
 * @param {LoopLaunch[]} before
 * @param {LoopLaunch[]} after
 * @param {Pick<BlockIo, "release"|"writeLedgerHold"|"log">} io
 */
function releaseEndedHolds(before, after, io) {
	const kept = new Set(after.filter(isLedgerHolding).map(ledgerJobOf));
	const running = new Map(
		after
			.filter((l) => l.finishedAt === null && l.parkStopped === undefined)
			.map((l) => [ledgerJobOf(l), l]),
	);
	for (const l of before.filter(isLedgerHolding)) {
		const job = ledgerJobOf(l);
		if (kept.has(job)) continue;
		if (!io.release(l))
			io.log(
				`could not release ${launchName(l)}'s dispatch-ledger hold: its issues wait until ${iso(l.limitHeld.ledgerHeldUntil)}`,
			);
		const live = running.get(job);
		if (live && !io.writeLedgerHold(live))
			io.log(`could not write ${launchName(l)}'s dispatch-ledger row`);
	}
}

/**
 * A held launch for a stop line (#3785): the session, its seat and what its
 * ticket is open to from now, as nothing judges it until the next `start`.
 * @param {LoopLaunch & {limitHeld: LimitHeld}} l
 */
function buildHeldStopText(l) {
	const { ledgerHeldUntil: until, limit, resumedAt } = l.limitHeld;
	const what = `${l.jobId} ${launchName(l)} on ${buildSeatName(l.seat)}`;
	if (resumedAt !== undefined)
		return `${what}, resumed at ${iso(resumedAt)} after its ${buildLimitText(limit)}, not yet judged`;
	return `${what}, stopped at its ${buildLimitText(limit)}, ${
		until === undefined
			? "its dispatch-ledger hold unwritten, so a direct dispatch may take its ticket"
			: `its ticket held from dispatch until ${iso(until)}`
	}`;
}

/**
 * Park `l`, held where nothing will resume it, so the launch finishes and a
 * normal-mode loop routes its ticket back (#3790). A failed resume can leave
 * its session starting, so it is stopped too, though a stop that fails, as
 * one off a dropped seat may for good, does not keep it held. Off the hold, as
 * isLimitHeld has no parkStopped guard; its session id kept for the marker.
 * @param {JobLaunch & {block: import("./block-act.js").Block,
 *   limitHeld: LimitHeld}} l
 * @param {{whyEnded: string|undefined, limitParks?: number}} why
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkHeld(l, why, mode, seen) {
	const stopFailed = stopJob(l, seen.io);
	if (stopFailed)
		seen.io.log(`could not stop ${launchName(l)} for its park: ${stopFailed}`);
	const { limitHeld: _, ...parked } = parkOnceStopped(
		{ ...l, sessionId: l.sessionId ?? l.limitHeld.sessionId },
		{ act: "stop-and-park", ...why },
		mode,
		seen,
	);
	return parked;
}

/**
 * Why `l` parks at a limit cap: `whyEnded`, and its parks at one in a row, a
 * reply since its launch starting them again (#3804). An unread transcript
 * counts as none, so a reading that fails cannot lift the bound.
 * @param {JobLaunch} l
 * @param {string|undefined} whyEnded
 * @param {BlockIo} io
 */
const buildLimitCapWhy = (l, whyEnded, io) => ({
	whyEnded,
	limitParks: io.hasRepliedSince(l, l.launchedAt) ? 1 : (l.limitParks ?? 0) + 1,
});

/**
 * `l`'s block as the table reads it, short of what its seat's reading adds.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const limitBlockOf = (l) => ({
	...l.block,
	held: isLimitHeld(l),
	heldAt: l.limitHeld?.at,
	tries: l.limitHeld?.failedTries,
	nextAt: l.limitResumes?.nextAt,
	dryResumes: l.limitResumes?.dryResumes,
});

/**
 * `l`, whose seat the seats read do not hold: parked where it is held and the
 * seats are the loop's own list, or, whatever the list, held at a cap.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkOffList(l, mode, seen) {
	if (!isLimitHeld(l)) return l;
	if (seen.seatListRead)
		/* No count: this is no limit-cap park, and its marker's count goes. */
		return parkHeld(
			l,
			{ whyEnded: `its seat ${l.seat} off the loop's seats` },
			mode,
			seen,
		);
	const whyEnded = buildLimitParkWhy(limitBlockOf(l), seen.now);
	return whyEnded
		? parkHeld(l, buildLimitCapWhy(l, whyEnded, seen.io), mode, seen)
		: l;
}

/**
 * Where pickMoveSeat sends `l`, null nowhere.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {LimitTick} seen
 * @param {MoveSeats} moveSeats
 * @returns {MoveTarget|null}
 */
function pickMoveTarget(l, seen, { seats, overflow }) {
	const pick = pickMoveSeat({
		seats,
		overflow,
		typedSeat: seen.typedSeat,
		ownSeat: l.seat,
		since: l.block.since,
		left: l.limitLeft,
	});
	if (pick.seat === null) return null;
	if (!pick.keyVar) return { seat: pick.seat };
	return {
		seat: pick.seat,
		keyVar: pick.keyVar,
		allowanceUsd: overflow.find((o) => o.keyVar === pick.keyVar)?.headroomUsd,
	};
}

/**
 * The move pick and the table's act on one limit-blocked launch on a plan seat.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {import("./refill-decide.js").SizedSeat} own  its seat's reading
 * @param {LimitTick} seen
 * @param {{mode: "away"|"normal", slots: number, moveSeats: MoveSeats}} how
 * @returns {LoopLaunch}
 */
function actOnLimit(l, own, seen, { mode, slots, moveSeats }) {
	const target = pickMoveTarget(l, seen, moveSeats);
	const block = {
		...limitBlockOf(l),
		seat: l.seat,
		movePick: target,
		slotFree: slots > 0,
	};
	const act = blockAct(block, mode, seen.now);
	if (act === "stop-and-park") {
		const why = buildLimitCapWhy(
			l,
			buildLimitParkWhy(block, seen.now),
			seen.io,
		);
		return isLimitHeld(l)
			? parkHeld(l, why, mode, seen)
			: stopPark(l, { act, ...why }, mode, seen);
	}
	const limit = limitReadOf(own, l.block.bar);
	if (act === "hold") return holdForLimit(l, limit, seen);
	if (act === "resume-in-place") return resumeInPlace(l, limit, seen);
	if (act === "move" && target) return moveToSeat(l, target, limit, seen);
	if (target?.seat === l.seat && !target.keyVar && slots <= 0)
		seen.io.log(
			`${launchName(l)} on ${l.seat} reads open, and waits on a free slot`,
		);
	return l;
}

/**
 * `seats` with the seat `l` was moved or resumed onto sized 0, as its next
 * sizing needs a fresh read.
 * @param {MoveSeats} seats
 * @param {LoopLaunch} l
 * @returns {MoveSeats}
 */
const withSeatTaken = ({ seats, overflow }, l) => ({
	seats: seats.map((s) => (isSameSeat(l, s) ? { ...s, fits: 0 } : s)),
	overflow: overflow.map((o) => (isSameSeat(l, o) ? { ...o, fits: 0 } : o)),
});

/**
 * The sessions an act on `l` added to the listing (#3778): one resumed from
 * held adds one, and one live left held or parked, no resume made, is gone. A
 * live one stopped and resumed in place adds none.
 * @param {LoopLaunch} l
 * @param {LoopLaunch} out
 * @returns {-1|0|1}
 */
function limitWorkingChange(l, out) {
	if (!isLimitHeld(out))
		return out.parkStopped !== undefined && !isLimitHeld(l) ? -1 : 0;
	const resumed = out.limitHeld.resumedAt !== undefined;
	if (isLimitHeld(l)) return resumed ? 1 : 0;
	return resumed ? 0 : -1;
}

/**
 * The tick's acts on limit-blocked launches, on the seats they read (#3735):
 * each resume made a tick ago judged, then for each on a plan seat its act; one
 * held whose seat has left the loop's list is parked (#3790), so a restart on
 * fewer seats parks each hold on those dropped. Each one resumed or moved from
 * held takes a slot, so a seat's reset lets them back only as admission has
 * room. A seat is sized for one session, so it takes one move or one resume
 * from held a tick, and the next waits a tick for a fresh sizing. The launches, the slots left, and the
 * net sessions added to those admission read. Nothing off an unread listing, and with none
 * limit-blocked no seat is read.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {{launches: LoopLaunch[], slots: number, workingChange: number}}
 */
function actOnLimits(launches, mode, seen) {
	let { slots } = seen;
	let workingChange = 0;
	if (!seen.agents || !launches.some(isLimitBlocked))
		return { launches, slots, workingChange };
	let moveSeats = seen.readMoveSeats();
	const blocked = blockedIdsOf(seen.agents);
	const acted = launches.map((l) => {
		if (!isLimitBlocked(l)) return l;
		if (isResumeUnjudged(l))
			return syncLedgerHold(settleLimitResume(l, seen), seen.io);
		/* A plan reading on the same dir is not this launch's: a key has no bars. */
		const own = moveSeats.seats.find((s) => isSameSeat(l, s));
		if (!own) return parkOffList(l, mode, seen);
		if (!(blocked.has(l.jobId) || isLimitHeld(l))) return l;
		const out = actOnLimit(judgeTakenResume(l, seen.io), own, seen, {
			mode,
			slots,
			moveSeats,
		});
		const change = limitWorkingChange(l, out);
		/* A resume from held fills a seat as a move onto it does; a live one's
		 * stop and resume in place keeps the slot it holds. */
		if (out.seat !== l.seat || out.keyVar !== l.keyVar || change > 0)
			moveSeats = withSeatTaken(moveSeats, out);
		if (change > 0) slots -= 1;
		workingChange += change;
		return syncLedgerHold(out, seen.io);
	});
	return { launches: acted, slots, workingChange };
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
		!seen.paused
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

module.exports = {
	actOnBlocks,
	actOnIdle,
	actOnLimits,
	unparkAnswered,
	buildChildLine,
	buildHeldStopText,
	buildLimitText,
	indented,
	isHeld,
	isLimitHeld,
	isLive,
	isResuming,
	isHoldCleared,
	isBootKillCandidate,
	isBootKillable,
	isBootKilled,
	isStepResume,
	isSwapHeld,
	LISTING_GRACE_MS,
	iso,
	launchName,
	movedOnto,
	limitWaitOf,
	markParked,
	nextResumeAt,
	releaseAwayParks,
	releaseEndedHolds,
	queueBootKilled,
	queueLifted,
	resumableOf,
	resumeHeldLaunches,
	settleStartedResumes,
	unknownNews,
};
