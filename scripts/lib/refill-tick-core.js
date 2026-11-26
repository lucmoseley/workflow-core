const { buildErrorText } = require("./caught.js");
const { buildTickRecord } = require("./concurrency.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const blocks = require("./refill-blocks.js");
const synthetic = require("./refill-synthetic.js");
const { isLimitHeld, launchName } = require("./refill-block-core.js");
const limits = require("./refill-limits.js");
const { stepBreakers } = require("./refill-breaker.js");
const { parkOverBudget } = require("./refill-budget.js");
const { retireOriginals } = require("./refill-retire.js");
const { declaresOverflowSeat } = require("./refill-seats.js");
const {
	bootSparedJobs,
	isEmptyListingTrusted,
	settleBootKilled,
	withManagerRestart,
} = require("./refill-boot.js");
const {
	actsRead,
	decideTick,
	isLaunchBarred,
	liveLaunchHold,
	NOTHING_LAUNCHABLE,
	readParkers,
	UNREAD,
} = require("./refill-decide.js");
const { buildLaunchRoom } = require("./launch-room.js");
const {
	controlWithoutOptedOut,
	judgedLaunches,
	landingRoots,
	runningOf,
} = require("./refill-loop.js");
const { settleTick } = require("./refill-tick-settle.js");
const { killSettled, withoutLaunching } = require("./refill-state.js");
const { buildDriftLines } = require("./registry-agents.js");
const {
	overflowReadings,
	seatTriedAfter,
	sizeParkerSeats,
	sizeResumeSeats,
} = require("./seat-reading.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

/** @typedef {import("./refill-loop.js").Control} Control */
/** @typedef {import("./refill-loop.js").ControlRead} ControlRead */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-state.js").LoopState} LoopState */
/** @typedef {import("./refill-state.js").Hold} Hold */
/** @typedef {import("./refill-batch.js").BatchOutcome} BatchOutcome */
/** @typedef {import("./refill-loop.js").FrontierRead} FrontierRead */

/**
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

const FREE_SLOT_ARGS = ["--json", "--skip-allowance"];

/**
 * @param {string[]} served
 * @param {(root: string) => number} peakMbOf
 * @returns {string|undefined}
 */
function admissionRoot(served, peakMbOf) {
	let best;
	let bestMb = -1;
	for (const root of served) {
		const mb = peakMbOf(root);
		if (mb > bestMb) {
			best = root;
			bestMb = mb;
		}
	}
	return best;
}

/** @param {LoopLaunch} l */
function buildFinishLine(l) {
	const read = actsRead(l);
	const acts = read
		? Object.entries(read)
				.map(([kind, n]) => `${kind} ${n}`)
				.join(", ") || "no acts"
		: UNREAD;
	return `finished ${launchName(l)}: ${acts}${synthetic.buildFinishNote(l)}`;
}

/**
 * @param {string} stderr
 * @param {string|null} failed
 */
function parseProbeOutcome(stderr, failed) {
	const line = stderr.split("\n").find((l) => l.startsWith(OUTCOME_PREFIX));
	return line
		? line.slice(OUTCOME_PREFIX.length).trim()
		: `no outcome line, ${failed ?? "exit 0"}`;
}

/**
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
 * @typedef {ReturnType<typeof import("./refill-seats.js").readDeclaredSeats>} DeclaredSeats
 * @typedef {import("./refill-blocks.js").BlockIo} BlockIo
 * @typedef {import("./refill-blocks.js").BlockActs} BlockActs
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
 *   isOptedOut: (root: string) => boolean,
 *   readConfiguredSeats: () => string[],
 *   readIncluded: () => string[],
 *   servedRoots: (scope: import("./refill-loop.js").Scope) =>
 *     {roots: string[], dropped: {root: string, why: string}[]},
 *   previewReap: () => void,
 *   readManagerRestart: () => Parameters<typeof withManagerRestart>[1],
 *   readCurrentBootId: () => Parameters<typeof withManagerRestart>[2],
 *   readState: () => LoopState,
 *   readRegistry: () => RegistryListing,
 *   hasConfig: (root: string) => boolean,
 *   readListing: (trusted: boolean) => {agents?: AgentRecord[]|null, why?: string|null},
 *   blockIo: (served: string[]) => BlockIo,
 *   readSwapHold: () => Seen["swapHold"],
 *   readProgress: (l: LoopLaunch, served: string[]) => object,
 *   readLoopLastActAt: (launches: LoopLaunch[], served: string[]) => Record<string, number>,
 *   readThroughput: (launches: LoopLaunch[], served: string[], now: number) =>
 *     import("./refill-breaker.js").ThroughputRead,
 *   readCause: import("./refill-blocks.js").CauseOf,
 *   readLiftedHolds: (roots: string[]) => Parameters<typeof blocks.queueLifted>[1],
 *   typecheckPeakMb: (root: string) => number,
 *   readFreeSlots: (root: string|undefined) => {slots: number,
 *     admission: import("./admission.js").AdmissionJson|null},
 *   readSeats: (seats: string[], slots: number, root: string|undefined,
 *     how: {typedSeat: string|null, sizeAll?: boolean,
 *       tries: {triedAt: Record<string, number>, now: number}}) => SeatsRead,
 *   seatBudget: typeof import("./overflow-budget.js").seatBudget,
 *   capSizer: (root: string|undefined) => Parameters<typeof sizeResumeSeats>[3],
 *   readGateJudgements: () => import("./gate-sweep.js").Judgement[],
 *   readTickHolds: (served: string[], broken: string[]) =>
 *     {holds: import("./refill-decide.js").TickInput["holds"]},
 *   readFrontier: (roots: string[], goal: import("./refill-loop.js").Scope["goal"]) =>
 *     Promise<Awaited<ReturnType<typeof import("./refill-frontier.js").refillFrontier>>>,
 *   readParkMarkers: (root: string) => import("./parked.js").ParkMarkerRead[],
 *   readOmittedDirs: (declared: DeclaredSeats) => string[],
 * }} TickReads
 * @typedef {{
 *   changeControl: (change: (c: Control) => Control|null) =>
 *     ControlWrite|{busy: string},
 *   reap: () => void,
 *   adoptKilledLaunches: (state: LoopState, served: string[]) => LoopState,
 *   stopNeverStarted: (registry: RegistryListing, spared: Set<string>) => string[],
 *   superviseLanding: (root: string) => void,
 *   levelMain: (root: string) => void,
 *   startWarmPass: (root: string) => void,
 *   startReapPass: (root: string) => void,
 *   runMachineChild: (script: string, label: string) => void,
 *   tendHolds: (roots: string[], served: string[], now: number) => string[],
 *   recordListedOverflowSessions: (agents: AgentRecord[]) => void,
 *   stopOverAllowance: (declared: DeclaredSeats, agents: AgentRecord[]|null) => string[],
 *   sendHoldNotices: (roots: string[],
 *     seen: {agents: AgentRecord[]|null, isPaused: boolean}, now: number) => void,
 *   sendPauseNotices: (repoPaused: Record<string, import("./refill-decide.js").Pause>,
 *     now: number) => void,
 *   tendClosedParks: (served: string[]) => void,
 *   actOnOutside: (launches: LoopLaunch[], registry: AgentRecord[],
 *     seen: Seen) => void,
 *   releaseAwayParks: (launches: LoopLaunch[], mode: "normal"|"away",
 *     served: string[], seen: Seen) => LoopLaunch[],
 *   attachProbeParks: (broken: string[], launches: LoopLaunch[]) => void,
 *   probeDueSeats: (seats: string[], triedAt: Record<string, number>) => Probe[],
 *   startDueConsoleReads: (declared: DeclaredSeats,
 *     seats: import("./refill-decide.js").SeatReading[], root: string|undefined) => void,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[], served: string[]) =>
 *     BatchOutcome,
 *   writePauses: (pauses: Record<string, import("./refill-decide.js").Pause>, noProgressFrom: number) => Record<string, import("./refill-decide.js").Pause>|null,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   updateState: (transition: import("./refill-state.js").Transition) => LoopState,
 *   dropSettledLifted: (settled: ReturnType<typeof blocks.queueLifted>["settled"]) => void,
 *   dropManagerRestart: (marker: NonNullable<Parameters<typeof withManagerRestart>[1]>) => void,
 *   appendTick: (record: ReturnType<typeof buildTickRecord>) => void,
 *   appendBreakerEvents: (events: import("./refill-breaker.js").BreakerEvent[]) => void,
 * }} TickActs
 * @typedef {TickReads & TickActs} TickIo
 */

/**
 * @param {TickIo} io
 * @param {Control|null} control
 * @param {(c: Control) => Control|null} change
 * @param {{what: string, said?: (write: Control, fresh: Control) => void,
 *   dryRun: boolean}} how
 */
function settleUnderLock(io, control, change, { what, said, dryRun }) {
	const next = control && change(control);
	if (!next) return control;
	if (dryRun) return next;
	const written = io.changeControl(change);
	if ("busy" in written) {
		io.log(`${what} waits for the next tick: ${written.busy}`);
		return control;
	}
	if (written.wrote) said?.(written.wrote.write, written.wrote.fresh);
	return written.control;
}

/**
 * @param {TickIo} io
 * @param {boolean} dryRun
 * @param {Control|null} control
 */
const settleOptedOut = (io, dryRun, control) =>
	settleUnderLock(
		io,
		control,
		(c) => controlWithoutOptedOut(c, io.isOptedOut)?.control ?? null,
		{
			dryRun,
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

/** @type {[string, string][]} */
const MACHINE_CHILDREN = [
	["file-memory-kill-tickets.js", "memory kills"],
	["file-process-runaway-tickets.js", "process runaways"],
	["repair-sweep-slot.js", "sweep slot repair"],
];

/**
 * @param {TickIo} io
 * @param {string[]} served
 * @param {LoopLaunch[]} launches
 * @param {number} now
 */
function tendCheckouts(io, served, launches, now) {
	const roots = landingRoots(served, launches);
	const configured = roots.filter((root) => io.hasConfig(root));
	for (const root of configured) io.superviseLanding(root);
	for (const root of configured) io.levelMain(root);
	for (const root of configured) io.startWarmPass(root);
	for (const root of configured) io.startReapPass(root);
	for (const [script, label] of MACHINE_CHILDREN)
		io.runMachineChild(script, label);
	return io.tendHolds(roots, served, now);
}

/**
 * @param {TickIo} io
 * @param {DeclaredSeats} declared
 * @param {AgentRecord[]|null} agents
 */
function capOverflowSessions(io, declared, agents) {
	if (agents && declaresOverflowSeat(declared) && declared.errors.length === 0)
		io.recordListedOverflowSessions(agents);
	for (const line of io.stopOverAllowance(declared, agents)) io.log(line);
}

/**
 * @param {TickIo} io
 * @param {string[]} served
 * @returns {string[]}
 */
function parkSweepRootsOf(io, served) {
	try {
		return [...new Set([...served, ...io.readIncluded()])];
	} catch (e) {
		io.log(`unserved parks unread: ${buildErrorText(e)}`);
		return served;
	}
}

/**
 * @param {TickIo} io
 * @param {LoopLaunch[]} listed
 * @param {{mode: "normal"|"away", served: string[], broken: string[],
 *   seen: Seen, registry: RegistryListing, acts: LaunchActs}} tick
 */
function actOnLaunches(
	io,
	listed,
	{ mode, served, broken, seen, registry, acts },
) {
	acts.unparkAnswered(parkSweepRootsOf(io, served), seen);
	io.tendClosedParks(served);
	const tried = retireOriginals(listed, seen.io);
	const acted = io.releaseAwayParks(
		acts.actOnSynthetic(
			acts.actOnIdle(acts.actOnBlocks(tried, mode, seen), mode, seen),
			mode,
			seen,
		),
		mode,
		served,
		seen,
	);
	io.attachProbeParks(broken, acted);
	io.actOnOutside(acted, registry.agents, seen);
	blocks.logNetWaits(seen);
	return acted;
}

/**
 * @param {TickIo} io
 * @param {LoopLaunch[]} launches
 * @param {{served: string[], seen: Seen, acts: LaunchActs}} tick
 */
function tendThroughput(io, launches, { served, seen, acts }) {
	const read = io.readThroughput(launches, served, seen.now);
	if (read.record === null)
		io.log("breaker record will not read: launching and resuming nothing");
	const parked = acts.parkOverBudget(launches, read, seen);
	const { events, room, notes } = stepBreakers({
		roots: served,
		launches: parked.launches,
		read,
		now: seen.now,
	});
	for (const note of notes) io.log(note);
	io.appendBreakerEvents([...parked.events, ...events]);
	return { launches: parked.launches, breakerRoom: room };
}

/**
 * @param {TickIo} io
 * @param {{registry: RegistryListing, state: LoopState, served: string[],
 *   now: number}} tick
 */
function relieve(io, { registry, state, served, now }) {
	for (const line of io.stopNeverStarted(registry, bootSparedJobs(state)))
		io.log(line);
	return tendCheckouts(io, served, state.launches, now);
}

/**
 * @param {TickIo} io
 * @param {{declared: DeclaredSeats, agents: AgentRecord[]|null,
 *   registry: RegistryListing, roots: string[],
 *   repoPaused: Record<string, import("./refill-decide.js").Pause>|undefined, barred: boolean,
 *   now: number}} tick
 */
function actOnListing(
	io,
	{ declared, agents, registry, roots, repoPaused, barred, now },
) {
	capOverflowSessions(io, declared, agents);
	io.sendHoldNotices(
		roots,
		{
			agents: noticeAgentsOf(agents, registry),
			isPaused: barred,
		},
		now,
	);
	io.sendPauseNotices(repoPaused ?? {}, now);
}

/**
 * @param {TickIo} io
 * @param {LoopState} read
 * @param {{served: string[], acts: LaunchActs}} tick
 */
function settleKilled(io, read, { served, acts }) {
	const adopted = io.adoptKilledLaunches(read, served);
	const { launches, settled } = acts.settleStartedResumes(
		adopted.launches,
		io.blockIo(served),
	);
	if (adopted === read && !settled) return read;
	return io.updateState(
		killSettled({ launches, launchCount: adopted.launchCount }, read),
	);
}

/**
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

/** @param {{seats: string[]}|null} parsed */
const isSeatListRead = (parsed) => parsed !== null && parsed.seats.length > 0;

/**
 * @param {TickIo} io
 * @param {{control: Control, seatListRead: boolean,
 *   before: LoopLaunch[], judged: LoopLaunch[], seen: Seen, served: string[],
 *   declared: DeclaredSeats, typedSeat: string|null,
 *   seatTriedAt: Record<string, number>, lastActAt: Record<string, number>,
 *   breakerRoom: Record<string, number>,
 *   holds: import("./refill-decide.js").TickInput["holds"], acts: LaunchActs}} tick
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
		lastActAt,
		breakerRoom,
		holds,
		acts,
	},
) {
	if (seen.barred) {
		acts.releaseEndedHolds(before, judged, seen.io);
		return {
			launches: judged,
			slots: 0,
			admission: null,
			liveChange: 0,
			seats: [],
			probes: [],
			overflow: [],
		};
	}
	const { slots: free, admission } = io.readFreeSlots(
		admissionRoot(served, io.typecheckPeakMb),
	);
	const room = buildLaunchRoom({
		history: judged,
		lastActAt,
		repoPaused: control.repoPaused,
		breakerRoom,
		holds,
	});
	/** @param {import("./refill-decide.js").SizedSeat[]} sized */
	const overflowOf = (sized) =>
		overflowReadings(declared, sized, (seat) => io.seatBudget(seat, served[0]));
	/** @type {Probe[]} */
	const moveProbes = [];
	const {
		launches,
		slots: limitLeft,
		liveChange,
	} = acts.actOnLimits(judged, control.scope.mode, {
		...seen,
		typedSeat,
		readMoveSeats: () => {
			const read = io.readSeats(control.seats, 1, served[0], {
				typedSeat,
				sizeAll: true,
				tries: { triedAt: seatTriedAt, now: io.now() },
			});
			moveProbes.push(...read.probes);
			return { seats: read.seats, overflow: overflowOf(read.seats) };
		},
		seatListRead,
		slots: free,
		roomOf: room.resumeLeft,
	});
	const slots = limitLeft;
	acts.releaseEndedHolds(before, launches, seen.io);
	const { seats, probes: walked } = io.readSeats(
		control.seats,
		slots,
		served[0],
		{
			typedSeat,
			tries: {
				triedAt: seatTriedAfter(seatTriedAt, moveProbes, io.now()),
				now: io.now(),
			},
		},
	);
	const walks = [...moveProbes, ...walked];
	const probes = [
		...walks,
		...io.probeDueSeats(
			control.seats,
			seatTriedAfter(seatTriedAt, walks, io.now(), { retryUnmoved: false }),
		),
	];
	const overflow = overflowOf(seats);
	if (!control.stopRequested)
		io.startDueConsoleReads(declared, seats, served[0]);
	return {
		launches,
		slots,
		admission,
		liveChange,
		seats,
		probes,
		overflow,
	};
}

/**
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
		(first.idle !== null && first.idle.reason !== NOTHING_LAUNCHABLE)
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
	const parkers = readParkers(frontier, io.readParkMarkers);
	const decision = decideTick({
		...input,
		seats: sizeParkerSeats(input.seats, parkers, io.capSizer(served.roots[0])),
		frontier,
		retroBundles: merged.retroBundles,
		failedShortlists: merged.failed,
		parkers,
	});
	return { decision, read };
}

/**
 * @param {Control} control
 * @param {LoopLaunch[]} launches
 * @param {Seen} seen
 */
const dueResumes = (control, launches, seen) =>
	seen.barred && !control.stopRequested
		? []
		: blocks.resumableOf(launches, seen);

/**
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
				blocks.resumeHeldLaunches(resumes, held, seen, { isStopped, record }),
			writePauses: (pauses) => {
				const written = io.writePauses(pauses, control.noProgressFrom);
				if (written) io.sendPauseNotices(written, input.now);
			},
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
			liveChange: limitChange + launched,
			agents: seen.agents,
		}),
	);
	return settled;
}

const doNothing = () => undefined;

/**
 * @param {TickReads} io
 * @returns {TickActs}
 */
const buildDryActs = (io) => ({
	changeControl: () => ({ busy: "a dry run takes no lock" }),
	reap: io.previewReap,
	adoptKilledLaunches: (state) => state,
	stopNeverStarted: () => [],
	superviseLanding: doNothing,
	levelMain: doNothing,
	startWarmPass: doNothing,
	startReapPass: doNothing,
	runMachineChild: doNothing,
	tendHolds: () => [],
	recordListedOverflowSessions: doNothing,
	stopOverAllowance: () => [],
	sendHoldNotices: doNothing,
	sendPauseNotices: doNothing,
	tendClosedParks: doNothing,
	actOnOutside: doNothing,
	releaseAwayParks: (launches) => launches,
	attachProbeParks: doNothing,
	probeDueSeats: () => [],
	startDueConsoleReads: doNothing,
	launchBatch: () => ({ launched: [], refused: [] }),
	writePauses: () => null,
	runReview: (lastRunOn) => lastRunOn,
	updateState: (transition) => transition(io.readState()),
	dropSettledLifted: doNothing,
	dropManagerRestart: doNothing,
	appendTick: doNothing,
	appendBreakerEvents: doNothing,
});

const DRY_RUN_WHY = "a dry run acts on nothing";

/** @type {BlockActs} */
const DRY_BLOCK_ACTS = {
	stop: () => ({
		ok: false,
		why: DRY_RUN_WHY,
		said: null,
		timedOut: false,
		noJob: false,
	}),
	type: () => DRY_RUN_WHY,
	resumeStopped: () => ({ failed: DRY_RUN_WHY }),
	resumeOwnId: () => ({ failed: DRY_RUN_WHY }),
	adoptResumed: () => ({ unread: DRY_RUN_WHY }),
	writeLaunch: doNothing,
	stagger: doNothing,
	moveSession: () => ({ failed: DRY_RUN_WHY }),
	removeJobRecord: () => DRY_RUN_WHY,
	retireJob: () => DRY_RUN_WHY,
	writeLedgerHold: () => false,
	holdLockedOut: () => ({ why: DRY_RUN_WHY }),
	labelParked: (l) => l.issues.map((n) => ({ n, why: DRY_RUN_WHY })),
	recordParked: () => DRY_RUN_WHY,
	unparkSession: () => DRY_RUN_WHY,
	comment: doNothing,
	postHandOff: () => ({ failed: DRY_RUN_WHY, out: "" }),
	release: () => false,
	writeOutside: doNothing,
	writeReapedRead: doNothing,
};

/**
 * @typedef {{
 *   settleStartedResumes: typeof blocks.settleStartedResumes,
 *   unparkAnswered: typeof blocks.unparkAnswered,
 *   actOnBlocks: typeof blocks.actOnBlocks,
 *   actOnIdle: typeof blocks.actOnIdle,
 *   actOnSynthetic: typeof synthetic.actOnSynthetic,
 *   actOnLimits: typeof limits.actOnLimits,
 *   releaseEndedHolds: typeof limits.releaseEndedHolds,
 *   parkOverBudget: typeof parkOverBudget,
 * }} LaunchActs
 * @type {LaunchActs}
 */
const LIVE_LAUNCH_ACTS = {
	settleStartedResumes: blocks.settleStartedResumes,
	unparkAnswered: blocks.unparkAnswered,
	actOnBlocks: blocks.actOnBlocks,
	actOnIdle: blocks.actOnIdle,
	actOnSynthetic: synthetic.actOnSynthetic,
	actOnLimits: limits.actOnLimits,
	releaseEndedHolds: limits.releaseEndedHolds,
	parkOverBudget,
};

/** @type {LaunchActs} */
const SKIPPED_LAUNCH_ACTS = {
	settleStartedResumes: (launches) => ({ launches, settled: false }),
	unparkAnswered: doNothing,
	actOnBlocks: (launches) => launches,
	actOnIdle: (launches) => launches,
	actOnSynthetic: (launches) => launches,
	actOnLimits: (launches, _mode, { slots }) => ({
		launches,
		slots,
		liveChange: 0,
	}),
	releaseEndedHolds: doNothing,
	parkOverBudget: (launches) => ({ launches, events: [] }),
};

/**
 * @param {TickIo} adapter
 * @returns {TickIo}
 */
const buildDryIo = (adapter) => ({
	...adapter,
	...buildDryActs(adapter),
	blockIo: (served) => ({ ...adapter.blockIo(served), ...DRY_BLOCK_ACTS }),
});

/**
 * @param {TickIo} io
 * @param {boolean} dryRun
 * @param {number} now
 * @returns {Control}
 */
const buildStandInControl = (io, dryRun, now) => ({
	noProgressFrom: now,
	stopRequested: !dryRun,
	seats: io.readConfiguredSeats(),
	scope: { mode: "normal", repos: io.readIncluded(), goal: null },
});

/**
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @returns {import("./refill-decide.js").BillingStop[]}
 */
const billingStopsOf = (launches) =>
	launches.flatMap((l) =>
		l.block?.billing && l.keyVar === undefined && l.finishedAt === null
			? [
					{
						seat: l.seat,
						since: Math.max(l.block.since, l.resumes?.triedAt ?? 0),
					},
				]
			: [],
	);

/**
 * @param {TickIo} adapter
 * @param {{dryRun: boolean, now: number, opening: {control: ControlRead,
 *   declared: DeclaredSeats,
 *   typedSeat: string|null}}} tick
 * @returns {Promise<{decision: import("./refill-decide.js").Decision,
 *   read?: FrontierRead|null, noProgressFrom: number,
 *   agents: AgentRecord[]|null}>}
 */
async function runTick(adapter, { dryRun, now, opening }) {
	/** @type {TickIo} */
	const io = dryRun ? buildDryIo(adapter) : adapter;
	const acts = dryRun ? SKIPPED_LAUNCH_ACTS : LIVE_LAUNCH_ACTS;
	const { control: stored, damaged } = opening.control;
	const { declared, typedSeat } = opening;
	const parsed = settleOptedOut(io, dryRun, stored);
	const control = parsed ?? buildStandInControl(io, dryRun, now);
	io.reap();
	const managerRestart = dryRun ? null : io.readManagerRestart();
	const served = io.servedRoots(control.scope).roots;
	const state = withManagerRestart(
		settleKilled(io, io.readState(), { served, acts }),
		managerRestart,
		io.readCurrentBootId(),
		io.blockIo(served),
	);
	const registry = io.readRegistry();
	const broken = relieve(io, { registry, state, served, now });
	const agents = readTickListing(io, dryRun, state, registry);
	if (agents)
		for (const line of buildDriftLines(agents, registry.agents)) io.log(line);
	const launchHold = control.paused
		? undefined
		: liveLaunchHold(control.launchHold, now);
	const barred = isLaunchBarred(control, now);
	const roots = landingRoots(served, state.launches);
	actOnListing(io, {
		declared,
		agents,
		registry,
		roots,
		repoPaused: control.repoPaused,
		barred,
		now,
	});
	/** @type {Seen} */
	const seen = {
		agents,
		now,
		io: io.blockIo(served),
		swapHold: io.readSwapHold(),
		barred,
	};
	const booted = dryRun ? state : settleBootKilled(state, seen, registry);
	const listed = judgedLaunches(booted.launches, agents, now, {
		progressOf: (l) => io.readProgress(l, served),
		causeOf: io.readCause,
		isOwedResume: (l) => synthetic.isOwedResume(l, seen.io),
	});
	const acted = actOnLaunches(io, listed, {
		mode: control.scope.mode,
		served,
		broken,
		seen,
		registry,
		acts,
	});
	const { launches: lifted, settled: liftedSettled } =
		dryRun || seen.barred || control.stopRequested
			? { launches: acted, settled: [] }
			: blocks.queueLifted(acted, io.readLiftedHolds(roots), seen);
	const { launches: judged, breakerRoom } = tendThroughput(io, lifted, {
		served,
		seen,
		acts,
	});
	const lastActAt = io.readLoopLastActAt(judged, served);
	const { holds } = io.readTickHolds(served, broken);
	const {
		launches,
		slots,
		admission,
		liveChange: limitChange,
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
		typedSeat,
		seatTriedAt: state.seatTriedAt,
		lastActAt,
		breakerRoom,
		holds,
		acts,
	});
	const resumable = dueResumes(control, launches, seen);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		mode: control.scope.mode,
		noProgressFrom: control.noProgressFrom,
		stopRequested: control.stopRequested,
		...(control.paused ? { paused: control.paused } : {}),
		repoPaused: control.repoPaused,
		breakerRoom,
		...(launchHold ? { launchHold } : {}),
		controlDamaged: dryRun ? null : damaged,
		frontier: [],
		retroBundles: [],
		running: runningOf(launches),
		freeSlots: slots,
		limitHeldLines: launches.filter(isLimitHeld).map(limits.buildHeldStopText),
		typedSeat,
		seats: sizeResumeSeats(seats, resumable, slots, io.capSizer(served[0])),
		overflow,
		history: launches,
		lastActAt,
		judgements: io.readGateJudgements().filter((j) => served.includes(j.root)),
		resumable,
		holds,
		billingStops: billingStopsOf(launches),
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
	billingStopsOf,
	buildFinishLine,
	buildReviewSkip,
	FREE_SLOT_ARGS,
	admissionRoot,
	parseProbeOutcome,
	runTick,
	settleLaunching,
	stopNeverStarted,
};
