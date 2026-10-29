/*
 * concurrency.js — the record and readout that answer "why only N sessions?"
 * (#2497, spec #3315).
 *
 * TWO RECORDS, EACH WRITTEN WHERE ITS FACT IS KNOWN. The refill loop appends
 * one line per tick to `concurrency.jsonl` beside its other files
 * (lib/refill-dir.js): the working count, the admission ceiling, the binding
 * limit, every other failing limit, and the memory figures behind them.
 * Sustained concurrency comes from memwatch's minute record instead
 * (docs/environment.md §4, #3214), its `sessions` field, which keeps
 * recording while the loop is off (#3215).
 *
 * TIME-WEIGHTED. A minute line counts until the next one, and a tick's
 * verdict stands until the next tick; a gap past STALE_MS ends either, the
 * recorder or the loop being off. Sustained concurrency averages only the
 * minutes some session works (GLOSSARY.md, Sustained concurrency).
 *
 * THE VERDICT is the first failing limit in a fixed order, the order the
 * checks below run in: loop not running, empty frontier, founder slot,
 * allowance, memory, CPU: gates on the loop and on policy before resource
 * fit, as Kubernetes' PreFilter and Borg's quota check run (#2497's
 * research). Every other failing limit follows it as "also".
 *
 * `readout` and `buildBlockText` are pure; the file functions below them
 * never throw, so a broken record costs a reading, never a tick.
 */

const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");
const { presenceAt } = require("./presence.js");
const { NOTHING_LAUNCHABLE, pickSeat } = require("./refill-decide.js");
const { refillPath } = require("./refill-dir.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/* A verdict older than this reads as the loop not running; untraced (#2497). */
const STALE_MS = 15 * MINUTE_MS;
/* Matched to memwatch's minute record (MEMWATCH_MINUTE_DAYS), so the 7-day
 * review window always has both records. */
const RETAIN_MS = 28 * DAY_MS;
/* The status line's and the morning review's sustained window; untraced
 * (#3315). */
const SUSTAINED_WINDOW = { ms: DAY_MS, span: "24 h" };

const LOOP_OFF = "loop not running";
/* Where no limit fails: a slot is free and the loop launches into it. */
const NONE = "none";
/* The spread's top bucket; a count at or past it shares one. Untraced
 * (#3315). */
const SPREAD_CAP = 10;

/** @typedef {{limit: string, why: string}} Failing */

/**
 * @typedef {object} TickRecord
 * @property {string} at
 * @property {number|null} working admission's working count, the founder's
 *   own session included
 * @property {number|null} ceiling the working count plus admission's slots
 * @property {Failing|null} binding
 * @property {Failing[]} also
 * @property {TickMemory|null} memory
 */
/** @typedef {import("./admission.js").AdmissionJson} AdmissionJson */
/** @typedef {ReturnType<typeof buildTickMemory>} TickMemory */

/** @typedef {{ts: string, sessions: number|null}} MinuteLine */
/** @typedef {{dir: string, count: number}} UnlistedDir */
/** The breakdown's unlisted row; `count` null where it went unread, `unknown`
 * then saying why where known.
 * @typedef {{count: number|null, mb: number|null, unknown?: string|null}} UnlistedRead */

/**
 * The memory component holding most of what admission charges besides the
 * free budget.
 * @param {AdmissionJson} a
 * @returns {{name: string, mb: number}}
 */
function largestHolder(a) {
	/* A malformed verdict costs its rows, never a throw (#3531). */
	const m = a.memory ?? {};
	/** @type {[string, number|null|undefined][]} */
	const holders = [
		["the live sessions' p95 draw", a.drawNeedMb],
		["the earlyoom floor + margin", (a.floorMb ?? 0) + (a.marginMb ?? 0)],
		["the lander's suite reserve", a.landerMb],
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
 * The loop's and policy's failing limits. A stop other than the allowance cut
 * ends the loop at this tick's end. The frontier, the founder's slot and the
 * allowance are judged only where the decision core judged them: a tick with
 * no free slot reads neither.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {import("./refill-decide.js").Decision} decision
 * @returns {Failing[]}
 */
function policyFailing(input, decision) {
	if ("stop" in decision)
		return [
			decision.stop === "allowance"
				? { limit: "allowance", why: decision.detail }
				: { limit: LOOP_OFF, why: `stopping: ${decision.detail}` },
		];
	/** @type {Failing[]} */
	const out = [];
	if (decision.idle === NOTHING_LAUNCHABLE)
		out.push({
			limit: "empty frontier",
			why: "nothing in the frontier is launchable",
		});
	const present =
		presenceAt(input.lastPromptAt, new Date(input.now)) === "present";
	/* Binding only where it is the one free slot: with more, the loop
	 * launches into the rest. */
	if (present && input.freeSlots === 1)
		out.push({
			limit: "founder slot",
			why: "one free slot is kept for the founder",
		});
	const pick = input.freeSlots - (present ? 1 : 0) > 0 ? pickSeat(input) : null;
	if (pick && pick.seat === null)
		out.push({ limit: "allowance", why: pick.wait || "no seat fits" });
	return out;
}

/**
 * Admission's failing limits: memory where it prices no slot, CPU where the
 * load or the session ceiling holds every one.
 * @param {AdmissionJson|null} a null where unread
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
	/* A verdict missing a reading binds on it unknown, as unknown is never
	 * calm (mantahostels#1206). */
	if (
		typeof a.slots !== "number" ||
		typeof a.memorySlots !== "number" ||
		!a.memory
	)
		out.push({
			limit: "memory",
			why: "admission's verdict carried no slot count or breakdown, so its fit is unknown",
		});
	else if (a.memorySlots === 0) {
		const top = largestHolder(a);
		out.push({ limit: "memory", why: `${top.name} holds most (${top.mb} MB)` });
	}
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

/**
 * Every limit failing at this tick, in the verdict's order.
 * @param {Tick} tick
 * @returns {Failing[]}
 */
function failingAt({ input, decision, admission }) {
	return [...policyFailing(input, decision), ...resourceFailing(admission)];
}

/**
 * @typedef {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision,
 *   admission: AdmissionJson|null}} Tick
 */

/**
 * The record line for one tick.
 * @param {Tick} tick
 * @returns {TickRecord}
 */
function buildTickRecord(tick) {
	const { input, admission: a } = tick;
	const [binding = null, ...also] = failingAt(tick);
	const count = a?.memory?.working?.count;
	const working = typeof count === "number" ? count : null;
	return {
		at: new Date(input.now).toISOString(),
		working,
		ceiling:
			working !== null && typeof a?.slots === "number"
				? working + a.slots
				: null,
		binding,
		also,
		memory: a ? buildTickMemory(a) : null,
	};
}

/**
 * The memory figures a tick keeps from admission's verdict.
 * @param {AdmissionJson} a
 */
function buildTickMemory(a) {
	return {
		availableMb: a.availableMb,
		budgetMb: a.budgetMb,
		drawNeedMb: a.drawNeedMb,
		nextNeedMb: a.nextNeedMb,
		reservedMb: a.reservedMb,
		landerMb: a.landerMb,
		floorMb: a.floorMb,
		marginMb: a.marginMb,
		memorySlots: a.memorySlots,
		rows: {
			working: a.memory?.working?.mb ?? null,
			finished: a.memory?.finished?.mb ?? null,
			pool: a.memory?.pool?.mb ?? null,
			other: a.memory?.other?.mb ?? null,
		},
		unlisted: unlistedOf(a.memory?.unlisted),
		largest: largestHolder(a),
	};
}

/**
 * The breakdown's unlisted row as a tick keeps it (#3322); null where the
 * admission read carried none.
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
 * The time-weighted readout over the `windowMs` before `now`.
 * @param {{ticks: TickRecord[], minutes: MinuteLine[]|null, now: number,
 *   windowMs: number, unreadable?: string[]}} input `minutes` null where the
 *   minute record is missing or would not read, so the sustained figure is
 *   unread; `unreadable` names each record that would not read, carried
 *   through for the block to print
 */
function readout({ ticks, minutes, now, windowMs, unreadable = [] }) {
	const from = now - windowMs;
	const timed = ticks
		.map((t) => ({ t, ms: Date.parse(t.at) }))
		.filter(({ ms }) => Number.isFinite(ms) && ms <= now)
		.sort((x, y) => x.ms - y.ms);
	/** The binding limit standing at `ms`. @param {number} ms */
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

	const last = timed.at(-1);
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
 * The sustained figure over `span`, as both the status block and the morning
 * review print it; unread where the minute record did not read, as unknown is
 * never calm (mantahostels#1206).
 * @param {ReturnType<typeof readout>} r
 * @param {string} span
 */
function buildSustainedText(r, span) {
	if (!r.minutesRead)
		return `unread over the last ${span} — memwatch's minute record did not read`;
	return r.sustained === null
		? `no session recorded working over the last ${span}`
		: `${r.sustained.toFixed(1)} over the last ${span} (${r.activeHours.toFixed(1)} h with any session working)`;
}

/**
 * `npm run status`'s concurrency block.
 * @param {ReturnType<typeof readout>} r the 24-hour readout
 * @param {() => UnlistedRead} readLive admission's unlisted row read now
 */
function buildBlockText(r, readLive) {
	const t = r.lastTick;
	const v = r.verdict;
	const lines = [
		...r.unreadable.map((u) => `unreadable: ${u}`),
		t
			? `${t.working ?? "?"} working at the last tick (${t.at}), admission ceiling ${t.ceiling ?? "?"}`
			: "no refill-loop tick recorded",
		`bound by:  ${v ? `${v.limit} — ${v.why}` : `${NONE} — a slot is free; the loop launches next tick`}`,
	];
	if (r.also.length > 0)
		lines.push(
			`also:      ${r.also.map((f) => `${f.limit} (${f.why})`).join(", ")}`,
		);
	const largest = t?.memory?.largest;
	if (largest)
		lines.push(`memory:    ${largest.name} holds most (${largest.mb} MB)`);
	const unlisted = buildUnlistedLine(r, readLive);
	if (unlisted) lines.push(unlisted);
	lines.push(`sustained: ${buildSustainedText(r, SUSTAINED_WINDOW.span)}`);
	return lines.join("\n");
}

/**
 * The unlisted watch's line (#3322), null where nothing is unlisted: whether
 * these sessions owe draw headroom is open (#2502), and this line raises it.
 * It reads the newest tick's row while that tick is fresh, else `readLive()`,
 * as the loop is off unless being tested (#3215, #3496). An unread row prints,
 * as unknown is never calm (mantahostels#1206), and so does the reason a
 * counted row's memory went unread (#3509).
 * @param {ReturnType<typeof readout>} r
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
		sustained: refillPath("concurrency-24h"),
		minutes:
			process.env.MEMWATCH_MINUTE_LOG ||
			path.join(os.homedir(), "memwatch-minute.jsonl"),
	};
}

/**
 * A record's rows, null where it is missing or would not read.
 * @param {string} file
 * @param {string[]} unreadable accumulator: a failed read is named here, so
 *   the block never prints it as an empty record
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

function readRecords() {
	const files = concurrencyFiles();
	/** @type {string[]} */
	const unreadable = [];
	return {
		/* No tick recorded is the loop off, which the verdict names. */
		ticks: /** @type {TickRecord[]} */ (
			readJsonLines(files.record, unreadable) ?? []
		),
		minutes: /** @type {MinuteLine[]|null} */ (
			readJsonLines(files.minutes, unreadable)
		),
		unreadable,
	};
}

/** @param {ReturnType<typeof readout>} r */
function buildSustainedFigure(r) {
	if (!r.minutesRead) return "?";
	return r.sustained === null ? "-" : r.sustained.toFixed(1);
}

/**
 * Write the readout's sustained figure to the precomputed file the status
 * line reads: `-` where no session worked, `?` where the minute record did
 * not read.
 * @param {ReturnType<typeof readout>} r
 */
function writeSustained(r) {
	try {
		writeFileAtomic(
			concurrencyFiles().sustained,
			`${buildSustainedFigure(r)}\n`,
		);
	} catch {
		/* Unwritable: the status line reads a stale figure, never a wrong one. */
	}
}

/**
 * Append the tick's record line and refresh the 24-hour figure.
 * @param {TickRecord} record
 * @returns {boolean} whether the line landed
 */
function appendTick(record) {
	const landed = appendRetained(concurrencyFiles().record, record, RETAIN_MS);
	writeSustained(
		readout({
			...readRecords(),
			now: Date.parse(record.at),
			windowMs: SUSTAINED_WINDOW.ms,
		}),
	);
	return landed;
}

module.exports = {
	NONE,
	SPREAD_CAP,
	SUSTAINED_WINDOW,
	appendTick,
	buildBlockText,
	buildTickRecord,
	concurrencyFiles,
	readRecords,
	readout,
	buildSustainedText,
	writeSustained,
};
