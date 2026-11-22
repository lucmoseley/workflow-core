const { isTerminalAgent } = require("./agent-liveness.js");
const { blockCause, hasEndedUnblocked } = require("./block-cause.js");
const { newestMarkerListing } = require("./parked.js");
const { swapHoldText } = require("./admission.js");
const {
	IDLE_TRIES,
	RESUME_CAP,
	blockAct,
	isFounderWait,
	nextTryAt,
	resumeDueAt,
} = require("./block-act.js");
const {
	API_PROMPT,
	HOLD_PROMPT,
	IDLE_PROMPT,
	BOOT_PROMPT,
	BOOT_UNREAD_PROMPT,
} = require("./loop-prompts.js");
const { buildResumeWaitLine } = require("./refill-decide.js");
const {
	adoptOnSeat,
	buildCarriedText,
	carriedOnto,
	resumeOnSeat,
} = require("./refill-carry.js");
const { seatIdOf } = require("./refill-seats.js");
const {
	PARKED_STATE,
	blockedIdsOf,
	buildResumedHow,
	isActionable,
	isHeld,
	isLimitHeld,
	isLive,
	isResuming,
	isStepResume,
	iso,
	launchName,
	ledgerOf,
	relaunched,
	stopJob,
	stopPark,
} = require("./refill-block-core.js");
const {
	adoptTargetOf,
	isLimitBlocked,
	settleStartedLimit,
} = require("./refill-limits.js");

// guess, #2359
const ATTACH_VERDICT_MS = 60 * 1000;
const ATTACH_ROUTE = "typing into the live session";
const FALLBACK_ROUTE = "stop and --bg --resume";
// guess, #2707
const HAND_OFF_TRIES = 3;
// guess, #3093
const SWAP_RESUME_TRIES = 3;
// guess, #2012
const LISTING_GRACE_MS = 2 * 60 * 1000;

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {LoopLaunch & {jobId: string}} JobLaunch
 * @typedef {{seat: string, jobId: string, root: string, sessionId?: string,
 *   keyVar?: string}} SessionRef
 * @typedef {JobLaunch & {block: import("./block-act.js").Block}} BlockedLaunch
 * @typedef {import("./block-act.js").Act} Act
 * @typedef {{id: string, issue: number|null}} HoldRef
 * @typedef {{act: Act, whyEnded?: string, limitParks?: number,
 *   hold?: HoldRef}} ParkWhy
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-limits.js").LimitHeld} LimitHeld
 * @typedef {import("./refill-limits.js").LimitAct} LimitAct
 * @typedef {import("./refill-limits.js").MoveTarget} MoveTarget
 * @typedef {{tries: number, triedAt: number, nextAt: number,
 *   attachAt?: number, heldAt?: number}} Resumes
 * @typedef {{tries: number, triedAt: number}} IdleResumes
 * @typedef {{at: number, sessionId: string, cwd: string, tries: number,
 *   resumeStartedAt?: number, resumeTo?: string}} StepHeld
 * @typedef {{
 *   swapHeld: StepHeld,
 *   holdCleared: StepHeld & {hold: string},
 *   bootKilled: Omit<StepHeld, "sessionId"> & {sessionId: string|null,
 *     flags?: string[]},
 * }} StepPayloads
 * @typedef {keyof StepPayloads} StepCause
 * @typedef {(l: SessionRef, row: AgentRecord, name: string) =>
 *   import("./block-cause.js").Reading} CauseOf
 * @typedef {{root: string, job: import("./parked.js").ParkJob|null,
 *   limitParks?: number, cause?: string}} ParkRecord
 * @typedef {{sessionId: string|null, cwd: string, flags?: string[]}} ResumeTarget
 * @typedef {ResumeTarget & {sessionId: string}} StoppedTarget
 * @typedef {(root: string, sessionId: string) =>
 *   NonNullable<LoopLaunch["actsBefore"]>} ReadActsBefore
 * @typedef {{agents: AgentRecord[]|null, now: number, io: BlockIo,
 *   swapHold: import("./admission.js").SwapHold, barred?: boolean,
 *   net?: NetGate}} Tick
 * @typedef {{seat: string, sessionId: string, cwd: string,
 *   copyJobId: string, tries: number}} Unretired
 * @typedef {{unretired?: Unretired[]}} HasUnretired
 * @typedef {{failed: string}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: false}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: true, why: string,
 *   unretired?: Unretired}} Resumed
 * @typedef {Extract<Resumed, {failed: null}>|{unread: string}|null} Adopted
 * @typedef {{kind: "api", route: string, again: boolean}|
 *   (LimitAct & {held: LimitHeld})} StartedAct
 * @typedef {{at: number, sessionId: string, cwd: string, act: StartedAct}} ResumeStarted
 */

/**
 * @template {StepCause} [C=StepCause]
 * @typedef {{[K in C]: {cause: K} & StepPayloads[K]}[C]} StepResume
 */

/** @typedef {JobLaunch & {stepResume: StepResume}} SteppedLaunch */

/**
 * @typedef {object} BlockReads
 * @property {(l: SessionRef) => ResumeTarget} resumeTargetOf
 * @property {(root: string) => string|null} admitResume
 * @property {(l: SessionRef) => {state?: unknown, detail?: unknown}|null} jobStateOf
 * @property {(l: SessionRef) => unknown[]|null} readTimeline
 * @property {(l: JobLaunch) => import("./block-cause.js").IdleReading} idleSince
 * @property {(l: SessionRef) => import("./block-cause.js").IdleReading} syntheticStopOf
 * @property {(l: SessionRef, at: number) => boolean} hasTurnedSince
 * @property {(l: SessionRef, at: number) => boolean|null} hasRepliedSince
 * @property {(seat: string, jobId: string) => string|null} readJobCwd
 * @property {(root: string) => import("./parked.js").ParkMarkerRead[]|null} readParkMarkers
 * @property {(marker: import("./parked.js").ParkMarkerRead) =>
 *   {file: string, mtimeMs: number}|null} findParkTranscript
 * @property {(file: string, who: string) => Record<string, unknown>[]|null} readMainChain
 * @property {(l: LoopLaunch) => object} progressOf
 * @property {ReadActsBefore} readActsBefore
 * @property {() => string|null} probeNetwork
 * @property {(l: SessionRef, since?: number) => boolean|null} isResumedSinceStop
 * @property {() => import("./refill-outside.js").Outside[]} readOutside
 * @property {() => {jobs: import("./reaped-jobs.js").ReapedJob[],
 *   read: string[]}} readReaped
 * @property {(l: SessionRef) => boolean|null} hasFounderTypedSinceStop
 * @property {(line: string) => void} log
 */

/**
 * @typedef {object} BlockActs
 * @property {(l: JobLaunch, target: ResumeTarget & {sessionId: string},
 *   since: number, move?: MoveTarget) => Adopted} adoptResumed
 * @property {(seat: string, jobId: string) =>
 *   import("./claude-stop.js").StopOutcome} stop
 * @property {(l: SessionRef, prompt: string) => string|null} type
 * @property {(l: SessionRef & {issues?: number[]}, prompt: string,
 *   target: ResumeTarget & {sessionId: string}) => Resumed} resumeStopped
 * @property {(l: JobLaunch, prompt: string, target: ResumeTarget &
 *   {sessionId: string}) => Resumed} resumeOwnId
 * @property {(l: LoopLaunch) => void} writeLaunch
 * @property {() => void} stagger
 * @property {(l: JobLaunch, target: MoveTarget, prompt: string, ids: ResumeTarget &
 *   {sessionId: string}) => Resumed} moveSession
 * @property {(seat: string, sessionId: string, cwd: string) => string|null} removeJobRecord
 * @property {(seat: string, sessionId: string, cwd: string) => string|null} retireJob
 * @property {(l: LoopLaunch, until?: number) => boolean} writeLedgerHold
 * @property {(l: JobLaunch, lockout: import("./block-cause.js").Lockout,
 *   now: number) => {hold: HoldRef}|{why: string}} holdLockedOut
 * @property {(l: LoopLaunch) => {n: number, why: string}[]} labelParked
 * @property {(sessionId: string, numbers: number[], record: ParkRecord) =>
 *   string|null} recordParked
 * @property {(root: string, sessionId: string, issues: number[]) => string|null} unparkSession
 * @property {(l: LoopLaunch, body: string) => void} comment
 * @property {(root: string, args: string[]) => {failed: string|null, out: string}} postHandOff
 * @property {(ledger: {jobId: string, root: string}) => boolean} release
 * @property {(records: import("./refill-outside.js").Outside[]) => void} writeOutside
 * @property {(keys: string[]) => void} writeReapedRead
 */

/** @typedef {BlockReads & BlockActs} BlockIo */

/** @param {JobLaunch} l */
const buildHandOffArgs = (l) => [
	"hand-off",
	"--from",
	l.seat,
	"--job",
	l.jobId,
	...(l.sessionId ? ["--session", l.sessionId] : []),
	...l.issues.flatMap((n) => ["--issue", String(n)]),
];

/** @param {string} text */
const indented = (text) => text.replace(/\n/g, "\n  ");

/**
 * @param {string} label
 * @param {{out: string, failed?: string|null}} ran
 */
const buildChildLine = (label, ran) =>
	`${label}: ${ran.failed ?? "exit 0"}\n  ${indented(ran.out)}`;

/**
 * @template {LoopLaunch} L
 * @template {StepCause} C
 * @param {L} l
 * @param {C} cause
 * @returns {l is L & {stepResume: StepResume<C>}}
 */
const isStepResumeFor = (l, cause) => l.stepResume?.cause === cause;

/** @typedef {{admit: (name: string) => boolean, waitedLine: () => string|null}} NetGate */

/**
 * @param {Tick} seen
 * @returns {NetGate}
 */
function netGateOf(seen) {
	if (seen.net) return seen.net;
	/** @type {string|null|undefined} */
	let why;
	/** @type {string[]} */
	const waited = [];
	const gate = {
		admit: (/** @type {string} */ name) => {
			if (why === undefined) why = seen.io.probeNetwork();
			if (why !== null) waited.push(name);
			return why === null;
		},
		waitedLine: () =>
			waited.length === 0
				? null
				: `the API host is unreachable (${why}), so these due resumes wait for the next tick, no try spent: ${waited.join(", ")}`,
	};
	seen.net = gate;
	return gate;
}

/**
 * @param {string} name
 * @param {Tick} seen
 */
const isRunAdmitted = (name, seen) =>
	!seen.barred && netGateOf(seen).admit(name);

/** @param {Tick} seen */
function logNetWaits(seen) {
	const line = seen.net?.waitedLine();
	if (line) seen.io.log(line);
}

/**
 * @param {LoopLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const blockOf = (l) => ({
	...l.block,
	tries: l.resumes?.tries ?? 0,
	nextAt: l.resumes?.nextAt,
	triedAt: l.resumes?.triedAt,
	held: l.resumes?.heldAt !== undefined,
	typing: l.resumes?.attachAt !== undefined,
});

/** @param {LoopLaunch & {block: import("./block-act.js").Block}} l */
const nextResumeAt = (l) => resumeDueAt(blockOf(l));

/**
 * @param {LoopLaunch[]} launches
 * @param {AgentRecord[]|null} agents
 * @param {CauseOf} causeOf
 * @param {number} now
 */
function markParked(launches, agents, causeOf, now) {
	if (!agents) return launches;
	const rows = new Map(agents.flatMap((a) => (a.id ? [[a.id, a]] : [])));
	return launches.map((l) => {
		const { jobId } = l;
		const row = jobId === null ? undefined : rows.get(jobId);
		if (l.finishedAt !== null || jobId === null || !row) return l;
		if (isHeld(l) && isTerminalAgent(row)) return l;
		const ref = { ...l, jobId };
		if (row.state == null) {
			causeOf(ref, row, launchName(l));
			return l;
		}
		const { block: _, stepResume: __, limitHeld: ___, ...rest } = l;
		if (row.state !== PARKED_STATE) return { ...rest, parked: false };
		const reading = causeOf(ref, row, launchName(l));
		return {
			...rest,
			parked: true,
			block: buildBlock(reading, l.block?.since ?? now),
		};
	});
}

/**
 * @param {import("./block-cause.js").Reading} reading
 * @param {number} since
 * @returns {import("./block-act.js").Block}
 */
const buildBlock = (reading, since) => ({
	cause: reading.cause,
	...("sub" in reading ? { sub: reading.sub } : {}),
	...("billing" in reading ? { billing: reading.billing } : {}),
	...("bar" in reading ? { bar: reading.bar } : {}),
	...("lockout" in reading ? { lockout: reading.lockout } : {}),
	since,
});

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{l: BlockedLaunch, act: Act}[]}
 */
function blockedActs(launches, mode, { agents, now }) {
	if (!agents) return [];
	const blocked = blockedIdsOf(agents);
	return launches.flatMap((l) => {
		if (
			!isActionable(l) ||
			!l.block ||
			isLimitBlocked(l) ||
			!(blocked.has(l.jobId) || isHeld(l))
		)
			return [];
		const b = { ...l, block: l.block };
		return [{ l: b, act: blockAct(blockOf(b), mode, now) }];
	});
}

/**
 * @param {{tries: number}|undefined} was
 * @param {number} now
 * @param {boolean} typed
 */
const nextTry = (was, now, typed) => ({
	tries: (was?.tries ?? 0) + 1,
	triedAt: now,
	...(typed ? { attachAt: now } : {}),
});

/**
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {{typed: boolean, failed: boolean}} how
 * @returns {L}
 */
function afterResume(l, now, { typed, failed }) {
	const { attachAt, ...tried } = nextTry(l.resumes, now, typed);
	return {
		...l,
		resumes: {
			...tried,
			nextAt: nextTryAt(tried.tries, now),
			...(attachAt === undefined ? {} : { attachAt }),
			...(failed ? { heldAt: l.resumes?.heldAt ?? now } : {}),
		},
	};
}

/**
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const afterIdleResume = (l, now) => ({
	...l,
	idleResumes: { tries: (l.idleResumes?.tries ?? 0) + 1, triedAt: now },
});

/**
 * @param {number} attachAt
 * @param {string} prompt
 * @param {unknown[]|null} timeline
 */
function isResumeArrived(attachAt, prompt, timeline) {
	return (timeline ?? []).some((r) => {
		const row = /** @type {{at?: unknown, detail?: unknown}} */ (r);
		const detail =
			typeof row.detail === "string" ? row.detail.replace(/…$/, "") : "";
		return (
			typeof row.at === "string" &&
			Date.parse(row.at) > attachAt &&
			detail.length > 0 &&
			prompt.startsWith(detail)
		);
	});
}

/**
 * @template {LoopLaunch} L
 * @param {L} l
 */
function endedIdle(l) {
	const {
		idleResumes: _,
		idleSince: __,
		bootResumedAt: ___,
		blockUnread: ____,
		...rest
	} = l;
	return rest;
}

/**
 * @param {LoopLaunch} l
 * @param {Tick} seen
 */
const isDeadAfterBootResume = (l, { agents, now, io }) =>
	isLive(l) &&
	l.bootResumedAt !== undefined &&
	agents !== null &&
	now - l.bootResumedAt >= LISTING_GRACE_MS &&
	!isLiveIn(l, agents) &&
	!io.hasTurnedSince(l, l.bootResumedAt);

/**
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {l is JobLaunch & {bootResumedAt: number}}
 */
const isIdleSinceBootResume = (l, io) =>
	l.bootResumedAt !== undefined &&
	!io.hasTurnedSince(l, l.bootResumedAt) &&
	io.jobStateOf(l)?.state === "working";

/**
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {"turned"|"ended"|"unread"|number}
 */
function idleReading(l, io) {
	const at = l.idleResumes?.triedAt;
	if (at !== undefined && io.hasTurnedSince(l, at)) return "turned";
	const since = io.idleSince(l);
	if (since !== null) return since;
	return isIdleSinceBootResume(l, io) ? l.bootResumedAt : "ended";
}

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[], acts: {l: BlockedLaunch, act: Act}[]}}
 */
function idleActs(launches, mode, { now, io, swapHold }) {
	/** @type {{l: BlockedLaunch, act: Act}[]} */
	const acts = [];
	const read = launches.map((l) => {
		if (
			!isActionable(l) ||
			isResuming(l) ||
			l.handOffTries !== undefined ||
			isStepResume(l) ||
			isLimitHeld(l)
		)
			return l;
		const since = idleReading(l, io);
		if (since === "unread") return l;
		if (typeof since === "string") return endedIdle(l);
		const idle = { ...l, idleSince: l.idleSince ?? since };
		/** @type {import("./block-act.js").Block} */
		const block = {
			cause: "RESUMED_IDLE",
			since: Math.max(since, l.idleResumes?.triedAt ?? 0),
			tries: l.idleResumes?.tries ?? 0,
			swapHeld: swapHold.held,
		};
		acts.push({ l: { ...idle, block }, act: blockAct(block, mode, now) });
		return idle;
	});
	return { launches: read, acts };
}

/**
 * @param {LoopLaunch} l
 * @param {string} route
 * @param {string|null} failed
 */
function buildResumeLine(l, route, failed) {
	const what = `resume ${l.resumes?.tries ?? 0} of ${RESUME_CAP} after an API error, ${launchName(l)}, by ${route}`;
	if (failed) return `could not ${what}: ${failed}`;
	return l.resumes ? `${what}; next due ${iso(l.resumes.nextAt)}` : what;
}

/**
 * @param {LoopLaunch} l
 * @param {string|null} failed
 */
const buildIdleResumeLine = (l, failed) =>
	`${failed ? "could not resume" : "resumed"} ${launchName(l)}, idle since its host's restart, by ${ATTACH_ROUTE}, try ${l.idleResumes?.tries ?? 0} of ${IDLE_TRIES}${failed ? `: ${failed}` : ""}`;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isAwayPark = (l) => l.parkedAway === true && l.jobId !== null;

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {string[]} served
 * @param {Pick<BlockIo, "release"|"log">} io
 * @returns {LoopLaunch[]}
 */
function releaseAwayParks(launches, mode, served, io) {
	if (mode !== "normal") return launches;
	return launches.map((l) => {
		if (!isAwayPark(l) || !served.includes(l.root)) return l;
		if (!io.release(ledgerOf(l))) {
			io.log(
				`could not release ${launchName(l)}'s dispatch-ledger row: its park waits out the window unless a later tick's release takes`,
			);
			return l;
		}
		const { parkedAway: _, ...released } = l;
		return released;
	});
}

/**
 * @param {BlockedLaunch} l
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function parkLockedOut(l, mode, seen) {
	const { lockout } = l.block;
	if (!lockout) return l;
	const held = seen.io.holdLockedOut(l, lockout, seen.now);
	if ("why" in held) {
		seen.io.log(
			`could not attach locked-out ${launchName(l)} to its probe hold, the next tick retries: ${held.why}`,
		);
		return l;
	}
	return stopPark(l, { act: "attach-to-hold", hold: held.hold }, mode, seen);
}

/**
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const withHeld = (l, now) =>
	l.resumes ? { ...l, resumes: { ...l.resumes, heldAt: now } } : l;

/**
 * @param {BlockedLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdForResume(l, { now, io }) {
	const failed = stopJob(l, io);
	io.log(
		failed
			? `could not stop ${launchName(l)} until its next resume: ${failed}`
			: `stopped ${launchName(l)} until its next resume, due ${iso(l.resumes?.nextAt ?? now)}`,
	);
	return failed ? l : withHeld(l, now);
}

/**
 * @param {JobLaunch} l
 * @param {Extract<StartedAct, {kind: "api"}>} act
 * @param {Tick} seen
 * @returns {{failed: string}|(Resumed & {fromSessionId: string})}
 */
function relaunchResume(l, act, { now, io }) {
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) return { failed: "no session id read for it" };
	io.writeLaunch({ ...l, resumeStarted: { at: now, sessionId, cwd, act } });
	const stopFailed = stopJob(l, io);
	if (stopFailed) return { failed: `stop: ${stopFailed}` };
	return {
		...io.resumeStopped(l, API_PROMPT, { sessionId, cwd }),
		fromSessionId: sessionId,
	};
}

/**
 * @param {LoopLaunch} l
 * @param {string} line
 * @param {BlockIo} io
 */
function reportResume(l, line, io) {
	io.log(line);
	io.comment(l, `Refill loop: ${line}.`);
}

/**
 * @param {JobLaunch} l
 * @param {number} now
 * @param {{failed: boolean, again: boolean}} how
 */
function afterFallBack(l, now, { failed, again }) {
	if (!again) return afterResume(l, now, { typed: false, failed });
	return failed ? withHeld(l, now) : l;
}

/**
 * @param {JobLaunch} l
 * @param {number} now
 * @param {boolean} again
 * @returns {LoopLaunch}
 */
function afterTurnUnknown(l, now, again) {
	const tried = afterFallBack(l, now, { failed: false, again });
	const heldAt = l.resumes?.heldAt;
	return heldAt === undefined ? tried : withHeld(tried, heldAt);
}

/**
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @param {{route: string, again: boolean}} how
 * @returns {LoopLaunch}
 */
function fallBack(l, seen, { route, again }) {
	if (!seen.agents) {
		reportResume(
			l,
			buildResumeLine(l, route, "the listing is unread, so it is not stopped"),
			seen.io,
		);
		return l;
	}
	const taken = isTakenSinceStop(l, launchName(l), seen.io, l.block?.since);
	if (taken === null) return afterTurnUnknown(l, seen.now, again);
	if (taken) {
		if (!l.resumes) return l;
		const { heldAt: _, ...resumes } = l.resumes;
		return { ...l, resumes };
	}
	const act = /** @type {const} */ ({ kind: "api", route, again });
	const out = settleFallBack(l, relaunchResume(l, act, seen), seen, act);
	seen.io.writeLaunch(out);
	return out;
}

/**
 * @param {JobLaunch} l
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{now: number, io: BlockIo}} seen
 * @param {{route: string, again: boolean}} how
 * @returns {LoopLaunch}
 */
function settleFallBack(l, r, { now, io }, { route, again }) {
	let resumed = l;
	let told = route;
	if (r.failed === null) {
		resumed = relaunched(l, r, now, { tookSlot: false });
		told = `${route}, ${buildResumedHow(r)}`;
	}
	const tried = {
		...afterFallBack(resumed, now, { failed: r.failed !== null, again }),
		jobId: resumed.jobId,
	};
	reportResume(tried, buildResumeLine(tried, told, r.failed), io);
	return tried;
}

/**
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 */
function settleTyped(launches, seen) {
	const { agents, now, io } = seen;
	if (!agents) return launches;
	return launches.map((l) => {
		const resumes = l.resumes;
		const at = resumes?.attachAt;
		if (!resumes || at === undefined || !isActionable(l)) return l;
		const verdict = typedVerdict(at, l, { now, io });
		if (verdict === "pending") return l;
		const { attachAt: _, ...rest } = resumes;
		const settled = /** @type {JobLaunch} */ ({ ...l, resumes: rest });
		if (!isResuming(settled) || verdict === "arrived") return settled;
		if (!netGateOf(seen).admit(launchName(l))) return l;
		return fallBack(settled, seen, {
			route: `${FALLBACK_ROUTE}, the typed one unseen`,
			again: true,
		});
	});
}

/**
 * @param {number} attachAt
 * @param {SessionRef} l
 * @param {{now: number, io: BlockIo}} seen
 * @returns {"pending"|"arrived"|"unseen"}
 */
function typedVerdict(attachAt, l, { now, io }) {
	if (now - attachAt < ATTACH_VERDICT_MS) return "pending";
	return isResumeArrived(attachAt, API_PROMPT, io.readTimeline(l))
		? "arrived"
		: "unseen";
}

/**
 * @param {SessionRef} l
 * @param {string} name
 * @param {BlockIo} io
 * @param {number} [since]
 * @returns {boolean|null}
 */
function isTakenSinceStop(l, name, io, since) {
	const resumed = io.isResumedSinceStop(l, since);
	if (resumed === null)
		io.log(
			`${name}'s transcript shows no API-error stop, and its timeline is unread or the loop holds no time for the stop, so whether its session took a turn since cannot be told: it is neither stopped nor copied this try`,
		);
	else if (resumed)
		io.log(
			`${name}'s session took a turn since its API-error stop, so it is neither stopped nor copied: its resume counts as arrived`,
		);
	return resumed;
}

/**
 * @param {JobLaunch} l
 * @param {AgentRecord[]|null} agents
 */
const isLiveIn = (l, agents) =>
	!agents || agents.some((a) => a.id === l.jobId && !isTerminalAgent(a));

/**
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function makeResume(l, seen) {
	const { agents, now, io } = seen;
	if (!netGateOf(seen).admit(launchName(l))) return l;
	const live = isLiveIn(l, agents);
	const typeFailed = live ? io.type(l, API_PROMPT) : null;
	if (typeFailed)
		io.log(`could not type the resume into ${l.jobId}: ${typeFailed}`);
	if (!live || typeFailed)
		return fallBack(l, seen, { route: FALLBACK_ROUTE, again: false });
	const tried = afterResume(l, now, { typed: true, failed: false });
	reportResume(tried, buildResumeLine(tried, ATTACH_ROUTE, null), io);
	return tried;
}

/**
 * @param {LoopLaunch} l
 * @param {string} plain
 */
const resumePromptOf = (l, plain) =>
	l.blockUnread ? BOOT_UNREAD_PROMPT : plain;

/**
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function typeIdleResume(l, { agents, now, io }) {
	const failed = isLiveIn(l, agents)
		? io.type(l, resumePromptOf(l, IDLE_PROMPT))
		: "its session is not live";
	const tried = afterIdleResume(l, now);
	reportResume(tried, buildIdleResumeLine(tried, failed), io);
	return tried;
}

const SPARED_WHY = {
	turned: "it took a turn after its resume",
	ended: "its job is no longer idle",
	unread: "its resumed-idle records are unread",
};

/**
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {LoopLaunch|null}
 */
function idleSpared(l, io) {
	const since = idleReading(l, io);
	if (typeof since === "number") return null;
	io.log(`not stopping ${launchName(l)}: ${SPARED_WHY[since]}`);
	return since === "unread" ? l : endedIdle(l);
}

/**
 * @param {JobLaunch} b
 * @param {Tick} seen
 * @param {boolean} [stopped]
 * @returns {LoopLaunch}
 */
function handOff(b, { agents, now, io }, stopped = false) {
	const { block: _, ...l } = b;
	if (!agents) {
		io.log(`not handing off ${launchName(l)}: the listing is unread`);
		return l;
	}
	const spared = stopped ? null : idleSpared(l, io);
	if (spared) return spared;
	const failed = stopped ? null : stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${launchName(l)} to hand it off: ${failed}`);
		return l;
	}
	const r = io.postHandOff(b.root, buildHandOffArgs(b));
	io.log(
		buildChildLine(
			`stopped ${launchName(l)}, idle after its resume, and handed it off`,
			r,
		),
	);
	const tries = (l.handOffTries ?? 0) + 1;
	if (r.failed && tries < HAND_OFF_TRIES) return { ...l, handOffTries: tries };
	if (r.failed)
		io.log(`gave up handing off ${launchName(l)} after ${tries} tries`);
	else if (!io.release(ledgerOf(b)))
		io.log(
			`could not release ${launchName(l)}'s dispatch-ledger hold: its issues wait out the hour (#2744)`,
		);
	const { handOffTries: __, ...done } = l;
	return {
		...done,
		...io.progressOf(done),
		finishedAt: now,
		handedOff: now,
	};
}

/**
 * @param {BlockedLaunch} b
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdIdle(b, { agents, now, io, swapHold }) {
	const { block: _, ...l } = b;
	const what = `${launchName(l)}, restarted by its host, under the swap hold${swapHold.held ? ` (${swapHoldText(swapHold)})` : ""}`;
	if (!agents) {
		io.log(`not stopping ${what}: the listing is unread`);
		return l;
	}
	const spared = idleSpared(l, io);
	if (spared) return spared;
	const { sessionId, cwd } = io.resumeTargetOf(b);
	if (!sessionId) {
		io.log(`not stopping ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${what}: ${failed}`);
		return l;
	}
	io.log(`stopped ${what}, until the hold clears`);
	const { idleSince: __, ...stopped } = l;
	return {
		...stopped,
		stepResume: { cause: "swapHeld", at: now, sessionId, cwd, tries: 0 },
	};
}

/**
 * @template {StepCause} C
 * @typedef {{kind: string, isUnsettled: boolean,
 *   what: (l: LoopLaunch, held: StepResume<C>) => string,
 *   why: string, prompt: (l: LoopLaunch) => string, isParked: boolean,
 *   watchesTurn: boolean,
 *   resume: (io: BlockIo, step: {l: JobLaunch, prompt: string,
 *     target: ResumeTarget & {sessionId: string}, held: StepResume<C>}) =>
 *     Resumed,
 *   status: (held: StepResume<C>) => string}} StepCauseRow
 */

/** @type {StepCauseRow<"swapHeld"|"holdCleared">["resume"]} */
const resumeStopped = (io, { l, prompt, target }) =>
	io.resumeStopped(l, prompt, target);

/** @type {{[C in StepCause]: StepCauseRow<C>}} */
const STEP_CAUSES = {
	swapHeld: {
		kind: "swap-held",
		isUnsettled: true,
		what: (l, held) =>
			`${launchName(l)}, stopped under the swap hold at ${iso(held.at)}`,
		why: "the hold cleared",
		prompt: (l) => resumePromptOf(l, IDLE_PROMPT),
		isParked: false,
		watchesTurn: false,
		resume: resumeStopped,
		status: (held) =>
			`stopped under the swap hold since ${iso(held.at)}, resumed through admission once it clears`,
	},
	holdCleared: {
		kind: "hold-cleared",
		isUnsettled: false,
		what: (l, held) =>
			`${launchName(l)}, parked at ${iso(held.at)} on repo hold ${held.hold}`,
		why: "the hold cleared",
		prompt: () => HOLD_PROMPT,
		isParked: true,
		watchesTurn: false,
		resume: resumeStopped,
		status: (held) =>
			`parked on repo hold ${held.hold}, since cleared, resumed through admission`,
	},
	bootKilled: {
		kind: "boot-killed",
		isUnsettled: false,
		what: (l) => `${launchName(l)}, launched at ${iso(l.launchedAt)}`,
		why: "killed by a restart",
		prompt: (l) => resumePromptOf(l, BOOT_PROMPT),
		isParked: false,
		watchesTurn: true,
		resume: (io, { l, prompt, target, held }) =>
			io.resumeOwnId(l, prompt, {
				...target,
				...(held.flags ? { flags: held.flags } : {}),
			}),
		status: () => "killed by a restart, resumed through admission",
	},
};

/**
 * @template {StepCause} C
 * @param {StepResume<C>} held
 * @returns {StepCauseRow<C>}
 */
const stepCauseOf = (held) => STEP_CAUSES[held.cause];

/**
 * @param {StepResume} held
 */
const buildStepStatus = (held) => stepCauseOf(held).status(held);

/**
 * @param {StepResume} held
 */
const stepKindOf = (held) => stepCauseOf(held).kind;

const UNSETTLED_STEP_KINDS = Object.values(STEP_CAUSES)
	.filter((row) => row.isUnsettled)
	.map((row) => row.kind);

/**
 * @template {StepCause} C
 * @param {StepResume<C>} held
 * @param {JobLaunch} l
 */
function bindStepCause(held, l) {
	const row = stepCauseOf(held);
	const prompt = row.prompt(l);
	return {
		what: row.what(l, held),
		why: row.why,
		prompt,
		isParked: row.isParked,
		watchesTurn: row.watchesTurn,
		/**
		 * @param {BlockIo} io
		 * @param {ResumeTarget & {sessionId: string}} target
		 */
		resume: (io, target) => row.resume(io, { l, prompt, target, held }),
	};
}

/** @param {SteppedLaunch} l */
function stepResumeOf(l) {
	const held = l.stepResume;
	const { stepResume: _, ...rest } = l;
	return {
		...bindStepCause(held, l),
		held,
		/** @type {JobLaunch} */ rest,
		/** @param {number} tries @returns {JobLaunch} */
		withTries: (tries) => ({ ...l, stepResume: { ...held, tries } }),
		/** @param {number} at @param {string} [to] @returns {JobLaunch} */
		withStarted: (at, to) => ({
			...l,
			stepResume: {
				...held,
				resumeStartedAt: at,
				resumeTo: to,
			},
		}),
	};
}

/**
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @returns {import("./refill-decide.js").HeldResume[]}
 */
function resumableOf(launches, { agents, io, swapHold }) {
	if (swapHold.held) return [];
	const due = launches.filter(isActionable).filter(isStepResume);
	if (!agents) {
		for (const l of due)
			io.log(`not resuming ${stepResumeOf(l).what}: the listing is unread`);
		return [];
	}
	return due.map((l) => {
		const { held, what, isParked } = stepResumeOf(l);
		return {
			jobId: l.jobId,
			...seatIdOf(l),
			root: l.root,
			at: held.at,
			line: `${l.jobId} ${what}`,
			...(isParked && !l.keyVar ? { parked: /** @type {const} */ (true) } : {}),
		};
	});
}

/**
 * @param {JobLaunch} l
 * @param {ReturnType<typeof stepResumeOf>} step
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} r
 * @param {{at: number, to?: string}} when
 * @returns {LoopLaunch}
 */
function afterStepResume(l, { rest, watchesTurn }, r, { at, to }) {
	const on = { ...rest, ...carriedOnto(l.seat, to) };
	const resumed = relaunched(on, r, at, { tookSlot: true });
	return watchesTurn || l.bootResumedAt !== undefined
		? { ...resumed, bootResumedAt: at }
		: resumed;
}

/**
 * @param {JobLaunch} l
 * @param {string} sessionId
 * @param {ReturnType<typeof stepResumeOf>} step
 * @param {BlockIo} io
 */
function unparkStepped(l, sessionId, { isParked, what }, io) {
	if (!isParked) return;
	const failed = io.unparkSession(l.root, sessionId, l.issues);
	if (failed) io.log(`${what}: still labelled parked: ${failed}`);
}

/**
 * @param {SteppedLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch|null}
 */
function adoptUnrecordedCopy(l, seen) {
	const step = stepResumeOf(l);
	const { held, what, why } = step;
	const { sessionId, cwd, resumeStartedAt: at, resumeTo: to } = held;
	if (at === undefined || !sessionId) return null;
	const r = adoptOnSeat(seen.io.adoptResumed, l, to, {
		ids: { sessionId, cwd },
		since: at,
	});
	if (r === null) return null;
	if ("unread" in r) {
		seen.io.log(
			`${what}: whether its resume at ${iso(at)} started a copy is unread, so it is resumed again: ${r.unread}`,
		);
		return null;
	}
	const launch = afterStepResume(
		l,
		step,
		{ ...r, fromSessionId: sessionId },
		{ at, to },
	);
	seen.io.log(
		`resumed ${what}, ${why}, by --bg --resume at ${iso(at)}, ${buildResumedHow(r)}, which a kill left out of the state: tracking it, not resuming again`,
	);
	unparkStepped(l, sessionId, step, seen.io);
	return launch;
}

/**
 * @param {SteppedLaunch} l
 * @param {Tick} seen
 * @param {string} [to]
 * @returns {{launch: LoopLaunch, started: boolean}}
 */
function resumeStepHeld(l, seen, to) {
	const { now, io } = seen;
	const step = stepResumeOf(l);
	const { held, what, why, rest, withTries } = step;
	const { sessionId, cwd } = held;
	if (!sessionId) {
		io.log(`${what}, ${why}: no session id read to resume it by`);
		return { launch: handOff(rest, seen, true), started: false };
	}
	const unpark = () => unparkStepped(l, sessionId, step, io);
	const ids = { sessionId, cwd };
	const r = resumeOnSeat(io, l, to, {
		prompt: step.prompt,
		ids,
		inPlace: () => step.resume(io, ids),
	});
	if (r.failed === null) {
		const launch = afterStepResume(
			l,
			step,
			{ ...r, fromSessionId: sessionId },
			{ at: now, to },
		);
		io.log(
			`resumed ${what}, ${why}, by --bg --resume${buildCarriedText(l.seat, to)}, ${buildResumedHow(r)}`,
		);
		unpark();
		return { launch, started: true };
	}
	const tries = held.tries + 1;
	io.log(
		`could not resume ${what}, try ${tries} of ${SWAP_RESUME_TRIES}: ${r.failed}`,
	);
	if (tries < SWAP_RESUME_TRIES)
		return { launch: withTries(tries), started: false };
	unpark();
	return { launch: handOff(rest, seen, true), started: false };
}

/**
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {BlockIo} io
 */
function hasParkEndedUnblocked(marker, io) {
	const found = io.findParkTranscript(marker);
	if (!found || found.mtimeMs <= marker.writtenAt) return false;
	const rows = io.readMainChain(found.file, marker.sessionId);
	return rows !== null && hasEndedUnblocked(rows, marker.writtenAt);
}

/**
 * @param {string[]} roots
 * @param {Pick<Tick, "agents"|"io">} seen
 */
function unparkAnswered(roots, { agents, io }) {
	if (!agents) return;
	const running = new Set(
		agents
			.filter((a) => !isTerminalAgent(a))
			.flatMap((a) => [a.sessionId, a.id])
			.filter(Boolean),
	);
	for (const root of roots) {
		const markers = io.readParkMarkers(root) ?? [];
		for (const marker of markers) {
			if (running.has(marker.sessionId) || running.has(marker.job?.jobId))
				continue;
			const issues = marker.issues.filter(
				(n) => newestMarkerListing(markers, n) === marker,
			);
			if (issues.length > 0 && hasParkEndedUnblocked(marker, io))
				unparkAndLog(root, marker.sessionId, issues, io);
		}
	}
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {number[]} issues
 * @param {BlockIo} io
 */
function unparkAndLog(root, sessionId, issues, io) {
	const named = issues.map((n) => `#${n}`).join(", ");
	const failed = io.unparkSession(root, sessionId, issues);
	io.log(
		failed
			? `session ${sessionId} ended unblocked: ${named} still labelled parked: ${failed}`
			: `session ${sessionId} ended unblocked: parked off ${named}`,
	);
}

/**
 * @param {import("./refill-decide.js").HeldResume[]} resumes
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @param {{isStopped: () => boolean,
 *   record: (launches: LoopLaunch[]) => void}} step
 * @returns {{launches: LoopLaunch[], started: number, waiting: boolean}}
 */
function resumeHeldLaunches(resumes, launches, seen, { isStopped, record }) {
	const { io } = seen;
	/** @type {Map<LoopLaunch, LoopLaunch>} */
	const acted = new Map();
	const current = () => launches.map((l) => acted.get(l) ?? l);
	let started = 0;
	let waiting = false;
	for (const { jobId, line, to } of resumes) {
		const l = launches.filter(isStepResume).find((x) => x.jobId === jobId);
		if (!l || !isActionable(l) || isStopped()) break;
		const adopted = adoptUnrecordedCopy(l, seen);
		if (adopted) {
			acted.set(l, adopted);
			record(current());
			continue;
		}
		const refused = io.admitResume(l.root);
		if (refused) {
			io.log(buildResumeWaitLine(line, refused));
			waiting = true;
			break;
		}
		acted.set(l, stepResumeOf(l).withStarted(seen.now, to));
		record(current());
		const out = resumeStepHeld(l, seen, to);
		acted.set(l, out.launch);
		record(current());
		if (out.started) {
			started += 1;
			io.stagger();
		}
	}
	return { launches: current(), started, waiting };
}

/**
 * @param {string} job
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {ReadActsBefore} readActsBefore
 * @returns {LoopLaunch}
 */
const buildMarkerLaunch = (job, marker, hold, readActsBefore) => ({
	root: hold.root,
	issues: marker.issues,
	prompt: `parked ${marker.issues.map((n) => `#${n}`).join(" ")}`,
	...seatIdOf({ seat: marker.job?.seat ?? "", keyVar: marker.job?.keyVar }),
	reason: /** @type {const} */ ("parked session's seat"),
	jobId: job,
	sessionId: marker.sessionId,
	launchedAt: marker.writtenAt,
	finishedAt: null,
	actsBefore: readActsBefore(hold.root, marker.sessionId),
});

/**
 * @param {string} job
 * @param {import("./parked.js").ParkMarkerRead} marker
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {LoopLaunch} from
 * @returns {JobLaunch}
 */
function buildClearedLaunch(job, marker, hold, from) {
	const {
		block: _,
		parked: __,
		parkStopped: ___,
		parkedAway: ____,
		handOffTries: _____,
		handedOff: ______,
		nothingToRepeat: _______,
		...base
	} = from;
	return {
		...base,
		issues: [...new Set([...base.issues, ...marker.issues])],
		jobId: job,
		finishedAt: null,
		stepResume: {
			cause: "holdCleared",
			at: marker.writtenAt,
			sessionId: marker.sessionId,
			cwd: marker.job?.cwd ?? hold.root,
			tries: 0,
			hold: hold.id,
		},
	};
}

/**
 * @param {string} job
 * @param {import("./repo-holds.js").LiftedHold} hold
 * @param {{launches: LoopLaunch[],
 *   markers: import("./parked.js").ParkMarkerRead[]}} read
 * @param {Tick} seen
 * @returns {{isSettled: boolean, launch?: JobLaunch}}
 */
function judgeClearedJob(job, hold, { launches, markers }, { agents, io }) {
	const known = launches.findLast((l) => l.jobId === job);
	if (known && isStepResumeFor(known, "holdCleared"))
		return { isSettled: true };
	const row = agents?.find((a) => a.id === job);
	const isBlocked = row?.state === PARKED_STATE;
	const marker =
		markers.find((m) => m.job?.jobId === job) ??
		markers.find((m) => m.sessionId === known?.sessionId);
	const name = `session ${job}, parked on repo hold ${hold.id} now cleared`;
	if (!marker) {
		io.log(`left ${name} alone: no park marker lists its issues`);
		return { isSettled: true };
	}
	if (row && !isTerminalAgent(row) && !isBlocked) {
		io.log(`left ${name} alone: it is live`);
		return { isSettled: true };
	}
	if (known?.handedOff !== undefined) {
		io.log(`left ${name} alone: it was handed off`);
		return { isSettled: true };
	}
	const holder = launches.find(
		(l) =>
			isLive(l) &&
			l.jobId !== job &&
			l.root === hold.root &&
			l.issues.some((n) => marker.issues.includes(n)),
	);
	if (holder) {
		io.log(`left ${name} alone: ${launchName(holder)} now holds its ticket`);
		return { isSettled: true };
	}
	const launch = buildClearedLaunch(
		job,
		marker,
		hold,
		known ?? buildMarkerLaunch(job, marker, hold, io.readActsBefore),
	);
	if (isBlocked) {
		const r = io.stop(launch.seat, job);
		if (!r.ok && !r.noJob) {
			io.log(`could not stop ${name}, the next tick retries: ${r.why}`);
			return { isSettled: false };
		}
	}
	io.log(`${name}: due back through the resume step`);
	return { isSettled: true, launch };
}

/**
 * @param {LoopLaunch[]} launches
 * @param {import("./repo-holds.js").LiftedHold[]} lifted
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[],
 *   settled: {hold: import("./repo-holds.js").LiftedHold, jobs: string[]}[]}}
 */
function queueLifted(launches, lifted, seen) {
	const { agents, io, now } = seen;
	if (!agents) return { launches, settled: [] };
	/** @type {Map<string, import("./parked.js").ParkMarkerRead[]|null>} */
	const byRoot = new Map();
	/** @param {string} root */
	const readMarkersIn = (root) => {
		const read = byRoot.get(root);
		if (read !== undefined) return read;
		const fresh = io.readParkMarkers(root);
		byRoot.set(root, fresh);
		return fresh;
	};
	let next = launches.map((l) => {
		if (!isActionable(l) || !isStepResumeFor(l, "holdCleared")) return l;
		const markers = readMarkersIn(l.root);
		if (!markers || markers.some((m) => m.sessionId === l.stepResume.sessionId))
			return l;
		io.log(
			`not resuming ${STEP_CAUSES.holdCleared.what(l, l.stepResume)}: its park marker no longer lists its issues`,
		);
		const { stepResume: _, ...rest } = l;
		return { ...rest, ...io.progressOf(rest), finishedAt: now };
	});
	const settled = lifted.flatMap((hold) => {
		const markers = readMarkersIn(hold.root);
		if (!markers) return [];
		const jobs = hold.jobs.filter((job) => {
			const { isSettled, launch } = judgeClearedJob(
				job,
				hold,
				{ launches: next, markers },
				seen,
			);
			if (launch) {
				const newest = next.findLastIndex((l) => l.jobId === job);
				next = newest < 0 ? [...next, launch] : next.with(newest, launch);
			}
			return isSettled;
		});
		return [{ hold, jobs }];
	});
	return { launches: next, settled };
}

const ENDED_JOB_STATES = new Set(["done", "stopped"]);

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isBootKillCandidate = (l) =>
	isActionable(l) &&
	!isHeld(l) &&
	l.handOffTries === undefined &&
	!(l.parked && isFounderWait(l.block?.cause));

/**
 * @param {JobLaunch} l
 * @param {Pick<BlockReads, "jobStateOf">} io
 */
const hasJobEnded = (l, io) => {
	const state = io.jobStateOf(l)?.state;
	return typeof state === "string" && ENDED_JOB_STATES.has(state);
};

/**
 * @param {LoopLaunch} l
 * @param {Tick} seen
 * @param {number} bootedAt
 * @returns {l is JobLaunch}
 */
function isBootKillable(l, { agents, io }, bootedAt) {
	if (l.launchedAt > bootedAt) return false;
	return isBootKillCandidate(l) && !isLiveIn(l, agents) && !hasJobEnded(l, io);
}

/**
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 * @param {number} bootedAt
 * @param {(l: LoopLaunch) => boolean} [isSpared]
 * @returns {LoopLaunch[]}
 */
function queueBootKilled(launches, seen, bootedAt, isSpared = () => false) {
	const { io } = seen;
	return launches.map((l) => {
		if (isSpared(l) || !isBootKillable(l, seen, bootedAt)) return l;
		const { block: _, parked: __, ...rest } = l;
		const { sessionId, cwd, flags } = io.resumeTargetOf(l);
		io.log(
			`${launchName(l)}, killed by a restart: due back through the resume step`,
		);
		return {
			...rest,
			...(l.block?.cause === "UNKNOWN" ? { blockUnread: true } : {}),
			stepResume: {
				cause: "bootKilled",
				at: l.launchedAt,
				sessionId,
				cwd,
				...(flags ? { flags } : {}),
				tries: 0,
			},
		};
	});
}

/**
 * @typedef {{mode: "away"|"normal", resume: (l: BlockedLaunch, seen: Tick)
 *   => LoopLaunch, hold: (l: BlockedLaunch, seen: Tick) => LoopLaunch}} ActHow
 */

/**
 * @type {Partial<Record<Act, (l: BlockedLaunch, seen: Tick, how: ActHow) =>
 *   LoopLaunch>>}
 */
const ACTS = {
	"stop-and-park": (l, seen, { mode }) =>
		stopPark(l, { act: "stop-and-park" }, mode, seen),
	"park-at-morning": (l, seen, { mode }) =>
		stopPark(l, { act: "park-at-morning" }, mode, seen),
	"attach-to-hold": (l, seen, { mode }) => parkLockedOut(l, mode, seen),
	hold: (l, seen, { hold }) => hold(l, seen),
	resume: (l, seen, { resume }) => resume(l, seen),
	"handoff-relaunch": (l, seen) => handOff(l, seen),
};

const RUNNING_ACTS = new Set(["resume", "handoff-relaunch"]);

/**
 * @param {{l: BlockedLaunch, act: Act}[]} acts
 * @param {Tick} seen
 * @param {ActHow} how
 * @returns {Map<string, LoopLaunch>}
 */
function actedOn(acts, seen, how) {
	const acted = new Map();
	for (const { l, act } of acts) {
		const handler = ACTS[act];
		if (handler && !(seen.barred && RUNNING_ACTS.has(act)))
			acted.set(l.jobId, handler(l, seen, how));
	}
	return acted;
}

/**
 * @param {LoopLaunch[]} launches
 * @param {Map<string, LoopLaunch>} acted
 */
const withActed = (launches, acted) =>
	launches.map((l) => (l.jobId && acted.get(l.jobId)) || l);

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnBlocks(launches, mode, seen) {
	const settled = seen.barred ? launches : settleTyped(launches, seen);
	const acts = blockedActs(settled, mode, seen);
	return withActed(
		settled,
		actedOn(acts, seen, { mode, resume: makeResume, hold: holdForResume }),
	);
}

/**
 * @param {LoopLaunch[]} launches
 * @param {BlockIo} io
 * @returns {{launches: LoopLaunch[], settled: boolean}}
 */
function settleStartedResumes(launches, io) {
	let settled = false;
	const out = launches.map((launch) => {
		const { resumeStarted: started, ...l } = launch;
		if (!started || l.jobId === null) return launch;
		settled = true;
		return settleStarted({ ...l, jobId: l.jobId }, started, io);
	});
	return { launches: out, settled };
}

/**
 * @param {JobLaunch} l
 * @param {ResumeStarted} started
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function settleStarted(l, { at, sessionId, cwd, act }, io) {
	const { on, move } = adoptTargetOf(l, act);
	const found = io.adoptResumed(on, { sessionId, cwd }, at, move);
	const killed = "a kill came between it and the state write";
	const what = `${launchName(l)}'s resume at ${iso(at)}`;
	/** @type {{failed: string}|(Resumed & {fromSessionId: string})} */
	let r;
	if (found && !("unread" in found)) {
		io.log(
			`${what} started a job ${buildResumedHow(found)}, which ${killed} left out of the state: tracking it, not resuming again`,
		);
		r = { ...found, fromSessionId: sessionId };
	} else if (io.jobStateOf(l)?.state === "stopped")
		r = {
			failed: found
				? `${killed}, and whether it started a job is unread: ${found.unread}`
				: `${killed}, and it started no job`,
		};
	else {
		io.log(`${what}: ${killed} before its stop, so it is left to its act`);
		return l;
	}
	if (act.kind === "api") return settleFallBack(l, r, { now: at, io }, act);
	return settleStartedLimit(l, act, r, { what, at, io });
}

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnIdle(launches, mode, seen) {
	const owed = launches.map((l) =>
		isActionable(l) &&
		(l.handOffTries !== undefined || isDeadAfterBootResume(l, seen)) &&
		!seen.barred
			? handOff(l, seen, true)
			: l,
	);
	const read = idleActs(owed, mode, seen);
	const acted = actedOn(read.acts, seen, {
		mode,
		resume: typeIdleResume,
		hold: holdIdle,
	});
	const unblocked = new Map(
		[...acted].map(([jobId, { block: _, ...l }]) => [jobId, l]),
	);
	return withActed(read.launches, unblocked);
}

/**
 * @param {Map<string, string>} logged
 * @param {string} key
 * @param {import("./block-cause.js").Reading} reading
 * @returns {string|null}
 */
function unknownNews(logged, key, reading) {
	if (reading.cause !== "UNKNOWN") {
		logged.delete(key);
		return null;
	}
	if (logged.get(key) === reading.why) return null;
	logged.set(key, reading.why);
	return reading.why;
}

/** @param {unknown} job */
function jobShape(job) {
	if (typeof job !== "object" || job === null) return job;
	const rec = /** @type {Record<string, unknown>} */ (job);
	return Object.fromEntries(
		[
			"state",
			"tempo",
			"detail",
			"needs",
			"needsOverlay",
			"block",
			"inFlight",
			"cliVersion",
		].map((k) => [k, rec[k]]),
	);
}

/**
 * @param {{readJob: (l: SessionRef) => unknown,
 *   readTail: (l: SessionRef, job: unknown) => Record<string, unknown>[]|null,
 *   log: (line: string) => void}} io
 * @returns {CauseOf}
 */
function causeReader(io) {
	/** @type {Map<string, string>} */
	const logged = new Map();
	return (l, row, name) => {
		const job = io.readJob(l);
		const tail =
			io
				.readTail(l, job)
				?.filter((r) => r.type === "user" || r.type === "assistant") ?? null;
		const reading = blockCause({
			row,
			job: /** @type {Parameters<typeof blockCause>[0]["job"]} */ (job),
			tail,
		});
		const why = unknownNews(logged, l.jobId, reading);
		if (why !== null)
			io.log(
				`block unread ${name}: ${why}; row ${JSON.stringify(row)}; job ${JSON.stringify(jobShape(job))}`,
			);
		return reading;
	};
}

module.exports = {
	ATTACH_VERDICT_MS,
	isTakenSinceStop,
	typedVerdict,
	causeReader,
	actOnBlocks,
	logNetWaits,
	isRunAdmitted,
	netGateOf,
	actOnIdle,
	unparkAnswered,
	buildChildLine,
	buildHandOffArgs,
	indented,
	hasJobEnded,
	isBootKillCandidate,
	isBootKillable,
	buildStepStatus,
	stepKindOf,
	UNSETTLED_STEP_KINDS,
	isStepResumeFor,
	LISTING_GRACE_MS,
	markParked,
	nextResumeAt,
	releaseAwayParks,
	queueBootKilled,
	queueLifted,
	resumableOf,
	resumeHeldLaunches,
	settleStartedResumes,
	unknownNews,
};
