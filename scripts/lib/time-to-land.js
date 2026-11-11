/*
 * time-to-land.js — how long a queue ref takes from the lander's first take
 * of it to its land or drop, against the green suite's own time, and where a
 * red batch's time goes (#4951).
 *
 * A STAY is one queue ref's time in the lander's hands, read off the queue
 * log (lib/queue-log.js): its first take row since it last left, to its land
 * or drop row. A ref taken again, as an isolation's passer is, keeps its
 * first take.
 *
 * THE GREEN SUITE is a batch's `test-sha <sha>` line in the lander log to the
 * `fast-forward-main <sha>` line at the same sha: one run that passed, paired
 * by sha, so batches under test at once never cross.
 *
 * THE WINDOW runs from a start to an end, by default the
 * lib/queue-log.js BASELINE_MS before now. A stay or green run counts only
 * where it began and ended inside it.
 *
 * THE TARGET: the stays' p90 at or under TARGET_MULTIPLE times the green
 * suite's p50, both over the window, judged by an exact binomial count of
 * the stays over that time (overCountNeeded, #4989).
 *
 * A RED BATCH is replayed off the lander log: each `take-batch` opens a batch
 * in its slot, a `detach` of that slot makes it the search, and each red-path
 * line until the search ends is a step of it, timed to the search's next
 * line. One search runs at a time (lib/queue-lander.js), so its lines cross no
 * other's. A `take-batch` repeating its slot's members at their shas is the
 * same batch. Residual: a red path a restart resumes with no new `detach`
 * joins the batch last tested, and a lander line written before
 * `take-batch` named its slot reads as slot 0; a `test-sha` is the batch's
 * last merged, so a retest after a later batch's merge reads as that batch's;
 * and a `parallel` tester's `isolate-members` and `confirm-members` are asked
 * together, so the pair's time reads on `confirm-members`.
 */

const { readTail } = require("./file-read.js");
const { BASELINE_MS, percentile } = require("./queue-log.js");
const { DAY_MS } = require("./retained-jsonl.js");

/* The stays' p90 over the green suite's p50 (#4951's design comment). */
const TARGET_MULTIPLE = 3;
/* The stays' percentile the target holds, so a queue on target has at most
 * OVER_SHARE of its stays over the time. */
const TARGET_PERCENTILE = 90;
const OVER_SHARE = 1 - TARGET_PERCENTILE / 100;
/* The one-sided chance a queue on target is called over: the conventional
 * 5% significance level, chosen at #4989. */
const CHANCE = 0.05;
/* The first window readLogSince reads, doubled until it reaches past
 * `since`; a guess, never measured against the log's daily growth. */
const FIRST_WINDOW_BYTES = 4 * 1024 * 1024;

const STAMPED = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ([a-z-]+)(?: (.*))?$/;
const FIRST_STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) /m;

/**
 * @typedef {import("./queue-log.js").LoggedRow} LoggedRow
 * @typedef {{ref: string, sha: string, event: "land"|"drop", take: number,
 *   at: number, takes: number}} Stay `take` the first take, `at` the land or
 *   drop, in ms
 * @typedef {{t: number, kind: string, rest: string}} LanderEvent a stamped
 *   lander log line: its action kind and the rest of the line
 * @typedef {{kind: string, t: number, end: number|null}} RedStep
 * @typedef {object} ReplayedBatch
 * @property {number} slot
 * @property {number} take
 * @property {string[]} members queue ref names
 * @property {string[]} shas the members' short shas, in order
 * @property {{sha: string, t: number}[]} tests each `test-sha` of it
 * @property {number|null} detach when it became the search
 * @property {RedStep[]} steps its red-path lines
 * @property {string[]} drops members dropped
 * @property {number|null} end
 * @property {"green"|"red-landed"|"dropped"|"rebatched"|"held"|"unmerged"
 *   |"retaken"|"unclosed"|null} outcome
 * @property {number} last its newest line
 */

/**
 * Each ref's stays, by the order they ended.
 * @param {readonly LoggedRow[]} rows oldest first
 * @returns {Stay[]}
 */
function memberStays(rows) {
	/** @type {Map<string, {take: number, takes: number}>} */
	const open = new Map();
	/** @type {Stay[]} */
	const stays = [];
	for (const row of rows) {
		const mine = open.get(row.ref);
		if (row.event === "take")
			open.set(row.ref, {
				take: mine?.take ?? row.at,
				takes: (mine?.takes ?? 0) + 1,
			});
		if (row.event !== "land" && row.event !== "drop") continue;
		open.delete(row.ref);
		if (mine)
			stays.push({
				ref: row.ref,
				sha: row.sha,
				event: row.event,
				take: mine.take,
				at: row.at,
				takes: mine.takes,
			});
	}
	return stays;
}

/**
 * The tail of the log at `file` reaching back past `since`, read from its
 * end, the window doubled until it does, as the log grows without bound;
 * empty where absent.
 * @param {string} file
 * @param {number} since ms
 * @returns {string}
 */
function readLogSince(file, since) {
	for (let want = FIRST_WINDOW_BYTES; ; want *= 2) {
		const tail = readTail(file, want);
		if (tail.state === "absent") return "";
		if (tail.state === "unreadable") throw tail.error;
		const { text, partial } = tail.data;
		const first = FIRST_STAMP.exec(text);
		if (!partial || (first && Date.parse(String(first[1])) < since))
			return text;
	}
}

/**
 * The stamped lines of a lander log, in its order; any other line, a
 * child's output among them, is left out.
 * @param {string} text
 * @returns {LanderEvent[]}
 */
function parseLanderLog(text) {
	/** @type {LanderEvent[]} */
	const events = [];
	for (const line of text.split("\n")) {
		const m = STAMPED.exec(line);
		if (m)
			events.push({
				t: Date.parse(String(m[1])),
				kind: String(m[2]),
				rest: m[3] ?? "",
			});
	}
	return events;
}

/**
 * Each green run's time, `test-sha` to `fast-forward-main` at one sha. A sha
 * a red-path line names is no green run, landed or not.
 * @param {readonly LanderEvent[]} events
 * @returns {{sha: string, from: number, at: number}[]}
 */
function greenSuiteSpans(events) {
	/** @type {Map<string, number>} */
	const tested = new Map();
	const spans = [];
	for (const e of events) {
		const sha = e.rest.trim();
		if (e.kind === "test-sha") tested.set(sha, e.t);
		if (RED_KINDS.has(e.kind)) tested.delete(sha.split(" ")[0] ?? "");
		const from = tested.get(sha);
		if (e.kind !== "fast-forward-main" || from === undefined) continue;
		spans.push({ sha, from, at: e.t });
		tested.delete(sha);
	}
	return spans;
}

/* An ISO time with its zone: `Date.parse` reads a bare date as UTC and a
 * zoneless time as local, so either would move the window unseen. */
const ISO_TIME_RE =
	/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;

/**
 * @typedef {{since: number, until: number, label: string}} Window ms; `label`
 *   names it in a reading's line
 */

/**
 * The window a reading covers.
 * @param {{since?: string|null, until?: string|null}} flags ISO times; the
 *   end is `at` where `until` is absent, the start the BASELINE_MS before the
 *   end where `since` is
 * @param {number} at now, in ms
 * @returns {Window|string} the window, or why the flags give none
 */
function windowOf(flags, at) {
	for (const [name, value] of Object.entries(flags))
		if (value != null && !ISO_TIME_RE.test(value))
			return `--${name} takes an ISO time with its zone, such as 2026-11-10T16:13:04Z: ${value}`;
	const until = flags.until == null ? at : Date.parse(flags.until);
	const since =
		flags.since == null ? until - BASELINE_MS : Date.parse(flags.since);
	if (!(since < until && until <= at))
		return "--since must fall before --until, and --until no later than now";
	const iso = (/** @type {number} */ t) => new Date(t).toISOString();
	return {
		since,
		until,
		label:
			flags.since == null && flags.until == null
				? `in ${BASELINE_MS / DAY_MS} days`
				: `from ${iso(since)} to ${iso(until)}`,
	};
}

/**
 * @param {Window} w
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
const spanIn = (w, from, to) => from >= w.since && to < w.until;

/**
 * The fewest of `n` stays over the time that a queue on target, each stay
 * over it with OVER_SHARE's chance, reaches at most CHANCE of the time:
 * `n + 1`, never reached, where no count of `n` is that rare.
 * @param {number} n
 * @returns {number}
 */
function overCountNeeded(n) {
	const odds = Math.log(OVER_SHARE / (1 - OVER_SHARE));
	let logMass = n * Math.log(1 - OVER_SHARE);
	let below = 0;
	for (let x = 0; x <= n; x++) {
		if (1 - below <= CHANCE) return x;
		below += Math.exp(logMass);
		logMass += Math.log((n - x) / (x + 1)) + odds;
	}
	return n + 1;
}

/**
 * @typedef {object} Reading
 * @property {number} stays stays that began and ended in the window
 * @property {number|null} overTarget stays longer than targetMs
 * @property {number} overNeeded overCountNeeded of the stays
 * @property {number|null} p50Ms
 * @property {number|null} p90Ms
 * @property {number} greens green runs that began and ended in the window
 * @property {number|null} greenP50Ms
 * @property {number|null} targetMs TARGET_MULTIPLE × greenP50Ms
 * @property {boolean} judged whether the window holds a green run
 * @property {boolean} over whether overTarget reaches overNeeded
 */

/** @param {number|null} ms @returns {string} whole seconds, `-` for none */
const secs = (ms) => (ms === null ? "-" : String(Math.round(ms / 1000)));

/**
 * The window's stays against the target.
 * @param {readonly Stay[]} stays
 * @param {readonly {from: number, at: number}[]} greens
 * @param {Window} w
 * @returns {Reading}
 */
function judgeTimeToLand(stays, greens, w) {
	const times = stays
		.filter((s) => spanIn(w, s.take, s.at))
		.map((s) => s.at - s.take);
	const runs = greens
		.filter((g) => spanIn(w, g.from, g.at))
		.map((g) => g.at - g.from);
	const greenP50Ms = percentile(runs, 50);
	const targetMs = greenP50Ms === null ? null : TARGET_MULTIPLE * greenP50Ms;
	const overTarget =
		targetMs === null ? null : times.filter((t) => t > targetMs).length;
	const overNeeded = overCountNeeded(times.length);
	return {
		stays: times.length,
		overTarget,
		overNeeded,
		p50Ms: percentile(times, 50),
		p90Ms: percentile(times, TARGET_PERCENTILE),
		greens: runs.length,
		greenP50Ms,
		targetMs,
		judged: targetMs !== null,
		over: overTarget !== null && overTarget >= overNeeded,
	};
}

const RED_KINDS = new Set([
	"rerun-files",
	"check-base",
	"file-base-red",
	"hold",
	"start-isolation",
	"start-serial",
	"merge-iso",
	"serial-land-step",
	"isolate-members",
	"confirm-members",
	"rebatch-passers",
	"land-step",
	"record-step",
]);

/** @param {string} rest */
const refsIn = (rest) =>
	[...rest.matchAll(/queue\/([^\s,@]+)/g)].map((m) => String(m[1]));

/** @param {string} rest */
const slotIn = (rest) => Number(/lander\/batch-(\d+)/.exec(rest)?.[1] ?? 0);

/**
 * @param {ReplayedBatch} b
 * @param {number} t
 */
function endStep(b, t) {
	const step = b.steps.at(-1);
	if (step && step.end === null) step.end = t;
}

/** The replay's state: every batch, each slot's newest, the live search and
 * the batch last merged. */
class Replay {
	constructor() {
		/** @type {ReplayedBatch[]} */
		this.batches = [];
		/** @type {Map<number, ReplayedBatch>} */
		this.bySlot = new Map();
		/** @type {ReplayedBatch|null} */
		this.search = null;
		/** @type {ReplayedBatch|null} */
		this.merged = null;
	}

	/**
	 * @param {ReplayedBatch} b
	 * @param {number} t
	 * @param {NonNullable<ReplayedBatch["outcome"]>} outcome
	 */
	close(b, t, outcome) {
		if (b.end !== null) return;
		b.end = t;
		b.outcome = outcome;
		endStep(b, t);
		if (this.search === b) this.search = null;
	}

	/**
	 * The newest batch not ended that `is` holds of.
	 * @param {(b: ReplayedBatch) => boolean} is
	 */
	live(is) {
		return this.batches.findLast((b) => b.end === null && is(b)) ?? null;
	}

	/** @param {LanderEvent} e */
	take(e) {
		const shas = [...e.rest.matchAll(/@([0-9a-f]+)/g)].map((m) => String(m[1]));
		const slot = slotIn(e.rest);
		const prev = this.bySlot.get(slot);
		if (prev && prev.end === null) {
			if (prev.shas.join() === shas.join()) {
				prev.last = e.t;
				return;
			}
			this.close(
				prev,
				prev.last,
				prev.detach === null ? "retaken" : "unclosed",
			);
		}
		/** @type {ReplayedBatch} */
		const b = {
			slot,
			take: e.t,
			members: refsIn(e.rest),
			shas,
			tests: [],
			detach: null,
			steps: [],
			drops: [],
			end: null,
			outcome: null,
			last: e.t,
		};
		this.batches.push(b);
		this.bySlot.set(slot, b);
	}

	/** @param {LanderEvent} e */
	merge(e) {
		const names = refsIn(e.rest);
		this.merged = this.live((b) => names.every((n) => b.members.includes(n)));
	}

	/** @param {LanderEvent} e */
	test(e) {
		const b = this.merged;
		if (!b || b.end !== null) return;
		b.tests.push({ sha: e.rest.trim(), t: e.t });
		b.last = e.t;
	}

	/** @param {LanderEvent} e */
	land(e) {
		const sha = e.rest.trim();
		const b = this.live((x) => x.tests.some((t) => t.sha === sha));
		if (b) this.close(b, e.t, b.detach === null ? "green" : "red-landed");
	}

	/** @param {LanderEvent} e */
	detach(e) {
		const b = this.bySlot.get(slotIn(e.rest));
		if (!b || b.end !== null) return;
		if (this.search && this.search !== b)
			this.close(this.search, this.search.last, "unclosed");
		b.detach = e.t;
		b.last = e.t;
		this.search = b;
	}

	/**
	 * The search a red-path line belongs to: the one detached, else, a red
	 * path no `detach` opened, the batch naming its members or last tested.
	 * @param {LanderEvent} e
	 */
	searchOf(e) {
		if (this.search) return this.search;
		const names = refsIn(e.rest);
		const named =
			names.length > 0
				? this.live((x) => names.every((n) => x.members.includes(n)))
				: null;
		const b = named ?? this.live((x) => x.tests.length > 0);
		if (b) b.detach = e.t;
		this.search = b;
		return b;
	}

	/** @param {LanderEvent} e */
	red(e) {
		const b = this.searchOf(e);
		if (!b) return;
		endStep(b, e.t);
		b.steps.push({ kind: e.kind, t: e.t, end: null });
		b.last = e.t;
		if (e.kind === "rebatch-passers") this.close(b, e.t, "rebatched");
		if (e.kind === "hold") this.close(b, e.t, "held");
	}

	/** @param {LanderEvent} e */
	drop(e) {
		const [name = ""] = refsIn(e.rest);
		const b = this.search?.members.includes(name)
			? this.search
			: this.live((x) => x.members.includes(name));
		if (!b) return;
		b.drops.push(name);
		b.last = e.t;
		endStep(b, e.t);
		if (b.drops.length >= b.members.length)
			this.close(b, e.t, b.detach === null ? "unmerged" : "dropped");
	}
}

/** @type {Record<string, "take"|"merge"|"test"|"land"|"detach"|"drop">} */
const HANDLERS = {
	"take-batch": "take",
	"merge-members": "merge",
	"test-sha": "test",
	"fast-forward-main": "land",
	detach: "detach",
	"drop-member": "drop",
};

/**
 * The batches a lander log's lines tell of, by the order they were taken.
 * @param {readonly LanderEvent[]} events
 * @returns {ReplayedBatch[]}
 */
function replayBatches(events) {
	const replay = new Replay();
	for (const e of events) {
		const handler = HANDLERS[e.kind];
		if (handler) replay[handler](e);
		else if (RED_KINDS.has(e.kind)) replay.red(e);
	}
	return replay.batches;
}

module.exports = {
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	parseLanderLog,
	readLogSince,
	judgeTimeToLand,
	secs,
	spanIn,
	windowOf,
	replayBatches,
};
