/*
 * refill-breaker.js — the refill loop's per-checkout throughput breaker (#5275,
 * spec #5273, ruling #5250). Each tick a checkout's rate is the non-merge
 * commits on its `origin/main` in the trailing 6 h over its loop sessions'
 * working hours in those 6 h. Once 12 working hours have run and the rate is
 * under 0.3 it opens: the loop launches and resumes nothing there, and running
 * sessions carry on. Once no loop session runs there it admits one trial
 * launch; a trial that lands a commit closes it, one that ends without a
 * landing reopens it. A closed breaker counts only from its close. No transition pages anyone (#5268).
 *
 * WORKING TIME is a session's job timeline rows in state `working` or
 * `running`, each counted until the next row, but never past an hour of
 * silence (#5275's measurement). A blocked row (on the
 * founder), and the stopped or done rows a seat-limit hold or a park leaves,
 * count nothing.
 *
 * THE RECORD is a machine-wide JSONL beside the loop's log, one line a
 * transition and a gate-run budget park (lib/refill-budget.js). The breaker's
 * state is folded from it each tick.
 */

const { refillPath } = require("./refill-dir.js");
const { appendRetained } = require("./retained-jsonl.js");

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const BREAKER_WINDOW_MS = 6 * HOUR_MS;
const BREAKER_MIN_HOURS = 12;
const BREAKER_FLOOR = 0.3;
const SILENCE_CAP_MS = HOUR_MS;
/* The gate-run record's own retention (lib/gate-seat.js), so the two records
 * the morning review reads side by side reach back alike. */
const BREAKER_RETAIN_MS = 30 * DAY_MS;
const WORKING_STATES = new Set(["working", "running"]);

/**
 * @typedef {"open"|"trial-start"|"close"|"reopen"|"budget-park"} BreakerEventName
 * @typedef {object} BreakerEvent  one line of the record
 * @property {string} at ISO
 * @property {string} repo the checkout's root
 * @property {BreakerEventName} event
 * @property {number|null} rate commits per working hour, null with none run
 * @property {number} workingHours
 * @property {string} [session] the trial's, or the parked session's
 * @property {number} [ticket] its issue
 *
 * @typedef {{at: string, state: string}} TimelineRow
 * @typedef {{rows: TimelineRow[], endAt: number}} SessionTimeline  a job's
 *   rows, its last counted to `endAt`, its finish or now
 * @typedef {{commits: number, workingHours: number, rate: number|null}} Reading
 *
 * @typedef {{state: "closed", since: number|null}
 *   | {state: "open", since: number}
 *   | {state: "trial", since: number, session: string, ticket: number|null}} BreakerState
 *   `since`, its last close, open or reopen; a trial's is its open's
 *
 * @typedef {{root: string, issues: number[], jobId: string|null,
 *   sessionId?: string, pastSessionIds?: string[], launchedAt: number,
 *   finishedAt: number|null}} BreakerLaunch
 *
 * @typedef {object} ThroughputRead  what a tick reads for the breaker and the
 *   gate-run budget
 * @property {Record<string, {commits: {sha: string, at: number}[]|null,
 *   gateRuns: import("./gate-seat.js").GateRun[]|null}>} byRoot each served
 *   checkout's non-merge `origin/main` commits since its lookback, and its
 *   gate-run record; null where either will not read
 * @property {(l: BreakerLaunch) => SessionTimeline|null} timelineOf
 * @property {(l: BreakerLaunch) => string[]} commitsOf the shas `l`'s
 *   sessions committed in its checkout
 * @property {BreakerEvent[]|null} record null where it will not read
 */

const breakerRecordPath = () => refillPath(".refill-breaker.jsonl");

/**
 * Append each event to the record. Never throws: an event it cannot take is
 * logged.
 * @param {BreakerEvent[]} events
 * @param {(line: string) => void} log
 */
function appendBreakerEvents(events, log) {
	for (const e of events)
		if (!appendRetained(breakerRecordPath(), e, BREAKER_RETAIN_MS))
			log(`breaker record would not take ${e.event} in ${e.repo}`);
}

/**
 * The working milliseconds `sessions` spent in [from, to).
 * @param {SessionTimeline[]} sessions
 * @param {number} from
 * @param {number} to
 */
function workingMsOf(sessions, from, to) {
	let ms = 0;
	for (const { rows, endAt } of sessions)
		for (const [i, row] of rows.entries()) {
			if (!WORKING_STATES.has(row.state)) continue;
			const start = Date.parse(row.at);
			const next = rows[i + 1];
			const end = Math.min(
				next ? Date.parse(next.at) : Math.max(start, endAt),
				start + SILENCE_CAP_MS,
			);
			ms += Math.max(0, Math.min(end, to) - Math.max(start, from));
		}
	return ms;
}

/**
 * A window's reading: the commits in (from, to], and the working hours in it.
 * @param {{commitTimes: number[], sessions: SessionTimeline[], from: number,
 *   to: number}} window
 * @returns {Reading}
 */
function readingOf({ commitTimes, sessions, from, to }) {
	const commits = commitTimes.filter((t) => t > from && t <= to).length;
	const workingHours = workingMsOf(sessions, from, to) / HOUR_MS;
	return {
		commits,
		workingHours,
		rate: workingHours > 0 ? commits / workingHours : null,
	};
}

/** @param {Reading} r */
const isTripping = (r) =>
	r.workingHours >= BREAKER_MIN_HOURS &&
	r.rate !== null &&
	r.rate < BREAKER_FLOOR;

/**
 * The breaker state `events` leave `root` in.
 * @param {BreakerEvent[]} events oldest first
 * @param {string} root
 * @returns {BreakerState}
 */
function foldBreaker(events, root) {
	/** @type {BreakerState} */
	let state = { state: "closed", since: null };
	for (const e of events) {
		if (e.repo !== root) continue;
		const at = Date.parse(e.at);
		if (e.event === "open" || e.event === "reopen")
			state = { state: "open", since: at };
		else if (e.event === "close") state = { state: "closed", since: at };
		else if (e.event === "trial-start" && state.state === "open")
			state = {
				state: "trial",
				since: state.since,
				session: e.session ?? "",
				ticket: e.ticket ?? null,
			};
	}
	return state;
}

/**
 * `l`'s session ids, past ones included.
 * @param {BreakerLaunch} l
 */
const sessionIdsOf = (l) =>
	new Set([...(l.pastSessionIds ?? []), ...(l.sessionId ? [l.sessionId] : [])]);

/**
 * `l`'s ids a record line may name it by: its session ids, and its job id,
 * which a session with no id yet is recorded under.
 * @param {BreakerLaunch} l
 */
const idsOf = (l) => [...(l.jobId ? [l.jobId] : []), ...sessionIdsOf(l)];

/**
 * The earliest time `root`'s reads must reach back to: the window's start, or
 * a live launch's start, so its landing reads whenever it came (#5275).
 * @param {BreakerLaunch[]} launches
 * @param {string} root
 * @param {number} now
 */
const buildLookbackOf = (launches, root, now) =>
	Math.min(
		now - BREAKER_WINDOW_MS,
		...launches
			.filter((l) => l.root === root && l.finishedAt === null)
			.map((l) => l.launchedAt),
	);

/**
 * The latest `origin/main` commit time among `l`'s commits, or null where none
 * of them has landed.
 * @param {BreakerLaunch} l
 * @param {ThroughputRead} read
 * @returns {number|null}
 */
function landedAtOf(l, read) {
	const commits = read.byRoot[l.root]?.commits ?? [];
	const mine = new Set(read.commitsOf(l));
	const times = commits.filter((c) => mine.has(c.sha)).map((c) => c.at);
	return times.length > 0 ? Math.max(...times) : null;
}

/**
 * @param {string} root
 * @param {BreakerEventName} event
 * @param {{reading: Reading, now: number}} at
 * @param {BreakerLaunch} [l]
 * @returns {BreakerEvent}
 */
const buildEvent = (root, event, { reading, now }, l) => ({
	at: new Date(now).toISOString(),
	repo: root,
	event,
	rate: reading.rate,
	workingHours: Math.round(reading.workingHours * 100) / 100,
	...(l
		? {
				session: l.sessionId ?? l.jobId ?? "",
				...(l.issues[0] === undefined ? {} : { ticket: l.issues[0] }),
			}
		: {}),
});

/**
 * One checkout's step: the event its breaker takes this tick, if any, and the
 * launch room it leaves there, null where it bars nothing.
 * @param {{root: string, state: BreakerState, launches: BreakerLaunch[],
 *   reading: Reading|null, read: ThroughputRead, now: number}} step
 *   `reading`, null where its commits will not read, which moves a closed
 *   breaker nowhere
 * @returns {{event: BreakerEvent|null, room: number|null}}
 */
function stepBreaker({ root, state, launches, reading, read, now }) {
	const none = { commits: 0, workingHours: 0, rate: null };
	const r = reading ?? none;
	const mine = launches.filter((l) => l.root === root);
	if (state.state === "closed")
		return reading && isTripping(reading)
			? { event: buildEvent(root, "open", { reading, now }), room: 0 }
			: { event: null, room: null };
	if (state.state === "open") {
		const trial = mine
			.filter((l) => l.launchedAt > state.since)
			.toSorted((a, b) => a.launchedAt - b.launchedAt)[0];
		if (trial)
			return {
				event: buildEvent(root, "trial-start", { reading: r, now }, trial),
				room: 0,
			};
		return { event: null, room: mine.some(isRunning) ? 0 : 1 };
	}
	const trial = mine.find(
		(l) => l.launchedAt > state.since && idsOf(l).includes(state.session),
	);
	if (trial && landedAtOf(trial, read) !== null)
		return {
			event: buildEvent(root, "close", { reading: r, now }, trial),
			room: null,
		};
	if (!trial || trial.finishedAt !== null)
		return {
			event: buildEvent(root, "reopen", { reading: r, now }, trial),
			room: 0,
		};
	return { event: null, room: 0 };
}

/** @param {BreakerLaunch} l */
const isRunning = (l) => l.finishedAt === null;

/**
 * The timelines of `root`'s loop sessions that ran after `from`.
 * @param {BreakerLaunch[]} launches
 * @param {string} root
 * @param {number} from
 * @param {ThroughputRead} read
 * @returns {SessionTimeline[]}
 */
const sessionsOf = (launches, root, from, read) =>
	launches
		.filter(
			(l) =>
				l.root === root &&
				l.jobId !== null &&
				(l.finishedAt === null || l.finishedAt > from),
		)
		.flatMap((l) => {
			const timeline = read.timelineOf(l);
			return timeline ? [timeline] : [];
		});

/**
 * Every served checkout's breaker step: the events to record, and the launch
 * room each open breaker leaves, by root. An unread record leaves no room
 * anywhere, since no breaker's state can be known.
 * @param {{roots: string[], launches: BreakerLaunch[], read: ThroughputRead,
 *   now: number}} tick
 * @returns {{events: BreakerEvent[], room: Record<string, number>}}
 */
function stepBreakers({ roots, launches, read, now }) {
	/** @type {BreakerEvent[]} */
	const events = [];
	/** @type {Record<string, number>} */
	const room = {};
	const { record } = read;
	if (record === null)
		return { events, room: Object.fromEntries(roots.map((r) => [r, 0])) };
	for (const root of roots) {
		const state = foldBreaker(record, root);
		const commits = read.byRoot[root]?.commits ?? null;
		const from = Math.max(
			now - BREAKER_WINDOW_MS,
			state.state === "closed" ? (state.since ?? 0) : 0,
		);
		const reading = commits
			? readingOf({
					commitTimes: commits.map((c) => c.at),
					sessions: sessionsOf(launches, root, from, read),
					from,
					to: now,
				})
			: null;
		const step = stepBreaker({ root, state, launches, reading, read, now });
		if (step.event) events.push(step.event);
		if (step.room !== null) room[root] = step.room;
	}
	return { events, room };
}

/**
 * A checkout's breaker state at `at`, by the record's events up to then.
 * @param {BreakerEvent[]} events
 * @param {string} root
 * @param {number} at
 */
const foldBreakerAt = (events, root, at) =>
	foldBreaker(
		events.filter((e) => Date.parse(e.at) <= at),
		root,
	);

module.exports = {
	appendBreakerEvents,
	breakerRecordPath,
	buildLookbackOf,
	foldBreakerAt,
	landedAtOf,
	sessionIdsOf,
	stepBreakers,
	workingMsOf,
};
