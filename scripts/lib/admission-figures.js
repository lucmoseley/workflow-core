const { DRAW_MARGIN_MB, EARLYOOM_FLOOR_MB } = require("./suite-ladder.js");
const { windowsUnbackedMb } = require("./windows-memory.js");

/**
 * @typedef {import("./meminfo.js").MbResult} MbResult
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 * @typedef {import("./admission.js").CpuSlots} CpuSlots
 * @typedef {import("./admission.js").SessionDraw} SessionDraw
 * @typedef {import("./admission.js").LiveDraw} LiveDraw
 * @typedef {import("./admission.js").HeldReserve} HeldReserve
 * @typedef {import("./admission.js").HeldField} HeldField
 * @typedef {{ sessions: number, unvouched?: boolean }} SessionCount
 * @typedef {(SessionCount & { ok: true }) | { ok: false, error: string }} LenientProcs
 * @typedef {import("./admission.js").LiveSessionsResult} LiveSessionsResult
 * @typedef {import("./windows-memory.js").WindowsRead} WindowsRead
 */

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

// 587 MB mean and 304 MB sigma measured, #2231
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
	noProcessCharged: 0,
	noProcessUncharged: 0,
	problems: [],
};

/**
 * @typedef {{ overhead?: MbResult, reclaimable?: MbResult, live?: LiveDraw, host?: SessionDraw, load?: LoadReading, cpu?: CpuSlots, held?: HeldReserve[], typecheckChargeMb?: number, testsHeld?: number, windows?: WindowsRead, guestFreeMb?: number | null }} AdmissionReadings
 */

// 587 − 440 MB measured, #2231
const SUITE_SHARE_MB = 147;

/**
 * @param {number} typecheckChargeMb
 * @param {number} sessions
 */
const typecheckReserveFor = (typecheckChargeMb, sessions) =>
	Math.max(0, typecheckChargeMb - sessions * SUITE_SHARE_MB);

// guess: the aggregate's p95, ruled at #2221
const DRAW_Z = 1.645;

/**
 * @param {number} slots
 * @param {CpuSlots} cpu
 */
const cpuCapped = (slots, cpu) =>
	cpu.slots === null ? slots : Math.min(slots, cpu.slots);

/**
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
 * @param {number} baseMb
 * @param {{ held: HeldReserve[], typecheckReserveMb: number, windowsChargeMb: number, reclaimMb: number }} adjustments
 */
function sessionBudgetMb(
	baseMb,
	{ held, typecheckReserveMb, windowsChargeMb, reclaimMb },
) {
	return (
		baseMb -
		held.reduce((sum, { mb }) => sum + mb, 0) -
		typecheckReserveMb -
		windowsChargeMb -
		EARLYOOM_FLOOR_MB -
		DRAW_MARGIN_MB +
		reclaimMb
	);
}

/** @param {HeldReserve[]} held */
const heldFields = (held) =>
	/** @type {Record<HeldField, number>} */ (
		Object.fromEntries(held.map(({ field, mb }) => [field, mb]))
	);

/**
 * @param {number} budgetMb
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 */
function drawSlots(budgetMb, live, host) {
	let k = 0;
	while (drawNeedFor(live, host, k + 1) <= budgetMb) k++;
	return k;
}

/**
 * @param {SessionCount} procs
 * @param {number} byMemory
 */
function isGuaranteed(procs, byMemory) {
	return procs.sessions === 0 && !procs.unvouched && byMemory < 1;
}

/**
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
		held = [],
		typecheckChargeMb = 0,
		testsHeld = 0,
		windows = { state: "absent" },
		guestFreeMb = null,
	} = {},
) {
	const inputs = {
		live,
		host,
		load,
		cpu,
		held,
		...heldFields(held),
		testsHeld,
		windows,
		guestFreeMb,
		reservedError: overhead.ok ? null : overhead.error,
		reclaimableError: reclaimable.ok ? null : reclaimable.error,
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
	const typecheckReserveMb = typecheckReserveFor(
		typecheckChargeMb,
		live.sessions - live.noProcessUncharged,
	);
	const windowsChargeMb = windowsUnbackedMb(windows, guestFreeMb);
	const budgetMb = sessionBudgetMb(effectiveMb, {
		held,
		typecheckReserveMb,
		windowsChargeMb,
		reclaimMb: reclaimedMb,
	});
	const byMemory = drawSlots(budgetMb, live, host);
	const guaranteed = procs.ok && isGuaranteed(procs, byMemory);
	const memorySlots = guaranteed ? 1 : byMemory;
	const holdSlots = (/** @type {number} */ n) =>
		load.overloaded || testsHeld > 0 ? 0 : cpuCapped(n, cpu);
	return {
		...inputs,
		memRead: /** @type {const} */ (true),
		availableMb: mem.mb,
		reservedMb,
		effectiveMb,
		reclaimedMb,
		budgetMb,
		typecheckReserveMb,
		windowsChargeMb,
		windowsCapped: drawSlots(budgetMb + windowsChargeMb, live, host) > byMemory,
		drawNeedMb: drawNeedFor(live, host, 0),
		byMemory,
		needAtMb: drawNeedFor(live, host, byMemory),
		nextNeedMb: drawNeedFor(live, host, byMemory + 1),
		guaranteed,
		freeSlots: holdSlots(byMemory),
		memorySlots,
		slots: holdSlots(memorySlots),
	};
}

module.exports = {
	DEFAULT_SESSION_DRAW,
	DRAW_Z,
	NO_LIVE_DRAW,
	UNDECLARED_DRAW,
	admissionFigures,
	heldFields,
};
