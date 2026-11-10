/*
 * time-to-land.js — how long a queue ref takes from the lander's first take
 * of it to its land or drop, against the green suite's own time, and where a
 * red batch's time goes (#4951). check-time-to-land.js holds the first to its
 * target; report-time-to-land.js prints both.
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
 * THE TARGET: the stays' p90 at or under TARGET_MULTIPLE times the green
 * suite's p50, both over lib/queue-log.js's BASELINE_MS.
 *
 * A RED BATCH is replayed off the lander log: each `take-batch` opens a batch
 * in its slot, a `detach` of that slot makes it the search, and each red-path
 * line until the search ends is a step of it, timed to the search's next
 * line. One search runs at a time (lib/queue-lander.js), so its lines cross no
 * other's. A `take-batch` repeating its slot's members at their shas is the
 * same batch. Residual: a red path a restart resumes with no new `detach`
 * joins the batch last tested, and a lander line written before
 * `take-batch` named its slot reads as slot 0.
 *
 * PERCENTILES are lib/queue-log.js's, nearest-rank.
 */

const fs = require("node:fs");
const { BASELINE_MS, percentile } = require("./queue-log.js");

/* The stays' p90 over the green suite's p50 (#4951's design comment). A red
 * member costs its batch's run and one more run alone, its confirm beside it,
 * and Uber's queue reports a P95 wait near one build (arXiv 2501.03440). */
const TARGET_MULTIPLE = 3;
/* A guess, about a day's members at #4951's ~100 a day: fewer give no p90. */
const MIN_STAYS = 100;
/* A guess: a week of lander lines is a few of these. */
const CHUNK_BYTES = 4 * 1024 * 1024;

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
 * end a chunk at a time, as the log grows without bound; empty where absent.
 * @param {string} file
 * @param {number} since ms
 * @returns {string}
 */
function readLogSince(file, since) {
	/** @type {number} */
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return "";
		throw err;
	}
	try {
		/** @type {Buffer[]} */
		const chunks = [];
		let pos = fs.fstatSync(fd).size;
		while (pos > 0) {
			const length = Math.min(CHUNK_BYTES, pos);
			pos -= length;
			const chunk = Buffer.alloc(length);
			fs.readSync(fd, chunk, 0, length, pos);
			chunks.unshift(chunk);
			const first = FIRST_STAMP.exec(chunk.toString("latin1"));
			if (first && Date.parse(String(first[1])) < since) break;
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		fs.closeSync(fd);
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
 * Each green run's time, `test-sha` to `fast-forward-main` at one sha.
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
		const from = tested.get(sha);
		if (e.kind !== "fast-forward-main" || from === undefined) continue;
		spans.push({ sha, from, at: e.t });
		tested.delete(sha);
	}
	return spans;
}

/**
 * @typedef {object} Reading
 * @property {number} stays stays that ended in the window
 * @property {number|null} p50Ms
 * @property {number|null} p90Ms
 * @property {number} greens green runs that ended in the window
 * @property {number|null} greenP50Ms
 * @property {number|null} targetMs TARGET_MULTIPLE × greenP50Ms
 * @property {boolean} judged whether the window holds MIN_STAYS and a green run
 * @property {boolean} over whether a judged p90 is past its target
 */

/**
 * The BASELINE_MS before `now` against the target.
 * @param {readonly Stay[]} stays
 * @param {readonly {from: number, at: number}[]} greens
 * @param {number} now
 * @returns {Reading}
 */
function readTimeToLand(stays, greens, now) {
	/** @param {{at: number}} x */
	const inWindow = (x) => x.at > now - BASELINE_MS && x.at <= now;
	const times = stays.filter(inWindow).map((s) => s.at - s.take);
	const runs = greens.filter(inWindow).map((g) => g.at - g.from);
	const p90Ms = percentile(times, 90);
	const greenP50Ms = percentile(runs, 50);
	const targetMs = greenP50Ms === null ? null : TARGET_MULTIPLE * greenP50Ms;
	const judged = times.length >= MIN_STAYS && targetMs !== null;
	return {
		stays: times.length,
		p50Ms: percentile(times, 50),
		p90Ms,
		greens: runs.length,
		greenP50Ms,
		targetMs,
		judged,
		over: judged && p90Ms !== null && targetMs !== null && p90Ms > targetMs,
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
	MIN_STAYS,
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	parseLanderLog,
	readLogSince,
	readTimeToLand,
	replayBatches,
};
