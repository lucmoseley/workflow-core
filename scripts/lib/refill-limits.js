const { buildLoopComment } = require("./loop-comment.js");
const {
	blockAct,
	buildLimitParkWhy,
	holdBoundAt,
	nextTryAt,
} = require("./block-act.js");
const { LIMIT_PROMPT, MOVED_PROMPT } = require("./loop-prompts.js");
const { pickMoveSeat } = require("./refill-decide.js");
const { buildSpentRoom } = require("./launch-room.js");
const {
	buildMovedReason,
	buildSeatName,
	isSameSeat,
	seatIdOf,
} = require("./refill-seats.js");
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
 * @typedef {{bar: "weekly"|"5-hour"|null, resets: string|null}} LimitRead
 * @typedef {{at: number, sessionId: string, cwd: string, limit: LimitRead,
 *   resumedAt?: number, ledgerHeldUntil?: number, failedTries?: number,
 *   movedFrom?: MovedFrom}} LimitHeld
 * @typedef {Partial<Pick<LoopLaunch, (typeof MOVED_FIELDS)[number]>> &
 *   {seat: string, jobId: string}} MovedFrom
 * @typedef {{tries: number, triedAt: number, nextAt: number, failed?: string,
 *   takenAt?: number, dryResumes?: number}} LimitResumes
 * @typedef {Tick & {typedSeat: string|null, slots: number,
 *   roomOf: (root: string) => number, readMoveSeats: () => MoveSeats,
 *   seatListRead: boolean}} LimitTick
 * @typedef {{seats: import("./refill-decide.js").SizedSeat[],
 *   overflow: import("./refill-decide.js").OverflowReading[]}} MoveSeats
 * @typedef {{seat: string, keyVar?: string, allowanceUsd?: number}} MoveTarget
 * @typedef {{kind: "in-place"}|{kind: "move", to: MoveTarget}} LimitAct
 */

/**
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isResumeUnjudged = (l) =>
	isLimitHeld(l) && l.limitHeld.resumedAt !== undefined;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {block: import("./block-act.js").Block}}
 */
const isLimitBlocked = (l) => isActionable(l) && l.block?.cause === "LIMIT";
/**
 * @param {import("./refill-decide.js").SizedSeat} s
 * @param {import("./block-cause.js").LimitBar} [named]
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
		buildLoopComment(
			`${line}: ${why.split(/\r?\n/)[0]}. It stays held on its seat, its conversation kept, and is judged again on a later tick.`,
		),
	);
}

/**
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
 * @param {JobLaunch} l
 * @param {LimitRead} limit
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
 * @param {JobLaunch} l
 * @param {LimitRead} limit
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
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 */
const buildInPlaceWhat = (l, limit) =>
	`${l.jobId} ${launchName(l)} on ${l.seat}, after its ${buildLimitText(limit)}`;

/**
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
		buildLoopComment(
			`resumed this session after its ${limitText}: same seat, ${l.seat}, ${how}. ${LIMIT_LOSS_TEXT}`,
		),
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
 * @template {{seat: string, keyVar?: string}} L
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
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit
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
 * @param {JobLaunch} l
 * @param {MoveTarget} target
 * @param {LimitRead} limit
 */
const buildMoveWhat = (l, target, limit) =>
	`${l.jobId} ${launchName(l)} from ${l.seat} to ${buildTargetText(target)}, at its ${buildLimitText(limit)}`;

/**
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
			reason: buildMovedReason(l.seat),
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
		buildLoopComment(
			`moved this session after its ${limitText}: from ${l.seat} to ${buildTargetText(target)}, ${how}${charged}. ${LIMIT_LOSS_TEXT}`,
		),
	);
	const tried = afterLimitTry(moved, now);
	return { ...tried, limitResumes: { ...tried.limitResumes, nextAt: now } };
}

/**
 * @param {JobLaunch} l
 * @param {import("./refill-blocks.js").StartedAct} act
 * @returns {{on: JobLaunch, move?: MoveTarget}}
 */
const adoptTargetOf = (l, act) =>
	act.kind === "move" ? { on: movedOnto(l, act.to), move: act.to } : { on: l };

/**
 * @param {JobLaunch} l
 * @param {LimitAct & {held: LimitHeld}} act
 * @param {{failed: string}|(Resumed & {fromSessionId: string})} r
 * @param {{what: string, at: number, io: BlockIo}} how
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
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function settleLimitResume(l, { now, io }) {
	const job = io.jobStateOf(l);
	if (job && job.state !== "failed") {
		const { limitHeld: _, block: __, ...rest } = l;
		const { movedFrom, sessionId } = l.limitHeld;
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

/** @param {LoopLaunch & {limitHeld: LimitHeld}} l */
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
 * @param {JobLaunch} l
 * @param {string|undefined} whyEnded
 * @param {BlockIo} io
 */
const buildLimitCapWhy = (l, whyEnded, io) => ({
	whyEnded,
	limitParks: io.hasRepliedSince(l, l.launchedAt) ? 1 : (l.limitParks ?? 0) + 1,
});

/**
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
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkOffList(l, mode, seen) {
	if (!isLimitHeld(l)) return l;
	if (seen.seatListRead)
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
	if (allowanceUsd === undefined) return null;
	return { seat: pick.seat, keyVar: pick.keyVar, allowanceUsd };
}

/**
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {import("./refill-decide.js").SizedSeat} own
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
 * @param {MoveSeats} seats
 * @param {LoopLaunch} l
 * @returns {MoveSeats}
 */
const withSeatTaken = ({ seats, overflow }, l) => ({
	seats: seats.map((s) => (isSameSeat(l, s) ? { ...s, fits: 0 } : s)),
	overflow: overflow.map((o) => (isSameSeat(l, o) ? { ...o, fits: 0 } : o)),
});

/**
 * @param {LoopLaunch} l
 * @param {LoopLaunch} out
 * @returns {-1|0|1}
 */
function limitLiveChange(l, out) {
	if (!isLimitHeld(out))
		return out.parkStopped !== undefined && !isLimitHeld(l) ? -1 : 0;
	const resumed = out.limitHeld.resumedAt !== undefined;
	if (takesSlot(l)) return resumed ? 1 : 0;
	return resumed ? 0 : -1;
}

/** @param {LoopLaunch} l */
const takesSlot = (l) => isLimitHeld(l);

/**
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {{launches: LoopLaunch[], slots: number, liveChange: number}}
 */
function actOnLimits(launches, mode, seen) {
	let { slots } = seen;
	const room = buildSpentRoom(seen.roomOf);
	let liveChange = 0;
	if (!seen.agents || !launches.some(isLimitBlocked))
		return { launches, slots, liveChange };
	let moveSeats = seen.readMoveSeats();
	const blocked = blockedIdsOf(seen.agents);
	const acted = launches.map((l) => {
		if (!isLimitBlocked(l)) return l;
		if (isResumeUnjudged(l))
			return syncLedgerHold(settleLimitResume(l, seen), seen.io);
		const own = moveSeats.seats.find((s) => isSameSeat(l, s));
		if (!own) return parkOffList(l, mode, seen);
		if (!(blocked.has(l.jobId) || isLimitHeld(l))) return l;
		const out = actOnLimit(judgeTakenResume(l, seen.io), own, seen, {
			mode,
			slots: Math.min(slots, room.left(l.root)),
			moveSeats,
		});
		const change = limitLiveChange(l, out);
		if (out.seat !== l.seat || out.keyVar !== l.keyVar || change > 0)
			moveSeats = withSeatTaken(moveSeats, out);
		if (change > 0) {
			slots -= 1;
			room.spend(l.root);
		}
		liveChange += change;
		return syncLedgerHold(out, seen.io);
	});
	return { launches: acted, slots, liveChange };
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
