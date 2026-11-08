/*
 * refill-commands.js — what the refill loop's `start`, `set` and `status`
 * commands compute and print, pure (#2012, #2123, spec #1995): what a `start`
 * does, the fields a `set` changes, and the lines naming a loop's scope, its
 * launches and its last tick.
 */

const path = require("node:path");
const { sizedPercent } = require("./allowance.js");
const { RESUME_CAP } = require("./block-act.js");
const { isLimitHeld, isResuming, iso } = require("./refill-block-core.js");
const {
	buildStepStatus,
	nextResumeAt,
	stepKindOf,
	UNSETTLED_STEP_KINDS,
} = require("./refill-blocks.js");
const { buildLimitText } = require("./refill-limits.js");
const {
	buildBasisLines,
	buildOverflowStartLines,
	buildStartLabel,
} = require("./overflow-notice.js");
const { isBudgetSpent } = require("./overflow-budget-core.js");
const { buildNotice, isNotice } = require("./refill-notice.js");
const {
	buildOverflowHoldText,
	buildPauseText,
	buildPausedWaitText,
	QUIET_BENCH_PAUSE,
	PAUSED,
	buildIdleText,
	hasRoom,
	orderPlanSeats,
	pickSeat,
	seatHold,
	isClashSkip,
} = require("./refill-decide.js");
const {
	buildSeatText,
	buildSkipText,
	controlInMode,
	controlWithoutOptedOut,
	scopeRoots,
	handedOffSince,
	withAbsentRead,
	launchesSince,
	recordedStop,
} = require("./refill-loop.js");
const {
	buildGoalLine,
	buildGoalStatus,
	isSameGoal,
	qualifyOpenRefs,
	qualifyRefs,
} = require("./refill-goal.js");
const {
	buildSeatLabel,
	buildSeatName,
	seatIdOf,
} = require("./refill-seats.js");

/* Untraced. */
const STATUS_LAUNCHES = 10;
/* The skipped rows `status` lists. Untraced. */
const STATUS_SKIPS = 10;

/** @typedef {import("./refill-loop.js").Control} Control */
/** @typedef {import("./refill-loop.js").Scope} Scope */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-state.js").LoopState} LoopState */

/** @param {number} from */
const buildCountingLine = (from) =>
	`counting:  no-progress count from ${iso(from)}`;

/** @param {string[]} roots */
const buildRepoNames = (roots) =>
	roots.map((r) => path.basename(r)).join(", ") || "none";

/** @typedef {import("./refill-notice.js").Notice} Notice */

const REWRITES_DAMAGED = "`start` rewrites it";
const RESTART_REMEDY = "run `start` once it is fixed";
const NOT_RUNNING = buildNotice(
	"not running",
	"this holds from its next start",
);

/**
 * The fields a `set` names, each absent where it does not; `repos`, the whole
 * ticked set; `pause`, `--pause`, or false for `--resume`; `goal`, the goal to
 * store, or null for `--clear-goal`; `quietBench`, `--quiet-bench`, or false for
 * `--no-quiet-bench`.
 * @typedef {{form: import("./refill-goal.js").GoalForm, text: string,
 *   refs: import("./refill-goal.js").AskedRef[]}} GoalAsk
 * @typedef {{pause?: boolean, mode?: Scope["mode"], repos?: string[],
 *   tick?: string[], untick?: string[], goal?: GoalAsk|null,
 *   quietBench?: boolean}} SetAsk
 * @typedef {{running: boolean, now: number,
 *   readExclusionWhy: (root: string) => string|null,
 *   isOptedOut: (root: string) => boolean}} SetContext
 *   `readExclusionWhy`, why the loop does not serve a root, null where it does;
 *   `isOptedOut`, whether its owner opted it out
 * @typedef {{write: Control|null, lines: string[]}} SetChange
 * @typedef {{write: Control|null, control: Control,
 *   action: "running"|"start"|"stopped", lines: string[]}} StartPlan
 * @typedef {{refused: Notice, exitCode: number}} StartRefusal
 * @typedef {{pid: number|null, now: number, root: string, seats: string[],
 *   seatErrors: string[], stopped: LoopState["stopped"],
 *   unlessStopped: boolean,
 *   readExclusionWhy: SetContext["readExclusionWhy"],
 *   isOptedOut: SetContext["isOptedOut"]}} StartContext `seats` and
 *   `seatErrors`, the seat file's; `stopped`, the state file's
 * @typedef {SetChange & {startFrom: Control|null, warning: Notice|null}} SetPlan
 *   `startFrom`, the control a process starts from, where a resume found none
 *   running; `warning`, what it changed but no process takes yet
 */

/** @param {SetAsk} ask */
const asksRepos = ({ repos, tick, untick }) => Boolean(repos || tick || untick);

/**
 * What a `set` does to the control just read under the lock: why it refuses, or
 * the control to write, null where none, and the lines to print.
 * @param {import("./refill-loop.js").ControlRead} read
 * @param {SetAsk} ask
 * @param {SetContext} context
 * @returns {{refused: Notice}|SetPlan}
 */
function planSet({ control, damaged }, ask, context) {
	if (damaged !== null)
		return { refused: buildNotice(damaged, REWRITES_DAMAGED) };
	if (control === null)
		return {
			refused: buildNotice("the loop was never started", "run `start` first"),
		};
	const changed = changeFields(control, ask, context);
	if ("refused" in changed) return changed;
	const { running } = context;
	return {
		write: changed.write,
		lines: changed.lines,
		warning: running || ask.pause === false ? null : NOT_RUNNING,
		startFrom: ask.pause === false && !running ? changed.write : null,
	};
}

/**
 * `set --json`'s one object, every key always there.
 * @param {{refused?: Notice, warning?: Notice|null, lines?: string[]}} said
 */
const buildSetJson = (said) => ({
	refused: null,
	warning: null,
	lines: [],
	...said,
});

/**
 * What a `set` that wrote says as JSON. A process that would not start is a warning,
 * not a refusal: the control is written, and no process takes it yet.
 * @param {SetPlan} plan
 * @param {{error: string}|{lines: string[]}} started
 */
function buildSetPlanJson({ lines, warning }, started) {
	return "error" in started
		? buildSetJson({
				warning: buildNotice(`not started: ${started.error}`, RESTART_REMEDY),
				lines,
			})
		: buildSetJson({ warning, lines: [...lines, ...started.lines] });
}

/**
 * @param {Control} control
 * @param {SetAsk} ask
 * @param {SetContext} context
 * @returns {SetChange|{refused: Notice}}
 */
function changeFields(control, ask, context) {
	const { pause, mode, goal, quietBench } = ask;
	/** @type {((c: Control) => SetChange|{refused: Notice})[]} */
	const steps = [
		...(pause === undefined
			? []
			: [(/** @type {Control} */ c) => buildPauseChange(c, pause, context)]),
		...(mode === undefined
			? []
			: [(/** @type {Control} */ c) => buildModeChange(c, mode, context)]),
		...(asksRepos(ask)
			? [(/** @type {Control} */ c) => buildReposChange(c, ask)]
			: []),
		/* After the repos, so a goal is judged on the set this `set` leaves. */
		...(goal === undefined
			? []
			: [(/** @type {Control} */ c) => buildGoalChange(c, goal, context)]),
		...(quietBench === undefined
			? []
			: [(/** @type {Control} */ c) => buildQuietBenchChange(c, quietBench)]),
		/* On every set, not only one naming repos, so no write keeps an opted-out
		 * tick for a later opt-in to serve unticked (#4188). */
		(/** @type {Control} */ c) => buildOptOutChange(c, context.isOptedOut),
	];
	let current = control;
	/** @type {Control|null} */
	let write = null;
	const lines = [];
	for (const step of steps) {
		const change = step(current);
		if ("refused" in change) return change;
		lines.push(...change.lines);
		if (change.write) {
			current = change.write;
			write = change.write;
		}
	}
	return { write, lines };
}

/**
 * @param {string} root
 * @param {string[]} seats
 * @param {number} now
 * @returns {Control}
 */
const buildFreshControl = (root, seats, now) => ({
	noProgressFrom: now,
	stopRequested: false,
	seats,
	scope: { mode: "normal", repos: [root], goal: null },
});

/**
 * @param {Control} control
 * @param {number} now
 * @returns {Control}
 */
function withStopCleared(control, now) {
	const { stopRequestedAt: _cleared, ...rest } = control;
	return { ...rest, stopRequested: false, noProgressFrom: now };
}

/**
 * Why a `start` will not go on: `unlessStopped` writes no fresh settings over a
 * control that will not read or a stop with none left to keep, and only a start
 * that writes seats minds a seat file it refuses.
 * @param {import("./refill-loop.js").ControlRead} read
 * @param {StartContext} context
 * @returns {StartRefusal|null}
 */
function buildStartRefusal({ control, damaged }, context) {
	const { pid, stopped, seatErrors, unlessStopped } = context;
	if (unlessStopped && damaged !== null)
		return { refused: buildNotice(damaged, REWRITES_DAMAGED), exitCode: 1 };
	if (unlessStopped && control === null && stopped !== null)
		return {
			refused: buildNotice(
				"the loop stopped and holds no stored settings",
				"`start` writes fresh ones",
			),
			exitCode: 1,
		};
	const writesSeats = control === null || (!unlessStopped && pid === null);
	return writesSeats && seatErrors.length > 0
		? {
				refused: buildNotice(
					`the seat file refuses\n${seatErrors.map((e) => `  ${e}`).join("\n")}`,
				),
				exitCode: 2,
			}
		: null;
}

/**
 * The stop `start --unless-stopped` leaves standing: an explicit one, on a loop
 * with no process (#2526).
 * @param {Control|null} control
 * @param {StartContext} context
 * @returns {LoopState["stopped"]}
 */
function readStandingStop(control, { pid, stopped, unlessStopped }) {
	if (!unlessStopped || pid !== null) return null;
	const stop = recordedStop(control, stopped);
	return control?.stopRequested || stop?.reason === "explicit" ? stop : null;
}

/**
 * What a `start` does to the control just read under the lock. It writes only the
 * fields `ask` names, on the stored control, a fresh one only where none exists,
 * and starts a process where none runs. A plain `start` also ends a stop: it
 * overtakes a pending one, and restarts a stopped loop. `unlessStopped`, the one `/pick-next` runs, lets an
 * explicit stop stand and otherwise starts from the settings as they were (#2526).
 * @param {import("./refill-loop.js").ControlRead} read
 * @param {SetAsk} ask
 * @param {StartContext} context
 * @returns {StartRefusal|StartPlan}
 */
function planStart(read, ask, context) {
	const { control, damaged } = read;
	const { pid, now, root, seats, unlessStopped, readExclusionWhy, isOptedOut } =
		context;
	const refusal = buildStartRefusal(read, context);
	if (refusal !== null) return refusal;
	const stored = control ?? buildFreshControl(root, seats, now);
	const changed = changeFields(stored, ask, {
		running: pid !== null,
		now,
		readExclusionWhy,
		isOptedOut,
	});
	if ("refused" in changed) return { ...changed, exitCode: 1 };
	const current = changed.write ?? stored;
	const write =
		!unlessStopped && (pid === null || current.stopRequested)
			? buildStopEnded(current, context)
			: (changed.write ?? (control === null ? stored : null));
	const stop = readStandingStop(control, context);
	return {
		write,
		control: write ?? current,
		action: startActionOf(stop, pid),
		lines: [
			...(damaged === null ? [] : [`${damaged}; fresh settings written`]),
			...buildStartHeadLines(stop, pid),
		],
	};
}

/**
 * @param {LoopState["stopped"]} stop
 * @param {number|null} pid
 * @returns {StartPlan["action"]}
 */
function startActionOf(stop, pid) {
	if (stop !== null) return "stopped";
	return pid === null ? "start" : "running";
}

/**
 * @param {LoopState["stopped"]} stop
 * @param {number|null} pid
 * @returns {string[]}
 */
function buildStartHeadLines(stop, pid) {
	if (stop !== null)
		return [
			`refill loop stopped at ${iso(stop.at)}: left stopped; \`start\` restarts it`,
		];
	return pid === null ? [] : [`refill loop running: pid ${pid}`];
}

/**
 * A new process takes the seat file's seats.
 * @param {Control} control
 * @param {StartContext} context
 * @returns {Control}
 */
function buildStopEnded(control, { pid, now, seats }) {
	const cleared = withStopCleared(control, now);
	return pid === null ? { ...cleared, seats } : cleared;
}

/**
 * The line saying the box decides, where `root`'s repo is unticked (#2526).
 * @param {Control} control
 * @param {string} root
 * @returns {string[]}
 */
function buildUntickedLines({ scope }, root) {
	const name = path.basename(root);
	return scope.repos.some((r) => path.basename(r) === name)
		? []
		: [`${name} is unchecked on the panel: the loop does not serve it`];
}

/**
 * Only the pause changed. A resume moves the point the no-progress count counts
 * from, so the finishes before it do not count (#3856). With no process it also
 * drops any stop, whatever the pause read, since its caller starts one from this
 * control (#3861). A stop pending on a running loop stands. A pause over the quiet
 * bench route's makes it the founder's, which that route never lifts (#3852).
 * Otherwise asking for what already holds changes nothing, a repeat pause keeping
 * its time.
 * @param {Control} control
 * @param {boolean} pause
 * @param {SetContext} context
 * @returns {SetChange}
 */
function buildPauseChange(control, pause, { running, now }) {
	if (
		pause === (control.paused !== undefined) &&
		(pause || running) &&
		control.paused?.by !== QUIET_BENCH_PAUSE
	)
		return {
			write: null,
			lines: [
				`unchanged: ${control.paused ? buildPauseText(control.paused) : "not paused"}`,
			],
		};
	if (pause) {
		const paused = { by: "founder", at: now };
		return { write: { ...control, paused }, lines: [buildPauseText(paused)] };
	}
	const { paused: _resumed, stopRequestedAt, ...rest } = control;
	return {
		write: {
			...rest,
			...(running && stopRequestedAt !== undefined ? { stopRequestedAt } : {}),
			stopRequested: running && control.stopRequested,
			noProgressFrom: now,
		},
		lines: ["not paused", buildCountingLine(now)],
	};
}

/**
 * Only the quiet bench route's setting changed (#3852); a tick lifts any hold of
 * its that this turns off.
 * @param {Control} control
 * @param {boolean} on
 * @returns {SetChange}
 */
function buildQuietBenchChange(control, on) {
	const { quietBenchOff: _off, ...rest } = control;
	return {
		write: on ? rest : { ...rest, quietBenchOff: true },
		lines: [`quiet bench: ${on ? "on" : "off"}`],
	};
}

/**
 * Only the mode changed. A repeat `--away` keeps the switch's time but clears
 * its absent read, so a tick that has yet to see the prompt behind this ask does
 * not take that prompt for his return (#3870).
 * @param {Control} control
 * @param {Scope["mode"]} mode
 * @param {SetContext} context
 * @returns {SetChange}
 */
function buildModeChange(control, mode, { now }) {
	if (control.scope.mode !== mode)
		return {
			write: controlInMode(control, mode, now),
			lines: [`mode:      ${mode}`],
		};
	return {
		write: control.away?.absentSeen
			? withAbsentRead(control, false, now)
			: null,
		lines: [`unchanged: mode ${mode}`],
	};
}

/**
 * The ticked set `ask` leaves.
 * @param {Control} control
 * @param {SetAsk} ask
 * @returns {string[]}
 */
const tickedAfter = ({ scope }, { repos, tick = [], untick = [] }) =>
	[...new Set([...(repos ?? scope.repos), ...tick])].filter(
		(r) => !untick.includes(r),
	);

/**
 * `ask` with its goal's refs qualified on the repos it leaves served, each read
 * as an open issue, or a refusal. This runs before the control lock, whose
 * holder reads no tracker; the lock's fresh read judges the refs again against
 * what is served then. A control that will not read is its planner's to refuse.
 * @param {Control|null} control
 * @param {SetAsk} ask
 * @param {{readIssue: (ref: import("./refill-goal.js").GoalRef) => import("./refill-goal.js").IssueRead,
 *   readExclusionWhy: (root: string) => string|null}} io
 * @returns {SetAsk|Notice}
 */
function checkGoalAsk(control, ask, { readIssue, readExclusionWhy }) {
	if (!ask.goal || control === null) return ask;
	const repos = tickedAfter(control, ask);
	const refs = qualifyOpenRefs(
		ask.goal.refs,
		scopeRoots({ ...control.scope, repos }, readExclusionWhy),
		readIssue,
	);
	return isNotice(refs) ? refs : { ...ask, goal: { ...ask.goal, refs } };
}

/**
 * Only the ticked set changed: replaced by `repos`, then `tick` added and
 * `untick` taken away, a repo already ticked keeping its place. An untick leaves
 * the goal's refs in that repo: no frontier read names them, and a re-tick ranks
 * them again.
 * @param {Control} control
 * @param {SetAsk} ask
 * @returns {SetChange}
 */
function buildReposChange(control, ask) {
	const before = control.scope.repos;
	const after = tickedAfter(control, ask);
	if (after.join("\0") === before.join("\0"))
		return {
			write: null,
			lines: [`unchanged: repos ${buildRepoNames(before)}`],
		};
	return {
		write: { ...control, scope: { ...control.scope, repos: after } },
		lines: [`repos:     ${buildRepoNames(after)}`],
	};
}

/**
 * Each ticked repo its owner has opted out unticked, as the tick does (#4188).
 * @param {Control} control
 * @param {SetContext["isOptedOut"]} isOptedOut
 * @returns {SetChange}
 */
function buildOptOutChange(control, isOptedOut) {
	const change = controlWithoutOptedOut(control, isOptedOut);
	if (change === null) return { write: null, lines: [] };
	return {
		write: change.control,
		lines: [`unticked:  ${buildRepoNames(change.dropped)} (opted out)`],
	};
}

/**
 * Only the goal changed, or why its refs are refused on the set served now.
 * Asking for what already holds changes nothing, a repeat goal keeping its time.
 * @param {Control} control
 * @param {GoalAsk|null} asked null clears it
 * @param {SetContext} context
 * @returns {SetChange|{refused: Notice}}
 */
function buildGoalChange(control, asked, { now, readExclusionWhy }) {
	const before = control.scope.goal;
	/** @param {import("./refill-goal.js").Goal|null} after */
	const changed = (after) => ({
		write: { ...control, scope: { ...control.scope, goal: after } },
		lines: [buildGoalLine(after)],
	});
	if (asked === null)
		return before === null
			? { write: null, lines: ["unchanged: goal none"] }
			: changed(null);
	const refs = qualifyRefs(
		asked.refs,
		scopeRoots(control.scope, readExclusionWhy),
	);
	if (isNotice(refs)) return { refused: refs };
	const goal = { form: asked.form, text: asked.text, refs };
	return isSameGoal(before, goal)
		? { write: null, lines: [`unchanged: ${buildGoalLine(before)}`] }
		: changed({ ...goal, setAt: now });
}

/**
 * @typedef {import("./refill-decide.js").SizedSeat} SizedSeat
 * @typedef {SizedSeat & {fresh: boolean}} ForeseenSeat
 * @typedef {{week: number, session: number}} Ceilings dispatch's cut
 * @typedef {{bar: "week"|"5h", percent: number, ceiling: number}} FailingLimit
 * @typedef {object} SeatsView what the `seats:` line says, its seats as tilde
 *   paths (#3733)
 * @property {{seat: string, week: number|null, weekFull: boolean,
 *   weekRead: {percent: number|null, at: string|null, rolled?: boolean},
 *   session: number|null, readAt: string, fresh: boolean}[]} readings in launch
 *   order
 * @property {{seat: string, keyVar?: string,
 *   reason: import("./refill-decide.js").SeatReason}|null} next
 * @property {string|null} wait why no seat is next, where none is
 * @property {{seat: string|null, keyVar?: string, limits: FailingLimit[],
 *   hold: string|null}[]} passedOver each seat a limit fails on, and each ahead
 *   of the pick, `hold` saying why where no limit fails; a null seat is the
 *   seat file that refuses
 * @property {string|null} callerSeat the seat `/pick-next`'s own launches went
 *   on, for `start`
 */

/**
 * A bar's percent as last read, trusted or not; null where it was never read
 * or its window has since reset.
 * @param {import("./allowance.js").Bar} bar
 * @param {number} now
 */
function asReadPercent(bar, now) {
	const sized = sizedPercent(bar);
	if (sized !== null) return sized;
	return Date.parse(bar.resetsAt ?? "") > now ? bar.percent : null;
}

/**
 * @param {{week: number|null, session: number|null}} s
 * @param {Ceilings} ceilings
 * @returns {FailingLimit[]}
 */
function failingLimits(s, ceilings) {
	/** @type {[FailingLimit["bar"], number|null, number][]} */
	const bars = [
		["week", s.week, ceilings.week],
		["5h", s.session, ceilings.session],
	];
	return bars.flatMap(([bar, percent, ceiling]) =>
		percent !== null && percent >= ceiling ? [{ bar, percent, ceiling }] : [],
	);
}

/**
 * A seat as `start` and `status` foresee it, reading only the cache where a
 * tick would refresh it with a `/usage` probe (#3733). A fresh seat is sized as
 * the tick sizes it. A stale bar counts at its last percent, and fits a launch
 * under dispatch's cut and none past it, the cap sizing no unfresh reading.
 * Residual: a tick's refresh can pick differently from a stale seat's guess,
 * which the line marks with the reading's age.
 * @param {{reading: import("./refill-decide.js").SeatReading,
 *   bars: {session: import("./allowance.js").Bar,
 *     weekly_all: import("./allowance.js").Bar},
 *   sizeCap: () => number|null, ceilings: Ceilings,
 *   now: number}} input `sizeCap`, the cap's count on a fresh seat
 * @returns {ForeseenSeat}
 */
function foreseeSeat({ reading, bars, sizeCap, ceilings, now }) {
	const fresh = reading.week !== null && reading.session !== null;
	if (fresh)
		return {
			...reading,
			fits: hasRoom(reading) ? sizeCap() : null,
			fresh,
		};
	const week = asReadPercent(bars.weekly_all, now);
	const session = asReadPercent(bars.session, now);
	const read = week !== null && session !== null;
	const fits = read
		? Number(failingLimits({ week, session }, ceilings).length === 0)
		: null;
	return { ...reading, week, session, fits, fresh };
}

/** Why the picker walked past a seat no limit fails on, by seatHold's word.
 * @type {Record<import("./refill-decide.js").SeatHold, string>} */
const HOLD_TEXT = {
	cut: "week full",
	fiveHour: "5-hour full",
	unread: "unread",
	unsized: "cap unsized",
	capped: "cap fits no launch",
};

/**
 * The picker's walk over the seats as foreseen, with every limit failing on
 * each seat it does not take. A seat behind the pick that no limit fails on
 * was never reached, so is not passed over; nor is an overflow seat before
 * every plan seat is weekly-full.
 * @param {{seats: ForeseenSeat[],
 *   overflow: import("./refill-decide.js").OverflowReading[],
 *   typedSeat: string|null, ceilings: Ceilings,
 *   callerSeat?: string}} input `seats` in seat-file order
 * @returns {SeatsView}
 */
function buildSeatsView({ seats, overflow, typedSeat, ceilings, callerSeat }) {
	const pick = pickSeat({ seats, overflow, typedSeat });
	const walk = orderPlanSeats(seats, typedSeat);
	const overflowPick = pick.seat !== null && pick.reason === "overflow";
	const planPick = overflowPick ? null : pick.seat;
	const taken = walk.findIndex((s) => s.seat === planPick);
	const reached = taken === -1 ? walk.length : taken;
	const overflowTaken = overflowPick
		? overflow.findIndex((o) => o.keyVar === pick.keyVar)
		: -1;
	const overflowReached = seats.every((s) => s.weekFull)
		? overflow.slice(0, overflowTaken === -1 ? overflow.length : overflowTaken)
		: [];
	const wait =
		pick.seat === null
			? [...seats, ...overflow].reduce(
					(text, { seat }) =>
						seat === null ? text : text.replaceAll(seat, buildSeatName(seat)),
					pick.wait ? buildIdleText(pick.wait) : "every seat is spent",
				)
			: null;
	return {
		readings: walk.map((s) => ({
			seat: buildSeatName(s.seat),
			week: s.week,
			weekFull: s.weekFull,
			weekRead: {
				percent: s.weekRead.percent,
				at: s.weekRead.atMs === null ? null : iso(s.weekRead.atMs),
				rolled: s.weekRead.rolled,
			},
			session: s.session,
			readAt: iso(s.readAt),
			fresh: s.fresh,
		})),
		next:
			pick.seat === null
				? null
				: {
						...seatIdOf({
							seat: buildSeatName(pick.seat),
							keyVar: pick.keyVar,
						}),
						reason: pick.reason,
					},
		wait,
		passedOver: [
			...walk.flatMap((s, i) => {
				if (s.seat === planPick) return [];
				const limits = failingLimits(s, ceilings);
				const hold =
					i < reached && limits.length === 0 ? HOLD_TEXT[seatHold(s)] : null;
				return limits.length > 0 || hold !== null
					? [{ seat: buildSeatName(s.seat), limits, hold }]
					: [];
			}),
			...overflowReached.map((o) => ({
				seat: o.seat === null ? null : buildSeatName(o.seat),
				...(o.keyVar ? { keyVar: o.keyVar } : {}),
				limits: [],
				hold: buildOverflowHoldText(o),
			})),
		],
		callerSeat: callerSeat === undefined ? null : buildSeatName(callerSeat),
	};
}

/**
 * @param {SeatsView} view
 * @param {number} now
 */
function buildSeatsLine(view, now) {
	/** @param {number|null} p */
	const percent = (p) => (p === null ? "unread" : `${p}%`);
	const readings = view.readings.map((r) => {
		const minutes = Math.round((now - Date.parse(r.readAt)) / 60_000);
		const dated = !r.fresh && (r.week !== null || r.session !== null);
		const age = dated ? ` (read ${minutes}m ago)` : "";
		return `${r.seat} week ${percent(r.week)} 5h ${percent(r.session)}${age}`;
	});
	return [
		`seats:     ${readings.join(", ") || "none"}`,
		view.next
			? `next ${buildSeatLabel(view.next)} (${view.next.reason})`
			: `next none (${view.wait})`,
		...view.passedOver.map(({ limits, hold, ...seat }) => {
			const failing = limits.map(
				(l) => `${l.bar} ${l.percent}% ≥ ${l.ceiling}%`,
			);
			return `passed over ${buildSeatLabel(seat)} ${[...failing, ...(hold ? [hold] : [])].join(", ")}`;
		}),
		...(view.callerSeat
			? [`/pick-next's launches ${view.callerSeat} (its caller's seat)`]
			: []),
	].join("; ");
}

/**
 * The lines naming what a loop serves and on which seats.
 * @param {Control} control
 * @param {{served: string[], running: boolean, seatsLine: string,
 *   goalProgress?: import("./refill-goal.js").GoalProgress|null}} opts
 *   `served`, scopeRoots's roots; `seatsLine`, buildSeatsLine's; `goalProgress`,
 *   the state's, where the caller read it
 */
function buildScopeLines(
	control,
	{ served, running, seatsLine, goalProgress = null },
) {
	const { scope } = control;
	return [
		...(control.paused ? [buildPausedWaitText(control.paused)] : []),
		`mode:      ${scope.mode}`,
		...(control.quietBenchOff ? ["quiet bench: off"] : []),
		`repos:     ${buildRepoNames(served)}`,
		buildGoalLine(scope.goal, goalProgress),
		...(running && control.stopRequested
			? ["stops:     at its next tick, on request"]
			: []),
		seatsLine,
	];
}

/**
 * Where a launch stands, for `status`.
 * @typedef {"park-stopped"|"handed-off"|"hand-off-owed"|"finished"
 *   |"resuming"|string|"limit-held"|"resumed-idle"
 *   |"parked"|"running"}
 *   LaunchKind
 * @param {LoopLaunch} l
 * @returns {LaunchKind}
 */
function launchKindOf(l) {
	if (l.parkStopped !== undefined) return "park-stopped";
	if (l.handedOff !== undefined) return "handed-off";
	if (l.handOffTries !== undefined) return "hand-off-owed";
	if (l.finishedAt !== null) return "finished";
	if (isResuming(l)) return "resuming";
	if (l.stepResume) return stepKindOf(l.stepResume);
	if (isLimitHeld(l)) return "limit-held";
	if (l.idleSince !== undefined) return "resumed-idle";
	return l.parked ? "parked" : "running";
}

/** The kinds `status` lists past its launch window: each waits on the
 * founder or on the loop's resumes or hand-off. */
const UNSETTLED = new Set([
	"park-stopped",
	"hand-off-owed",
	"resuming",
	...UNSETTLED_STEP_KINDS,
	"limit-held",
	"resumed-idle",
	"parked",
]);

/** @param {LoopLaunch} l */
function launchStateOf(l) {
	const kind = launchKindOf(l);
	if (l.stepResume && kind === stepKindOf(l.stepResume))
		return buildStepStatus(l.stepResume);
	switch (kind) {
		case "park-stopped":
			return "parked, stopped";
		case "handed-off":
			return "handed off: stopped idle after its host's restart";
		case "hand-off-owed":
			return `stopped idle after its host's restart, its hand-off failed ${l.handOffTries} times`;
		case "finished":
			return "finished";
		case "resuming": {
			const blocked =
				/** @type {LoopLaunch & {block: import("./block-act.js").Block}} */ (l);
			const next =
				l.resumes?.attachAt === undefined
					? `next at ${iso(nextResumeAt(blocked))}`
					: "its typed resume being checked";
			return `resuming after an API error, ${l.resumes?.tries ?? 0} of ${RESUME_CAP} tries, ${next}`;
		}
		case "limit-held": {
			const held = /** @type {import("./refill-limits.js").LimitHeld} */ (
				l.limitHeld
			);
			return held.resumedAt === undefined
				? `stopped since ${iso(held.at)} on its ${buildLimitText(held.limit)}, resumed once its seat reads under the cut`
				: `resumed at ${iso(held.resumedAt)} after its ${buildLimitText(held.limit)}, not yet seen live`;
		}
		case "resumed-idle": {
			const r = l.idleResumes;
			return `resumed-idle since ${iso(/** @type {number} */ (l.idleSince))}, ${r ? `resumed ${r.tries} times, last at ${iso(r.triedAt)}` : "not yet resumed"}`;
		}
		case "parked":
			return "parked";
		default:
			return "running";
	}
}

/**
 * The launches `status` counts, those since the no-progress count's point and
 * any still running from before it, and of them those it lists: the last
 * STATUS_LAUNCHES and every unsettled one.
 * @param {Control} control
 * @param {LoopState} state
 */
function shownLaunches(control, state) {
	const shown = state.launches.filter(
		(l) => l.launchedAt >= control.noProgressFrom || l.finishedAt === null,
	);
	const listed = shown.filter(
		(l, i) =>
			i >= shown.length - STATUS_LAUNCHES || UNSETTLED.has(launchKindOf(l)),
	);
	return { shown, listed };
}

/**
 * The lines a recorded control gives `status`: launches since the no-progress
 * count's point, and any still running from before it.
 * @param {Control} control
 * @param {LoopState} state
 * @param {{served: string[], running: boolean, seatsLine: string,
 *   goalProgress: LoopState["goalProgress"]}} opts
 */
function buildControlLines(control, state, opts) {
	const lines = [buildCountingLine(control.noProgressFrom)];
	lines.push(...buildScopeLines(control, opts));
	const since = launchesSince(state, control.noProgressFrom);
	const { shown, listed } = shownLaunches(control, state);
	const kinds = shown.map(launchKindOf);
	const running = kinds.filter(
		(k) => k === "running" || k === "resumed-idle",
	).length;
	const parked = kinds.filter(
		(k) => k === "park-stopped" || k === "parked",
	).length;
	lines.push(
		`launches:  ${since} since then, ${running} running, ${parked} parked`,
	);
	for (const l of listed) {
		const at = launchStateOf(l);
		const session = l.sessionId ? `  session ${l.sessionId}` : "";
		lines.push(
			`  ${iso(l.launchedAt)}  ${path.basename(l.root)}  ${l.prompt}  ${at}  ${buildSeatText(l)}${session}`,
		);
	}
	return lines;
}

/**
 * The last tick's line, then the rows it skipped (#2561), its clash skips
 * first: a launching tick's other skips are rows ranked above them (#4355).
 * @param {NonNullable<LoopState["lastTick"]>} t
 */
function buildLastTickLines(t) {
	const all = t.skipped ?? [];
	const skipped = [
		...all.filter(isClashSkip),
		...all.filter((s) => !isClashSkip(s)),
	];
	return [
		`last tick: ${iso(t.at)}  ${t.summary}`,
		...skipped
			.slice(0, STATUS_SKIPS)
			.map((s) => `  skipped ${buildSkipText(s)}`),
		...(skipped.length > STATUS_SKIPS
			? [`  … and ${skipped.length - STATUS_SKIPS} more skipped`]
			: []),
	];
}

/**
 * With no process, the stop that ended the loop, or whether a process held the
 * pidfile and died with none on record (#3861). A start still on its way to the
 * pidfile, or that never reached it, has no process to have died.
 * @param {Control|null} control
 * @param {LoopState} state
 * @param {number|null} pid
 */
function readEnding(control, state, pid) {
	if (pid !== null) return { stop: null, crashed: false };
	const stop = recordedStop(control, state.stopped);
	return {
		stop,
		crashed: control !== null && stop === null && Boolean(state.heldAt),
	};
}

/**
 * @param {{control: Control|null, state: LoopState, pid: number|null,
 *   served: string[], seats: SeatsView, now: number,
 *   codeSha?: string|null}} input `served`, scopeRoots's roots; `codeSha`,
 *   lib/refill-code.js's readRunningCode
 * @returns {string[]}
 */
function buildStatusLines({
	control,
	state,
	pid,
	served,
	seats,
	now,
	codeSha = null,
}) {
	const { stop, crashed } = readEnding(control, state, pid);
	return [
		pid === null
			? "refill loop: not running"
			: `refill loop: running, pid ${pid}`,
		...(crashed
			? ["died:      with no stop recorded since its last start"]
			: []),
		...(pid !== null && codeSha ? [`code:      ${codeSha}`] : []),
		...(control
			? buildControlLines(control, state, {
					served,
					running: pid !== null,
					seatsLine: buildSeatsLine(seats, now),
					goalProgress: state.goalProgress,
				})
			: ["never started on this machine"]),
		...(state.lastTick ? buildLastTickLines(state.lastTick) : []),
		...(stop
			? [`last stop: ${iso(stop.at)}  ${stop.reason} — ${stop.detail}`]
			: []),
	];
}

/**
 * What `status` prints where an overflow seat is declared: the plan seats the
 * overflow decision rests on as read now, where the seat file differs from
 * them (only a plain `start` with no process reads it), and the last overflow start's.
 * @param {{planSeats: import("./overflow-notice.js").PlanSeatBasis[],
 *   filePlanSeats: string[], omitted: string[],
 *   start: import("./overflow-notice.js").OverflowStart|null,
 *   now: number}} input
 * @returns {string[]}
 */
function buildOverflowBasisLines({
	planSeats,
	filePlanSeats,
	omitted,
	start,
	now,
}) {
	const used = planSeats.map((b) => b.seat);
	/** @param {string[]} seats */
	const names = (seats) => seats.map((s) => buildSeatName(s)).join(", ");
	const unread = filePlanSeats.filter((s) => !used.includes(s));
	const dropped = used.filter((s) => !filePlanSeats.includes(s));
	return [
		"overflow rests on these plan seats:",
		...buildBasisLines(planSeats, omitted, { at: now, ageSuffix: "ago" }).map(
			(l) => `  ${l}`,
		),
		...(unread.length > 0
			? [
					`  in the seat file, unread until a plain start restarts the loop: ${names(unread)}`,
				]
			: []),
		...(dropped.length > 0
			? [
					`  read since the last start, gone from the seat file: ${names(dropped)}`,
				]
			: []),
		...(start
			? [
					`last overflow start: ${iso(start.at)} on ${buildStartLabel(start)}`,
					...buildOverflowStartLines(start).map((l) => `  ${l}`),
				]
			: []),
	];
}

/**
 * One overflow key's entry in `status --json`: the budget gate's figures, or why
 * they will not read.
 * @param {import("./refill-seats.js").OverflowSeat} overflowSeat
 * @param {import("./overflow-budget.js").SeatBudget|{why: string}} budget
 */
function buildOverflowStatus({ dir, keyVar }, budget) {
	const seat = buildSeatName(dir);
	if ("why" in budget) return { seat, keyVar, why: budget.why };
	return {
		seat,
		keyVar,
		spentUsd: budget.settledUsd,
		creditUsd: budget.creditUsd,
		grantUsd: budget.grantUsd,
		creditReadAt: budget.readAt,
		creditReadFailure: budget.readFailure,
		headroomUsd: budget.headroomUsd,
		exhausted: budget.exhausted,
		noLaunchLeft: isBudgetSpent(budget),
		running: budget.running,
		runningReadAt: budget.runningReadAt,
	};
}

/**
 * `status --json`: whether the loop runs and on what code, its pause and mode,
 * when away was switched on and the sessions handed off since, with no process
 * the stop that ended it or that it died with none, the last tick's summary and waiting reason, every candidate
 * checkout, ticked or not, with why any is disabled (#3862), the launch rows
 * `status` lists, each with its seat as a tilde path and why it was picked
 * (#3732), null on a record from before that, the `seats:` line's fields
 * (#3733), each overflow key's budget (#3875), and the newest tick's concurrency
 * (#4062).
 * @param {{control: Control|null, state: LoopState, pid: number|null,
 *   seats: SeatsView, codeSha: string|null,
 *   candidates: {root: string, disabled: string|null}[],
 *   burnMode: ReturnType<typeof import("./burn-mode.js").readBurnState>,
 *   overflow: (ReturnType<typeof buildOverflowStatus>|{seat: null, why: string})[],
 *   concurrency: ReturnType<typeof import("./concurrency.js").readConcurrencyStatus>}} input
 *   `codeSha`, lib/refill-code.js's readRunningCode; `today`, machine-local;
 *   `burnMode`, lib/burn-mode.js's readBurnState
 */
function buildStatusJson({
	control,
	state,
	pid,
	seats,
	codeSha,
	candidates,
	burnMode,
	overflow,
	concurrency,
}) {
	const { lastTick } = state;
	return {
		running: pid !== null,
		pid,
		codeSha,
		stopRequested: control?.stopRequested ?? false,
		...readEnding(control, state, pid),
		paused: control?.paused ?? null,
		lastTick: lastTick && {
			at: lastTick.at,
			summary: lastTick.summary,
			idle: lastTick.idle ?? null,
			paused: lastTick.idle?.reason === PAUSED,
			planWait: lastTick.planWait ?? null,
		},
		concurrency,
		mode: control?.scope.mode ?? null,
		goal: buildGoalStatus(control?.scope.goal ?? null, state.goalProgress),
		awaySince: control?.away?.since ?? null,
		handedOffSinceAway: control?.away
			? handedOffSince(state, control.away.since)
			: 0,
		repos: candidates.map(({ root, disabled }) => ({
			name: path.basename(root),
			root,
			ticked: control?.scope.repos.includes(root) ?? false,
			disabled,
		})),
		seats,
		overflow,
		burnMode,
		launches: control
			? shownLaunches(control, state).listed.map((l) => ({
					launchedAt: iso(l.launchedAt),
					root: l.root,
					prompt: l.prompt,
					state: launchStateOf(l),
					seat: buildSeatName(l.seat),
					reason: l.reason ?? null,
					sessionId: l.sessionId ?? null,
				}))
			: [],
	};
}

module.exports = {
	checkGoalAsk,
	buildOverflowBasisLines,
	buildOverflowStatus,
	buildScopeLines,
	buildSeatsLine,
	buildSeatsView,
	buildStatusJson,
	buildStatusLines,
	foreseeSeat,
	planStart,
	buildFreshControl,
	buildUntickedLines,
	planSet,
	buildSetJson,
	buildSetPlanJson,
};
