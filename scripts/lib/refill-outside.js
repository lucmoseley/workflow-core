/*
 * refill-outside.js — the refill loop's resumes of background sessions it did
 * not launch, the founder's and a dispatcher's (#4815): each blocked on a
 * transient API error is typed into on the schedule of #2359 (the API-error
 * resume schedule), through the tick's network gate, and falls
 * back to a stop and `claude --bg --resume` under its own id where the typed
 * one is unseen; where that resume fails after the stop, it is tried again
 * when next due. Unlike a loop launch it is never held stopped between tries,
 * takes no slot, and is never parked, labelled or commented on: at the cap the
 * loop logs that it stopped and leaves it blocked on its last error, which the
 * job list shows as needs input (#4689). Where the founder has typed into it
 * since its stop the loop leaves that stop alone.
 *
 * Its records live in their own file, OUTSIDE_FILE, as they are no launches:
 * nothing that counts, ranks or finishes launches reads them.
 */

const { API_PROMPT } = require("./loop-prompts.js");
const { RESUME_CAP, blockAct, nextTryAt } = require("./block-act.js");
const {
	blockedIdsOf,
	buildResumedHow,
	iso,
} = require("./refill-block-core.js");
const {
	isTakenSinceStop,
	netGateOf,
	typedVerdict,
} = require("./refill-blocks.js");

const OUTSIDE_FILE = ".refill-outside.json";

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").CauseOf} CauseOf
 * @typedef {{seat: string, jobId: string, name: string, cwd: string,
 *   sessionId: string, since?: number, tries: number, triedAt?: number,
 *   nextAt?: number, attachAt?: number, handsOff?: true, capped?: true,
 *   held?: {sessionId: string, cwd: string}}}
 *   Outside  a session the loop took up: `since`, the first tick that read its
 *   current API-error stop, absent between stops; `tries`, the resumes the loop
 *   made since it took it up, the last at `triedAt`, the next due at `nextAt`;
 *   `attachAt`, a typed resume not yet seen arrive; `handsOff`, the founder
 *   typed into it since this stop; `capped`, its resumes reached the cap,
 *   after which the loop leaves this stop alone; `held`, the session the
 *   loop stopped whose `--bg --resume` failed, resumed when next due
 */

/**
 * The launch-shaped record the BlockIo ports read for an outside session: its
 * seat, job, session and cwd.
 * @param {Outside} o
 * @returns {JobLaunch}
 */
const launchOf = (o) => ({
	root: o.cwd,
	issues: [],
	prompt: "",
	seat: o.seat,
	jobId: o.jobId,
	sessionId: o.sessionId,
	launchedAt: o.since ?? 0,
	finishedAt: null,
});

/** @param {Outside} o */
const nameOf = (o) => `${o.name} (${o.jobId}, started outside the loop)`;

/**
 * `o` between stops: its resume count kept, its stop's fields dropped; none
 * where it was capped.
 * @param {Outside} o
 * @returns {Outside|null}
 */
function betweenStops(o) {
	if (o.capped) return null;
	const { since: _, attachAt: __, handsOff: ___, held: ____, ...rest } = o;
	return rest;
}

/**
 * `o`, listed live again, so no longer held for a retry.
 * @param {Outside} o
 * @returns {Outside}
 */
function withoutHeld(o) {
	const { held: _, ...rest } = o;
	return rest;
}

/**
 * The record a registry row starts, or null where it is no background job or
 * names no seat, job, session or cwd.
 * @param {AgentRecord} a
 * @param {number} now
 * @returns {Outside|null}
 */
function takenUp(a, now) {
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
 * prompt: `o` moved onto the job it runs as, else marked `held` for a retry
 * when next due.
 * @param {Outside} o
 * @param {{sessionId: string, cwd: string}} target
 * @param {Tick} seen
 * @returns {Outside}
 */
function relaunch(o, target, { io }) {
	const r = io.resumeStopped(launchOf(o), API_PROMPT, target);
	if (r.failed !== null) {
		io.log(
			`could not resume ${nameOf(o)} by --bg --resume: ${r.failed}; it stays stopped until the next try, due ${iso(o.nextAt ?? 0)}`,
		);
		return { ...o, held: target };
	}
	io.log(`resumed ${nameOf(o)} by --bg --resume, ${buildResumedHow(r)}`);
	const { held: _, ...rest } = o;
	return { ...rest, jobId: r.jobId, sessionId: r.sessionId ?? o.sessionId };
}

/**
 * Stop `o`'s session and relaunch it under its full id, its typed resume
 * unseen; never where it took a prompt since its stop (isTakenSinceStop).
 * @param {Outside} o  its typed resume settled
 * @param {Tick} seen
 * @returns {Outside}
 */
function fallBack(o, seen) {
	const { io } = seen;
	const l = launchOf(o);
	if (isTakenSinceStop(l, nameOf(o), io)) return o;
	const { sessionId, cwd } = io.resumeTargetOf(l);
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
 * `o`, stopped by the loop with its relaunch failed, tried again once due: a
 * try of its own; at the cap, logged and dropped, left stopped.
 * @param {Outside & {held: {sessionId: string, cwd: string}}} o
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function retryHeld(o, seen) {
	const { now, io } = seen;
	if (o.tries >= RESUME_CAP) {
		io.log(
			`stopped trying to resume ${nameOf(o)} after ${o.tries} resumes: it stays stopped on its last error`,
		);
		return null;
	}
	if ((o.nextAt ?? 0) > now || seen.barred || !netGateOf(seen).admit(nameOf(o)))
		return o;
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
	const failed = io.type(launchOf(o), API_PROMPT);
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
		const verdict = typedVerdict(o.attachAt, launchOf(o), seen);
		if (verdict === "pending") return o;
		const { attachAt: _, ...settled } = o;
		if (verdict === "arrived") return settled;
		if (seen.barred || !netGateOf(seen).admit(nameOf(o))) return o;
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
	if (act !== "resume" || seen.barred || !netGateOf(seen).admit(nameOf(o)))
		return o;
	return resume(o, seen);
}

/**
 * `o` this tick, blocked live on the listing: taken up on a transient API
 * error, left alone where capped or the founder has typed since its stop, else
 * acted on; null where it is blocked on anything else.
 * @param {Outside} o
 * @param {AgentRecord} row
 * @param {CauseOf} causeOf
 * @param {Tick} seen
 * @returns {Outside|null}
 */
function judge(o, row, causeOf, seen) {
	const { io, now } = seen;
	const l = launchOf(o);
	const reading = causeOf(l, row);
	if (reading.cause !== "API_ERROR" || reading.sub !== "transient")
		return o.tries > 0 ? betweenStops(o) : null;
	if (o.capped || o.handsOff) return o;
	const stopped = { ...o, since: o.since ?? now };
	if (io.hasFounderTypedSinceStop(l)) {
		io.log(
			`leaving ${nameOf(o)} alone: the founder typed into it since its API-error stop`,
		);
		return { ...stopped, handsOff: true };
	}
	return actOn(stopped, seen);
}

/**
 * The record of a session the registry lists live, `o` where the loop had
 * one, else `fresh`: judged where the listing shows it blocked, else between
 * stops.
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
	return o ? betweenStops(o) : null;
}

/**
 * The tick's resumes of the background sessions on every seat the registry
 * lists live that no launch in `launches` is (#4815): each blocked on a
 * transient API error taken up and acted on, every record of one no longer
 * listed dropped, save one the loop stopped and holds for a retry (retryHeld).
 * None off an unread listing, which cannot tell blocked from working; a
 * barred tick types nothing.
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {AgentRecord[]} registry  the registry listing's agents
 * @param {CauseOf} causeOf
 * @param {Tick} seen
 */
function actOnOutside(launches, registry, causeOf, seen) {
	if (!seen.agents) return;
	const known = new Set(
		launches.flatMap((l) => [l.jobId, l.copiedFrom].filter(Boolean)),
	);
	const blocked = blockedIdsOf(seen.agents);
	const had = seen.io.readOutside();
	const byJob = new Map(had.map((o) => [`${o.seat}\0${o.jobId}`, o]));
	/** @type {(Outside|null)[]} */
	const next = [];
	for (const row of registry) {
		const fresh = takenUp(row, seen.now);
		if (!fresh || known.has(fresh.jobId)) continue;
		const key = `${fresh.seat}\0${fresh.jobId}`;
		const o = byJob.get(key);
		byJob.delete(key);
		next.push(listedTurn(o, fresh, { row, blocked, causeOf }, seen));
	}
	for (const o of byJob.values())
		if (o.held) next.push(retryHeld({ ...o, held: o.held }, seen));
	const kept = next.filter((o) => o !== null);
	if (JSON.stringify(kept) !== JSON.stringify(had)) seen.io.writeOutside(kept);
}

module.exports = { OUTSIDE_FILE, actOnOutside };
