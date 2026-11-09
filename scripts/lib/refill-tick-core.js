/*
 * refill-tick-core.js — the refill loop's tick (#2012, #2123, spec #1995,
 * #4212): its step order, its dry-run policy and its own readings, with no I/O
 * of its own. Every read, write and child process goes through the TickIo port,
 * whose adapter is lib/refill-tick.js: its reads (TickReads) and its acts
 * (TickActs). A dry run takes the same adapter's reads, each act swapped for
 * its dry answer (buildDryIo), and differs in the policy branches here: it
 * previews over no control as over a stopped one, judges no listing by a
 * boot's kills, and stops at its decision.
 *
 * A TICK: read founder presence, and in away mode write what it changes under
 * the control lock (#2522), untick each repo its owner opted out (#4188), reap,
 * take the quiet bench route's step (lib/quiet-bench-tick.js, #3852), settle
 * what a kill before the last tick's write left out of the state (#4180), stop
 * each job that never started, tend the served checkouts (their landing queue,
 * the machine's children, the repo holds and the `.git` probe), read the
 * listing, stop each overflow session past its allowance (#3698), send each repo
 * hold's notice, queue the launches a boot killed (#3880), judge the finished
 * launches for progress, act on the blocked and idle ones (lib/refill-blocks.js),
 * queue the sessions parked on each lifted hold (#3863), read admission and the
 * seats and act on the limit-held launches (#3735), then decide
 * (lib/refill-decide.js), first with an empty frontier, the per-repo
 * shortlists being read only on a tick that could launch. From the decision on,
 * lib/refill-tick-settle.js's settleTick. Then
 * the tick's row is appended to the concurrency record (lib/concurrency.js,
 * #2497).
 */

const { buildErrorText } = require("./caught.js");
const { buildTickRecord } = require("./concurrency.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const blocks = require("./refill-blocks.js");
const { isLimitHeld, launchName } = require("./refill-block-core.js");
const limits = require("./refill-limits.js");
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
	awayChangeOf,
	decideTick,
	isLaunchBarred,
	liveLaunchHold,
	NOTHING_LAUNCHABLE,
	readParkers,
	UNREAD,
	unprovenRoom,
} = require("./refill-decide.js");
const {
	controlInMode,
	controlWithoutOptedOut,
	judgedLaunches,
	landingRoots,
	runningOf,
	withAbsentRead,
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
 * The reads, writes and child processes a tick runs through.
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
 *   readLoopLastActAt: (launches: LoopLaunch[], served: string[]) => number|null,
 *   readCause: import("./refill-blocks.js").CauseOf,
 *   readLiftedHolds: (roots: string[]) => Parameters<typeof blocks.queueLifted>[1],
 *   readFreeSlots: () => {slots: number,
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
 *   tendQuietBench: (control: Control,
 *     tick: {lastTypedAt: number|null, now: number}) => Control,
 *   adoptKilledLaunches: (state: LoopState, served: string[]) => LoopState,
 *   settleStartedResumes: (launches: LoopLaunch[], served: string[]) =>
 *     {launches: LoopLaunch[], settled: boolean},
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
 *   sendPauseNotices: (paused: import("./refill-decide.js").Pause|undefined,
 *     now: number) => void,
 *   unparkAnswered: (roots: string[], seen: Seen) => void,
 *   tendClosedParks: (served: string[]) => void,
 *   actOnBlocks: (listed: LoopLaunch[], mode: "normal"|"away", seen: Seen) =>
 *     LoopLaunch[],
 *   actOnIdle: (launches: LoopLaunch[], mode: "normal"|"away", seen: Seen) =>
 *     LoopLaunch[],
 *   releaseAwayParks: (launches: LoopLaunch[], mode: "normal"|"away",
 *     served: string[], seen: Seen) => LoopLaunch[],
 *   attachProbeParks: (broken: string[], launches: LoopLaunch[]) => void,
 *   actOnLimits: (judged: LoopLaunch[], mode: "normal"|"away",
 *     seen: Parameters<typeof limits.actOnLimits>[2]) =>
 *     {launches: LoopLaunch[], slots: number, workingChange: number},
 *   releaseEndedHolds: (before: LoopLaunch[], after: LoopLaunch[], io: BlockIo) => void,
 *   probeDueSeats: (seats: string[], triedAt: Record<string, number>) => Probe[],
 *   startDueConsoleReads: (declared: DeclaredSeats,
 *     seats: import("./refill-decide.js").SeatReading[], root: string|undefined) => void,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[], served: string[]) =>
 *     BatchOutcome,
 *   resumeHeld: (resumes: import("./refill-decide.js").HeldResume[],
 *     held: LoopLaunch[], seen: Seen,
 *     how: {isStopped: () => boolean, record: (launches: LoopLaunch[]) => void}) =>
 *     {launches: LoopLaunch[], started: number, waiting: boolean},
 *   writePause: (pause: import("./refill-decide.js").Pause, noProgressFrom: number) => boolean,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   updateState: (transition: import("./refill-state.js").Transition) => LoopState,
 *   dropSettledLifted: (settled: ReturnType<typeof blocks.queueLifted>["settled"]) => void,
 *   dropManagerRestart: (marker: NonNullable<Parameters<typeof withManagerRestart>[1]>) => void,
 *   appendTick: (record: ReturnType<typeof buildTickRecord>) => void,
 * }} TickActs  every write and child process; each has its dry answer in buildDryActs
 * @typedef {TickReads & TickActs} TickIo
 */

/**
 * The control `change` leaves, made on a fresh read under the control lock and
 * `said` called on what it wrote; `control` where it changes nothing. A dry
 * run writes nothing and goes on over the change previewed.
 * @param {TickIo} io
 * @param {Control|null} control
 * @param {(c: Control) => Control|null} change
 * @param {{what: string, said: (write: Control, fresh: Control) => void,
 *   dryRun: boolean}} how  `what`, the change's name in the busy line
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
	if (written.wrote) said(written.wrote.write, written.wrote.fresh);
	return written.control;
}

/**
 * The control after this tick's read of the founder (controlAfterPresence).
 * @param {TickIo} io
 * @param {Control|null} control
 * @param {{dryRun: boolean, lastPromptAt: number|null, now: number}} tick
 */
const settleAwayMode = (io, control, { dryRun, lastPromptAt, now }) =>
	settleUnderLock(
		io,
		control,
		(c) => controlAfterPresence(c, lastPromptAt, now),
		{
			dryRun,
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

/** The machine's children a tick runs from the review checkout: the incident
 * filers, on its tracker — earlyoom kills (#3094) and memwatch's process
 * runaways (#3807) — and the sweep's slot repair, on its code repo (#4447).
 * @type {[string, string][]} */
const MACHINE_CHILDREN = [
	["file-memory-kill-tickets.js", "memory kills"],
	["file-process-runaway-tickets.js", "process runaways"],
	["repair-sweep-slot.js", "sweep slot repair"],
];

/**
 * What a real tick does for its checkouts ahead of its decision: each landing
 * root with a workflow-core config has its landing queue supervised, its main
 * checkout levelled (#4248), its dependency store warmed for the next cut
 * (#4318) and its worktrees reaped (#4247), a checkout gone
 * since its launch being skipped (#3284); the machine's children run; the
 * repo holds are tended. The served checkouts whose probe failed.
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
 * Stop each overflow session past its allowance (lib/overflow-cap.js,
 * #3698), logged, first giving each overflow launch the session id the listing
 * shows for it (#3701), where the listing read and the seat file declares an
 * overflow seat without fault, paused or stopping alike.
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
 * The checkouts whose answered parks a tick takes off: `served` and every other
 * it could serve, the idle alarm's set (#3950). Discovery that
 * will not read leaves `served`, logged.
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
 * The tick's acts on its launches: the answered parks taken off, the closed
 * issues' parks cleared (#3940), each copy's unretired original tried again
 * (#4646), the blocked and idle launches acted on, then
 * each away park's ledger row released once normal mode is live, ahead of the
 * shortlist read (#3872).
 * Then each served checkout's broken probe has the parks made meanwhile
 * attached to its hold.
 * @param {TickIo} io
 * @param {LoopLaunch[]} listed
 * @param {{mode: "normal"|"away", served: string[], broken: string[],
 *   seen: Seen}} tick
 */
function actOnLaunches(io, listed, { mode, served, broken, seen }) {
	io.unparkAnswered(parkSweepRootsOf(io, served), seen);
	io.tendClosedParks(served);
	const retired = retireOriginals(listed, seen.io);
	const acted = io.releaseAwayParks(
		io.actOnIdle(io.actOnBlocks(retired, mode, seen), mode, seen),
		mode,
		served,
		seen,
	);
	io.attachProbeParks(broken, acted);
	return acted;
}

/**
 * The relief a real tick takes off the registry alone, ahead of the CLI
 * listing (#2665): each job that never started stopped, then the checkouts
 * tended. The served checkouts whose probe failed.
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
 * A real tick's acts off its listing: each overflow session past its allowance
 * stopped, then each repo hold's notice and the pause's sent.
 * @param {TickIo} io
 * @param {{declared: DeclaredSeats, agents: AgentRecord[]|null,
 *   registry: RegistryListing, roots: string[],
 *   paused: import("./refill-decide.js").Pause|undefined, barred: boolean,
 *   now: number}} tick  `barred`, whether a pause or a launch hold bars launching
 */
function actOnListing(
	io,
	{ declared, agents, registry, roots, paused, barred, now },
) {
	capOverflowSessions(io, declared, agents);
	io.sendHoldNotices(
		roots,
		{
			agents: noticeAgentsOf(agents, registry),
			/* A held loop's slots are quiet by intent, as a paused one's are, so
			 * a hold restarts the quiet-slot count rather than raising it. */
			isPaused: barred,
		},
		now,
	);
	io.sendPauseNotices(paused, now);
}

/**
 * The control the tick goes on: the quiet bench route's step taken on a
 * tick's sound, running control (#3852).
 * @param {TickIo} io
 * @param {{parsed: Control|null, unsettled: Control, typedAt: number|null,
 *   now: number}} tick
 */
const stepQuietBench = (io, { parsed, unsettled, typedAt, now }) =>
	parsed === null || unsettled.stopRequested
		? unsettled
		: io.tendQuietBench(unsettled, { lastTypedAt: typedAt, now });

/**
 * `read` with what a kill before the last tick's own write left out of it
 * settled (#4180): its cut-off batch's launches adopted, then each resume left
 * with no outcome (lib/refill-blocks.js's settleStartedResumes), ahead of any
 * judging of the launches. Written at once where either changed it, so a stamp
 * later this tick lands on what was settled; what was written is returned, so
 * the tick reads on from the file (#4232).
 * @param {TickIo} io
 * @param {LoopState} read
 * @param {string[]} served
 */
function settleKilled(io, read, served) {
	const adopted = io.adoptKilledLaunches(read, served);
	const { launches, settled } = io.settleStartedResumes(
		adopted.launches,
		served,
	);
	if (adopted === read && !settled) return read;
	return io.updateState(
		killSettled({ launches, launchCount: adopted.launchCount }, read),
	);
}

/**
 * The tick's listing, an empty one read as nothing live where a boot's killed
 * launches allow it.
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
 * and the seats. A barred tick launches nothing, so it reads none of them, and leaves the limit acts, which need them,
 * for the tick after the resume (#3856); a hold its finishes ended is still
 * released, as that tick's `before` no longer shows it holding. The walks'
 * probe stamps are for this read alone: settleTick writes the tick's own. A
 * limit resume from held takes a slot only where the unproven cap has room,
 * as a launch does (#4223).
 * @param {TickIo} io
 * @param {{control: Control, seatListRead: boolean,
 *   before: LoopLaunch[], judged: LoopLaunch[], seen: Seen, served: string[],
 *   declared: DeclaredSeats, typedSeat: string|null,
 *   seatTriedAt: Record<string, number>, lastActAt: number|null}} tick
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
	},
) {
	if (seen.barred) {
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
	const limitSlots = Math.min(
		free,
		unprovenRoom({ history: judged, lastActAt }),
	);
	/** @param {import("./refill-decide.js").SizedSeat[]} sized */
	const overflowOf = (sized) =>
		overflowReadings(declared, sized, (seat) => io.seatBudget(seat, served[0]));
	/** @type {Probe[]} */
	const moveProbes = [];
	const {
		launches,
		slots: limitLeft,
		workingChange,
	} = io.actOnLimits(judged, control.scope.mode, {
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
		slots: limitSlots,
	});
	const slots = free - (limitSlots - limitLeft);
	io.releaseEndedHolds(before, launches, seen.io);
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
		workingChange,
		seats,
		probes,
		overflow,
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
 * The stopped sessions due back: none on a barred tick, which resumes none,
 * though a stop still names those it leaves.
 * @param {Control} control
 * @param {LoopLaunch[]} launches
 * @param {Seen} seen
 */
const dueResumes = (control, launches, seen) =>
	seen.barred && !control.stopRequested
		? []
		: blocks.resumableOf(launches, seen);

/**
 * A live tick from its decision on (settleTick); the decision it settled on.
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
			/* The raise goes the tick the pause is written, not the next. */
			writePause: (pause) => {
				if (io.writePause(pause, control.noProgressFrom))
					io.sendPauseNotices(pause, input.now);
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
			workingChange: limitChange + launched,
		}),
	);
	return settled;
}

const doNothing = () => undefined;

/**
 * Every act's answer on a dry run, which does none of them (#4356, #4323).
 * Typed over every act, so a new one cannot reach a dry run live.
 * @param {TickReads} io
 * @returns {TickActs}
 */
const buildDryActs = (io) => ({
	/* Unreached: settleUnderLock previews the change over the tick's own
	 * control, which a fresh read would not carry. */
	changeControl: () => ({ busy: "a dry run takes no lock" }),
	reap: io.previewReap,
	tendQuietBench: (control) => control,
	adoptKilledLaunches: (state) => state,
	settleStartedResumes: (launches) => ({ launches, settled: false }),
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
	unparkAnswered: doNothing,
	tendClosedParks: doNothing,
	actOnBlocks: (listed) => listed,
	actOnIdle: (launches) => launches,
	releaseAwayParks: (launches) => launches,
	attachProbeParks: doNothing,
	actOnLimits: (judged, _mode, { slots }) => ({
		launches: judged,
		slots,
		workingChange: 0,
	}),
	releaseEndedHolds: doNothing,
	probeDueSeats: () => [],
	startDueConsoleReads: doNothing,
	launchBatch: () => ({ launched: [], refused: [] }),
	resumeHeld: (_resumes, held) => ({
		launches: held,
		started: 0,
		waiting: false,
	}),
	writePause: () => false,
	runReview: (lastRunOn) => lastRunOn,
	updateState: (transition) => transition(io.readState()),
	dropSettledLifted: doNothing,
	dropManagerRestart: doNothing,
	appendTick: doNothing,
});

const DRY_RUN_WHY = "a dry run acts on nothing";

/**
 * Every block act's answer on a dry run: each one not done (#4569). Typed over
 * every block act, so a new one cannot reach a dry `seen.io` live.
 * @type {BlockActs}
 */
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
 * The control a tick with no sound control file goes on: a loop nobody
 * started, which a real tick stops, and with no set written a dry run previews
 * every checkout it may serve.
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
 * One tick: its decision and the start it judged against. `opening` is what
 * the tick reads before its first write.
 * @param {TickIo} adapter
 * @param {{dryRun: boolean, now: number, opening: {control: ControlRead,
 *   declared: DeclaredSeats,
 *   typed: {at: number|null, seat: string|null}}}} tick
 * @returns {Promise<{decision: import("./refill-decide.js").Decision,
 *   read?: FrontierRead|null, noProgressFrom: number,
 *   agents: AgentRecord[]|null}>}
 */
async function runTick(adapter, { dryRun, now, opening }) {
	/** @type {TickIo} */
	const io = dryRun ? buildDryIo(adapter) : adapter;
	const { control: stored, damaged } = opening.control;
	const { declared, typed } = opening;
	const parsed = settleOptedOut(
		io,
		dryRun,
		settleAwayMode(io, stored, { dryRun, lastPromptAt: typed.at, now }),
	);
	const unsettled = parsed ?? buildStandInControl(io, dryRun, now);
	io.reap();
	const control = stepQuietBench(io, {
		parsed,
		unsettled,
		typedAt: typed.at,
		now,
	});
	/* A dry run previews the state on disk: the marker is the live tick's to apply
	 * and drop. */
	const managerRestart = dryRun ? null : io.readManagerRestart();
	const served = io.servedRoots(control.scope).roots;
	const state = withManagerRestart(
		settleKilled(io, io.readState(), served),
		managerRestart,
		io.readCurrentBootId(),
		io.blockIo(served),
	);
	const registry = io.readRegistry();
	const broken = relieve(io, { registry, state, served, now });
	const agents = readTickListing(io, dryRun, state, registry);
	/* Read side by side here anyway, so the undocumented registry the relief
	 * steps trust is checked against the documented listing every tick. */
	if (agents)
		for (const line of buildDriftLines(agents, registry.agents)) io.log(line);
	/* A pause outranks a launch hold, so the hold is the tick's only where none
	 * stands. */
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
		paused: control.paused,
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
	});
	const acted = actOnLaunches(io, listed, {
		mode: control.scope.mode,
		served,
		broken,
		seen,
	});
	/* A dry run, a barred tick or a stopping one sets nothing running, and the
	 * lifted holds keep for a later tick. */
	const { launches: judged, settled: liftedSettled } =
		dryRun || seen.barred || control.stopRequested
			? { launches: acted, settled: [] }
			: blocks.queueLifted(acted, io.readLiftedHolds(roots), seen);
	const lastActAt = io.readLoopLastActAt(judged, served);
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
		lastActAt,
	});
	const resumable = dueResumes(control, launches, seen);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		mode: control.scope.mode,
		noProgressFrom: control.noProgressFrom,
		stopRequested: control.stopRequested,
		...(control.paused ? { paused: control.paused } : {}),
		...(launchHold ? { launchHold } : {}),
		controlDamaged: dryRun ? null : damaged,
		frontier: [],
		retroBundles: [],
		running: runningOf(launches),
		freeSlots: slots,
		limitHeldLines: launches.filter(isLimitHeld).map(limits.buildHeldStopText),
		typedSeat: typed.seat,
		seats: sizeResumeSeats(seats, resumable, slots, io.capSizer(served[0])),
		overflow,
		history: launches,
		lastActAt,
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
	buildReviewSkip,
	FREE_SLOT_ARGS,
	parseProbeOutcome,
	runTick,
	settleLaunching,
	stopNeverStarted,
};
