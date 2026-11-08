/*
 * landing-wait.js — `landing-status.js --wait`'s loop: re-read the session's
 * landing state until nothing it had queued is still queued, or a bound.
 *
 * A sha is pending while a commit reads queued or a queue-ref stay reads
 * queued, testing or unknown between them. Once none is pending, each sha
 * pending at the start has landed, or it has not, and so was dropped.
 */

/** Under the harness's 15-minute Bash wait (#1286). */
const WAIT_BOUND_MS = 14 * 60_000;
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

/** @param {ReadonlyMap<string, ShaState>} states */
const pendingOf = (states) =>
	[...states].filter(([, s]) => s === "pending").map(([sha]) => sha);

/**
 * @param {() => Reading|Fault} read
 * @param {{sleep: (ms: number) => void, elapsed: () => number,
 *   boundMs?: number, pollMs?: number}} io `elapsed` counts ms from the call
 * @returns {Outcome}
 */
function waitForLanding(read, io) {
	const boundMs = io.boundMs ?? WAIT_BOUND_MS;
	const pollMs = io.pollMs ?? WAIT_POLL_MS;
	let reading = read();
	if ("fault" in reading) return { kind: "fault", code: reading.fault };
	const started = pendingOf(reading.states);
	if (started.length === 0) return { kind: "idle", reading, ms: io.elapsed() };
	for (;;) {
		if (io.elapsed() + pollMs > boundMs)
			return { kind: "bound", reading, ms: io.elapsed() };
		io.sleep(pollMs);
		const next = read();
		if ("fault" in next) return { kind: "fault", code: next.fault };
		reading = next;
		if (pendingOf(reading.states).length > 0) continue;
		const states = reading.states;
		const shas = started.filter((sha) => {
			const s = states.get(sha);
			return s === "dropped" || s === "left";
		});
		return shas.length > 0
			? { kind: "dropped", reading, ms: io.elapsed(), shas }
			: { kind: "landed", reading, ms: io.elapsed() };
	}
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
			return `wait: dropped — ${o.shas.map((s) => s.slice(0, 9)).join(", ")} left the queue without landing, after ${minSec(o.ms)}.`;
		case "bound":
			return `wait: bound — still queued after ${minSec(o.ms)}; run it again to keep waiting.`;
	}
}

module.exports = { WAIT_BOUND_MS, WAIT_POLL_MS, buildWaitLine, waitForLanding };
