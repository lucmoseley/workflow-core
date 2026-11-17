/*
 * refill-synthetic.js — the refill loop's resumes of a launch the harness
 * ended on its own "No response requested." record (#5322, #5324): its job
 * reads `done`, so no Stop hook ran and nothing wakes it.
 *
 * The reading is lib/block-cause.js's syntheticStopAt, off the job store and
 * transcript alone; the act is lib/block-act.js's SYNTHETIC_STOP row. A resume
 * is typed into the job first, and where the transcript still shows the stop
 * past the attach-verdict window, or the typing fails, the job is stopped and
 * `claude --bg --resume`d under its own id; a job the reaper already stopped
 * goes straight to that resume. Arrival is read off the transcript, not the
 * timeline: any turn row after the synthetic record, the founder's typing
 * included, ends the stop, so the loop never stops a job he has typed into.
 *
 * The count is per stop, keyed to the synthetic record's timestamp. A later
 * stop starts afresh only where a model reply came between it and the loop's
 * last resume; one that a resume ran straight into carries the count on, so a
 * job that ends this way on every resume meets the cap. At the cap the loop
 * logs it and lets the launch finish; check-ghost-jobs then reports the job.
 */

const { SYNTHETIC_TRIES, blockAct } = require("./block-act.js");
const { SYNTHETIC_PROMPT } = require("./loop-prompts.js");
const {
	buildResumedHow,
	isActionable,
	isHeld,
	isLimitHeld,
	isResuming,
	isStepResume,
	iso,
	launchName,
	relaunched,
	stopJob,
} = require("./refill-block-core.js");
const { ATTACH_VERDICT_MS } = require("./refill-blocks.js");

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {{at: number, tries: number, resumed: number, triedAt?: number,
 *   attachAt?: number, spent?: true}} SyntheticResumes  a launch's resumes
 *   of its synthetic stops: `at`, the stop's synthetic record, ms; `tries`,
 *   the resumes made for it, the last at `triedAt`; `attachAt`, a typed one
 *   not yet seen arrive; `spent`, its cap reached and logged; `resumed`, the
 *   resumes made across every stop, for its finished-launch line
 */

const ROUTE_TYPED = "typing into the live session";
const ROUTE_RELAUNCH = "stop and --bg --resume";
const ROUTE_REAPED = "--bg --resume, the reaper having stopped it";

/**
 * Whether the loop leaves `l` to other acts: one it resumes after an API
 * error, holds stopped, owes a hand-off or a step resume.
 * @param {LoopLaunch} l
 */
const isOthers = (l) =>
	isResuming(l) ||
	isHeld(l) ||
	isStepResume(l) ||
	isLimitHeld(l) ||
	l.handOffTries !== undefined;

/**
 * Whether `l`'s job, gone from the listing, still owes the loop a synthetic
 * stop's resume, so the launch is not judged finished: its typed resume is in
 * flight, or its job reads a stop whose resumes are not spent.
 * @param {LoopLaunch} l
 * @param {import("./refill-blocks.js").BlockIo} io
 */
function isOwedResume(l, io) {
	if (!isActionable(l) || isOthers(l)) return false;
	if (l.synthetic?.attachAt !== undefined) return true;
	const at = io.syntheticStopOf(l);
	if (typeof at !== "number") return false;
	return !(l.synthetic?.at === at && l.synthetic.spent);
}

/**
 * The record of stop `at`: `was` where it is that stop's; else afresh, its
 * count carried where no model reply came since the loop's last resume.
 * @param {JobLaunch} l
 * @param {number} at
 * @param {import("./refill-blocks.js").BlockIo} io
 * @returns {SyntheticResumes}
 */
function recordOf(l, at, io) {
	const was = l.synthetic;
	if (was?.at === at) return was;
	const resumed = was?.resumed ?? 0;
	const carried =
		was?.triedAt !== undefined && io.hasRepliedSince(l, was.triedAt) === false;
	return { at, tries: carried ? was.tries : 0, resumed };
}

/**
 * The loop log's and the issue comment's line for one resume.
 * @param {LoopLaunch} l
 * @param {SyntheticResumes} rec  after the try
 * @param {string} route
 * @param {string|null} failed
 */
const buildLine = (l, rec, route, failed) =>
	`${failed ? "could not resume" : "resumed"} ${launchName(l)}, whose last turn the harness ended on a synthetic reply at ${iso(rec.at)}, by ${route}, try ${rec.tries} of ${SYNTHETIC_TRIES}${failed ? `: ${failed}` : ""}`;

/**
 * @param {LoopLaunch} l
 * @param {string} line
 * @param {import("./refill-blocks.js").BlockIo} io
 */
function report(l, line, io) {
	io.log(line);
	io.comment(l, `Refill loop: ${line}.`);
}

/**
 * Stop `l`'s job, unless the reaper already did, then `claude --bg --resume`
 * it with the synthetic prompt; `rec` the try it makes or settles. Never off
 * an unread listing, which cannot tell a live job from a stopped one.
 * @param {JobLaunch} l
 * @param {SyntheticResumes} rec
 * @param {Tick} seen
 * @param {boolean} reaped
 * @returns {LoopLaunch}
 */
function relaunch(l, rec, { agents, now, io }, reaped) {
	const route = reaped ? ROUTE_REAPED : ROUTE_RELAUNCH;
	/** @param {string} why */
	const failed = (why) => {
		report(l, buildLine(l, rec, route, why), io);
		return { ...l, synthetic: rec };
	};
	if (!agents) return failed("the listing is unread, so it is not stopped");
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) return failed("no session id read for it");
	const stopFailed = reaped ? null : stopJob(l, io);
	if (stopFailed) return failed(`stop: ${stopFailed}`);
	const r = io.resumeStopped(l, SYNTHETIC_PROMPT, { sessionId, cwd });
	if (r.failed !== null) return failed(r.failed);
	const out = {
		...relaunched(l, { ...r, fromSessionId: sessionId }, now, {
			tookSlot: false,
		}),
		synthetic: rec,
	};
	report(out, buildLine(out, rec, `${route}, ${buildResumedHow(r)}`, null), io);
	io.writeLaunch(out);
	return out;
}

/**
 * Resume `l`'s stop: typed into its job unless the reaper stopped it, where
 * the typing fails by relaunch. One more try either way.
 * @param {JobLaunch} l
 * @param {SyntheticResumes} rec
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function resume(l, rec, seen) {
	const { now, io } = seen;
	const tried = {
		...rec,
		tries: rec.tries + 1,
		triedAt: now,
		resumed: rec.resumed + 1,
	};
	const reaped = io.jobStateOf(l)?.state === "stopped";
	if (reaped) return relaunch(l, tried, seen, true);
	const typeFailed = io.type(l, SYNTHETIC_PROMPT);
	if (typeFailed) {
		io.log(`could not type the resume into ${l.jobId}: ${typeFailed}`);
		return relaunch(l, tried, seen, false);
	}
	const typed = { ...tried, attachAt: now };
	report(l, buildLine(l, typed, ROUTE_TYPED, null), io);
	return { ...l, synthetic: typed };
}

/**
 * `l` with its typed resume judged: in flight inside the attach-verdict
 * window; arrived once the transcript no longer reads that stop; else the
 * same try relaunched. Null where nothing is in flight.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch|null}
 */
function settleTyped(l, seen) {
	const rec = l.synthetic;
	if (rec?.attachAt === undefined) return null;
	if (seen.now - rec.attachAt < ATTACH_VERDICT_MS) return l;
	const { attachAt: _, ...settled } = rec;
	const at = seen.io.syntheticStopOf(l);
	if (at === "unread") return l;
	if (at !== rec.at) return { ...l, synthetic: settled };
	seen.io.log(
		`${launchName(l)} still reads its synthetic stop after the typed resume, so it is stopped and resumed`,
	);
	return relaunch(l, settled, seen, false);
}

/**
 * The tick's act on `l`'s synthetic stop, read at `at`.
 * @param {JobLaunch} l
 * @param {number} at
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function actOnStop(l, at, mode, seen) {
	const { now, io } = seen;
	const rec = recordOf(l, at, io);
	const act = blockAct(
		{
			cause: "SYNTHETIC_STOP",
			since: Math.max(at, rec.triedAt ?? 0),
			tries: rec.tries,
		},
		mode,
		now,
	);
	if (act === "resume") return resume(l, rec, seen);
	if (act === "none" && !rec.spent) {
		io.log(
			`stopped trying to resume ${launchName(l)} after ${rec.tries} resumes of its synthetic stop at ${iso(at)}: it finishes, and check-ghost-jobs reports it`,
		);
		return { ...l, synthetic: { ...rec, spent: true } };
	}
	return { ...l, synthetic: rec };
}

/**
 * The tick's acts on the launches the harness ended on a synthetic reply
 * (#5324): each typed resume in flight judged, then each actionable launch
 * whose job reads a synthetic stop acted on by the SYNTHETIC_STOP row. A
 * launch whose records will not read is left as it was.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch[]}
 */
function actOnSynthetic(launches, mode, seen) {
	return launches.map((l) => {
		if (!isActionable(l) || isOthers(l)) return l;
		const settled = settleTyped(l, seen);
		if (settled) return settled;
		const at = seen.io.syntheticStopOf(l);
		return typeof at === "number" ? actOnStop(l, at, mode, seen) : l;
	});
}

/**
 * The finished-launch line's note of the synthetic stops resumed, empty
 * where there were none.
 * @param {LoopLaunch} l
 */
const buildFinishNote = (l) =>
	l.synthetic?.resumed
		? `; resumed ${l.synthetic.resumed} time(s) after the harness ended its turn on a synthetic reply`
		: "";

module.exports = { actOnSynthetic, buildFinishNote, isOwedResume };
