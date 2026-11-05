/*
 * seat-reading.js — a seat's reading, its cap sizing and the overflow seats'
 * readings, for the refill loop's two readers of them: the tick
 * (lib/refill-tick.js) and the CLI's status view (scripts/refill-loop.js's
 * readSeatsView, behind `status --json` and `start`'s and `set`'s seats line)
 * (#4218). A seat's identity is lib/refill-seats.js's.
 *
 * The readings and their sizing are pure over their inputs. The reads are
 * readSeat, off lib/allowance.js, and readCap, through the `allowance.js --cap`
 * child dispatch-sessions.sh runs; readSizedSeats takes its read, probe and
 * sizing as arguments, and overflowReadings its key budgets, so each caller
 * picks its own: the tick probes stale seats and reads each budget afresh, the
 * status view probes none (#3733) and memoises each key's budget (#4169).
 */

const path = require("node:path");
const {
	isTrustworthy,
	readAllowance,
	sizedPercent,
} = require("./allowance.js");
const { CHILD_TIMEOUT_MS, spawnChild } = require("./child-spawn.js");
const { localDate } = require("./morning-review.js");
const { isBudgetSpent } = require("./overflow-budget-core.js");
const {
	FULL,
	fitsLaunch,
	hasRoom,
	orderPlanSeats,
} = require("./refill-decide.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { isSameSeat } = require("./refill-seats.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { hasResetPassed } = require("./usage-cache.js");

/** @typedef {import("./refill-decide.js").SeatReading} SeatReading */
/** @typedef {import("./refill-decide.js").SizedSeat} SizedSeat */
/** @typedef {{seat: string, outcome: string}} Probe */

const SCRIPTS = path.dirname(__dirname);

/* dispatch-sessions.sh's WEEK_CEILING and SESSION_CEILING defaults, the
 * thresholds its cap sizes a launch past; its test pins the two copies
 * together. */
const DEFAULT_CEILINGS = { week: 97, session: 90 };

/**
 * dispatch-sessions.sh's cap thresholds, from the variables it reads.
 * @param {Record<string, string | undefined>} env
 */
const ceilingsOf = (env) => ({
	week: Number(env.WFC_DISPATCH_WEEK_CEILING || DEFAULT_CEILINGS.week),
	session: Number(env.WFC_DISPATCH_SESSION_CEILING || DEFAULT_CEILINGS.session),
});

/**
 * Whether a bar is full: it reads 100% fresh, or, unfresh, its cached percent
 * is 100 and its cached reset is still ahead: a locked seat's bars age without
 * refreshing, and neither reopens before its reset (#2606). A passed or
 * unparsed reset leaves it unread.
 * @param {import("./allowance.js").Bar} bar
 * @param {number} now
 */
const isBarFull = (bar, now) =>
	bar.percent !== null &&
	bar.percent >= FULL &&
	(bar.trust === "fresh" || Date.parse(bar.resetsAt ?? "") > now);

/**
 * A seat's reading from lib/allowance.js's bars, each full by isBarFull. The
 * weekly reset is kept whatever the bar's trust (#3732); one passed or unparsed
 * reads as unread. Each bar reads `sizedPercent`'s figure.
 * @param {string} seat
 * @param {{session: import("./allowance.js").Bar,
 *   weekly_all: import("./allowance.js").Bar}} bars
 * @param {number} now
 * @returns {SeatReading}
 */
function seatReadingOf(seat, { session, weekly_all: week }, now) {
	const sessionFull = isBarFull(session, now);
	const weekResets = Date.parse(week.resetsAt ?? "");
	/* A window that has rolled is at 0, as seat-utilisation.js's effectiveSevenDay
	 * has it (#4106). A fresh bar's reset can be a printed date Date.parse misreads. */
	const rolled = week.trust !== "fresh" && hasResetPassed(week.resetsAt, now);
	return {
		/* An unstamped bar is a printed `/usage`, read now, or unread. */
		readAt: Math.min(session.fetchedAtMs ?? now, week.fetchedAtMs ?? now),
		seat,
		week: sizedPercent(week),
		session: sizedPercent(session),
		weekFull: isBarFull(week, now),
		sessionFull,
		sessionResets: session.resetsAt,
		weekResets: weekResets > now ? weekResets : null,
		weekRead: {
			percent: rolled ? 0 : week.percent,
			/* A printed `/usage` carries no time: it was read just now. */
			atMs: week.fetchedAtMs ?? (week.trust === "fresh" ? now : null),
			rolled,
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
		const due = resumable.filter((r) => isSameSeat(r, s)).length;
		const sized =
			s.fits === null && hasRoom(s) && (due > 0 || !spare)
				? { ...s, fits: sizeOf(s.seat, slots) }
				: s;
		spare ||= hasRoom(sized) && (sized.fits ?? 0) > due;
		return sized;
	});
}

/**
 * `seats` with each parker's seat that has room but no cap sized, sized for
 * one resume: only the first seat with room is sized for the decision, and a
 * resume is held to the same cap as a launch (#3669). A marker naming an
 * overflow key on a plan seat's dir sizes none of that plan seat's cap
 * (#4147). In away mode, where none resumes, a cap sized 0 still reads full
 * for the idle alarm's hold (#3850).
 * @param {SizedSeat[]} seats
 * @param {import("./refill-decide.js").ParkerReading[]} parkers
 * @param {(seat: string, members: number) => number|null} sizeOf
 * @returns {SizedSeat[]}
 */
const sizeParkerSeats = (seats, parkers, sizeOf) =>
	seats.map((s) =>
		s.fits === null &&
		hasRoom(s) &&
		parkers.some((p) => p.job && isSameSeat(p.job, s))
			? { ...s, fits: sizeOf(s.seat, 1) }
			: s,
	);

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
 * The seats to read for the panel's figures, apart from the launch walk and
 * whatever the machine's slots (#4060). A week read full stays full until its
 * reset. Else a seat is due where its last reading or try predates its passed
 * reset, is a day old (the founder's limit on a read with no reason to think the
 * figure moved), or has had a session run since.
 * @param {string[]} seats
 * @param {{barsOf: (seat: string) => ReturnType<
 *     typeof import("./allowance.js").readAllowance>,
 *   triedAt: Record<string, number>,
 *   hasRunSince: (seat: string, sinceMs: number) => boolean, now: number}} io
 * @returns {string[]}
 */
function seatsDueRead(seats, { barsOf, triedAt, hasRunSince, now }) {
	return seats.filter((seat) => {
		const bars = barsOf(seat);
		const week = bars.weekly_all;
		const resets = Date.parse(week.resetsAt ?? "");
		if (isBarFull(week, now) || isTrustworthy(bars)) return false;
		const last = Math.max(week.fetchedAtMs ?? 0, triedAt[seat] ?? 0);
		return (
			(resets <= now && resets > last) ||
			now - last >= DAY_MS ||
			hasRunSince(seat, last)
		);
	});
}

/**
 * `triedAt` with each probe that ran stamped `now`.
 * @param {Record<string, number>} triedAt
 * @param {Probe[]} probes
 * @param {number} now
 */
const seatTriedAfter = (triedAt, probes, now) => ({
	...triedAt,
	...Object.fromEntries(
		probes.filter((p) => p.outcome !== "cached").map((p) => [p.seat, now]),
	),
});

/**
 * Each overflow seat's reading for the decision core, its budget read only
 * once every plan seat is weekly-full, the one state it launches in (#2570).
 * A key is spent for its cycle where Anthropic refused it for credit, or
 * where its settled spend leaves under one launch's reservation, which no
 * running session's end reopens. A seat file that refuses reads as one
 * unread seat, so the tick waits on it (#2611).
 * @param {import("./refill-seats.js").SeatList} list
 * @param {SeatReading[]} plan
 * @param {(seat: import("./refill-seats.js").OverflowSeat) =>
 *   import("./overflow-budget-core.js").Budget|{why: string}} budgetOf
 *   lib/overflow-budget.js's seatBudget
 * @returns {import("./refill-decide.js").OverflowReading[]}
 */
function overflowReadings(list, plan, budgetOf) {
	/** @param {import("./overflow-budget-core.js").Budget} b */
	const spentUntilText = (b) =>
		b.readAt === null
			? localDate(new Date(b.nextCycleStart))
			: "a newer Console reading";
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
	 * can serve sizes no key to launch on. */
	const due = plan.every((s) => s.weekFull);
	/** @type {import("./refill-seats.js").OverflowSeat[]} */
	const seats = list.seats.flatMap((s) => (s.kind === "overflow" ? [s] : []));
	return seats.map((seat) => {
		const unread = {
			seat: seat.dir,
			keyVar: seat.keyVar,
			fits: null,
			spentUntil: null,
		};
		if (!due) return { ...unread, why: "a plan seat is not weekly-full" };
		const b = budgetOf(seat);
		if ("why" in b) return { ...unread, why: b.why };
		return {
			seat: seat.dir,
			keyVar: seat.keyVar,
			fits: b.fit,
			headroomUsd: b.headroomUsd,
			spentUntil: isBudgetSpent(b) ? spentUntilText(b) : null,
			why: null,
		};
	});
}

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
 * A seat's bars off lib/allowance.js and its reading off them. `usageText`, a
 * printed `/usage`, stands in for a stale cache.
 * @param {string} seat
 * @param {number} now
 * @param {string} [usageText]
 */
function readSeat(seat, now, usageText) {
	const bars = readAllowance({ configDir: seat, usageText, now });
	return { bars, reading: seatReadingOf(seat, bars, now) };
}

/**
 * Each seat's reading; `usage` maps a seat to a printed `/usage`.
 * @param {string[]} seats
 * @param {Map<string, string>} [usage]
 * @param {number} [now]
 * @returns {SeatReading[]}
 */
const readSeatReadings = (seats, usage = new Map(), now = Date.now()) =>
	seats.map((seat) => readSeat(seat, now, usage.get(seat)).reading);

/**
 * How many of `members` the dispatcher's allowance cap launches on `seat`,
 * read through the `allowance.js --cap` call it makes, fed the seat's printed
 * `/usage` as the dispatcher feeds its probe's, run in `root` as the
 * dispatcher runs in the checkout it launches into, so both read that host's
 * cost table (#2937); null where it cannot be sized.
 * @param {string|undefined} root
 * @param {string} seat
 * @param {number} members
 * @param {string} usageText
 * @returns {{fits: number, why?: undefined, fault?: undefined}
 *   | {fits: null, why: string, fault: boolean}}
 */
function readCap(root, seat, members, usageText) {
	if (root === undefined)
		return {
			fits: null,
			why: "the loop serves no checkout to size it in",
			fault: true,
		};
	const r = spawnChild(
		process.execPath,
		[
			path.join(SCRIPTS, "allowance.js"),
			...capArgs(seat, members, ceilingsOf(process.env)),
		],
		{
			timeout: CHILD_TIMEOUT_MS,
			input: usageText,
			cwd: root,
			env: { ...buildCheckoutEnv(root), CLAUDE_CONFIG_DIR: seat },
		},
	);
	const cap = parseCapFits(r.stdout);
	if (cap.fits !== null || !r.failed) return cap;
	return { fits: null, why: `${cap.why} (${r.failed})`, fault: true };
}

/**
 * The line naming a cap unsized; a fault where it could not be sized off a
 * trustworthy reading.
 * @param {string} seat
 * @param {{why: string, fault: boolean}} cap
 */
const buildCapUnsizedLine = (seat, cap) =>
	`${cap.fault ? "fault: " : ""}cap on ${seat} unsized: ${cap.why}`;

/**
 * readCap's count in `root`, with `note` given the line naming a cap unsized:
 * readSizedSeats's `sizeOf`.
 * @param {string|undefined} root
 * @param {(line: string) => void} note
 * @returns {(seat: string, members: number, usageText?: string) => number|null}
 */
const capSizer =
	(root, note) =>
	(seat, members, usageText = "") => {
		const cap = readCap(root, seat, members, usageText);
		if (cap.fits === null) note(buildCapUnsizedLine(seat, cap));
		return cap.fits;
	};

module.exports = {
	capArgs,
	capSizer,
	ceilingsOf,
	overflowReadings,
	parseCapFits,
	readSeat,
	readSeatReadings,
	readSizedSeats,
	seatReadingOf,
	seatsDueRead,
	seatTriedAfter,
	sizeParkerSeats,
	sizeResumeSeats,
};
