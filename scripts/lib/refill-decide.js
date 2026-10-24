/*
 * refill-decide.js — away mode's decision core (#2007, spec #1995): one pure
 * function from a tick's readings to either the launches to make or the stop
 * that ends launching.
 *
 * Caller: scripts/refill-loop.js's tick (#2012)
 */

const { PARKED_LABEL } = require("./parked.js");
const { presenceAt } = require("./presence.js");

/* Spec #1995's stops: 24 hours after the last start (#1918), and three
 * finishes in a row with no progress (#1920). */
const RUN_HOURS = 24;
const RUN_MS = RUN_HOURS * 60 * 60 * 1000;
const NO_PROGRESS_RUN = 3;
/* A finish whose acts could not be read, counted neither as progress nor as
 * no progress (#2312). */
const UNREAD = "unread";
const WAITING_LABEL = "waiting:external";
/* `human` and `children` are absent: neither has a command to launch. */
const LAUNCHABLE = new Set([
	"implement",
	"wayfinder",
	"to-spec",
	"to-tickets",
	"triage",
]);
/* Spec #1995's launch list names these and untyped for a `takes:wayfinder`
 * row, so a map at `takes:wayfinder` is skipped and its children launch on
 * their own; a map at any other kind launches (#1920, #2639). */
const WAYFINDER_TYPES = new Set(["research", "task", "grilling", "prototype"]);
const WAYFINDER_PREFIX = "wayfinder:";
/* Sonnet's founder check does not happen while he is away (#1920). */
const MODEL = "opus";
/* A bar reading this refuses the dispatcher's launch (#371); under it, its
 * cap sizes the launch (#2278). Residual: past the cap's thresholds the margin
 * left is the cap's projection alone, which the per-call floor of one can
 * overrun. */
const FULL = 100;
/* The idle reason of a tick that walked its frontier and launched nothing. */
const NOTHING_LAUNCHABLE = "nothing launchable";
/* A row a running launch already holds, skipped as any other so an idle
 * tick's log can count it (#2561). */
const ALREADY_RUNNING = "already running";

/** @typedef {import("./frontier-order.js").FrontierRow & {root: string, takes: string[], labels: string[]}} MergedRow */
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
 */

/**
 * @typedef {object} TickInput
 * @property {number} now ms
 * @property {number} startedAt ms, the last `start` or renewal
 * @property {boolean} stopRequested
 * @property {MergedRow[]} frontier lib/frontier-order.js's merged ranking
 * @property {MergedBundle[]} retroBundles
 * @property {{root: string, issues: number[]}[]} running
 * @property {number} freeSlots admission's count
 * @property {number|null} lastPromptAt ms of the founder's last typed prompt
 * @property {SizedSeat[]} seats in failover order
 * @property {LaunchRecord[]} history
 * @property {import("./gate-sweep.js").Judgement[]} [judgements] the gate
 *   sweep's queue, launched ahead of the ranking (#2279)
 */

/**
 * @typedef {object} Launch
 * @property {string} root the checkout the dispatcher runs in
 * @property {number[]} issues
 * @property {string} prompt
 * @property {"opus"} model
 * @property {string} seat
 */

/** @typedef {"explicit" | "expired" | "no-progress" | "allowance"} StopReason */

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
 * unread one is passed over. A renewal starts the count afresh, or a restart
 * after this stop would stop at once.
 * @param {TickInput} input
 */
function noProgressRun({ history, startedAt }) {
	const recent = history
		.filter(
			(r) =>
				r.finishedAt !== null && r.launchedAt >= startedAt && r.acts !== UNREAD,
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
 * Whether the loop launches on a seat: room on both bars and a cap sized
 * above 0.
 * @template {{week: number|null, session: number|null, fits: number|null}} S
 * @param {S} s
 * @returns {s is S & {fits: number}}
 */
const fitsLaunch = (s) => hasRoom(s) && s.fits !== null && s.fits > 0;

/**
 * The first seat with room whose cap fits a launch, else whether every seat
 * is weekly-full, and why the tick waits where not. A seat full on its 5-hour
 * bar alone reopens at that bar's reset, so the tick waits through it (#2606).
 * A seat with no fresh reading, no sized cap or a cap sized 0 stops nothing
 * either: the dispatcher refuses the first two, so the tick waits rather than
 * stopping the run on a stale cache, and running sessions finishing reopen
 * the third's headroom (#2432). An unsized seat names the wait: the loop
 * probes no seat behind it, so an unread one there was never refreshed
 * (#2362).
 * @param {TickInput} input
 */
function pickSeat({ seats }) {
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

/** @param {MergedRow} row */
function skipReason(row) {
	if (row.labels.includes(PARKED_LABEL)) return "parked";
	if (row.labels.includes(WAITING_LABEL)) return WAITING_LABEL;
	const [kind, ...more] = row.takes;
	if (kind === undefined || more.length > 0)
		return `takes:${row.takes.join("+") || "none"}`;
	if (!LAUNCHABLE.has(kind)) return `takes:${kind}`;
	if (kind !== "wayfinder") return null;
	const type = row.labels.find(
		(l) =>
			l.startsWith(WAYFINDER_PREFIX) &&
			!WAYFINDER_TYPES.has(l.slice(WAYFINDER_PREFIX.length)),
	);
	return type ?? null;
}

/**
 * What one ranked row launches, its whole retro bundle where it sits in one,
 * or why it is skipped.
 * @param {MergedRow} row
 * @param {MergedBundle[]} retroBundles
 * @param {(n: number) => boolean} isTaken
 * @returns {{issues: number[], prompt: string} | {why: string}}
 */
function rowLaunch(row, retroBundles, isTaken) {
	const why = skipReason(row);
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
 * The stop that ends launching, checked in this order, or null.
 * @param {TickInput} input
 * @param {ReturnType<typeof pickSeat>} pick
 * @returns {Extract<Decision, {stop: StopReason}> | null}
 */
function stopOf(input, pick) {
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
	if (pick.seat === null && pick.allCut)
		return {
			stop: "allowance",
			detail: `every seat reads ${FULL}% of the week`,
		};
	return null;
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
	{ frontier, retroBundles, running, judgements = [] },
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
	/** @param {string} root @param {number[]} issues @param {string} prompt */
	const launch = (root, issues, prompt) => {
		for (const n of issues) taken.add(key(root, n));
		launches.push({ root, issues, prompt, model: MODEL, seat });
	};
	for (const j of judgements) {
		if (launches.length >= slots) break;
		if (taken.has(key(j.root, j.number)))
			skipped.push({ root: j.root, number: j.number, why: ALREADY_RUNNING });
		else launch(j.root, [j.number], j.prompt);
	}
	for (const row of frontier) {
		if (launches.length >= slots) break;
		const next = taken.has(key(row.root, row.number))
			? { why: ALREADY_RUNNING }
			: rowLaunch(row, retroBundles, (n) => taken.has(key(row.root, n)));
		if ("why" in next)
			skipped.push({ root: row.root, number: row.number, why: next.why });
		else launch(row.root, next.issues, next.prompt);
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
	return {
		...out,
		idle: out.launches.length === 0 ? NOTHING_LAUNCHABLE : null,
	};
}

module.exports = {
	ALREADY_RUNNING,
	FULL,
	NOTHING_LAUNCHABLE,
	RUN_MS,
	UNREAD,
	actsRead,
	decideTick,
	fitsLaunch,
	hasRoom,
};
