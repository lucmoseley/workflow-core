/*
 * admission-figures.js — the admission arithmetic: from the machine's
 * readings to the slots they admit (workflow-core#4263). Pure, so its suite reaches every
 * branch in process; `admission.js` does the reading.
 */

const { DRAW_MARGIN_MB, EARLYOOM_FLOOR_MB } = require("./suite-ladder.js");

/**
 * @typedef {import("./meminfo.js").MbResult} MbResult
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 * @typedef {import("./admission.js").CpuSlots} CpuSlots
 * @typedef {import("./admission.js").SessionDraw} SessionDraw
 * @typedef {import("./admission.js").LiveDraw} LiveDraw
 * @typedef {import("./admission.js").SwapHold} SwapHold
 * @typedef {{ sessionFloor: number, sessionFloorWorking: number, sessionFloorSlots: number, sessionFloorLifted: boolean, swapHold: SwapHold }} SessionFloorFigures
 * @typedef {{ sessions: number, working: number, self?: boolean, unvouched?: boolean }} FloorProcs
 * @typedef {(FloorProcs & { ok: true }) | { ok: false, error: string }} LenientProcs
 * @typedef {import("./admission.js").LiveSessionsResult} LiveSessionsResult
 */

/* The default for a caller that has not read the load: no hold. */
/** @type {LoadReading} */
const LOAD_UNREAD = { overloaded: false, load1: null, ceiling: null };

/** @type {CpuSlots} */
const CPU_UNREAD = {
	ceiling: null,
	sessions: null,
	idleSpares: null,
	slots: null,
	full: false,
	unknown: "not read",
};

/*
 * THE AGGREGATE DRAW (workflow-core#2221). Admission prices the live sessions together, not
 * as N copies of one session's p90: sessions do not peak together, so the
 * sum's tail grows with √N. One session's draw is its pair (the session
 * process and its `bg-pty-host`) plus every process it starts, measured as a
 * mean and a standard deviation (`docs/environment.md` §5). k more sessions are
 * admitted while
 *
 *   Σμ + k·μ + z·√(Σσ² + k·σ²) − the live sessions' current PSS
 *     ≤ free − pool reserve − earlyoom floor − margin + reclaim credit
 *
 * Σ runs over the live sessions, each at its own repo's draw; the bare μ and σ
 * are this host's, whose sessions are the ones admitted. Current PSS counts
 * descendants too, the unit μ is measured in, so the suites μ's sample saw
 * are charged at the rate it saw them. Nothing more is held for suites: the
 * suite gate queues a suite until its ladder rung is free (workflow-core#2305).
 *
 * An undeclared repo is charged DEFAULT_SESSION_DRAW: the pooled draw across
 * every repo workflow-core#2231's 45-minute sample saw working.
 */
/** @type {{ meanMb: number, sigmaMb: number }} */
const DEFAULT_SESSION_DRAW = { meanMb: 587, sigmaMb: 304 };
/** @type {SessionDraw} */
const UNDECLARED_DRAW = { ...DEFAULT_SESSION_DRAW, declared: false };
/** @type {LiveDraw} */
const NO_LIVE_DRAW = {
	sessions: 0,
	meanMb: 0,
	varianceMb2: 0,
	pssMb: 0,
	unread: 0,
	noProcess: 0,
	problems: [],
};
/** @type {SwapHold} */
const NO_SWAP_HOLD = { held: false };

/**
 * The readings beside memory and the session count, each read by
 * `admission.js`'s named reader and defaulting to no adjustment for a caller
 * that hasn't read it. `launchMb`, the pending pairs
 * `overhead` reserves for one launch, is charged again for each slot past the
 * first (workflow-core#2511, workflow-core#2568); `live` is the live sessions' draw, from `liveDraw`,
 * and `host` this host's session draw, from `readSessionDraw` (workflow-core#2221);
 * `landerMb`, from `landerHeldMb`, is held back for the lander's suite;
 * `sessionFloor`, from `readDeclaredSessionFloor`, lifts the memory slots to
 * `sessionFloorSlotsOf`'s, none while `swapHold`, from `swapHoldOf`, binds
 * (workflow-core#2501, workflow-core#2690); `load` comes from `overloadReading`, and an overload holds
 * every slot; `cpu`, from `cpuSlots`, caps them (workflow-core#830, workflow-core#2141), the
 * always-admit-one guarantee included in both.
 * @typedef {{ overhead?: MbResult, reclaimable?: MbResult, live?: LiveDraw, host?: SessionDraw, load?: LoadReading, cpu?: CpuSlots, landerMb?: number, sessionFloor?: number, swapHold?: SwapHold, launchMb?: number }} AdmissionReadings
 */

/* The aggregate's p95, ruled at workflow-core#2221. DUPLICATED BY HAND as DRAW_Z in
 * scripts/sample_session_memory.py, whose aggregate check models this p95:
 * move both, or neither. */
const DRAW_Z = 1.645;

/**
 * @param {number} slots
 * @param {CpuSlots} cpu
 */
const cpuCapped = (slots, cpu) =>
	cpu.slots === null ? slots : Math.min(slots, cpu.slots);

/**
 * What the live sessions and `k` more still need at the aggregate's p95, less
 * what the live ones already hold. Negative
 * where the live sessions already hold more than that.
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} k
 */
function drawNeedFor(live, host, k) {
	return Math.ceil(
		live.meanMb +
			k * host.meanMb +
			DRAW_Z * Math.sqrt(live.varianceMb2 + k * host.sigmaMb ** 2) -
			live.pssMb,
	);
}

/**
 * What admits sessions, from `baseMb`, memory less the pool reserve.
 * @param {number} baseMb
 * @param {number} landerMb
 * @param {number} reclaimMb
 */
function sessionBudgetMb(baseMb, landerMb, reclaimMb) {
	return baseMb - landerMb - EARLYOOM_FLOOR_MB - DRAW_MARGIN_MB + reclaimMb;
}

/**
 * `drawNeedFor` plus the spare pairs the 2nd to k-th of k launches warm, each
 * `launchMb`: the budget already reserves the 1st's (workflow-core#2511).
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} k
 * @param {number} launchMb
 */
function launchNeedFor(live, host, k, launchMb) {
	return drawNeedFor(live, host, k) + Math.max(0, k - 1) * launchMb;
}

/**
 * How many more of this host's sessions `budgetMb` admits on the aggregate
 * draw: the largest k whose need fits, 0 where none does.
 * @param {number} budgetMb
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} launchMb see `launchNeedFor`
 */
function drawSlots(budgetMb, live, host, launchMb) {
	let k = 0;
	while (launchNeedFor(live, host, k + 1, launchMb) <= budgetMb) k++;
	return k;
}

/**
 * The session floor's slots: those `sessionFloor` wants past the `working`
 * sessions, each granted only while `effectiveMb` still holds one more
 * session's mean above earlyoom's line and the margin, the machine's hard
 * limit (CLAUDE.md §Machine limits).
 *
 * Priced at the mean, not the p95 aggregate the draw slots use, and against
 * memory the lander's suite reserve (workflow-core#2416) is NOT taken from: a floor slot
 * may admit into the lander's hold. The residual risk is a floor slot's
 * session plus a lander's suite eating into the margin above earlyoom's line,
 * which the founder's floor accepts until workflow-core#2495.
 * @param {number} sessionFloor
 * @param {number} working the sessions in a working state, the caller included
 * @param {number} effectiveMb free memory less the spare pool's reserve
 * @param {SessionDraw} host
 */
function sessionFloorSlotsOf(sessionFloor, working, effectiveMb, host) {
	const wanted = Math.max(0, sessionFloor - working);
	const room = Math.floor(sessionBudgetMb(effectiveMb, 0, 0) / host.meanMb);
	return Math.max(0, Math.min(wanted, room));
}

/**
 * Whether the always-admit-one guarantee holds: nothing of ours running and
 * memory admitting none. A zero count no listing vouched for never unlocks it
 * (workflow-core#2180).
 * @param {FloorProcs} procs
 * @param {number} byMemory
 */
function isGuaranteed(procs, byMemory) {
	return procs.sessions === 0 && !procs.unvouched && byMemory < 1;
}

/**
 * The session floor's figures both verdicts report: the working sessions,
 * this run's own counted, the floor slots, none while `swapHold` binds
 * (workflow-core#2690), and whether they lift `priced`, the slots the p95 pricing and the
 * guarantee give.
 * @param {{ sessionFloor: number, procs: FloorProcs, effectiveMb: number, host: SessionDraw, priced: number, swapHold: SwapHold }} input
 * @returns {SessionFloorFigures}
 */
function sessionFloorFigures({
	sessionFloor,
	procs,
	effectiveMb,
	host,
	priced,
	swapHold,
}) {
	const sessionFloorWorking = procs.working + (procs.self ? 1 : 0);
	const sessionFloorSlots = swapHold.held
		? 0
		: sessionFloorSlotsOf(sessionFloor, sessionFloorWorking, effectiveMb, host);
	return {
		sessionFloor,
		sessionFloorWorking,
		sessionFloorSlots,
		sessionFloorLifted: sessionFloorSlots > priced,
		swapHold,
	};
}

/**
 * `overhead` FAILS OPEN to no reservation where it cannot be read: it refines
 * the memory/session gate, which already fails closed. `reclaimable` FAILS
 * CLOSED to no credit: crediting memory that never materialises is the
 * over-admission this gate exists to prevent. An unread session count yields
 * no floor and no guarantee; unread memory yields no figures, only its error.
 *
 * `byMemory` is the p95 pricing alone; `liftedSlots` lifts it to the floor,
 * and `memorySlots` lifts the guarantee's slot too. `liftedCapped` and
 * `slots` are those two under the CPU cap and the load hold.
 * @param {MbResult} mem
 * @param {LenientProcs | LiveSessionsResult} procs
 * @param {AdmissionReadings} [readings]
 */
function admissionFigures(
	mem,
	procs,
	{
		overhead = { ok: true, mb: 0 },
		reclaimable = { ok: true, mb: 0 },
		live = NO_LIVE_DRAW,
		host = UNDECLARED_DRAW,
		load = LOAD_UNREAD,
		cpu = CPU_UNREAD,
		landerMb = 0,
		sessionFloor = 0,
		swapHold = NO_SWAP_HOLD,
		launchMb = 0,
	} = {},
) {
	const inputs = {
		live,
		host,
		load,
		cpu,
		landerMb,
		launchMb,
		reservedError: overhead.ok ? null : overhead.error,
		reclaimableError: reclaimable.ok ? null : reclaimable.error,
	};
	/** @type {SessionFloorFigures} */
	const noFloor = {
		sessionFloor,
		sessionFloorWorking: 0,
		sessionFloorSlots: 0,
		sessionFloorLifted: false,
		swapHold,
	};
	if (!mem.ok)
		return {
			...inputs,
			memRead: /** @type {const} */ (false),
			error: mem.error,
			floor: noFloor,
		};
	const reservedMb = overhead.ok ? overhead.mb : 0;
	const effectiveMb = Math.max(0, mem.mb - reservedMb);
	const reclaimedMb = reclaimable.ok ? reclaimable.mb : 0;
	/* The floor and margin come off what admits sessions and nothing else:
	 * the suite ladder carries earlyoom's line in its own rungs. */
	const budgetMb = sessionBudgetMb(effectiveMb, landerMb, reclaimedMb);
	const byMemory = drawSlots(budgetMb, live, host, launchMb);
	const guaranteed = procs.ok && isGuaranteed(procs, byMemory);
	const priced = guaranteed ? 1 : byMemory;
	const floor = procs.ok
		? sessionFloorFigures({
				sessionFloor,
				procs,
				effectiveMb,
				host,
				priced,
				swapHold,
			})
		: noFloor;
	const liftedSlots = Math.max(byMemory, floor.sessionFloorSlots);
	const memorySlots = Math.max(priced, floor.sessionFloorSlots);
	const held = (/** @type {number} */ n) =>
		load.overloaded ? 0 : cpuCapped(n, cpu);
	return {
		...inputs,
		memRead: /** @type {const} */ (true),
		availableMb: mem.mb,
		reservedMb,
		effectiveMb,
		reclaimedMb,
		budgetMb,
		drawNeedMb: drawNeedFor(live, host, 0),
		byMemory,
		needAtMb: launchNeedFor(live, host, byMemory, launchMb),
		nextNeedMb: launchNeedFor(live, host, byMemory + 1, launchMb),
		guaranteed,
		floor,
		liftedSlots,
		liftedCapped: held(liftedSlots),
		memorySlots,
		slots: held(memorySlots),
	};
}

module.exports = {
	DEFAULT_SESSION_DRAW,
	DRAW_Z,
	NO_LIVE_DRAW,
	NO_SWAP_HOLD,
	UNDECLARED_DRAW,
	admissionFigures,
};
