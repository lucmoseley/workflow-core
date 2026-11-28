const { heldFields } = require("./admission-figures.js");
const { caught } = require("./caught.js");
const { readJsonl, readLastJsonlRow } = require("./jsonl.js");
const {
	NOTHING_LAUNCHABLE,
	PROBE_HOLD_WAIT,
	UNTRUSTED_HELD,
	buildIdleText,
	buildPauseText,
	buildLaunchHoldText,
	isLaunchBarred,
	buildPlanWaitText,
	pickSeat,
} = require("./refill-decide.js");
const { refillPath } = require("./refill-dir.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { minuteLogPath } = require("./windows-memory.js");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// guess, #2497
const STALE_MS = 15 * MINUTE_MS;
const RETAIN_MS = 28 * DAY_MS;

const LOOP_OFF = "loop not running";
const LAUNCH_HOLD = "launch hold";
const WINDOWS_MEMORY = "Windows memory";
const NONE = "none";
// guess, #3315
const SPREAD_CAP = 10;

/** @typedef {{limit: string, why: string}} Failing */

/**
 * @typedef {object} TickRecord
 * @property {string} at
 * @property {number|null} live
 * @property {number|null} ceiling
 * @property {number|null} working
 * @property {Waiting[]|null} [waiting]
 * @property {Failing|null} binding
 * @property {Failing[]} also
 * @property {TickMemory|null} memory
 */
/** @typedef {{seat: string, count: number, cwd: string|null}} Waiting */
/** @typedef {import("./admission.js").AdmissionJson} AdmissionJson */
/** @typedef {ReturnType<typeof buildTickMemory>} TickMemory */

/** @typedef {{ts: string, sessions: number|null, load1?: number|null}} MinuteLine */
/** @typedef {{dir: string, count: number}} UnlistedDir */
/** @typedef {{count: number|null, mb: number|null, unknown?: string|null}} UnlistedRead */

/**
 * @param {AdmissionJson} a
 * @returns {{name: string, mb: number}}
 */
function largestHolder(a) {
	const m = a.memory ?? {};
	/** @type {[string, number|null|undefined][]} */
	const holders = [
		["the live sessions' p95 draw", a.drawNeedMb],
		["the earlyoom floor + margin", (a.floorMb ?? 0) + (a.marginMb ?? 0)],
		...(a.held ?? []).map(
			({ holding, mb }) =>
				/** @type {[string, number]} */ ([`${holding} reserve`, mb]),
		),
		["the type-check reserve", a.typecheckReserveMb],
		["guest free memory Windows cannot back", a.windowsChargeMb],
		["non-session processes", m.other?.mb],
		["the spare pool", m.pool?.mb],
		["finished sessions", m.finished?.mb],
		["unlisted sessions", m.unlisted?.mb],
	];
	let best = { name: "nothing", mb: 0 };
	for (const [name, mb] of holders)
		if (typeof mb === "number" && mb > best.mb) best = { name, mb };
	return best;
}

/**
 * @param {import("./refill-decide.js").TickInput} input
 * @param {import("./refill-decide.js").Decision} decision
 * @returns {Failing[]}
 */
function policyFailing(input, decision) {
	if ("stop" in decision)
		return [{ limit: LOOP_OFF, why: `stopping: ${decision.detail}` }];
	if (input.paused)
		return [{ limit: LOOP_OFF, why: buildPauseText(input.paused) }];
	if (input.launchHold)
		return [{ limit: LAUNCH_HOLD, why: buildLaunchHoldText(input.launchHold) }];
	if (decision.planWait)
		return [{ limit: "allowance", why: buildPlanWaitText(decision.planWait) }];
	/** @type {Failing[]} */
	const out = [];
	if (decision.idle?.reason === NOTHING_LAUNCHABLE)
		out.push({
			limit: "empty frontier",
			why: "nothing in the frontier is launchable",
		});
	if (decision.idle?.reason === UNTRUSTED_HELD)
		out.push({ limit: "workspace trust", why: buildIdleText(decision.idle) });
	if (decision.idle?.reason === PROBE_HOLD_WAIT)
		out.push({ limit: "probe hold", why: buildIdleText(decision.idle) });
	const pick = input.freeSlots > 0 ? pickSeat(input) : null;
	if (pick && pick.seat === null)
		out.push({
			limit: "allowance",
			why: pick.wait ? buildIdleText(pick.wait) : "no seat fits",
		});
	return out;
}

/**
 * @param {AdmissionJson|null} a
 * @returns {Failing[]}
 */
function resourceFailing(a) {
	if (!a)
		return [
			{
				limit: "memory",
				why: "admission.js did not read, so no slot is admitted",
			},
		];
	/** @type {Failing[]} */
	const out = [];
	if (
		typeof a.slots !== "number" ||
		typeof a.memorySlots !== "number" ||
		!a.memory
	)
		out.push({
			limit: "memory",
			why: "admission's verdict carried no slot count or breakdown, so its fit is unknown",
		});
	else if (a.memorySlots === 0 && !a.windowsCapped) {
		const top = largestHolder(a);
		out.push({ limit: "memory", why: `${top.name} holds most (${top.mb} MB)` });
	}
	if (a.testsHeld > 0)
		out.push({
			limit: WINDOWS_MEMORY,
			why: `${a.testsHeld} queued test run(s) are held on it`,
		});
	else if (a.memorySlots === 0 && a.windowsCapped)
		out.push({
			limit: WINDOWS_MEMORY,
			why: `${a.windowsChargeMb} MB of the guest's free memory is more than Windows can back`,
		});
	const { load, cpu } = a;
	if (!load || !cpu)
		out.push({
			limit: "CPU",
			why: "admission's verdict carried no load or CPU reading, so it is unknown",
		});
	else if (load.overloaded)
		out.push({ limit: "CPU", why: `load1 ${load.load1} over ${load.ceiling}` });
	else if (cpu.full || cpu.slots === 0)
		out.push({
			limit: "CPU",
			why: `${cpu.sessions} sessions fill the ceiling of ${cpu.ceiling}`,
		});
	return out;
}

/** @typedef {"load" | "sessions" | "memory" | "Windows memory" | "none"} Limb */

/**
 * @param {TickRecord} t
 * @returns {Limb | null}
 */
function tickLimb(t) {
	for (const f of [t.binding, ...(t.also ?? [])]) {
		if (!f) continue;
		const limb = failingLimb(f, t);
		if (limb !== undefined) return limb;
	}
	return t.memory ? NONE : null;
}

/**
 * @param {Failing} f
 * @param {TickRecord} t
 * @returns {Limb | null | undefined}
 */
function failingLimb(f, t) {
	if (f.limit === "memory") return t.memory ? "memory" : null;
	if (f.limit === WINDOWS_MEMORY) return WINDOWS_MEMORY;
	if (f.limit !== "CPU") return;
	if (f.why.startsWith("load1 ")) return "load";
	return f.why.includes(" sessions fill ") ? "sessions" : null;
}

/**
 * @param {Tick} tick
 * @returns {Failing[]}
 */
function failingAt({ input, decision, admission }) {
	return [
		...policyFailing(input, decision),
		...(isLaunchBarred(input, input.now) ? [] : resourceFailing(admission)),
	];
}

/**
 * @typedef {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision,
 *   admission: AdmissionJson|null, liveChange: number,
 *   agents: import("./agent-liveness.js").AgentRecord[]|null}} Tick
 */

/**
 * @param {import("./agent-liveness.js").AgentRecord[]} agents
 * @param {string|null} typedSeat
 * @returns {Waiting[]}
 */
function waitingOffSeat(agents, typedSeat) {
	/** @type {Map<string, Waiting>} */
	const bySeat = new Map();
	for (const a of agents) {
		if (a.state !== "needs_input" || !a.seat || a.seat === typedSeat) continue;
		const had = bySeat.get(a.seat);
		bySeat.set(
			a.seat,
			had
				? { ...had, count: had.count + 1 }
				: { seat: a.seat, count: 1, cwd: a.cwd ?? null },
		);
	}
	return [...bySeat.values()];
}

/**
 * @param {Tick} tick
 * @returns {TickRecord}
 */
function buildTickRecord(tick) {
	const { input, admission: a, liveChange, agents } = tick;
	const [binding = null, ...also] = failingAt(tick);
	const count = a?.memory?.live?.count;
	const admitted = typeof count === "number" ? count : null;
	return {
		at: new Date(input.now).toISOString(),
		live: admitted === null ? null : admitted + liveChange,
		ceiling:
			admitted !== null && typeof a?.slots === "number"
				? admitted + a.slots
				: null,
		working: agents ? agents.filter((r) => r.state === "working").length : null,
		waiting: agents ? waitingOffSeat(agents, input.typedSeat ?? null) : null,
		binding,
		also,
		memory: a ? buildTickMemory(a) : null,
	};
}

/** @param {AdmissionJson} a */
function buildTickMemory(a) {
	return {
		availableMb: a.availableMb,
		budgetMb: a.budgetMb,
		drawNeedMb: a.drawNeedMb,
		nextNeedMb: a.nextNeedMb,
		reservedMb: a.reservedMb,
		...heldFields(a.held ?? []),
		typecheckReserveMb: a.typecheckReserveMb,
		windowsChargeMb: a.windowsChargeMb,
		testsHeld: a.testsHeld,
		guestFreeMb: a.guestFreeMb,
		noProcessCharged: a.noProcessCharged,
		windows: a.windows,
		floorMb: a.floorMb,
		marginMb: a.marginMb,
		memorySlots: a.memorySlots,
		rows: {
			live: a.memory?.live?.mb ?? null,
			finished: a.memory?.finished?.mb ?? null,
			pool: a.memory?.pool?.mb ?? null,
			other: a.memory?.other?.mb ?? null,
		},
		unlisted: unlistedOf(a.memory?.unlisted),
		largest: largestHolder(a),
	};
}

/**
 * @param {(Partial<UnlistedRead> & {dirs?: UnlistedDir[]})|null|undefined} u
 * @returns {UnlistedRead & {dirs: UnlistedDir[]}|null}
 */
function unlistedOf(u) {
	if (!u) return null;
	return {
		count: u.count ?? null,
		mb: u.mb ?? null,
		unknown: u.unknown ?? null,
		dirs: u.dirs ?? [],
	};
}

/**
 * @param {TickRecord[]} ticks
 * @param {number} now
 */
const timedTicks = (ticks, now) =>
	ticks
		.map((t) => ({ t, ms: Date.parse(t.at) }))
		.filter(({ ms }) => Number.isFinite(ms) && ms <= now)
		.sort((x, y) => x.ms - y.ms);

/** @param {{ticks: TickRecord[], now: number, unreadable?: string[]}} input */
function buildVerdict({ ticks, now, unreadable = [] }) {
	const last = timedTicks(ticks, now).at(-1);
	const stale = !last || now - last.ms > STALE_MS;
	/** @type {Failing|null} */
	const verdict = stale
		? {
				limit: LOOP_OFF,
				why: last ? `no tick since ${last.t.at}` : "no tick recorded",
			}
		: last.t.binding;
	return {
		unreadable,
		lastTick: last?.t ?? null,
		stale,
		verdict,
		also: stale ? [] : (last?.t.also ?? []),
	};
}

/**
 * @param {{ticks: TickRecord[], minutes: MinuteLine[]|null, now: number,
 *   windowMs: number, unreadable?: string[]}} input
 */
function readout({ ticks, minutes, now, windowMs, unreadable = [] }) {
	const from = now - windowMs;
	const timed = timedTicks(ticks, now);
	/** @param {number} ms */
	const limitAt = (ms) => {
		let last = null;
		for (const x of timed) {
			if (x.ms > ms) break;
			last = x;
		}
		if (!last || ms - last.ms > STALE_MS) return LOOP_OFF;
		return last.t.binding?.limit ?? NONE;
	};

	const lines = (minutes ?? [])
		.map((m) => ({ ms: Date.parse(m.ts), sessions: m.sessions }))
		.filter(({ ms }) => Number.isFinite(ms) && ms <= now)
		.sort((x, y) => x.ms - y.ms);
	let weighted = 0;
	let activeMs = 0;
	/** @type {Record<string, number>} */
	const chargedMs = {};
	/** @type {Record<string, number>} */
	const spreadMs = {};
	lines.forEach((line, i) => {
		const end = Math.min(lines[i + 1]?.ms ?? now, now, line.ms + STALE_MS);
		const start = Math.max(line.ms, from);
		const ms = end - start;
		if (ms <= 0 || typeof line.sessions !== "number" || line.sessions <= 0)
			return;
		weighted += line.sessions * ms;
		activeMs += ms;
		const limit = limitAt(line.ms);
		chargedMs[limit] = (chargedMs[limit] ?? 0) + ms;
		const bucket = String(Math.min(line.sessions, SPREAD_CAP));
		spreadMs[bucket] = (spreadMs[bucket] ?? 0) + ms;
	});

	return {
		...buildVerdict({ ticks, now, unreadable }),
		minutesRead: minutes !== null,
		sustained: activeMs > 0 ? weighted / activeMs : null,
		activeHours: activeMs / HOUR_MS,
		hours: Object.fromEntries(
			Object.entries(chargedMs).map(([k, ms]) => [k, ms / HOUR_MS]),
		),
		spread: Object.fromEntries(
			Object.entries(spreadMs).map(([k, ms]) => [k, ms / activeMs]),
		),
	};
}

/**
 * @param {ReturnType<typeof buildVerdict>} r
 * @param {() => UnlistedRead} readLive
 * @param {() => number | null} [readHeldRun]
 */
function buildBlockText(r, readLive, readHeldRun = () => null) {
	const t = r.lastTick;
	const v = r.verdict;
	const lines = [
		...r.unreadable.map((u) => `unreadable: ${u}`),
		t
			? `${t.live ?? "?"} live at the last tick (${t.at}), admission ceiling ${t.ceiling ?? "?"}`
			: "no refill-loop tick recorded",
		`bound by:  ${v ? `${v.limit} — ${v.why}` : `${NONE} — ${buildUnboundText(t)}`}`,
	];
	if (r.also.length > 0)
		lines.push(
			`also:      ${r.also.map((f) => `${f.limit} (${f.why})`).join(", ")}`,
		);
	const largest = t?.memory?.largest;
	if (largest)
		lines.push(`memory:    ${largest.name} holds most (${largest.mb} MB)`);
	const heldRun = r.stale ? readHeldRun() : t?.memory?.heldRunMb;
	if (heldRun)
		lines.push(
			`held run:  ${heldRun} MB held ${r.stale ? "now" : "at the last tick"} for a queued test run the memory rung holds (#5555)`,
		);
	const unlisted = buildUnlistedLine(r, readLive);
	if (unlisted) lines.push(unlisted);
	return lines.join("\n");
}

/** @param {TickRecord|null|undefined} t */
const buildUnboundText = (t) =>
	t && t.live !== null && t.ceiling !== null && t.live >= t.ceiling
		? "the last tick filled the free slots"
		: "a slot is free; the loop launches next tick";

/**
 * @param {ReturnType<typeof buildVerdict>} r
 * @param {() => UnlistedRead} readLive
 */
function buildUnlistedLine(r, readLive) {
	/** @type {[UnlistedRead|null, string]} */
	const [u, when] = r.stale
		? [readLive(), "now"]
		: [r.lastTick?.memory?.unlisted ?? null, "at the last tick"];
	if (!u) return null;
	const why = u.unknown ?? "unread";
	if (u.count === null) return `unlisted:  unknown ${when} — ${why}`;
	if (u.count <= 0) return null;
	const held = u.mb == null ? `? MB ${when} (${why})` : `${u.mb} MB ${when}`;
	return `unlisted:  ${u.count} session(s) outside admission's listing hold ${held}, charged no draw headroom (#2502)`;
}

function concurrencyFiles() {
	return {
		record: refillPath("concurrency.jsonl"),
		minutes: minuteLogPath(),
	};
}

/**
 * @param {string} file
 * @param {string[]} unreadable
 * @returns {Record<string, unknown>[]|null}
 */
function readJsonLines(file, unreadable) {
	try {
		return readJsonl(file)?.rows ?? null;
	} catch (e) {
		unreadable.push(`${file} — ${caught(e).code ?? caught(e).message}`);
		return null;
	}
}

function readTicks() {
	/** @type {string[]} */
	const unreadable = [];
	const ticks = /** @type {TickRecord[]} */ (
		readJsonLines(concurrencyFiles().record, unreadable) ?? []
	);
	return { ticks, unreadable };
}

/** @param {string[]} [unreadable] */
function readMinuteLines(unreadable = []) {
	return /** @type {MinuteLine[]|null} */ (
		readJsonLines(concurrencyFiles().minutes, unreadable)
	);
}

function readRecords() {
	const { ticks, unreadable } = readTicks();
	return { ticks, minutes: readMinuteLines(unreadable), unreadable };
}

/** @returns {TickRecord|null} */
function readNewestTick() {
	try {
		return /** @type {TickRecord|null} */ (
			readLastJsonlRow(concurrencyFiles().record) ?? null
		);
	} catch {
		return null;
	}
}

/** @param {number} now */
function readConcurrencyStatus(now) {
	const newest = readNewestTick();
	const tick =
		newest &&
		now - Date.parse(newest.at) <= STALE_MS &&
		newest.binding?.limit !== LOOP_OFF
			? newest
			: null;
	return {
		live: tick?.live ?? null,
		ceiling: tick?.ceiling ?? null,
		working: tick?.working ?? null,
		waiting: tick?.waiting ?? null,
	};
}

/**
 * @param {TickRecord} record
 * @returns {boolean}
 */
function appendTick(record) {
	return appendRetained(concurrencyFiles().record, record, RETAIN_MS);
}

module.exports = {
	LOOP_OFF,
	NONE,
	STALE_MS,
	SPREAD_CAP,
	appendTick,
	buildBlockText,
	buildTickRecord,
	concurrencyFiles,
	readConcurrencyStatus,
	readMinuteLines,
	readRecords,
	readout,
	buildVerdict,
	readTicks,
	tickLimb,
};
