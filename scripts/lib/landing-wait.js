/*
 * landing-wait.js — `landing-status.js --wait`'s loop (#4617): re-read the
 * session's landing state until nothing it had queued is still queued, or a
 * bound, so a session backgrounds one call in place of guessing a timer.
 *
 * A sha is pending while its commit reads queued, or its queue-ref stay reads
 * queued, testing or unknown between them. Once none is pending, each sha
 * pending at the start has landed, or it has not, and so was dropped.
 */

const { short } = require("./lander-git.js");

/** Under the harness's 15-minute Bash wait (#1286). */
const WAIT_BOUND_MS = 14 * 60_000;
/* A judgement, not a measurement: one fetch per poll is cheap, and 20 s is a
 * small fraction of the queue's 5-minute p50 time in queue. */
const WAIT_POLL_MS = 20_000;

/**
 * @typedef {"landed"|"pending"|"dropped"|"left"} ShaState `left`: a commit
 *   that reads unpushed, so off every queue ref and off `main`
 * @typedef {{lines: string[], states: ReadonlyMap<string, ShaState>}} Reading
 * @typedef {{fault: number}} Fault a read that failed, its exit code; the
 *   reader has named why on stderr
 * @typedef {{kind: "idle"|"landed"|"bound", reading: Reading, ms: number}
 *   | {kind: "dropped", reading: Reading, ms: number, shas: string[]}
 *   | {kind: "fault", code: number}} Outcome
 */

/** @type {Record<import("./landing-status.js").CommitState["kind"], ShaState>} */
const COMMIT_STATE = { landed: "landed", queued: "pending", unpushed: "left" };

/** @type {Record<import("./queue-ref-status.js").RefState["state"], ShaState>} */
const REF_STATE = {
	queued: "pending",
	testing: "pending",
	unread: "pending",
	unwalked: "pending",
	landed: "landed",
	dropped: "dropped",
};

/**
 * One sha's state off its commit's reading and its queue-ref stay's. The
 * commit reads where the sha is now, so it wins where it reads landed or
 * queued: a stay is history, and a dropped sha can be pushed again or land
 * under a later push. Only a commit off every ref defers, to the stay that
 * says why.
 * @param {import("./landing-status.js").CommitState["kind"]|undefined} commit
 * @param {import("./queue-ref-status.js").RefState["state"]|undefined} ref
 * @returns {ShaState|undefined}
 */
function shaState(commit, ref) {
	const c = commit && COMMIT_STATE[commit];
	if (c === "landed" || c === "pending") return c;
	return (ref && REF_STATE[ref]) ?? c;
}

/** @param {ReadonlyMap<string, ShaState>} states */
const pendingOf = (states) =>
	[...states].filter(([, s]) => s === "pending").map(([sha]) => sha);

/**
 * A failed read after the first is retried at the next poll, and returned
 * only where it is still failing at the bound.
 * @param {() => Reading|Fault} read
 * @param {{sleep: (ms: number) => void, elapsed: () => number}} io
 *   `elapsed` counts ms from the call
 * @returns {Outcome}
 */
function waitForLanding(read, io) {
	const first = read();
	if ("fault" in first) return { kind: "fault", code: first.fault };
	let reading = first;
	const started = pendingOf(reading.states);
	if (started.length === 0) return { kind: "idle", reading, ms: io.elapsed() };
	/** @type {Fault|null} */
	let fault = null;
	for (;;) {
		if (io.elapsed() + WAIT_POLL_MS > WAIT_BOUND_MS)
			return fault
				? { kind: "fault", code: fault.fault }
				: { kind: "bound", reading, ms: io.elapsed() };
		io.sleep(WAIT_POLL_MS);
		const next = read();
		fault = "fault" in next ? next : null;
		if ("fault" in next) continue;
		reading = next;
		if (pendingOf(reading.states).length === 0)
			return settled(started, reading, io.elapsed());
	}
}

/**
 * How a wait with nothing left pending ended: dropped where any sha pending
 * at the start did not land.
 * @param {string[]} started
 * @param {Reading} reading
 * @param {number} ms
 * @returns {Outcome}
 */
function settled(started, reading, ms) {
	const shas = started.filter((sha) => {
		const s = reading.states.get(sha);
		return s === "dropped" || s === "left";
	});
	return shas.length > 0
		? { kind: "dropped", reading, ms, shas }
		: { kind: "landed", reading, ms };
}

/** @param {number} ms */
const minSec = (ms) => {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

/**
 * The wait's last line, naming how it ended.
 * @param {Exclude<Outcome, {kind: "fault"}>} o
 */
function buildWaitLine(o) {
	switch (o.kind) {
		case "idle":
			return "wait: nothing of this session's is queued, so there is nothing to wait for.";
		case "landed":
			return `wait: landed — every queued commit is on main, after ${minSec(o.ms)}.`;
		case "dropped":
			return `wait: dropped — ${o.shas.map(short).join(", ")} left the queue without landing, after ${minSec(o.ms)}.`;
		case "bound":
			return `wait: bound — still queued after ${minSec(o.ms)}; run it again to keep waiting.`;
	}
}

module.exports = {
	WAIT_BOUND_MS,
	WAIT_POLL_MS,
	buildWaitLine,
	shaState,
	waitForLanding,
};
