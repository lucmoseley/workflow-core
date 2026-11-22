/*
 * refill-synthetic.js — the refill loop's resumes of a session the harness
 * ended on its own "No response requested." record (workflow-core#5322, workflow-core#5324): its job
 * reads `done`, so no Stop hook ran and nothing wakes it. One judgement serves
 * the loop's own launches and the sessions it did not launch
 * (lib/refill-outside.js), each through a Subject adapter of its record.
 *
 * Arrival is read off the transcript, not the timeline: any turn row after
 * the synthetic record, the founder's typing included, ends the stop.
 *
 * The count is per stop, keyed to the synthetic record's timestamp. A later
 * stop starts afresh only where a model reply came between it and the loop's
 * last resume; one that a resume ran straight into carries the count on, so a
 * job that ends this way on every resume meets the cap.
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
const { ATTACH_VERDICT_MS, isRunAdmitted } = require("./refill-blocks.js");

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").SessionRef} SessionRef
 * @typedef {import("./refill-blocks.js").StoppedTarget} StoppedTarget
 * @typedef {{at: number, tries: number, resumed: number, triedAt?: number,
 *   attachAt?: number, spent?: true}} SyntheticResumes  a session's resumes
 *   of its synthetic stops: `at`, the stop's synthetic record, ms; `tries`,
 *   the resumes made for it, the last at `triedAt`; `attachAt`, a typed one
 *   not yet seen arrive; `spent`, its cap reached and logged; `resumed`, the
 *   resumes made across every stop, for a finished launch's line
 */
/**
 * @template T
 * @typedef {{name: string, ref: SessionRef, was?: SyntheticResumes,
 *   admitted: () => boolean, keep: (rec: SyntheticResumes) => T,
 *   stop: () => string|null,
 *   resume: (target: StoppedTarget, rec: SyntheticResumes) =>
 *     {out: T, how?: string}|string,
 *   report: (line: string) => void}} Subject  one session's record as the
 *   judgement sees it: `admitted`, whether the tick may set it running,
 *   asked only of a due resume; `keep` it with a record; `stop` its job, the why where
 *   that failed; `resume` it stopped, the record it then is and how where
 *   its own log does not say, or the why;
 *   `report` a resume's line where its kind of session reports one
 */

const ROUTE_TYPED = "typing into the live session";
const ROUTE_RELAUNCH = "stop and --bg --resume";
const ROUTE_REAPED = "--bg --resume, the reaper having stopped it";

/**
 * The log line for one resume.
 * @param {string} name
 * @param {SyntheticResumes} rec  after the try
 * @param {string} route
 * @param {string|null} failed
 */
const buildLine = (name, rec, route, failed) =>
	`${failed ? "could not resume" : "resumed"} ${name}, whose last turn the harness ended on a synthetic reply at ${iso(rec.at)}, by ${route}, try ${rec.tries} of ${SYNTHETIC_TRIES}${failed ? `: ${failed}` : ""}`;

/**
 * The record of stop `at`: `was` where it is that stop's; else afresh, its
 * count carried where no model reply came since the loop's last resume.
 * @param {SyntheticResumes|undefined} was
 * @param {number} at
 * @param {SessionRef} ref
 * @param {Tick["io"]} io
 * @returns {SyntheticResumes}
 */
function recordOf(was, at, ref, io) {
	if (was?.at === at) return was;
	const carried =
		was?.triedAt !== undefined &&
		io.hasRepliedSince(ref, was.triedAt) === false;
	return { at, tries: carried ? was.tries : 0, resumed: was?.resumed ?? 0 };
}

/**
 * Stop `s`'s job, unless the reaper already did, then `claude --bg --resume`
 * it with the synthetic prompt; `rec` the try it makes or settles. Never off
 * an unread listing, which cannot tell a live job from a stopped one.
 * @template T
 * @param {Subject<T>} s
 * @param {SyntheticResumes} rec
 * @param {boolean} reaped
 * @param {Tick} seen
 * @returns {T}
 */
function relaunch(s, rec, reaped, { agents, io }) {
	const route = reaped ? ROUTE_REAPED : ROUTE_RELAUNCH;
	/** @param {string} why */
	const failed = (why) => {
		s.report(buildLine(s.name, rec, route, why));
		return s.keep(rec);
	};
	if (!agents) return failed("the listing is unread, so it is not stopped");
	const { sessionId, cwd } = io.resumeTargetOf(s.ref);
	if (!sessionId) return failed("no session id read for it");
	const stopFailed = reaped ? null : s.stop();
	if (stopFailed) return failed(`stop: ${stopFailed}`);
	const r = s.resume({ sessionId, cwd }, rec);
	if (typeof r === "string") return failed(r);
	s.report(buildLine(s.name, rec, r.how ? `${route}, ${r.how}` : route, null));
	return r.out;
}

/**
 * Resume `s`'s stop: typed into its job unless the reaper stopped it, where
 * the typing fails by relaunch.
 * @template T
 * @param {Subject<T>} s
 * @param {SyntheticResumes} rec
 * @param {Tick} seen
 * @returns {T}
 */
function resume(s, rec, seen) {
	const { now, io } = seen;
	const tried = {
		...rec,
		tries: rec.tries + 1,
		triedAt: now,
		resumed: rec.resumed + 1,
	};
	if (io.jobStateOf(s.ref)?.state === "stopped")
		return relaunch(s, tried, true, seen);
	const typeFailed = io.type(s.ref, SYNTHETIC_PROMPT);
	if (typeFailed) {
		io.log(`could not type the resume into ${s.name}: ${typeFailed}`);
		return relaunch(s, tried, false, seen);
	}
	const typed = { ...tried, attachAt: now };
	s.report(buildLine(s.name, typed, ROUTE_TYPED, null));
	return s.keep(typed);
}

/**
 * `s`'s synthetic stop this tick, read at `at`: a typed resume judged once the
 * attach-verdict window passes, arrived where the transcript no longer reads
 * that stop, else the same try relaunched; else the SYNTHETIC_STOP row's act,
 * its give-up logged once. Null where it leaves `s` as it was: its reading
 * unread, a typed resume in flight, or no stop read and none in flight.
 * @template T
 * @param {Subject<T>} s
 * @param {import("./block-cause.js").IdleReading} at
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {T|null}
 */
function judgeStop(s, at, mode, seen) {
	const { now, io } = seen;
	const was = s.was;
	if (at === "unread") return null;
	if (was?.attachAt !== undefined) {
		if (now - was.attachAt < ATTACH_VERDICT_MS) return null;
		const { attachAt: _, ...settled } = was;
		if (at !== was.at) return s.keep(settled);
		if (!s.admitted()) return null;
		io.log(
			`${s.name} still reads its synthetic stop after the typed resume, so it is stopped and resumed`,
		);
		return relaunch(s, settled, false, seen);
	}
	if (at === null) return null;
	const rec = recordOf(was, at, s.ref, io);
	const act = blockAct(
		{
			cause: "SYNTHETIC_STOP",
			since: Math.max(at, rec.triedAt ?? 0),
			tries: rec.tries,
		},
		mode,
		now,
	);
	if (act === "none" && !rec.spent) {
		io.log(
			`stopped trying to resume ${s.name} after ${rec.tries} resumes of its synthetic stop at ${iso(at)}: check-ghost-jobs reports it`,
		);
		return s.keep({ ...rec, spent: true });
	}
	if (act !== "resume" || !s.admitted()) return s.keep(rec);
	return resume(s, rec, seen);
}

/**
 * Whether the loop leaves `l` to other acts: one it resumes after an API
 * error, holds stopped or limit-held, owes a hand-off or a step resume.
 * @param {LoopLaunch} l
 */
const isLeftToOtherActs = (l) =>
	isResuming(l) ||
	isHeld(l) ||
	isStepResume(l) ||
	isLimitHeld(l) ||
	l.handOffTries !== undefined;

/**
 * Whether a synthetic stop of `l`'s is this cause's to act on.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isOwnSyntheticStop = (l) => isActionable(l) && !isLeftToOtherActs(l);

/**
 * Whether `l`'s job, gone from the listing, still owes the loop a synthetic
 * stop's resume, so the launch is not judged finished: its typed resume is in
 * flight, or its job reads a stop whose resumes are not spent.
 * @param {LoopLaunch} l
 * @param {import("./refill-blocks.js").BlockIo} io
 */
function isOwedResume(l, io) {
	if (!isOwnSyntheticStop(l)) return false;
	if (l.synthetic?.attachAt !== undefined) return true;
	const at = io.syntheticStopOf(l);
	if (typeof at !== "number") return false;
	return !(l.synthetic?.at === at && l.synthetic.spent);
}

/**
 * Launch `l` as a Subject: each resume logged and commented on its issues,
 * a relaunch recorded as the launch it becomes.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {Subject<LoopLaunch>}
 */
function launchSubject(l, seen) {
	const { now, io } = seen;
	return {
		name: launchName(l),
		ref: l,
		was: l.synthetic,
		admitted: () => isRunAdmitted(launchName(l), seen),
		keep: (rec) => ({ ...l, synthetic: rec }),
		stop: () => stopJob(l, io),
		resume: (target, rec) => {
			const r = io.resumeStopped(l, SYNTHETIC_PROMPT, target);
			if (r.failed !== null) return r.failed;
			const out = {
				...relaunched(l, { ...r, fromSessionId: target.sessionId }, now, {
					tookSlot: false,
				}),
				synthetic: rec,
			};
			io.writeLaunch(out);
			return { out, how: buildResumedHow(r) };
		},
		report: (line) => {
			io.log(line);
			io.comment(l, `Refill loop: ${line}.`);
		},
	};
}

/**
 * The tick's acts on the launches the harness ended on a synthetic reply
 * (workflow-core#5324), each actionable one not left to other acts judged by judgeStop.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch[]}
 */
function actOnSynthetic(launches, mode, seen) {
	return launches.map((l) => {
		if (!isOwnSyntheticStop(l)) return l;
		const at = seen.io.syntheticStopOf(l);
		return judgeStop(launchSubject(l, seen), at, mode, seen) ?? l;
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

module.exports = { actOnSynthetic, buildFinishNote, isOwedResume, judgeStop };
