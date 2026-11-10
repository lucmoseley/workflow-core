/*
 * suite-queue-replay.js — what held each queued test run, for a firing of the
 * queue-wait alarm (report-suite-queue-wait.js) to answer by limb (#3060).
 * scripts/replay-suite-queue-wait.js is its command line.
 *
 * THE METHOD is #2909's and #3047's diagnosis: replay the suite gate at
 * TICK_S over the window and label each waiter-tick with the first limb that
 * held it, in the gate's order:
 *   count       a whole waiter while a whole run holds the slot (WHOLE_SUITE_MAX)
 *   memory      memwatch's MemAvailable under suiteRungMb(busy + own workers)
 *   fifo-whole  a whole waiter behind any older waiter
 *   fifo-part   a part waiter behind an older part waiter
 *   admitted    another waiter between its `opened` exit and its spawn
 *   load        memwatch load1 at or over the load ceiling (#830)
 *   open        none of these: the replay cannot say what held it
 * A `tsc` exit is a waiter of its own class, on the type-check slot's gate
 * (lib/tsc-slot.js, #3163), which no suite limb reads:
 *   tsc-count   memwatch's process lines show TSC_MAX `tsc` running
 *   tsc-memory  memwatch's MemAvailable under the rung of the waiter's compiler
 *   tsc-fifo    an older `tsc` waiter, its queue being its own
 * then `admitted`, a suite's admission holding its turn (#3203), `peer-climb`,
 * and `open`:
 *   peer-climb  an older waiter in the other queue stamped `climbHeld`
 *               (`climbStampsAt`)
 * In either class, directly after the memory limb and ahead of the fifos:
 *   climb       MemAvailable clears the rung, but not less the climb the wait's
 *               exit line says held it (#3416, #3806)
 *   windows     memwatch's minute log shows Windows under its floor or
 *               paging hard (`windowsShortfall`), for at most one unbroken
 *               WINDOWS_MAX_HOLD_MS spell (#4850); between #4557's commit and
 *               #4850's, its win_avail_mb under the waiter's draw plus the
 *               margin
 * The fifos, `admitted` and `peer-climb` are the gate's own turn, `turnOf` in
 * lib/suite-queue.js, asked of each tick's waits (#4260).
 * Every later limb holding the same waiter-tick is tallied too, since one
 * cleared may leave the next binding
 * (docs/practice/capacity-planning-and-admission.md).
 * A waiter is an exit line's [at - waitS, at]. Each `opened` or `timeout`
 * exit is matched to its `.test-runs.jsonl` run: same session, spawned from
 * MATCH_BEFORE_S before the exit to MATCH_AFTER_S after it, nearest first.
 * The run's `wholeSlot` and `resolvedFiles` weigh it; a run logged before
 * those fields existed is weighed from its vitest marker's module count and
 * PRE_FIELDS_GATE.
 * An exit line's own `passed` (#3115) is tallied beside the modelled pass, as
 * what the waiters themselves recorded, and so is its `peerS` and a `peer`
 * limb at the bound (#4765) beside the modelled peer-climb limb. The opened part waits the memory limb
 * held at some tick, `tsc` waits left out, are the sample PART_PASS_AGE_MS is
 * derived from (#3361).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { requiredGroup } = require("./regex-group");
const { docPath } = require("./script-path.js");
const { WHOLE_SLOT_FILES, WHOLE_SUITE_WORKERS } = require("./suite-bounded");
const {
	DRAW_MARGIN_MB,
	WHOLE_SUITE_MAX,
	rungMb,
	suiteRungMb,
} = require("./suite-ladder");
const {
	PART_PASS_AGE_MS,
	WINDOWS_MAX_HOLD_MS,
	isClimbKept,
	turnOf,
} = require("./suite-queue");
const { chargeMb } = require("./launch-charge");
const { TSC_MAX, isTscRunner } = require("./tsc-slot");
const {
	isWindowsFresh,
	windowsReadingOf,
	windowsShortfall,
} = require("./windows-memory");

/* #2909's tick; the figures #3047 reports are at it. */
const TICK_S = 10;
/* #3047's match window. */
const MATCH_BEFORE_S = 3;
const MATCH_AFTER_S = 900;
/* A vitest marker whose run is the same as a `.test-runs.jsonl` line where the
 * two start within this of each other: #2909's, chosen, not measured. */
const MARKER_MATCH_S = 3;
/* A marker counting this share of the suite's modules ran the whole of it:
 * #2909's, a guess. */
const WHOLE_SHARE = 0.9;
/* Logs are read this far past each end of the window, so a run spanning an
 * end is seen whole: an hour, past the 840 s suite ceiling (#2726). */
const PAD_MS = 3_600_000;
/* Rows a ranked table prints: a display choice. */
const TOP = 8;
const LIMBS = [
	"count",
	"memory",
	"tsc-count",
	"tsc-memory",
	"climb",
	"windows",
	"fifo-whole",
	"fifo-part",
	"tsc-fifo",
	"admitted",
	"peer-climb",
	"load",
	"open",
];
/* The gate as it stood before a run's `.test-runs.jsonl` line carried
 * `wholeSlot` and `resolvedFiles` (from 25 Oct 2026 10:49 UTC): 3 files made a
 * whole run until #2931 (11:26 UTC that day), and a whole run ran 3 workers
 * until 24 Oct 07:27 UTC. */
const PRE_FIELDS_GATE = {
	wholeFilesUntil: Date.parse("2026-10-25T11:26:00Z"),
	wholeFilesBefore: 3,
	wholeWorkersUntil: Date.parse("2026-10-24T07:27:00Z"),
	wholeWorkersBefore: 3,
};
/* #3058's commit, from which a part waiter passes an older one the memory
 * rung holds. */
const PART_PASS_FROM = Date.parse("2026-10-26T10:39:01Z");
/* #4557's commit, from which the Windows-memory hold holds a launch. */
const WINDOWS_HOLD_FROM = Date.parse("2026-11-09T05:09:20Z");
/* #4850's commit, from which that hold reads Windows' floor and paging in
 * place of each launch's draw. */
const WINDOWS_FLOOR_FROM = Date.parse("2026-11-10T01:48:21Z");
/* #4782's commit, from which a part waiter passes an older one that hold
 * keeps out. */
const WINDOWS_PASS_FROM = Date.parse("2026-11-09T13:33:04Z");
/* #4783's commit, from which a part waiter passes an older one held at rest
 * past PART_PASS_AGE_MS. */
const REST_PASS_FROM = Date.parse("2026-11-09T15:00:37Z");
/* #4760's commit, from which a waiter yields to an older one in the other
 * queue stamped `climbHeld`. */
const PEER_CLIMB_FROM = Date.parse("2026-11-09T08:18:51Z");
/* #4799's commit, from which a wait keeps that stamp while it is charged. */
const CLIMB_KEEP_FROM = Date.parse("2026-11-09T15:36:27Z");
const MEMWATCH_HEADER =
	/^=== (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (\d+)MB used \| cpu: \d+% .*?load ([\d.]+)/;
/* A process line of a memwatch block: `PID RSS COMMAND`, or
 * `PID S %CPU RSS COMMAND`. */
const MEMWATCH_ROW = /^ *(\d+) +(?:[A-Z]+ +[\d.]+ +)?\d+ (.*)$/;

/**
 * @typedef {{ at: string, waitS: number, reason: string, kind: string,
 *   session: string | null, pid: number, slotFree?: boolean,
 *   skipped?: boolean, passed?: number, climbMb?: number,
 *   chargeMb?: number, peerS?: number,
 *   limb?: import("./queue-exit-log.js").HeldLimb }} Exit
 * @typedef {{ st: number, en: number, session: string | null, kind: string,
 *   wholeSlot: boolean | null, resolvedFiles: number | null, verdict: string,
 *   modulesRun: number | null, modulesTotal: number | null }} Run
 * @typedef {{ used: number, load: number, tsc: number }} MemBlock
 * @typedef {{ exits: Exit[], runs: Run[], mem: Map<number, MemBlock>,
 *   windows: Map<number, WindowsMinute>, unread: Unread }} Logs
 * @typedef {import("./windows-memory.js").WindowsMinute} WindowsMinute
 * @typedef {{ since: number, until: number, eras: { label: string, from: number }[],
 *   memTotalMb: number, loadCeiling: number | null }} Window
 */

/**
 * What the reading could not read, printed with it so an all-zero reading off
 * a wrong `--markers` says so (#3060).
 * @typedef {{ absent: string[], unparsed: number }} Unread
 */

/**
 * Each parseable JSON line of `file` that `pre` passes, in file order. A
 * missing file is none and a line that will not parse is skipped, each
 * counted into `unread` (#3060).
 *
 * @param {string} file
 * @param {Unread} unread  accumulator: the absent file and the torn lines
 * @param {(line: string) => boolean} [pre]
 * @returns {any[]}
 */
function readRows(file, unread, pre) {
	const read = readJsonl(file, pre);
	if (!read) {
		unread.absent.push(file);
		return [];
	}
	unread.unparsed += read.bad.length;
	return read.rows;
}

/** @param {string} s */
const isoAt = (s) => {
	const i = s.indexOf('"at":"');
	return i < 0 ? "" : s.slice(i + 6, i + 30);
};

/**
 * The logs the replay reads, cut to what can touch [since, until].
 *
 * @param {{ markers: string, memwatch: string[], minuteLog: string, since: number, until: number }} o
 * @returns {Logs}
 */
function readLogs({ markers, memwatch, minuteLog, since, until }) {
	const lo = new Date(since - PAD_MS).toISOString();
	const hi = new Date(until + PAD_MS).toISOString();
	const inRange = (/** @type {string} */ line) => {
		const at = isoAt(line);
		return lo <= at && at <= hi;
	};
	/** @type {Unread} */
	const unread = { absent: [], unparsed: 0 };
	const exits = readRows(
		path.join(markers, ".suite-queue-exits.jsonl"),
		unread,
	);
	const logged = readRows(
		path.join(markers, ".test-runs.jsonl"),
		unread,
		inRange,
	)
		.filter((d) => d.suite === "vitest")
		.map((d) => ({
			st: Date.parse(d.startedAt),
			en: Date.parse(d.at),
			session: d.session ?? null,
			kind: d.kind,
			wholeSlot: d.wholeSlot ?? null,
			resolvedFiles: d.resolvedFiles ?? null,
			verdict: d.verdict,
			modulesRun: null,
			modulesTotal: null,
		}));
	const runs = logged.some((r) => r.resolvedFiles === null)
		? withModuleCounts(logged, readModuleCounts(markers, unread, inRange))
		: logged;
	const mem = readMemwatch(memwatch, unread);
	const windows = readWindowsMinutes(
		minuteLog,
		unread,
		since - PAD_MS,
		until + PAD_MS,
	);
	return { exits, runs, mem, windows, unread };
}

/**
 * memwatch's minute log's Windows free memory, keyed by minute, from each
 * row in [lo, hi] whose reading the gate would take as fresh.
 *
 * @param {string} file
 * @param {Unread} unread  accumulator: the absent log and the torn lines
 * @param {number} lo
 * @param {number} hi
 */
function readWindowsMinutes(file, unread, lo, hi) {
	/** @type {Map<number, WindowsMinute>} */
	const windows = new Map();
	const inRange = (/** @type {string} */ line) => {
		const t = Date.parse(/"ts":"([^"]+)"/.exec(line)?.[1] ?? "");
		return lo <= t && t <= hi;
	};
	for (const row of readRows(file, unread, inRange)) {
		const reading = windowsReadingOf(row);
		if (reading && isWindowsFresh(reading))
			windows.set(Math.floor(Date.parse(row.ts) / 60_000), reading);
	}
	return windows;
}

/**
 * memwatch's block headers, with the `tsc` its process lines show running,
 * keyed by local minute; the last block in a minute stands for it.
 *
 * @param {string[]} files
 * @param {Unread} unread  accumulator: the absent logs
 */
function readMemwatch(files, unread) {
	/** @type {Map<number, MemBlock>} */
	const mem = new Map();
	for (const file of files) {
		if (fs.existsSync(file))
			parseMemwatch(fs.readFileSync(file, "latin1"), mem);
		else unread.absent.push(file);
	}
	return mem;
}

/**
 * @param {string} text  one memwatch log
 * @param {Map<number, MemBlock>} mem  accumulator: its blocks are added
 */
function parseMemwatch(text, mem) {
	/** @type {MemBlock | null} */
	let block = null;
	/* A block lists its top processes twice, by RSS and by CPU, so a `tsc` is
	 * counted once by its pid. */
	/** @type {Set<number>} */
	const tscPids = new Set();
	for (const line of text.split("\n")) {
		const m = MEMWATCH_HEADER.exec(line);
		if (m) {
			const n = (/** @type {number} */ i) =>
				Number(requiredGroup(m, i, MEMWATCH_HEADER));
			const t = new Date(n(1), n(2) - 1, n(3), n(4), n(5), n(6)).getTime();
			block = { used: n(7), load: n(8), tsc: 0 };
			tscPids.clear();
			mem.set(Math.floor(t / 60_000), block);
			continue;
		}
		const row = MEMWATCH_ROW.exec(line);
		if (!block || !row) continue;
		if (isTscRunner(requiredGroup(row, 2, MEMWATCH_ROW)))
			tscPids.add(Number(requiredGroup(row, 1, MEMWATCH_ROW)));
		block.tsc = tscPids.size;
	}
}

/**
 * Each session's vitest marker starts and module counts, from both stores and
 * their archives.
 *
 * @param {string} markers
 * @param {Unread} unread  accumulator: the absent stores and torn lines
 * @param {(line: string) => boolean} inRange
 */
function readModuleCounts(markers, unread, inRange) {
	/** @type {Map<string, { st: number, run: number | null, total: number | null }[]>} */
	const bySession = new Map();
	const files = ["pass", "fail"].flatMap((store) => [
		`.test-${store}-markers.jsonl`,
		`.test-${store}-markers.archive.jsonl`,
	]);
	for (const file of files)
		for (const d of readRows(path.join(markers, file), unread, inRange)) {
			const list = bySession.get(d.sessionId) ?? [];
			list.push({
				st: Date.parse(d.startedAt),
				run: d.scope?.modulesRun ?? null,
				total: d.scope?.modulesTotal ?? null,
			});
			bySession.set(d.sessionId, list);
		}
	return bySession;
}

/**
 * Each run, those with no `resolvedFiles` given their vitest marker's module
 * counts.
 *
 * @param {Run[]} runs
 * @param {ReturnType<typeof readModuleCounts>} bySession
 * @returns {Run[]}
 */
function withModuleCounts(runs, bySession) {
	return runs.map((r) => {
		if (r.resolvedFiles !== null || r.session === null) return r;
		const list = bySession.get(r.session) ?? [];
		const m =
			list.find((x) => x.st === r.st) ??
			list.find((x) => Math.abs(x.st - r.st) < MARKER_MATCH_S * 1000);
		return m ? { ...r, modulesRun: m.run, modulesTotal: m.total } : r;
	});
}

/**
 * A run's test files: logged, or a marker's module count, where a count of
 * most of the suite stands for the whole of it.
 * @param {Run} r
 */
function filesOf(r) {
	if (r.resolvedFiles !== null) return r.resolvedFiles;
	if (r.modulesRun === null) return null;
	if (r.modulesTotal && r.modulesRun >= WHOLE_SHARE * r.modulesTotal)
		return Number.POSITIVE_INFINITY;
	return r.modulesRun;
}

/** @param {Run} r */
function isWhole(r) {
	if (r.kind === "lander") return true;
	/* The kinds that launch the whole suite unless their files resolve fewer:
	 * the replay's reading of #2909's logs, not a list the gate keeps. */
	const sessionWhole = ["bare", "full", "adopt"].includes(r.kind);
	if (r.wholeSlot !== null) {
		/* A run killed before its files resolved logs `wholeSlot: false`;
		 * #3047's replay counts a killed whole-kind run whole. Residual: a
		 * killed part `changed` run is counted whole too. */
		if (
			r.verdict === "killed" &&
			!r.wholeSlot &&
			r.resolvedFiles === null &&
			(sessionWhole || r.kind === "changed")
		)
			return true;
		return r.wholeSlot;
	}
	if (r.kind === "touched") return false;
	if (sessionWhole) return true;
	const n = filesOf(r);
	if (n === null) return r.kind !== "named";
	const bound =
		r.st < PRE_FIELDS_GATE.wholeFilesUntil
			? PRE_FIELDS_GATE.wholeFilesBefore
			: WHOLE_SLOT_FILES;
	return n === 0 || n >= bound;
}

/**
 * @param {Run} r
 * @param {boolean} whole
 */
function workersOf(r, whole) {
	if (whole)
		return r.st > PRE_FIELDS_GATE.wholeWorkersUntil
			? WHOLE_SUITE_WORKERS
			: PRE_FIELDS_GATE.wholeWorkersBefore;
	return Math.max(1, Math.min(filesOf(r) || 1, WHOLE_SUITE_WORKERS));
}

/** @param {number | null} n */
function sizeOf(n) {
	if (n === null) return "";
	if (n < 6) return ", under 6 files";
	if (n < WHOLE_SLOT_FILES) return `, 6-${WHOLE_SLOT_FILES - 1} files`;
	return `, ${WHOLE_SLOT_FILES}+ files`;
}

/**
 * Who a whole run is, for the count limb's holder table.
 * @param {Run} r
 */
function holderOf(r) {
	if (r.kind !== "lander")
		return `${r.session === null ? "sessionless " : ""}\`${r.kind}\`${sizeOf(filesOf(r))}`;
	return "lander push gate";
}

/** @param {Map<string, number>} m @param {string} k @param {number} v */
const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);

/** @param {Map<string, Map<string, number>>} m @param {string} k @param {string} limb */
const addNested = (m, k, limb) => {
	const inner = m.get(k) ?? new Map();
	add(inner, limb, TICK_S);
	m.set(k, inner);
};

/**
 * The part of a wait inside the window, or null where none is.
 * @param {{ st: number, en: number }} e
 * @param {Window} w
 * @returns {[number, number] | null}
 */
function spanIn(e, w) {
	const a = Math.max(e.st, w.since);
	const b = Math.min(e.en, w.until);
	return b > a ? [a, b] : null;
}

/**
 * Seconds of [a, b) inside [from, to).
 * @param {number} a @param {number} b @param {number} from @param {number} to
 */
const clip = (a, b, from, to) =>
	Math.max(0, Math.min(b, to) - Math.max(a, from)) / 1000;

/**
 * @typedef {Run & { whole: boolean, workers: number }} WeighedRun
 * @typedef {Exit & { st: number, en: number, run: WeighedRun | null,
 *   gap: number, whole: boolean, cls: string, workers: number }} Waiter
 */

/**
 * The nearest unmatched run of `e`'s session spawned from MATCH_BEFORE_S
 * before its exit to MATCH_AFTER_S after it, and seconds from exit to spawn.
 *
 * @param {Exit} e
 * @param {number} en
 * @param {WeighedRun[]} runs
 * @param {Set<WeighedRun>} used  accumulator: the matched run is added
 */
function matchRun(e, en, runs, used) {
	/** @type {{ run: WeighedRun, gap: number } | null} */
	let best = null;
	if (!isMatchable(e)) return best;
	for (const r of runs) {
		if (used.has(r) || r.session !== (e.session ?? null)) continue;
		const g = (r.st - en) / 1000;
		if (
			g >= -MATCH_BEFORE_S &&
			g <= MATCH_AFTER_S &&
			g < (best?.gap ?? Number.POSITIVE_INFINITY)
		)
			best = { run: r, gap: g };
	}
	if (best) used.add(best.run);
	return best;
}

/**
 * Whether `e` launched a suite run the replay can match: an `opened` or
 * `timeout` suite wait, a `tsc` running no suite.
 * @param {Exit} e
 */
const isMatchable = (e) =>
	e.kind !== "tsc" && (e.reason === "opened" || e.reason === "timeout");

/**
 * Whole or part: `slotFree`, then the matched run, then the kind, marked `?`.
 * @param {Exit} e
 * @param {WeighedRun | null} run
 */
function classOf(e, run) {
	if (e.slotFree === true) return { whole: false, sure: true };
	if (run) return { whole: run.whole, sure: true };
	if (e.slotFree === false) return { whole: true, sure: true };
	/* No run matched: the kinds that run whole by default (#2909's guess). */
	const whole = ["bare", "full", "changed", "other"].includes(e.kind);
	return { whole, sure: false };
}

/**
 * The queued waits whose exit was logged by `w.until` and whose wait touches
 * the window, as the alarm counts them, each matched to its run.
 *
 * @param {Exit[]} queued
 * @param {WeighedRun[]} runs
 * @returns {Waiter[]}
 */
function toWaiters(queued, runs) {
	/** @type {Set<WeighedRun>} */
	const used = new Set();
	return queued.map((e) => {
		const en = Date.parse(e.at);
		const match = matchRun(e, en, runs, used);
		const run = match?.run ?? null;
		const { whole, sure } = classOf(e, run);
		const unmatched = whole ? WHOLE_SUITE_WORKERS : 1;
		return {
			...e,
			st: en - e.waitS * 1000,
			en,
			run,
			gap: Math.max(0, match?.gap ?? 0),
			whole,
			cls:
				e.kind === "tsc"
					? "tsc"
					: `${whole ? "whole" : "part"}${sure ? "" : "?"}`,
			workers: run ? run.workers : unmatched,
		};
	});
}

/**
 * @typedef {{ t: number, whole: WeighedRun[], busy: number,
 *   mem: MemBlock | undefined, win: WindowsMinute | undefined, waiting: Waiter[],
 *   admitting: Waiter[], era: string }} GateTick
 * @typedef {GateTick & { climbStamped: Set<Waiter> }} Tick
 */

/**
 * The gate's state at `t`: the whole runs, the busy workers, memwatch's block
 * for that minute, who waits, the era, and the waiters stamped `climbHeld`
 * (`climbStampsAt`), from `stamped`, the last tick's.
 *
 * @param {number} t
 * @param {{ runs: WeighedRun[], waiters: Waiter[], admitting: Waiter[],
 *   mem: Logs["mem"], windows: Logs["windows"], eraOf: (t: number) => string }} s
 * @param {Window} w
 * @param {Set<Waiter>} stamped
 * @returns {Tick}
 */
function tickAt(t, s, w, stamped) {
	const live = s.runs.filter((r) => r.st <= t && t < r.en);
	/** @type {GateTick} */
	const tick = {
		t,
		whole: live.filter((r) => r.whole),
		busy: live.reduce((n, r) => n + r.workers, 0),
		mem: s.mem.get(Math.floor(t / 60_000)),
		win: s.windows.get(Math.floor(t / 60_000)),
		waiting: s.waiters.filter((e) => e.st <= t && t < e.en),
		admitting: s.admitting,
		era: s.eraOf(t),
	};
	return { ...tick, climbStamped: climbStampsAt(tick, w, stamped) };
}

/**
 * The waiters `tick` stamps `climbHeld`, as `waitForGate` does: of those the
 * count limb, read first, leaves to the rest, each the climb limb holds, and
 * from #4799's commit each `stamped` on the last tick that `isClimbKept` in
 * lib/suite-queue.js keeps.
 *
 * @param {GateTick} tick
 * @param {Window} w
 * @param {Set<Waiter>} stamped
 * @returns {Set<Waiter>}
 */
function climbStampsAt(tick, w, stamped) {
	/** @param {Waiter} e */
	const limbOf = (e) => {
		if (isMemoryHeld(e, tick, w)) return "memory";
		return isWindowsHeld(e, tick) ? "windows" : undefined;
	};
	/* The other queue's launches alone charge a wait (`readPeerClimbMb`). */
	const isCharged = (/** @type {Waiter} */ e) =>
		e.kind === "tsc" ? tick.busy > 0 : (tick.mem?.tsc ?? 0) > 0;
	const isKept = (/** @type {Waiter} */ e) =>
		tick.t >= CLIMB_KEEP_FROM &&
		stamped.has(e) &&
		isClimbKept(limbOf(e), isCharged(e));
	return new Set(
		tick.waiting.filter(
			(e) => !isCountHeld(e, tick) && (isClimbHeld(e, tick, w) || isKept(e)),
		),
	);
}

function buildTallies() {
	/** @type {() => Map<string, number>} */
	const flat = () => new Map();
	/** @type {() => Map<string, Map<string, number>>} */
	const nested = () => new Map();
	return {
		limb: flat(),
		limbClass: flat(),
		limbAlso: flat(),
		limbSession: nested(),
		limbEra: nested(),
		holder: flat(),
		holderSession: flat(),
		slotBusy: 0,
		landerSlot: 0,
		/** @type {Set<number>} */
		memMinutes: new Set(),
		/** @type {Set<Waiter>} */
		memoryHeldPart: new Set(),
	};
}

/**
 * @param {Tick} tick
 * @param {Window} w
 * @param {ReturnType<typeof buildTallies>} acc  accumulator: the tick is added
 */
function tallyTick(tick, w, acc) {
	if (tick.whole.length >= WHOLE_SUITE_MAX) acc.slotBusy += TICK_S;
	if (tick.whole.some((r) => r.kind === "lander")) acc.landerSlot += TICK_S;
	if (tick.mem) acc.memMinutes.add(Math.floor(tick.t / 60_000));
	for (const e of tick.waiting) {
		const [first = "open", ...also] = limbsOf(e, tick, w);
		for (const a of also) add(acc.limbAlso, `${first} / ${a}`, TICK_S);
		add(acc.limb, first, TICK_S);
		if (!e.whole && e.kind !== "tsc" && isRungHeld(e, tick, w))
			acc.memoryHeldPart.add(e);
		add(acc.limbClass, `${first} / ${e.cls}`, TICK_S);
		addNested(acc.limbSession, e.session ?? "(no session)", first);
		addNested(acc.limbEra, tick.era, first);
		if (first === "count") shareSlot(tick.whole, acc.holder, acc.holderSession);
	}
}

/**
 * The count limb: `TSC_MAX` `tsc` running for a `tsc` waiter, a whole run in
 * the slot for a whole one.
 * @param {Waiter} e
 * @param {GateTick} tick
 */
const isCountHeld = (e, tick) =>
	e.kind === "tsc"
		? (tick.mem?.tsc ?? 0) >= TSC_MAX
		: e.whole && tick.whole.length >= WHOLE_SUITE_MAX;

/**
 * @param {Waiter} e
 * @param {GateTick} tick
 * @param {Window} w
 */
function isMemoryHeld(e, tick, w) {
	return (
		tick.mem !== undefined && w.memTotalMb - tick.mem.used < rungOf(e, tick)
	);
}

/**
 * @param {Waiter} e
 * @param {GateTick} tick
 */
const rungOf = (e, tick) =>
	e.kind === "tsc"
		? rungMb(tscChargeOf(e))
		: suiteRungMb(tick.busy + e.workers);

/**
 * The peak a type-check waiter is charged: its exit line's, that of the
 * compiler it ran; on a line from before #4892, whose type-checks all ran on
 * TypeScript 5, 5's. Residual: a killed line from #4892 to #4921 carries no
 * charge, and a 7 waiter's is read as 5's.
 * @param {Waiter} e
 */
const tscChargeOf = (e) => e.chargeMb ?? chargeMb({ kind: "tsc", major: 5 });

/**
 * @param {Waiter} e
 * @param {GateTick} tick
 * @param {Window} w
 */
function isClimbHeld(e, tick, w) {
	if (!e.climbMb || tick.mem === undefined) return false;
	const available = w.memTotalMb - tick.mem.used;
	const rung = rungOf(e, tick);
	return available >= rung && available - e.climbMb < rung;
}

/* When each waiter's current spell of the Windows-memory hold began, for
 * #4850's maximum hold. Ticks reach a waiter in time order. */
/** @type {WeakMap<Waiter, number>} */
const windowsSpell = new WeakMap();

/**
 * The Windows-memory hold: from #4850, Windows under its floor or paging
 * hard, until one unbroken spell has held `e` for WINDOWS_MAX_HOLD_MS; from
 * #4557 until then, Windows' free memory under what `e` would draw, its own
 * workers' share of the rung or a `tsc`'s peak, plus the margin.
 * @param {Waiter} e
 * @param {GateTick} tick
 */
function isWindowsHeld(e, tick) {
	if (tick.win === undefined || tick.t < WINDOWS_HOLD_FROM) return false;
	if (tick.t >= WINDOWS_FLOOR_FROM) {
		if (windowsShortfall(tick.win) === null) {
			windowsSpell.delete(e);
			return false;
		}
		const since = windowsSpell.get(e) ?? tick.t;
		windowsSpell.set(e, since);
		return tick.t - since < WINDOWS_MAX_HOLD_MS;
	}
	const drawMb =
		e.kind === "tsc"
			? tscChargeOf(e)
			: rungOf(e, tick) - suiteRungMb(tick.busy);
	return tick.win.mb < drawMb + DRAW_MARGIN_MB;
}

/**
 * What stamps a marker `memoryHeld`.
 * @param {Waiter} e
 * @param {Tick} tick
 * @param {Window} w
 */
const isRungHeld = (e, tick, w) =>
	isMemoryHeld(e, tick, w) || isClimbHeld(e, tick, w);

/**
 * The gate's own turn for `e` at this tick (`turnOf`, #4260), from a snapshot
 * of the waits the logs show: the older waiters in its queue, none yet
 * spawned, each stamped `memoryHeld` where its rung holds it, `restHeld`
 * where its memory rung does at a tick no test worker runs, else
 * `windowsHeld` where the Windows hold does; another waiter between its
 * `opened` exit and its spawn; and an older waiter in the other queue the
 * tick stamps `climbHeld`. #3058's pass is on from its commit, the Windows
 * stamp from #4782's, and the rest stamp from #4783's.
 * @param {Waiter} e
 * @param {Tick} tick
 * @param {Window} w
 */
function turnReasonsOf(e, tick, w) {
	const tsc = e.kind === "tsc";
	/* Each queue's turn reads its own directory alone (#3163). */
	const ahead = tick.waiting
		.filter((o) => o !== e && o.st < e.st && (o.kind === "tsc") === tsc)
		.map((o) => ({
			at: o.st,
			part: !tsc && !o.whole,
			spawned: false,
			memoryHeld: isRungHeld(o, tick, w),
			restHeld:
				tick.t >= REST_PASS_FROM &&
				tick.busy === 0 &&
				!o.climbMb &&
				isMemoryHeld(o, tick, w),
			windowsHeld:
				tick.t >= WINDOWS_PASS_FROM &&
				!isRungHeld(o, tick, w) &&
				isWindowsHeld(o, tick),
		}));
	const suite = e.whole ? "whole" : "part";
	const peerClimbHeld =
		tick.t >= PEER_CLIMB_FROM &&
		tick.waiting.some(
			(o) =>
				o.st < e.st && (o.kind === "tsc") !== tsc && tick.climbStamped.has(o),
		);
	const admissionOpen = tick.admitting.some(
		(o) => o.pid !== e.pid && o.en <= tick.t && tick.t < o.en + o.gap * 1000,
	);
	return turnOf(
		{
			waiter: tsc ? "tsc" : suite,
			ahead,
			admissionOpen,
			peerClimbHeld,
			slots: WHOLE_SUITE_MAX,
			now: tick.t,
		},
		{ partPass: tick.t >= PART_PASS_FROM },
	).reasons;
}

/**
 * Every limb that holds `e` at this tick, in the gate's order; `open` where
 * none does.
 * @param {Waiter} e
 * @param {Tick} tick
 * @param {Window} w
 */
function limbsOf(e, tick, w) {
	const memory = isMemoryHeld(e, tick, w);
	const climb = isClimbHeld(e, tick, w);
	const windows = isWindowsHeld(e, tick);
	/** @type {Record<string, boolean>} */
	const held =
		e.kind === "tsc"
			? {
					"tsc-count": isCountHeld(e, tick),
					"tsc-memory": memory,
					climb,
					windows,
				}
			: {
					count: isCountHeld(e, tick),
					memory,
					climb,
					windows,
					load:
						w.loadCeiling !== null && (tick.mem?.load ?? 0) >= w.loadCeiling,
				};
	for (const reason of turnReasonsOf(e, tick, w)) held[reason] = true;
	const limbs = LIMBS.filter((l) => held[l]);
	return limbs.length > 0 ? limbs : ["open"];
}

/**
 * Share a count-held tick between the whole runs holding the slot, by who
 * they are and by launching session.
 *
 * @param {WeighedRun[]} whole
 * @param {Map<string, number>} holder  accumulator: the tick's share by holder
 * @param {Map<string, number>} holderSession  accumulator: by session
 */
function shareSlot(whole, holder, holderSession) {
	for (const r of whole) {
		add(holder, holderOf(r), TICK_S / whole.length);
		const session = r.kind === "lander" ? "lander" : r.session;
		add(holderSession, session ?? "(no session)", TICK_S / whole.length);
	}
}

/**
 * The eras, the window's start opening the first where it falls before them.
 * @param {Window} w
 */
function erasOf(w) {
	const eras = [...w.eras].sort((a, b) => a.from - b.from);
	if ((eras[0]?.from ?? w.since) > w.since)
		eras.unshift({ label: "window start", from: w.since });
	return eras;
}

/**
 * Per session: the waits summed, and their union, the gap being waits one
 * session ran side by side.
 *
 * @param {Waiter[]} waiters
 * @param {Window} w
 * @param {Map<string, Map<string, number>>} limbSession
 */
function sessionSums(waiters, w, limbSession) {
	/** @type {Map<string, [number, number][]>} */
	const spans = new Map();
	for (const e of waiters) {
		const span = spanIn(e, w);
		if (!span) continue;
		const s = e.session ?? "(no session)";
		spans.set(s, [...(spans.get(s) ?? []), span]);
	}
	return [...spans].map(([session, iv]) => {
		const sum = iv.reduce((s, [a, b]) => s + b - a, 0) / 1000;
		iv.sort((x, y) => x[0] - y[0]);
		let union = 0;
		let reach = Number.NEGATIVE_INFINITY;
		for (const [a, b] of iv) {
			union += Math.max(0, b - Math.max(a, reach)) / 1000;
			reach = Math.max(reach, b);
		}
		const limbs = limbSession.get(session) ?? new Map();
		return { session, waits: iv.length, sum, union, limbs };
	});
}

/**
 * @param {Waiter[]} waiters
 * @param {Window} w
 */
function peakOf(waiters, w) {
	/** @type {[number, number][]} */
	const edges = [];
	for (const e of waiters) {
		const span = spanIn(e, w);
		if (span) edges.push([span[0], 1], [span[1], -1]);
	}
	edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	let level = 0;
	let peak = { n: 0, at: w.since };
	for (const [t, d] of edges) {
		level += d;
		if (level > peak.n) peak = { n: level, at: t };
	}
	return peak;
}

/**
 * The replay over `w`. Every figure is in seconds.
 *
 * @param {Logs} logs
 * @param {Window} w
 */
function replay(logs, w) {
	const touching = logs.exits.filter((e) => {
		const en = Date.parse(e.at);
		return en <= w.until && en >= w.since && en - e.waitS * 1000 < w.until;
	});
	const runs = logs.runs.map((r) => {
		const whole = isWhole(r);
		return { ...r, whole, workers: workersOf(r, whole) };
	});
	const waiters = toWaiters(
		touching.filter((e) => e.skipped !== true),
		runs,
	);
	const admitting = waiters.filter((e) => e.gap > 0);
	const eras = erasOf(w);
	const eraOf = (/** @type {number} */ t) =>
		eras.findLast((e) => t >= e.from)?.label ?? "";

	const acc = buildTallies();
	const state = {
		runs,
		waiters,
		admitting,
		mem: logs.mem,
		windows: logs.windows,
		eraOf,
	};
	/** @type {Set<Waiter>} */
	let stamped = new Set();
	for (let t = w.since; t < w.until; t += TICK_S * 1000) {
		const tick = tickAt(t, state, w, stamped);
		stamped = tick.climbStamped;
		tallyTick(tick, w, acc);
	}
	const eraWait = eras.map((era, i) => {
		const to = eras[i + 1]?.from ?? w.until;
		const from = Math.max(era.from, w.since);
		return {
			label: era.label,
			spanS: (to - from) / 1000,
			waitS: waiters.reduce((s, e) => s + clip(e.st, e.en, from, to), 0),
		};
	});
	const matchable = waiters.filter(isMatchable);
	const counts = waiters.flatMap((e) =>
		e.passed === undefined ? [] : [e.passed],
	);
	const passing = counts.filter((n) => n > 0);
	return {
		peers: recordedPeers(waiters),
		exits: touching.length,
		skipped: touching.length - waiters.length,
		queued: waiters.length,
		waitS: waiters.reduce((s, e) => s + clip(e.st, e.en, w.since, w.until), 0),
		matched: waiters.filter((e) => e.run).length,
		matchable: matchable.length,
		passes: {
			counted: counts.length,
			passing: passing.length,
			passed: passing.reduce((s, n) => s + n, 0),
		},
		limb: acc.limb,
		limbClass: acc.limbClass,
		limbAlso: acc.limbAlso,
		limbEra: acc.limbEra,
		eraWait,
		slotBusy: acc.slotBusy,
		landerSlot: acc.landerSlot,
		holder: acc.holder,
		holderSession: acc.holderSession,
		sessions: sessionSums(waiters, w, acc.limbSession),
		peak: peakOf(waiters, w),
		gaps: waiters
			.filter((e) => e.run)
			.map((e) => e.gap)
			.sort((a, b) => a - b),
		memoryHeldPart: [...acc.memoryHeldPart]
			.filter((e) => e.reason === "opened" && e.waitS > 0)
			.map((e) => e.waitS)
			.sort((a, b) => a - b),
		unread: logs.unread,
		memMinutes: acc.memMinutes.size,
		minutes: Math.ceil((w.until - w.since) / 60_000),
	};
}

/**
 * What the waits' own exit lines record of the `peer` limb (#4765), `tsc`
 * waits and suite waits apart: the waits it held, their seconds on it, and
 * those it still held at the queue's wait bound. Absent from every line before #4765.
 *
 * @param {Waiter[]} waiters
 */
function recordedPeers(waiters) {
	/** @param {Waiter[]} ws */
	const sum = (ws) => ({
		held: ws.filter((e) => (e.peerS ?? 0) > 0).length,
		heldS: ws.reduce((n, e) => n + (e.peerS ?? 0), 0),
		atBound: ws.filter((e) => e.limb === "peer").length,
	});
	return {
		tsc: sum(waiters.filter((e) => e.kind === "tsc")),
		suite: sum(waiters.filter((e) => e.kind !== "tsc")),
	};
}

/** @param {number} s */
const hours = (s) => (s / 3600).toFixed(2);

/**
 * #3047's quantile rule.
 * @param {number[]} sorted
 * @param {number} p
 */
const quantileOf = (sorted, p) =>
	sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

/** @param {Map<string, number>} m */
const byValue = (m) => [...m].sort((a, b) => b[1] - a[1]);

/**
 * The reading, as markdown a diagnosis comment can quote.
 *
 * @param {ReturnType<typeof replay>} r
 * @param {Window} w
 */
function render(r, w) {
	const total = [...r.limb.values()].reduce((s, v) => s + v, 0);
	const held = r.memoryHeldPart;
	const lines = [
		`# Suite queue wait replay, ${new Date(w.since).toISOString()} to ${new Date(w.until).toISOString()}`,
		"",
		`${r.queued} queued waits (${r.exits} exits less ${r.skipped} skipped), ${hours(r.waitS)} h inside the window. ${r.matched} of ${r.matchable} opened or timed-out suite waits matched to their run. At most ${r.peak.n} waited at once, at ${new Date(r.peak.at).toISOString()}.`,
		"",
		"## Limb",
		"",
		"| Limb | Hours |",
		"| --- | --- |",
		...LIMBS.filter((l) => r.limb.has(l)).map(
			(l) => `| ${l} | ${hours(r.limb.get(l) ?? 0)} |`,
		),
		`| total | ${hours(total)} |`,
		"",
		"By waiter class (`?`: no run matched, classed by kind):",
		"",
		...byValue(r.limbClass).map(([k, v]) => `- ${k}: ${hours(v)} h`),
		"",
		"Held by a later limb as well, which clearing the first would leave binding (first / also):",
		"",
		...byValue(r.limbAlso).map(([k, v]) => `- ${k}: ${hours(v)} h`),
		"",
		r.passes.counted > 0
			? `Recorded passes: ${r.passes.passing} of the ${r.passes.counted} waits whose exit line counts its passes opened their turn past ${r.passes.passed} older part waiter(s) the memory rung held (#3115).`
			: "Recorded passes: no exit line in the window counts its passes (none logged before #3115 does); the fifo-part limb above is the replay's model alone.",
		"",
		.../** @type {const} */ (["tsc", "suite"]).map((k) => {
			const p = r.peers[k];
			return `Recorded peer holds, ${k} waits: ${p.held} held on an older waiter in the other queue the climb charge holds, ${hours(p.heldS)} h, ${p.atBound} still held at the queue's wait bound (#4765).`;
		}),
		"",
		`Memory-held part waits, the sample PART_PASS_AGE_MS is derived from (#3361): ${held.length} opened part waits the memory limb held at some tick, wait p50 ${quantileOf(held, 0.5)} s, p90 ${quantileOf(held, 0.9)} s, max ${held.at(-1) ?? 0} s, against a bound of ${PART_PASS_AGE_MS / 1000} s now.`,
		"",
		"## Whole slot",
		"",
		`Busy ${hours(r.slotBusy)} h of the window; a lander whole run held it ${hours(r.landerSlot)} h. Who held it while the count limb held a waiter, each tick shared between the whole runs on it:`,
		"",
		"| Holder | Count-hold share (h) |",
		"| --- | --- |",
		...byValue(r.holder).map(([k, v]) => `| ${k} | ${hours(v)} |`),
		"",
		"By launching session:",
		"",
		...byValue(r.holderSession)
			.slice(0, TOP)
			.map(([k, v]) => `- \`${k}\`: ${hours(v)} h`),
	];
	if (r.eraWait.length > 0)
		lines.push(
			"",
			"## Era",
			"",
			`| Era | Span (h) | Wait (h) | ${LIMBS.join(" | ")} |`,
			`| --- | --- | --- | ${LIMBS.map(() => "---").join(" | ")} |`,
			...r.eraWait.map((e) => {
				const m = r.limbEra.get(e.label) ?? new Map();
				return `| ${e.label} | ${hours(e.spanS)} | ${hours(e.waitS)} | ${LIMBS.map((l) => (m.has(l) ? hours(m.get(l) ?? 0) : "—")).join(" | ")} |`;
			}),
		);
	const bySum = [...r.sessions].sort((a, b) => b.sum - a.sum).slice(0, TOP);
	const sum = r.sessions.reduce((s, x) => s + x.sum, 0);
	const union = r.sessions.reduce((s, x) => s + x.union, 0);
	lines.push(
		"",
		"## Sessions",
		"",
		`Summed ${hours(sum)} h, union ${hours(union)} h: ${hours(sum - union)} h is one session's waits running side by side.`,
		"",
		"| Session | Waits | Sum (h) | Union (h) | Limbs (h) |",
		"| --- | --- | --- | --- | --- |",
		...bySum.map(
			(s) =>
				`| \`${s.session}\` | ${s.waits} | ${hours(s.sum)} | ${hours(s.union)} | ${byValue(
					s.limbs,
				)
					.map(([k, v]) => `${k} ${hours(v)}`)
					.join(", ")} |`,
		),
		"",
		`Exit to spawn, ${r.gaps.length} matched waits: median ${quantileOf(r.gaps, 0.5).toFixed(1)} s, p90 ${quantileOf(r.gaps, 0.9).toFixed(1)} s, max ${(r.gaps.at(-1) ?? 0).toFixed(1)} s.`,
		"",
		"## Limits",
		"",
		`- The memory limb is a lower bound: memwatch wrote a block in ${r.memMinutes} of the window's ${r.minutes} minutes, only above its used-memory or CPU threshold (${docPath("environment.md")} §4), and a minute with none counts as memory open.`,
		"- The climb limb tries each tick against the highest charge the wait's exit line recorded, so it can overstate a wait whose charge fell. A minute with no memwatch block counts as climb open.",
		"- The peer-climb limb reads the `climbHeld` stamp off the climb limb, and keeps it while a launch of the other queue runs (from #4799's commit); it inherits the climb limb's overstatement.",
		"- The windows limb is a lower bound too: it charges a waiter no climb, and a minute with no fresh Windows reading in memwatch's minute log counts as open.",
		"- The tsc-count limb is a lower bound too: it reads a `tsc` off memwatch's process lines, which list the top few by RSS and by CPU and cut each command short.",
		"- tsc-count reads a `tsc` as lib/tsc-slot.js does since 27 Oct 2026 15:26 UTC (#3276); before then the gate also counted a queued `--tsc` waiter, so a wait it held then reads here as open or tsc-fifo.",
		"- A `tsc` admission is matched to no run, so it holds no `admitted` limb, neither a younger `tsc` waiter's nor a suite waiter's (#3203).",
		"- The lander's own queue wait is not in the exits log; its runs count here only as slot holders and busy workers.",
		...(r.unread.absent.length > 0
			? [
					`- Not found, so read as empty: ${r.unread.absent.map((f) => `\`${f}\``).join(", ")}.`,
				]
			: []),
		...(r.unread.unparsed > 0
			? [
					`- ${r.unread.unparsed} log line(s) would not parse and are not counted.`,
				]
			: []),
		`- Each run is charged its workers, not its memory; MemTotal is taken as ${w.memTotalMb} MB.`,
	);
	return lines.join("\n");
}

module.exports = { readLogs, replay, render };
