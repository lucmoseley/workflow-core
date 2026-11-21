/*
 * refill-budget.js — the refill loop's per-session gate-run budget (#5275,
 * spec #5273, ruling #5250). A loop session's 6th commit-gate run since its
 * last landing, or since its launch where it has landed nothing, has the loop
 * stop it, post its hand-off on its issues (rescue-sessions.js hand-off, which
 * releases its claim) and label them `parked`, so they wait for the founder or
 * a later resume and no fresh launch takes them. The park is recorded on the
 * breaker's record (lib/refill-breaker.js) for the morning review.
 *
 * A gate run is one whole-suite start the commit gate queued, as
 * `.gate-runs.jsonl` records it (lib/gate-seat.js), matched by its `session`.
 * A landing is a commit of the session's on `origin/main`, dated by its commit
 * time, so the gate run that let that commit through counts before it. A
 * session whose newest gate run passed and whose queue ref has a stay queued,
 * under test or landed is waiting on the lander, or on `origin/main` showing
 * its landing, so is never parked (#5438); nor is one whose queue ref reads
 * no stay while its push of that passed commit is still due (#5441). No park
 * writes the session marker a normal-mode loop resumes parked sessions from
 * (lib/parked.js).
 *
 * Residual: a session whose stay landed, or that has no stay, and that then
 * passes gate after gate without pushing is held while its newest run passes
 * (#5438, #5441); and one pushing more than 11 minutes after its pass, as a
 * slow review before the push can, is parked (#5441).
 */

const { isActionable, launchName, stopJob } = require("./refill-block-core.js");
const { buildChildLine, buildHandOffArgs } = require("./refill-blocks.js");
const { landingOf, sessionIdsOf } = require("./refill-breaker.js");

/* Ruling #5250, read off its 14-day distribution of gate runs per landing. */
const GATE_RUN_BUDGET = 6;

/* How long after a passing gate run its push is still due (#5441): the
 * longest of 56 gaps from a passing run's end to the session's next push, with
 * no gate run between, across four checkouts' gate-run and queue-log records
 * on 2026-11-21, was 634 s; 52 fell under 75 s. Two gaps of about 16 h, each
 * ended by a later session's push, are left out; rounded up to the minute. */
const PUSH_DUE_MS = 11 * 60_000;

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-breaker.js").ThroughputRead} ThroughputRead
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 */

/**
 * The gate runs `l`'s sessions ran since its last landing, else its launch,
 * oldest first; null where its checkout's gate-run record will not read, and
 * why where its landing will not, so an unread landing never parks it (#5273).
 * @param {LoopLaunch} l
 * @param {ThroughputRead} read
 * @returns {import("./gate-seat.js").GateRun[]|{unread: string}|null}
 */
function gateRunsSinceLanding(l, read) {
	const runs = read.byRoot[l.root]?.gateRuns;
	if (!runs) return null;
	const landing = landingOf(l, read);
	if (!("at" in landing)) return landing;
	const since = Math.max(l.launchedAt, landing.at ?? 0);
	const ids = sessionIdsOf(l);
	return runs
		.filter(
			(r) =>
				r.session !== null && ids.has(r.session) && Date.parse(r.at) > since,
		)
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Whether `l` is parked this tick: its run count where it is, else null, or
 * why it is not judged or is held.
 * @param {LoopLaunch} l
 * @param {ThroughputRead} read
 * @param {number} now
 * @returns {number|{note: string}|null}
 */
function budgetVerdict(l, read, now) {
	const runs = gateRunsSinceLanding(l, read);
	if (runs === null) return null;
	if (!Array.isArray(runs)) return { note: `not judged: ${runs.unread}` };
	if (runs.length < GATE_RUN_BUDGET) return null;
	const newest = runs.at(-1);
	if (newest?.outcome !== "pass") return runs.length;
	const queue = read.queueOf(l);
	/* An unread queue ref parks nothing, as an unread landing does (#5273). */
	if (queue.state === "unread") return { note: `not judged: ${queue.why}` };
	if (queue.state !== "gone")
		return { note: "held: its passed commit waits on the lander" };
	return now - Date.parse(newest.at) < PUSH_DUE_MS
		? { note: "held: its push of its passed commit is still due" }
		: runs.length;
}

/**
 * Park `l` on its budget: stopped, handed off, its issues labelled `parked`
 * and told why. A stop that fails is logged and tried again next tick.
 * @param {JobLaunch} l
 * @param {number} runs
 * @param {Tick} seen
 * @returns {LoopLaunch|null} the parked launch, or null where the stop failed
 */
function parkOnBudget(l, runs, { now, io }) {
	const failed = stopJob(l, io);
	if (failed) {
		io.log(`could not stop ${launchName(l)} at its gate-run budget: ${failed}`);
		return null;
	}
	const handed = io.postHandOff(l.root, buildHandOffArgs(l));
	const unlabelled = io.labelParked(l);
	const why = `its ${runs}th commit-gate run since its last landing, past the budget of ${GATE_RUN_BUDGET - 1}`;
	io.log(
		buildChildLine(
			`stopped ${launchName(l)} on ${why}, handed it off and parked it${unlabelled.length > 0 ? `; parked label refused on ${unlabelled.map((u) => `#${u.n} (${u.why})`).join(", ")}` : ""}`,
			handed,
		),
	);
	io.comment(
		l,
		`Refill loop: stopped this issue's session on ${why} (#5275), and parked it for a human or a later resume. The conversation is kept: \`claude attach\` reopens it.`,
	);
	return { ...l, ...io.progressOf(l), finishedAt: now, budgetParked: now };
}

/**
 * @param {LoopLaunch[]} launches
 * @param {ThroughputRead} read
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[], events: BreakerEvent[]}}
 */
function parkOverBudget(launches, read, seen) {
	/** @type {BreakerEvent[]} */
	const events = [];
	const out = launches.map((l) => {
		if (!isActionable(l) || l.jobId === null) return l;
		const verdict = budgetVerdict(l, read, seen.now);
		if (verdict === null) return l;
		if (typeof verdict === "object") {
			seen.io.log(`gate-run budget of ${launchName(l)} ${verdict.note}`);
			return l;
		}
		const parked = parkOnBudget(/** @type {JobLaunch} */ (l), verdict, seen);
		if (parked === null) return l;
		events.push({
			at: new Date(seen.now).toISOString(),
			repo: l.root,
			event: "budget-park",
			rate: null,
			workingHours: 0,
			session: l.sessionId ?? l.jobId,
			...(l.issues[0] === undefined ? {} : { ticket: l.issues[0] }),
		});
		return parked;
	});
	return { launches: out, events };
}

module.exports = { parkOverBudget };
