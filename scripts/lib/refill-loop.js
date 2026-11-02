/*
 * refill-loop.js — the refill loop's logic around lib/refill-decide.js, with
 * no I/O of its own (#2012, spec #1995, #3392): parsing its files' contents, sizing
 * its seats, judging its launches and settling its tick, each step taking its
 * effects and clock as arguments. The files themselves are
 * lib/refill-files.js's; launching a tick's picks, lib/refill-batch.js's;
 * what `start` and `status` print, lib/refill-commands.js's.
 */

const path = require("node:path");
const { parseAct } = require("./act-line.js");
const { isTerminalAgent } = require("./agent-liveness.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const { REVIEW_HOUR, localDate } = require("./morning-review.js");
const { sizedPercent } = require("./allowance.js");
const { batchesOf } = require("./refill-batch.js");
const {
	awayChangeOf,
	FULL,
	UNREAD,
	actsRead,
	decideTick,
	fitsLaunch,
	hasRoom,
	isParkRoutingMode,
	orderPlanSeats,
} = require("./refill-decide.js");
const {
	buildChildLine,
	isHeld,
	isLive,
	launchName,
	isStepResume,
	limitWaitOf,
	markParked,
} = require("./refill-blocks.js");
const { buildErrorText } = require("./caught.js");
const { buildSeatName } = require("./refill-seats.js");
const { unclosedLaunches } = require("./unclosed-launch.js");
const {
	buildOverflowStartLines,
	firstOverflowLaunch,
	parseOverflowStart,
	planSeatBasisOf,
} = require("./overflow-notice.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

/* A finished session drops off the listing; one just launched may not be on
 * it yet, so a launch younger than this is never judged finished. Untraced. */
const LISTING_GRACE_MS = 2 * 60 * 1000;
/* Enough for the no-progress run and for `status`. Untraced. */
const HISTORY_KEPT = 50;
/* A bound on the state file, since a ticket outranked for weeks must keep its
 * record: roomy against the 7 the live file held on 2 Nov 2026. A guess. */
const UNCLOSED_KEPT = 50;
/* The skipped rows an idle tick's log line names. Untraced. */
const LINE_SKIPS = 3;
/* dispatch-sessions.sh's WEEK_CEILING and SESSION_CEILING defaults, the
 * thresholds its cap sizes a launch past; its test pins the two copies
 * together. */
const DEFAULT_CEILINGS = { week: 97, session: 90 };

/**
 * @typedef {object} Control
 * @property {number} noProgressFrom ms, where the no-progress count counts from
 * @property {boolean} stopRequested
 * @property {import("./refill-decide.js").Pause} [paused] absent where not paused
 * @property {import("./refill-decide.js").AwaySwitch} [away] absent in normal
 *   mode, or where the file holds no readable switch: a tick's absent read then
 *   dates it, and until then status names no switch time
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
 * @property {Record<string, number[]>} goals keyed by checkout root
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
 * cleared, waits on the resume step (#3863). `limitHeld`, while it holds one stopped on its seat's
 * limit, and `limitResumes`, its resumes and moves (#3735, #3734), `limitLeft`,
 * the seats a limit moved it off. `limitParks`, the
 * limit-cap parks in a row its ticket came back from (#3804). `handOffTries` counts the hand-offs of
 * one stopped still idle that failed, and
 * `handedOff` is when one went to a fresh launch. `relaunchedAt` is when a
 * stop and `--bg --resume` last restarted its job, from which it has the
 * listing's grace. Where a resume moved it to a copy (#2963), `copiedFrom`
 * is the job its dispatch-ledger hold names; `pastSessionIds`, the sessions
 * it ran under before `sessionId`.
 * @typedef {import("./refill-decide.js").LaunchRecord & {
 *   prompt: string, seat: string, jobId: string|null,
 *   parked?: boolean, block?: import("./block-act.js").Block,
 *   parkStopped?: number, parkedAway?: boolean, sessionId?: string,
 *   resumes?: import("./refill-blocks.js").Resumes,
 *   idleResumes?: import("./refill-blocks.js").IdleResumes, idleSince?: number,
 *   swapHeld?: import("./refill-blocks.js").SwapHeld,
 *   holdCleared?: import("./refill-blocks.js").HoldCleared,
 *   limitHeld?: import("./refill-blocks.js").LimitHeld,
 *   limitResumes?: import("./refill-blocks.js").LimitResumes,
 *   limitLeft?: import("./refill-decide.js").SeatLeft[],
 *   limitParks?: number, handOffTries?: number, handedOff?: number, copiedFrom?: string,
 *   relaunchedAt?: number, pastSessionIds?: string[]}} LoopLaunch
 */

/**
 * @typedef {object} LoopState
 * @property {LoopLaunch[]} launches
 * @property {{at: number, summary: string,
 *   skipped?: import("./refill-decide.js").Skip[],
 *   idle?: string|null}|null} lastTick `idle` is decideTick's reason it launched
 *   nothing, the idle alarm's source for it (#3920)
 * @property {{at: number, reason: string, detail: string}|null} stopped
 * @property {Hold[]} held the last frontier-reading tick's, for the idle
 *   alarm (#3680)
 * @property {string|null} reviewRunOn machine-local date of the last morning
 *   review filing
 * @property {LaunchCount|null} launchCount
 * @property {LaunchCount|null} handedOff handedOffSince's, `from` being the away
 *   switch
 * @property {LaunchDay|null} launchDay
 * @property {import("./overflow-notice.js").OverflowStart|null} overflowStart
 *   the newest first overflow launch after a plan-seat launch
 * @property {string[]} probeBrokenRoots the last settled tick's served checkouts
 *   whose probe failed, for the idle alarm: such a failure may leave no hold on
 *   file (#3903)
 */

/**
 * The launches since `from`, the control's noProgressFrom, which outlast the
 * rows keptLaunches trims (#3889).
 * @typedef {{from: number, count: number}} LaunchCount
 */

/**
 * The launches on `day`, machine-local, which outlast the rows keptLaunches
 * trims (#3873).
 * @typedef {{day: string, count: number}} LaunchDay
 */

/**
 * An issue the loop holds, and since when, ms: a parked row on its session's full
 * seat, from the first normal-mode tick of an unbroken run of frontier-reading
 * ticks that held it; or, `onLimit`, a launch waiting on a limit (limitWaitOf).
 * @typedef {import("./refill-decide.js").Skip & {since: number,
 *   onLimit?: boolean}} Hold
 */

/** @typedef {import("./refill-decide.js").SeatReading} SeatReading */
/** @typedef {import("./refill-decide.js").SizedSeat} SizedSeat */
/** @typedef {import("./refill-batch.js").BatchOutcome} BatchOutcome */

/** @param {unknown} raw @returns {raw is Record<string, unknown>} */
const isRecord = (raw) => typeof raw === "object" && raw !== null;

/** @param {unknown} raw */
const parseStrings = (raw) =>
	Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];

/**
 * Whether a raw scope has away mode's old shape, serving every included checkout
 * bar `exclude`. writeControlFile's `tickedSet` marks an `exclude` it repeated. A stopgap: #3921 removes it.
 * @param {unknown} raw
 */
const hasExcludeShape = (raw) =>
	isRecord(raw) &&
	raw.mode !== "normal" &&
	Array.isArray(raw.exclude) &&
	raw.tickedSet !== true;

/**
 * The control file's scope. A scope that does not say normal reads as away
 * mode, ticking only the repos it names.
 * @param {unknown} raw
 * @param {() => string[]} [readIncluded] discovery's checkouts, for
 *   hasExcludeShape's shape
 * @returns {Scope}
 */
function parseScope(raw, readIncluded = () => []) {
	const r = isRecord(raw) ? raw : {};
	/** @type {Record<string, number[]>} */
	const goals = {};
	for (const [root, issues] of Object.entries(
		isRecord(r.goals) ? r.goals : {},
	)) {
		const kept = Array.isArray(issues) ? issues.filter(Number.isInteger) : [];
		if (kept.length > 0) goals[root] = kept;
	}
	return {
		mode: r.mode === "normal" ? "normal" : "away",
		repos: hasExcludeShape(r)
			? readIncluded().filter((root) => !parseStrings(r.exclude).includes(root))
			: parseStrings(r.repos),
		goals,
	};
}

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
 * The control file's fields, or null where it is not one. A file a start before
 * #3854 wrote names noProgressFrom `startedAt`. A stopgap: #3888 removes it.
 * @param {unknown} raw
 * @param {() => string[]} [readIncluded] parseScope's
 * @returns {Control|null}
 */
function parseControl(raw, readIncluded) {
	if (!isRecord(raw)) return null;
	const noProgressFrom = raw.noProgressFrom ?? raw.startedAt;
	if (typeof noProgressFrom !== "number") return null;
	return {
		noProgressFrom,
		stopRequested: raw.stopRequested === true,
		...parsePause(raw.paused),
		...parseAway(raw.away),
		seats: parseStrings(raw.seats),
		scope: parseScope(raw.scope, readIncluded),
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
 * The roots a tick serves, and why each ticked root is not. `exclusionOf`
 * re-reads a root's config, so a repo that opts out mid-run is dropped.
 * @param {Scope} scope
 * @param {(root: string) => string|null} exclusionOf
 */
function scopeRoots(scope, exclusionOf) {
	/** @type {string[]} */
	const roots = [];
	/** @type {{root: string, why: string}[]} */
	const dropped = [];
	for (const root of scope.repos) {
		const why = exclusionOf(root);
		if (why === null) roots.push(root);
		else dropped.push({ root, why });
	}
	return { roots, dropped };
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

/** @param {unknown} raw @returns {LoopState["stopped"]} */
function parseStopped(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.reason !== "string"
	)
		return null;
	return {
		at: raw.at,
		reason: raw.reason,
		detail: typeof raw.detail === "string" ? raw.detail : "",
	};
}

/** @param {unknown} raw */
const isSkip = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	typeof raw.number === "number" &&
	typeof raw.why === "string";

/** @param {unknown} raw @returns {raw is Hold} */
const isHold = (raw) =>
	isRecord(raw) && isSkip(raw) && typeof raw.since === "number";

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

/** @param {unknown} raw @returns {LoopState["lastTick"]} */
function parseLastTick(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.summary !== "string"
	)
		return null;
	const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter(isSkip) : [];
	const idle = typeof raw.idle === "string" ? raw.idle : null;
	return { at: raw.at, summary: raw.summary, skipped, idle };
}

/** @param {unknown} raw @returns {LaunchCount|null} */
const parseLaunchCount = (raw) =>
	isRecord(raw) && typeof raw.from === "number" && typeof raw.count === "number"
		? { from: raw.from, count: raw.count }
		: null;

/** @param {unknown} raw @returns {LaunchDay|null} */
const parseLaunchDay = (raw) =>
	isRecord(raw) && typeof raw.day === "string" && typeof raw.count === "number"
		? { day: raw.day, count: raw.count }
		: null;

/** @param {unknown} raw @returns {LoopState} */
function parseState(raw) {
	const r = isRecord(raw) ? raw : {};
	return {
		launches: Array.isArray(r.launches) ? r.launches : [],
		lastTick: parseLastTick(r.lastTick),
		stopped: parseStopped(r.stopped),
		held: Array.isArray(r.held) ? r.held.filter(isHold) : [],
		reviewRunOn: typeof r.reviewRunOn === "string" ? r.reviewRunOn : null,
		launchCount: parseLaunchCount(r.launchCount),
		handedOff: parseLaunchCount(r.handedOff),
		launchDay: parseLaunchDay(r.launchDay),
		overflowStart: parseOverflowStart(r.overflowStart),
		probeBrokenRoots: parseStrings(r.probeBrokenRoots),
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
 * dispatch-sessions.sh's cap thresholds, from the variables it reads.
 * @param {Record<string, string | undefined>} env
 */
const ceilingsOf = (env) => ({
	week: Number(env.WFC_DISPATCH_WEEK_CEILING || DEFAULT_CEILINGS.week),
	session: Number(env.WFC_DISPATCH_SESSION_CEILING || DEFAULT_CEILINGS.session),
});

/**
 * A seat's reading from lib/allowance.js's bars. A bar is full where it reads
 * 100% fresh, or, unfresh, its cached percent is 100 and its cached reset is
 * still ahead: a locked seat's bars age without refreshing, and neither
 * reopens before its reset (#2606). A passed or unparsed reset leaves it
 * unread. The weekly reset is kept whatever the bar's trust (#3732); one
 * passed or unparsed reads as unread. Each bar reads `sizedPercent`'s figure.
 * @param {string} seat
 * @param {{session: import("./allowance.js").Bar,
 *   weekly_all: import("./allowance.js").Bar}} bars
 * @param {number} now
 * @returns {SeatReading}
 */
function seatReadingOf(seat, { session, weekly_all: week }, now) {
	/** @param {import("./allowance.js").Bar} b */
	const full = (b) =>
		b.percent !== null &&
		b.percent >= FULL &&
		(b.trust === "fresh" || Date.parse(b.resetsAt ?? "") > now);
	const sessionFull = full(session);
	const weekResets = Date.parse(week.resetsAt ?? "");
	return {
		/* An unstamped bar is a printed `/usage`, read now, or unread. */
		readAt: Math.min(session.fetchedAtMs ?? now, week.fetchedAtMs ?? now),
		seat,
		week: sizedPercent(week),
		session: sizedPercent(session),
		weekFull: full(week),
		sessionFull,
		sessionResets: session.resetsAt,
		weekResets: weekResets > now ? weekResets : null,
		weekRead: {
			percent: week.percent,
			/* A printed `/usage` carries no time: it was read just now. */
			atMs: week.fetchedAtMs ?? (week.trust === "fresh" ? now : null),
		},
	};
}

/**
 * The stale seats to refresh: those ahead of the first fresh seat with room,
 * so failover keeps its order and a stale seat behind a full one is read
 * rather than waited on. A seat the cap sized 0 is passed as a full one is; a
 * seat with a full bar is passed unread, that bar reopening only at its reset.
 * With `sizeAll`, every stale seat, a move weighing them all.
 * @param {(SeatReading & {fits?: number|null})[]} readings in failover order
 * @param {boolean} sizeAll
 */
function seatsToRefresh(readings, sizeAll) {
	/** @type {string[]} */
	const stale = [];
	for (const r of readings) {
		if (r.weekFull || r.sessionFull) continue;
		if (r.week === null || r.session === null) stale.push(r.seat);
		// Not fitsLaunch: an unsized seat with room ends the walk, the tick waiting on it.
		else if (!sizeAll && hasRoom(r) && r.fits !== 0) break;
	}
	return stale;
}

/**
 * Each seat with the dispatcher's cap sized on it, in failover order, up to
 * the first seat with room that sizes above 0 (#2432): the decision core
 * launches there, so the seats behind it are left unsized, unless `sizeAll`,
 * for a move, whose own seat is passed over (#3734). With no slot free nothing
 * is sized.
 * @param {SeatReading[]} readings
 * @param {number} slots
 * @param {(seat: string, members: number) => number|null} sizeOf the cap's
 *   launch count for `members` on `seat`, null where it cannot be sized
 * @param {boolean} sizeAll
 * @returns {SizedSeat[]}
 */
function sizedSeats(readings, slots, sizeOf, sizeAll) {
	let sized = false;
	return readings.map((r) => {
		if (sized || !hasRoom(r)) return { ...r, fits: null };
		const fits = slots > 0 ? sizeOf(r.seat, slots) : 0;
		sized = !sizeAll && fitsLaunch({ ...r, fits });
		return { ...r, fits };
	});
}

/**
 * `seats`, in launch order, with each cap a tick's resumes need sized (#3895):
 * sizedSeats stops at the first seat that fits one, but a resume is held to its
 * own seat's cap. Each seat with one due, and the next seat with room wherever
 * the resumes leave no fit spare, so a launch falls through to it.
 * @param {SizedSeat[]} seats
 * @param {import("./refill-decide.js").HeldResume[]} resumable
 * @param {number} slots
 * @param {(seat: string, members: number) => number|null} sizeOf
 * @returns {SizedSeat[]}
 */
function sizeResumeSeats(seats, resumable, slots, sizeOf) {
	if (slots === 0 || resumable.length === 0) return seats;
	let spare = false;
	return seats.map((s) => {
		const due = resumable.filter((r) => r.seat === s.seat).length;
		const sized =
			s.fits === null && hasRoom(s) && (due > 0 || !spare)
				? { ...s, fits: sizeOf(s.seat, slots) }
				: s;
		spare ||= hasRoom(sized) && (sized.fits ?? 0) > due;
		return sized;
	});
}

/**
 * Each seat read and sized for a tick, in the decision core's launch order
 * (#3732): the stale seats ahead of the first one free to launch are
 * refreshed by `/usage` first, then those behind a seat the cap sizes 0, so
 * the fall-through reaches them (#2432). Each seat is probed and sized at
 * most once; with no slot free nothing is refreshed or sized.
 * @param {number} slots
 * @param {{
 *   read: (usage: Map<string, string>) => SeatReading[],
 *   probe: (seats: string[]) => {usage: Map<string, string>, probes: Probe[]},
 *   sizeOf: (seat: string, members: number, usageText: string) => number|null,
 *   typedSeat: string|null,
 *   sizeAll?: boolean,
 * }} io `read` takes each refreshed seat's printed `/usage` and returns the
 *   seats in seat-file order; `typedSeat` is the seat the founder last typed
 *   on, null where none is recorded; `sizeAll`, each seat with room read and
 *   sized, not only up to the first
 * @returns {{seats: SizedSeat[], probes: Probe[]}}
 */
function readSizedSeats(
	slots,
	{ read, probe, sizeOf, typedSeat, sizeAll = false },
) {
	/** @type {Map<string, string>} */
	const usage = new Map();
	/** @type {Probe[]} */
	const probes = [];
	/* Keyed on the seat alone: `members` is always `slots`, and a sized seat
	 * reads fresh, so it is never refreshed later in the tick. */
	/** @type {Map<string, number|null>} */
	const fits = new Map();
	const sizeOnce = (/** @type {string} */ seat, /** @type {number} */ n) => {
		const known = fits.get(seat);
		if (known !== undefined) return known;
		const sized = sizeOf(seat, n, usage.get(seat) ?? "");
		fits.set(seat, sized);
		return sized;
	};
	const readOrdered = () => orderPlanSeats(read(usage), typedSeat);
	let readings = readOrdered();
	let stale = slots > 0 ? seatsToRefresh(readings, sizeAll) : [];
	for (;;) {
		if (stale.length > 0) {
			const printed = probe(stale);
			for (const [seat, text] of printed.usage) usage.set(seat, text);
			probes.push(...printed.probes);
			readings = readOrdered();
		}
		const sized = sizedSeats(readings, slots, sizeOnce, sizeAll);
		stale =
			slots > 0
				? seatsToRefresh(sized, sizeAll).filter((seat) => !usage.has(seat))
				: [];
		if (stale.length === 0) return { seats: sized, probes };
	}
}

/**
 * Each overflow seat's reading for the decision core, its budget read only
 * once every plan seat is weekly-full, the one state it launches in (#2570).
 * A key is spent for its cycle where Anthropic refused it for credit, or
 * where its settled spend leaves under one launch's reservation, which no
 * running session's end reopens. A seat file that refuses reads as one
 * unread seat, so the tick waits on it rather than stopping the run (#2611).
 * @param {import("./refill-seats.js").SeatList} list
 * @param {SeatReading[]} plan
 * @param {(seat: import("./refill-seats.js").OverflowSeat) =>
 *   import("./overflow-budget-core.js").Budget|{why: string}} budgetOf
 *   lib/overflow-budget.js's seatBudget
 * @returns {import("./refill-decide.js").OverflowReading[]}
 */
function overflowReadings(list, plan, budgetOf) {
	if (list.errors.length > 0)
		return [
			{
				seat: "the seat file",
				fits: null,
				spentUntil: null,
				why: `it refuses: ${list.errors.join("; ")}`,
			},
		];
	/* The decision core's own test too; repeated here so a tick a plan seat
	 * can serve settles no ledger. */
	const due = plan.every((s) => s.weekFull);
	/** @type {import("./refill-seats.js").OverflowSeat[]} */
	const seats = list.seats.flatMap((s) => (s.kind === "overflow" ? [s] : []));
	return seats.map((seat) => {
		const unread = { seat: seat.dir, fits: null, spentUntil: null };
		if (!due) return { ...unread, why: "a plan seat is not weekly-full" };
		const b = budgetOf(seat);
		if ("why" in b) return { ...unread, why: b.why };
		const spent = b.exhausted || b.grantUsd - b.settledUsd < b.qUsd;
		return {
			seat: seat.dir,
			fits: b.fit,
			spentUntil: spent ? localDate(new Date(b.nextCycleStart)) : null,
			why: null,
		};
	});
}

/**
 * The `admission.js` arguments the loop's free-slot count passes:
 * dispatch-sessions.sh's per-member re-read's, so a slot counted is one that
 * re-read admits (#2500), with the allowance limb left to the cap; its test
 * pins them to the script's.
 */
const FREE_SLOT_ARGS = ["--json", "--launch", "--skip-allowance"];

/**
 * The `allowance.js` arguments dispatch-sessions.sh's cap call passes, for
 * `members` on `seat`; its test pins the flags to the script's.
 * @param {string} seat
 * @param {number} members
 * @param {{week: number, session: number}} ceilings
 */
const capArgs = (seat, members, ceilings) => [
	"--json",
	"--config-dir",
	seat,
	"--cap",
	String(members),
	"--session-threshold",
	String(ceilings.session),
	"--week-threshold",
	String(ceilings.week),
];

/**
 * The cap's launch count from `allowance.js --json --cap`'s output, or why
 * there is none: the dispatcher refuses on both. A launch that is the floor's
 * member alone reads 0 (#2425): each tick would otherwise launch one more
 * past the headroom. `fault` marks a cap the call could not size, where the
 * seat's reading itself was trustworthy (#2937).
 * @param {string} stdout
 * @returns {{fits: number} | {fits: null, why: string, fault: boolean}}
 */
function parseCapFits(stdout) {
	let payload;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { fits: null, why: "allowance.js printed no JSON", fault: true };
	}
	const cap = payload?.cap;
	if (!cap)
		return {
			fits: null,
			why: "no trustworthy allowance reading",
			fault: false,
		};
	if (cap.error) return { fits: null, why: String(cap.error), fault: true };
	if (!Number.isInteger(cap.launch))
		return { fits: null, why: `cap.launch is ${cap.launch}`, fault: true };
	return { fits: cap.floored === true ? 0 : cap.launch };
}

/**
 * The launches whose session has left the listing or ended, and are not
 * judged yet. Nothing is judged off an unread listing, and a launch with no
 * job id is never judged: nothing ties it to a listed session. The listing
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
			now - Math.max(l.launchedAt, l.relaunchedAt ?? 0) >= LISTING_GRACE_MS &&
			!listed.has(l.jobId) &&
			!isHeld(l),
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
 * How many launches the loop made on `day`, machine-local.
 * @param {Pick<LoopState, "launchDay">} state
 * @param {string} day
 */
const launchesOnDay = ({ launchDay }, day) =>
	launchDay?.day === day ? launchDay.count : 0;

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
 * A finished launch's progress: the acts of its session and each it ran
 * under before a resume moved it to a copy (#2969), across `roots`' stores,
 * counted per kind (#2312). UNREAD where its session id was never captured,
 * its past sessions' acts then unsummed, or where no act read and some store
 * would not, which is not "did nothing".
 * The reader is passed in so this module stays free of store reads.
 * @param {LoopLaunch} l
 * @param {string[]} roots
 * @param {(sessionId: string, roots: string[]) =>
 *   {acts: string[], unreadable: string[]}} readActsBy lib/arbiter-ledger.js's
 * @returns {{acts: Record<string, number>|typeof UNREAD}}
 */
function actsOf(l, roots, readActsBy) {
	if (!l.sessionId) return { acts: UNREAD };
	const ids = new Set([...(l.pastSessionIds ?? []), l.sessionId]);
	const reads = [...ids].map((id) => readActsBy(id, roots));
	const acts = reads.flatMap((r) => r.acts);
	if (acts.length === 0 && reads.some((r) => r.unreadable.length > 0))
		return { acts: UNREAD };
	/** @type {Record<string, number>} */
	const counts = {};
	for (const act of acts) {
		const { kind } = parseAct(act);
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return { acts: counts };
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

/** @typedef {{seat: string, outcome: string}} Probe */

/**
 * A tick's frontier read: the merged rows and how long the read took.
 * @typedef {{rows: number, ms: number}} FrontierRead
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
 * @param {{freeSlots: number|null, probes: Probe[], read: FrontierRead|null,
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
 * The state's stop record for a stop decision, else null.
 * @param {import("./refill-decide.js").Decision} d
 * @param {number} at
 */
const stoppedOf = (d, at) =>
	"stop" in d ? { at, reason: d.stop, detail: d.detail } : null;

/**
 * The record of `launched`'s first overflow launch after a plan-seat launch,
 * logged, or null. The credential scan runs only then; its failure is logged,
 * since the launches it follows are not yet in the state.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {{judged: LoopLaunch[], launched: LoopLaunch[]}} launches
 * @param {{readOmittedDirs: () => string[], log: (line: string) => void}} io
 * @returns {import("./overflow-notice.js").OverflowStart|null}
 */
function recordOverflowStart(input, { judged, launched }, io) {
	const overflowDirs = new Set((input.overflow ?? []).map((o) => o.seat));
	const first = firstOverflowLaunch(judged, launched, overflowDirs);
	if (first === null) return null;
	/** @type {string[]} */
	let omitted = [];
	try {
		omitted = io.readOmittedDirs();
	} catch (err) {
		io.log(`credentials scan failed: ${buildErrorText(err)}`);
	}
	const start = {
		at: first.launchedAt,
		seat: first.seat,
		planSeats: input.seats.map(planSeatBasisOf),
		omitted,
	};
	io.log(
		`first overflow launch on ${buildSeatName(first.seat)}: ${buildOverflowStartLines(start).join("; ")}`,
	);
	return start;
}

/**
 * @typedef {(resumes: import("./refill-decide.js").HeldResume[],
 *   launches: LoopLaunch[], isStopped: () => boolean) =>
 *   {launches: LoopLaunch[], started: number, waiting: boolean}} ResumeHeld
 */

/**
 * The decision's resumes made, ahead of its launches; none on a stop.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {LoopLaunch[]} launches
 * @param {{readControl: () => ControlRead, resumeHeld: ResumeHeld}} io
 */
const resumeDecided = (decision, launches, io) =>
	"stop" in decision
		? { launches, started: 0, waiting: false }
		: io.resumeHeld(decision.resumes, launches, () =>
				isLaunchBarred(io.readControl().control),
			);

/** @param {import("./refill-decide.js").TickInput} input */
const dueCount = (input) => input.resumable?.length ?? 0;

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
 * A tick from its decision on: dispatch its launches while the control asks
 * for no stop or pause, write the state, then take the morning review's step, which
 * starts its child detached and returns at once (reviewStep).
 * A stop that landed during the dispatches or the review is logged and
 * recorded as `stop: explicit`, or `control-damaged` where the re-read found
 * the control damaged, so the loop ends at this tick's end, which
 * `stop` promises (#2126).
 * @param {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision, state: LoopState,
 *   judged: LoopLaunch[], probes: Probe[], read: FrontierRead|null,
 *   probeBrokenRoots: string[],
 *   away?: import("./refill-decide.js").AwaySwitch}} tick
 * @param {{readControl: () => ControlRead,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[]) => BatchOutcome,
 *   resumeHeld: ResumeHeld,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   writeState: (state: LoopState) => void,
 *   readOmittedDirs: () => string[],
 *   log: (line: string) => void, now: () => number}} io
 * @returns {{decision: import("./refill-decide.js").Decision,
 *   launched: number}} the late stop where one landed, else the tick's
 *   decision, and how many sessions the tick started
 */
function settleTick(
	{ input, decision, state, judged, probes, read, probeBrokenRoots, away },
	io,
) {
	const {
		launches: afterResumes,
		started,
		waiting,
	} = resumeDecided(decision, judged, io);
	const outcome = launchUntilBarred(
		buildLaunchBatches(decision, waiting),
		() => io.readControl().control,
		io.launchBatch,
	);
	const summary = buildTickLine(decision, outcome, {
		freeSlots: input.paused ? null : input.freeSlots,
		probes,
		read,
		resumesDue: dueCount(input),
		resumesStarted: started,
	});
	io.log(summary);
	const overflowStart = recordOverflowStart(
		input,
		{ judged: afterResumes, launched: outcome.launched },
		io,
	);
	const today = localDate(new Date(input.now));
	const next = {
		launches: keptLaunches([...afterResumes, ...outcome.launched]),
		lastTick: {
			at: input.now,
			summary,
			...("stop" in decision
				? {}
				: { skipped: decision.skipped, idle: decision.idle }),
		},
		stopped: stoppedOf(decision, input.now) ?? state.stopped,
		held:
			"stop" in decision || read === null
				? state.held
				: holdsOf(decision.held, state.held, input.now, input.mode),
		reviewRunOn: state.reviewRunOn,
		launchCount: {
			from: input.noProgressFrom,
			count:
				launchesSince(state, input.noProgressFrom) + outcome.launched.length,
		},
		handedOff: nextHandedOff(state, away, judged, input.now),
		launchDay: {
			day: today,
			count: launchesOnDay(state, today) + outcome.launched.length,
		},
		overflowStart: overflowStart ?? state.overflowStart,
		probeBrokenRoots,
	};
	io.writeState(next);
	const reviewRunOn = io.runReview(state.reviewRunOn, input.now);
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
	if (late || reviewRunOn !== state.reviewRunOn)
		io.writeState({
			...next,
			stopped: (late && stoppedOf(late, io.now())) ?? next.stopped,
			reviewRunOn,
		});
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
	controlAfterPresence,
	controlInMode,
	handedOffSince,
	withAbsentRead,
	FREE_SLOT_ARGS,
	actsOf,
	capArgs,
	parseCapFits,
	ceilingsOf,
	parseControl,
	buildFinishLine,
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
	hasExcludeShape,
	scopeRoots,
	landingRoots,
	parseProbeOutcome,
	overflowReadings,
	seatReadingOf,
	settleTick,
	readSizedSeats,
	sizeResumeSeats,
	launchesOnDay,
	launchesSince,
	parseState,
	stopNeverStarted,
	summaryOf,
};
