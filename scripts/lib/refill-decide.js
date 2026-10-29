/*
 * refill-decide.js — away mode's decision core (#2007, spec #1995): one pure
 * function from a tick's readings to either the launches to make or the stop
 * that ends launching.
 *
 * Caller: lib/refill-tick.js's tick (#2012)
 */

const path = require("node:path");
const { WAITING_LABEL } = require("./frontier-order.js");
const { PARKED_LABEL } = require("./parked.js");
const { COMMAND_VALUES, TAKES_PREFIX } = require("./takes-label.js");
const { presenceAt } = require("./presence.js");

/* Spec #1995's stops: 24 hours after the last start (#1918), and three
 * finishes in a row with no progress (#1920). */
const RUN_HOURS = 24;
const RUN_MS = RUN_HOURS * 60 * 60 * 1000;
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
/* A row a running launch already holds, skipped as any other so an idle
 * tick's log can count it (#2561). */
const ALREADY_RUNNING = "already running";

/**
 * `parkedAt` is when `parked` went on, null where the label is off or its
 * start would not read.
 * @typedef {import("./frontier-order.js").FrontierRow & {root: string,
 *   takes: string[], labels: string[], parkedAt?: string|null}} MergedRow
 */
/** @typedef {import("./retro-bundles.js").RetroLaunch & {root: string}} MergedBundle */

/**
 * One seat's bars, in percent; null where the reading is not fresh. A bar is
 * full where it reads 100% fresh, or cached with its reset still ahead
 * (lib/refill-loop.js's seatReadingOf), so a fresh `week` of 100 is always
 * `weekFull`.
 * @typedef {object} SeatReading
 * @property {string} seat config dir
 * @property {number|null} week
 * @property {number|null} session the 5-hour bar
 * @property {boolean} weekFull
 * @property {boolean} sessionFull
 * @property {string|null} sessionResets the 5-hour bar's reset, as read,
 *   where it is full; else null
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
 * @property {string} seat config dir
 * @property {number|null} fits
 * @property {string|null} spentUntil
 * @property {string|null} why
 */

/**
 * A loop launch. `acts` is read once it has finished.
 * @typedef {object} LaunchRecord
 * @property {string} root
 * @property {number[]} issues
 * @property {number} launchedAt ms
 * @property {number|null} finishedAt ms of the tick that saw the finish, not
 *   of the finish itself, used only to order the last three finishes; null
 *   while running
 * @property {Record<string, number>|typeof UNREAD} [acts] the launched
 *   session's acts-ledger lines counted per kind (#2312), or UNREAD where its
 *   session id was never captured or its ledger would not read
 * @property {true} [gate] a gate judgement's launch (#3092)
 */

/**
 * @typedef {object} TickInput
 * @property {number} now ms
 * @property {"normal"|"away"} mode
 * @property {number} startedAt ms, the last `start` or renewal
 * @property {boolean} stopRequested
 * @property {string|null} [controlDamaged] the control file and why, where it
 *   exists but is not a control
 * @property {MergedRow[]} frontier lib/frontier-order.js's merged ranking
 * @property {MergedBundle[]} retroBundles
 * @property {{root: string, issues: number[]}[]} running
 * @property {number} freeSlots admission's count
 * @property {number|null} lastPromptAt ms of the founder's last typed prompt
 * @property {SizedSeat[]} seats the plan seats, in failover order
 * @property {OverflowReading[]} [overflow] the overflow seats, in failover
 *   order
 * @property {LaunchRecord[]} history
 * @property {import("./gate-sweep.js").Judgement[]} [judgements] the gate
 *   sweep's queue, launched ahead of the ranking (#2279)
 * @property {{root: string, error: string}[]} [failedShortlists]
 * @property {ParkerReading[]} [parkers] each parked frontier row's parking
 *   launch the tick found
 */

/**
 * @typedef {object} Launch
 * @property {string} root the checkout the dispatcher runs in
 * @property {number[]} issues
 * @property {string} prompt
 * @property {"opus"} model
 * @property {string} seat
 * @property {true} [gate] a gate judgement's launch (#3092)
 * @property {{resume: ResumeTarget}|{afresh: string}} [parkedRoute] a parked
 *   ticket's: the session that parked it to resume in place, else why
 *   `prompt` launches afresh (#3621)
 */

/**
 * @typedef {object} ParkerReading
 * @property {string} root
 * @property {number} number the parked issue
 * @property {import("./refill-blocks.js").JobLaunch} launch
 * @property {string|null} sessionId its session, null where unread
 * @property {string} cwd where its session resumes
 */

/**
 * @typedef {{launch: import("./refill-blocks.js").JobLaunch, sessionId: string,
 *   cwd: string}} ResumeTarget
 */

/**
 * @typedef {"control-damaged" | "explicit" | "expired" | "no-progress"
 *   | "allowance"} StopReason
 */

/** @typedef {{root: string, number: number, why: string}} Skip */

/**
 * @typedef {{stop: StopReason, detail: string}
 *   | {launches: Launch[], skipped: Skip[], idle: string | null}} Decision
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
 * The last three read finishes since the last start, if none progressed: an
 * unread one is passed over, and so is a gate judgement with no act, since
 * judging a gate unmet ends with none (#3092). A renewal starts the count
 * afresh, or a restart after this stop would stop at once. Residual: a judge
 * that crashed or did nothing is passed over too, so a run of gate launches
 * alone never stops the loop; JUDGE_EVERY_MS in lib/gate-sweep.js bounds how
 * often each issue's runs.
 * @param {TickInput} input
 */
function noProgressRun({ history, startedAt }) {
	const recent = history
		.filter(
			(r) =>
				r.finishedAt !== null &&
				r.launchedAt >= startedAt &&
				r.acts !== UNREAD &&
				!(r.gate && !hasProgressed(r)),
		)
		.sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt))
		.slice(0, NO_PROGRESS_RUN);
	return recent.length === NO_PROGRESS_RUN && !recent.some(hasProgressed)
		? recent
		: null;
}

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
 * The first plan seat with room whose cap fits a launch, else, once every
 * plan seat is weekly-full, the first overflow seat whose budget fits one
 * (#2570); else whether every seat is spent, and why the tick waits where
 * not.
 * @param {TickInput} input
 */
function pickSeat({ seats, overflow = [] }) {
	const plan = pickPlanSeat(seats);
	if (plan.seat !== null || overflow.length === 0) return plan;
	if (!plan.allCut) {
		const open = seats.filter((s) => !s.weekFull).map((s) => s.seat);
		const wait = `no overflow launch: ${open.join(", ")} not weekly-full`;
		return { ...plan, wait: [plan.wait, wait].filter(Boolean).join("; ") };
	}
	const open = overflow.find(isFitted);
	if (open) return { seat: open.seat, fits: open.fits };
	return {
		seat: null,
		fits: 0,
		allCut: overflow.every((o) => o.spentUntil !== null),
		wait: `every plan seat is weekly-full; overflow ${overflowHolds(overflow)}`,
	};
}

/** @param {OverflowReading[]} overflow */
const overflowHolds = (overflow) => overflow.map(overflowHold).join(", ");

/**
 * The first plan seat with room whose cap fits a launch, else whether every
 * plan seat is weekly-full, and why the tick waits where not. A seat full on
 * its 5-hour bar alone reopens at that bar's reset, so the tick waits through
 * it (#2606). A seat with no fresh reading, no sized cap or a cap sized 0
 * stops nothing either: the dispatcher refuses the first two, so the tick
 * waits rather than stopping the run on a stale cache, and running sessions
 * finishing reopen the third's headroom (#2432). An unsized seat names the
 * wait: the loop probes no seat behind it, so an unread one there was never
 * refreshed (#2362).
 * @param {SizedSeat[]} seats
 */
function pickPlanSeat(seats) {
	/** @type {Record<SeatHold, string[]>} */
	const seatsByHold = {
		cut: [],
		fiveHour: [],
		unread: [],
		unsized: [],
		capped: [],
	};
	for (const s of seats) {
		if (fitsLaunch(s)) return { seat: s.seat, fits: s.fits };
		const hold = seatHold(s);
		seatsByHold[hold].push(
			hold === "fiveHour"
				? `${s.seat} until its 5-hour reset ${s.sessionResets ?? "(unread)"}`
				: s.seat,
		);
	}
	const { fiveHour, unread, unsized, capped } = seatsByHold;
	/* One reason among the rest, as #2362 ruled; a 5-hour wait beside it. */
	const waits = [];
	if (unsized.length > 0)
		waits.push("no seat with room has a sized allowance cap");
	else if (capped.length > 0)
		waits.push(`the allowance cap fits no launch on ${capped.join(", ")}`);
	else if (unread.length > 0)
		waits.push("no seat has a fresh allowance reading");
	if (fiveHour.length > 0)
		waits.push(`the 5-hour bar is full on ${fiveHour.join(", ")}`);
	return {
		seat: null,
		fits: 0,
		allCut: seatsByHold.cut.length === seats.length,
		wait: waits.join("; "),
	};
}

/**
 * @param {OverflowReading} o
 */
function overflowHold(o) {
	if (o.spentUntil !== null) return `${o.seat} exhausted until ${o.spentUntil}`;
	if (o.fits === 0) return `${o.seat} budget held by running sessions`;
	return `${o.seat} budget unread (${o.why ?? "no reason given"})`;
}

/** @typedef {"cut" | "fiveHour" | "unread" | "unsized" | "capped"} SeatHold */

/**
 * What holds a seat the loop cannot launch on: a full week, which alone can
 * end the run, else a full 5-hour bar, else an unread bar, else its cap
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

/** @param {{labels: string[]}} row */
const isParked = (row) => row.labels.includes(PARKED_LABEL);

/**
 * Why the loop's launch filter skips a row, or null where it launches it;
 * also the idle alarm's printed reason (lib/idle-efforts.js). A parked row
 * launches in normal mode alone: away mode leaves its question to the founder's
 * return (#2355, #3621).
 * @param {{labels: string[], takes: string[]}} row
 * @param {"normal"|"away"} [mode]
 */
function buildSkipReason(row, mode) {
	if (mode !== "normal" && isParked(row)) return "parked";
	if (row.labels.includes(WAITING_LABEL)) return WAITING_LABEL;
	const [kind, ...more] = row.takes;
	if (kind === undefined || more.length > 0)
		return `${TAKES_PREFIX}${row.takes.join("+") || "none"}`;
	if (!COMMAND_VALUES.includes(kind)) return `${TAKES_PREFIX}${kind}`;
	return null;
}

/**
 * What one ranked row launches, its whole retro bundle where it sits in one,
 * or why it is skipped.
 * @param {MergedRow} row
 * @param {MergedBundle[]} retroBundles
 * @param {(n: number) => boolean} isTaken
 * @param {"normal"|"away"} mode
 * @returns {{issues: number[], prompt: string} | {why: string}}
 */
function rowLaunch(row, retroBundles, isTaken, mode) {
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
		prompt: bundle ? bundle.prompt : `/${row.takes[0]} ${row.number}`,
	};
}

/**
 * rowLaunch, with a parked row routed by routeParked, a hold as a skip.
 * @param {MergedRow} row
 * @param {Pick<TickInput, "retroBundles"|"mode"|"seats"|"parkers">} input
 * @param {(n: number) => boolean} isTaken
 * @returns {{why: string} | {issues: number[], prompt: string,
 *   parkedRoute?: Launch["parkedRoute"]}}
 */
function routedLaunch(
	row,
	{ retroBundles, mode, seats, parkers = [] },
	isTaken,
) {
	const next = rowLaunch(row, retroBundles, isTaken, mode);
	if ("why" in next || !isParked(row)) return next;
	const parked = routeParked(
		parkers.find((p) => p.root === row.root && p.number === row.number),
		seats,
	);
	return "hold" in parked
		? { why: parked.hold }
		: { ...next, parkedRoute: parked };
}

/**
 * The stop that ends launching, checked in this order, or null.
 * @param {TickInput} input
 * @param {ReturnType<typeof pickSeat>} pick
 * @returns {Extract<Decision, {stop: StopReason}> | null}
 */
function stopOf(input, pick) {
	if (input.controlDamaged)
		return { stop: "control-damaged", detail: input.controlDamaged };
	if (input.stopRequested)
		return { stop: "explicit", detail: "stop was requested" };
	if (input.now >= input.startedAt + RUN_MS)
		return {
			stop: "expired",
			detail: `${RUN_HOURS} hours since the last start at ${new Date(input.startedAt).toISOString()}`,
		};
	const stalled = noProgressRun(input);
	if (stalled)
		return {
			stop: "no-progress",
			detail: `no act in the launched session's acts ledger from ${stalled
				.map((r) => `${r.root} #${r.issues.join(", #")}`)
				.join("; ")}`,
		};
	if (pick.seat === null && pick.allCut) {
		const { overflow = [] } = input;
		return {
			stop: "allowance",
			detail:
				overflow.length === 0
					? `every seat reads ${FULL}% of the week`
					: `every plan seat reads ${FULL}% of the week and every overflow key is spent: ${overflowHolds(overflow)}`,
		};
	}
	return null;
}

/**
 * How a parked row launches, from the tick's reading of the session that
 * parked it: resumed in place (#3621); held, a skip with why, where that
 * session's seat reads full, a bar at 100% or a cap sized 0 (#3669); else
 * afresh on its `takes:` command, with why. A seat with an unread bar
 * resumes: the loop refreshes no seat behind the first with room, so a hold
 * there would never end. Residual: a weekly-full seat holds its
 * tickets until its week resets, up to 7 days, and the idle alarm counts no
 * parked issue.
 * @param {ParkerReading|undefined} parker none where no launch of the loop's
 *   parked it
 * @param {SizedSeat[]} seats this tick's
 * @returns {{resume: ResumeTarget} | {hold: string} | {afresh: string}}
 */
function routeParked(parker, seats) {
	if (!parker) return { afresh: "no session that parked it is recorded" };
	if (!parker.sessionId)
		return { afresh: "no session id read for its parking launch" };
	const seat = seats.find((s) => s.seat === parker.launch.seat);
	if (!seat)
		return {
			afresh: `its session's seat ${parker.launch.seat} is not one the loop reads`,
		};
	if (readsFull(seat))
		return { hold: `parked: its session's seat ${seat.seat} is full` };
	const { launch, sessionId, cwd } = parker;
	return { resume: { launch, sessionId, cwd } };
}

/**
 * When `row` was parked, ms; an unreadable start sorts as the oldest, as in
 * pick-next.js's PARKED.
 * @param {MergedRow} row
 */
const parkedMs = (row) => Date.parse(row.parkedAt ?? "") || 0;

/**
 * The ranking as the loop walks it: in normal mode the parked rows first,
 * oldest park first (#3621).
 * @param {MergedRow[]} frontier
 * @param {"normal"|"away"} mode
 */
function walkOrder(frontier, mode) {
	if (mode !== "normal") return frontier;
	const parked = frontier
		.filter(isParked)
		.sort((a, b) => parkedMs(a) - parkedMs(b));
	return [...parked, ...frontier.filter((r) => !isParked(r))];
}

/**
 * Walk the gate judgements, then the ranking, launching up to `slots`. A
 * judgement goes first: its issue is held out of every ranking until one
 * runs. A retro-bundle member launches its whole bundle, at its best-ranked
 * member's place.
 * @param {TickInput} input
 * @param {string} seat
 * @param {number} slots
 */
function fill(
	{ frontier, retroBundles, running, judgements = [], mode, seats, parkers },
	seat,
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
			seat,
			...(gate ? { gate: /** @type {const} */ (true) } : {}),
			...(parkedRoute ? { parkedRoute } : {}),
		});
	};
	for (const j of judgements) {
		if (launches.length >= slots) break;
		if (taken.has(key(j.root, j.number)))
			skipped.push({ root: j.root, number: j.number, why: ALREADY_RUNNING });
		else launch(j.root, [j.number], j.prompt, { gate: true });
	}
	for (const row of walkOrder(frontier, mode)) {
		if (launches.length >= slots) break;
		const next = taken.has(key(row.root, row.number))
			? { why: ALREADY_RUNNING }
			: routedLaunch(row, { retroBundles, mode, seats, parkers }, (n) =>
					taken.has(key(row.root, n)),
				);
		if ("why" in next)
			skipped.push({ root: row.root, number: row.number, why: next.why });
		else
			launch(row.root, next.issues, next.prompt, {
				parkedRoute: next.parkedRoute,
			});
	}
	return { launches, skipped };
}

/**
 * @param {TickInput} input
 * @returns {Decision}
 */
function decideTick(input) {
	const pick = pickSeat(input);
	const stop = stopOf(input, pick);
	if (stop) return stop;
	const present =
		presenceAt(input.lastPromptAt, new Date(input.now)) === "present";
	const free = Math.max(0, input.freeSlots - (present ? 1 : 0));
	/* Ahead of the seat's wait: with no slot free the loop refreshes no seat,
	 * so an aged cache reads unread and is not why the tick waits (#2362). */
	if (free === 0)
		return {
			launches: [],
			skipped: [],
			idle: present ? "one free slot is kept for the founder" : "no free slot",
		};
	if (pick.seat === null)
		return {
			launches: [],
			skipped: [],
			idle: pick.wait,
		};
	/* The cap's fits, so a tick asks no dispatcher call for a member the cap
	 * would drop: each call launches at least one under 100%. */
	const out = fill(input, pick.seat, Math.min(pick.fits, free));
	if (out.launches.length > 0) return { ...out, idle: null };
	const failed = input.failedShortlists ?? [];
	return {
		...out,
		idle:
			failed.length > 0
				? failed
						.map(
							(f) => `${SHORTLIST_FAILED} ${path.basename(f.root)}: ${f.error}`,
						)
						.join("; ")
				: NOTHING_LAUNCHABLE,
	};
}

module.exports = {
	ALREADY_RUNNING,
	FULL,
	NOTHING_LAUNCHABLE,
	RUN_MS,
	UNREAD,
	actsRead,
	buildSkipReason,
	decideTick,
	fitsLaunch,
	hasRoom,
	isParked,
	pickSeat,
};
