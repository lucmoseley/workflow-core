const { REVIEW_HOUR } = require("./review-hour.js");
const { DAY_MS } = require("./retained-jsonl.js");

const MIN_MS = 60 * 1000;
// guess, workflow-core#2359
const LAST_RESUME_OFFSET_MS = 30 * MIN_MS;
const RESUME_OFFSETS_MS = [
	...[1, 5, 15].map((m) => m * MIN_MS),
	LAST_RESUME_OFFSET_MS,
];
const RESUME_EVERY_MS = 30 * MIN_MS;
// guess, workflow-core#2359
const RESUME_CAP = 16;
// guess, workflow-core#3793
const LIMIT_HOLD_BOUND_DAYS = 8;
const HOLD_BOUND_WHY = `held on its limit past the ${LIMIT_HOLD_BOUND_DAYS}-day bound`;
// 3 min 13 s measured, workflow-core#2354
const RETRY_CYCLE_MS = 4 * MIN_MS;
// guess, workflow-core#2659
const RESUMED_IDLE_MS = 5 * MIN_MS;
// guess, workflow-core#2978
const IDLE_RETYPE_MS = 5 * MIN_MS;
// guess, workflow-core#2978
const IDLE_TRIES = 2;
// guess, workflow-core#5322
const SYNTHETIC_QUIET_MS = 5 * MIN_MS;
// guess, workflow-core#5322
const SYNTHETIC_TRIES = 2;

/**
 * @typedef {import("./block-cause.js").Cause} Cause
 * @typedef {"stop-and-park"|"park-at-morning"|"resume"|"hold"
 *   |"resume-in-place"|"move"|"handoff-relaunch"|"attach-to-hold"|"wait"
 *   |"none"} Act
 * @typedef {{cause: Cause, sub?: import("./block-cause.js").ApiErrorKind,
 *   billing?: true,
 *   bar?: import("./block-cause.js").LimitBar, since: number, tries?: number, nextAt?: number, triedAt?: number,
 *   held?: boolean, typing?: boolean, swapHeld?: boolean, seat?: string,
 *   movePick?: Pick<import("./refill-limits.js").MoveTarget, "seat"|"keyVar">|null,
 *   slotFree?: boolean,
 *   dryResumes?: number, heldAt?: number,
 *   lockout?: import("./block-cause.js").Lockout}} Block
 * @typedef {(block: Block, now: number) => Act} Rule
 */

/**
 * @param {number} k
 * @returns {number}
 */
const resumeOffset = (k) =>
	RESUME_OFFSETS_MS[k] ?? resumeOffset(k - 1) + RESUME_EVERY_MS;

/**
 * @param {number} tries
 * @param {number} at
 */
const nextTryAt = (tries, at) =>
	at + resumeOffset(tries) - resumeOffset(tries - 1);

/** @param {number} since */
function morningAfter(since) {
	const d = new Date(since);
	d.setHours(REVIEW_HOUR, 0, 0, 0);
	if (d.getTime() <= since) d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** @type {Rule} */
const stopAtOnce = () => "stop-and-park";
/** @type {Rule} */
const waitForAnswer = () => "wait";
/** @type {Rule} */
const leave = () => "none";
/** @type {Rule} */
const attachToHold = () => "attach-to-hold";

/**
 * @param {Block} block
 * @param {number} now
 */
const isHoldDue = (block, now) =>
	block.triedAt !== undefined &&
	!block.held &&
	!block.typing &&
	now - block.triedAt >= RETRY_CYCLE_MS;

/**
 * @param {Block} block
 * @returns {Act}
 */
function dueAct(block) {
	if ((block.tries ?? 0) >= RESUME_CAP) return "stop-and-park";
	return block.typing ? "wait" : "resume";
}

/** @param {Block} block */
const resumeDueAt = (block) => Math.max(block.nextAt ?? 0, block.since);

/**
 * @param {boolean} away
 * @returns {Rule}
 */
const apiError = (away) => (block, now) => {
	if (block.sub !== "transient") return "stop-and-park";
	if (away && now >= morningAfter(block.since)) return "park-at-morning";
	if (now < resumeDueAt(block)) return isHoldDue(block, now) ? "hold" : "wait";
	return dueAct(block);
};

/** @type {Rule} */
const resumedIdle = (block, now) => {
	const tries = block.tries ?? 0;
	if (block.swapHeld) return tries < IDLE_TRIES ? "hold" : "handoff-relaunch";
	if (now - block.since < (tries === 0 ? RESUMED_IDLE_MS : IDLE_RETYPE_MS))
		return "wait";
	return tries < IDLE_TRIES ? "resume" : "handoff-relaunch";
};

/** @type {Rule} */
const syntheticStop = (block, now) => {
	if (block.typing || now - block.since < SYNTHETIC_QUIET_MS) return "wait";
	return (block.tries ?? 0) < SYNTHETIC_TRIES ? "resume" : "none";
};

/** @param {number} heldAt */
const holdBoundAt = (heldAt) => heldAt + LIMIT_HOLD_BOUND_DAYS * DAY_MS;

/**
 * @param {number} heldAt
 * @param {number} now
 */
const isHeldPastBound = (heldAt, now) => now >= holdBoundAt(heldAt);

/**
 * @param {Block} block
 * @param {number} now
 */
const isFreeToGo = (block, now) =>
	Boolean(block.seat) &&
	Boolean(block.movePick) &&
	now >= (block.nextAt ?? 0) &&
	(!block.held || Boolean(block.slotFree));

/**
 * @param {Block} block
 * @param {number} now
 * @returns {string|undefined}
 */
function buildLimitParkWhy(block, now) {
	const failed = block.tries ?? 0;
	if (block.held && failed >= RESUME_CAP)
		return `${failed} failed resumes or moves`;
	const dry = block.dryResumes ?? 0;
	if (dry >= RESUME_CAP)
		return `${dry} resumes or moves in a row with no reply`;
	if (block.heldAt === undefined || isFreeToGo(block, now)) return;
	return isHeldPastBound(block.heldAt, now) ? HOLD_BOUND_WHY : undefined;
}

/** @param {Block} block */
const isOwnSeat = ({ movePick, seat }) =>
	movePick?.seat === seat && !movePick?.keyVar;

/** @type {Rule} */
const limit = (block, now) => {
	if (buildLimitParkWhy(block, now)) return "stop-and-park";
	if (isFreeToGo(block, now))
		return isOwnSeat(block) ? "resume-in-place" : "move";
	return block.held ? "wait" : "hold";
};

/** @type {Record<Cause, {away: Rule, normal: Rule, isFounderWait: boolean}>} */
const TABLE = {
	QUESTION: { away: stopAtOnce, normal: waitForAnswer, isFounderWait: true },
	PERMISSION: { away: stopAtOnce, normal: waitForAnswer, isFounderWait: true },
	API_ERROR: {
		away: apiError(true),
		normal: apiError(false),
		isFounderWait: false,
	},
	LIMIT: { away: limit, normal: limit, isFounderWait: false },
	OTHER_DIALOG: { away: leave, normal: leave, isFounderWait: true },
	LOCKED_OUT: {
		away: attachToHold,
		normal: attachToHold,
		isFounderWait: false,
	},
	RESUMED_IDLE: {
		away: resumedIdle,
		normal: resumedIdle,
		isFounderWait: false,
	},
	SYNTHETIC_STOP: {
		away: syntheticStop,
		normal: syntheticStop,
		isFounderWait: false,
	},
	UNKNOWN: { away: leave, normal: leave, isFounderWait: false },
};

/** @param {Cause|undefined} cause */
const isFounderWait = (cause) =>
	cause !== undefined && TABLE[cause].isFounderWait;

/**
 * @param {Block} block
 * @param {"away"|"normal"} mode
 * @param {number} now
 * @returns {Act}
 */
const blockAct = (block, mode, now) => TABLE[block.cause][mode](block, now);

module.exports = {
	IDLE_TRIES,
	LAST_RESUME_OFFSET_MS,
	RESUME_CAP,
	SYNTHETIC_QUIET_MS,
	SYNTHETIC_TRIES,
	blockAct,
	buildLimitParkWhy,
	holdBoundAt,
	isFounderWait,
	nextTryAt,
	resumeDueAt,
};
