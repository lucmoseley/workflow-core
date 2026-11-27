const { API_PROMPT, SYNTHETIC_PROMPT } = require("./loop-prompts.js");
const { RESUME_CAP, blockAct, nextTryAt } = require("./block-act.js");
const {
	blockedIdsOf,
	buildResumedHow,
	iso,
	withUnretired,
} = require("./refill-block-core.js");
const {
	isRunAdmitted,
	isTakenSinceStop,
	typedVerdict,
} = require("./refill-blocks.js");
const { buildGiveUpFix, withRetried } = require("./refill-retire.js");
const { judgeStop } = require("./refill-synthetic.js");
const { shortJobId } = require("./job-paths.js");
const { REAPED_KEEP_MS, reapedKey } = require("./reaped-jobs.js");

const MIN_MS = 60 * 1000;
// guess, workflow-core#4871
const RE_ATTEMPT_GAPS_MS = [1, 2, 4].map((m) => m * MIN_MS);
const RE_ATTEMPTS = RE_ATTEMPT_GAPS_MS.length;

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").SessionRef} SessionRef
 * @typedef {import("./refill-blocks.js").CauseOf} CauseOf
 * @typedef {import("./refill-blocks.js").Unretired} Unretired
 * @typedef {import("./refill-blocks.js").StoppedTarget} StoppedTarget
 * @typedef {{seat: string, jobId: string, name: string, cwd: string,
 *   sessionId: string, since?: number, tries: number, triedAt?: number,
 *   nextAt?: number, attachAt?: number, handsOff?: true, typedUnread?: true,
 *   capped?: true,
 *   held?: StoppedTarget, reAttempts?: number, reAttemptAt?: number,
 *   unretired?: Unretired[],
 *   synthetic?: import("./refill-synthetic.js").SyntheticResumes}}
 *   Outside
 */

/**
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
 * @param {Outside} o
 * @returns {Outside}
 */
function withoutHeld(o) {
	const { held: _, reAttempts: __, reAttemptAt: ___, ...rest } = o;
	return rest;
}

/**
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
 * @param {Outside} o
 * @param {StoppedTarget} target
 * @param {Tick} seen
 * @param {number} [spent]
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
 * @param {Outside} o
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
 * @param {Outside & {held: StoppedTarget}} o
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function retryHeld(o, seen) {
	const { now, io } = seen;
	const isTryDue = (o.nextAt ?? 0) <= now;
	const isReAttemptDue = o.reAttemptAt !== undefined && o.reAttemptAt <= now;
	if (!(isTryDue || isReAttemptDue) || !isRunAdmitted(nameOf(o), seen))
		return o;
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
		if (!isRunAdmitted(nameOf(o), seen)) return o;
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
	if (act !== "resume" || !isRunAdmitted(nameOf(o), seen)) return o;
	return resume(o, seen);
}

/**
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
		// workflow-core#4815
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
 * @param {Outside} o
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function unlistedTurn(o, seen) {
	if (o.held) return retryHeld({ ...o, held: o.held }, seen);
	if (!o.synthetic) return null;
	if (o.synthetic.spent)
		return seen.now - o.synthetic.at < REAPED_KEEP_MS ? o : null;
	const at = seen.io.syntheticStopOf(sessionRefOf(o));
	if (at === null && o.synthetic.attachAt === undefined) return null;
	return judgeSynthetic(o, seen, at);
}

/**
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
		admitted: () => isRunAdmitted(nameOf(o), seen),
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
 * @param {Outside} o
 * @param {Tick} seen
 * @param {import("./block-cause.js").IdleReading} [at]
 * @returns {Outside}
 */
const judgeSynthetic = (
	o,
	seen,
	at = seen.io.syntheticStopOf(sessionRefOf(o)),
) => judgeStop(syntheticSubject(o, seen), at, "normal", seen) ?? o;

/**
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
 * @param {Outside} o
 * @param {Tick["io"]} io
 * @returns {Outside}
 */
const withOriginalsRetried = (o, io) =>
	withRetried(o, nameOf(o), io, (u, original, failed) =>
		io.log(`${nameOf(o)}: ${buildGiveUpFix(u, original, failed)}`),
	);

/**
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {AgentRecord[]} registry
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

/**
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @returns {string[]}
 */
const launchIdsOf = (launches) =>
	launches.flatMap((l) =>
		[l.jobId, l.copiedFrom, l.sessionId, ...(l.pastSessionIds ?? [])].filter(
			/** @returns {id is string} */ (id) =>
				typeof id === "string" && id !== "",
		),
	);

/**
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
		...launchIdsOf(launches),
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
 * @param {Outside[]} had
 * @param {{launches: import("./refill-loop.js").LoopLaunch[],
 *   registry: AgentRecord[], causeOf: CauseOf, agents: AgentRecord[]}}
 *   listing
 * @param {Tick} seen
 * @returns {Outside[]}
 */
function turnOutside(had, { launches, registry, causeOf, agents }, seen) {
	const known = new Set([
		...launchIdsOf(launches),
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
		if (!fresh) continue;
		const key = `${fresh.seat}\0${fresh.jobId}`;
		const o = byJob.get(key);
		byJob.delete(key);
		if (known.has(fresh.jobId) || known.has(fresh.sessionId)) continue;
		keep(listedTurn(o, fresh, { row, blocked, causeOf }, seen), o ?? fresh);
	}
	for (const o of byJob.values()) keep(unlistedTurn(o, seen), o);
	return next;
}

module.exports = { actOnOutside };
