/*
 * refill-tick-core.js — the refill loop's tick (#2012, #2123, spec #1995,
 * #4212): its step order, its dry-run policy and its own readings, with no I/O
 * of its own. Every read, write and child process goes through the TickIo port,
 * whose production adapter is lib/refill-tick.js; a dry run takes that adapter
 * with its writes no-ops, so the policy branches here are the only place a dry
 * run differs: it previews over no control as over a stopped one, judges no
 * listing by a boot's kills and stops at its decision.
 *
 * A TICK: read founder presence, and in away mode write what it changes under
 * the control lock (#2522), untick each repo its owner opted out (#4188), reap,
 * take the quiet bench route's step (lib/quiet-bench-tick.js, #3852), settle
 * what a kill before the last tick's write left out of the state (#4180), stop
 * each job that never started, tend the served checkouts (their landing queue,
 * the machine incident filers, the repo holds and the `.git` probe), read the
 * listing, stop each overflow session past its allowance (#3698), send each repo
 * hold's notice, queue the launches a boot killed (#3880), judge the finished
 * launches for progress, act on the blocked and idle ones (lib/refill-blocks.js),
 * queue the sessions parked on each lifted hold (#3863), read admission and the
 * seats and act on the limit-held launches (#3735), then decide
 * (lib/refill-decide.js), first with an empty frontier, the per-repo
 * shortlists being read only on a tick that could launch. From the decision on,
 * settleTick: resumes, then each batch on record before its launcher runs
 * (#4157, #4180), the pause, the state, the morning review (#2017, #3765). Then
 * the tick's row is appended to the concurrency record (lib/concurrency.js,
 * #2497).
 */

const { isTerminalAgent } = require("./agent-liveness.js");
const { buildTickRecord } = require("./concurrency.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const { batchesOf } = require("./refill-batch.js");
const blocks = require("./refill-blocks.js");
const {
	bootSparedJobs,
	isEmptyListingTrusted,
	settleBootKilled,
	withManagerRestart,
} = require("./refill-boot.js");
const {
	actsRead,
	awayChangeOf,
	buildResumeWaitLine,
	decideTick,
	isParkRoutingMode,
	NOTHING_LAUNCHABLE,
	startedAt,
	UNREAD,
} = require("./refill-decide.js");
const { buildErrorText } = require("./caught.js");
const { buildGoalProgress } = require("./refill-goal.js");
const {
	buildFrontierReadText,
	buildLaunchLine,
	buildSkipText,
	controlInMode,
	controlWithoutOptedOut,
	handedOffSince,
	landingRoots,
	launchesSince,
	runningOf,
	summaryOf,
	withAbsentRead,
} = require("./refill-loop.js");
const { buildSeatName } = require("./refill-seats.js");
const {
	batchLaunching,
	lateStopped,
	tickSettled,
	withoutLaunching,
} = require("./refill-state.js");
const { buildDriftLines } = require("./registry-agents.js");
const {
	overflowReadings,
	seatTriedAfter,
	sizeResumeSeats,
} = require("./seat-reading.js");
const { unclosedLaunches } = require("./unclosed-launch.js");
const {
	buildOverflowStartLines,
	firstOverflowStart,
	planSeatBasisOf,
} = require("./overflow-notice.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

const {
	isHeld,
	isLive,
	isStepResume,
	launchName,
	LISTING_GRACE_MS,
	markParked,
} = blocks;

/** @typedef {import("./refill-loop.js").Control} Control */
/** @typedef {import("./refill-loop.js").ControlRead} ControlRead */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-state.js").LoopState} LoopState */
/** @typedef {import("./refill-state.js").Hold} Hold */
/** @typedef {import("./refill-batch.js").BatchOutcome} BatchOutcome */
/** @typedef {import("./refill-loop.js").FrontierRead} FrontierRead */

/* Enough for the no-progress run and for `status`. Untraced. */
const HISTORY_KEPT = 50;
/* A bound on the state file, since a ticket outranked for weeks must keep its
 * record: roomy against the 7 the live file held on 2 Nov 2026. A guess. */
const UNCLOSED_KEPT = 50;
/* The skipped rows an idle tick's log line names. Untraced. */
const LINE_SKIPS = 3;

/**
 * The control this tick's read of the founder leaves (awayChangeOf), null where
 * it changes nothing.
 * @param {Control} control
 * @param {number|null} lastPromptAt
 * @param {number} now
 * @returns {Control|null}
 */
function controlAfterPresence(control, lastPromptAt, now) {
	const { away } = control;
	const change = awayChangeOf(
		{ mode: control.scope.mode, ...(away ? { away } : {}) },
		lastPromptAt,
		now,
	);
	if (change === null) return null;
	return change === "return"
		? controlInMode(control, "normal", now)
		: withAbsentRead(control, true, now);
}

/**
 * The stored count after a tick that parked `launches`' rows stamped `now`.
 * @param {Pick<LoopState, "handedOff">} state
 * @param {import("./refill-decide.js").AwaySwitch|undefined} away the switch,
 *   absent in normal mode
 * @param {LoopLaunch[]} launches
 * @param {number} now
 */
function nextHandedOff(state, away, launches, now) {
	if (!away) return state.handedOff;
	const parked = launches.filter(
		(l) => l.parkedAway === true && l.parkStopped === now,
	).length;
	return {
		from: away.since,
		count: handedOffSince(state, away.since) + parked,
	};
}

/**
 * The holds a frontier-reading tick leaves. An away tick opens none, as a seat's
 * reset would launch nothing there (#2355), but keeps one whose seat still reads
 * full, so its start stands (#3850).
 * @param {import("./refill-decide.js").Skip[]} held this tick's
 * @param {Hold[]} before
 * @param {number} now
 * @param {"normal"|"away"} mode
 * @returns {Hold[]}
 */
const holdsOf = (held, before, now, mode) =>
	held.flatMap((h) => {
		const since = before.find(
			(b) => b.root === h.root && b.number === h.number,
		)?.since;
		if (since !== undefined) return [{ ...h, since }];
		return isParkRoutingMode(mode) ? [{ ...h, since: now }] : [];
	});

/**
 * `state` with the members of the batch a kill cut off that `adopt` finds
 * started tracked as launches and counted (#4180); as it was where none was in
 * flight.
 * Residual: the kill leaves the dispatcher running, and a member it launches
 * after `adopt` reads the ledger is never tracked.
 * @param {LoopState} state
 * @param {(launching: import("./refill-batch.js").Launching) => LoopLaunch[]} adopt
 * @returns {LoopState}
 */
function settleLaunching(state, adopt) {
	if (!state.launching) return state;
	const launched = adopt(state.launching);
	const rest = withoutLaunching(state);
	return {
		...rest,
		launches: [...rest.launches, ...launched],
		launchCount: rest.launchCount && {
			...rest.launchCount,
			count: rest.launchCount.count + launched.length,
		},
	};
}

/**
 * A tick whose review root has no workflow-core config: its log lines, one
 * on the due tick and none after, and the date it records, today on that
 * tick so the line is not repeated.
 * @param {{due: boolean, root: string, lastRunOn: string|null,
 *   today: string}} skip
 * @returns {{lines: string[], runOn: string|null}}
 */
const buildReviewSkip = ({ due, root, lastRunOn, today }) =>
	due
		? {
				lines: [`morning review: not run, ${root} has no workflow-core config`],
				runOn: today,
			}
		: { lines: [], runOn: lastRunOn };

/**
 * The `admission.js` arguments the loop's free-slot count passes:
 * dispatch-sessions.sh's per-member re-read's, so a slot counted is one that
 * re-read admits (#2500), with the allowance limb left to the cap; its test
 * pins them to the script's.
 */
const FREE_SLOT_ARGS = ["--json", "--launch", "--skip-allowance"];

/**
 * The launches whose session has left the listing or ended, and are not
 * judged yet. Nothing is judged off an unread listing, and a launch with no
 * job id is never judged: nothing ties it to a listed session. One owed a hand-off
 * or still watched after a boot's resume is actOnIdle's to settle (#3880). The listing
 * must span every seat the loop launches on (lib/refill-tick.js's SEATS).
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
 * The launches a tick's state keeps, order unchanged (#3775): every live one,
 * however old, since blockedActs and runningOf see only what is kept, and of
 * the rest the HISTORY_KEPT latest to finish, or to launch where none did.
 * Admission bounds the running ones; a limit-held launch, stopped so outside
 * admission, stays until it resumes or parks (#3790, #3793).
 * Also the UNCLOSED_KEPT latest unclosed launches, which a low-ranked ticket can
 * otherwise outwait, as #3609's record did (#3782).
 * @param {LoopLaunch[]} launches
 */
function keptLaunches(launches) {
	const settledAt = (/** @type {LoopLaunch} */ l) =>
		l.finishedAt ?? l.launchedAt;
	const capped = new Set(
		launches
			.filter((l) => !isLive(l))
			.sort((a, b) => settledAt(a) - settledAt(b))
			.slice(-HISTORY_KEPT)
			.concat(unclosedLaunches(launches).slice(-UNCLOSED_KEPT)),
	);
	return launches.filter((l) => isLive(l) || capped.has(l));
}

/**
 * The launches with `sessionId` taken from the listing for each that has none
 * yet and whose job it shows (#2311), for the wake on a session's end and
 * actsOf. Off an unread listing, or for a job it does not show, a launch is
 * returned as it was.
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
 * The launches after one listing: each the listing first shows given its
 * session id, then each newly finished one marked with `progressOf`'s fields,
 * then each still listed marked parked or not (markParked). The id comes first, so a
 * launch whose first listing already shows it ended is judged with it.
 * @template {object} P
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {{progressOf: (l: LoopLaunch) => P,
 *   causeOf: import("./refill-blocks.js").CauseOf}} read
 * @returns {LoopLaunch[]}
 */
function judgedLaunches(launches, agents, now, { progressOf, causeOf }) {
	const listed = withSessionIds(launches, agents);
	const done = new Set(newlyFinished(listed, agents, now));
	const judged = listed.map((l) =>
		done.has(l) ? { ...l, ...progressOf(l), finishedAt: now } : l,
	);
	return markParked(judged, agents, causeOf, now);
}

/**
 * The loop log's line for a finished launch.
 * @param {LoopLaunch} l
 */
function buildFinishLine(l) {
	const read = actsRead(l);
	const acts = read
		? Object.entries(read)
				.map(([kind, n]) => `${kind} ${n}`)
				.join(", ") || "no acts"
		: UNREAD;
	return `finished ${launchName(l)}: ${acts}`;
}

/**
 * Whether a control read mid-tick asks the loop to stop. A control gone
 * missing does, as at the tick's start.
 * @param {Control|null} control
 */
const isStopRequested = (control) => control?.stopRequested !== false;

/**
 * Whether a control read mid-tick holds back the tick's next launch: a stop or
 * a pause.
 * @param {Control|null} control
 */
const isLaunchBarred = (control) =>
	isStopRequested(control) || control?.paused !== undefined;

/**
 * What the dispatches did, dispatching each batch in turn after re-reading the
 * control, and none once it asks for a stop (#2126) or a pause: one dispatch can
 * hold the tick for minutes. Residual: a dispatch already running still launches
 * every member.
 * @param {import("./refill-decide.js").Launch[][]} batches
 * @param {() => Control|null} readControl
 * @param {(batch: import("./refill-decide.js").Launch[]) => BatchOutcome} launch
 * @returns {Outcome}
 */
function launchUntilBarred(batches, readControl, launch) {
	/** @type {Outcome} */
	const outcome = { launched: [], refused: [], unreached: [] };
	for (const [i, batch] of batches.entries()) {
		if (isLaunchBarred(readControl())) {
			outcome.unreached = batches.slice(i).flat();
			break;
		}
		const r = launch(batch);
		outcome.launched.push(...r.launched);
		outcome.refused.push(...r.refused);
		const { resumeRefused: reason } = r;
		if (reason) {
			outcome.refused.push(
				...batches
					.slice(i + 1)
					.flat()
					.map((l) => ({ launch: l, reason })),
			);
			break;
		}
	}
	return outcome;
}

/**
 * @param {{root: string, prompt: string}[]} launches
 */
const buildLaunchesLine = (launches) => launches.map(launchName).join("; ");

/**
 * A probed seat's outcome: the outcome line scripts/usage-probe.js writes on
 * stderr, else how its run failed.
 * @param {string} stderr
 * @param {string|null} failed runChild's failure, null on exit 0
 */
function parseProbeOutcome(stderr, failed) {
	const line = stderr.split("\n").find((l) => l.startsWith(OUTCOME_PREFIX));
	return line
		? line.slice(OUTCOME_PREFIX.length).trim()
		: `no outcome line, ${failed ?? "exit 0"}`;
}

/**
 * An idle tick's account of the frontier it read (#2561).
 * @param {Extract<import("./refill-decide.js").Decision, {idle: unknown}>} d
 * @param {FrontierRead|null} read
 */
function frontierNotes(d, read) {
	if (read === null) return [];
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const s of d.skipped) counts.set(s.why, (counts.get(s.why) ?? 0) + 1);
	return [
		buildFrontierReadText(read),
		...(counts.size > 0
			? [
					`skipped ${[...counts].map(([why, n]) => `${n} ${why}`).join(", ")}`,
					`first ${d.skipped.slice(0, LINE_SKIPS).map(buildSkipText).join(", ")}`,
				]
			: []),
	];
}

/**
 * What a tick's dispatches did: the members launched, each refused with its
 * reason, and those a stop left undispatched.
 * @typedef {BatchOutcome & {unreached: import("./refill-decide.js").Launch[]}} Outcome
 */

/**
 * A launching tick's line: what launched, and each member the dispatcher
 * refused as refused, with its reason (#2500).
 * @param {Outcome} o
 */
const buildOutcomeLine = (o) =>
	[
		...(o.launched.length > 0 ? [buildLaunchLine(o.launched)] : []),
		...o.refused.map(
			(r) => `refused ${buildLaunchesLine([r.launch])}: ${r.reason}`,
		),
		...(o.unreached.length > 0
			? [
					`not dispatched ${buildLaunchesLine(o.unreached)}: a stop or a pause landed first`,
				]
			: []),
	].join("; ");

/**
 * The decision's log line, an idle one naming admission's free slots and its
 * frontier, a launching one its dispatches' outcome and its frontier read's
 * time, which sizes the shortlist cap (#2677), and a tick that probed
 * naming each seat's outcome, so the log alone tells a stale-reading wait
 * that had a slot from one that had none (#2362).
 * @param {import("./refill-decide.js").Decision} d
 * @param {Outcome} outcome
 * @param {{freeSlots: number|null, probes: import("./seat-reading.js").Probe[], read: FrontierRead|null,
 *   resumesDue: number, resumesStarted: number}} seen
 */
function buildTickLine(
	d,
	outcome,
	{ freeSlots, probes, read, resumesDue, resumesStarted },
) {
	if ("stop" in d) return summaryOf(d);
	const head = d.launches.length > 0 ? buildOutcomeLine(outcome) : summaryOf(d);
	const notes = [
		...(resumesDue > 0
			? [`resumed ${resumesStarted} of ${resumesDue} due`]
			: []),
		...(d.launches.length === 0
			? [
					...(freeSlots === null ? [] : [`free slots: ${freeSlots}`]),
					...frontierNotes(d, read),
				]
			: []),
		...(d.launches.length > 0 && read ? [buildFrontierReadText(read)] : []),
		...(probes.length > 0
			? [`probed ${probes.map((p) => `${p.seat}: ${p.outcome}`).join(", ")}`]
			: []),
	];
	return `${head}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * A log line for each resume the decision left waiting on its seat's cap (#3911).
 * @param {import("./refill-decide.js").Decision} d
 */
const buildCapHeldLines = (d) =>
	"stop" in d
		? []
		: (d.capHeld ?? []).map(({ line, seat }) =>
				buildResumeWaitLine(
					line,
					`the cap on ${buildSeatName(seat)} has no fit left`,
				),
			);

/**
 * The state's stop record for a stop decision, else null.
 * @param {import("./refill-decide.js").Decision} d
 * @param {number} at
 */
const stoppedOf = (d, at) =>
	"stop" in d ? { at, reason: d.stop, detail: d.detail } : null;

/**
 * The record of the first start on an overflow seat after one on a plan seat,
 * since `since`, the last record's time, logged, or null. The credential scan
 * runs only then; its failure is logged, since the launches it follows are not
 * yet in the state.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {LoopLaunch[]} launches the state's, the tick's acts made, and its
 *   launches
 * @param {number|null} since
 * @param {{readOmittedDirs: () => string[], log: (line: string) => void}} io
 * @returns {import("./overflow-notice.js").OverflowStart|null}
 */
function recordOverflowStart(input, launches, since, io) {
	const first = firstOverflowStart(launches, since);
	if (first === null) return null;
	/** @type {string[]} */
	let omitted = [];
	try {
		omitted = io.readOmittedDirs();
	} catch (err) {
		io.log(`credentials scan failed: ${buildErrorText(err)}`);
	}
	const start = {
		at: first.at,
		seat: first.launch.seat,
		planSeats: input.seats.map(planSeatBasisOf),
		omitted,
	};
	io.log(
		`first overflow launch on ${buildSeatName(first.launch.seat)}: ${buildOverflowStartLines(start).join("; ")}`,
	);
	return start;
}

/**
 * @typedef {(resumes: import("./refill-decide.js").HeldResume[],
 *   launches: LoopLaunch[], isStopped: () => boolean,
 *   record: (launches: LoopLaunch[]) => void) =>
 *   {launches: LoopLaunch[], started: number, waiting: boolean}} ResumeHeld
 */

/**
 * The decision's resumes made, ahead of its launches; none on a stop. `record`
 * writes the state with the launches as the step leaves each resume.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {LoopLaunch[]} launches
 * @param {{readControl: () => ControlRead, resumeHeld: ResumeHeld}} io
 * @param {(launches: LoopLaunch[]) => void} record
 */
const resumeDecided = (decision, launches, io, record) =>
	"stop" in decision
		? { launches, started: 0, waiting: false }
		: io.resumeHeld(
				decision.resumes,
				launches,
				() => isLaunchBarred(io.readControl().control),
				record,
			);

/** @param {import("./refill-decide.js").TickInput} input */
const dueCount = (input) => input.resumable?.length ?? 0;

/**
 * The state's goal progress after a tick, as it stands where the tick read no
 * frontier.
 * @param {LoopState["goalProgress"]} before
 * @param {FrontierRead|null} read
 * @param {number} now
 */
const goalProgressAfter = (before, read, now) =>
	read === null ? before : buildGoalProgress(before, read.goal, now);

/**
 * The input's resumes the step left held, for a late stop to name.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {LoopLaunch[]} launches
 */
const leftDue = (input, launches) =>
	(input.resumable ?? []).filter((r) =>
		launches.some((l) => l.jobId === r.jobId && isStepResume(l)),
	);

/**
 * The tick's launches as batches: none on a stop, nor behind a resume the
 * re-read made wait, which a fresh start would overtake.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {boolean} waiting
 */
const buildLaunchBatches = (decision, waiting) =>
	"stop" in decision || waiting ? [] : batchesOf(decision.launches);

/**
 * @param {import("./refill-decide.js").Decision} decision
 * @param {{writePause: (pause: import("./refill-decide.js").Pause) => void}} io
 */
function writeDecidedPause(decision, io) {
	if (!("stop" in decision) && decision.pause) io.writePause(decision.pause);
}

/**
 * The state's record of a tick: a stop leaves no idle reason to read.
 * @param {import("./refill-decide.js").Decision} decision
 * @param {number} at
 * @param {string} summary
 */
const buildLastTick = (decision, at, summary) => ({
	at,
	summary,
	...("stop" in decision
		? {}
		: {
				skipped: decision.skipped,
				idle: decision.idle,
				...(decision.planWait ? { planWait: decision.planWait } : {}),
			}),
});

/**
 * A tick from its decision on: dispatch its launches while the control asks
 * for no stop or pause, write the no-progress pause it decided, write the
 * state, then take the morning review's step, which
 * starts its child detached and returns at once (reviewStep).
 * A stop that landed during the dispatches or the review is logged and
 * recorded as `stop: explicit`, or `control-damaged` where the re-read found
 * the control damaged, so the loop ends at this tick's end, which
 * `stop` promises (#2126).
 * Each resume and each batch is on record in the state before its launcher
 * runs (#4157, #4180).
 * @param {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision, state: LoopState,
 *   judged: LoopLaunch[], probes: import("./seat-reading.js").Probe[], read: FrontierRead|null,
 *   probeBrokenRoots: string[], bootedAt?: number, sameBootRestart?: true,
 *   away?: import("./refill-decide.js").AwaySwitch}} tick
 * @param {{readControl: () => ControlRead,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[]) => BatchOutcome,
 *   resumeHeld: ResumeHeld,
 *   writePause: (pause: import("./refill-decide.js").Pause) => void,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   updateState: (transition: import("./refill-state.js").Transition) =>
 *     LoopState,
 *   readOmittedDirs: () => string[],
 *   log: (line: string) => void, now: () => number}} io
 * @returns {{decision: import("./refill-decide.js").Decision,
 *   launched: number}} the late stop where one landed, else the tick's
 *   decision, and how many sessions the tick started
 */
function settleTick(
	{
		input,
		decision,
		state,
		judged,
		probes,
		read,
		probeBrokenRoots,
		bootedAt,
		sameBootRestart,
		away,
	},
	io,
) {
	/** @type {LoopLaunch[]} */
	const launchedSoFar = [];
	/** @type {(launches: LoopLaunch[],
	 *   launching?: import("./refill-batch.js").Launching) => LoopState} */
	const record = (launches, launching) =>
		io.updateState(
			batchLaunching(keptLaunches(launches), state, {
				bootedAt,
				sameBootRestart,
				...(launching
					? {
							inFlight: {
								launching,
								launchCount: {
									from: input.noProgressFrom,
									count:
										launchesSince(state, input.noProgressFrom) +
										launchedSoFar.length,
								},
							},
						}
					: {}),
			}),
		);
	const {
		launches: afterResumes,
		started,
		waiting,
	} = resumeDecided(decision, judged, io, record);
	const outcome = launchUntilBarred(
		buildLaunchBatches(decision, waiting),
		() => io.readControl().control,
		(batch) => {
			record([...afterResumes, ...launchedSoFar], { at: io.now(), batch });
			const r = io.launchBatch(batch);
			launchedSoFar.push(...r.launched);
			return r;
		},
	);
	const summary = buildTickLine(decision, outcome, {
		freeSlots: input.paused ? null : input.freeSlots,
		probes,
		read,
		resumesDue: dueCount(input),
		resumesStarted: started,
	});
	for (const line of buildCapHeldLines(decision)) io.log(line);
	io.log(summary);
	writeDecidedPause(decision, io);
	const overflowStart = recordOverflowStart(
		input,
		[...afterResumes, ...outcome.launched],
		state.overflowStart?.at ?? null,
		io,
	);
	const settledState = io.updateState(
		tickSettled(
			{
				launches: keptLaunches([...afterResumes, ...outcome.launched]),
				lastTick: buildLastTick(decision, input.now, summary),
				/* A tick that does not stop outlives any record, a stop a `start`
				 * overtook included. */
				stopped: stoppedOf(decision, input.now),
				held:
					"stop" in decision || read === null
						? state.held
						: holdsOf(decision.held, state.held, input.now, input.mode),
				launchCount: {
					from: input.noProgressFrom,
					count:
						launchesSince(state, input.noProgressFrom) +
						outcome.launched.length,
				},
				handedOff: nextHandedOff(state, away, judged, input.now),
				overflowStart: overflowStart ?? state.overflowStart,
				goalProgress: goalProgressAfter(state.goalProgress, read, input.now),
				probeBrokenRoots,
				seatTriedAt: seatTriedAfter(state.seatTriedAt, probes, input.now),
				bootedAt,
				sameBootRestart,
			},
			state,
		),
	);
	const reviewRunOn = io.runReview(settledState.reviewRunOn, input.now);
	const reread = "stop" in decision ? null : io.readControl();
	const late =
		reread === null || !isStopRequested(reread.control)
			? null
			: decideTick({
					...input,
					stopRequested: true,
					controlDamaged: reread.damaged,
					resumable: leftDue(input, afterResumes),
				});
	if (late) io.log(summaryOf(late));
	if (late || reviewRunOn !== settledState.reviewRunOn)
		io.updateState(
			lateStopped(
				(late && stoppedOf(late, io.now())) ?? settledState.stopped,
				reviewRunOn,
			),
		);
	return {
		decision: late ?? decision,
		launched: outcome.launched.length + started,
	};
}

/**
 * Stop each job that never started (lib/hung-jobs.js's neverStartedJobs,
 * #2467) through `stop(job)`, a `claude stop <short id>` on its seat that
 * answers null or why it failed; the log line for each. Its live processes
 * are lib/registry-agents.js's, which needs no CLI (#2665). Off a registry
 * seat that would not read, or no job store, it stops nothing and says why;
 * a job on a seat with no registry at all is left unjudged.
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Parameters<typeof neverStartedJobs>[0]|null} jobs
 * @param {(job: ReturnType<typeof neverStartedJobs>[number]) => string|null} stop
 */
function stopNeverStarted(registry, jobs, stop) {
	/** @param {string} why */
	const skipped = (why) => [`never-started jobs unjudged: ${why}`];
	if (registry.faults.length > 0) return skipped(registry.faults.join("; "));
	if (!jobs) return skipped("no job store would open");
	const live = new Set(registry.agents.map((a) => a.sessionId));
	return neverStartedJobs(jobs, { live, seats: registry.seats }).map((j) => {
		const failed = stop(j);
		const age = j.age === null ? "an unreadable age" : `${Math.floor(j.age)}m`;
		return `${failed ? "could not stop" : "stopped"} never-started job ${j.job} on ${j.seat} (${j.intent ?? "no intent"}; ${age}, no pid, no transcript)${failed ? `: ${failed}` : ""}`;
	});
}

/**
 * The reads, writes and child processes a tick runs through. Each act a dry run
 * skips is a port, whose dry-run adapter answers as though it did nothing.
 * @typedef {ReturnType<typeof import("./refill-seats.js").readDeclaredSeats>} DeclaredSeats
 * @typedef {import("./refill-blocks.js").BlockIo} BlockIo
 * @typedef {import("./refill-blocks.js").Tick} Seen
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./registry-agents.js").RegistryListing} RegistryListing
 * @typedef {import("./seat-reading.js").Probe} Probe
 * @typedef {{seats: import("./refill-decide.js").SizedSeat[], probes: Probe[]}} SeatsRead
 * @typedef {{control: Control|null,
 *   wrote: {write: Control, fresh: Control}|null}} ControlWrite
 * @typedef {{
 *   now: () => number,
 *   log: (line: string) => void,
 *   readControl: () => ControlRead,
 *   changeControl: (change: (c: Control) => Control|null) =>
 *     ControlWrite|{busy: string}|null,
 *   isOptedOut: (root: string) => boolean,
 *   readConfiguredSeats: () => string[],
 *   readIncluded: () => string[],
 *   servedRoots: (scope: import("./refill-loop.js").Scope) =>
 *     {roots: string[], dropped: {root: string, why: string}[]},
 *   reap: () => void,
 *   tendQuietBench: (control: Control,
 *     tick: {lastTypedAt: number|null, served: string[], now: number}) => Control,
 *   readManagerRestart: () => Parameters<typeof withManagerRestart>[1],
 *   readCurrentBootId: () => Parameters<typeof withManagerRestart>[2],
 *   readState: () => LoopState,
 *   settleKilled: (read: LoopState, served: string[]) => LoopState,
 *   readRegistry: () => RegistryListing,
 *   stopNeverStarted: (registry: RegistryListing, spared: Set<string>) => string[],
 *   tendCheckouts: (served: string[], launches: LoopLaunch[], now: number) => string[],
 *   readListing: (trusted: boolean) => {agents?: AgentRecord[]|null, why?: string|null},
 *   capOverflowSessions: (declared: DeclaredSeats, agents: AgentRecord[]|null) => void,
 *   blockIo: (served: string[]) => BlockIo,
 *   readSwapHold: () => Seen["swapHold"],
 *   sendHoldNotices: (roots: string[],
 *     seen: {agents: AgentRecord[]|null, isPaused: boolean}, now: number) => void,
 *   progressOf: (l: LoopLaunch, served: string[]) => object,
 *   causeOf: import("./refill-blocks.js").CauseOf,
 *   actOnLaunches: (listed: LoopLaunch[], mode: "normal"|"away",
 *     served: string[], seen: Seen) => LoopLaunch[],
 *   attachProbeParks: (broken: string[], launches: LoopLaunch[]) => void,
 *   readLiftedHolds: (roots: string[]) => Parameters<typeof blocks.queueLifted>[1],
 *   releaseEndedHolds: (before: LoopLaunch[], after: LoopLaunch[], io: BlockIo) => void,
 *   readFreeSlots: () => {slots: number,
 *     admission: import("./admission.js").AdmissionJson|null},
 *   actOnLimits: (before: LoopLaunch[], judged: LoopLaunch[], mode: "normal"|"away",
 *     seen: Parameters<typeof blocks.actOnLimits>[2]) =>
 *     {launches: LoopLaunch[], slots: number, workingChange: number},
 *   readSeats: (seats: string[], slots: number, root: string|undefined,
 *     how: {typedSeat: string|null, sizeAll?: boolean}) => SeatsRead,
 *   probeDueSeats: (seats: string[], triedAt: Record<string, number>) => Probe[],
 *   seatBudget: typeof import("./overflow-budget.js").seatBudget,
 *   startDueConsoleReads: (declared: DeclaredSeats,
 *     seats: import("./refill-decide.js").SeatReading[], root: string|undefined) => void,
 *   capSizer: (root: string|undefined) => Parameters<typeof sizeResumeSeats>[3],
 *   readGateJudgements: () => import("./gate-sweep.js").Judgement[],
 *   readTickHolds: (served: string[], broken: string[]) =>
 *     {holds: import("./refill-decide.js").TickInput["holds"]},
 *   readFrontier: (roots: string[], goal: import("./refill-loop.js").Scope["goal"]) =>
 *     Promise<Awaited<ReturnType<typeof import("./refill-frontier.js").refillFrontier>>>,
 *   readParkers: (frontier: import("./refill-decide.js").MergedRow[]) =>
 *     import("./refill-decide.js").ParkerReading[],
 *   sizeParkerSeats: (seats: import("./refill-decide.js").SizedSeat[],
 *     parkers: import("./refill-decide.js").ParkerReading[], root: string|undefined) =>
 *     import("./refill-decide.js").SizedSeat[],
 *   launchBatch: (batch: import("./refill-decide.js").Launch[], served: string[]) =>
 *     BatchOutcome,
 *   resumeHeld: (resumes: import("./refill-decide.js").HeldResume[],
 *     held: LoopLaunch[], seen: Seen,
 *     how: {isStopped: () => boolean, record: (launches: LoopLaunch[]) => void}) =>
 *     {launches: LoopLaunch[], started: number, waiting: boolean},
 *   writePause: (pause: import("./refill-decide.js").Pause, noProgressFrom: number) => void,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   updateState: (transition: import("./refill-state.js").Transition) => LoopState,
 *   readOmittedDirs: (declared: DeclaredSeats) => string[],
 *   dropSettledLifted: (settled: ReturnType<typeof blocks.queueLifted>["settled"]) => void,
 *   dropManagerRestart: (marker: NonNullable<Parameters<typeof withManagerRestart>[1]>) => void,
 *   appendTick: (record: ReturnType<typeof buildTickRecord>) => void,
 * }} TickIo
 */

/**
 * The control `change` leaves, made on a fresh read under the control lock and
 * `said` called on what it wrote; `control` where it changes nothing. A lock
 * held past the wait leaves the change to the next tick, this one going on as
 * stored. A dry run's adapter writes nothing, answering null, and the tick
 * goes on over the change previewed.
 * @param {TickIo} io
 * @param {Control|null} control
 * @param {(c: Control) => Control|null} change
 * @param {{what: string, said: (write: Control, fresh: Control) => void}} how
 *   `what`, the change's name in the busy line
 */
function settleUnderLock(io, control, change, { what, said }) {
	const next = control && change(control);
	if (!next) return control;
	const written = io.changeControl(change);
	if (written === null) return next;
	if ("busy" in written) {
		io.log(`${what} waits for the next tick: ${written.busy}`);
		return control;
	}
	if (written.wrote) said(written.wrote.write, written.wrote.fresh);
	return written.control;
}

/**
 * The control after this tick's read of the founder (controlAfterPresence).
 * @param {TickIo} io
 * @param {Control|null} control
 * @param {number|null} lastPromptAt
 * @param {number} now
 */
const settleAwayMode = (io, control, lastPromptAt, now) =>
	settleUnderLock(
		io,
		control,
		(c) => controlAfterPresence(c, lastPromptAt, now),
		{
			what: "away mode's change",
			said: (write) => {
				if (write.scope.mode === "normal")
					io.log(
						`mode normal: the founder is back, a prompt typed at ${new Date(lastPromptAt ?? now).toISOString()} after a tick read him absent`,
					);
			},
		},
	);

/**
 * The control with each ticked repo its owner has opted out unticked
 * (controlWithoutOptedOut). A busy lock leaves it ticked a tick longer, which
 * serves nothing: scopeRoots drops it meanwhile.
 * @param {TickIo} io
 * @param {Control|null} control
 */
const settleOptedOut = (io, control) =>
	settleUnderLock(
		io,
		control,
		(c) => controlWithoutOptedOut(c, io.isOptedOut)?.control ?? null,
		{
			what: "the opt-out untick",
			said: (write, fresh) => {
				for (const root of fresh.scope.repos)
					if (!write.scope.repos.includes(root))
						io.log(
							`unticked: ${root} (opted out); a return needs a fresh tick`,
						);
			},
		},
	);

/**
 * The tick's listing, an empty one read as nothing live where a boot's killed
 * launches allow it. A dry run judges nothing by it, so it reads the plain one.
 * @param {TickIo} io
 * @param {boolean} dryRun
 * @param {LoopState} state
 * @param {RegistryListing} registry
 */
function readTickListing(io, dryRun, state, registry) {
	const trusted = !dryRun && Boolean(isEmptyListingTrusted(state, registry));
	const read = io.readListing(trusted);
	if (read.why && (trusted || (!dryRun && state.sameBootRestart)))
		io.log(`a restart's killed launches wait on the listing: ${read.why}`);
	return read.agents ?? null;
}

/**
 * The listing a hold notice reads: the listing refuses an empty answer, so a
 * registry that read and holds nobody stands in for it, as that is the quiet
 * the notice is for.
 * @param {AgentRecord[]|null} agents
 * @param {RegistryListing} registry
 */
const noticeAgentsOf = (agents, registry) =>
	agents ??
	(registry.seats.length > 0 &&
	registry.faults.length === 0 &&
	registry.agents.length === 0
		? []
		: null);

/**
 * Whether a tick's seats are the loop's own list: read off a sound control that
 * names some (#3790).
 * @param {{seats: string[]}|null} parsed
 */
const isSeatListRead = (parsed) => parsed !== null && parsed.seats.length > 0;

/**
 * The limit acts made, and what a tick decides its launches on: the free slots
 * and the seats. A paused tick launches nothing, so it reads none of them, making
 * no admission, `/usage` or cap read, and leaves the limit acts, which need them,
 * for the tick after the resume (#3856); a hold its finishes ended is still
 * released, as that tick's `before` no longer shows it holding. The walks'
 * probe stamps are for this read alone: settleTick writes the tick's own.
 * @param {TickIo} io
 * @param {{control: Control, seatListRead: boolean, before: LoopLaunch[],
 *   judged: LoopLaunch[], seen: Seen, served: string[],
 *   declared: DeclaredSeats, typedSeat: string|null,
 *   seatTriedAt: Record<string, number>}} tick
 */
function settleRoom(
	io,
	{
		control,
		seatListRead,
		before,
		judged,
		seen,
		served,
		declared,
		typedSeat,
		seatTriedAt,
	},
) {
	if (control.paused) {
		io.releaseEndedHolds(before, judged, seen.io);
		return {
			launches: judged,
			slots: 0,
			admission: null,
			workingChange: 0,
			seats: [],
			probes: [],
			overflow: [],
		};
	}
	const { slots: free, admission } = io.readFreeSlots();
	/** @param {import("./refill-decide.js").SizedSeat[]} sized */
	const overflowOf = (sized) =>
		overflowReadings(declared, sized, (seat) => io.seatBudget(seat, served[0]));
	/** @type {Probe[]} */
	const moveProbes = [];
	const { launches, slots, workingChange } = io.actOnLimits(
		before,
		judged,
		control.scope.mode,
		{
			...seen,
			typedSeat,
			readMoveSeats: () => {
				const read = io.readSeats(control.seats, 1, served[0], {
					typedSeat,
					sizeAll: true,
				});
				moveProbes.push(...read.probes);
				return { seats: read.seats, overflow: overflowOf(read.seats) };
			},
			seatListRead,
			slots: free,
		},
	);
	const { seats, probes: walked } = io.readSeats(
		control.seats,
		slots,
		served[0],
		{ typedSeat },
	);
	const walks = [...moveProbes, ...walked];
	const probes = [
		...walks,
		...io.probeDueSeats(
			control.seats,
			seatTriedAfter(seatTriedAt, walks, io.now()),
		),
	];
	if (!control.stopRequested)
		io.startDueConsoleReads(declared, seats, served[0]);
	return {
		launches,
		slots,
		admission,
		workingChange,
		seats,
		probes,
		overflow: overflowOf(seats),
	};
}

/**
 * The decision, and the shortlist read's size and time, null where it was not
 * read. A tick launching gate judgements alone may still have slots for the
 * ranking, so it reads the shortlists too.
 * @param {TickIo} io
 * @param {import("./refill-decide.js").TickInput} input
 * @param {import("./refill-loop.js").Scope} scope
 * @returns {Promise<{decision: import("./refill-decide.js").Decision,
 *   read: FrontierRead|null}>}
 */
async function decide(io, input, scope) {
	const first = decideTick(input);
	if (
		"stop" in first ||
		(first.idle !== null && first.idle !== NOTHING_LAUNCHABLE)
	)
		return { decision: first, read: null };
	const served = io.servedRoots(scope);
	for (const d of served.dropped) io.log(`not served: ${d.root} (${d.why})`);
	const readStart = io.now();
	const merged = await io.readFrontier(served.roots, scope.goal);
	const read = {
		rows: merged.frontier.length,
		ms: io.now() - readStart,
		goal: merged.goal,
	};
	for (const f of merged.failed)
		io.log(`shortlist failed in ${f.root}: ${f.error}`);
	for (const h of merged.held)
		io.log(
			`held outside the loop: ${h.ref} (${h.why}), holding ${h.holds.join(", ")}`,
		);
	const frontier = /** @type {import("./refill-decide.js").MergedRow[]} */ (
		merged.frontier
	);
	const parkers = io.readParkers(frontier);
	const decision = decideTick({
		...input,
		seats: io.sizeParkerSeats(input.seats, parkers, served.roots[0]),
		frontier,
		retroBundles: merged.retroBundles,
		failedShortlists: merged.failed,
		parkers,
	});
	return { decision, read };
}

/**
 * The stopped sessions due back: none on a paused tick, which resumes none,
 * though a stop still names those it leaves.
 * @param {Control} control
 * @param {LoopLaunch[]} launches
 * @param {Seen} seen
 */
const dueResumes = (control, launches, seen) =>
	control.paused && !control.stopRequested
		? []
		: blocks.resumableOf(launches, seen);

/**
 * A live tick from its decision on (settleTick), then what of the lifted holds
 * and the manager's restart marker the written state now carries dropped, and
 * the tick's concurrency row appended; the decision it settled on.
 * @param {TickIo} io
 * @param {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision, state: LoopState,
 *   launches: LoopLaunch[], probes: Probe[], read: FrontierRead|null,
 *   broken: string[], booted: ReturnType<typeof settleBootKilled>,
 *   control: Control, seen: Seen, served: string[], declared: DeclaredSeats,
 *   admission: import("./admission.js").AdmissionJson|null, limitChange: number,
 *   liftedSettled: ReturnType<typeof blocks.queueLifted>["settled"],
 *   managerRestart: Parameters<typeof withManagerRestart>[1]}} tick
 */
function settleDecided(
	io,
	{
		input,
		decision,
		state,
		launches,
		probes,
		read,
		broken,
		booted,
		control,
		seen,
		served,
		declared,
		admission,
		limitChange,
		liftedSettled,
		managerRestart,
	},
) {
	const { decision: settled, launched } = settleTick(
		{
			input,
			decision,
			state,
			judged: launches,
			probes,
			read,
			probeBrokenRoots: broken,
			bootedAt: booted.bootedAt,
			sameBootRestart: booted.sameBootRestart,
			away: control.away,
		},
		{
			readControl: io.readControl,
			launchBatch: (batch) => io.launchBatch(batch, served),
			resumeHeld: (resumes, held, isStopped, record) =>
				io.resumeHeld(resumes, held, seen, { isStopped, record }),
			writePause: (pause) => io.writePause(pause, control.noProgressFrom),
			runReview: io.runReview,
			updateState: io.updateState,
			readOmittedDirs: () => io.readOmittedDirs(declared),
			log: io.log,
			now: io.now,
		},
	);
	io.dropSettledLifted(liftedSettled);
	if (managerRestart) io.dropManagerRestart(managerRestart);
	io.appendTick(
		buildTickRecord({
			input,
			decision: settled,
			admission,
			workingChange: limitChange + launched,
		}),
	);
	return settled;
}

/**
 * The control a tick with no sound control file goes on: a loop nobody
 * started, which a real tick stops, and with no set written a dry run previews
 * every checkout it may serve.
 * @param {TickIo} io
 * @param {boolean} dryRun
 * @param {number} now
 * @returns {Control}
 */
const standInControl = (io, dryRun, now) => ({
	noProgressFrom: now,
	stopRequested: !dryRun,
	seats: io.readConfiguredSeats(),
	scope: { mode: "normal", repos: io.readIncluded(), goal: null },
});

/**
 * One tick: its decision and the start it judged against. `opening` is what
 * the tick reads before its first write. Under `dryRun` the tick previews: no
 * control reads as a stopped loop's would not, a damaged one stops nothing, no
 * listing is trusted off a boot's kills, and the tick returns at its decision,
 * its adapter having made no act.
 * @param {TickIo} io
 * @param {{dryRun: boolean, now: number, opening: {control: ControlRead,
 *   declared: DeclaredSeats,
 *   typed: {at: number|null, seat: string|null}}}} tick
 * @returns {Promise<{decision: import("./refill-decide.js").Decision,
 *   read?: FrontierRead|null, noProgressFrom: number,
 *   agents: AgentRecord[]|null}>}
 */
async function runTick(io, { dryRun, now, opening }) {
	const { control: stored, damaged } = opening.control;
	const { declared, typed } = opening;
	const parsed = settleOptedOut(io, settleAwayMode(io, stored, typed.at, now));
	const unsettled = parsed ?? standInControl(io, dryRun, now);
	io.reap();
	const control =
		parsed === null || unsettled.stopRequested
			? unsettled
			: io.tendQuietBench(unsettled, {
					lastTypedAt: typed.at,
					served: io.servedRoots(unsettled.scope).roots,
					now,
				});
	/* A dry run previews the state on disk: the marker is the live tick's to apply
	 * and drop. */
	const managerRestart = dryRun ? null : io.readManagerRestart();
	const served = io.servedRoots(control.scope).roots;
	const state = withManagerRestart(
		io.settleKilled(io.readState(), served),
		managerRestart,
		io.readCurrentBootId(),
	);
	/* Relief first, off the registry alone: the CLI listing below can outrun
	 * its caps under the very pressure relief exists for (#2665). */
	const registry = io.readRegistry();
	for (const line of io.stopNeverStarted(registry, bootSparedJobs(state)))
		io.log(line);
	const broken = io.tendCheckouts(served, state.launches, now);
	const agents = readTickListing(io, dryRun, state, registry);
	/* Read side by side here anyway, so the undocumented registry the relief
	 * steps trust is checked against the documented listing every tick. */
	if (agents)
		for (const line of buildDriftLines(agents, registry.agents)) io.log(line);
	io.capOverflowSessions(declared, agents);
	/** @type {Seen} */
	const seen = {
		agents,
		now,
		io: io.blockIo(served),
		swapHold: io.readSwapHold(),
		paused: control.paused !== undefined,
	};
	const roots = landingRoots(served, state.launches);
	io.sendHoldNotices(
		roots,
		{
			agents: noticeAgentsOf(agents, registry),
			isPaused: control.paused !== undefined,
		},
		now,
	);
	const booted = dryRun ? state : settleBootKilled(state, seen, registry);
	const listed = judgedLaunches(booted.launches, agents, now, {
		progressOf: (l) => io.progressOf(l, served),
		causeOf: io.causeOf,
	});
	const acted = io.actOnLaunches(listed, control.scope.mode, served, seen);
	io.attachProbeParks(broken, acted);
	/* A dry run, a paused tick or a stopping one sets nothing running, and the
	 * lifted holds keep for a later tick. */
	const { launches: judged, settled: liftedSettled } =
		dryRun || seen.paused || control.stopRequested
			? { launches: acted, settled: [] }
			: blocks.queueLifted(acted, io.readLiftedHolds(roots), seen);
	const {
		launches,
		slots,
		admission,
		workingChange: limitChange,
		seats,
		probes,
		overflow,
	} = settleRoom(io, {
		control,
		seatListRead: isSeatListRead(parsed),
		before: state.launches,
		judged,
		seen,
		served,
		declared,
		typedSeat: typed.seat,
		seatTriedAt: state.seatTriedAt,
	});
	const resumable = dueResumes(control, launches, seen);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		mode: control.scope.mode,
		noProgressFrom: control.noProgressFrom,
		stopRequested: control.stopRequested,
		...(control.paused ? { paused: control.paused } : {}),
		/* A dry run previews launches over any control, as over none. */
		controlDamaged: dryRun ? null : damaged,
		frontier: [],
		retroBundles: [],
		running: runningOf(launches),
		freeSlots: slots,
		limitHeldLines: launches
			.filter(blocks.isLimitHeld)
			.map(blocks.buildHeldStopText),
		typedSeat: typed.seat,
		seats: sizeResumeSeats(seats, resumable, slots, io.capSizer(served[0])),
		overflow,
		history: launches,
		judgements: io.readGateJudgements().filter((j) => served.includes(j.root)),
		resumable,
		holds: io.readTickHolds(served, broken).holds,
	};
	const { decision, read } = await decide(io, input, control.scope);
	if (dryRun)
		return { decision, read, noProgressFrom: control.noProgressFrom, agents };
	const settled = settleDecided(io, {
		input,
		decision,
		state,
		launches,
		probes,
		read,
		broken,
		booted,
		control,
		seen,
		served,
		declared,
		admission,
		limitChange,
		liftedSettled,
		managerRestart,
	});
	return { decision: settled, noProgressFrom: control.noProgressFrom, agents };
}

module.exports = {
	buildFinishLine,
	buildLaunchesLine,
	buildReviewSkip,
	FREE_SLOT_ARGS,
	judgedLaunches,
	parseProbeOutcome,
	runTick,
	settleLaunching,
	settleTick,
	stopNeverStarted,
};
