/*
 * refill-tick-settle.js — the refill tick's settle step (#4231): from its
 * decision on, the resumes, then each batch on record before its launcher runs
 * (#4157, #4180), the pause, the state, the morning review (#2017, #3765), and
 * a late stop read after them. lib/refill-tick-core.js's runTick is its caller.
 */

const { batchesOf } = require("./refill-batch.js");
const { isLive, isStepResume, launchName } = require("./refill-block-core.js");
const {
	buildResumeWaitLine,
	decideTick,
	isClashSkip,
	isParkRoutingMode,
	isLaunchBarred,
} = require("./refill-decide.js");
const { buildErrorText } = require("./caught.js");
const { buildGoalProgress } = require("./refill-goal.js");
const {
	buildFrontierReadText,
	buildLaunchLine,
	buildSkipText,
	handedOffSince,
	launchesSince,
	summaryOf,
} = require("./refill-loop.js");
const { buildSeatName } = require("./refill-seats.js");
const {
	batchLaunching,
	lateStopped,
	tickSettled,
} = require("./refill-state.js");
const { seatTriedAfter } = require("./seat-reading.js");
const { unclosedLaunches } = require("./unclosed-launch.js");
const {
	buildOverflowStartLines,
	buildStartLabel,
	firstOverflowStart,
	planSeatBasisOf,
} = require("./overflow-notice.js");

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
/* How a tick line counts its clash skips, each of whose reasons names its own
 * file and partner. */
const CLASH_COUNT = "on a clash";

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
		const since = sinceOf(h, before);
		if (since !== undefined) return [{ ...h, since }];
		return isParkRoutingMode(mode) ? [{ ...h, since: now }] : [];
	});

/**
 * @param {import("./refill-decide.js").Skip} h
 * @param {Hold[]} before
 */
const sinceOf = (h, before) =>
	before.find((b) => b.root === h.root && b.number === h.number)?.since;

/**
 * The tick's clash skips as holds, in either mode, from the first tick of an
 * unbroken run that deferred the row, so the idle alarm names the clash that
 * keeps a row waiting (#4355).
 * @param {import("./refill-decide.js").Skip[]} skipped this tick's
 * @param {Hold[]} before
 * @param {number} now
 * @returns {Hold[]}
 */
const clashHoldsOf = (skipped, before, now) =>
	skipped
		.filter(isClashSkip)
		.map((s) => ({ ...s, since: sinceOf(s, before) ?? now }));

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
 * Whether a control read mid-tick asks the loop to stop. A control gone
 * missing does, as at the tick's start.
 * @param {Control|null} control
 */
const isStopRequested = (control) => control?.stopRequested !== false;

/**
 * Whether a control read mid-tick holds back the tick's next launch: a stop, a
 * pause or a launch hold live at `now`, so a hold set mid-tick bars the next
 * batch (#4354).
 * @param {Control|null} control
 * @param {number} now
 */
const isControlBarred = (control, now) =>
	isStopRequested(control) || isLaunchBarred(control ?? {}, now);

/**
 * What the dispatches did, dispatching each batch in turn after re-reading the
 * control, and none once it asks for a stop (#2126), a pause or a launch hold: one dispatch can
 * hold the tick for minutes. Residual: a dispatch already running still launches
 * every member.
 * @param {import("./refill-decide.js").Launch[][]} batches
 * @param {() => boolean} isBarred whether the control read now bars launching
 * @param {(batch: import("./refill-decide.js").Launch[]) => BatchOutcome} launch
 * @returns {Outcome}
 */
function launchUntilBarred(batches, isBarred, launch) {
	/** @type {Outcome} */
	const outcome = { launched: [], refused: [], unreached: [] };
	for (const [i, batch] of batches.entries()) {
		if (isBarred()) {
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
 * An idle tick's account of the frontier it read (#2561).
 * @param {Extract<import("./refill-decide.js").Decision, {idle: unknown}>} d
 * @param {FrontierRead|null} read
 */
function frontierNotes(d, read) {
	if (read === null) return [];
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const s of d.skipped) {
		const why = isClashSkip(s) ? CLASH_COUNT : s.why;
		counts.set(why, (counts.get(why) ?? 0) + 1);
	}
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
 * A launching tick's account of the rows it deferred on a clash (#4355): an
 * idle tick's frontierNotes count them with its other skips.
 * @param {import("./refill-decide.js").Skip[]} skipped
 */
function clashNotes(skipped) {
	const clashes = skipped.filter(isClashSkip);
	return clashes.length > 0
		? [
				`deferred ${clashes.length} ${CLASH_COUNT}: ${clashes.slice(0, LINE_SKIPS).map(buildSkipText).join(", ")}`,
			]
		: [];
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
		...(d.launches.length > 0 ? clashNotes(d.skipped) : []),
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
		...(first.launch.keyVar ? { keyVar: first.launch.keyVar } : {}),
		planSeats: input.seats.map(planSeatBasisOf),
		omitted,
	};
	io.log(
		`first overflow launch on ${buildStartLabel(start)}: ${buildOverflowStartLines(start).join("; ")}`,
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
 * @param {{readControl: () => ControlRead, resumeHeld: ResumeHeld,
 *   now: () => number}} io
 * @param {(launches: LoopLaunch[]) => void} record
 */
const resumeDecided = (decision, launches, io, record) =>
	"stop" in decision
		? { launches, started: 0, waiting: false }
		: io.resumeHeld(
				decision.resumes,
				launches,
				() => isControlBarred(io.readControl().control, io.now()),
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
		() => isControlBarred(io.readControl().control, io.now()),
		(batch) => {
			record([...afterResumes, ...launchedSoFar], { at: io.now(), batch });
			const r = io.launchBatch(batch);
			launchedSoFar.push(...r.launched);
			return r;
		},
	);
	const summary = buildTickLine(decision, outcome, {
		freeSlots: isLaunchBarred(input, input.now) ? null : input.freeSlots,
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
						: [
								...holdsOf(decision.held, state.held, input.now, input.mode),
								...clashHoldsOf(decision.skipped, state.held, input.now),
							],
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

module.exports = { buildLaunchesLine, settleTick };
