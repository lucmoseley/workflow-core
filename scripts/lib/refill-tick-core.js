/*
 * refill-tick-core.js — the refill loop's tick (#2012, #2123, spec #1995,
 * #4212): its step order, its dry-run policy and its own readings, with no I/O
 * of its own. Every read, write and child process goes through the TickIo port,
 * whose production adapter is lib/refill-tick.js; a dry run takes that adapter
 * with its writes no-ops. A dry run differs in the policy branches here (it
 * previews over no control as over a stopped one, judges no listing by a boot's
 * kills and stops at its decision) and in what those no-ops answer, which is
 * policy too.
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
 * lib/refill-tick-settle.js's settleTick. Then
 * the tick's row is appended to the concurrency record (lib/concurrency.js,
 * #2497).
 */

const { buildTickRecord } = require("./concurrency.js");
const { neverStartedJobs } = require("./hung-jobs.js");
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
	decideTick,
	NOTHING_LAUNCHABLE,
	UNREAD,
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
const { withoutLaunching } = require("./refill-state.js");
const { buildDriftLines } = require("./registry-agents.js");
const {
	overflowReadings,
	seatTriedAfter,
	sizeResumeSeats,
} = require("./seat-reading.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

const { launchName } = blocks;

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
 *   readProgress: (l: LoopLaunch, served: string[]) => object,
 *   readCause: import("./refill-blocks.js").CauseOf,
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
 * `said` called on what it wrote; `control` where it changes nothing. A dry run's adapter writes nothing, answering null, and the tick
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
 * and the seats. A paused tick launches nothing, so it reads none of them, and leaves the limit acts, which need them,
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
const buildStandInControl = (io, dryRun, now) => ({
	noProgressFrom: now,
	stopRequested: !dryRun,
	seats: io.readConfiguredSeats(),
	scope: { mode: "normal", repos: io.readIncluded(), goal: null },
});

/**
 * One tick: its decision and the start it judged against. `opening` is what
 * the tick reads before its first write.
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
	const unsettled = parsed ?? buildStandInControl(io, dryRun, now);
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
	const paused = control.paused !== undefined;
	/** @type {Seen} */
	const seen = {
		agents,
		now,
		io: io.blockIo(served),
		swapHold: io.readSwapHold(),
		paused,
	};
	const roots = landingRoots(served, state.launches);
	io.sendHoldNotices(
		roots,
		{
			agents: noticeAgentsOf(agents, registry),
			isPaused: paused,
		},
		now,
	);
	const booted = dryRun ? state : settleBootKilled(state, seen, registry);
	const listed = judgedLaunches(booted.launches, agents, now, {
		progressOf: (l) => io.readProgress(l, served),
		causeOf: io.readCause,
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
	buildReviewSkip,
	FREE_SLOT_ARGS,
	parseProbeOutcome,
	runTick,
	settleLaunching,
	stopNeverStarted,
};
