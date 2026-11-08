/*
 * refill-decide.js — the refill loop's decision core, in normal and away mode
 * (#2007, spec #1995; parked rows by mode, #3621): one pure function from a
 * tick's readings to the launches to make, the idle reason for making none, or
 * the stop that ends the loop, with the held sessions it resumes ahead of them.
 *
 * Caller: lib/refill-tick.js's tick (#2012)
 */

const path = require("node:path");
const { WAITING_LABEL } = require("./frontier-order.js");
const { newestMarkerListing, PARKED_LABEL } = require("./parked.js");
const { buildSeatLabel, isSameSeat, seatIdOf } = require("./refill-seats.js");
const {
	COMMAND_VALUES,
	TAKES_PREFIX,
	takesValue,
} = require("./takes-label.js");
const { presenceAt } = require("./presence.js");
const { withoutStamps } = require("./stamp-paths.js");
const { buildVerifyPrompt, unclosedLaunchOf } = require("./unclosed-launch.js");

/* Three finishes in a row with no progress pause the loop (#1920, #3859), and
 * as many launches since the last act are all that run unproven (#4200, #4223). */
const NO_PROGRESS_RUN = 3;
/* A finish whose acts could not be read, counted neither as progress nor as
 * no progress (#2312). */
const UNREAD = "unread";
/* Sonnet's founder check does not happen while he is away (#1920). */
const MODEL = "opus";
/* A bar reading this refuses the dispatcher's launch (#371); under it, its
 * cap sizes the launch (#2278). Residual: past the cap's thresholds the margin
 * left is the cap's projection alone, which the per-call floor of one can
 * overrun. */
const FULL = 100;
/* The idle reason of a tick that walked its frontier and launched nothing. */
const NOTHING_LAUNCHABLE = "nothing launchable";
/* The idle reason of one missing a checkout's shortlist, named over "nothing
 * launchable" even where the checkouts read held only skipped rows: the
 * unread work may have launched (#2561). */
const SHORTLIST_FAILED = "shortlist failed in";
/* The idle reasons of a tick with no slot to launch into. */
const NO_FREE_SLOT = "no free slot";
const NO_PROGRESS_PAUSE = "no-progress";
/* The pause lib/quiet-bench.js takes; only it and `set --resume` lift it (#3852). */
const QUIET_BENCH_PAUSE = "quiet bench";
/* A seat's reading, cap size or cap fit holds it, as one reason to the reader
 * (#2525, #3859). Residual: the log and the idle alarm lose which seat and hold;
 * `status`'s `passed over` names them. */
const NO_PLAN_ROOM = "no plan has room right now";
const FIVE_HOUR_FULL = "the 5-hour bar is full on";
/* The idle reason of a tick whose seats are all spent, with a limit-held
 * launch still to act on. */
const LIMIT_HELD_WAIT =
	"every seat is spent; a limit-held session waits on one";
/* The idle reason of a tick whose seats are all spent, with a resume due. */
const RESUME_DUE_WAIT = "every seat is spent; a resume is due";
/* The idle reason of a tick whose resumes take every free slot. */
const RESUMES_TAKE_SLOTS = "resumes take every free slot";
/* The idle reason of a tick whose unproven launches fill the cap (#4223). */
const UNPROVEN_CAP = `${NO_PROGRESS_RUN} launches since the last act are running`;
/* The idle reason of a tick whose plan seats are weekly-full and whose
 * overflow keys are spent. */
const OVERFLOW_SPENT = "every plan seat is weekly-full";
/* The idle reason of a tick waiting out every plan seat's full week. */
const PLAN_RESETS = "a plan resets";
const PAUSED = "paused by";
/* A row in a checkout whose probe hold stops launches (#3860). */
const PROBE_HELD = "a probe hold stops launches into its checkout";
/* A row a running launch already holds, skipped as any other so an idle
 * tick's log can count it (#2561). */
const ALREADY_RUNNING = "already running";
/* A row whose predicted write-set shares a substrate file with a held file or
 * a launch this tick, deferred behind the clean rows (#4355). */
const CLASH_PREFIX = "clashes on ";
/** @param {Skip} s */
const isClashSkip = (s) => s.why.startsWith(CLASH_PREFIX);

/**
 * `parkedAt` is when `parked` went on, null where the label is off or its
 * start would not read. `writeSet` is its shortlist's predicted write-set;
 * `heldBy` the substrate files of it a running session holds (#4355).
 * @typedef {import("./frontier-order.js").FrontierRow & {root: string,
 *   takes: string[], labels: string[], parkedAt?: string|null,
 *   writeSet?: string[], heldBy?: HeldBy}} MergedRow
 */
/** @typedef {{paths: string[], session: string, sessionId: string|null}} HeldBy
 *   substrate files of a row's write-set a running session holds, and that
 *   session's name and id */
/** @typedef {import("./retro-bundles.js").RetroLaunch & {root: string}} MergedBundle */

/**
 * One seat's bars, in percent; null where the reading is not fresh. A bar is
 * full where it reads 100% fresh, or cached with its reset still ahead
 * (lib/seat-reading.js's seatReadingOf), so a fresh `week` of 100 is always
 * `weekFull`.
 * @typedef {object} SeatReading
 * @property {string} seat config dir
 * @property {number|null} week
 * @property {number|null} session the 5-hour bar
 * @property {boolean} weekFull
 * @property {boolean} sessionFull
 * @property {string|null} sessionResets the 5-hour bar's reset, as read
 * @property {number|null} weekResets the weekly bar's reset, ms, from the
 *   same reading; null where it is unread, will not parse or has passed
 * @property {number} readAt ms, when the older of its bars was read
 * @property {{percent: number|null, atMs: number|null, rolled?: boolean}} weekRead
 *   the weekly bar as read, whatever its trust, and when; `rolled` where its reset
 *   has since passed, `percent` then being 0; for reporting alone
 */

/**
 * @typedef {SeatReading & {fits: number|null}} SizedSeat `fits` is how many
 *   the dispatcher's allowance cap would launch on this seat now; null where
 *   it was not sized
 */

/**
 * An overflow seat (lib/refill-seats.js), billed to a plan's API credits
 * through its own key (#2570). `fits` is how many sessions its budget gate
 * fits on the key now, null where it was not read, with `why`; `spentUntil`
 * the date its cycle ends where the key is spent for it, else null.
 * @typedef {object} OverflowReading
 * @property {string|null} seat config dir; null on the row standing in for a
 *   seat file that refuses
 * @property {string} [keyVar] the seat's identity; none on that row
 * @property {number|null} fits
 * @property {number} [headroomUsd] the key's headroom where its budget read,
 *   the allowance a session moved onto it takes (#3736)
 * @property {string|null} spentUntil
 * @property {string|null} why
 */

/**
 * A loop launch. `acts` is read once it has finished.
 * @typedef {object} LaunchRecord
 * @property {string} root
 * @property {number[]} issues
 * @property {string} [prompt] what it launched on
 * @property {number} launchedAt ms
 * @property {number} [relaunchedAt] ms, when a resume last restarted its job
 * @property {string|null} [jobId]
 * @property {{resumedAt?: number}} [limitHeld] where the loop stopped it on its
 *   seat's limit, with `resumedAt` once a resume restarted it
 * @property {number|null} finishedAt ms of the tick that saw the finish, not
 *   of the finish itself, used only to order the last three finishes; null
 *   while running
 * @property {Record<string, number>|typeof UNREAD} [acts] the launched
 *   session's acts-ledger lines counted per kind (#2312), or UNREAD where its
 *   session id was never captured or its ledger would not read
 * @property {true} [gate] a gate judgement's launch (#3092)
 * @property {true} [nothingToRepeat] a resume of a session parked on an API error
 *   or a limit, which asked the founder nothing (#3949)
 * @property {number} [parkStopped] ms, when the loop stopped it for a park
 * @property {SeatReason} [reason] why its seat was picked
 */

/**
 * The picker's tokens (#3732), then a parked resume's, which goes back to its
 * own session's seat, and a moved session's (#3734), naming the seat it left.
 * @typedef {"last typed on" | "soonest reset" | "overflow"
 *   | "parked session's seat" | `moved from ${string}`} SeatReason
 */

/**
 * A seat whose limit moved a session off it, and when that limit blocked it.
 * @typedef {{seat: string, since: number}} SeatLeft
 */

/**
 * @typedef {object} TickInput
 * @property {number} now ms
 * @property {"normal"|"away"} mode
 * @property {number} noProgressFrom ms, where the no-progress count counts from
 * @property {boolean} stopRequested
 * @property {Pause} [paused] absent where the loop is not paused
 * @property {string|null} [controlDamaged] the control file and why, where it
 *   exists but is not a control
 * @property {MergedRow[]} frontier lib/frontier-order.js's merged ranking
 * @property {MergedBundle[]} retroBundles
 * @property {{root: string, issues: number[]}[]} running
 * @property {number} freeSlots admission's count
 * @property {string|null} [typedSeat] the plan seat the founder last typed
 *   on, null or absent where none is recorded (lib/presence.js's
 *   readLastTyped)
 * @property {SizedSeat[]} seats the plan seats, seat-file order or any
 *   order of it: pickSeat orders them
 * @property {OverflowReading[]} [overflow] the overflow seats, in failover
 *   order
 * @property {LaunchRecord[]} history
 * @property {number|null} lastActAt ms, the latest act any of `history`'s
 *   sessions made, null where none read (#4223)
 * @property {import("./gate-sweep.js").Judgement[]} [judgements] the gate
 *   sweep's queue, launched ahead of the ranking (#2279), behind normal
 *   mode's parked rows (#3713)
 * @property {{root: string, error: string}[]} [failedShortlists]
 * @property {ParkerReading[]} [parkers] each parked frontier row's park
 *   marker the tick found
 * @property {string[]} [limitHeldLines] each launch waiting stopped on its seat's
 *   limit, for a stop line to name (#3785): spent seats end no run while any
 *   waits, as only a running loop resumes it (#3735)
 * @property {HeldResume[]} [resumable] each session the loop stopped whose
 *   cause has cleared (#3855)
 * @property {TickHold[]} [holds] each checkout's open repo holds (#3860)
 */

/**
 * @typedef {{root: string, kind: "probe"|"park"}} TickHold
 */

/**
 * When away mode was switched on, ms, and whether a tick since has read the
 * founder absent.
 * @typedef {{since: number, absentSeen: boolean}} AwaySwitch
 */

/**
 * Who paused the loop, and when, ms; the no-progress rule also records the
 * issues that made none, and the quiet bench route why it holds.
 * @typedef {{by: string, at: number, issues?: PauseIssue[], why?: string}} Pause
 */

/** @typedef {{root: string, number: number}} PauseIssue */

/**
 * A stopped session due back: its launch's job, seat and checkout, when it was
 * stopped, and its line for a stop to name. `keyVar`, the overflow seat it ran on.
 * @typedef {{jobId: string, seat: string, keyVar?: string, root: string, at: number,
 *   line: string}} HeldResume
 */

/**
 * @typedef {object} Launch
 * @property {string} root the checkout the dispatcher runs in
 * @property {number[]} issues
 * @property {string} prompt
 * @property {"opus"} model
 * @property {string} seat
 * @property {string} [keyVar] the overflow seat it launches on
 * @property {SeatReason} reason
 * @property {true} [gate] a gate judgement's launch (#3092)
 * @property {({resume: ResumeTarget}|{afresh: string}) & {limitParks?: number}} [parkedRoute]
 *   a parked ticket's: the session that parked it to resume in place, else why
 *   `prompt` launches afresh (#3621), and its limit-cap parks in a row, for
 *   the launch's record to carry on (#3804)
 */

/**
 * @typedef {object} ParkerReading
 * @property {string} root
 * @property {number} number the parked issue
 * @property {string} sessionId the session whose marker lists it
 * @property {import("./parked.js").ParkJob|null} job the seat and job its
 *   marker names, null where it names none
 * @property {string} resumeCwd where its session resumes
 * @property {number} [limitParks] its marker's limit-cap parks in a row
 * @property {string} [parkCause] the block its marker names, where the loop
 *   stopped it on one
 */

/**
 * @typedef {{seat: string, sessionId: string, cwd: string, parkCause?: string}} ResumeTarget
 */

/** @typedef {"control-damaged" | "explicit"} StopReason */

/** @typedef {{root: string, number: number, why: string}} Skip */

/**
 * Why a tick launched nothing: `reason` one of the idle reasons above, which
 * readers match on, and `detail` the text that follows it in the log line, its
 * joining punctuation included, so buildIdleText gives back that line (#4183).
 * @typedef {{reason: string, detail: string}} Idle
 */

/**
 * @param {string} reason
 * @param {string} [detail]
 * @returns {Idle}
 */
const buildIdle = (reason, detail = "") => ({ reason, detail });

/** @param {Idle} idle */
const buildIdleText = ({ reason, detail }) => `${reason}${detail}`;

/**
 * @typedef {{stop: StopReason, detail: string}
 *   | {launches: Launch[], skipped: Skip[], idle: Idle | null,
 *   held: Skip[], resumes: HeldResume[], pause?: Pause,
 *   capHeld?: HeldResume[], planWait?: PlanWait}} Decision `held` is
 *   heldParked's; `resumes` the tick's, oldest first, made ahead of its launches;
 *   `capHeld` takeResumes's, for the tick to log; `pause` the no-progress
 *   pause for the tick to write; `planWait` set where every plan seat's full week
 *   is why nothing launches
 */

/**
 * The allowance wait: the earliest weekly reset, ms, null where none reads.
 * @typedef {{resets: number|null}} PlanWait
 */

/**
 * The launch's acts counted per kind, or null where they were not read.
 * @param {LaunchRecord} r
 */
const actsRead = (r) =>
	r.acts === undefined || r.acts === UNREAD ? null : r.acts;

/** @param {LaunchRecord} r */
const hasProgressed = (r) =>
	Object.values(actsRead(r) ?? {}).some((n) => n > 0);

/**
 * The last three read finishes since noProgressFrom, if none progressed: an
 * unread one is passed over, and so is a gate judgement with no act, since
 * judging a gate unmet ends with none (#3092), and a resume with nothing to repeat
 * that ended with no act and no new park, as its work may be done already (#3949):
 * its ticket leaves `parked`, so it comes back only by a new park, while one the
 * loop parked again, as an auth error would be, counts. A resume moves noProgressFrom, or
 * the finishes behind this pause would pause the loop again at once. Residual: a
 * judge that crashed or did nothing is passed over too, so a run of gate launches
 * alone never pauses the loop; JUDGE_EVERY_MS in lib/gate-sweep.js bounds how
 * often each issue's runs.
 * @param {TickInput} input
 */
function noProgressRun({ history, noProgressFrom }) {
	const recent = history
		.filter(
			(r) =>
				r.finishedAt !== null &&
				r.launchedAt >= noProgressFrom &&
				r.acts !== UNREAD &&
				!(
					(r.gate || (r.nothingToRepeat && r.parkStopped === undefined)) &&
					!hasProgressed(r)
				),
		)
		.sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt))
		.slice(0, NO_PROGRESS_RUN);
	return recent.length === NO_PROGRESS_RUN && !recent.some(hasProgressed)
		? recent
		: null;
}

/**
 * How many more launches and resumes may start before an act proves one
 * (#4223): NO_PROGRESS_RUN less the running launches started after
 * `lastActAt`, every one where it is null, a launch with no job yet among them
 * (so not refill-blocks' isActionable). One the loop stopped, for a park or
 * on its seat's limit and not since resumed, runs no session, and one due back
 * this tick is counted as its resume.
 * @param {Pick<TickInput, "history"|"lastActAt"> & Partial<Pick<TickInput, "resumable">>} input
 */
function unprovenRoom({ history, lastActAt, resumable = [] }) {
	const due = new Set(resumable.map((r) => r.jobId));
	const unproven = history.filter(
		(l) =>
			l.finishedAt === null &&
			l.parkStopped === undefined &&
			!(l.limitHeld && l.limitHeld.resumedAt === undefined) &&
			!(l.jobId && due.has(l.jobId)) &&
			(lastActAt === null || startedAt(l) > lastActAt),
	).length;
	return Math.max(0, NO_PROGRESS_RUN - unproven);
}

/**
 * The unproven cap's idle, naming the act it counts from.
 * @param {number|null} lastActAt
 */
const buildUnprovenIdle = (lastActAt) =>
	buildIdle(
		UNPROVEN_CAP,
		lastActAt === null
			? " (no act read)"
			: ` (last act ${new Date(lastActAt).toISOString()})`,
	);

/**
 * Whether the dispatcher would launch on a seat: both bars fresh and under
 * 100%.
 * @param {{week: number|null, session: number|null}} s
 */
const hasRoom = (s) =>
	s.week !== null && s.session !== null && s.week < FULL && s.session < FULL;

/**
 * @template {{fits: number|null}} S
 * @param {S} s
 * @returns {s is S & {fits: number}}
 */
const isFitted = (s) => s.fits !== null && s.fits > 0;

/**
 * Whether the loop launches on a seat: room on both bars and a cap sized
 * above 0.
 * @template {{week: number|null, session: number|null, fits: number|null}} S
 * @param {S} s
 * @returns {s is S & {fits: number}}
 */
const fitsLaunch = (s) => hasRoom(s) && isFitted(s);

/**
 * Whether a seat reads full: a bar at 100% or a cap sized 0.
 * @param {SizedSeat} s
 */
const readsFull = (s) => s.weekFull || s.sessionFull || s.fits === 0;

/**
 * The plan seats in the order the loop launches on them (#3732): the seat
 * the founder last typed on first, where it is one of them, then the rest
 * by soonest weekly reset, ties and unread resets in seat-file order. The
 * one order both a launch and a move walk.
 * @template {{seat: string, weekResets: number|null}} S
 * @param {S[]} seats in seat-file order
 * @param {string|null} typedSeat
 * @returns {S[]}
 */
function orderPlanSeats(seats, typedSeat) {
	/** @param {S} s */
	const key = (s) => ({
		typed: s.seat === typedSeat ? 0 : 1,
		resets: s.weekResets ?? Number.POSITIVE_INFINITY,
	});
	return seats
		.map((s, i) => ({ s, i, k: key(s) }))
		.sort(
			(a, b) => a.k.typed - b.k.typed || a.k.resets - b.k.resets || a.i - b.i,
		)
		.map(({ s }) => s);
}

/**
 * The first plan seat, in orderPlanSeats's order, with room whose cap fits a
 * launch, else, once every plan seat is weekly-full, the first overflow seat
 * whose budget fits one (#2570); else whether every seat is spent, and why
 * the tick waits where not.
 * @param {Pick<TickInput, "seats"|"overflow"|"typedSeat">} input
 * @returns {{seat: string, keyVar?: string, fits: number, reason: SeatReason}
 *   | {seat: null, fits: 0, allCut: boolean, wait: Idle|null}}
 */
function pickSeat({ seats, overflow = [], typedSeat = null }) {
	const plan = pickPlanSeat(orderPlanSeats(seats, typedSeat));
	if (plan.seat !== null)
		return {
			...plan,
			reason: plan.seat === typedSeat ? "last typed on" : "soonest reset",
		};
	if (overflow.length === 0) return plan;
	if (!plan.allCut) {
		const open = seats.filter((s) => !s.weekFull).map((s) => s.seat);
		const shut = `; no overflow launch: ${open.join(", ")} not weekly-full`;
		/* A seat not cut holds a wait of its own, so plan.wait is set. */
		return {
			...plan,
			wait: plan.wait && {
				...plan.wait,
				detail: `${plan.wait.detail}${shut}`,
			},
		};
	}
	const open = overflow.find(isFitted);
	if (open?.seat)
		return {
			...seatIdOf({ seat: open.seat, keyVar: open.keyVar }),
			fits: open.fits,
			reason: "overflow",
		};
	return {
		seat: null,
		fits: 0,
		allCut: overflow.every((o) => o.spentUntil !== null),
		wait: buildIdle(OVERFLOW_SPENT, `; overflow ${overflowHolds(overflow)}`),
	};
}

/**
 * The seat a session blocked on its seat's limit goes to (#3735): pickSeat's
 * walk over `seats` sized for one session, as it already holds its slot, with
 * its own seat passed over until a reading taken since the block shows room,
 * so an older one never sends it back into the limit. Passed over, not left
 * out: a seat full on its 5-hour bar still keeps overflow shut (#2570). Each
 * seat a limit moved it off is passed over the same way (#3734).
 * @param {Pick<TickInput, "seats"|"overflow"|"typedSeat"> &
 *   {ownSeat: string, since: number, left?: SeatLeft[]}} input `since`, ms,
 *   when it blocked
 */
function pickMoveSeat({
	seats,
	overflow,
	typedSeat,
	ownSeat,
	since,
	left = [],
}) {
	const blockedAt = new Map([
		...left.map((x) => /** @type {const} */ ([x.seat, x.since])),
		[ownSeat, since],
	]);
	return pickSeat({
		seats: seats.map((s) =>
			s.readAt <= (blockedAt.get(s.seat) ?? Number.NEGATIVE_INFINITY)
				? { ...s, fits: 0 }
				: s,
		),
		overflow,
		typedSeat,
	});
}

/** @param {OverflowReading[]} overflow */
const overflowHolds = (overflow) => overflow.map(overflowHold).join(", ");

/**
 * The first plan seat with room whose cap fits a launch, else whether every
 * plan seat is weekly-full, and why the tick waits where not. A seat full on
 * its 5-hour bar alone reopens at that bar's reset, so the tick waits through
 * it (#2606). A seat with no fresh reading, no sized cap or a cap sized 0
 * waits too: the dispatcher refuses the first two, and running sessions
 * finishing reopen the third's headroom (#2432).
 * @param {SizedSeat[]} seats in launch order
 * @returns {{seat: string, fits: number}
 *   | {seat: null, fits: 0, allCut: boolean, wait: Idle|null}}
 */
function pickPlanSeat(seats) {
	const fiveHour = [];
	let cut = 0;
	let noRoom = 0;
	for (const s of seats) {
		if (fitsLaunch(s)) return { seat: s.seat, fits: s.fits };
		const hold = seatHold(s);
		if (hold === "cut") cut += 1;
		else if (hold === "fiveHour")
			fiveHour.push(
				`${s.seat} until its 5-hour reset ${s.sessionResets ?? "(unread)"}`,
			);
		else noRoom += 1;
	}
	/* One reason, as #2362 ruled, whichever hold it is. A 5-hour wait beside it. */
	const fiveHourText = ` ${fiveHour.join(", ")}`;
	/** @type {Idle|null} */
	let wait = null;
	if (noRoom > 0)
		wait = buildIdle(
			NO_PLAN_ROOM,
			fiveHour.length > 0 ? `; ${FIVE_HOUR_FULL}${fiveHourText}` : "",
		);
	else if (fiveHour.length > 0) wait = buildIdle(FIVE_HOUR_FULL, fiveHourText);
	return { seat: null, fits: 0, allCut: cut === seats.length, wait };
}

/**
 * @param {OverflowReading} o
 */
const overflowHold = (o) => `${buildSeatLabel(o)} ${buildOverflowHoldText(o)}`;

/**
 * @param {OverflowReading} o
 */
function buildOverflowHoldText(o) {
	if (o.spentUntil !== null) return `exhausted until ${o.spentUntil}`;
	if (o.fits === 0) return "budget held by running sessions";
	return `budget unread (${o.why ?? "no reason given"})`;
}

/** @typedef {"cut" | "fiveHour" | "unread" | "unsized" | "capped"} SeatHold */

/**
 * What holds a seat the loop cannot launch on: a full week, which alone makes
 * the allowance wait, else a full 5-hour bar, else an unread bar, else its cap
 * unsized or sized 0.
 * @param {SizedSeat} s
 * @returns {SeatHold}
 */
function seatHold(s) {
	if (s.weekFull) return "cut";
	if (s.sessionFull) return "fiveHour";
	if (s.week === null || s.session === null) return "unread";
	return s.fits === null ? "unsized" : "capped";
}

/**
 * The checkouts launches are stopped from: those with a `probe` hold, the only
 * kind that stops any (#3860).
 * @param {TickHold[]} [holds]
 */
const buildProbeHeldRoots = (holds = []) =>
	new Set(holds.filter((h) => h.kind === "probe").map((h) => h.root));

/** @param {{labels: string[]}} row */
const isParked = (row) => row.labels.includes(PARKED_LABEL);

/**
 * Whether a loop in `mode` routes parked rows: normal mode relaunches them,
 * away mode leaves their questions to the founder's return (#2355, #3621).
 * @param {"normal"|"away"} [mode]
 */
const isParkRoutingMode = (mode) => mode === "normal";

/**
 * Why the loop's launch filter skips a row, or null where it launches it;
 * also the idle alarm's printed reason (lib/idle-efforts.js).
 * @param {{labels: string[], takes: string[]}} row
 * @param {"normal"|"away"} [mode]
 */
function buildSkipReason(row, mode) {
	if (!isParkRoutingMode(mode) && isParked(row)) return "parked";
	if (row.labels.includes(WAITING_LABEL)) return WAITING_LABEL;
	const [kind, ...more] = row.takes;
	if (kind === undefined || more.length > 0)
		return `${TAKES_PREFIX}${row.takes.join("+") || "none"}`;
	if (!COMMAND_VALUES.includes(kind)) return `${TAKES_PREFIX}${kind}`;
	return null;
}

/**
 * The prompt a lone row launches on: its `takes:` command, checking first
 * whether the work landed where an `/implement` launch committed and did not
 * close (#3782).
 * @param {MergedRow} row
 * @param {LaunchRecord[]} history
 */
const buildRowPrompt = (row, history) =>
	row.takes[0] === takesValue("implement") &&
	unclosedLaunchOf(history, row.root, row.number)
		? buildVerifyPrompt(row.number)
		: `/${row.takes[0]} ${row.number}`;

/**
 * What one ranked row launches, its whole retro bundle where it sits in one,
 * or why it is skipped.
 * @param {MergedRow} row
 * @param {Pick<TickInput, "retroBundles"|"mode"|"history">} input
 * @param {(n: number) => boolean} isTaken
 * @returns {{issues: number[], prompt: string} | {why: string}}
 */
function rowLaunch(row, { retroBundles, mode, history }, isTaken) {
	const why = buildSkipReason(row, mode);
	if (why) return { why };
	const bundle = retroBundles.find(
		(b) => b.root === row.root && b.issues.includes(row.number),
	);
	const issues = bundle ? bundle.issues : [row.number];
	const busy = issues.find(isTaken);
	if (busy !== undefined)
		return { why: `its retro bundle's #${busy} is running` };
	return {
		issues,
		prompt: bundle ? bundle.prompt : buildRowPrompt(row, history),
	};
}

/**
 * rowLaunch, with a parked row routed by routeParked, a hold as a skip.
 * @param {MergedRow} row
 * @param {Pick<TickInput, "retroBundles"|"mode"|"seats"|"parkers"|"history">} input
 * @param {(n: number) => boolean} isTaken
 * @returns {{why: string} | {issues: number[], prompt: string,
 *   parkedRoute?: Launch["parkedRoute"]}}
 */
function routedLaunch(
	row,
	{ retroBundles, mode, seats, parkers = [], history },
	isTaken,
) {
	const next = rowLaunch(row, { retroBundles, mode, history }, isTaken);
	if ("why" in next || !isParked(row)) return next;
	const parked = routeParkedRow(row, parkers, seats);
	return "hold" in parked
		? { why: parked.hold }
		: { ...next, parkedRoute: parked };
}

/* What a `stop` command's record says, as the loop decides it and as `stop`'s own
 * control field reads before a tick has. */
const EXPLICIT_STOP_DETAIL = "stop was requested";

/**
 * The stop a damaged control or a `stop` command asks for, or null.
 * @param {TickInput} input
 * @returns {Extract<Decision, {stop: StopReason}> | null}
 */
function requestedStopOf(input) {
	if (input.controlDamaged)
		return { stop: "control-damaged", detail: input.controlDamaged };
	if (input.stopRequested)
		return { stop: "explicit", detail: EXPLICIT_STOP_DETAIL };
	return null;
}

/* A limit-cap park has spent block-act.js's RESUME_CAP of resumes or its hold
 * bound, whose comments say which limit each outlasts, so a second in a row with
 * no model reply means a limit no relaunch has outlasted. Untraced (#3804,
 * delegated). */
const LIMIT_PARK_CAP = 2;

/**
 * What ends a ticket's relaunches, for the park's comment and the hold's why,
 * which the idle alarm prints.
 * @param {number} limitParks
 */
const buildLimitCapText = (limitParks) =>
	`${limitParks} limit-cap parks in a row with no model reply; it stays parked until you type in its session or take the label off`;

/**
 * Whether a ticket's limit-cap parks in a row have ended its relaunches.
 * @param {number|undefined} limitParks
 * @returns {limitParks is number} false covers a count under the cap too
 */
const isAtLimitCap = (limitParks) =>
	limitParks !== undefined && limitParks >= LIMIT_PARK_CAP;

/**
 * The hold's why for a row at LIMIT_PARK_CAP, else null.
 * @param {number|undefined} limitParks
 */
const buildLimitCapHoldWhy = (limitParks) =>
	isAtLimitCap(limitParks) ? `parked: ${buildLimitCapText(limitParks)}` : null;

/**
 * How a parked row's session goes back, from the tick's reading of its park
 * marker: resumed in place (#3621); held, a skip with why, where that
 * session's seat reads full, a bar at 100% or a cap sized 0 (#3669); else
 * afresh on its `takes:` command, with why. A seat with an unread bar
 * resumes: the loop refreshes no seat behind the first with room, so a hold
 * there would never end. A weekly-full seat holds its tickets until its
 * week resets, up to 7 days; the idle alarm counts one held past 2 days
 * (#3680). A seat outside `seats` goes afresh: the loop launches on no such
 * seat, with no bar or cap to hold a resume to, and an overflow seat's key
 * bars a resume (lib/launch-auth.js) (#3773).
 * @param {ParkerReading} parker
 * @param {SizedSeat[]} seats this tick's
 * @returns {{resume: ResumeTarget} | {hold: string} | {afresh: string}}
 */
function routeParkedSession(parker, seats) {
	const { job } = parker;
	if (!job)
		return { afresh: `its session ${parker.sessionId}'s marker names no job` };
	if (job.keyVar)
		return { afresh: `its session ran on overflow seat key=${job.keyVar}` };
	const seat = seats.find((s) => isSameSeat(job, s));
	if (!seat)
		return {
			afresh: `its session's seat ${job.seat} is not one the loop reads`,
		};
	if (readsFull(seat))
		return { hold: `parked: its session's seat ${seat.seat} is full` };
	return {
		resume: {
			seat: seat.seat,
			sessionId: parker.sessionId,
			cwd: parker.resumeCwd,
			...(parker.parkCause ? { parkCause: parker.parkCause } : {}),
		},
	};
}

/**
 * How a parked row launches: held at LIMIT_PARK_CAP limit-cap parks in a row,
 * as the next relaunch would burn the cap again (#3804), else as
 * routeParkedSession says, with the count carried on.
 * @param {ParkerReading|undefined} parker none where no marker lists it
 * @param {SizedSeat[]} seats this tick's
 * @returns {{hold: string, atCap?: boolean} | NonNullable<Launch["parkedRoute"]>}
 */
function routeParked(parker, seats) {
	if (!parker) return { afresh: "no session that parked it is recorded" };
	const { limitParks } = parker;
	if (limitParks === undefined) return routeParkedSession(parker, seats);
	const capHold = buildLimitCapHoldWhy(limitParks);
	if (capHold !== null) return { hold: capHold, atCap: true };
	return { ...routeParkedSession(parker, seats), limitParks };
}

/**
 * routeParked for `row`, from the parker the tick read for it.
 * @param {MergedRow} row
 * @param {ParkerReading[]} parkers
 * @param {SizedSeat[]} seats
 */
const routeParkedRow = (row, parkers, seats) =>
	routeParked(
		parkers.find((p) => p.root === row.root && p.number === row.number),
		seats,
	);

/**
 * Every parked frontier row whose session's seat a tick reads full, whether or
 * not its walk reaches the row (#3680), and in either mode, so an away tick
 * can keep a hold's start (#3850). One at the limit-cap parks' cap is left
 * to the idle alarm's own read of its marker, which needs no loop (#3840).
 * @param {Pick<TickInput, "frontier"|"seats"|"parkers">} input
 * @returns {Skip[]}
 */
const heldParked = ({ frontier, seats, parkers = [] }) =>
	frontier.filter(isParked).flatMap((row) => {
		const parked = routeParkedRow(row, parkers, seats);
		return "hold" in parked && !parked.atCap
			? [{ root: row.root, number: row.number, why: parked.hold }]
			: [];
	});

/**
 * When `row` was parked, ms; an unreadable start sorts as the oldest, as in
 * pick-next.js's PARKED.
 * @param {MergedRow} row
 */
const parkedMs = (row) => Date.parse(row.parkedAt ?? "") || 0;

/**
 * The ranking split for the walk: parked rows, oldest park first, where the
 * mode routes them (#3621), then the rest in rank order.
 * @param {MergedRow[]} frontier
 * @param {"normal"|"away"} mode
 */
function splitParked(frontier, mode) {
	if (!isParkRoutingMode(mode)) return { parked: [], rest: frontier };
	const parked = frontier
		.filter(isParked)
		.sort((a, b) => parkedMs(a) - parkedMs(b));
	return { parked, rest: frontier.filter((r) => !isParked(r)) };
}

/**
 * The log line of a resume left for a later tick.
 * @param {string} line the resume's own, HeldResume's
 * @param {string} why
 */
const buildResumeWaitLine = (line, why) =>
	`not resuming ${line}, for a later tick: ${why}`;

/**
 * `seats` with one launch's or resume's fit spent on `seat`, where its cap is
 * sized.
 * @param {SizedSeat[]} seats
 * @param {string} seat
 * @returns {SizedSeat[]}
 */
const spendSeatFit = (seats, seat) =>
	seats.map((s) =>
		s.seat === seat && s.fits !== null ? { ...s, fits: s.fits - 1 } : s,
	);

/**
 * The resumes this tick starts, oldest first, up to `slots`, and `seats` with
 * a fit spent on each one's seat (#3895). One whose seat has no fit left waits
 * for a later tick, in `capHeld` (#3911). Past the last slot the walk stops, the
 * slots being why the rest wait: a seat is sized for the slots alone, so one that
 * filled them reads 0 whatever room it has. Only the cap holds it, not a full bar
 * as a parked row: it was running on that seat, and a limit it meets there moves
 * it (#3735). A seat outside `seats` or unsized has no cap to charge, nor has an
 * overflow seat's session, on the dir a plan seat's cap is sized for or not.
 * @param {TickInput} input
 * @param {number} slots
 */
function takeResumes({ resumable = [], holds, seats }, slots) {
	const probeHeldRoots = buildProbeHeldRoots(holds);
	/** @type {HeldResume[]} */
	const resumes = [];
	/** @type {HeldResume[]} */
	const capHeld = [];
	let seatsLeft = seats;
	for (const r of resumable.toSorted((a, b) => a.at - b.at)) {
		if (resumes.length >= slots) break;
		if (probeHeldRoots.has(r.root)) continue;
		const planSeat = seatsLeft.find((s) => isSameSeat(r, s));
		if (planSeat?.fits === 0) {
			capHeld.push(r);
			continue;
		}
		resumes.push(r);
		if (planSeat) seatsLeft = spendSeatFit(seatsLeft, planSeat.seat);
	}
	return { resumes, capHeld, seatsLeft };
}

/**
 * Walk the routed parked rows, then the gate judgements, then the rest of
 * the ranking, launching up to `slots`. A parked row goes first, its
 * question already waiting on the founder (spec #3623, #3713); one with a
 * judgement queued walks behind that judgement, which a launch of its issue
 * would drop from the queue. A judgement goes ahead of the ranking: its
 * issue is held out of every ranking until one runs. A retro-bundle member
 * launches its whole bundle, at its best-ranked member's place. A row whose
 * substrate write-set meets a held file or a launch this tick waits behind
 * every clean row, a parked one included, then fills what slots they leave
 * (#4355); a parked row's own session holding its files is no clash, as it
 * resumes onto them. Residual:
 * enough resumable parked rows to fill every slot hold the judgements back a
 * tick.
 * @param {TickInput} input
 * @param {{seat: string, keyVar?: string, reason: SeatReason}} on
 * @param {number} slots
 */
function fill(
	{
		frontier,
		retroBundles,
		running,
		judgements = [],
		mode,
		seats,
		parkers,
		history,
		holds,
	},
	{ seat, keyVar, reason },
	slots,
) {
	/** @type {Launch[]} */
	const launches = [];
	/** @type {Skip[]} */
	const skipped = [];
	/** @param {string} root @param {number} n */
	const key = (root, n) => `${root}#${n}`;
	const taken = new Set(
		running.flatMap((r) => r.issues.map((n) => key(r.root, n))),
	);
	const probeHeldRoots = buildProbeHeldRoots(holds);
	/** Why `number` in `root` launches nothing whatever its row reads, or null.
	 * @param {string} root @param {number} number */
	const buildHeldWhy = (root, number) => {
		if (probeHeldRoots.has(root)) return PROBE_HELD;
		return taken.has(key(root, number)) ? ALREADY_RUNNING : null;
	};
	/* A resume is held to its own seat's cap, which the pick seat's fits does
	 * not bound where it is another seat (#3872). */
	let seatsLeft = seats;
	/**
	 * @param {string} root @param {number[]} issues @param {string} prompt
	 * @param {{gate?: boolean, parkedRoute?: Launch["parkedRoute"]}} [kind]
	 */
	const launch = (root, issues, prompt, { gate, parkedRoute } = {}) => {
		for (const n of issues) taken.add(key(root, n));
		launches.push({
			root,
			issues,
			prompt,
			model: MODEL,
			...seatIdOf({ seat, keyVar }),
			reason,
			...(gate ? { gate: /** @type {const} */ (true) } : {}),
			...(parkedRoute ? { parkedRoute } : {}),
		});
	};
	/** @param {MergedRow} row */
	const nextOf = (row) => {
		const why = buildHeldWhy(row.root, row.number);
		if (why !== null) return { why };
		return routedLaunch(
			row,
			{ retroBundles, mode, seats: seatsLeft, parkers, history },
			(n) => taken.has(key(row.root, n)),
		);
	};
	/** @type {Map<string, number>} root and path -> the issue launched this
	 * tick that writes it */
	const writtenBy = new Map();
	/** @param {MergedRow} row */
	const substrateOf = (row) => withoutStamps(row.writeSet ?? []);
	/** @param {string} root @param {string} p */
	const pathKey = (root, p) => `${root}\0${p}`;
	/** Why `row`, routed as `next`, would clash with a held file or a launch
	 * this tick, or null.
	 * @param {MergedRow} row
	 * @param {Exclude<ReturnType<typeof nextOf>, {why: string}>} next */
	const buildClashWhy = (row, next) => {
		const resumer =
			next.parkedRoute && "resume" in next.parkedRoute
				? next.parkedRoute.resume.sessionId
				: null;
		const by = row.heldBy;
		const [held] = by && by.sessionId !== resumer ? by.paths : [];
		if (held !== undefined)
			return `${CLASH_PREFIX}${held} held by ${by?.session}`;
		for (const p of substrateOf(row)) {
			const partner = writtenBy.get(pathKey(row.root, p));
			if (partner !== undefined)
				return `${CLASH_PREFIX}${p} with #${partner} launched this tick`;
		}
		return null;
	};
	/** @type {{row: MergedRow, why: string}[]} rank order */
	const clashing = [];
	/** Launch `row` as `next` routes it, its substrate paths marked written.
	 * @param {MergedRow} row
	 * @param {Exclude<ReturnType<typeof nextOf>, {why: string}>} next */
	const launchRow = (row, next) => {
		if (next.parkedRoute && "resume" in next.parkedRoute)
			seatsLeft = spendSeatFit(seatsLeft, next.parkedRoute.resume.seat);
		for (const p of substrateOf(row)) {
			const at = pathKey(row.root, p);
			if (!writtenBy.has(at)) writtenBy.set(at, row.number);
		}
		launch(row.root, next.issues, next.prompt, {
			parkedRoute: next.parkedRoute,
		});
	};
	/** @param {MergedRow} row @param {string} why */
	const skip = (row, why) =>
		skipped.push({ root: row.root, number: row.number, why });
	/** @param {MergedRow[]} rows */
	const walk = (rows) => {
		for (const row of rows) {
			if (launches.length >= slots) break;
			const next = nextOf(row);
			if ("why" in next) {
				skip(row, next.why);
				continue;
			}
			const clash = buildClashWhy(row, next);
			if (clash === null) launchRow(row, next);
			else clashing.push({ row, why: clash });
		}
	};
	const queued = new Set(judgements.map((j) => key(j.root, j.number)));
	const hasQueuedJudgement = (/** @type {MergedRow} */ r) =>
		queued.has(key(r.root, r.number));
	const { parked, rest } = splitParked(frontier, mode);
	walk(parked.filter((r) => !hasQueuedJudgement(r)));
	for (const j of judgements) {
		if (launches.length >= slots) break;
		const why = buildHeldWhy(j.root, j.number);
		if (why === null) launch(j.root, [j.number], j.prompt, { gate: true });
		else skipped.push({ root: j.root, number: j.number, why });
	}
	walk([...parked.filter(hasQueuedJudgement), ...rest]);
	/* An empty slot costs more than a predicted clash (mantahostels#588).
	 * Residual: such a row still launches onto its held file, or beside its
	 * partner, that same tick. */
	for (const { row, why } of clashing) {
		const next = launches.length < slots ? nextOf(row) : { why };
		if ("why" in next) skip(row, next.why);
		else launchRow(row, next);
	}
	return { launches, skipped };
}

/**
 * @param {Extract<Decision, {stop: StopReason}>} stop
 * @param {TickInput} input
 */
const buildStopDecision = (stop, input) => ({
	...stop,
	detail: buildStopDetail(stop.detail, input),
});

/**
 * @param {Idle} idle
 * @param {Skip[]} held
 * @param {HeldResume[]} resumes
 */
const buildIdleDecision = (idle, held, resumes) => ({
	launches: [],
	skipped: [],
	idle,
	held,
	resumes,
});

/** @param {PauseIssue} issue */
const buildPauseIssueText = ({ root, number }) =>
	`${path.basename(root)}#${number}`;

/** @param {Pause} pause */
const buildPauseIdle = ({ by, at, issues = [], why }) =>
	buildIdle(
		PAUSED,
		` ${by} at ${new Date(at).toISOString()}${
			issues.length > 0
				? `: no act from ${issues.map(buildPauseIssueText).join(", ")}`
				: ""
		}${why ? `: ${why}` : ""}`,
	);

/** @param {Pause} pause */
const buildPauseText = (pause) => buildIdleText(buildPauseIdle(pause));

/**
 * The pause three launched sessions in a row with no act call for, with their
 * issues, each once. Only `set --resume` ends it: nothing reopens by waiting.
 * @param {LaunchRecord[]} stalled
 * @param {number} at
 * @returns {Pause}
 */
function buildNoProgressPause(stalled, at) {
	const refs = new Map(
		stalled.flatMap(({ root, issues }) =>
			issues.map((number) => {
				const issue = { root, number };
				return [buildPauseIssueText(issue), issue];
			}),
		),
	);
	return { by: NO_PROGRESS_PAUSE, at, issues: [...refs.values()] };
}

/**
 * The wait every plan seat at 100% of the week makes, which the loop leaves by
 * itself on the first tick a bar has reset.
 * @param {SeatReading[]} seats
 * @returns {PlanWait}
 */
function readPlanWait(seats) {
	const resets = seats.flatMap((s) => s.weekResets ?? []);
	return { resets: resets.length > 0 ? Math.min(...resets) : null };
}

/** @param {PlanWait} wait */
const buildPlanWaitIdle = ({ resets }) =>
	buildIdle(
		PLAN_RESETS,
		resets === null
			? ", its time unread"
			: ` at ${new Date(resets).toISOString()}`,
	);

/** @param {PlanWait} wait */
const buildPlanWaitText = (wait) => buildIdleText(buildPlanWaitIdle(wait));

/**
 * The idle of a tick with no seat to launch on, the allowance wait leading where
 * every plan seat's week is full, as a session left on a limit or an overflow
 * key's held budget does not change what the loop waits for.
 * @param {TickInput} input
 * @param {Idle|null} wait null where every plan seat's week is full
 * @param {Skip[]} held
 * @param {HeldResume[]} resumes
 */
function buildNoSeatIdle(input, wait, held, resumes) {
	if (wait && !input.seats.every((s) => s.weekFull))
		return buildIdleDecision(wait, held, resumes);
	const planWait = readPlanWait(input.seats);
	const idle = buildPlanWaitIdle(planWait);
	return {
		...buildIdleDecision(
			wait
				? { ...idle, detail: `${idle.detail}; ${buildIdleText(wait)}` }
				: idle,
			held,
			resumes,
		),
		planWait,
	};
}

/** @param {Pause} pause */
const buildPausedWaitText = (pause) =>
	`${buildPauseText(pause)}; launches nothing until ${
		pause.by === QUIET_BENCH_PAUSE
			? "the bench ends or its drain limit passes, or `set --resume`"
			: "`set --resume`"
	}`;

/* Idle reasons that stop no row in particular: the next slot goes to the top of
 * rank, and a failed shortlist may be another tracker's. */
const QUEUE_MOVING_WAITS = [
	NO_FREE_SLOT,
	RESUMES_TAKE_SLOTS,
	UNPROVEN_CAP,
	NOTHING_LAUNCHABLE,
];

/**
 * The reason a tick's idle gives for no row launching whatever its rank, or null
 * where rank still decides. Any reason this does not know counts, so a new stop
 * cannot read as rank on the idle alarm (#3920).
 * @param {Idle|null} idle
 * @returns {string|null}
 */
const buildLoopWait = (idle) =>
	idle === null ||
	QUEUE_MOVING_WAITS.includes(idle.reason) ||
	idle.reason === SHORTLIST_FAILED
		? null
		: buildIdleText(idle);

/**
 * A stop's detail with what it leaves for the next start to act on.
 * @param {string} detail
 * @param {TickInput} input
 */
function buildStopDetail(detail, { limitHeldLines = [], resumable = [] }) {
	const left = [
		...(limitHeldLines.length > 0
			? [
					`left on a seat's limit, acted on only by the next start: ${limitHeldLines.join("; ")}`,
				]
			: []),
		...(resumable.length > 0
			? [
					`left with a resume due, acted on only by the next start: ${resumable.map((r) => r.line).join("; ")}`,
				]
			: []),
	];
	return [detail, ...left].join("; ");
}

/**
 * What this tick's read of the founder does to away mode (#2522): "return" at the
 * first present read after an absent one since the switch, so a prompt inside
 * the presence window the switch was made in does not undo it; "absent" at the
 * first absent read since it; otherwise null. The switch counts as presence,
 * since the panel click that makes it records no typed prompt (#4184), so any
 * switch reads present for one window, whoever made it.
 * @param {{mode: "normal"|"away", away?: AwaySwitch}} control
 * @param {number|null} lastPromptAt ms
 * @param {number} now ms
 * @returns {"return"|"absent"|null}
 */
function awayChangeOf({ mode, away }, lastPromptAt, now) {
	if (mode !== "away") return null;
	const absentSeen = away?.absentSeen === true;
	const lastSeen =
		away === undefined
			? lastPromptAt
			: Math.max(lastPromptAt ?? away.since, away.since);
	if (presenceAt(lastSeen, new Date(now)) === "present")
		return absentSeen ? "return" : null;
	return absentSeen ? null : "absent";
}

/**
 * A requested stop outranks a pause, so `stop` still ends a paused loop; a pause
 * outranks every other reason, as the reads they rest on are barred (#3856).
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideTick(input) {
	const requested = requestedStopOf(input);
	if (requested) return buildStopDecision(requested, input);
	if (input.paused)
		return buildIdleDecision(buildPauseIdle(input.paused), [], []);
	return decideUnpaused(input);
}

/**
 * The decision once the tick's resumes are taken: their launches, or why none.
 * `spent`, the idle where the resumes take every slot of `free`.
 * @param {TickInput} input
 * @param {{free: number, spent: Idle, held: Skip[], resumes: HeldResume[],
 *   seatsLeft: SizedSeat[]}} taken
 * @returns {Exclude<Decision, {stop: StopReason}>}
 */
function decideLaunches(input, { free, spent, held, resumes, seatsLeft }) {
	const launchSlots = free - resumes.length;
	if (launchSlots === 0) return buildIdleDecision(spent, held, resumes);
	const chargedInput = { ...input, seats: seatsLeft };
	const launchPick = pickSeat(chargedInput);
	if (launchPick.seat === null)
		return buildNoSeatIdle(
			input,
			launchPick.wait ??
				buildIdle(
					input.limitHeldLines?.length ? LIMIT_HELD_WAIT : RESUME_DUE_WAIT,
				),
			held,
			resumes,
		);
	/* The cap's fits, so a tick asks no dispatcher call for a member the cap
	 * would drop: each call launches at least one under 100%. */
	const out = fill(
		chargedInput,
		launchPick,
		Math.min(launchPick.fits, launchSlots),
	);
	if (out.launches.length > 0) return { ...out, idle: null, held, resumes };
	const failed = input.failedShortlists ?? [];
	return {
		...out,
		idle:
			failed.length > 0
				? buildIdle(
						SHORTLIST_FAILED,
						` ${failed
							.map((f) => `${path.basename(f.root)}: ${f.error}`)
							.join(`; ${SHORTLIST_FAILED} `)}`,
					)
				: buildIdle(NOTHING_LAUNCHABLE),
		held,
		resumes,
	};
}

/**
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideUnpaused(input) {
	const stalled = noProgressRun(input);
	if (stalled) {
		const pause = buildNoProgressPause(stalled, input.now);
		return { ...buildIdleDecision(buildPauseIdle(pause), [], []), pause };
	}
	const pick = pickSeat(input);
	/* A session left on a seat's limit or with a resume due has acts still to
	 * come, so the tick carries on to them. */
	if (
		pick.seat === null &&
		pick.allCut &&
		!input.limitHeldLines?.length &&
		!input.resumable?.length
	)
		return buildNoSeatIdle(input, null, heldParked(input), []);
	/* Ahead of the seat's wait: with no slot free the loop refreshes no seat,
	 * so an aged cache reads unread and is not why the tick waits (#2362). */
	const held = heldParked(input);
	if (input.freeSlots === 0)
		return buildIdleDecision(buildIdle(NO_FREE_SLOT), held, []);
	const room = unprovenRoom(input);
	const capIdle = buildUnprovenIdle(input.lastActAt);
	if (room === 0) return buildIdleDecision(capIdle, held, []);
	const free = Math.min(input.freeSlots, room);
	const spent =
		room < input.freeSlots ? capIdle : buildIdle(RESUMES_TAKE_SLOTS);
	const { resumes, capHeld, seatsLeft } = takeResumes(input, free);
	return {
		...decideLaunches(input, { free, spent, held, resumes, seatsLeft }),
		capHeld,
	};
}

/** When `l` last started its job, from which it has the listing's grace: its
 * launch, or a resume or move since.
 * @param {{launchedAt: number, relaunchedAt?: number}} l */
const startedAt = (l) => Math.max(l.launchedAt, l.relaunchedAt ?? 0);

/**
 * Each parked row's park marker, the newest written where several list it,
 * with the seat and job it names and the directory its session resumes in,
 * its marker's, else the checkout holding the marker (#3773). Each checkout's
 * markers are read once.
 * @param {MergedRow[]} frontier
 * @param {(root: string) => import("./parked.js").ParkMarkerRead[]} readMarkers
 * @returns {ParkerReading[]}
 */
function readParkers(frontier, readMarkers) {
	/** @type {Map<string, import("./parked.js").ParkMarkerRead[]>} */
	const byRoot = new Map();
	const markersIn = (/** @type {string} */ root) => {
		const read = byRoot.get(root) ?? readMarkers(root);
		byRoot.set(root, read);
		return read;
	};
	return frontier.flatMap((row) => {
		if (!isParked(row)) return [];
		const marker = newestMarkerListing(markersIn(row.root), row.number);
		if (!marker) return [];
		const { job, sessionId, limitParks, cause } = marker;
		return [
			{
				root: row.root,
				number: row.number,
				sessionId,
				job,
				resumeCwd: job?.cwd ?? row.root,
				...(limitParks === undefined ? {} : { limitParks }),
				...(cause === undefined ? {} : { parkCause: cause }),
			},
		];
	});
}

module.exports = {
	readParkers,
	startedAt,
	EXPLICIT_STOP_DETAIL,
	PROBE_HELD,
	buildProbeHeldRoots,
	buildOverflowHoldText,
	buildResumeWaitLine,
	buildPauseIssueText,
	buildPauseText,
	buildPausedWaitText,
	buildPlanWaitText,
	buildLoopWait,
	buildIdleText,
	FIVE_HOUR_FULL,
	LIMIT_HELD_WAIT,
	NO_FREE_SLOT,
	NO_PLAN_ROOM,
	NO_PROGRESS_PAUSE,
	PAUSED,
	QUIET_BENCH_PAUSE,
	RESUME_DUE_WAIT,
	RESUMES_TAKE_SLOTS,
	SHORTLIST_FAILED,
	UNPROVEN_CAP,
	unprovenRoom,
	seatHold,
	FULL,
	buildLimitCapHoldWhy,
	isAtLimitCap,
	NOTHING_LAUNCHABLE,
	UNREAD,
	actsRead,
	awayChangeOf,
	buildLimitCapText,
	buildSkipReason,
	CLASH_PREFIX,
	decideTick,
	isClashSkip,
	fitsLaunch,
	hasRoom,
	isParked,
	MODEL,
	orderPlanSeats,
	pickMoveSeat,
	pickSeat,
	isParkRoutingMode,
};
