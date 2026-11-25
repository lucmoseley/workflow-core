const { short } = require("./lander-git.js");
const { scriptPath } = require("./script-path.js");

// guess under the harness's 15-minute Bash wait, workflow-core#1286
const WAIT_BOUND_MS = 14 * 60_000;
// guess, workflow-core#4617
const WAIT_POLL_MS = 20_000;

/**
 * @typedef {"landed"|"pending"|"dropped"|"left"} ShaState
 * @typedef {{lines: string[], states: ReadonlyMap<string, ShaState>}} Reading
 * @typedef {{fault: number, network: boolean}} Fault
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
 * @param {() => Reading|Fault} read
 * @param {{sleep: (ms: number) => void, elapsed: () => number}} io
 * @returns {Outcome}
 */
function waitForLanding(read, io) {
	const first = read();
	if ("fault" in first) return { kind: "fault", code: first.fault };
	let reading = first;
	const started = pendingOf(reading.states);
	if (started.length === 0) return { kind: "idle", reading, ms: io.elapsed() };
	/** @type {Reading|Fault} */
	let last = first;
	while (io.elapsed() + WAIT_POLL_MS <= WAIT_BOUND_MS) {
		io.sleep(WAIT_POLL_MS);
		last = read();
		if ("fault" in last) {
			if (!last.network) break;
			continue;
		}
		reading = last;
		if (pendingOf(reading.states).length === 0)
			return settled(started, reading, io.elapsed());
	}
	return "fault" in last
		? { kind: "fault", code: last.fault }
		: { kind: "bound", reading, ms: io.elapsed() };
}

/**
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

/** @param {Exclude<Outcome, {kind: "fault"}>} o */
function buildWaitLine(o) {
	switch (o.kind) {
		case "idle":
			return "wait: nothing of this session's is queued, so there is nothing to wait for.";
		case "landed":
			return `wait: landed — every queued commit is on main, after ${minSec(o.ms)}.`;
		case "dropped":
			return `wait: dropped — ${o.shas.map(short).join(", ")} left the queue without landing, after ${minSec(o.ms)}; \`node ${scriptPath("landing-status.js")}\` shows why each was dropped.`;
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
