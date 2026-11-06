/*
 * admission-figures.js — the admission arithmetic: from the machine's
 * readings to the slots they admit (#4263).
 */

const { DRAW_MARGIN_MB, EARLYOOM_FLOOR_MB } = require("./suite-ladder.js");

/**
 * @typedef {import("./meminfo.js").MbResult} MbResult
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 * @typedef {import("./admission.js").CpuSlots} CpuSlots
 * @typedef {import("./admission.js").SessionDraw} SessionDraw
 * @typedef {import("./admission.js").LiveDraw} LiveDraw
 * @typedef {import("./admission.js").SwapHold} SwapHold
 * @typedef {import("./admission.js").SessionFloorFigures} SessionFloorFigures
 * @typedef {import("./admission.js").FloorProcs} FloorProcs
 * @typedef {import("./admission.js").LenientProcs} LenientProcs
 * @typedef {import("./admission.js").LiveSessionsResult} LiveSessionsResult
 * @typedef {{ overhead: MbResult, reclaimable: MbResult, live: LiveDraw, host: SessionDraw, load: LoadReading, cpu: CpuSlots, landerMb: number, sessionFloor: number, swapHold: SwapHold, launchMb: number }} FigureReadings
 */

/* The aggregate's p95, ruled at #2221. DUPLICATED BY HAND as DRAW_Z in
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
 * `launchMb`: the budget already reserves the 1st's (#2511).
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
 * memory the lander's suite reserve (#2416) is NOT taken from: a floor slot
 * may admit into the lander's hold. The residual risk is a floor slot's
 * session plus a lander's suite eating into the margin above earlyoom's line,
 * which the founder's floor accepts until #2495.
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
 * (#2180).
 * @param {FloorProcs} procs
 * @param {number} byMemory
 */
function isGuaranteed(procs, byMemory) {
	return procs.sessions === 0 && !procs.unvouched && byMemory < 1;
}

/**
 * The session floor's figures both verdicts report: the working sessions,
 * this run's own counted, the floor slots, none while `swapHold` binds
 * (#2690), and whether they lift `priced`, the slots the p95 pricing and the
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
 * @param {FigureReadings} readings
 */
function admissionFigures(
	mem,
	procs,
	{
		overhead,
		reclaimable,
		live,
		host,
		load,
		cpu,
		landerMb,
		sessionFloor,
		swapHold,
		launchMb,
	},
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

module.exports = { DRAW_Z, admissionFigures };
