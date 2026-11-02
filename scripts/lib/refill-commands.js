/*
 * refill-commands.js — what the refill loop's `start`, `set` and `status`
 * commands compute and print, pure (#2012, #2123, spec #1995): the scope a
 * `start` writes over a running loop's, the fields a `set` changes, and the lines naming a loop's scope, its
 * launches and its last tick. The control and state they read are
 * lib/refill-loop.js's.
 */

const path = require("node:path");
const { sizedPercent } = require("./allowance.js");
const { RESUME_CAP } = require("./block-act.js");
const {
	buildLimitText,
	isLimitHeld,
	isResuming,
	isHoldCleared,
	isSwapHeld,
	iso,
	nextResumeAt,
} = require("./refill-blocks.js");
const {
	buildBasisLines,
	buildOverflowStartLines,
} = require("./overflow-notice.js");
const {
	buildOverflowHoldText,
	buildPauseText,
	buildPausedWaitText,
	isPauseText,
	hasRoom,
	orderPlanSeats,
	pickSeat,
	seatHold,
} = require("./refill-decide.js");
const {
	buildSeatText,
	buildSkipText,
	launchesOnDay,
	launchesSince,
} = require("./refill-loop.js");
const { buildSeatName } = require("./refill-seats.js");

/* Untraced. */
const STATUS_LAUNCHES = 10;
/* The skipped rows `status` lists. Untraced. */
const STATUS_SKIPS = 10;

/** @typedef {import("./refill-loop.js").Control} Control */
/** @typedef {import("./refill-loop.js").Scope} Scope */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-loop.js").LoopState} LoopState */

/**
 * The scope a `start` writes, given the running loop's (null where none
 * runs) and the one asked for from `root`. A start adds its repos to a running
 * loop's and keeps its mode; the asked goal replaces `root`'s, a bare start
 * clearing it (#2119, #2123).
 * @param {Scope|null} running
 * @param {Scope} asked
 * @param {string} root
 * @returns {Scope}
 */
function mergedScope(running, asked, root) {
	if (running === null) return asked;
	const goals = { ...running.goals };
	delete goals[root];
	Object.assign(goals, asked.goals);
	const repos = [...new Set([...running.repos, ...asked.repos])];
	return { ...running, repos, goals };
}

/** @param {number} from */
const buildCountingLine = (from) =>
	`counting:  no-progress count from ${iso(from)}`;

/** @param {string[]} roots */
const buildRepoNames = (roots) =>
	roots.map((r) => path.basename(r)).join(", ") || "none";

/**
 * The fields a `set` names, each absent where it does not; `repos`, the whole
 * ticked set; `pause`, `--pause`, or false for `--resume`.
 * @typedef {{pause?: boolean, mode?: Scope["mode"], repos?: string[],
 *   tick?: string[], untick?: string[]}} SetAsk
 * @typedef {{running: boolean, now: number}} SetContext
 * @typedef {{write: Control|null, lines: string[]}} SetChange
 */

/** @param {SetAsk} ask */
const asksRepos = ({ repos, tick, untick }) => Boolean(repos || tick || untick);

/**
 * What a `set` does to the control just read under the lock: why it refuses, or
 * the control to write, null where none, and the lines to print.
 * @param {import("./refill-loop.js").ControlRead} read
 * @param {SetAsk} ask
 * @param {SetContext} context
 * @returns {{refused: string}|SetChange}
 */
function planSet({ control, damaged }, ask, context) {
	if (damaged !== null) return { refused: `${damaged}; \`start\` rewrites it` };
	if (control === null)
		return { refused: "the loop was never started; run `start` first" };
	const { pause, mode } = ask;
	/** @type {((c: Control) => SetChange)[]} */
	const steps = [
		...(pause === undefined
			? []
			: [(/** @type {Control} */ c) => buildPauseChange(c, pause, context)]),
		...(mode === undefined
			? []
			: [(/** @type {Control} */ c) => buildModeChange(c, mode)]),
		...(asksRepos(ask)
			? [(/** @type {Control} */ c) => buildReposChange(c, ask)]
			: []),
	];
	let current = control;
	/** @type {Control|null} */
	let write = null;
	const lines = [];
	for (const step of steps) {
		const change = step(current);
		lines.push(...change.lines);
		if (change.write) {
			current = change.write;
			write = change.write;
		}
	}
	return { write, lines: [...lines, ...buildNotRunningLines(ask, context)] };
}

/**
 * A `start` keeps a pause, and rebuilds the mode and repos.
 * @param {SetAsk} ask
 * @param {SetContext} context
 */
function buildNotRunningLines(ask, { running }) {
	if (running) return [];
	return [
		...(ask.pause === undefined
			? []
			: ["refill loop: not running; this holds from its next start"]),
		...(ask.mode || asksRepos(ask)
			? [
					"refill loop: not running; its next start sets the mode and repos afresh",
				]
			: []),
	];
}

/**
 * Only the pause changed. A resume of a running loop moves the point the
 * no-progress count counts from, so the finishes before it do not count
 * (#3856). With no process the point stays, so a loop that ended itself still
 * reads as ended until a `start`. Asking for what already holds changes nothing,
 * a repeat pause keeping its time.
 * @param {Control} control
 * @param {boolean} pause
 * @param {SetContext} context
 * @returns {SetChange}
 */
function buildPauseChange(control, pause, { running, now }) {
	if (pause === (control.paused !== undefined))
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
	const { paused: _resumed, ...rest } = control;
	return running
		? {
				write: { ...rest, noProgressFrom: now },
				lines: ["not paused", buildCountingLine(now)],
			}
		: { write: rest, lines: ["not paused"] };
}

/**
 * Only the mode changed.
 * @param {Control} control
 * @param {Scope["mode"]} mode
 * @returns {SetChange}
 */
function buildModeChange(control, mode) {
	if (control.scope.mode === mode)
		return { write: null, lines: [`unchanged: mode ${mode}`] };
	return {
		write: { ...control, scope: { ...control.scope, mode } },
		lines: [`mode:      ${mode}`],
	};
}

/**
 * Only the ticked set changed: replaced by `repos`, then `tick` added and
 * `untick` taken away, a repo already ticked keeping its place.
 * @param {Control} control
 * @param {SetAsk} ask
 * @returns {SetChange}
 */
function buildReposChange(control, { repos, tick = [], untick = [] }) {
	const before = control.scope.repos;
	const after = [...new Set([...(repos ?? before), ...tick])].filter(
		(r) => !untick.includes(r),
	);
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
 * @typedef {import("./refill-decide.js").SizedSeat} SizedSeat
 * @typedef {{week: number, session: number}} Ceilings dispatch's cut
 * @typedef {{bar: "week"|"5h", percent: number, ceiling: number}} FailingLimit
 * @typedef {object} SeatsView what the `seats:` line says, its seats as tilde
 *   paths (#3733)
 * @property {{seat: string, week: number|null, session: number|null,
 *   readAt: string, fresh: boolean}[]} readings in launch order
 * @property {{seat: string, reason: import("./refill-decide.js").SeatReason}|null} next
 * @property {string|null} wait why no seat is next, where none is
 * @property {{seat: string, limits: FailingLimit[], hold: string|null}[]} passedOver
 *   each seat a limit fails on, and each ahead of the pick, `hold` saying why
 *   where no limit fails
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
 * @returns {SizedSeat & {fresh: boolean}}
 */
function foreseeSeat({ reading, bars, sizeCap, ceilings, now }) {
	const fresh = reading.week !== null && reading.session !== null;
	if (fresh)
		return { ...reading, fits: hasRoom(reading) ? sizeCap() : null, fresh };
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
 * A seat's tilde path; "the seat file", standing in for an overflow seat where
 * that file refuses, is no path.
 * @param {string} dir
 */
const buildDirName = (dir) => (path.isAbsolute(dir) ? buildSeatName(dir) : dir);

/**
 * The picker's walk over the seats as foreseen, with every limit failing on
 * each seat it does not take. A seat behind the pick that no limit fails on
 * was never reached, so is not passed over; nor is an overflow seat before
 * every plan seat is weekly-full.
 * @param {{seats: (SizedSeat & {fresh: boolean})[],
 *   overflow: import("./refill-decide.js").OverflowReading[],
 *   typedSeat: string|null, ceilings: Ceilings,
 *   callerSeat?: string}} input `seats` in seat-file order
 * @returns {SeatsView}
 */
function buildSeatsView({ seats, overflow, typedSeat, ceilings, callerSeat }) {
	const pick = pickSeat({ seats, overflow, typedSeat });
	const walk = orderPlanSeats(seats, typedSeat);
	const taken = walk.findIndex((s) => s.seat === pick.seat);
	const reached = taken === -1 ? walk.length : taken;
	const overflowTaken = overflow.findIndex((o) => o.seat === pick.seat);
	const overflowReached = seats.every((s) => s.weekFull)
		? overflow.slice(0, overflowTaken === -1 ? overflow.length : overflowTaken)
		: [];
	const wait =
		pick.seat === null
			? [...seats, ...overflow].reduce(
					(text, { seat }) => text.replaceAll(seat, buildDirName(seat)),
					pick.wait || "every seat is spent",
				)
			: null;
	return {
		readings: walk.map((s) => ({
			seat: buildSeatName(s.seat),
			week: s.week,
			session: s.session,
			readAt: iso(s.readAt),
			fresh: s.fresh,
		})),
		next:
			pick.seat === null
				? null
				: { seat: buildDirName(pick.seat), reason: pick.reason },
		wait,
		passedOver: [
			...walk.flatMap((s, i) => {
				if (s.seat === pick.seat) return [];
				const limits = failingLimits(s, ceilings);
				const hold =
					i < reached && limits.length === 0 ? HOLD_TEXT[seatHold(s)] : null;
				return limits.length > 0 || hold !== null
					? [{ seat: buildSeatName(s.seat), limits, hold }]
					: [];
			}),
			...overflowReached.map((o) => ({
				seat: buildDirName(o.seat),
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
			? `next ${view.next.seat} (${view.next.reason})`
			: `next none (${view.wait})`,
		...view.passedOver.map(({ seat, limits, hold }) => {
			const failing = limits.map(
				(l) => `${l.bar} ${l.percent}% ≥ ${l.ceiling}%`,
			);
			return `passed over ${seat} ${[...failing, ...(hold ? [hold] : [])].join(", ")}`;
		}),
		...(view.callerSeat
			? [`/pick-next's launches ${view.callerSeat} (its caller's seat)`]
			: []),
	].join("; ");
}

/**
 * The lines naming what a loop serves and on which seats.
 * @param {Control} control
 * @param {{served: string[], running: boolean, seatsLine: string}} opts
 *   `served`, scopeRoots's roots; `seatsLine`, buildSeatsLine's
 */
function buildScopeLines(control, { served, running, seatsLine }) {
	const { scope } = control;
	const goals = Object.entries(scope.goals).map(
		([root, issues]) =>
			`${path.basename(root)} ${issues.map((n) => `#${n}`).join(", ")}`,
	);
	return [
		...(control.paused ? [buildPausedWaitText(control.paused)] : []),
		`mode:      ${scope.mode}`,
		`repos:     ${buildRepoNames(served)}`,
		`goal:      ${goals.join("; ") || "none"}`,
		...(running && control.stopRequested
			? ["stops:     at its next tick, on request"]
			: []),
		seatsLine,
	];
}

/**
 * Where a launch stands, for `status`.
 * @typedef {"park-stopped"|"handed-off"|"hand-off-owed"|"finished"
 *   |"resuming"|"swap-held"|"hold-cleared"|"limit-held"|"resumed-idle"|"parked"|"running"}
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
	if (isSwapHeld(l)) return "swap-held";
	if (isHoldCleared(l)) return "hold-cleared";
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
	"swap-held",
	"limit-held",
	"resumed-idle",
	"parked",
]);

/** @param {LoopLaunch} l */
function launchStateOf(l) {
	switch (launchKindOf(l)) {
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
		case "swap-held":
			return `stopped under the swap hold since ${iso(/** @type {number} */ (l.swapHeld?.at))}, resumed through admission once it clears`;
		case "hold-cleared":
			return `parked on repo hold ${l.holdCleared?.hold}, since cleared, resumed through admission`;
		case "limit-held": {
			const held = /** @type {import("./refill-blocks.js").LimitHeld} */ (
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
 * @param {{served: string[], running: boolean, seatsLine: string}} opts
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
 * The last tick's line, then the rows it skipped (#2561).
 * @param {NonNullable<LoopState["lastTick"]>} t
 */
function buildLastTickLines(t) {
	const skipped = t.skipped ?? [];
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
	return [
		pid === null
			? "refill loop: not running"
			: `refill loop: running, pid ${pid}`,
		...(pid !== null && codeSha ? [`code:      ${codeSha}`] : []),
		...(control
			? buildControlLines(control, state, {
					served,
					running: pid !== null,
					seatsLine: buildSeatsLine(seats, now),
				})
			: ["never started on this machine"]),
		...(state.lastTick ? buildLastTickLines(state.lastTick) : []),
		...(state.stopped
			? [
					`last stop: ${iso(state.stopped.at)}  ${state.stopped.reason} — ${state.stopped.detail}`,
				]
			: []),
	];
}

/**
 * What `status` prints where an overflow seat is declared: the plan seats the
 * overflow decision rests on as read now, where the seat file differs from
 * them (the loop reads it only at `start`), and the last overflow start's.
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
			? [`  in the seat file, unread until the next start: ${names(unread)}`]
			: []),
		...(dropped.length > 0
			? [
					`  read since the last start, gone from the seat file: ${names(dropped)}`,
				]
			: []),
		...(start
			? [
					`last overflow start: ${iso(start.at)} on ${buildSeatName(start.seat)}`,
					...buildOverflowStartLines(start).map((l) => `  ${l}`),
				]
			: []),
	];
}

/**
 * `status --json`: whether the loop runs and on what code, its pause and mode,
 * the last tick's summary and waiting reason, launches today, every candidate
 * checkout, ticked or not, with why any is disabled (#3862), the launch rows
 * `status` lists, each with its seat as a tilde path and why it was picked
 * (#3732), null on a record from before that, and the `seats:` line's fields
 * (#3733).
 * @param {{control: Control|null, state: LoopState, pid: number|null,
 *   seats: SeatsView, codeSha: string|null, today: string,
 *   candidates: {root: string, disabled: string|null}[]}} input
 *   `codeSha`, lib/refill-code.js's readRunningCode; `today`, machine-local
 */
function buildStatusJson({
	control,
	state,
	pid,
	seats,
	codeSha,
	today,
	candidates,
}) {
	const { lastTick } = state;
	return {
		running: pid !== null,
		pid,
		codeSha,
		stopRequested: control?.stopRequested ?? false,
		paused: control?.paused ?? null,
		lastTick: lastTick && {
			at: lastTick.at,
			summary: lastTick.summary,
			idle: lastTick.idle ?? null,
			paused: isPauseText(lastTick.idle),
		},
		launchesToday: launchesOnDay(state, today),
		mode: control?.scope.mode ?? null,
		repos: candidates.map(({ root, disabled }) => ({
			name: path.basename(root),
			root,
			ticked: control?.scope.repos.includes(root) ?? false,
			disabled,
		})),
		seats,
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
	buildOverflowBasisLines,
	buildScopeLines,
	buildSeatsLine,
	buildSeatsView,
	buildStatusJson,
	buildStatusLines,
	foreseeSeat,
	mergedScope,
	planSet,
};
