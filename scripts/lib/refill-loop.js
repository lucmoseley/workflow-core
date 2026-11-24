const path = require("node:path");
const { parseAct } = require("./act-line.js");
const { localDate } = require("./local-date.js");
const { REVIEW_HOUR } = require("./review-hour.js");
const { isTerminalAgent } = require("./agent-liveness.js");
const {
	EXPLICIT_STOP_DETAIL,
	buildIdleText,
	startedAt,
	UNREAD,
} = require("./refill-decide.js");
const { isHeld, isLive, launchName } = require("./refill-block-core.js");
const {
	buildChildLine,
	LISTING_GRACE_MS,
	markParked,
} = require("./refill-blocks.js");
const { limitWaitOf } = require("./refill-limits.js");
const { isRecord, parseGoal, parseStrings } = require("./refill-goal.js");
const { buildSeatName } = require("./refill-seats.js");

/**
 * @typedef {object} Control
 * @property {number} noProgressFrom
 * @property {boolean} stopRequested
 * @property {number} [stopRequestedAt]
 * @property {import("./refill-decide.js").Pause} [paused]
 * @property {Record<string, import("./refill-decide.js").Pause>} [repoPaused]
 * @property {import("./refill-decide.js").LaunchHold} [launchHold]
 * @property {import("./refill-decide.js").AwaySwitch} [away]
 * @property {string[]} seats
 * @property {Scope} scope
 */

/**
 * @typedef {object} ControlRead
 * @property {Control|null} control
 * @property {string|null} damaged
 */

/**
 * @typedef {object} Scope
 * @property {"normal"|"away"} mode
 * @property {string[]} repos
 * @property {import("./refill-goal.js").Goal|null} goal
 */

/**
 * @typedef {import("./refill-decide.js").LaunchRecord & {
 *   prompt: string, seat: string, keyVar?: string, jobId: string|null,
 *   parked?: boolean, block?: import("./block-act.js").Block,
 *   parkedAway?: boolean, sessionId?: string,
 *   resumes?: import("./refill-blocks.js").Resumes,
 *   idleResumes?: import("./refill-blocks.js").IdleResumes, idleSince?: number,
 *   stepResume?: import("./refill-blocks.js").StepResume, bootResumedAt?: number,
 *   blockUnread?: true,
 *   limitHeld?: import("./refill-limits.js").LimitHeld,
 *   limitResumes?: import("./refill-limits.js").LimitResumes,
 *   limitLeft?: import("./refill-decide.js").SeatLeft[],
 *   limitParks?: number, handOffTries?: number, handedOff?: number, budgetParked?: number, copiedFrom?: string,
 *   relaunchedAt?: number, slotTakenAt?: number, movedAt?: number, pastSessionIds?: string[],
 *   resumeStarted?: import("./refill-blocks.js").ResumeStarted, leftListing?: true,
 *   synthetic?: import("./refill-synthetic.js").SyntheticResumes,
 *   unretired?: import("./refill-blocks.js").Unretired[],
 *   actsBefore?: Record<string, number>|typeof UNREAD}} LoopLaunch
 * @typedef {(sessionId: string, roots: string[]) =>
 *   {acts: string[], unreadable: string[]}} ReadActsBy
 * @typedef {(sessionId: string, roots: string[]) =>
 *   {at: number|null, unreadable: string[]}} ReadLastActAt
 */

/** @typedef {import("./refill-state.js").LoopState} LoopState */
/** @typedef {import("./refill-state.js").LaunchCount} LaunchCount */
/** @typedef {import("./refill-state.js").Hold} Hold */
/** @typedef {import("./refill-batch.js").BatchOutcome} BatchOutcome */

/**
 * @param {unknown} raw
 * @returns {Scope}
 */
function parseScope(raw) {
	const r = isRecord(raw) ? raw : {};
	return {
		mode: r.mode === "normal" ? "normal" : "away",
		repos: parseStrings(r.repos),
		goal: parseGoal(r),
	};
}

/**
 * @param {unknown} raw
 * @returns {raw is import("./refill-decide.js").PauseIssue}
 */
const isPauseIssue = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	typeof raw.number === "number";

/**
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
			...(Array.isArray(r.issues)
				? { issues: r.issues.filter(isPauseIssue) }
				: {}),
		},
	};
}

/**
 * @param {unknown} raw
 * @returns {{repoPaused?: Record<string, import("./refill-decide.js").Pause>}}
 */
function parseRepoPaused(raw) {
	if (!isRecord(raw)) return {};
	/** @type {Record<string, import("./refill-decide.js").Pause>} */
	const repoPaused = {};
	for (const [root, value] of Object.entries(raw)) {
		const { paused } = parsePause(value);
		if (paused) repoPaused[root] = paused;
	}
	return Object.keys(repoPaused).length > 0 ? { repoPaused } : {};
}

/**
 * @param {unknown} raw
 * @returns {{launchHold?: import("./refill-decide.js").LaunchHold}}
 */
function parseLaunchHold(raw) {
	if (!isRecord(raw) || typeof raw.until !== "number") return {};
	const holder = typeof raw.holder === "string" ? raw.holder : null;
	return { launchHold: { holder, until: raw.until } };
}

/**
 * @param {unknown} raw
 * @returns {{away?: import("./refill-decide.js").AwaySwitch}}
 */
function parseAway(raw) {
	if (!isRecord(raw) || typeof raw.since !== "number") return {};
	return { away: { since: raw.since } };
}

/**
 * @param {unknown} raw
 * @returns {Control|null}
 */
function parseControl(raw) {
	if (!isRecord(raw)) return null;
	const { noProgressFrom } = raw;
	if (typeof noProgressFrom !== "number") return null;
	return {
		noProgressFrom,
		stopRequested: raw.stopRequested === true,
		...(typeof raw.stopRequestedAt === "number"
			? { stopRequestedAt: raw.stopRequestedAt }
			: {}),
		...parsePause(raw.paused),
		...parseRepoPaused(raw.repoPaused),
		...parseLaunchHold(raw.launchHold),
		...parseAway(raw.away),
		seats: parseStrings(raw.seats),
		scope: parseScope(raw.scope),
	};
}

/**
 * @param {Control} control
 * @param {Scope["mode"]} mode
 * @param {number} now
 * @returns {Control}
 */
function controlInMode({ away: _switch, ...control }, mode, now) {
	return {
		...control,
		...(mode === "away" ? { away: { since: now } } : {}),
		scope: { ...control.scope, mode },
	};
}

/**
 * @param {Pick<LoopState, "handedOff">} state
 * @param {number} since
 */
const handedOffSince = ({ handedOff }, since) =>
	handedOff?.from === since ? handedOff.count : 0;

/**
 * @param {Scope} scope
 * @param {(root: string) => string|null} readExclusionWhy
 */
function scopeRoots(scope, readExclusionWhy) {
	/** @type {string[]} */
	const roots = [];
	/** @type {{root: string, why: string}[]} */
	const dropped = [];
	for (const root of scope.repos) {
		const why = readExclusionWhy(root);
		if (why === null) roots.push(root);
		else dropped.push({ root, why });
	}
	return { roots, dropped };
}

/**
 * @param {Control} control
 * @param {(root: string) => boolean} isOptedOut
 * @returns {{control: Control, dropped: string[]}|null}
 */
function controlWithoutOptedOut(control, isOptedOut) {
	const { repos } = control.scope;
	const dropped = repos.filter(isOptedOut);
	if (dropped.length === 0) return null;
	const kept = repos.filter((r) => !dropped.includes(r));
	return {
		control: { ...control, scope: { ...control.scope, repos: kept } },
		dropped,
	};
}

/**
 * @param {string[]} served
 * @param {LoopLaunch[]} launches
 */
const landingRoots = (served, launches) => [
	...new Set([...served, ...launches.map((l) => l.root)]),
];

/**
 * @param {Date} now
 * @param {string|null} lastRunOn
 */
const isReviewRunDue = (now, lastRunOn) =>
	now.getHours() >= REVIEW_HOUR && localDate(now) !== lastRunOn;

/**
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
 * @param {{due: boolean, status: number|null, lastRunOn: string|null,
 *   today: string}} run
 */
const reviewRunRecorded = ({ due, status, lastRunOn, today }) =>
	due && (status === 0 || status === 2) ? today : lastRunOn;

/**
 * @param {ReviewResult} ran
 * @returns {string[]}
 */
const buildReviewRunLines = (ran) =>
	ran.due || ran.out || ran.failed ? [buildChildLine(ran.label, ran)] : [];

/**
 * @typedef {{due: boolean, script: string, label: string, today: string}} ReviewStart
 * @typedef {ReviewStart & {status: number|null, out: string,
 *   failed: string|null}} ReviewResult
 */

/**
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
 * @param {Pick<LoopState, "launches"|"launchCount">} state
 * @param {number} from
 */
const launchesSince = ({ launches, launchCount }, from) =>
	launchCount?.from === from
		? launchCount.count
		: launches.filter((l) => l.launchedAt >= from).length;

/**
 * @param {string[]} acts
 * @returns {Record<string, number>}
 */
function countKinds(acts) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const act of acts) {
		const { kind } = parseAct(act);
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return counts;
}

/**
 * @param {string} sessionId
 * @param {string[]} roots
 * @param {ReadActsBy} readActsBy
 * @returns {Record<string, number>|typeof UNREAD}
 */
function readActsSoFar(sessionId, roots, readActsBy) {
	const { acts, unreadable } = readActsBy(sessionId, roots);
	return unreadable.length > 0 ? UNREAD : countKinds(acts);
}

/**
 * @param {LoopLaunch} l
 * @param {string[]} roots
 * @param {ReadActsBy} readActsBy
 * @returns {{acts: Record<string, number>|typeof UNREAD}}
 */
function actsOf(l, roots, readActsBy) {
	if (!l.sessionId || l.actsBefore === UNREAD) return { acts: UNREAD };
	const reads = sessionIdsOf(l).map((id) => readActsBy(id, roots));
	const acts = reads.flatMap((r) => r.acts);
	if (
		(acts.length === 0 || l.actsBefore) &&
		reads.some((r) => r.unreadable.length > 0)
	)
		return { acts: UNREAD };
	const before = l.actsBefore ?? {};
	return {
		acts: Object.fromEntries(
			Object.entries(countKinds(acts)).flatMap(([kind, n]) => {
				const since = n - (before[kind] ?? 0);
				return since > 0 ? [[kind, since]] : [];
			}),
		),
	};
}

/**
 * @param {LoopLaunch} l
 * @returns {string[]}
 */
const sessionIdsOf = (l) => [
	...new Set([
		...(l.pastSessionIds ?? []),
		...(l.sessionId ? [l.sessionId] : []),
	]),
];

/**
 * @param {LoopLaunch[]} launches
 * @param {(l: LoopLaunch) => string[]} rootsOf
 * @param {ReadLastActAt} readLastActAt
 * @returns {{at: Record<string, number>, unread: {sessionId: string, root: string}[]}}
 */
function lastActOf(launches, rootsOf, readLastActAt) {
	/** @type {Record<string, number>} */
	const at = {};
	/** @type {{sessionId: string, root: string}[]} */
	const unread = [];
	for (const l of launches)
		for (const sessionId of sessionIdsOf(l)) {
			const read = readLastActAt(sessionId, rootsOf(l));
			for (const root of read.unreadable) unread.push({ sessionId, root });
			if (read.at !== null) at[l.root] = Math.max(at[l.root] ?? 0, read.at);
		}
	return { at, unread };
}

/** @param {LoopLaunch[]} launches */
const runningOf = (launches) =>
	launches.filter(isLive).map((l) => ({ root: l.root, issues: l.issues }));

/** @param {LoopLaunch[]} launches */
const runningOffLimitOf = (launches) =>
	runningOf(launches.filter((l) => limitWaitOf(l) === null));

/**
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
 * @param {Control|null} control
 * @param {number} since
 */
const isRestartedSince = (control, since) =>
	control !== null && !control.stopRequested && control.noProgressFrom > since;

/**
 * @param {Control|null} control
 * @param {LoopState["stopped"]} stopped
 * @returns {LoopState["stopped"]}
 */
const recordedStop = (control, stopped) =>
	stopped ??
	(control?.stopRequested
		? {
				at: control.stopRequestedAt ?? 0,
				reason: "explicit",
				detail: EXPLICIT_STOP_DETAIL,
			}
		: null);

/** @param {{seat: string, reason?: string}} l */
const buildSeatText = (l) =>
	`on ${buildSeatName(l.seat)}${l.reason ? ` (${l.reason})` : ""}`;

/**
 * @param {{root: string, prompt: string, seat: string, reason?: string}[]} launches
 */
const buildLaunchLine = (launches) =>
	`launch ${launches.map((l) => `${launchName(l)} ${buildSeatText(l)}`).join("; ")}`;

/** @param {import("./refill-decide.js").Decision} d */
function summaryOf(d) {
	if ("stop" in d) return `stop: ${d.stop} — ${d.detail}`;
	if (d.launches.length > 0) return buildLaunchLine(d.launches);
	return `idle: ${d.idle ? buildIdleText(d.idle) : ""}`;
}

/**
 * @typedef {{rows: number, ms: number,
 *   goal: import("./refill-goal.js").GoalRead|null}} FrontierRead
 */

/** @param {FrontierRead} read */
const buildFrontierReadText = (read) =>
	`frontier: ${read.rows} rows in ${(read.ms / 1000).toFixed(1)} s`;

/** @param {import("./refill-decide.js").Skip} s */
const buildSkipText = (s) => `${path.basename(s.root)} #${s.number} ${s.why}`;

/**
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
			now - startedAt(l) >= LISTING_GRACE_MS &&
			!listed.has(l.jobId) &&
			!isHeld(l) &&
			l.handOffTries === undefined &&
			l.bootResumedAt === undefined,
	);
}

/**
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
 * @template {object} P
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {{progressOf: (l: LoopLaunch) => P,
 *   causeOf: import("./refill-blocks.js").CauseOf,
 *   isOwedResume?: (l: LoopLaunch) => boolean}} read
 * @returns {LoopLaunch[]}
 */
function judgedLaunches(
	launches,
	agents,
	now,
	{ progressOf, causeOf, isOwedResume = () => false },
) {
	const listed = withSessionIds(launches, agents);
	const done = new Set(
		newlyFinished(listed, agents, now).filter((l) => !isOwedResume(l)),
	);
	const judged = listed.map((l) =>
		done.has(l)
			? { ...l, ...progressOf(l), finishedAt: now, leftListing: true }
			: l,
	);
	return markParked(judged, agents, causeOf, now);
}

module.exports = {
	judgedLaunches,
	controlInMode,
	handedOffSince,
	actsOf,
	lastActOf,
	readActsSoFar,
	parseControl,
	recordedStop,
	isRestartedSince,
	buildLaunchLine,
	buildSeatText,
	buildFrontierReadText,
	buildSkipText,
	isReviewRunDue,
	reviewStep,
	limitHoldsOf,
	runningOf,
	runningOffLimitOf,
	scopeRoots,
	controlWithoutOptedOut,
	landingRoots,
	launchesSince,
	summaryOf,
};
