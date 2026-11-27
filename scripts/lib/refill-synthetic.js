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
 *   attachAt?: number, spent?: true}} SyntheticResumes
 */
/**
 * @template T
 * @typedef {{name: string, ref: SessionRef, was?: SyntheticResumes,
 *   admitted: () => boolean, keep: (rec: SyntheticResumes) => T,
 *   stop: () => string|null,
 *   resume: (target: StoppedTarget, rec: SyntheticResumes) =>
 *     {out: T, how?: string}|string,
 *   report: (line: string) => void}} Subject
 */

const ROUTE_TYPED = "typing into the live session";
const ROUTE_RELAUNCH = "stop and --bg --resume";
const ROUTE_REAPED = "--bg --resume, the reaper having stopped it";

/**
 * @param {string} name
 * @param {SyntheticResumes} rec
 * @param {string} route
 * @param {string|null} failed
 */
const buildLine = (name, rec, route, failed) =>
	`${failed ? "could not resume" : "resumed"} ${name}, whose last turn the harness ended on a synthetic reply at ${iso(rec.at)}, by ${route}, try ${rec.tries} of ${SYNTHETIC_TRIES}${failed ? `: ${failed}` : ""}`;

/**
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

/** @param {LoopLaunch} l */
const isLeftToOtherActs = (l) =>
	isResuming(l) ||
	isHeld(l) ||
	isStepResume(l) ||
	isLimitHeld(l) ||
	l.handOffTries !== undefined;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isOwnSyntheticStop = (l) => isActionable(l) && !isLeftToOtherActs(l);

/**
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

/** @param {LoopLaunch} l */
const buildFinishNote = (l) =>
	l.synthetic?.resumed
		? `; resumed ${l.synthetic.resumed} time(s) after the harness ended its turn on a synthetic reply`
		: "";

module.exports = { actOnSynthetic, buildFinishNote, isOwedResume, judgeStop };
