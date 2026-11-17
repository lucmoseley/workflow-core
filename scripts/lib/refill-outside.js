/*
 * refill-outside.js — the refill loop's resumes of background sessions it did
 * not launch, the founder's and a dispatcher's (#4815): each blocked on a
 * transient API error is typed into on the schedule of #2359 (the API-error
 * resume schedule), through the tick's network gate, and falls
 * back to a stop and `claude --bg --resume` under its own id where the typed
 * one is unseen. Unlike a loop launch it is not stopped to wait between tries,
 * takes no slot, and is never parked, labelled or commented on: at the cap the
 * loop logs that it stopped and leaves it blocked on its last error, which the
 * job list shows as needs input (#4689). Only where that `--bg --resume`
 * fails after the stop is it stopped, until a relaunch works: at most 3 short
 * re-attempts after each of the 16 scheduled tries, none of them a try, plus
 * one last relaunch at the cap, so 65 relaunch attempts for one stop at most
 * (#4871), never one without `--resume` (#2359).
 *
 * A `done` one the harness ended on its own "No response requested." record
 * (#5324) is resumed as a loop launch is (lib/refill-synthetic.js). One the
 * reaper stopped before the loop read that stop has left the listing, so it
 * is reached through the reaper's journal (lib/reaped-jobs.js) (#5331).
 *
 * Its records live in their own file, lib/refill-dir.js's OUTSIDE_FILE, as
 * they are no launches:
 * nothing that counts, ranks or finishes launches reads them.
 */

const { API_PROMPT, SYNTHETIC_PROMPT } = require("./loop-prompts.js");
const { RESUME_CAP, blockAct, nextTryAt } = require("./block-act.js");
const {
	blockedIdsOf,
	buildResumedHow,
	iso,
	withUnretired,
} = require("./refill-block-core.js");
const {
	isTakenSinceStop,
	netGateOf,
	typedVerdict,
} = require("./refill-blocks.js");
const { buildGiveUpFix, withRetried } = require("./refill-retire.js");
const { judgeStop } = require("./refill-synthetic.js");
const { shortJobId } = require("./job-paths.js");

const MIN_MS = 60 * 1000;
/* The short re-attempts a failed scheduled relaunch earns, each no sooner
 * than its gap after the failure before it. The gaps: untraced (delegated,
 * #4871), their doubling from docs/practice/process-supervision-and-oom.md
 * §Restart policy. */
const RE_ATTEMPT_GAPS_MS = [1, 2, 4].map((m) => m * MIN_MS);
/* How many of them: untraced (delegated, #4871). */
const RE_ATTEMPTS = RE_ATTEMPT_GAPS_MS.length;

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").SessionRef} SessionRef
 * @typedef {import("./refill-blocks.js").CauseOf} CauseOf
 * @typedef {import("./refill-blocks.js").Unretired} Unretired
 * @typedef {import("./refill-blocks.js").ResumeTarget & {sessionId: string}}
 *   StoppedTarget  what a stopped session's `--bg --resume` runs under
 * @typedef {{seat: string, jobId: string, name: string, cwd: string,
 *   sessionId: string, since?: number, tries: number, triedAt?: number,
 *   nextAt?: number, attachAt?: number, handsOff?: true, typedUnread?: true,
 *   capped?: true,
 *   held?: StoppedTarget, reAttempts?: number, reAttemptAt?: number,
 *   unretired?: Unretired[],
 *   synthetic?: import("./refill-synthetic.js").SyntheticResumes}}
 *   Outside  a session the loop took up: `since`, the first tick that read its
 *   current API-error stop, absent between stops; `tries`, the resumes the loop
 *   made since it took it up, the last at `triedAt`, the next due at `nextAt`;
 *   `attachAt`, a typed resume not yet seen arrive; `handsOff`, the founder
 *   typed into it since this stop; `typedUnread`, whether it
 *   did is unread, logged once; `capped`, its resumes reached the cap,
 *   after which the loop leaves this stop alone; `held`, the session the
 *   loop stopped whose `--bg --resume` failed, with `reAttempts`, the short
 *   re-attempts spent since its last scheduled try, the next due at
 *   `reAttemptAt`, absent once they are spent;
 *   `unretired`, the originals of its copies whose jobs would not retire;
 *   `synthetic`, its resumes of its current synthetic stop (#5324)
 */

/**
 * The session the BlockIo ports read for `o`.
 * @param {Outside} o
 * @returns {SessionRef}
 */
const sessionRefOf = (o) => ({
	root: o.cwd,
	seat: o.seat,
	jobId: o.jobId,
	sessionId: o.sessionId,
});

/** @param {Outside} o */
const nameOf = (o) => `${o.name} (${o.jobId}, started outside the loop)`;

/**
 * Whether the tick may set `o` running: launching unbarred and the network
 * up (netGateOf, which logs a resume it holds back).
 * @param {Outside} o
 * @param {Tick} seen
 */
const isRunAdmitted = (o, seen) =>
	!seen.barred && netGateOf(seen).admit(nameOf(o));

/**
 * `o` between stops: its resume count kept, its stop's fields dropped; none
 * where it was capped.
 * @param {Outside} o
 * @returns {Outside|null}
 */
function betweenStops(o) {
	if (o.capped) return null;
	const {
		since: _,
		attachAt: __,
		handsOff: ___,
		typedUnread: ____,
		...rest
	} = withoutHeld(o);
	return rest;
}

/**
 * `o` kept only for its unretired originals: between stops, afresh where it
 * was capped.
 * @param {Outside} o
 * @returns {Outside}
 */
function retiringOnly(o) {
	const { seat, jobId, name, cwd, sessionId, unretired } = o;
	return (
		betweenStops(o) ?? {
			seat,
			jobId,
			name,
			cwd,
			sessionId,
			tries: 0,
			unretired,
		}
	);
}

/**
 * `o` live again, so no longer held for a relaunch.
 * @param {Outside} o
 * @returns {Outside}
 */
function withoutHeld(o) {
	const { held: _, reAttempts: __, reAttemptAt: ___, ...rest } = o;
	return rest;
}

/**
 * The record a registry row starts, or null where it is no background job or
 * names no seat, job, session or cwd.
 * @param {AgentRecord} a
 * @param {number} now
 * @returns {Outside|null}
 */
function buildOutside(a, now) {
	if (a.kind !== "background" || !a.id || !a.seat || !a.cwd) return null;
	return {
		seat: a.seat,
		jobId: a.id,
		name: a.name ?? a.id,
		cwd: a.cwd,
		sessionId: a.sessionId,
		since: now,
		tries: 0,
	};
}

/**
 * `claude --bg --resume` of `o`'s stopped session `target` with the resume
 * prompt: `o` moved onto the job it runs as, logged, else why it failed.
 * @param {Outside} o
 * @param {StoppedTarget} target
 * @param {Tick["io"]} io
 * @param {string} [prompt]
 * @returns {Outside|string}
 */
function relaunchOrWhy(o, target, io, prompt = API_PROMPT) {
	const r = io.resumeStopped(sessionRefOf(o), prompt, target);
	if (r.failed !== null) return r.failed;
	io.log(`resumed ${nameOf(o)} by --bg --resume, ${buildResumedHow(r)}`);
	return withUnretired(
		{
			...withoutHeld(o),
			jobId: r.jobId,
			sessionId: r.sessionId ?? o.sessionId,
		},
		r,
	);
}

/**
 * Relaunch `o`'s stopped session `target`; where that fails, `o` marked
 * `held` for the next short re-attempt, or once those are spent for its next
 * scheduled try.
 * @param {Outside} o
 * @param {StoppedTarget} target
 * @param {Tick} seen
 * @param {number} [spent]  which short re-attempt this is, 0 for a
 *   scheduled try
 * @returns {Outside}
 */
function relaunch(o, target, { io, now }, spent = 0) {
	const moved = relaunchOrWhy(o, target, io);
	if (typeof moved !== "string") return moved;
	const gap = RE_ATTEMPT_GAPS_MS[spent];
	const reAttemptAt = gap === undefined ? undefined : now + gap;
	const due = Math.min(reAttemptAt ?? Number.POSITIVE_INFINITY, o.nextAt ?? 0);
	const what =
		spent === 0
			? `could not resume ${nameOf(o)} by --bg --resume`
			: `re-attempt ${spent} of ${RE_ATTEMPTS} to resume ${nameOf(o)} by --bg --resume failed`;
	io.log(
		`${what}: ${moved}; it stays stopped until the next attempt, due ${iso(due)}`,
	);
	return {
		...withoutHeld(o),
		held: target,
		reAttempts: spent,
		...(reAttemptAt === undefined ? {} : { reAttemptAt }),
	};
}

/**
 * The loop's last act on `o`, held at the cap: one more relaunch, and where
 * that fails too, logged and dropped, left stopped.
 * @param {Outside & {held: StoppedTarget}} o
 * @param {Tick["io"]} io
 * @returns {Outside|null}
 */
function lastRelaunch(o, io) {
	const moved = relaunchOrWhy(o, o.held, io);
	if (typeof moved !== "string") return moved;
	io.log(
		`stopped trying to resume ${nameOf(o)} after ${o.tries} resumes, its last --bg --resume failing too (${moved}): it stays stopped on its last error`,
	);
	return null;
}

/**
 * Stop `o`'s session and relaunch it under its full id, its typed resume
 * unseen; never where it took a turn since its stop or that cannot be told
 * (isTakenSinceStop), the try already counted.
 * @param {Outside} o  its typed resume settled
 * @param {Tick} seen
 * @returns {Outside}
 */
function fallBack(o, seen) {
	const { io } = seen;
	const ref = sessionRefOf(o);
	if (isTakenSinceStop(ref, nameOf(o), io, o.since) !== false) return o;
	const { sessionId, cwd } = io.resumeTargetOf(ref);
	const what = `${nameOf(o)} by stop and --bg --resume, the typed one unseen`;
	if (!sessionId) {
		io.log(`could not resume ${what}: no session id read for it`);
		return o;
	}
	const stop = io.stop(o.seat, o.jobId);
	if (!stop.ok) {
		io.log(`could not resume ${what}: stop: ${stop.why}`);
		return o;
	}
	return relaunch(o, { sessionId, cwd }, seen);
}

/**
 * `o`, stopped by the loop with its relaunch failed, relaunched again once
 * its scheduled try or a short re-attempt is due, on a tick that admits it;
 * one that does not spends nothing. At the cap, its last relaunch: null where
 * that fails too.
 * @param {Outside & {held: StoppedTarget}} o
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function retryHeld(o, seen) {
	const { now, io } = seen;
	const isTryDue = (o.nextAt ?? 0) <= now;
	const isReAttemptDue = o.reAttemptAt !== undefined && o.reAttemptAt <= now;
	if (!(isTryDue || isReAttemptDue) || !isRunAdmitted(o, seen)) return o;
	if (!isTryDue) return relaunch(o, o.held, seen, (o.reAttempts ?? 0) + 1);
	if (o.tries >= RESUME_CAP) return lastRelaunch(o, io);
	const tries = o.tries + 1;
	return relaunch(
		{ ...o, tries, triedAt: now, nextAt: nextTryAt(tries, now) },
		o.held,
		seen,
	);
}

/**
 * Type the resume into `o`'s live session; where the typing fails, fallBack
 * at once. One more try either way.
 * @param {Outside} o
 * @param {Tick} seen
 * @returns {Outside}
 */
function resume(o, seen) {
	const { io, now } = seen;
	const tries = o.tries + 1;
	const tried = { ...o, tries, triedAt: now, nextAt: nextTryAt(tries, now) };
	const failed = io.type(sessionRefOf(o), API_PROMPT);
	if (failed) {
		io.log(`could not type the resume into ${nameOf(o)}: ${failed}`);
		return fallBack(tried, seen);
	}
	io.log(
		`resume ${tries} of ${RESUME_CAP} after an API error, ${nameOf(o)}, by typing into the live session; next due ${iso(tried.nextAt)}`,
	);
	return { ...tried, attachAt: now };
}

/**
 * The tick's act on `o`, blocked on a transient API error this tick.
 * @param {Outside & {since: number}} o
 * @param {Tick} seen
 * @returns {Outside}
 */
function actOn(o, seen) {
	const { now, io } = seen;
	if (o.attachAt !== undefined) {
		const verdict = typedVerdict(o.attachAt, sessionRefOf(o), seen);
		if (verdict === "pending") return o;
		const { attachAt: _, ...settled } = o;
		if (verdict === "arrived") return settled;
		if (!isRunAdmitted(o, seen)) return o;
		return fallBack(settled, seen);
	}
	const act = blockAct(
		{
			cause: "API_ERROR",
			sub: "transient",
			since: o.since,
			tries: o.tries,
			nextAt: o.nextAt,
			triedAt: o.triedAt,
		},
		"normal",
		now,
	);
	if (act === "stop-and-park") {
		io.log(
			`stopped trying to resume ${nameOf(o)} after ${o.tries} resumes: it stays blocked on its last error`,
		);
		return { ...o, capped: true };
	}
	if (act !== "resume" || !isRunAdmitted(o, seen)) return o;
	return resume(o, seen);
}

/**
 * `o` this tick, blocked live on the listing: taken up on a transient API
 * error, left alone where capped or where the founder has typed since its
 * stop or that cannot be read, else acted on; null where it is blocked on
 * anything else.
 * @param {Outside} o
 * @param {AgentRecord} row
 * @param {CauseOf} causeOf
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function judge(o, row, causeOf, seen) {
	const { io, now } = seen;
	const ref = sessionRefOf(o);
	const reading = causeOf(ref, row, nameOf(o));
	if (reading.cause !== "API_ERROR" || reading.sub !== "transient")
		return o.tries > 0 ? betweenStops(o) : null;
	if (o.capped || o.handsOff) return o;
	const stopped = { ...o, since: o.since ?? now };
	const typed = io.hasFounderTypedSinceStop(ref);
	if (typed) {
		io.log(
			`leaving ${nameOf(o)} alone: the founder typed into it since its API-error stop`,
		);
		return { ...stopped, handsOff: true };
	}
	if (typed === null) {
		/* Unknown is not typed-into: it waits and is read again next tick, as
		 * the read may be passing (#4815); one whose stop row never shows is
		 * never resumed, the residual. */
		if (!o.typedUnread)
			io.log(
				`leaving ${nameOf(o)} alone while its transcript is unread or shows no API-error stop, so whether the founder typed since cannot be told`,
			);
		return { ...stopped, typedUnread: true };
	}
	const { typedUnread: _, ...read } = stopped;
	return actOn(read, seen);
}

/**
 * The record of a session the registry no longer lists: one held stopped
 * retried, one owing a synthetic stop's resume judged; null for any other.
 * @param {Outside} o
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function unlistedTurn(o, seen) {
	if (o.held) return retryHeld({ ...o, held: o.held }, seen);
	if (!o.synthetic || o.synthetic.spent) return null;
	const at = seen.io.syntheticStopOf(sessionRefOf(o));
	if (at === null && o.synthetic.attachAt === undefined) return null;
	return judgeSynthetic(o, seen, at);
}

/**
 * `o` as lib/refill-synthetic.js's Subject.
 * @param {Outside} o
 * @param {Tick} seen
 * @returns {import("./refill-synthetic.js").Subject<Outside>}
 */
function syntheticSubject(o, seen) {
	const { io } = seen;
	return {
		name: nameOf(o),
		ref: sessionRefOf(o),
		was: o.synthetic,
		admitted: isRunAdmitted(o, seen),
		keep: (rec) => ({ ...o, synthetic: rec }),
		stop: () => {
			const r = io.stop(o.seat, o.jobId);
			return r.ok ? null : r.why;
		},
		resume: (target, rec) => {
			const moved = relaunchOrWhy(o, target, io, SYNTHETIC_PROMPT);
			return typeof moved === "string"
				? moved
				: { out: { ...moved, synthetic: rec } };
		},
		report: (line) => io.log(line),
	};
}

/**
 * `o`'s synthetic stop this tick (#5324), judged by lib/refill-synthetic.js's
 * judgeStop; `o` unchanged where that leaves it so.
 * @param {Outside} o
 * @param {Tick} seen
 * @param {import("./block-cause.js").IdleReading} [at]  its reading, where
 *   already read this tick
 * @returns {Outside}
 */
const judgeSynthetic = (
	o,
	seen,
	at = seen.io.syntheticStopOf(sessionRefOf(o)),
) => judgeStop(syntheticSubject(o, seen), at, "normal", seen) ?? o;

/**
 * The record of a session the registry lists live, `o` where the loop had
 * one, else `fresh`: judged where the listing shows it blocked; else its
 * synthetic stop judged where its job store and transcript read one, or a
 * typed resume of one is in flight; else between stops.
 * @param {Outside|undefined} o
 * @param {Outside} fresh
 * @param {{row: AgentRecord, blocked: Set<string|undefined>, causeOf: CauseOf}}
 *   listed
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function listedTurn(o, fresh, { row, blocked, causeOf }, seen) {
	if (blocked.has(fresh.jobId))
		return judge(o ? withoutHeld(o) : fresh, row, causeOf, seen);
	const at = seen.io.syntheticStopOf(sessionRefOf(fresh));
	const pending = o?.synthetic?.attachAt !== undefined;
	if (typeof at === "number" || pending) {
		const { since: _, ...base } = fresh;
		return judgeSynthetic(o ?? base, seen, at);
	}
	return o ? betweenStops(o) : null;
}

/**
 * `o` with each original of its copies that would not retire tried again
 * (lib/refill-retire.js); one out of tries is logged.
 * @param {Outside} o
 * @param {Tick["io"]} io
 * @returns {Outside}
 */
const withOriginalsRetried = (o, io) =>
	withRetried(o, nameOf(o), io, (u, original, failed) =>
		io.log(`${nameOf(o)}: ${buildGiveUpFix(u, original, failed)}`),
	);

/**
 * The tick's resumes of the background sessions on every seat the registry
 * lists live that no launch in `launches` is (#4815): each copy's unretired
 * original tried again (#4829), each session blocked on a transient API error
 * taken up and acted on, every record of one no longer listed dropped, save
 * one the loop stopped and holds for a retry (retryHeld), one still owed a
 * synthetic stop's resume (unlistedTurn), and any record kept
 * while an original of its copy is unretired; and each the reaper stopped
 * on a synthetic stop the loop never read taken up (reapedTurn). Only the
 * retirements off an unread listing, which cannot tell blocked from working;
 * a barred tick types nothing.
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {AgentRecord[]} registry  the registry listing's agents
 * @param {CauseOf} causeOf
 * @param {Tick} seen
 */
function actOnOutside(launches, registry, causeOf, seen) {
	const { io, agents } = seen;
	const had = io.readOutside();
	const retried = had.map((o) => withOriginalsRetried(o, io));
	let kept = retried;
	if (agents) {
		const turned = turnOutside(
			retried,
			{ launches, registry, causeOf, agents },
			seen,
		);
		kept = [...turned, ...takeUpReaped({ launches, registry, turned }, seen)];
	}
	if (JSON.stringify(kept) !== JSON.stringify(had)) io.writeOutside(kept);
}

/** @param {import("./reaped-jobs.js").ReapedJob} j */
const reapedKey = (j) => `${j.seat}\0${j.jobId}\0${j.at}`;

/**
 * The records the reaper's journal entries the loop has not read start, each
 * entry read once: none for a launch's job or session, past or present, a
 * listed session, or one this tick's records hold, as their own acts reach
 * them. The entries read are remembered by key, never by a high-water mark.
 * @param {{launches: import("./refill-loop.js").LoopLaunch[],
 *   registry: AgentRecord[], turned: Outside[]}} known
 * @param {Tick} seen
 * @returns {Outside[]}
 */
function takeUpReaped({ launches, registry, turned }, seen) {
	const { jobs, read } = seen.io.readReaped();
	const wasRead = new Set(read);
	const unread = jobs.filter((j) => !wasRead.has(reapedKey(j)));
	if (unread.length === 0) return [];
	const taken = new Set([
		...launches.flatMap((l) => [
			l.jobId,
			l.copiedFrom,
			l.sessionId,
			...(l.pastSessionIds ?? []),
		]),
		...registry.flatMap((a) => [a.id, a.sessionId]),
		...turned.flatMap((o) => [o.jobId, o.sessionId]),
	]);
	const out = unread.flatMap((j) =>
		taken.has(j.jobId) || taken.has(j.sessionId) ? [] : reapedTurn(j, seen),
	);
	seen.io.writeReapedRead(jobs.map(reapedKey));
	return out;
}

/**
 * The record a job the reaper stopped starts (#5331): where its job store and
 * transcript read a synthetic stop, judged at once; none for any other, nor
 * where the reading will not read, which is logged as it is not read again.
 * @param {import("./reaped-jobs.js").ReapedJob} j
 * @param {Tick} seen
 * @returns {Outside[]}
 */
function reapedTurn({ seat, jobId, name, cwd, sessionId }, seen) {
	const o = { seat, jobId, name, cwd, sessionId, tries: 0 };
	const at = seen.io.syntheticStopOf(sessionRefOf(o));
	if (at === "unread")
		seen.io.log(
			`could not read whether ${nameOf(o)}, which the reaper stopped, was ended on a synthetic reply, so the loop does not resume it`,
		);
	if (typeof at !== "number") return [];
	const turned = judgeSynthetic(o, seen, at);
	return turned.synthetic ? [turned] : [];
}

/**
 * The records `had` after the tick's acts on the listed sessions.
 * @param {Outside[]} had
 * @param {{launches: import("./refill-loop.js").LoopLaunch[],
 *   registry: AgentRecord[], causeOf: CauseOf, agents: AgentRecord[]}}
 *   listing  `agents`, the tick's read listing
 * @param {Tick} seen
 * @returns {Outside[]}
 */
function turnOutside(had, { launches, registry, causeOf, agents }, seen) {
	const known = new Set([
		...launches.flatMap((l) => [l.jobId, l.copiedFrom].filter(Boolean)),
		...had.flatMap((o) =>
			(o.unretired ?? []).map((u) => shortJobId(u.sessionId)),
		),
	]);
	const blocked = blockedIdsOf(agents);
	const byJob = new Map(had.map((o) => [`${o.seat}\0${o.jobId}`, o]));
	/** @type {Outside[]} */
	const next = [];
	/** @param {Outside|null} turned @param {Outside} o */
	const keep = (turned, o) => {
		const k = turned ?? (o.unretired ? retiringOnly(o) : null);
		if (k) next.push(k);
	};
	for (const row of registry) {
		const fresh = buildOutside(row, seen.now);
		if (!fresh || known.has(fresh.jobId)) continue;
		const key = `${fresh.seat}\0${fresh.jobId}`;
		const o = byJob.get(key);
		byJob.delete(key);
		keep(listedTurn(o, fresh, { row, blocked, causeOf }, seen), o ?? fresh);
	}
	for (const o of byJob.values()) keep(unlistedTurn(o, seen), o);
	return next;
}

module.exports = { actOnOutside };
