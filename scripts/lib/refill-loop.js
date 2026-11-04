/*
 * refill-loop.js — the refill loop's logic around lib/refill-decide.js, with
 * no I/O of its own (#2012, spec #1995, #3392): parsing its files' contents,
 * judging its launches and settling its tick, each step taking its effects and
 * clock as arguments. The files themselves are lib/refill-files.js's, the
 * state file lib/refill-state.js's; a seat's reading and sizing,
 * lib/seat-reading.js's; launching a tick's picks, lib/refill-batch.js's; what
 * `start` and `status` print, lib/refill-commands.js's.
 */

const path = require("node:path");
const { parseAct } = require("./act-line.js");
const { isTerminalAgent } = require("./agent-liveness.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const { REVIEW_HOUR, localDate } = require("./morning-review.js");
const { batchesOf } = require("./refill-batch.js");
const {
	awayChangeOf,
	UNREAD,
	actsRead,
	buildResumeWaitLine,
	decideTick,
	isParkRoutingMode,
	EXPLICIT_STOP_DETAIL,
	startedAt,
} = require("./refill-decide.js");
const {
	buildChildLine,
	isHeld,
	isLive,
	launchName,
	isStepResume,
	LISTING_GRACE_MS,
	limitWaitOf,
	markParked,
} = require("./refill-blocks.js");
const { buildErrorText } = require("./caught.js");
const { buildGoalProgress, isRecord, parseGoal } = require("./refill-goal.js");
const { buildSeatName } = require("./refill-seats.js");
const {
	batchLaunching,
	lateStopped,
	parseStrings,
	tickSettled,
	withoutLaunching,
} = require("./refill-state.js");
const { unclosedLaunches } = require("./unclosed-launch.js");
const {
	buildOverflowStartLines,
	firstOverflowStart,
	planSeatBasisOf,
} = require("./overflow-notice.js");
const { seatTriedAfter } = require("./seat-reading.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

/* Enough for the no-progress run and for `status`. Untraced. */
const HISTORY_KEPT = 50;
/* A bound on the state file, since a ticket outranked for weeks must keep its
 * record: roomy against the 7 the live file held on 2 Nov 2026. A guess. */
const UNCLOSED_KEPT = 50;
/* The skipped rows an idle tick's log line names. Untraced. */
const LINE_SKIPS = 3;

/**
 * @typedef {object} Control
 * @property {number} noProgressFrom ms, where the no-progress count counts from
 * @property {boolean} stopRequested
 * @property {number} [stopRequestedAt] ms, when `stop` asked; a start drops it
 * @property {import("./refill-decide.js").Pause} [paused] absent where not paused
 * @property {import("./refill-decide.js").AwaySwitch} [away] absent in normal
 *   mode, or where the file holds no readable switch: a tick's absent read then
 *   dates it, and until then status names no switch time
 * @property {true} [quietBenchOff] the quiet bench route is off (#3852)
 * @property {string[]} seats config dirs, in failover order
 * @property {Scope} scope
 */

/**
 * @typedef {object} ControlRead
 * @property {Control|null} control
 * @property {string|null} damaged the file and why, where it exists but is not
 *   a control
 */

/**
 * What the loop serves and what it does with a question (#2123, #2522): it
 * serves the ticked `repos` in either mode; away hands a session that reaches a
 * question off to its issue, and normal keeps it open.
 * @typedef {object} Scope
 * @property {"normal"|"away"} mode
 * @property {string[]} repos the ticked checkout roots
 * @property {import("./refill-goal.js").Goal|null} goal loop-wide
 */

/**
 * A loop launch, as lib/refill-decide.js reads it, plus what the loop needs
 * to judge it. `parked` is the last read listing's word on whether its
 * session waits on a question, and `block` why (lib/block-cause.js, #2699).
 * `parkStopped` is when the loop stopped it for that park; `parkedAway`, that
 * away mode did and its ledger row awaits normal mode's release. `resumes` counts
 * the loop's resumes of it after an API error, kept across spells so the cap
 * is the session's (#2705), with when the last was made; `attachAt`, a typed
 * resume not yet seen arrive; `heldAt`, when the loop stopped the session to
 * wait for the next. `idleResumes` counts its typed resumes of a
 * resumed-idle session (#2659), cleared once the session takes a turn;
 * `idleSince`, the time of the harness restart row it last read resumed-idle
 * on (#2978). `swapHeld`, set while the loop holds one it stopped under the
 * swap hold (#3093). `holdCleared`, while its session, parked on a repo hold since
 * cleared, waits on the resume step (#3863). `bootKilled`, while its session, killed
 * by a restart, waits on the same step, and `bootResumedAt`, from that resume until
 * it takes a turn (#3880), and `blockUnread`, from a restart killing it on an UNKNOWN
 * block until then, so every resume asks what it waits on (#3980). `limitHeld`, while it holds one stopped on its seat's
 * limit, and `limitResumes`, its resumes and moves (#3735, #3734), `limitLeft`,
 * the seats a limit moved it off. `limitParks`, the
 * limit-cap parks in a row its ticket came back from (#3804). `handOffTries` counts the hand-offs of
 * one stopped still idle that failed, and
 * `handedOff` is when one went to a fresh launch. `relaunchedAt` is when a
 * stop and `--bg --resume` last restarted its job, from which it has the
 * listing's grace. Where a resume moved it to a copy (#2963), `copiedFrom`
 * is the job its dispatch-ledger hold names; `pastSessionIds`, the sessions
 * it ran under before `sessionId`. `actsBefore`, on a parked session resumed as
 * a new launch, the acts that session had already made (#3942).
 * `nothingToRepeat`, on one parked on an API error or a limit (#3949). `keyVar`,
 * the overflow seat it runs on (#4147); `movedAt`, when a limit last moved it
 * to another seat (#4257).
 * @typedef {import("./refill-decide.js").LaunchRecord & {
 *   prompt: string, seat: string, keyVar?: string, jobId: string|null,
 *   parked?: boolean, block?: import("./block-act.js").Block,
 *   parkedAway?: boolean, sessionId?: string,
 *   resumes?: import("./refill-blocks.js").Resumes,
 *   idleResumes?: import("./refill-blocks.js").IdleResumes, idleSince?: number,
 *   swapHeld?: import("./refill-blocks.js").SwapHeld,
 *   holdCleared?: import("./refill-blocks.js").HoldCleared,
 *   bootKilled?: import("./refill-blocks.js").BootKilled, bootResumedAt?: number,
 *   blockUnread?: true,
 *   limitHeld?: import("./refill-blocks.js").LimitHeld,
 *   limitResumes?: import("./refill-blocks.js").LimitResumes,
 *   limitLeft?: import("./refill-decide.js").SeatLeft[],
 *   limitParks?: number, handOffTries?: number, handedOff?: number, copiedFrom?: string,
 *   relaunchedAt?: number, movedAt?: number, pastSessionIds?: string[],
 *   resumeStarted?: import("./refill-blocks.js").ResumeStarted,
 *   actsBefore?: Record<string, number>|typeof UNREAD}} LoopLaunch
 * @typedef {(sessionId: string, roots: string[]) =>
 *   {acts: string[], unreadable: string[]}} ReadActsBy  lib/arbiter-ledger.js's
 */

/** @typedef {import("./refill-state.js").LoopState} LoopState */
/** @typedef {import("./refill-state.js").LaunchCount} LaunchCount */
/** @typedef {import("./refill-state.js").Hold} Hold */
/** @typedef {import("./refill-batch.js").BatchOutcome} BatchOutcome */

/**
 * The control file's scope. A scope that does not say normal reads as away
 * mode, ticking only the repos it names.
 * @param {unknown} raw
 * @returns {Scope}
 */
function parseScope(raw) {
	const r = isRecord(raw) ? raw : {};
	return {
		mode: r.mode === "normal" ? "normal" : "away",
		repos: parseStrings(r.repos),
		goal: parseGoal(r),
	};
}

/**
 * @param {unknown} raw
 * @returns {raw is import("./refill-decide.js").PauseIssue}
 */
const isPauseIssue = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	typeof raw.number === "number";

/**
 * The control file's pause (#3856): absent or null is no pause, and any other
 * value is one, so a garbled pause launches nothing.
 * @param {unknown} raw
 * @returns {{paused?: import("./refill-decide.js").Pause}}
 */
function parsePause(raw) {
	if (raw === undefined || raw === null) return {};
	const r = isRecord(raw) ? raw : {};
	return {
		paused: {
			by: typeof r.by === "string" ? r.by : "an unreadable record",
			at: typeof r.at === "number" ? r.at : 0,
			...(Array.isArray(r.issues)
				? { issues: r.issues.filter(isPauseIssue) }
				: {}),
			...(typeof r.why === "string" ? { why: r.why } : {}),
		},
	};
}

/**
 * The control file's away switch: absent where it is not one.
 * @param {unknown} raw
 * @returns {{away?: import("./refill-decide.js").AwaySwitch}}
 */
function parseAway(raw) {
	if (!isRecord(raw) || typeof raw.since !== "number") return {};
	return { away: { since: raw.since, absentSeen: raw.absentSeen === true } };
}

/**
 * The control file's fields, or null where it is not one.
 * @param {unknown} raw
 * @returns {Control|null}
 */
function parseControl(raw) {
	if (!isRecord(raw)) return null;
	const { noProgressFrom } = raw;
	if (typeof noProgressFrom !== "number") return null;
	return {
		noProgressFrom,
		stopRequested: raw.stopRequested === true,
		...(typeof raw.stopRequestedAt === "number"
			? { stopRequestedAt: raw.stopRequestedAt }
			: {}),
		...parsePause(raw.paused),
		...parseAway(raw.away),
		...(raw.quietBenchOff === true
			? { quietBenchOff: /** @type {const} */ (true) }
			: {}),
		seats: parseStrings(raw.seats),
		scope: parseScope(raw.scope),
	};
}

/**
 * `control` switched to `mode` at `now`: away records the switch, with no
 * absent read yet, and normal drops it.
 * @param {Control} control
 * @param {Scope["mode"]} mode
 * @param {number} now
 * @returns {Control}
 */
function controlInMode({ away: _switch, ...control }, mode, now) {
	return {
		...control,
		...(mode === "away" ? { away: { since: now, absentSeen: false } } : {}),
		scope: { ...control.scope, mode },
	};
}

/**
 * `control` with its absent read set, a switch with no readable time dated `now`.
 * @param {Control} control
 * @param {boolean} absentSeen
 * @param {number} now
 * @returns {Control}
 */
const withAbsentRead = (control, absentSeen, now) => ({
	...control,
	away: { since: control.away?.since ?? now, absentSeen },
});

/**
 * The control this tick's read of the founder leaves (awayChangeOf), null where
 * it changes nothing.
 * @param {Control} control
 * @param {number|null} lastPromptAt
 * @param {number} now
 * @returns {Control|null}
 */
function controlAfterPresence(control, lastPromptAt, now) {
	const { away } = control;
	const change = awayChangeOf(
		{ mode: control.scope.mode, ...(away ? { away } : {}) },
		lastPromptAt,
		now,
	);
	if (change === null) return null;
	return change === "return"
		? controlInMode(control, "normal", now)
		: withAbsentRead(control, true, now);
}

/**
 * The sessions handed off to their issues since the away switch at `since`, a
 * park of any cause counting, as each ticket then waits on the founder. Stored,
 * as the rows that made them are trimmed or cleared while he is away.
 * @param {Pick<LoopState, "handedOff">} state
 * @param {number} since
 */
const handedOffSince = ({ handedOff }, since) =>
	handedOff?.from === since ? handedOff.count : 0;

/**
 * The stored count after a tick that parked `launches`' rows stamped `now`.
 * @param {Pick<LoopState, "handedOff">} state
 * @param {import("./refill-decide.js").AwaySwitch|undefined} away the switch,
 *   absent in normal mode
 * @param {LoopLaunch[]} launches
 * @param {number} now
 */
function nextHandedOff(state, away, launches, now) {
	if (!away) return state.handedOff;
	const parked = launches.filter(
		(l) => l.parkedAway === true && l.parkStopped === now,
	).length;
	return {
		from: away.since,
		count: handedOffSince(state, away.since) + parked,
	};
}

/**
 * The roots a tick serves, and why each ticked root is not. `readExclusionWhy`
 * re-reads a root's config, so a repo that opts out mid-run is dropped.
 * @param {Scope} scope
 * @param {(root: string) => string|null} readExclusionWhy
 */
function scopeRoots(scope, readExclusionWhy) {
	/** @type {string[]} */
	const roots = [];
	/** @type {{root: string, why: string}[]} */
	const dropped = [];
	for (const root of scope.repos) {
		const why = readExclusionWhy(root);
		if (why === null) roots.push(root);
		else dropped.push({ root, why });
	}
	return { roots, dropped };
}

/**
 * `control` with each ticked root `isOptedOut` names unticked, so a return to
 * the loop needs a fresh tick (#4188), and those roots; null where none is.
 * @param {Control} control
 * @param {(root: string) => boolean} isOptedOut
 * @returns {{control: Control, dropped: string[]}|null}
 */
function controlWithoutOptedOut(control, isOptedOut) {
	const { repos } = control.scope;
	const dropped = repos.filter(isOptedOut);
	if (dropped.length === 0) return null;
	const kept = repos.filter((r) => !dropped.includes(r));
	return {
		control: { ...control, scope: { ...control.scope, repos: kept } },
		dropped,
	};
}

/**
 * The checkouts whose landing queue a tick supervises: `served`, then each
 * other root a recorded launch ran in (#3284). Finished launches count, since
 * a landing outlives its session. Residual: a foreign root drops out once its last launch ages out
 * of the HISTORY_KEPT record, landed or not.
 * @param {string[]} served
 * @param {LoopLaunch[]} launches
 */
const landingRoots = (served, launches) => [
	...new Set([...served, ...launches.map((l) => l.root)]),
];

/**
 * The holds a frontier-reading tick leaves. An away tick opens none, as a seat's
 * reset would launch nothing there (#2355), but keeps one whose seat still reads
 * full, so its start stands (#3850).
 * @param {import("./refill-decide.js").Skip[]} held this tick's
 * @param {Hold[]} before
 * @param {number} now
 * @param {"normal"|"away"} mode
 * @returns {Hold[]}
 */
const holdsOf = (held, before, now, mode) =>
	held.flatMap((h) => {
		const since = before.find(
			(b) => b.root === h.root && b.number === h.number,
		)?.since;
		if (since !== undefined) return [{ ...h, since }];
		return isParkRoutingMode(mode) ? [{ ...h, since: now }] : [];
	});

/**
 * `state` with the members of the batch a kill cut off that `adopt` finds
 * started tracked as launches and counted (#4180); as it was where none was in
 * flight.
 * Residual: the kill leaves the dispatcher running, and a member it launches
 * after `adopt` reads the ledger is never tracked.
 * @param {LoopState} state
 * @param {(launching: import("./refill-batch.js").Launching) => LoopLaunch[]} adopt
 * @returns {LoopState}
 */
function settleLaunching(state, adopt) {
	if (!state.launching) return state;
	const launched = adopt(state.launching);
	const rest = withoutLaunching(state);
	return {
		...rest,
		launches: [...rest.launches, ...launched],
		launchCount: rest.launchCount && {
			...rest.launchCount,
			count: rest.launchCount.count + launched.length,
		},
	};
}

/**
 * Whether this tick files the morning review: the first tick at or after
 * REVIEW_HOUR on a day it has not filed (#2017).
 * @param {Date} now
 * @param {string|null} lastRunOn
 */
const isReviewRunDue = (now, lastRunOn) =>
	now.getHours() >= REVIEW_HOUR && localDate(now) !== lastRunOn;

/**
 * The review child this tick runs and its log label: file-morning-review.js,
 * which answers the reversals too, on a due tick (isReviewRunDue), else
 * answer-review-reversals.js alone.
 * @param {Date} now
 * @param {string|null} lastRunOn
 * @returns {{due: boolean, script: string, label: string}}
 */
function reviewRunOf(now, lastRunOn) {
	const due = isReviewRunDue(now, lastRunOn);
	return due
		? { due, script: "file-morning-review.js", label: "morning review" }
		: {
				due,
				script: "answer-review-reversals.js",
				label: "morning review reversals",
			};
}

/**
 * The last filing's date after a tick's review child, read off its exit
 * status, on a due tick file-morning-review.js's worse of its filing's and
 * its answering's: today once a due tick's is 0, or 2, a refusal a retry
 * would only repeat; unchanged on a tick not due, where it timed out or was
 * killed (null), or on a gh failure or another run's filing lock (1), so the
 * next tick retries and the filing files nothing twice.
 * @param {{due: boolean, status: number|null, lastRunOn: string|null,
 *   today: string}} run
 */
const reviewRunRecorded = ({ due, status, lastRunOn, today }) =>
	due && (status === 0 || status === 2) ? today : lastRunOn;

/**
 * A tick whose review root has no workflow-core config: its log lines, one
 * on the due tick and none after, and the date it records, today on that
 * tick so the line is not repeated.
 * @param {{due: boolean, root: string, lastRunOn: string|null,
 *   today: string}} skip
 * @returns {{lines: string[], runOn: string|null}}
 */
const buildReviewSkip = ({ due, root, lastRunOn, today }) =>
	due
		? {
				lines: [`morning review: not run, ${root} has no workflow-core config`],
				runOn: today,
			}
		: { lines: [], runOn: lastRunOn };

/**
 * A finished review run's log lines: one where it was due, else one only
 * where it printed or failed, so a quiet reversals pass logs none.
 * @param {ReviewResult} ran
 * @returns {string[]}
 */
const buildReviewRunLines = (ran) =>
	ran.due || ran.out || ran.failed ? [buildChildLine(ran.label, ran)] : [];

/**
 * @typedef {{due: boolean, script: string, label: string, today: string}}
 *   ReviewStart a review child to start (reviewRunOf's pick) and the
 *   machine-local date it is started on
 * @typedef {ReviewStart & {status: number|null, out: string,
 *   failed: string|null}} ReviewResult a finished run, as
 *   scripts/refill-review-run.js writes it
 */

/**
 * A tick's review step, where the review child runs detached
 * (scripts/refill-review-run.js, #3765) so the tick never waits on it: a
 * finished run's log lines and the filing date it records
 * (reviewRunRecorded), then the run to start, none while one still runs.
 * @param {{lastRunOn: string|null, now: Date, running: boolean,
 *   finished: ReviewResult|null}} step
 * @returns {{runOn: string|null, lines: string[], start: ReviewStart|null}}
 */
function reviewStep({ lastRunOn, now, running, finished }) {
	const runOn = finished
		? reviewRunRecorded({ ...finished, lastRunOn })
		: lastRunOn;
	return {
		runOn,
		lines: finished ? buildReviewRunLines(finished) : [],
		start: running
			? null
			: { ...reviewRunOf(now, runOn), today: localDate(now) },
	};
}

/**
 * The `admission.js` arguments the loop's free-slot count passes:
 * dispatch-sessions.sh's per-member re-read's, so a slot counted is one that
 * re-read admits (#2500), with the allowance limb left to the cap; its test
 * pins them to the script's.
 */
const FREE_SLOT_ARGS = ["--json", "--launch", "--skip-allowance"];

/**
 * The launches whose session has left the listing or ended, and are not
 * judged yet. Nothing is judged off an unread listing, and a launch with no
 * job id is never judged: nothing ties it to a listed session. One owed a hand-off
 * or still watched after a boot's resume is actOnIdle's to settle (#3880). The listing
 * must span every seat the loop launches on (lib/refill-tick.js's SEATS).
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 */
function newlyFinished(launches, agents, now) {
	if (!agents) return [];
	const listed = new Set(
		agents.filter((a) => a.id && !isTerminalAgent(a)).map((a) => a.id),
	);
	return launches.filter(
		(l) =>
			isLive(l) &&
			now - startedAt(l) >= LISTING_GRACE_MS &&
			!listed.has(l.jobId) &&
			!isHeld(l) &&
			l.handOffTries === undefined &&
			l.bootResumedAt === undefined,
	);
}

/**
 * The launches a tick's state keeps, order unchanged (#3775): every live one,
 * however old, since blockedActs and runningOf see only what is kept, and of
 * the rest the HISTORY_KEPT latest to finish, or to launch where none did.
 * Admission bounds the running ones; a limit-held launch, stopped so outside
 * admission, stays until it resumes or parks (#3790, #3793).
 * Also the UNCLOSED_KEPT latest unclosed launches, which a low-ranked ticket can
 * otherwise outwait, as #3609's record did (#3782).
 * @param {LoopLaunch[]} launches
 */
function keptLaunches(launches) {
	const settledAt = (/** @type {LoopLaunch} */ l) =>
		l.finishedAt ?? l.launchedAt;
	const capped = new Set(
		launches
			.filter((l) => !isLive(l))
			.sort((a, b) => settledAt(a) - settledAt(b))
			.slice(-HISTORY_KEPT)
			.concat(unclosedLaunches(launches).slice(-UNCLOSED_KEPT)),
	);
	return launches.filter((l) => isLive(l) || capped.has(l));
}

/**
 * How many launches the loop made since `from`, the control's noProgressFrom:
 * the stored count from there, else the kept rows, for a state with none or a
 * noProgressFrom since moved. Residual: a state from before the counter seeds it
 * from rows already trimmed, so a run crossing this change undercounts.
 * @param {Pick<LoopState, "launches"|"launchCount">} state
 * @param {number} from
 */
const launchesSince = ({ launches, launchCount }, from) =>
	launchCount?.from === from
		? launchCount.count
		: launches.filter((l) => l.launchedAt >= from).length;

/**
 * The launches with `sessionId` taken from the listing for each that has none
 * yet and whose job it shows (#2311), for the wake on a session's end and
 * actsOf. Off an unread listing, or for a job it does not show, a launch is
 * returned as it was.
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 */
function withSessionIds(launches, agents) {
	if (!agents) return launches;
	const sessions = new Map(
		agents.flatMap((a) => (a.id && a.sessionId ? [[a.id, a.sessionId]] : [])),
	);
	return launches.map((l) => {
		const sessionId = l.jobId === null ? undefined : sessions.get(l.jobId);
		return l.sessionId === undefined && sessionId !== undefined
			? { ...l, sessionId }
			: l;
	});
}

/**
 * The launches after one listing: each the listing first shows given its
 * session id, then each newly finished one marked with `progressOf`'s fields,
 * then each still listed marked parked or not (markParked). The id comes first, so a
 * launch whose first listing already shows it ended is judged with it.
 * @template {object} P
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {{progressOf: (l: LoopLaunch) => P,
 *   causeOf: import("./refill-blocks.js").CauseOf}} read
 * @returns {LoopLaunch[]}
 */
function judgedLaunches(launches, agents, now, { progressOf, causeOf }) {
	const listed = withSessionIds(launches, agents);
	const done = new Set(newlyFinished(listed, agents, now));
	const judged = listed.map((l) =>
		done.has(l) ? { ...l, ...progressOf(l), finishedAt: now } : l,
	);
	return markParked(judged, agents, causeOf, now);
}

/**
 * `acts` counted per kind (#2312).
 * @param {string[]} acts
 * @returns {Record<string, number>}
 */
function countKinds(acts) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const act of acts) {
		const { kind } = parseAct(act);
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return counts;
}

/**
 * The acts session `sessionId` has made so far, for a launch resuming it to
 * count from (#3942). UNREAD where any store would not read, as a partial count
 * would pass the rest off as the resume's own.
 * @param {string} sessionId
 * @param {string[]} roots
 * @param {ReadActsBy} readActsBy
 * @returns {Record<string, number>|typeof UNREAD}
 */
function readActsSoFar(sessionId, roots, readActsBy) {
	const { acts, unreadable } = readActsBy(sessionId, roots);
	return unreadable.length > 0 ? UNREAD : countKinds(acts);
}

/**
 * A finished launch's progress: the acts of its session and each it ran
 * under before a resume moved it to a copy (#2969), across `roots`' stores,
 * counted per kind (#2312), less `actsBefore`, those its session made before
 * this launch began (#3942). UNREAD where its session id was never captured,
 * its past sessions' acts then unsummed, where `actsBefore` is, or where some
 * store would not read and either no act did or `actsBefore` is to be taken off,
 * neither of which is "did nothing". Residual: the loop's repos changing between
 * the resume and the finish misjudges a store only one read saw: one served only
 * at the finish has its earlier acts counted, one served only at the resume has
 * its earlier acts taken off the rest.
 * The reader is passed in so this module stays free of store reads.
 * @param {LoopLaunch} l
 * @param {string[]} roots
 * @param {ReadActsBy} readActsBy
 * @returns {{acts: Record<string, number>|typeof UNREAD}}
 */
function actsOf(l, roots, readActsBy) {
	if (!l.sessionId || l.actsBefore === UNREAD) return { acts: UNREAD };
	const ids = new Set([...(l.pastSessionIds ?? []), l.sessionId]);
	const reads = [...ids].map((id) => readActsBy(id, roots));
	const acts = reads.flatMap((r) => r.acts);
	if (
		(acts.length === 0 || l.actsBefore) &&
		reads.some((r) => r.unreadable.length > 0)
	)
		return { acts: UNREAD };
	const before = l.actsBefore ?? {};
	return {
		acts: Object.fromEntries(
			Object.entries(countKinds(acts)).flatMap(([kind, n]) => {
				const since = n - (before[kind] ?? 0);
				return since > 0 ? [[kind, since]] : [];
			}),
		),
	};
}

/**
 * The loop log's line for a finished launch.
 * @param {LoopLaunch} l
 */
function buildFinishLine(l) {
	const read = actsRead(l);
	const acts = read
		? Object.entries(read)
				.map(([kind, n]) => `${kind} ${n}`)
				.join(", ") || "no acts"
		: UNREAD;
	return `finished ${launchName(l)}: ${acts}`;
}

/**
 * The loop's unfinished launches, for the decision core's `running`, whose one
 * use is not relaunching their issues. Parked ones stay in it (#2118): their
 * session still holds the issue, and no count of these sizes a slot, which
 * admission's memory reading alone does.
 * @param {LoopLaunch[]} launches
 */
const runningOf = (launches) =>
	launches.filter(isLive).map((l) => ({ root: l.root, issues: l.issues }));

/**
 * The launches the idle alarm reads as running: runningOf's less those waiting
 * on a limit, which limitHoldsOf names (#3838).
 * @param {LoopLaunch[]} launches
 */
const workingOf = (launches) =>
	runningOf(launches.filter((l) => limitWaitOf(l) === null));

/**
 * The issues of launches waiting on a limit, as the idle alarm's holds (#3838).
 * @param {LoopLaunch[]} launches
 * @returns {Hold[]}
 */
const limitHoldsOf = (launches) =>
	launches.flatMap((l) => {
		const wait = limitWaitOf(l);
		return wait
			? l.issues.map((number) => ({
					root: l.root,
					number,
					...wait,
					onLimit: true,
				}))
			: [];
	});

/**
 * Whether a `start` or a resume moved the count on after `since`, so a stop decided
 * before it is stale.
 * @param {Control|null} control
 * @param {number} since
 */
const isRestartedSince = (control, since) =>
	control !== null && !control.stopRequested && control.noProgressFrom > since;

/**
 * The stop that ended the loop's last run, or null where none did (#3861). The
 * state's record is the loop's own and a process taking the pidfile clears it;
 * `stop` needs no tick to count, so it stands where the loop died before one. A
 * control from before `stopRequestedAt` reads as time 0, as an unreadable pause
 * does. Residual: a start whose process never took the pidfile leaves the earlier
 * record standing, as does a dead loop's state from before #3861, whose ticks kept
 * an overtaken stop; each reads as that stop until a start's process runs.
 * @param {Control|null} control
 * @param {LoopState["stopped"]} stopped
 * @returns {LoopState["stopped"]}
 */
const recordedStop = (control, stopped) =>
	stopped ??
	(control?.stopRequested
		? {
				at: control.stopRequestedAt ?? 0,
				reason: "explicit",
				detail: EXPLICIT_STOP_DETAIL,
			}
		: null);

/**
 * Whether a control read mid-tick asks the loop to stop. A control gone
 * missing does, as at the tick's start.
 * @param {Control|null} control
 */
const isStopRequested = (control) => control?.stopRequested !== false;

/**
 * Whether a control read mid-tick holds back the tick's next launch: a stop or
 * a pause.
 * @param {Control|null} control
 */
const isLaunchBarred = (control) =>
	isStopRequested(control) || control?.paused !== undefined;

/**
 * What the dispatches did, dispatching each batch in turn after re-reading the
 * control, and none once it asks for a stop (#2126) or a pause: one dispatch can
 * hold the tick for minutes. Residual: a dispatch already running still launches
 * every member.
 * @param {import("./refill-decide.js").Launch[][]} batches
 * @param {() => Control|null} readControl
 * @param {(batch: import("./refill-decide.js").Launch[]) => BatchOutcome} launch
 * @returns {Outcome}
 */
function launchUntilBarred(batches, readControl, launch) {
	/** @type {Outcome} */
	const outcome = { launched: [], refused: [], unreached: [] };
	for (const [i, batch] of batches.entries()) {
		if (isLaunchBarred(readControl())) {
			outcome.unreached = batches.slice(i).flat();
			break;
		}
		const r = launch(batch);
		outcome.launched.push(...r.launched);
		outcome.refused.push(...r.refused);
		const { resumeRefused: reason } = r;
		if (reason) {
			outcome.refused.push(
				...batches
					.slice(i + 1)
					.flat()
					.map((l) => ({ launch: l, reason })),
			);
			break;
		}
	}
	return outcome;
}

/**
 * A record from before #3732 has no reason.
 * @param {{seat: string, reason?: string}} l
 */
const buildSeatText = (l) =>
	`on ${buildSeatName(l.seat)}${l.reason ? ` (${l.reason})` : ""}`;

/**
 * @param {{root: string, prompt: string}[]} launches
 */
const buildLaunchesLine = (launches) => launches.map(launchName).join("; ");

/**
 * @param {{root: string, prompt: string, seat: string, reason?: string}[]} launches
 */
const buildLaunchLine = (launches) =>
	`launch ${launches.map((l) => `${launchName(l)} ${buildSeatText(l)}`).join("; ")}`;

/**
 * One line naming a decision.
 * @param {import("./refill-decide.js").Decision} d
 */
function summaryOf(d) {
	if ("stop" in d) return `stop: ${d.stop} — ${d.detail}`;
	if (d.launches.length > 0) return buildLaunchLine(d.launches);
	return `idle: ${d.idle}`;
}

/**
 * A probed seat's outcome: the outcome line scripts/usage-probe.js writes on
 * stderr, else how its run failed.
 * @param {string} stderr
 * @param {string|null} failed runChild's failure, null on exit 0
 */
function parseProbeOutcome(stderr, failed) {
	const line = stderr.split("\n").find((l) => l.startsWith(OUTCOME_PREFIX));
	return line
		? line.slice(OUTCOME_PREFIX.length).trim()
		: `no outcome line, ${failed ?? "exit 0"}`;
}

/**
 * A tick's frontier read: the merged rows and how long the read took.
 * @typedef {{rows: number, ms: number,
 *   goal: import("./refill-goal.js").GoalRead|null}} FrontierRead
 */

/** @param {FrontierRead} read */
const buildFrontierReadText = (read) =>
	`frontier: ${read.rows} rows in ${(read.ms / 1000).toFixed(1)} s`;

/** @param {import("./refill-decide.js").Skip} s */
const buildSkipText = (s) => `${path.basename(s.root)} #${s.number} ${s.why}`;

/**
 * An idle tick's account of the frontier it read (#2561).
 * @param {Extract<import("./refill-decide.js").Decision, {idle: unknown}>} d
 * @param {FrontierRead|null} read
 */
function frontierNotes(d, read) {
	if (read === null) return [];
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const s of d.skipped) counts.set(s.why, (counts.get(s.why) ?? 0) + 1);
	return [
		buildFrontierReadText(read),
		...(counts.size > 0
			? [
					`skipped ${[...counts].map(([why, n]) => `${n} ${why}`).join(", ")}`,
					`first ${d.skipped.slice(0, LINE_SKIPS).map(buildSkipText).join(", ")}`,
				]
			: []),
	];
}

/**
 * What a tick's dispatches did: the members launched, each refused with its
 * reason, and those a stop left undispatched.
 * @typedef {BatchOutcome & {unreached: import("./refill-decide.js").Launch[]}} Outcome
 */

/**
 * A launching tick's line: what launched, and each member the dispatcher
 * refused as refused, with its reason (#2500).
 * @param {Outcome} o
 */
const buildOutcomeLine = (o) =>
	[
		...(o.launched.length > 0 ? [buildLaunchLine(o.launched)] : []),
		...o.refused.map(
			(r) => `refused ${buildLaunchesLine([r.launch])}: ${r.reason}`,
		),
		...(o.unreached.length > 0
			? [
					`not dispatched ${buildLaunchesLine(o.unreached)}: a stop or a pause landed first`,
				]
			: []),
	].join("; ");

/**
 * The decision's log line, an idle one naming admission's free slots and its
 * frontier, a launching one its dispatches' outcome and its frontier read's
 * time, which sizes the shortlist cap (#2677), and a tick that probed
 * naming each seat's outcome, so the log alone tells a stale-reading wait
 * that had a slot from one that had none (#2362).
 * @param {import("./refill-decide.js").Decision} d
 * @param {Outcome} outcome
 * @param {{freeSlots: number|null, probes: import("./seat-reading.js").Probe[], read: FrontierRead|null,
 *   resumesDue: number, resumesStarted: number}} seen
 */
function buildTickLine(
	d,
	outcome,
	{ freeSlots, probes, read, resumesDue, resumesStarted },
) {
	if ("stop" in d) return summaryOf(d);
	const head = d.launches.length > 0 ? buildOutcomeLine(outcome) : summaryOf(d);
	const notes = [
		...(resumesDue > 0
			? [`resumed ${resumesStarted} of ${resumesDue} due`]
			: []),
		...(d.launches.length === 0
			? [
					...(freeSlots === null ? [] : [`free slots: ${freeSlots}`]),
					...frontierNotes(d, read),
				]
			: []),
		...(d.launches.length > 0 && read ? [buildFrontierReadText(read)] : []),
		...(probes.length > 0
			? [`probed ${probes.map((p) => `${p.seat}: ${p.outcome}`).join(", ")}`]
			: []),
	];
	return `${head}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * A log line for each resume the decision left waiting on its seat's cap (#3911).
 * @param {import("./refill-decide.js").Decision} d
 */
const buildCapHeldLines = (d) =>
	"stop" in d
		? []
		: (d.capHeld ?? []).map(({ line, seat }) =>
				buildResumeWaitLine(
					line,
					`the cap on ${buildSeatName(seat)} has no fit left`,
				),
			);

/**
 * The state's stop record for a stop decision, else null.
 * @param {import("./refill-decide.js").Decision} d
 * @param {number} at
 */
const stoppedOf = (d, at) =>
	"stop" in d ? { at, reason: d.stop, detail: d.detail } : null;

/**
 * The record of the first start on an overflow seat after one on a plan seat,
 * since `since`, the last record's time, logged, or null. The credential scan
 * runs only then; its failure is logged, since the launches it follows are not
 * yet in the state.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {LoopLaunch[]} launches the state's, the tick's acts made, and its
 *   launches
 * @param {number|null} since
 * @param {{readOmittedDirs: () => string[], log: (line: string) => void}} io
 * @returns {import("./overflow-notice.js").OverflowStart|null}
 */
function recordOverflowStart(input, launches, since, io) {
	const first = firstOverflowStart(launches, since);
	if (first === null) return null;
	/** @type {string[]} */
	let omitted = [];
	try {
		omitted = io.readOmittedDirs();
	} catch (err) {
		io.log(`credentials scan failed: ${buildErrorText(err)}`);
	}
	const start = {
		at: first.at,
		seat: first.launch.seat,
		planSeats: input.seats.map(planSeatBasisOf),
		omitted,
	};
	io.log(
		`first overflow launch on ${buildSeatName(first.launch.seat)}: ${buildOverflowStartLines(start).join("; ")}`,
	);
	return start;
}

/**
 * @typedef {(resumes: import("./refill-decide.js").HeldResume[],
 *   launches: LoopLaunch[], isStopped: () => boolean,
 *   record: (launches: LoopLaunch[]) => void) =>
 *   {launches: LoopLaunch[], started: number, waiting: boolean}} ResumeHeld
 */

/**
 * The decision's resumes made, ahead of its launches; none on a stop. `record`
 * writes the state with the launches as the step leaves each resume.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {LoopLaunch[]} launches
 * @param {{readControl: () => ControlRead, resumeHeld: ResumeHeld}} io
 * @param {(launches: LoopLaunch[]) => void} record
 */
const resumeDecided = (decision, launches, io, record) =>
	"stop" in decision
		? { launches, started: 0, waiting: false }
		: io.resumeHeld(
				decision.resumes,
				launches,
				() => isLaunchBarred(io.readControl().control),
				record,
			);

/** @param {import("./refill-decide.js").TickInput} input */
const dueCount = (input) => input.resumable?.length ?? 0;

/**
 * The state's goal progress after a tick, as it stands where the tick read no
 * frontier.
 * @param {LoopState["goalProgress"]} before
 * @param {FrontierRead|null} read
 * @param {number} now
 */
const goalProgressAfter = (before, read, now) =>
	read === null ? before : buildGoalProgress(before, read.goal, now);

/**
 * The input's resumes the step left held, for a late stop to name.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {LoopLaunch[]} launches
 */
const leftDue = (input, launches) =>
	(input.resumable ?? []).filter((r) =>
		launches.some((l) => l.jobId === r.jobId && isStepResume(l)),
	);

/**
 * The tick's launches as batches: none on a stop, nor behind a resume the
 * re-read made wait, which a fresh start would overtake.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {boolean} waiting
 */
const buildLaunchBatches = (decision, waiting) =>
	"stop" in decision || waiting ? [] : batchesOf(decision.launches);

/**
 * @param {import("./refill-decide.js").Decision} decision
 * @param {{writePause: (pause: import("./refill-decide.js").Pause) => void}} io
 */
function writeDecidedPause(decision, io) {
	if (!("stop" in decision) && decision.pause) io.writePause(decision.pause);
}

/**
 * The state's record of a tick: a stop leaves no idle reason to read.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {number} at
 * @param {string} summary
 */
const buildLastTick = (decision, at, summary) => ({
	at,
	summary,
	...("stop" in decision
		? {}
		: {
				skipped: decision.skipped,
				idle: decision.idle,
				...(decision.planWait ? { planWait: decision.planWait } : {}),
			}),
});

/**
 * A tick from its decision on: dispatch its launches while the control asks
 * for no stop or pause, write the no-progress pause it decided, write the
 * state, then take the morning review's step, which
 * starts its child detached and returns at once (reviewStep).
 * A stop that landed during the dispatches or the review is logged and
 * recorded as `stop: explicit`, or `control-damaged` where the re-read found
 * the control damaged, so the loop ends at this tick's end, which
 * `stop` promises (#2126).
 * Each resume and each batch is on record in the state before its launcher
 * runs (#4157, #4180).
 * @param {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision, state: LoopState,
 *   judged: LoopLaunch[], probes: import("./seat-reading.js").Probe[], read: FrontierRead|null,
 *   probeBrokenRoots: string[], bootedAt?: number, sameBootRestart?: true,
 *   away?: import("./refill-decide.js").AwaySwitch}} tick
 * @param {{readControl: () => ControlRead,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[]) => BatchOutcome,
 *   resumeHeld: ResumeHeld,
 *   writePause: (pause: import("./refill-decide.js").Pause) => void,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   updateState: (transition: import("./refill-state.js").Transition) =>
 *     LoopState,
 *   readOmittedDirs: () => string[],
 *   log: (line: string) => void, now: () => number}} io
 * @returns {{decision: import("./refill-decide.js").Decision,
 *   launched: number}} the late stop where one landed, else the tick's
 *   decision, and how many sessions the tick started
 */
function settleTick(
	{
		input,
		decision,
		state,
		judged,
		probes,
		read,
		probeBrokenRoots,
		bootedAt,
		sameBootRestart,
		away,
	},
	io,
) {
	/** @type {LoopLaunch[]} */
	const launchedSoFar = [];
	/** @type {(launches: LoopLaunch[],
	 *   launching?: import("./refill-batch.js").Launching) => LoopState} */
	const record = (launches, launching) =>
		io.updateState(
			batchLaunching(keptLaunches(launches), state, {
				bootedAt,
				sameBootRestart,
				...(launching
					? {
							launching: {
								launching,
								launchCount: {
									from: input.noProgressFrom,
									count:
										launchesSince(state, input.noProgressFrom) +
										launchedSoFar.length,
								},
							},
						}
					: {}),
			}),
		);
	const {
		launches: afterResumes,
		started,
		waiting,
	} = resumeDecided(decision, judged, io, record);
	const outcome = launchUntilBarred(
		buildLaunchBatches(decision, waiting),
		() => io.readControl().control,
		(batch) => {
			record([...afterResumes, ...launchedSoFar], { at: io.now(), batch });
			const r = io.launchBatch(batch);
			launchedSoFar.push(...r.launched);
			return r;
		},
	);
	const summary = buildTickLine(decision, outcome, {
		freeSlots: input.paused ? null : input.freeSlots,
		probes,
		read,
		resumesDue: dueCount(input),
		resumesStarted: started,
	});
	for (const line of buildCapHeldLines(decision)) io.log(line);
	io.log(summary);
	writeDecidedPause(decision, io);
	const overflowStart = recordOverflowStart(
		input,
		[...afterResumes, ...outcome.launched],
		state.overflowStart?.at ?? null,
		io,
	);
	const settledState = io.updateState(
		tickSettled(
			{
				launches: keptLaunches([...afterResumes, ...outcome.launched]),
				lastTick: buildLastTick(decision, input.now, summary),
				/* A tick that does not stop outlives any record, a stop a `start`
				 * overtook included. */
				stopped: stoppedOf(decision, input.now),
				held:
					"stop" in decision || read === null
						? state.held
						: holdsOf(decision.held, state.held, input.now, input.mode),
				launchCount: {
					from: input.noProgressFrom,
					count:
						launchesSince(state, input.noProgressFrom) +
						outcome.launched.length,
				},
				handedOff: nextHandedOff(state, away, judged, input.now),
				overflowStart: overflowStart ?? state.overflowStart,
				goalProgress: goalProgressAfter(state.goalProgress, read, input.now),
				probeBrokenRoots,
				seatTriedAt: seatTriedAfter(state.seatTriedAt, probes, input.now),
				bootedAt,
				sameBootRestart,
			},
			state,
		),
	);
	const reviewRunOn = io.runReview(settledState.reviewRunOn, input.now);
	const reread = "stop" in decision ? null : io.readControl();
	const late =
		reread === null || !isStopRequested(reread.control)
			? null
			: decideTick({
					...input,
					stopRequested: true,
					controlDamaged: reread.damaged,
					resumable: leftDue(input, afterResumes),
				});
	if (late) io.log(summaryOf(late));
	if (late || reviewRunOn !== settledState.reviewRunOn)
		io.updateState(
			lateStopped(
				(late && stoppedOf(late, io.now())) ?? settledState.stopped,
				reviewRunOn,
			),
		);
	return {
		decision: late ?? decision,
		launched: outcome.launched.length + started,
	};
}

/**
 * Stop each job that never started (lib/hung-jobs.js's neverStartedJobs,
 * #2467) through `stop(job)`, a `claude stop <short id>` on its seat that
 * answers null or why it failed; the log line for each. Its live processes
 * are lib/registry-agents.js's, which needs no CLI (#2665). Off a registry
 * seat that would not read, or no job store, it stops nothing and says why;
 * a job on a seat with no registry at all is left unjudged.
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Parameters<typeof neverStartedJobs>[0]|null} jobs
 * @param {(job: ReturnType<typeof neverStartedJobs>[number]) => string|null} stop
 */
function stopNeverStarted(registry, jobs, stop) {
	/** @param {string} why */
	const skipped = (why) => [`never-started jobs unjudged: ${why}`];
	if (registry.faults.length > 0) return skipped(registry.faults.join("; "));
	if (!jobs) return skipped("no job store would open");
	const live = new Set(registry.agents.map((a) => a.sessionId));
	return neverStartedJobs(jobs, { live, seats: registry.seats }).map((j) => {
		const failed = stop(j);
		const age = j.age === null ? "an unreadable age" : `${Math.floor(j.age)}m`;
		return `${failed ? "could not stop" : "stopped"} never-started job ${j.job} on ${j.seat} (${j.intent ?? "no intent"}; ${age}, no pid, no transcript)${failed ? `: ${failed}` : ""}`;
	});
}

module.exports = {
	settleLaunching,
	controlAfterPresence,
	controlInMode,
	handedOffSince,
	withAbsentRead,
	FREE_SLOT_ARGS,
	actsOf,
	readActsSoFar,
	parseControl,
	buildFinishLine,
	recordedStop,
	isRestartedSince,
	judgedLaunches,
	buildLaunchesLine,
	buildSeatText,
	buildFrontierReadText,
	buildSkipText,
	isReviewRunDue,
	buildReviewSkip,
	reviewStep,
	limitHoldsOf,
	runningOf,
	workingOf,
	parseScope,
	scopeRoots,
	controlWithoutOptedOut,
	landingRoots,
	parseProbeOutcome,
	settleTick,
	launchesSince,
	stopNeverStarted,
	summaryOf,
};
