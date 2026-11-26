const path = require("node:path");
const { LAST_RESUME_OFFSET_MS } = require("./block-act.js");
const { WAITING_LABEL } = require("./frontier-order.js");
const { buildAgeText } = require("./hold-age.js");
const { newestMarkerListing, PARKED_LABEL } = require("./parked.js");
const { buildSeatLabel, isSameSeat, seatIdOf } = require("./refill-seats.js");
const { loneCommandOf, TAKES_PREFIX } = require("./takes-label.js");
const { withoutStamps } = require("./stamp-paths.js");
const { buildRowPrompt } = require("./unclosed-launch.js");
const {
	BREAKER_OPEN,
	buildLaunchRoom,
	NO_PROGRESS_RUN,
	PROBE_HELD,
	REPO_PAUSED,
	UNPROVEN_HELD,
} = require("./launch-room.js");

/** @type {"unread"} */
const UNREAD = "unread";
const MODEL = "opus";
const FULL = 100;
const BILLING_SKIP_MS = LAST_RESUME_OFFSET_MS;
const NOTHING_LAUNCHABLE = "nothing launchable";
const SHORTLIST_FAILED = "shortlist failed in";
const NO_FREE_SLOT = "no free slot";
const NO_PROGRESS_PAUSE = "no-progress";
const NO_PLAN_ROOM = "no plan has room right now";
const FIVE_HOUR_FULL = "the 5-hour bar is full on";
const LIMIT_HELD_WAIT =
	"every seat is spent; a limit-held session waits on one";
const RESUME_DUE_WAIT = "every seat is spent; a resume is due";
const RESUMES_TAKE_SLOTS = "resumes take every free slot";
const UNPROVEN_CAP = `${NO_PROGRESS_RUN} launches since the last act are running`;
const CHECKOUTS_HELD = "every launchable checkout is held";
const OVERFLOW_SPENT = "every plan seat is weekly-full";
const PLAN_RESETS = "a plan resets";
const PAUSED = "paused by";
const LAUNCH_HELD = "launches held by a manual /pick-next";
const PROBE_HOLD_WAIT = "a probe hold stops every launch";
const ALREADY_RUNNING = "already running";
const CLASH_PREFIX = "clashes on ";
/** @param {Skip} s */
const isClashSkip = (s) => s.why.startsWith(CLASH_PREFIX);

/**
 * @typedef {import("./frontier-order.js").FrontierRow & {root: string,
 *   takes: string[], labels: string[], parkedAt?: string|null,
 *   writeSet?: string[], heldBy?: HeldBy}} MergedRow
 */
/** @typedef {{paths: string[], session: string, sessionId: string|null}} HeldBy */
/** @typedef {import("./retro-bundles.js").RetroLaunch & {root: string}} MergedBundle */

/**
 * @typedef {object} SeatReading
 * @property {string} seat
 * @property {number|null} week
 * @property {number|null} session
 * @property {boolean} weekFull
 * @property {boolean} sessionFull
 * @property {string|null} sessionResets
 * @property {number|null} weekResets
 * @property {number} readAt
 * @property {{percent: number|null, atMs: number|null, rolled?: boolean}} weekRead
 */

/** @typedef {SeatReading & {fits: number|null}} SizedSeat */

/**
 * @typedef {object} OverflowReading
 * @property {string|null} seat
 * @property {string} [keyVar]
 * @property {number|null} fits
 * @property {number} [headroomUsd]
 * @property {string|null} spentUntil
 * @property {string|null} why
 */

/**
 * @typedef {object} LaunchRecord
 * @property {string} root
 * @property {number[]} issues
 * @property {string} [prompt]
 * @property {number} launchedAt
 * @property {number} [relaunchedAt]
 * @property {number} [slotTakenAt]
 * @property {string|null} [jobId]
 * @property {{resumedAt?: number}} [limitHeld]
 * @property {number|null} finishedAt
 * @property {Record<string, number>|typeof UNREAD} [acts]
 * @property {true} [gate]
 * @property {true} [nothingToRepeat]
 * @property {number} [parkStopped]
 * @property {SeatReason} [reason]
 */

/**
 * @typedef {"last typed on" | "soonest reset" | "overflow"
 *   | "parked session's seat" | `moved from ${string}`} SeatReason
 */

/** @typedef {{seat: string, since: number}} SeatLeft */

/**
 * @typedef {object} TickInput
 * @property {number} now
 * @property {"normal"|"away"} mode
 * @property {number} noProgressFrom
 * @property {boolean} stopRequested
 * @property {Pause} [paused]
 * @property {LaunchHold} [launchHold]
 * @property {string|null} [controlDamaged]
 * @property {MergedRow[]} frontier
 * @property {MergedBundle[]} retroBundles
 * @property {{root: string, issues: number[]}[]} running
 * @property {number} freeSlots
 * @property {string|null} [typedSeat]
 * @property {SizedSeat[]} seats
 * @property {OverflowReading[]} [overflow]
 * @property {LaunchRecord[]} history
 * @property {Record<string, number>} lastActAt
 * @property {Record<string, Pause>} [repoPaused]
 * @property {Record<string, number>} [breakerRoom]
 * @property {import("./gate-sweep.js").Judgement[]} [judgements]
 * @property {{root: string, error: string}[]} [failedShortlists]
 * @property {ParkerReading[]} [parkers]
 * @property {string[]} [limitHeldLines]
 * @property {HeldResume[]} [resumable]
 * @property {TickHold[]} [holds]
 * @property {BillingStop[]} [billingStops]
 */

/** @typedef {{seat: string, since: number}} BillingStop */

/**
 * @typedef {{root: string, kind: "probe"|"park", issue: number|null,
 *   raisedAt: number|null}} TickHold
 */

/** @typedef {{since: number}} AwaySwitch */

/** @typedef {{by: string, at: number, issues?: PauseIssue[]}} Pause */

/** @typedef {{root: string, number: number}} PauseIssue */

/** @typedef {{holder: string|null, until: number}} LaunchHold */

/**
 * @param {LaunchHold|undefined} hold
 * @param {number} now
 */
const liveLaunchHold = (hold, now) =>
	hold !== undefined && hold.until > now ? hold : undefined;

/**
 * @param {{paused?: Pause, launchHold?: LaunchHold}} barring
 * @param {number} now
 */
const isLaunchBarred = ({ paused, launchHold }, now) =>
	paused !== undefined || liveLaunchHold(launchHold, now) !== undefined;

/** @param {LaunchHold} hold */
const buildLaunchHoldIdle = ({ until }) =>
	buildIdle(LAUNCH_HELD, ` until ${new Date(until).toISOString()}`);

/** @param {LaunchHold} hold */
const buildLaunchHoldText = (hold) => buildIdleText(buildLaunchHoldIdle(hold));

/**
 * @typedef {{jobId: string, seat: string, keyVar?: string, root: string, at: number,
 *   line: string, parked?: true, to?: string}} HeldResume
 */

/**
 * @typedef {object} Launch
 * @property {string} root
 * @property {number[]} issues
 * @property {string} prompt
 * @property {"opus"} model
 * @property {string} seat
 * @property {string} [keyVar]
 * @property {SeatReason} reason
 * @property {true} [gate]
 * @property {({resume: ResumeTarget}|{afresh: string}) & {limitParks?: number}} [parkedRoute]
 */

/**
 * @typedef {object} ParkerReading
 * @property {string} root
 * @property {number} number
 * @property {string} sessionId
 * @property {import("./parked.js").ParkJob|null} job
 * @property {string} resumeCwd
 * @property {number} [limitParks]
 * @property {string} [parkCause]
 */

/**
 * @typedef {{seat: string, sessionId: string, cwd: string, parkCause?: string,
 *   from?: string}} ResumeTarget
 */

/** @typedef {"control-damaged" | "explicit"} StopReason */

/** @typedef {{root: string, number: number, why: string}} Skip */

/** @typedef {{reason: string, detail: string}} Idle */

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
 *   held: Skip[], resumes: HeldResume[], repoPauses?: Record<string, Pause>,
 *   capHeld?: HeldResume[], planWait?: PlanWait, weighed?: true}} Decision
 */

/** @typedef {{resets: number|null}} PlanWait */

/** @param {LaunchRecord} r */
const actsRead = (r) =>
	r.acts === undefined || r.acts === UNREAD ? null : r.acts;

/** @param {LaunchRecord} r */
const hasProgressed = (r) =>
	Object.values(actsRead(r) ?? {}).some((n) => n > 0);

/**
 * @param {Pick<TickInput, "history"|"noProgressFrom">} input
 * @param {string} root
 */
function noProgressRun({ history, noProgressFrom }, root) {
	const recent = history
		.filter(
			(r) =>
				r.root === root &&
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
 * @param {TickInput} input
 * @returns {Record<string, Pause>}
 */
function buildNoProgressPauses(input) {
	/** @type {Record<string, Pause>} */
	const pauses = {};
	for (const root of new Set(input.history.map((l) => l.root))) {
		if (input.repoPaused?.[root]) continue;
		const stalled = noProgressRun(input, root);
		if (stalled) pauses[root] = buildNoProgressPause(stalled, input.now);
	}
	return pauses;
}

/**
 * @param {Record<string, number>} lastActAt
 * @param {string[]} roots
 */
const buildUnprovenIdle = (lastActAt, roots) =>
	buildIdle(
		UNPROVEN_CAP,
		` (${roots
			.map((root) => {
				const at = lastActAt[root];
				return `${path.basename(root)} ${
					at === undefined
						? "no act read"
						: `last act ${new Date(at).toISOString()}`
				}`;
			})
			.join("; ")})`,
	);

/** @param {{week: number|null, session: number|null}} s */
const hasRoom = (s) =>
	s.week !== null && s.session !== null && s.week < FULL && s.session < FULL;

/**
 * @template {{fits: number|null}} S
 * @param {S} s
 * @returns {s is S & {fits: number}}
 */
const isFitted = (s) => s.fits !== null && s.fits > 0;

/**
 * @template {{week: number|null, session: number|null, fits: number|null}} S
 * @param {S} s
 * @returns {s is S & {fits: number}}
 */
const fitsLaunch = (s) => hasRoom(s) && isFitted(s);

/** @param {SizedSeat} s */
const readsFull = (s) => s.weekFull || s.sessionFull || s.fits === 0;

/**
 * @template {{seat: string, weekResets: number|null}} S
 * @param {S[]} seats
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
 * @template {SizedSeat} S
 * @param {S[]} seats
 * @param {string|null} typedSeat
 * @param {string} own
 * @returns {S|undefined}
 */
const pickParkedSeat = (seats, typedSeat, own) =>
	orderPlanSeats(seats, typedSeat).find((s) =>
		s.seat === own ? !readsFull(s) : fitsLaunch(s),
	);

/**
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
 * @param {Pick<TickInput, "seats"|"overflow"|"typedSeat"> &
 *   {ownSeat: string, since: number, left?: SeatLeft[]}} input
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

/**
 * @param {SizedSeat[]} seats
 * @param {BillingStop[]} stops
 * @param {number} now
 * @returns {SizedSeat[]}
 */
function barBillingSeats(seats, stops, now) {
	const live = new Set(
		stops.filter((b) => now - b.since < BILLING_SKIP_MS).map((b) => b.seat),
	);
	return seats.map((s) => (live.has(s.seat) ? { ...s, fits: 0 } : s));
}

/** @param {OverflowReading[]} overflow */
const overflowHolds = (overflow) => overflow.map(overflowHold).join(", ");

/**
 * @param {SizedSeat[]} seats
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
 * @param {TickHold[]} holds
 * @param {number} now
 */
function buildProbeHoldDetail(holds, now) {
	/** @type {Map<string, TickHold>} */
	const byRoot = new Map();
	for (const h of holds)
		if (h.kind === "probe" && (h.raisedAt !== null || !byRoot.has(h.root)))
			byRoot.set(h.root, h);
	const parts = [...byRoot.values()].map(({ root, issue, raisedAt }) => {
		const filed = issue === null ? "no issue filed yet" : `#${issue}`;
		const age =
			raisedAt === null
				? "raised this tick"
				: `held ${buildAgeText(now - raisedAt)}`;
		return `${path.basename(root)} ${filed}, ${age}`;
	});
	return `: ${parts.join("; ")}`;
}

/** @param {{labels: string[]}} row */
const isParked = (row) => row.labels.includes(PARKED_LABEL);

/** @param {"normal"|"away"} [mode] */
const isParkRoutingMode = (mode) => mode === "normal";

/**
 * @param {{labels: string[], takes: string[]}} row
 * @param {"normal"|"away"} [mode]
 */
function buildSkipReason(row, mode) {
	if (!isParkRoutingMode(mode) && isParked(row)) return "parked";
	if (row.labels.includes(WAITING_LABEL)) return WAITING_LABEL;
	if (loneCommandOf(row.takes) === null)
		return `${TAKES_PREFIX}${row.takes.join("+") || "none"}`;
	return null;
}

/**
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
 * @param {MergedRow} row
 * @param {Pick<TickInput, "retroBundles"|"mode"|"seats"|"parkers"|"history"|
 *   "typedSeat">} input
 * @param {(n: number) => boolean} isTaken
 * @returns {{why: string} | {issues: number[], prompt: string,
 *   parkedRoute?: Launch["parkedRoute"]}}
 */
function routedLaunch(
	row,
	{ retroBundles, mode, seats, parkers = [], history, typedSeat = null },
	isTaken,
) {
	const next = rowLaunch(row, { retroBundles, mode, history }, isTaken);
	if ("why" in next || !isParked(row)) return next;
	const parked = routeParkedRow(row, parkers, { seats, typedSeat });
	return "hold" in parked
		? { why: parked.hold }
		: { ...next, parkedRoute: parked };
}

const EXPLICIT_STOP_DETAIL = "stop was requested";

/**
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

/** @typedef {{seats: SizedSeat[], typedSeat?: string|null}} SeatWalk */

// guess, #3804
const LIMIT_PARK_CAP = 2;

/** @param {number} limitParks */
const buildLimitCapText = (limitParks) =>
	`${limitParks} limit-cap parks in a row with no model reply; it stays parked until you type in its session or take the label off`;

/**
 * @param {number|undefined} limitParks
 * @returns {limitParks is number}
 */
const isAtLimitCap = (limitParks) =>
	limitParks !== undefined && limitParks >= LIMIT_PARK_CAP;

/** @param {number|undefined} limitParks */
const buildLimitCapHoldWhy = (limitParks) =>
	isAtLimitCap(limitParks) ? `parked: ${buildLimitCapText(limitParks)}` : null;

/**
 * @param {ParkerReading} parker
 * @param {SeatWalk} walk
 * @returns {{resume: ResumeTarget} | {hold: string} | {afresh: string}}
 */
function routeParkedSession(parker, { seats, typedSeat }) {
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
	const to = pickParkedSeat(seats, typedSeat ?? null, seat.seat);
	if (!to) return { hold: `parked: its session's seat ${seat.seat} is full` };
	return {
		resume: {
			seat: to.seat,
			...(to.seat === seat.seat ? {} : { from: seat.seat }),
			sessionId: parker.sessionId,
			cwd: parker.resumeCwd,
			...(parker.parkCause ? { parkCause: parker.parkCause } : {}),
		},
	};
}

/**
 * @param {ParkerReading|undefined} parker
 * @param {SeatWalk} walk
 * @returns {{hold: string, atCap?: boolean} | NonNullable<Launch["parkedRoute"]>}
 */
function routeParked(parker, walk) {
	if (!parker) return { afresh: "no session that parked it is recorded" };
	const { limitParks } = parker;
	if (limitParks === undefined) return routeParkedSession(parker, walk);
	const capHold = buildLimitCapHoldWhy(limitParks);
	if (capHold !== null) return { hold: capHold, atCap: true };
	return { ...routeParkedSession(parker, walk), limitParks };
}

/**
 * @param {MergedRow} row
 * @param {ParkerReading[]} parkers
 * @param {SeatWalk} walk
 */
const routeParkedRow = (row, parkers, walk) =>
	routeParked(
		parkers.find((p) => p.root === row.root && p.number === row.number),
		walk,
	);

/**
 * @param {Pick<TickInput, "frontier"|"seats"|"parkers"|"typedSeat">} input
 * @returns {Skip[]}
 */
const heldParked = ({ frontier, seats, parkers = [], typedSeat = null }) =>
	frontier.filter(isParked).flatMap((row) => {
		const parked = routeParkedRow(row, parkers, { seats, typedSeat });
		return "hold" in parked && !parked.atCap
			? [{ root: row.root, number: row.number, why: parked.hold }]
			: [];
	});

/** @param {MergedRow} row */
const parkedMs = (row) => Date.parse(row.parkedAt ?? "") || 0;

/**
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
 * @param {string} line
 * @param {string} why
 */
const buildResumeWaitLine = (line, why) =>
	`not resuming ${line}, for a later tick: ${why}`;

/**
 * @param {SizedSeat[]} seats
 * @param {string} seat
 * @returns {SizedSeat[]}
 */
const spendSeatFit = (seats, seat) =>
	seats.map((s) =>
		s.seat === seat && s.fits !== null ? { ...s, fits: s.fits - 1 } : s,
	);

/**
 * @param {HeldResume} r
 * @param {SizedSeat[]} seats
 * @param {string|null} typedSeat
 */
function resumeSeatOf(r, seats, typedSeat) {
	const own = seats.find((s) => isSameSeat(r, s));
	if (!r.parked || !own) return own;
	return pickParkedSeat(seats, typedSeat, own.seat) ?? own;
}

/**
 * @param {TickInput} input
 * @param {number} slots
 * @param {import("./launch-room.js").LaunchRoom} room
 */
function takeResumes(input, slots, room) {
	const { resumable = [], seats } = input;
	/** @type {HeldResume[]} */
	const resumes = [];
	/** @type {HeldResume[]} */
	const capHeld = [];
	let seatsLeft = seats;
	for (const r of resumable.toSorted((a, b) => a.at - b.at)) {
		if (resumes.length >= slots) break;
		if (room.resumeLeft(r.root) <= 0) continue;
		const on = resumeSeatOf(r, seatsLeft, input.typedSeat ?? null);
		if (on?.fits === 0) {
			capHeld.push(r);
			continue;
		}
		resumes.push(on && on.seat !== r.seat ? { ...r, to: on.seat } : r);
		room.spend(r.root);
		if (on) seatsLeft = spendSeatFit(seatsLeft, on.seat);
	}
	return { resumes, capHeld, seatsLeft };
}

/**
 * @param {TickInput} input
 * @param {{seat: string, keyVar?: string, reason: SeatReason}} on
 * @param {number} slots
 * @param {import("./launch-room.js").LaunchRoom} room
 */
function fill(input, { seat, keyVar, reason }, slots, room) {
	const {
		frontier,
		retroBundles,
		running,
		judgements = [],
		mode,
		seats,
		parkers,
		history,
		typedSeat,
	} = input;
	/** @type {Launch[]} */
	const launches = [];
	/** @type {Skip[]} */
	const skipped = [];
	/** @param {string} root @param {number} n */
	const key = (root, n) => `${root}#${n}`;
	const taken = new Set(
		running.flatMap((r) => r.issues.map((n) => key(r.root, n))),
	);
	/**
	 * @param {string} root
	 * @param {number} number
	 */
	const buildHeldWhy = (root, number) =>
		room.heldWhy(root) ??
		(taken.has(key(root, number)) ? ALREADY_RUNNING : room.spentWhy(root));
	let seatsLeft = seats;
	/**
	 * @param {string} root @param {number[]} issues @param {string} prompt
	 * @param {{gate?: boolean, parkedRoute?: Launch["parkedRoute"]}} [kind]
	 */
	const launch = (root, issues, prompt, { gate, parkedRoute } = {}) => {
		for (const n of issues) taken.add(key(root, n));
		room.spend(root);
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
			{ retroBundles, mode, seats: seatsLeft, parkers, history, typedSeat },
			(n) => taken.has(key(row.root, n)),
		);
	};
	/** @type {Map<string, number>} */
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
	/** @type {{row: MergedRow, why: string}[]} */
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
const buildPauseIdle = ({ by, at, issues = [] }) =>
	buildIdle(
		PAUSED,
		` ${by} at ${new Date(at).toISOString()}${
			issues.length > 0
				? `: no act from ${issues.map(buildPauseIssueText).join(", ")}`
				: ""
		}`,
	);

/** @param {Pause} pause */
const buildPauseText = (pause) => buildIdleText(buildPauseIdle(pause));

/**
 * @param {boolean} paused
 * @param {string} source
 */
const buildPauseLogLine = (paused, source) =>
	`${paused ? "paused" : "resumed"} by ${source}`;

/**
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
 * @param {TickInput} input
 * @param {Idle|null} wait
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
	`${buildPauseText(pause)}; launches nothing until \`set --resume\``;

const QUEUE_MOVING_WAITS = [
	NO_FREE_SLOT,
	RESUMES_TAKE_SLOTS,
	UNPROVEN_CAP,
	NOTHING_LAUNCHABLE,
];

/**
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
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideTick(input) {
	const requested = requestedStopOf(input);
	if (requested) return buildStopDecision(requested, input);
	if (input.paused)
		return buildIdleDecision(buildPauseIdle(input.paused), [], []);
	if (input.launchHold)
		return buildIdleDecision(buildLaunchHoldIdle(input.launchHold), [], []);
	return decideUnpaused(input);
}

/**
 * @param {TickInput} input
 * @param {{free: number, spent: Idle, held: Skip[], resumes: HeldResume[],
 *   seatsLeft: SizedSeat[]}} taken
 * @param {import("./launch-room.js").LaunchRoom} room
 * @returns {Exclude<Decision, {stop: StopReason}>}
 */
function decideLaunches(
	input,
	{ free, spent, held, resumes, seatsLeft },
	room,
) {
	const launchSlots = free - resumes.length;
	if (launchSlots === 0) return buildIdleDecision(spent, held, resumes);
	const chargedInput = { ...input, seats: seatsLeft };
	const launchPick = pickSeat({
		...input,
		seats: barBillingSeats(seatsLeft, input.billingStops ?? [], input.now),
	});
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
	const out = fill(
		chargedInput,
		launchPick,
		Math.min(launchPick.fits, launchSlots),
		room,
	);
	if (out.launches.length > 0)
		return { ...out, idle: null, held, resumes, weighed: true };
	return {
		...out,
		idle: buildUnlaunchedIdle(input, out.skipped),
		held,
		resumes,
		weighed: true,
	};
}

const CHECKOUT_SKIPS = [PROBE_HELD, REPO_PAUSED, BREAKER_OPEN, UNPROVEN_HELD];

/** @param {Decision} decision */
const isFrontierDependent = (decision) =>
	!("stop" in decision) && decision.weighed === true;

/**
 * @param {TickInput} input
 * @param {Skip[]} skipped
 * @returns {Idle}
 */
function buildUnlaunchedIdle(input, skipped) {
	const failed = input.failedShortlists ?? [];
	if (failed.length > 0)
		return buildIdle(
			SHORTLIST_FAILED,
			` ${failed
				.map((f) => `${path.basename(f.root)}: ${f.error}`)
				.join(`; ${SHORTLIST_FAILED} `)}`,
		);
	if (
		skipped.length === 0 ||
		!skipped.every((s) => CHECKOUT_SKIPS.includes(s.why))
	)
		return buildIdle(NOTHING_LAUNCHABLE);
	if (skipped.every((s) => s.why === PROBE_HELD))
		return buildIdle(
			PROBE_HOLD_WAIT,
			buildProbeHoldDetail(input.holds ?? [], input.now),
		);
	const byRoot = new Map(skipped.map((s) => [s.root, s.why]));
	if (skipped.every((s) => s.why === UNPROVEN_HELD))
		return buildUnprovenIdle(input.lastActAt, [...byRoot.keys()]);
	return buildIdle(
		CHECKOUTS_HELD,
		`: ${[...byRoot].map(([root, why]) => `${path.basename(root)} ${why}`).join("; ")}`,
	);
}

/**
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideUnpaused(input) {
	const repoPauses = buildNoProgressPauses(input);
	const decision = decideUnpausedRepos({
		...input,
		repoPaused: { ...input.repoPaused, ...repoPauses },
	});
	return Object.keys(repoPauses).length > 0
		? { ...decision, repoPauses }
		: decision;
}

/**
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideUnpausedRepos(input) {
	const pick = pickSeat(input);
	if (
		pick.seat === null &&
		pick.allCut &&
		!input.limitHeldLines?.length &&
		!input.resumable?.length
	)
		return buildNoSeatIdle(input, null, heldParked(input), []);
	const held = heldParked(input);
	if (input.freeSlots === 0)
		return buildIdleDecision(buildIdle(NO_FREE_SLOT), held, []);
	const room = buildLaunchRoom(input);
	const free = input.freeSlots;
	const spent = buildIdle(RESUMES_TAKE_SLOTS);
	const { resumes, capHeld, seatsLeft } = takeResumes(input, free, room);
	return {
		...decideLaunches(input, { free, spent, held, resumes, seatsLeft }, room),
		capHeld,
	};
}

/** @param {{launchedAt: number, relaunchedAt?: number}} l */
const startedAt = (l) => Math.max(l.launchedAt, l.relaunchedAt ?? 0);

/**
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
	PROBE_HOLD_WAIT,
	buildOverflowHoldText,
	buildResumeWaitLine,
	buildPauseIssueText,
	buildPauseText,
	buildPausedWaitText,
	buildPlanWaitText,
	buildLoopWait,
	buildIdleText,
	buildPauseLogLine,
	FIVE_HOUR_FULL,
	LIMIT_HELD_WAIT,
	NO_FREE_SLOT,
	NO_PLAN_ROOM,
	PAUSED,
	buildLaunchHoldText,
	liveLaunchHold,
	isLaunchBarred,
	RESUME_DUE_WAIT,
	RESUMES_TAKE_SLOTS,
	SHORTLIST_FAILED,
	UNPROVEN_CAP,
	seatHold,
	FULL,
	buildLimitCapHoldWhy,
	isAtLimitCap,
	NOTHING_LAUNCHABLE,
	UNREAD,
	actsRead,
	buildLimitCapText,
	buildSkipReason,
	CLASH_PREFIX,
	decideTick,
	isFrontierDependent,
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
