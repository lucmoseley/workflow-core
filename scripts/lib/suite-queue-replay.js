/*
 * suite-queue-replay.js — what held each queued test run, for a firing of the
 * queue-wait alarm (report-suite-queue-wait.js) to answer by limb (workflow-core#3060).
 * scripts/replay-suite-queue-wait.js is its command line.
 *
 * THE METHOD is workflow-core#2909's and workflow-core#3047's diagnosis: replay the suite gate at
 * TICK_S over the window and label each waiter-tick with the first limb that
 * held it, in the gate's order:
 *   count       a whole waiter while a whole run holds the slot (WHOLE_SUITE_MAX)
 *   memory      memwatch's MemAvailable under suiteRungMb(busy + own workers)
 *   fifo-whole  a whole waiter behind any older waiter
 *   fifo-part   a part waiter behind an older part waiter
 *   admitted    another waiter between its `opened` exit and its spawn
 *   load        memwatch load1 at or over the load ceiling (workflow-core#830)
 *   open        none of these: the replay cannot say what held it
 * Every later limb holding the same waiter-tick is tallied too, since one
 * cleared may leave the next binding
 * (docs/practice/capacity-planning-and-admission.md).
 * A waiter is an exit line's [at - waitS, at]. Each `opened` or `timeout`
 * exit is matched to its `.test-runs.jsonl` run: same session, spawned from
 * MATCH_BEFORE_S before the exit to MATCH_AFTER_S after it, nearest first.
 * The run's `wholeSlot` and `resolvedFiles` weigh it; a run logged before
 * those fields existed is weighed from its vitest marker's module count and
 * PRE_FIELDS_GATE.
 * An exit line's own `passed` (workflow-core#3115) is tallied beside the modelled pass, as
 * what the waiters themselves recorded.
 */

const fs = require("node:fs");
const path = require("node:path");
const { requiredGroup } = require("./regex-group");
const { docPath } = require("./script-path.js");
const { WHOLE_SLOT_FILES, WHOLE_SUITE_WORKERS } = require("./suite-bounded");
const { WHOLE_SUITE_MAX, suiteRungMb } = require("./suite-ladder");
const { PART_PASS_AGE_MS } = require("./suite-queue");

/* workflow-core#2909's tick; the figures workflow-core#3047 reports are at it. */
const TICK_S = 10;
/* workflow-core#3047's match window. */
const MATCH_BEFORE_S = 3;
const MATCH_AFTER_S = 900;
/* A vitest marker whose run is the same as a `.test-runs.jsonl` line where the
 * two start within this of each other: workflow-core#2909's, chosen, not measured. */
const MARKER_MATCH_S = 3;
/* A lander whole run is its parent confirm where the lander logged one for
 * the same sha this long before it spawned: workflow-core#3047's, a guess that covers the
 * one whole-suite rerun a confirm runs. */
const PARENT_CONFIRM_S = 1800;
/* A marker counting this share of the suite's modules ran the whole of it:
 * workflow-core#2909's, a guess. */
const WHOLE_SHARE = 0.9;
/* Logs are read this far past each end of the window, so a run spanning an
 * end is seen whole: an hour, past the 840 s suite ceiling (workflow-core#2726). */
const PAD_MS = 3_600_000;
/* Rows a ranked table prints: a display choice. */
const TOP = 8;
const LIMBS = [
	"count",
	"memory",
	"fifo-whole",
	"fifo-part",
	"admitted",
	"load",
	"open",
];
/* The gate as it stood before a run's `.test-runs.jsonl` line carried
 * `wholeSlot` and `resolvedFiles` (from 25 Oct 2026 10:49 UTC): 3 files made a
 * whole run until workflow-core#2931 (11:26 UTC that day), and a whole run ran 3 workers
 * until 24 Oct 07:27 UTC. */
const PRE_FIELDS_GATE = {
	wholeFilesUntil: Date.parse("2026-10-25T11:26:00Z"),
	wholeFilesBefore: 3,
	wholeWorkersUntil: Date.parse("2026-10-24T07:27:00Z"),
	wholeWorkersBefore: 3,
};
/* workflow-core#3058's commit, from which a part waiter passes an older one the memory
 * rung holds. */
const PART_PASS_FROM = Date.parse("2026-10-26T10:39:01Z");
const PARENT_LINE = /^(\S+) rerun ([0-9a-f]{9})\S* \(parent\): the whole suite/;
const MEMWATCH_HEADER =
	/^=== (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (\d+)MB used \| cpu: \d+% .*?load ([\d.]+)/;

/**
 * @typedef {{ at: string, waitS: number, reason: string, kind: string,
 *   session: string | null, pid: number, slotFree?: boolean,
 *   skipped?: boolean, passed?: number }} Exit
 * @typedef {{ st: number, en: number, session: string | null, kind: string,
 *   wholeSlot: boolean | null, resolvedFiles: number | null, verdict: string,
 *   sha: string, modulesRun: number | null, modulesTotal: number | null }} Run
 * @typedef {{ used: number, load: number }} MemBlock
 * @typedef {{ exits: Exit[], runs: Run[], mem: Map<number, MemBlock>,
 *   parents: { t: number, sha: string }[], unread: Unread }} Logs
 * @typedef {{ since: number, until: number, eras: { label: string, from: number }[],
 *   memTotalMb: number, loadCeiling: number | null }} Window
 */

/**
 * What the reading could not read, printed with it so an all-zero reading off
 * a wrong `--markers` says so (workflow-core#3060).
 * @typedef {{ absent: string[], unparsed: number }} Unread
 */

/**
 * Each parseable JSON line of `file` that `pre` passes, in file order. A
 * missing file is none and a line that will not parse is skipped, each
 * counted into `unread` (workflow-core#3060).
 *
 * @param {string} file
 * @param {Unread} unread  accumulator: the absent file and the torn lines
 * @param {(line: string) => boolean} pre
 * @returns {any[]}
 */
function readJsonl(file, unread, pre = () => true) {
	if (!fs.existsSync(file)) {
		unread.absent.push(file);
		return [];
	}
	const rows = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim() || !pre(line)) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			unread.unparsed++;
		}
	}
	return rows;
}

/** @param {string} s */
const isoAt = (s) => {
	const i = s.indexOf('"at":"');
	return i < 0 ? "" : s.slice(i + 6, i + 30);
};

/**
 * The logs the replay reads, cut to what can touch [since, until].
 *
 * @param {{ markers: string, memwatch: string[], since: number, until: number }} o
 * @returns {Logs}
 */
function readLogs({ markers, memwatch, since, until }) {
	const lo = new Date(since - PAD_MS).toISOString();
	const hi = new Date(until + PAD_MS).toISOString();
	const inRange = (/** @type {string} */ line) => {
		const at = isoAt(line);
		return lo <= at && at <= hi;
	};
	/** @type {Unread} */
	const unread = { absent: [], unparsed: 0 };
	const exits = readJsonl(
		path.join(markers, ".suite-queue-exits.jsonl"),
		unread,
	);
	const logged = readJsonl(
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
			sha: String(d.sha ?? "").slice(0, 9),
			modulesRun: null,
			modulesTotal: null,
		}));
	const runs = logged.some((r) => r.resolvedFiles === null)
		? withModuleCounts(logged, readModuleCounts(markers, unread, inRange))
		: logged;
	const mem = readMemwatch(memwatch, unread);
	const parents = readParents(path.join(markers, ".lander.log"), unread);
	return { exits, runs, mem, parents, unread };
}

/**
 * memwatch's block headers, keyed by local minute; the last block in a minute
 * stands for it.
 *
 * @param {string[]} files
 * @param {Unread} unread  accumulator: the absent logs
 */
function readMemwatch(files, unread) {
	/** @type {Map<number, MemBlock>} */
	const mem = new Map();
	for (const file of files) {
		if (!fs.existsSync(file)) {
			unread.absent.push(file);
			continue;
		}
		for (const line of fs.readFileSync(file, "latin1").split("\n")) {
			const m = MEMWATCH_HEADER.exec(line);
			if (!m) continue;
			const n = (/** @type {number} */ i) =>
				Number(requiredGroup(m, i, MEMWATCH_HEADER));
			const t = new Date(n(1), n(2) - 1, n(3), n(4), n(5), n(6)).getTime();
			mem.set(Math.floor(t / 60_000), { used: n(7), load: n(8) });
		}
	}
	return mem;
}

/**
 * The lander's whole-suite parent confirms: when, and the sha confirmed.
 *
 * @param {string} file
 * @param {Unread} unread  accumulator: the log, where absent
 */
function readParents(file, unread) {
	if (!fs.existsSync(file)) {
		unread.absent.push(file);
		return [];
	}
	const parents = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = PARENT_LINE.exec(line);
		if (m)
			parents.push({
				t: Date.parse(requiredGroup(m, 1, PARENT_LINE)),
				sha: requiredGroup(m, 2, PARENT_LINE),
			});
	}
	return parents;
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
		for (const d of readJsonl(path.join(markers, file), unread, inRange)) {
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
	 * the replay's reading of workflow-core#2909's logs, not a list the gate keeps. */
	const sessionWhole = ["bare", "full", "adopt"].includes(r.kind);
	if (r.wholeSlot !== null) {
		/* A run killed before its files resolved logs `wholeSlot: false`;
		 * workflow-core#3047's replay counts a killed whole-kind run whole. Residual: a
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
 * @param {Logs["parents"]} parents
 */
function holderOf(r, parents) {
	if (r.kind !== "lander")
		return `${r.session === null ? "sessionless " : ""}\`${r.kind}\`${sizeOf(filesOf(r))}`;
	const confirm = parents.some(
		(p) =>
			p.sha === r.sha &&
			r.st - p.t >= 0 &&
			r.st - p.t < PARENT_CONFIRM_S * 1000,
	);
	return confirm ? "lander parent confirm" : "lander push gate";
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
	if (e.reason !== "opened" && e.reason !== "timeout") return best;
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
 * Whole or part: `slotFree`, then the matched run, then the kind, marked `?`.
 * @param {Exit} e
 * @param {WeighedRun | null} run
 */
function classOf(e, run) {
	if (e.slotFree === true) return { whole: false, sure: true };
	if (run) return { whole: run.whole, sure: true };
	if (e.slotFree === false) return { whole: true, sure: true };
	/* No run matched: the kinds that run whole by default (workflow-core#2909's guess). */
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
			cls: `${whole ? "whole" : "part"}${sure ? "" : "?"}`,
			workers: run ? run.workers : unmatched,
		};
	});
}

/**
 * @typedef {{ t: number, whole: WeighedRun[], busy: number,
 *   mem: MemBlock | undefined, waiting: Waiter[], admitting: Waiter[],
 *   era: string }} Tick
 */

/**
 * The gate's state at `t`: the whole runs, the busy workers, memwatch's block
 * for that minute, who waits and the era.
 *
 * @param {number} t
 * @param {{ runs: WeighedRun[], waiters: Waiter[], admitting: Waiter[],
 *   mem: Logs["mem"], eraOf: (t: number) => string }} s
 * @returns {Tick}
 */
function tickAt(t, s) {
	const live = s.runs.filter((r) => r.st <= t && t < r.en);
	return {
		t,
		whole: live.filter((r) => r.whole),
		busy: live.reduce((n, r) => n + r.workers, 0),
		mem: s.mem.get(Math.floor(t / 60_000)),
		waiting: s.waiters.filter((e) => e.st <= t && t < e.en),
		admitting: s.admitting,
		era: s.eraOf(t),
	};
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
	};
}

/**
 * @param {Tick} tick
 * @param {Window} w
 * @param {ReturnType<typeof buildTallies>} acc  accumulator: the tick is added
 * @param {Logs["parents"]} parents
 */
function tallyTick(tick, w, acc, parents) {
	if (tick.whole.length >= WHOLE_SUITE_MAX) acc.slotBusy += TICK_S;
	if (tick.whole.some((r) => r.kind === "lander")) acc.landerSlot += TICK_S;
	if (tick.mem) acc.memMinutes.add(Math.floor(tick.t / 60_000));
	for (const e of tick.waiting) {
		const [first = "open", ...also] = limbsOf(e, tick, w);
		for (const a of also) add(acc.limbAlso, `${first} / ${a}`, TICK_S);
		add(acc.limb, first, TICK_S);
		add(acc.limbClass, `${first} / ${e.cls}`, TICK_S);
		addNested(acc.limbSession, e.session ?? "(no session)", first);
		addNested(acc.limbEra, tick.era, first);
		if (first === "count")
			shareSlot(tick.whole, parents, acc.holder, acc.holderSession);
	}
}

/**
 * @param {Waiter} e
 * @param {Tick} tick
 * @param {Window} w
 */
function memoryHolds(e, tick, w) {
	return (
		tick.mem !== undefined &&
		w.memTotalMb - tick.mem.used < suiteRungMb(tick.busy + e.workers)
	);
}

/**
 * Whether a younger part waiter passes the older part waiter `o`: from
 * workflow-core#3058's commit, one the memory rung holds and that joined under
 * PART_PASS_AGE_MS ago, as the gate's turn reads it.
 * @param {Waiter} o
 * @param {Tick} tick
 * @param {Window} w
 */
function passes(o, tick, w) {
	return (
		tick.t >= PART_PASS_FROM &&
		tick.t - o.st < PART_PASS_AGE_MS &&
		memoryHolds(o, tick, w)
	);
}

/**
 * Every limb that holds `e` at this tick, in the gate's order; `open` where
 * none does.
 * @param {Waiter} e
 * @param {Tick} tick
 * @param {Window} w
 */
function limbsOf(e, tick, w) {
	const wholeWaiter = e.whole;
	const older = tick.waiting.filter((o) => o !== e && o.st < e.st);
	const held = {
		count: wholeWaiter && tick.whole.length >= WHOLE_SUITE_MAX,
		memory: memoryHolds(e, tick, w),
		"fifo-whole": wholeWaiter && older.length > 0,
		"fifo-part":
			!wholeWaiter && older.some((o) => !o.whole && !passes(o, tick, w)),
		admitted: tick.admitting.some(
			(o) => o.pid !== e.pid && o.en <= tick.t && tick.t < o.en + o.gap * 1000,
		),
		load: w.loadCeiling !== null && (tick.mem?.load ?? 0) >= w.loadCeiling,
	};
	const limbs = LIMBS.filter((l) => held[/** @type {keyof typeof held} */ (l)]);
	return limbs.length > 0 ? limbs : ["open"];
}

/**
 * Share a count-held tick between the whole runs holding the slot, by who
 * they are and by launching session.
 *
 * @param {WeighedRun[]} whole
 * @param {Logs["parents"]} parents
 * @param {Map<string, number>} holder  accumulator: the tick's share by holder
 * @param {Map<string, number>} holderSession  accumulator: by session
 */
function shareSlot(whole, parents, holder, holderSession) {
	for (const r of whole) {
		add(holder, holderOf(r, parents), TICK_S / whole.length);
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
	const state = { runs, waiters, admitting, mem: logs.mem, eraOf };
	for (let t = w.since; t < w.until; t += TICK_S * 1000)
		tallyTick(tickAt(t, state), w, acc, logs.parents);
	const eraWait = eras.map((era, i) => {
		const to = eras[i + 1]?.from ?? w.until;
		const from = Math.max(era.from, w.since);
		return {
			label: era.label,
			spanS: (to - from) / 1000,
			waitS: waiters.reduce((s, e) => s + clip(e.st, e.en, from, to), 0),
		};
	});
	const matchable = waiters.filter(
		(e) => e.reason === "opened" || e.reason === "timeout",
	);
	const counts = waiters.flatMap((e) =>
		e.passed === undefined ? [] : [e.passed],
	);
	const passing = counts.filter((n) => n > 0);
	return {
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
		unread: logs.unread,
		memMinutes: acc.memMinutes.size,
		minutes: Math.ceil((w.until - w.since) / 60_000),
	};
}

/** @param {number} s */
const hours = (s) => (s / 3600).toFixed(2);

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
	/* workflow-core#3047's quantile rule. */
	const quantile = (/** @type {number} */ p) =>
		r.gaps[Math.min(r.gaps.length - 1, Math.floor(p * r.gaps.length))] ?? 0;
	const lines = [
		`# Suite queue wait replay, ${new Date(w.since).toISOString()} to ${new Date(w.until).toISOString()}`,
		"",
		`${r.queued} queued waits (${r.exits} exits less ${r.skipped} skipped), ${hours(r.waitS)} h inside the window. ${r.matched} of ${r.matchable} opened or timed-out waits matched to their run. At most ${r.peak.n} waited at once, at ${new Date(r.peak.at).toISOString()}.`,
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
			? `Recorded passes: ${r.passes.passing} of the ${r.passes.counted} waits whose exit line counts its passes opened their turn past ${r.passes.passed} older part waiter(s) the memory rung held (workflow-core#3115).`
			: "Recorded passes: no exit line in the window counts its passes (none logged before workflow-core#3115 does); the fifo-part limb above is the replay's model alone.",
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
		`Exit to spawn, ${r.gaps.length} matched waits: median ${quantile(0.5).toFixed(1)} s, p90 ${quantile(0.9).toFixed(1)} s, max ${(r.gaps.at(-1) ?? 0).toFixed(1)} s.`,
		"",
		"## Limits",
		"",
		`- The memory limb is a lower bound: memwatch wrote a block in ${r.memMinutes} of the window's ${r.minutes} minutes, only above its used-memory or CPU threshold (${docPath("environment.md")} §4), and a minute with none counts as memory open.`,
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
