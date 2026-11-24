const { refillPath } = require("./refill-dir.js");
const { QUEUE_EXIT_RETAIN_MS } = require("./queue-exit-log.js");
const { appendRetained } = require("./retained-jsonl.js");

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
/* Ruling workflow-core#5250, read off its measured 14-day curve. */
const BREAKER_WINDOW_MS = 6 * HOUR_MS;
const BREAKER_MIN_HOURS = 12;
const BREAKER_FLOOR = 0.3;

// guess, workflow-core#5275
const SILENCE_CAP_MS = HOUR_MS;
// workflow-core#5275
const BREAKER_RETAIN_MS = QUEUE_EXIT_RETAIN_MS;
const WORKING_STATES = new Set(["working", "running"]);

/**
 * @typedef {"open"|"trial-start"|"close"|"reopen"|"budget-park"} BreakerEventName
 * @typedef {object} BreakerEvent
 * @property {string} at
 * @property {string} repo
 * @property {BreakerEventName} event
 * @property {number|null} rate
 * @property {number} workingHours
 * @property {string} [session]
 * @property {number} [ticket]
 * @typedef {{at: string, state: string}} TimelineRow
 * @typedef {{rows: TimelineRow[], endAt: number}} SessionTimeline
 * @typedef {{commits: number, workingHours: number, rate: number|null}} Reading
 * @typedef {{state: "closed", since: number|null}
 *   | {state: "open", since: number}
 *   | {state: "trial", since: number, session: string, ticket: number|null}} BreakerState
 * @typedef {{root: string, seat: string, issues: number[], jobId: string|null,
 *   sessionId?: string, pastSessionIds?: string[], launchedAt: number,
 *   finishedAt: number|null}} BreakerLaunch
 * @typedef {{state: "landed"|"waiting"|"gone"}
 *   | {state: "unread", why: string}} TrialQueue
 * @typedef {object} ThroughputRead
 * @property {Record<string, {commits: {sha: string, at: number}[]|null,
 *   gateRuns: import("./gate-seat.js").GateRun[]|null,
 *   suiteCommand: string|null,
 *   sessions: SessionTimeline[], timelinesUnread: string[]}>} byRoot
 * @property {(l: BreakerLaunch) => string[]|null} commitsOf
 * @property {(l: BreakerLaunch) => TrialQueue} queueOf
 * @property {BreakerEvent[]|null} record
 */

const breakerRecordPath = () => refillPath(".refill-breaker.jsonl");

/**
 * @param {BreakerEvent[]} events
 * @param {(line: string) => void} log
 */
function appendBreakerEvents(events, log) {
	for (const e of events)
		if (!appendRetained(breakerRecordPath(), e, BREAKER_RETAIN_MS))
			log(`breaker record would not take ${e.event} in ${e.repo}`);
}

/**
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
 * @param {BreakerEvent[]} events
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

/** @param {BreakerLaunch} l */
const sessionIdsOf = (l) =>
	new Set([...(l.pastSessionIds ?? []), ...(l.sessionId ? [l.sessionId] : [])]);

/** @param {BreakerLaunch} l */
const idsOf = (l) => [...(l.jobId ? [l.jobId] : []), ...sessionIdsOf(l)];

/**
 * @param {BreakerLaunch[]} launches
 * @param {string} root
 * @param {number} now
 * @param {BreakerEvent[]|null} record
 */
function buildLookbackOf(launches, root, now, record) {
	const state = record === null ? null : foldBreaker(record, root);
	const trial = state?.state === "trial" ? state.session : null;
	return Math.min(
		now - BREAKER_WINDOW_MS,
		...launches
			.filter(
				(l) =>
					l.root === root &&
					(isRunning(l) || (trial !== null && idsOf(l).includes(trial))),
			)
			.map((l) => l.launchedAt),
	);
}

/**
 * @param {BreakerLaunch} l
 * @param {ThroughputRead} read
 * @returns {{at: number|null, committed: boolean} | {unread: string}}
 */
function landingOf(l, read) {
	const commits = read.byRoot[l.root]?.commits ?? null;
	if (commits === null) return { unread: "origin/main will not read" };
	const shas = read.commitsOf(l);
	if (shas === null) return { unread: "its commit ledger will not read" };
	const mine = new Set(shas);
	const times = commits.filter((c) => mine.has(c.sha)).map((c) => c.at);
	return {
		at: times.length > 0 ? Math.max(...times) : null,
		committed: shas.length > 0,
	};
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
 * @param {{root: string, state: BreakerState, launches: BreakerLaunch[],
 *   reading: Reading|null, read: ThroughputRead, now: number}} step
 * @returns {{event: BreakerEvent|null, room: number|null, note?: string}}
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
			.filter((l) => l.launchedAt > state.since && idsOf(l).length > 0)
			.toSorted((a, b) => a.launchedAt - b.launchedAt)[0];
		if (trial)
			return {
				event: buildEvent(root, "trial-start", { reading: r, now }, trial),
				room: 0,
			};
		return {
			event: null,
			room: mine.some(isRunning) ? 0 : 1,
			...idlessNote(root, mine),
		};
	}
	return stepTrial({ root, state, mine, reading: r, read, now });
}

/**
 * @param {{root: string, state: Extract<BreakerState, {state: "trial"}>,
 *   mine: BreakerLaunch[], reading: Reading, read: ThroughputRead,
 *   now: number}} step
 * @returns {{event: BreakerEvent|null, room: number|null, note?: string}}
 */
function stepTrial({ root, state, mine, reading, read, now }) {
	const trial = mine.find(
		(l) => l.launchedAt > state.since && idsOf(l).includes(state.session),
	);
	if (!trial)
		return { event: buildEvent(root, "reopen", { reading, now }), room: 0 };
	const outcome = trialOutcomeOf(trial, read);
	if (outcome === "close" || outcome === "reopen")
		return {
			event: buildEvent(root, outcome, { reading, now }, trial),
			room: outcome === "close" ? null : 0,
		};
	if (outcome === "running") return { event: null, room: 0 };
	const why =
		outcome === "queued"
			? "its commits wait in the landing queue"
			: outcome.unread;
	return {
		event: null,
		room: 0,
		note: `breaker trial ${state.session} in ${root} held in trial: ${why}`,
	};
}

/**
 * @param {BreakerLaunch} trial
 * @param {ThroughputRead} read
 * @returns {"close"|"reopen"|"running"|"queued"|{unread: string}}
 */
function trialOutcomeOf(trial, read) {
	const landing = landingOf(trial, read);
	if ("at" in landing && landing.at !== null) return "close";
	if (trial.finishedAt === null) return "running";
	if (!("at" in landing)) return landing;
	if (!landing.committed) return "reopen";
	const queue = read.queueOf(trial);
	if (queue.state === "unread") return { unread: queue.why };
	if (queue.state === "landed") return "close";
	return queue.state === "waiting" ? "queued" : "reopen";
}

/** @param {BreakerLaunch} l */
const isRunning = (l) => l.finishedAt === null && l.jobId !== null;

/**
 * @param {string} root
 * @param {BreakerLaunch[]} mine
 * @returns {{note?: string}}
 */
function idlessNote(root, mine) {
	const idless = mine.filter((l) => l.finishedAt === null && l.jobId === null);
	if (idless.length === 0) return {};
	const at = idless.map((l) => new Date(l.launchedAt).toISOString());
	return {
		note: `open breaker in ${root} waits on no launch without a job id: ${idless.length} launched at ${at.join(", ")}, never judged finished`,
	};
}

/**
 * @param {string} root
 * @param {BreakerState} state
 * @param {ThroughputRead} read
 * @param {number} now
 * @returns {{reading: Reading|null, note?: string}}
 */
function rootReading(root, state, read, now) {
	const commits = read.byRoot[root]?.commits ?? null;
	const unread = read.byRoot[root]?.timelinesUnread ?? [];
	const closed = state.state === "closed";
	const note =
		unread.length === 0
			? {}
			: {
					note: `breaker reading in ${root} leaves out ${unread.join(", ")}${closed ? ", so it opens nothing" : ""}`,
				};
	if (commits === null || (closed && unread.length > 0))
		return { reading: null, ...note };
	return {
		reading: readingOf({
			commitTimes: commits.map((c) => c.at),
			sessions: read.byRoot[root]?.sessions ?? [],
			from: Math.max(now - BREAKER_WINDOW_MS, closed ? (state.since ?? 0) : 0),
			to: now,
		}),
		...note,
	};
}

/**
 * @param {{roots: string[], launches: BreakerLaunch[], read: ThroughputRead,
 *   now: number}} tick
 * @returns {{events: BreakerEvent[], room: Record<string, number>,
 *   notes: string[]}}
 */
function stepBreakers({ roots, launches, read, now }) {
	/** @type {BreakerEvent[]} */
	const events = [];
	/** @type {string[]} */
	const notes = [];
	/** @type {Record<string, number>} */
	const room = {};
	const { record } = read;
	if (record === null)
		return {
			events,
			room: Object.fromEntries(roots.map((r) => [r, 0])),
			notes,
		};
	for (const root of roots) {
		const state = foldBreaker(record, root);
		const { reading, note } = rootReading(root, state, read, now);
		if (note) notes.push(note);
		const step = stepBreaker({ root, state, launches, reading, read, now });
		if (step.event) events.push(step.event);
		if (step.note) notes.push(step.note);
		if (step.room !== null) room[root] = step.room;
	}
	return { events, room, notes };
}

/**
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
	BREAKER_RETAIN_MS,
	SILENCE_CAP_MS,
	appendBreakerEvents,
	breakerRecordPath,
	buildLookbackOf,
	foldBreakerAt,
	landingOf,
	sessionIdsOf,
	stepBreakers,
	workingMsOf,
};
