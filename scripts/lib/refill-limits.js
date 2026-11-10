/*
 * refill-limits.js — the refill loop's acts on limit-blocked launches, behind
 * actOnLimits (workflow-core#4295): the hold (workflow-core#3735), the resume in place, the plan-seat
 * (workflow-core#3734) and overflow (workflow-core#3736) moves, their comments and retry spacing, and
 * the dispatch-ledger hold a held session keeps (workflow-core#3785). It is split from
 * lib/refill-blocks.js, whose other causes' acts change for reasons of their
 * own.
 */

const {
	blockAct,
	buildLimitParkWhy,
	holdBoundAt,
	nextTryAt,
} = require("./block-act.js");
const { LIMIT_PROMPT, MOVED_PROMPT } = require("./loop-prompts.js");
const { pickMoveSeat } = require("./refill-decide.js");
const { buildSeatName, isSameSeat, seatIdOf } = require("./refill-seats.js");
const { ledgerJobOf } = require("./refill-state.js");
const {
	blockedIdsOf,
	buildResumedHow,
	isActionable,
	isLimitHeld,
	isLive,
	iso,
	launchName,
	ledgerOf,
	parkOnceStopped,
	relaunched,
	stopJob,
	stopPark,
} = require("./refill-block-core.js");

const LIMIT_LOSS_TEXT =
	"Lost: its in-flight subagents, background tasks and monitors, and the warm prompt cache (one cache rewrite of its context).";

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Resumed} Resumed
 * @typedef {import("./refill-blocks.js").ResumeTarget} ResumeTarget
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").BlockIo} BlockIo
 * @typedef {{bar: "weekly"|"5-hour"|null, resets: string|null}} LimitRead  the
 *   limit a seat's reading shows a session stopped on, null where neither bar
 *   read, with its reset as read; from the reading, never the limit's text
 * @typedef {{at: number, sessionId: string, cwd: string, limit: LimitRead,
 *   resumedAt?: number, ledgerHeldUntil?: number, failedTries?: number,
 *   movedFrom?: MovedFrom}}
 *   LimitHeld  a limit-blocked session the loop stopped (workflow-core#3735): when, the
 *   session and directory its resume runs in, read before the stop, and its
 *   limit, read then, as a reset seat no longer shows it; `resumedAt`, a
 *   resume not yet judged; `ledgerHeldUntil`, when the ledger hold written for
 *   it ends;
 *   `failedTries`, its failed resumes this hold, which park it at the cap;
 *   `movedFrom`, the launch a move not yet judged left, for a failed one to go
 *   back to
 * @typedef {Partial<Pick<LoopLaunch, (typeof MOVED_FIELDS)[number]>> &
 *   {seat: string, jobId: string}} MovedFrom  what a move rewrites: its seat, reason and key, and the job and
 *   session a copy replaced
 * @typedef {{tries: number, triedAt: number, nextAt: number, failed?: string,
 *   takenAt?: number, dryResumes?: number}}
 *   LimitResumes  its resumes and moves, kept for the launch's life, each
 *   spacing the next; `failed`, why the last one failed; `takenAt`, when the
 *   last one took, until judged at its next limit block (judgeTakenResume);
 *   `dryResumes`, those in a row that took and bought no reply, which park it
 *   at the cap (workflow-core#3792)
 * @typedef {Tick & {typedSeat: string|null, slots: number,
 *   readMoveSeats: () => MoveSeats,
 *   seatListRead: boolean}} LimitTick  `seatListRead`, whether the seats read
 *   are the loop's own list, not a damaged or empty control's stand-in
 *   a tick read further for its limit-blocked launches: the plan seats sized
 *   for one session each, the overflow seats on those readings, and
 *   admission's free slots
 * @typedef {{seats: import("./refill-decide.js").SizedSeat[],
 *   overflow: import("./refill-decide.js").OverflowReading[]}} MoveSeats
 * @typedef {{seat: string, keyVar?: string, allowanceUsd?: number}} MoveTarget
 *   a move's seat: on an overflow seat, its key and the allowance the session
 *   takes there, the key's headroom at the move (workflow-core#3736)
 * @typedef {{kind: "in-place"}|{kind: "move", to: MoveTarget}} LimitAct  a
 *   limit resume on its own seat, or a move to `to`
 */

/**
 * Whether `l` was resumed from its limit hold and not yet judged.
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isResumeUnjudged = (l) =>
	isLimitHeld(l) && l.limitHeld.resumedAt !== undefined;

/**
 * Whether `l` waits on its seat's limit, its session live or held.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {block: import("./block-act.js").Block}}
 */
const isLimitBlocked = (l) => isActionable(l) && l.block?.cause === "LIMIT";
/**
 * The limit `l` hit, its reset off its seat's reading `s`: the bar its block
 * text names, else the one the reading shows, a full bar, the weekly first,
 * as it outlasts the 5-hour one, else the fuller, a session reaching its
 * limit ahead of the cached reading.
 * @param {import("./refill-decide.js").SizedSeat} s
 * @param {import("./block-cause.js").LimitBar} [named]  the bar the block
 *   text names
 * @returns {LimitRead}
 */
function limitReadOf(s, named) {
	if (
		!named &&
		s.week === null &&
		s.session === null &&
		!s.weekFull &&
		!s.sessionFull
	)
		return { bar: null, resets: null };
	const isWeekly = named
		? named === "weekly"
		: s.weekFull || (!s.sessionFull && (s.week ?? 0) >= (s.session ?? 0));
	return isWeekly
		? {
				bar: "weekly",
				resets: s.weekResets === null ? null : iso(s.weekResets),
			}
		: { bar: "5-hour", resets: s.sessionResets };
}

/** @param {LimitRead} limit */
const buildLimitText = ({ bar, resets }) =>
	`${bar ?? "unread"} limit (reset ${resets ?? "unread"})`;

/**
 * What `l` waits on, and since when, where it waits on its limit and no resume
 * is being judged; null otherwise. One the loop could not stop stays live with
 * no hold, so no bound parks it (workflow-core#3838).
 * @param {LoopLaunch} l
 * @returns {{why: string, since: number}|null}
 */
function limitWaitOf(l) {
	if (!isLive(l) || isResumeUnjudged(l)) return null;
	if (isLimitHeld(l))
		return {
			why: `stopped on its ${buildLimitText(l.limitHeld.limit)}`,
			since: l.limitHeld.at,
		};
	return isLimitBlocked(l)
		? {
				why: "blocked on its limit, its session not stopped",
				since: l.block.since,
			}
		: null;
}

/**
 * `l` with one more resume or move counted, `failed` why it failed, which a
 * held one's hold counts towards its park at the cap (workflow-core#3790); one that took
 * is judged at the launch's next limit block (workflow-core#3792).
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {string} [failed]
 * @returns {L & {limitResumes: LimitResumes}}
 */
function afterLimitTry(l, now, failed) {
	const tries = (l.limitResumes?.tries ?? 0) + 1;
	const held = l.limitHeld;
	const dryResumes = l.limitResumes?.dryResumes;
	return {
		...l,
		...(failed !== undefined && held
			? {
					limitHeld: {
						...held,
						failedTries: (held.failedTries ?? 0) + 1,
					},
				}
			: {}),
		limitResumes: {
			tries,
			triedAt: now,
			nextAt: nextTryAt(tries, now),
			...(dryResumes === undefined ? {} : { dryResumes }),
			...(failed === undefined ? { takenAt: now } : { failed }),
		},
	};
}

/**
 * Log a resume or move that failed, and comment it where its failure is news,
 * so one that keeps failing does not comment on every try.
 * @param {LoopLaunch} l
 * @param {string} line
 * @param {string} why
 * @param {BlockIo} io
 */
function reportLimitFailure(l, line, why, io) {
	io.log(`${line}: ${why}`);
	if (l.limitResumes?.failed === why) return;
	io.comment(
		l,
		`Refill loop: ${line}: ${why.split(/\r?\n/)[0]}. It stays held on its seat, its conversation kept, and is judged again on a later tick.`,
	);
}

/**
 * Stop `l`'s limit-blocked session until a seat has room: it keeps its
 * conversation and its launch, and holds no memory or slot. Told in the log
 * alone. One with no session id is not stopped, as nothing could resume it.
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function holdForLimit(l, limit, { now, io }) {
	const what = `${l.jobId} ${launchName(l)} on ${l.seat}, at its ${buildLimitText(limit)}`;
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) {
		io.log(`not holding ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(l, io);
	if (failed) {
		io.log(`could not hold ${what}: ${failed}`);
		return l;
	}
	io.log(`held ${what}: stopped until a seat has room`);
	return { ...l, limitHeld: { at: now, sessionId, cwd, limit } };
}

/**
 * Limit act `act` on `l`: its session stopped, unless held already, and held
 * from now on, then `resume` run on it and the launch it leaves written, told
 * takesSlot. Where
 * no session id read or the stop failed, `l` after that failed try, reported
 * under `failedLine` of the limit it is held at.
 * @param {JobLaunch} l
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {{act: LimitAct, failedLine: (held: LimitRead) => string,
 *   resume: (stopped: JobLaunch & {limitHeld: LimitHeld},
 *   ids: ResumeTarget & {sessionId: string}, tookSlot: boolean) => LoopLaunch}} how
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function runLimitAct(l, limit, { act, failedLine, resume }, { now, io }) {
	const held = l.limitHeld ?? { ...io.resumeTargetOf(l), at: now, limit };
	const { sessionId, cwd } = held;
	/** @param {string} why */
	const gaveUp = (why) => {
		reportLimitFailure(l, failedLine(held.limit), why, io);
		return afterLimitTry(l, now, why);
	};
	if (!sessionId) return gaveUp("no session id read for it");
	io.writeLaunch({
		...l,
		resumeStarted: {
			at: now,
			sessionId,
			cwd,
			act: { ...act, held: { ...held, sessionId } },
		},
	});
	const stopFailed = isLimitHeld(l) ? null : stopJob(l, io);
	if (stopFailed) return gaveUp(`stop: ${stopFailed}`);
	const out = resume(
		{ ...l, limitHeld: { ...held, sessionId } },
		{ sessionId, cwd },
		takesSlot(l),
	);
	io.writeLaunch(out);
	return out;
}

/**
 * Resume `l`'s limit-blocked session on its own seat (workflow-core#3735): stopped, unless
 * held already, then `--bg --resume` under its own session id. A resume stays
 * held until settleLimitResume, as a failed one can show only seconds later
 * (workflow-core#2159). One the launcher ran as a copy tracks the copy, as
 * lib/refill-tick.js's resumeStopped moves the claims to it (workflow-core#2963).
 * @param {JobLaunch} l
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function resumeInPlace(l, limit, seen) {
	const { now, io } = seen;
	return runLimitAct(
		l,
		limit,
		{
			act: { kind: "in-place" },
			failedLine: (at) => `could not resume ${buildInPlaceWhat(l, at)}`,
			resume: (stopped, ids, tookSlot) =>
				settleInPlace(
					stopped,
					{
						...io.resumeStopped(stopped, LIMIT_PROMPT, ids),
						fromSessionId: ids.sessionId,
					},
					{ now, io, tookSlot },
				),
		},
		seen,
	);
}

/**
 * What resumeInPlace's lines call its resume of `l` after `limit`.
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 */
const buildInPlaceWhat = (l, limit) =>
	`${l.jobId} ${launchName(l)} on ${l.seat}, after its ${buildLimitText(limit)}`;

/**
 * `l`, stopped, after resumeInPlace's resume `r` at `now`, reported;
 * `tookSlot` where it was held before.
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{now: number, io: BlockIo, tookSlot: boolean}} seen
 * @returns {LoopLaunch}
 */
function settleInPlace(l, r, { now, io, tookSlot }) {
	const limitText = buildLimitText(l.limitHeld.limit);
	const what = buildInPlaceWhat(l, l.limitHeld.limit);
	if (r.failed !== null) {
		reportLimitFailure(l, `could not resume ${what}`, r.failed, io);
		return afterLimitTry(l, now, r.failed);
	}
	const resumed = relaunched(
		{
			...l,
			parked: false,
			limitHeld: { ...l.limitHeld, resumedAt: now },
		},
		r,
		now,
		{ tookSlot },
	);
	const how = buildResumedHow(r);
	io.log(`resumed ${what}: same seat, ${how}`);
	io.comment(
		l,
		`Refill loop: resumed this session after its ${limitText}: same seat, ${l.seat}, ${how}. ${LIMIT_LOSS_TEXT}`,
	);
	return afterLimitTry(resumed, now);
}

const MOVED_FIELDS = /** @type {const} */ ([
	"seat",
	"reason",
	"keyVar",
	"jobId",
	"sessionId",
	"copiedFrom",
	"pastSessionIds",
	"movedAt",
]);

/**
 * @param {JobLaunch} l
 * @returns {MovedFrom}
 */
const movedFromOf = (l) => ({
	...Object.fromEntries(
		MOVED_FIELDS.flatMap((k) => (l[k] === undefined ? [] : [[k, l[k]]])),
	),
	seat: l.seat,
	jobId: l.jobId,
});

/**
 * @template {JobLaunch} L
 * @param {L} l
 * @param {MovedFrom} from
 * @returns {L}
 */
function unmoved(l, from) {
	const back = { ...l };
	for (const k of MOVED_FIELDS) delete back[k];
	return { ...back, ...from };
}

/**
 * @template {JobLaunch} L
 * @param {L} l
 * @param {MoveTarget} target
 * @returns {L}
 */
const movedOnto = (l, { seat, keyVar }) => ({
	...l,
	...seatIdOf({ seat, keyVar }),
});

/** @param {MoveTarget} target */
const buildTargetText = (target) =>
	target.keyVar
		? `${target.seat} on overflow key ${target.keyVar}`
		: target.seat;

/**
 * Move `l`'s limit-blocked session to `target` under its own session id:
 * stopped on its seat, unless held already, then carried and resumed
 * there, from its own cwd. The launch stays the same launch, its seat, key
 * and reason rewritten, so stop, reap, status and the allowance stop address
 * `target` from here, and its block dated now, so no reading older than the
 * move sends it back. A failure leaves it held on its seat; a resume that the
 * launcher ran as a copy tracks the copy, as an overflow seat's always does
 * (workflow-core#3692 (d)).
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function moveToSeat(l, target, limit, seen) {
	const { now, io } = seen;
	return runLimitAct(
		l,
		limit,
		{
			act: { kind: "move", to: target },
			failedLine: (at) => `could not move ${buildMoveWhat(l, target, at)}`,
			resume: (stopped, ids, tookSlot) =>
				settleMove(
					{ ...stopped, block: l.block },
					target,
					{
						...io.moveSession(stopped, target, MOVED_PROMPT, ids),
						fromSessionId: ids.sessionId,
					},
					{ now, io, tookSlot },
				),
		},
		seen,
	);
}

/**
 * What moveToSeat's lines call its move of `l` to `target` at `limit`.
 * @param {JobLaunch} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit
 */
const buildMoveWhat = (l, target, limit) =>
	`${l.jobId} ${launchName(l)} from ${l.seat} to ${buildTargetText(target)}, at its ${buildLimitText(limit)}`;

/**
 * `l`, stopped, after moveToSeat's resume `r` on `target` at `now`, reported;
 * `tookSlot` where it was held before.
 * @param {JobLaunch & {block: import("./block-act.js").Block,
 *   limitHeld: LimitHeld}} l
 * @param {MoveTarget} target
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{now: number, io: BlockIo, tookSlot: boolean}} seen
 * @returns {LoopLaunch}
 */
function settleMove(l, target, r, { now, io, tookSlot }) {
	const limitText = buildLimitText(l.limitHeld.limit);
	const what = buildMoveWhat(l, target, l.limitHeld.limit);
	if (r.failed !== null) {
		reportLimitFailure(l, `could not move ${what}`, r.failed, io);
		return afterLimitTry(l, now, r.failed);
	}
	const moved = relaunched(
		{
			...movedOnto(l, target),
			reason: `moved from ${buildSeatName(l.seat)}`,
			movedAt: now,
			parked: false,
			block: { ...l.block, since: now },
			limitLeft: [
				...(l.limitLeft ?? []).filter((x) => x.seat !== l.seat),
				{ seat: l.seat, since: l.block.since },
			],
			limitHeld: {
				...l.limitHeld,
				resumedAt: now,
				movedFrom: movedFromOf(l),
			},
		},
		r,
		now,
		{ tookSlot },
	);
	const how = r.copy ? buildResumedHow(r) : "under its own session id";
	const charged =
		target.allowanceUsd === undefined
			? ""
			: `, its allowance there $${target.allowanceUsd.toFixed(2)}`;
	io.log(`moved ${what}: ${how}${charged}`);
	io.comment(
		l,
		`Refill loop: moved this session after its ${limitText}: from ${l.seat} to ${buildTargetText(target)}, ${how}${charged}. ${LIMIT_LOSS_TEXT}`,
	);
	/* Spacing is for tries that fail: one that took may move again at once. */
	const tried = afterLimitTry(moved, now);
	return { ...tried, limitResumes: { ...tried.limitResumes, nextAt: now } };
}

/**
 * Where to look for the job a started resume of `l` made: on the seat a move
 * went to, with that move, else on `l`'s own.
 * @param {JobLaunch} l  as it was before the stop
 * @param {import("./refill-blocks.js").StartedAct} act
 * @returns {{on: JobLaunch, move?: MoveTarget}}
 */
const adoptTargetOf = (l, act) =>
	act.kind === "move" ? { on: movedOnto(l, act.to), move: act.to } : { on: l };

/**
 * `l` after its limit act `act`'s resume `r`, which a kill left out of the
 * state (lib/refill-blocks.js's settleStartedResumes), its ledger hold synced.
 * @param {JobLaunch} l  as it was before the stop
 * @param {LimitAct & {held: LimitHeld}} act
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{what: string, at: number, io: BlockIo}} how  `what`, the resume
 *   as its log lines name it; `at`, when it was made
 * @returns {LoopLaunch}
 */
function settleStartedLimit(l, act, r, { what, at, io }) {
	if (!l.block) {
		io.log(`${what} is dropped: its launch is no longer blocked`);
		return l;
	}
	const held = { ...l, block: l.block, limitHeld: act.held };
	const seen = { now: at, io, tookSlot: takesSlot(l) };
	return syncLedgerHold(
		act.kind === "in-place"
			? settleInPlace(held, r, seen)
			: settleMove(held, act.to, r, seen),
		io,
	);
}

/**
 * Judge a resume or move a tick on, its session not listed live or markParked
 * would have let it go. A job record reading failed or unread goes back to
 * held, a move back on the seat it left, named; any other is let go, for the
 * listing to judge finished. A move that took has its job record gone from
 * the seat it left.
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function settleLimitResume(l, { now, io }) {
	const job = io.jobStateOf(l);
	if (job && job.state !== "failed") {
		const { limitHeld: _, block: __, ...rest } = l;
		const { movedFrom, sessionId } = l.limitHeld;
		/* The job it left, unless it woke in that job, in the dir it shares. */
		const left =
			movedFrom && (movedFrom.seat !== l.seat || movedFrom.jobId !== l.jobId);
		const failed = left
			? io.removeJobRecord(movedFrom.seat, sessionId, l.limitHeld.cwd)
			: null;
		if (failed) io.log(`${launchName(l)}: ${failed}`);
		return rest;
	}
	const { resumedAt: _, movedFrom, ...limitHeld } = l.limitHeld;
	const why = job
		? `state failed after its resume: ${job.detail}`
		: "its job record is unread after its resume";
	const name = `${l.jobId} ${launchName(l)}`;
	if (!movedFrom) {
		reportLimitFailure(l, `could not resume ${name} on ${l.seat}`, why, io);
		return afterLimitTry({ ...l, limitHeld }, now, why);
	}
	reportLimitFailure(
		l,
		`could not move ${name} from ${movedFrom.seat} to ${l.seat}`,
		why,
		io,
	);
	const stopFailed = stopJob(l, io);
	if (stopFailed) io.log(`could not stop ${name}'s failed move: ${stopFailed}`);
	return afterLimitTry(unmoved({ ...l, limitHeld }, movedFrom), now, why);
}

/**
 * `l`, limit-blocked again, with its last resume that took judged, once: no
 * reply since adds to its dry resumes, a reply clears them (workflow-core#3792). An unread
 * transcript judges nothing, and the next resume replaces what it would have
 * judged.
 * Residual: a launch whose transcript never reads is never counted, though one
 * that reads LIMIT has read its transcript that tick.
 * @template {JobLaunch} L
 * @param {L} l
 * @param {BlockIo} io
 * @returns {L}
 */
function judgeTakenResume(l, io) {
	if (l.limitResumes?.takenAt === undefined) return l;
	const { takenAt, dryResumes = 0, ...rest } = l.limitResumes;
	const replied = io.hasRepliedSince(l, takenAt);
	if (replied === null) return l;
	return {
		...l,
		limitResumes: replied ? rest : { ...rest, dryResumes: dryResumes + 1 },
	};
}

/**
 * `l`, held, with a dispatch-ledger hold written to the hold's bound: its
 * stopped session leaves the listing and its claim unread, so nothing else
 * keeps a direct dispatch off its issues, and the hold must outlast the run,
 * which may end with no tick left to write another (workflow-core#3785).
 * Residual: a session the founder resumes by hand while the loop is stopped
 * keeps its ticket refused, once it ends, until the next `start` or the bound;
 * `--force` is the way out.
 * @param {LoopLaunch & {limitHeld: LimitHeld}} l
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function writeLedgerHold(l, io) {
	if (l.limitHeld.ledgerHeldUntil !== undefined) return l;
	const until = holdBoundAt(l.limitHeld.at);
	if (io.writeLedgerHold(l, until))
		return { ...l, limitHeld: { ...l.limitHeld, ledgerHeldUntil: until } };
	io.log(`could not write ${launchName(l)}'s dispatch-ledger hold`);
	return l;
}

/**
 * `l` with the ledger state its hold owes: a session stopped holds past the
 * window; one resumed and unjudged is live and may end while the loop is
 * stopped, so it gives the hold up (releaseEndedHolds).
 * @param {LoopLaunch} l
 * @param {BlockIo} io
 * @returns {LoopLaunch}
 */
function syncLedgerHold(l, io) {
	if (!isLimitHeld(l)) return l;
	if (!isResumeUnjudged(l)) return writeLedgerHold(l, io);
	const { ledgerHeldUntil: _, ...limitHeld } = l.limitHeld;
	return { ...l, limitHeld };
}

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {limitHeld: LimitHeld & {ledgerHeldUntil: number}}}
 */
const isLedgerHolding = (l) =>
	l.jobId !== null &&
	l.finishedAt === null &&
	l.limitHeld?.ledgerHeldUntil !== undefined;

/**
 * Release the ledger hold of each launch in `before` whose hold ended by
 * `after`. One whose session runs on takes an ordinary row in its place, so its
 * ticket has the window any launch has. A release that fails, the ledger
 * unwritable, is logged and not retried (workflow-core#3785): its issues wait to the hold's
 * bound or a `--force`.
 * @param {LoopLaunch[]} before
 * @param {LoopLaunch[]} after
 * @param {Pick<BlockIo, "release"|"writeLedgerHold"|"log">} io
 */
function releaseEndedHolds(before, after, io) {
	const kept = new Set(after.filter(isLedgerHolding).map(ledgerJobOf));
	const running = new Map(
		after
			.filter((l) => l.finishedAt === null && l.parkStopped === undefined)
			.map((l) => [ledgerJobOf(l), l]),
	);
	for (const l of before.filter(isLedgerHolding)) {
		const job = ledgerJobOf(l);
		if (kept.has(job)) continue;
		if (!io.release(ledgerOf(l)))
			io.log(
				`could not release ${launchName(l)}'s dispatch-ledger hold: its issues wait until ${iso(l.limitHeld.ledgerHeldUntil)}`,
			);
		const live = running.get(job);
		if (live && !io.writeLedgerHold(live))
			io.log(`could not write ${launchName(l)}'s dispatch-ledger row`);
	}
}

/**
 * A held launch for a stop line (workflow-core#3785): the session, its seat and what its
 * ticket is open to from now, as nothing judges it until the next `start`.
 * @param {LoopLaunch & {limitHeld: LimitHeld}} l
 */
function buildHeldStopText(l) {
	const { ledgerHeldUntil: until, limit, resumedAt } = l.limitHeld;
	const what = `${l.jobId} ${launchName(l)} on ${buildSeatName(l.seat)}`;
	if (resumedAt !== undefined)
		return `${what}, resumed at ${iso(resumedAt)} after its ${buildLimitText(limit)}, not yet judged`;
	return `${what}, stopped at its ${buildLimitText(limit)}, ${
		until === undefined
			? "its dispatch-ledger hold unwritten, so a direct dispatch may take its ticket"
			: `its ticket held from dispatch until ${iso(until)}`
	}`;
}

/**
 * Park `l`, held where nothing will resume it, so the launch finishes and a
 * normal-mode loop routes its ticket back (workflow-core#3790). A failed resume can leave
 * its session starting, so it is stopped too, though a stop that fails, as
 * one off a dropped seat may for good, does not keep it held. Off the hold, as
 * isLimitHeld has no parkStopped guard; its session id kept for the marker.
 * @param {JobLaunch & {block: import("./block-act.js").Block,
 *   limitHeld: LimitHeld}} l
 * @param {{whyEnded: string|undefined, limitParks?: number}} why
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkHeld(l, why, mode, seen) {
	const stopFailed = stopJob(l, seen.io);
	if (stopFailed)
		seen.io.log(`could not stop ${launchName(l)} for its park: ${stopFailed}`);
	const { limitHeld: _, ...parked } = parkOnceStopped(
		{ ...l, sessionId: l.sessionId ?? l.limitHeld.sessionId },
		{ act: "stop-and-park", ...why },
		mode,
		seen,
	);
	return parked;
}

/**
 * Why `l` parks at a limit cap: `whyEnded`, and its parks at one in a row, a
 * reply since its launch starting them again (workflow-core#3804). An unread transcript
 * counts as none, so a reading that fails cannot lift the bound.
 * @param {JobLaunch} l
 * @param {string|undefined} whyEnded
 * @param {BlockIo} io
 */
const buildLimitCapWhy = (l, whyEnded, io) => ({
	whyEnded,
	limitParks: io.hasRepliedSince(l, l.launchedAt) ? 1 : (l.limitParks ?? 0) + 1,
});

/**
 * `l`'s block as the table reads it, short of what its seat's reading adds.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const limitBlockOf = (l) => ({
	...l.block,
	held: isLimitHeld(l),
	heldAt: l.limitHeld?.at,
	tries: l.limitHeld?.failedTries,
	nextAt: l.limitResumes?.nextAt,
	dryResumes: l.limitResumes?.dryResumes,
});

/**
 * `l`, whose seat the seats read do not hold: parked where it is held and the
 * seats are the loop's own list, or, whatever the list, held at a cap.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkOffList(l, mode, seen) {
	if (!isLimitHeld(l)) return l;
	if (seen.seatListRead)
		/* No count: this is no limit-cap park, and its marker's count goes. */
		return parkHeld(
			l,
			{ whyEnded: `its seat ${l.seat} off the loop's seats` },
			mode,
			seen,
		);
	const whyEnded = buildLimitParkWhy(limitBlockOf(l), seen.now);
	return whyEnded
		? parkHeld(l, buildLimitCapWhy(l, whyEnded, seen.io), mode, seen)
		: l;
}

/**
 * Where pickMoveSeat sends `l`, null nowhere.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {LimitTick} seen
 * @param {MoveSeats} moveSeats
 * @returns {MoveTarget|null}
 */
function pickMoveTarget(l, seen, { seats, overflow }) {
	const pick = pickMoveSeat({
		seats,
		overflow,
		typedSeat: seen.typedSeat,
		ownSeat: l.seat,
		since: l.block.since,
		left: l.limitLeft,
	});
	if (pick.seat === null) return null;
	if (!pick.keyVar) return { seat: pick.seat };
	const allowanceUsd = overflow.find(
		(o) => o.keyVar === pick.keyVar,
	)?.headroomUsd;
	/* Unread, the move could not be charged to the key (workflow-core#3730). */
	if (allowanceUsd === undefined) return null;
	return { seat: pick.seat, keyVar: pick.keyVar, allowanceUsd };
}

/**
 * The move pick and the table's act on one limit-blocked launch on a plan seat.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {import("./refill-decide.js").SizedSeat} own  its seat's reading
 * @param {LimitTick} seen
 * @param {{mode: "away"|"normal", slots: number, moveSeats: MoveSeats}} how
 * @returns {LoopLaunch}
 */
function actOnLimit(l, own, seen, { mode, slots, moveSeats }) {
	const target = pickMoveTarget(l, seen, moveSeats);
	const block = {
		...limitBlockOf(l),
		seat: l.seat,
		movePick: target,
		slotFree: slots > 0,
	};
	const act = blockAct(block, mode, seen.now);
	if (act === "stop-and-park") {
		const why = buildLimitCapWhy(
			l,
			buildLimitParkWhy(block, seen.now),
			seen.io,
		);
		return isLimitHeld(l)
			? parkHeld(l, why, mode, seen)
			: stopPark(l, { act, ...why }, mode, seen);
	}
	const limit = limitReadOf(own, l.block.bar);
	if (act === "hold") return holdForLimit(l, limit, seen);
	if (act === "resume-in-place") return resumeInPlace(l, limit, seen);
	if (act === "move" && target) return moveToSeat(l, target, limit, seen);
	if (target?.seat === l.seat && !target.keyVar && slots <= 0)
		seen.io.log(
			`${launchName(l)} on ${l.seat} reads open, and waits on a free slot`,
		);
	return l;
}

/**
 * `seats` with the seat `l` was moved or resumed onto sized 0, as its next
 * sizing needs a fresh read.
 * @param {MoveSeats} seats
 * @param {LoopLaunch} l
 * @returns {MoveSeats}
 */
const withSeatTaken = ({ seats, overflow }, l) => ({
	seats: seats.map((s) => (isSameSeat(l, s) ? { ...s, fits: 0 } : s)),
	overflow: overflow.map((o) => (isSameSeat(l, o) ? { ...o, fits: 0 } : o)),
});

/**
 * The sessions an act on `l` added to the listing (workflow-core#3778): one resumed from
 * held adds one, and one live left held or parked, no resume made, is gone. A
 * live one stopped and resumed in place adds none.
 * @param {LoopLaunch} l
 * @param {LoopLaunch} out
 * @returns {-1|0|1}
 */
function limitWorkingChange(l, out) {
	if (!isLimitHeld(out))
		return out.parkStopped !== undefined && !isLimitHeld(l) ? -1 : 0;
	const resumed = out.limitHeld.resumedAt !== undefined;
	if (takesSlot(l)) return resumed ? 1 : 0;
	return resumed ? 0 : -1;
}

/**
 * Whether a resume of `l` takes a slot: one from held does (workflow-core#3730).
 * @param {LoopLaunch} l  as it was before the act
 */
const takesSlot = (l) => isLimitHeld(l);

/**
 * The tick's acts on limit-blocked launches, on the seats they read (workflow-core#3735):
 * each resume made a tick ago judged, then for each on a plan seat its act; one
 * held whose seat has left the loop's list is parked (workflow-core#3790), so a restart on
 * fewer seats parks each hold on those dropped. Each one resumed or moved from
 * held takes a slot, so a seat's reset lets them back only as admission has
 * room. A seat is sized for one session, so it takes one move or one resume
 * from held a tick, and the next waits a tick for a fresh sizing. The launches, the slots left, and the
 * net sessions added to those admission read. Nothing off an unread listing, and with none
 * limit-blocked no seat is read.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {{launches: LoopLaunch[], slots: number, workingChange: number}}
 */
function actOnLimits(launches, mode, seen) {
	let { slots } = seen;
	let workingChange = 0;
	if (!seen.agents || !launches.some(isLimitBlocked))
		return { launches, slots, workingChange };
	let moveSeats = seen.readMoveSeats();
	const blocked = blockedIdsOf(seen.agents);
	const acted = launches.map((l) => {
		if (!isLimitBlocked(l)) return l;
		if (isResumeUnjudged(l))
			return syncLedgerHold(settleLimitResume(l, seen), seen.io);
		/* A plan reading on the same dir is not this launch's: a key has no bars. */
		const own = moveSeats.seats.find((s) => isSameSeat(l, s));
		if (!own) return parkOffList(l, mode, seen);
		if (!(blocked.has(l.jobId) || isLimitHeld(l))) return l;
		const out = actOnLimit(judgeTakenResume(l, seen.io), own, seen, {
			mode,
			slots,
			moveSeats,
		});
		const change = limitWorkingChange(l, out);
		/* A resume from held fills a seat as a move onto it does; a live one's
		 * stop and resume in place keeps the slot it holds (workflow-core#3730). */
		if (out.seat !== l.seat || out.keyVar !== l.keyVar || change > 0)
			moveSeats = withSeatTaken(moveSeats, out);
		if (change > 0) slots -= 1;
		workingChange += change;
		return syncLedgerHold(out, seen.io);
	});
	return { launches: acted, slots, workingChange };
}

module.exports = {
	actOnLimits,
	adoptTargetOf,
	buildHeldStopText,
	buildLimitText,
	isLimitBlocked,
	limitWaitOf,
	movedOnto,
	releaseEndedHolds,
	settleStartedLimit,
};
