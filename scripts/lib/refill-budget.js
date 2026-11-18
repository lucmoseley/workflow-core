/*
 * refill-budget.js — the refill loop's per-session gate-run budget (workflow-core#5275,
 * spec workflow-core#5273, ruling workflow-core#5250). A loop session's 6th commit-gate run since its
 * last landing, or since its launch where it has landed nothing, has the loop
 * stop it, post its hand-off on its issues (rescue-sessions.js hand-off, which
 * releases its claim) and label them `parked`, so they wait for the founder or
 * a later resume and no fresh launch takes them. The park is recorded on the
 * breaker's record (lib/refill-breaker.js) for the morning review.
 *
 * A gate run is one whole-suite start the commit gate queued, as
 * `.gate-runs.jsonl` records it (lib/gate-seat.js), matched by its `session`.
 * A landing is a commit of the session's on `origin/main`, dated by its commit
 * time, so the gate run that let that commit through counts before it. No park
 * writes the session marker a normal-mode loop resumes parked sessions from
 * (lib/parked.js).
 */

const { isActionable, launchName, stopJob } = require("./refill-block-core.js");
const { buildChildLine, buildHandOffArgs } = require("./refill-blocks.js");
const { landingOf, sessionIdsOf } = require("./refill-breaker.js");

/* Ruling workflow-core#5250, read off its 14-day distribution of gate runs per landing. */
const GATE_RUN_BUDGET = 6;

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-breaker.js").ThroughputRead} ThroughputRead
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 */

/**
 * How many gate runs `l`'s sessions ran since its last landing, else its
 * launch; null where its checkout's gate-run record will not read, and why
 * where its landing will not, so an unread landing never parks it (workflow-core#5273).
 * @param {LoopLaunch} l
 * @param {ThroughputRead} read
 * @returns {number|{unread: string}|null}
 */
function gateRunsSinceLanding(l, read) {
	const runs = read.byRoot[l.root]?.gateRuns;
	if (!runs) return null;
	const landing = landingOf(l, read);
	if (!("at" in landing)) return landing;
	const since = Math.max(l.launchedAt, landing.at ?? 0);
	const ids = sessionIdsOf(l);
	return runs.filter(
		(r) => r.session !== null && ids.has(r.session) && Date.parse(r.at) > since,
	).length;
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
		`Refill loop: stopped this issue's session on ${why} (workflow-core#5275), and parked it for a human or a later resume. The conversation is kept: \`claude attach\` reopens it.`,
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
		const runs = gateRunsSinceLanding(l, read);
		if (runs !== null && typeof runs === "object") {
			seen.io.log(
				`gate-run budget of ${launchName(l)} not judged: ${runs.unread}`,
			);
			return l;
		}
		if (runs === null || runs < GATE_RUN_BUDGET) return l;
		const parked = parkOnBudget(/** @type {JobLaunch} */ (l), runs, seen);
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
