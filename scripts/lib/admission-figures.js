/*
 * admission-figures.js — the admission arithmetic: from the machine's
 * readings to the slots they admit (#4263). Pure, so its suite reaches every
 * branch in process; `admission.js` does the reading.
 */

const { DRAW_MARGIN_MB, EARLYOOM_FLOOR_MB } = require("./suite-ladder.js");

/**
 * @typedef {import("./meminfo.js").MbResult} MbResult
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 * @typedef {import("./admission.js").CpuSlots} CpuSlots
 * @typedef {import("./admission.js").SessionDraw} SessionDraw
 * @typedef {import("./admission.js").LiveDraw} LiveDraw
 * @typedef {{ sessions: number, unvouched?: boolean }} SessionCount
 * @typedef {(SessionCount & { ok: true }) | { ok: false, error: string }} LenientProcs
 * @typedef {import("./admission.js").LiveSessionsResult} LiveSessionsResult
 * @typedef {import("./windows-memory.js").WindowsRead} WindowsRead
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
 * THE AGGREGATE DRAW (#2221). Admission prices the live sessions together, not
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
 * suite gate queues a suite until its ladder rung is free (#2305).
 *
 * An undeclared repo is charged DEFAULT_SESSION_DRAW: the pooled draw across
 * every repo #2231's 45-minute sample saw working.
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

/**
 * The readings beside memory and the session count, each read by
 * `admission.js`'s named reader and defaulting to no adjustment for a caller
 * that hasn't read it. `launchMb`, the pending pairs
 * `overhead` reserves for one launch, is charged again for each slot past the
 * first (#2511, #2568); `live` is the live sessions' draw, from `liveDraw`,
 * and `host` this host's session draw, from `readSessionDraw` (#2221);
 * `landerMb`, from `landerHeldMb`, is held back for the lander's suite;
 * `load` comes from `overloadReading`, and an overload holds
 * every slot; `cpu`, from `cpuSlots`, caps them (#830, #2141), and so does
 * `windows`, from `readWindowsMemory`, a fresh reading holding them to what
 * Windows' own free memory admits (#4557), the always-admit-one guarantee
 * included in all three.
 * @typedef {{ overhead?: MbResult, reclaimable?: MbResult, live?: LiveDraw, host?: SessionDraw, load?: LoadReading, cpu?: CpuSlots, landerMb?: number, launchMb?: number, windows?: WindowsRead }} AdmissionReadings
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
 * The slots Windows' own free memory admits, null where no fresh reading
 * holds them (#4557). The same aggregate draw as the guest's, against Windows'
 * free memory less the pool reserve, the lander's suite and DRAW_MARGIN_MB:
 * earlyoom's line is the guest's, and a reclaim's freed pages return to
 * Windows on no schedule, so earn no credit.
 * @param {WindowsRead} windows
 * @param {{ reservedMb: number, landerMb: number, live: LiveDraw, host: SessionDraw, launchMb: number }} draw
 * @returns {{ windowsMb: number, windowsBudgetMb: number, windowsSlots: number } | null}
 */
function windowsSlotsOf(
	windows,
	{ reservedMb, landerMb, live, host, launchMb },
) {
	if (windows.state !== "fresh") return null;
	const windowsBudgetMb = windows.mb - reservedMb - landerMb - DRAW_MARGIN_MB;
	return {
		windowsMb: windows.mb,
		windowsBudgetMb,
		windowsSlots: drawSlots(windowsBudgetMb, live, host, launchMb),
	};
}

/**
 * Whether the always-admit-one guarantee holds: nothing of ours running and
 * memory admitting none. A zero count no listing vouched for never unlocks it
 * (#2180).
 * @param {SessionCount} procs
 * @param {number} byMemory
 */
function isGuaranteed(procs, byMemory) {
	return procs.sessions === 0 && !procs.unvouched && byMemory < 1;
}

/**
 * `overhead` FAILS OPEN to no reservation where it cannot be read: it refines
 * the memory/session gate, which already fails closed. `reclaimable` FAILS
 * CLOSED to no credit: crediting memory that never materialises is the
 * over-admission this gate exists to prevent. An unread session count yields
 * no guarantee; unread memory yields no figures, only its error.
 *
 * `byMemory` is the p95 pricing alone, and `memorySlots` lifts it to the
 * guarantee's slot. `freeSlots` and `slots` are those two under the CPU cap,
 * the Windows hold and the load hold.
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
		launchMb = 0,
		windows = { state: "absent" },
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
		windows,
	};
	if (!mem.ok)
		return {
			...inputs,
			memRead: /** @type {const} */ (false),
			error: mem.error,
		};
	const reservedMb = overhead.ok ? overhead.mb : 0;
	const effectiveMb = Math.max(0, mem.mb - reservedMb);
	const reclaimedMb = reclaimable.ok ? reclaimable.mb : 0;
	/* The floor and margin come off what admits sessions and nothing else:
	 * the suite ladder carries earlyoom's line in its own rungs. */
	const budgetMb = sessionBudgetMb(effectiveMb, landerMb, reclaimedMb);
	const byMemory = drawSlots(budgetMb, live, host, launchMb);
	const guaranteed = procs.ok && isGuaranteed(procs, byMemory);
	const memorySlots = guaranteed ? 1 : byMemory;
	const onWindows = windowsSlotsOf(windows, {
		reservedMb,
		landerMb,
		live,
		host,
		launchMb,
	});
	const held = (/** @type {number} */ n) =>
		load.overloaded
			? 0
			: Math.min(
					cpuCapped(n, cpu),
					onWindows ? onWindows.windowsSlots : Number.POSITIVE_INFINITY,
				);
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
		freeSlots: held(byMemory),
		memorySlots,
		onWindows,
		slots: held(memorySlots),
	};
}

module.exports = {
	DEFAULT_SESSION_DRAW,
	DRAW_Z,
	NO_LIVE_DRAW,
	UNDECLARED_DRAW,
	admissionFigures,
};
