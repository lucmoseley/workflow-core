/*
 * refill-loop.js — the refill loop's readings shared by its tick and its
 * commands, with no I/O of its own (#2012, spec #1995, #3392): parsing its
 * files' contents, its scope, its launches' acts and the lines `status` names
 * them by. The tick's step order and its own readings are
 * lib/refill-tick-core.js's; the files themselves, lib/refill-files.js's; the
 * state file, lib/refill-state.js's; a seat's reading and sizing,
 * lib/seat-reading.js's; launching a tick's picks, lib/refill-batch.js's; what
 * `start` and `status` print, lib/refill-commands.js's.
 */

const path = require("node:path");
const { parseAct } = require("./act-line.js");
const { REVIEW_HOUR, localDate } = require("./morning-review.js");
const { isTerminalAgent } = require("./agent-liveness.js");
const {
	EXPLICIT_STOP_DETAIL,
	startedAt,
	UNREAD,
} = require("./refill-decide.js");
const {
	buildChildLine,
	isHeld,
	isLive,
	launchName,
	limitWaitOf,
	LISTING_GRACE_MS,
	markParked,
} = require("./refill-blocks.js");
const { isRecord, parseGoal, parseStrings } = require("./refill-goal.js");
const { buildSeatName } = require("./refill-seats.js");

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
 * The sessions handed off to their issues since the away switch at `since`, a
 * park of any cause counting, as each ticket then waits on the founder. Stored,
 * as the rows that made them are trimmed or cleared while he is away.
 * @param {Pick<LoopState, "handedOff">} state
 * @param {number} since
 */
const handedOffSince = ({ handedOff }, since) =>
	handedOff?.from === since ? handedOff.count : 0;

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
 * A record from before #3732 has no reason.
 * @param {{seat: string, reason?: string}} l
 */
const buildSeatText = (l) =>
	`on ${buildSeatName(l.seat)}${l.reason ? ` (${l.reason})` : ""}`;

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

module.exports = {
	judgedLaunches,
	controlInMode,
	handedOffSince,
	withAbsentRead,
	actsOf,
	readActsSoFar,
	parseControl,
	recordedStop,
	isRestartedSince,
	buildLaunchLine,
	buildSeatText,
	buildFrontierReadText,
	buildSkipText,
	isReviewRunDue,
	reviewStep,
	limitHoldsOf,
	runningOf,
	workingOf,
	scopeRoots,
	controlWithoutOptedOut,
	landingRoots,
	launchesSince,
	summaryOf,
};
