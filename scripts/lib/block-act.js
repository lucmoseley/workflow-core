/*
 * block-act.js — what the refill loop does with a blocked launch, by cause and
 * mode (workflow-core#2699, spec workflow-core#2695). Pure: the caller does the act it gets back.
 */

const { REVIEW_HOUR } = require("./morning-review.js");

const MIN_MS = 60 * 1000;
/* Normal mode: the founder may answer in place while at the machine — house:
 * workflow-core#2393. */
const NORMAL_GRACE_MS = 60 * MIN_MS;
/* A transient API stop's resumes, at about these offsets from the stop, then
 * every RESUME_EVERY_MS: untraced (workflow-core#2359, chosen to land inside the prompt
 * cache's hour). */
const RESUME_OFFSETS_MS = [1, 5, 15, 30].map((m) => m * MIN_MS);
const RESUME_EVERY_MS = 30 * MIN_MS;
/* Untraced (workflow-core#2359): a guard against a loop that never ends. */
const RESUME_CAP = 16;
/* A resume starts a retry cycle that reads blocked again about 3 min 13 s
 * later where the API is still down (workflow-core#2354 F8); a session is held only past
 * it, so none is stopped mid-cycle. Rounded up. */
const RETRY_CYCLE_MS = 4 * MIN_MS;
/* How long a resumed-idle session waits from its restart row before the
 * loop types a resume — house: workflow-core#2659. */
const RESUMED_IDLE_MS = 5 * MIN_MS;
/* How long it waits from each typed resume before the next act: untraced
 * (workflow-core#2978, reusing RESUMED_IDLE_MS's figure). */
const IDLE_RETYPE_MS = 5 * MIN_MS;
/* The typed resumes a resumed-idle session gets before its hand-off:
 * untraced (workflow-core#2978, delegated). */
const IDLE_TRIES = 2;

/**
 * @typedef {import("./block-cause.js").Cause} Cause
 * @typedef {"stop-and-park"|"park-at-morning"|"resume"|"hold"
 *   |"handoff-relaunch"|"wait"|"none"} Act  `hold`, stop the session until
 *   its next resume is due, or a resumed-idle one until the swap hold clears
 * @typedef {{cause: Cause, sub?: import("./block-cause.js").ApiErrorKind,
 *   since: number, tries?: number, nextAt?: number, triedAt?: number,
 *   held?: boolean, typing?: boolean, swapHeld?: boolean}} Block  `since`,
 *   the first tick that
 *   read this cause, ms, or for RESUMED_IDLE the later of the harness's
 *   restart row and the loop's last resume; `sub`, an API_ERROR's kind;
 *   `tries`, the resumes made for the launch so far, the last at `triedAt`,
 *   and `nextAt`, when the next is due; `held`, its session stopped until
 *   then; `typing`, a typed resume not yet seen arrive; `swapHeld`, the swap
 *   hold (workflow-core#2690) binding this tick
 * @typedef {(block: Block, now: number) => Act} Rule
 */

/**
 * Resume `k`'s offset from the stop, 0-based.
 * @param {number} k
 * @returns {number}
 */
const resumeOffset = (k) =>
	RESUME_OFFSETS_MS[k] ?? resumeOffset(k - 1) + RESUME_EVERY_MS;

/**
 * When the resume after `tries` resumes is due, the last made at `at`: each
 * gap is the step between two offsets, so a spell that never clears meets
 * them all from its stop, and a session that clears and fails again keeps
 * backing off.
 * @param {number} tries  made so far, at least 1
 * @param {number} at  ms
 */
const nextTryAt = (tries, at) =>
	at + resumeOffset(tries) - resumeOffset(tries - 1);

/**
 * The first REVIEW_HOUR after `since`, machine-local.
 * @param {number} since ms
 */
function morningAfter(since) {
	const d = new Date(since);
	d.setHours(REVIEW_HOUR, 0, 0, 0);
	if (d.getTime() <= since) d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** @type {Rule} */
const stopAtOnce = () => "stop-and-park";
/** @type {Rule} */
const stopAfterGrace = (block, now) =>
	now - block.since >= NORMAL_GRACE_MS ? "stop-and-park" : "wait";
/** @type {Rule} */
const leave = () => "none";

/**
 * Whether a resumed session blocked again before its next try is stopped
 * until then (workflow-core#2359: between tries it holds no memory and no slot).
 * @param {Block} block
 * @param {number} now
 */
const isHoldDue = (block, now) =>
	block.triedAt !== undefined &&
	!block.held &&
	!block.typing &&
	now - block.triedAt >= RETRY_CYCLE_MS;

/**
 * A transient stop's act once its next try is due.
 * @param {Block} block
 * @returns {Act}
 */
function dueAct(block) {
	if ((block.tries ?? 0) >= RESUME_CAP) return "stop-and-park";
	return block.typing ? "wait" : "resume";
}

/**
 * When a transient API stop's next resume is due: the first on the first tick
 * that reads the stop, the harness having spent its own retries, about 3 min,
 * by then (workflow-core#2359).
 * @param {Block} block
 */
const resumeDueAt = (block) => Math.max(block.nextAt ?? 0, block.since);

/**
 * An auth or invalid_request stop parks at once: a resume cannot fix it. A
 * transient one resumes on the schedule, held stopped between tries, and
 * parks at the cap or, away, at the morning review; never relaunched fresh
 * (workflow-core#2359).
 * @param {boolean} away
 * @returns {Rule}
 */
const apiError = (away) => (block, now) => {
	if (block.sub !== "transient") return "stop-and-park";
	if (away && now >= morningAfter(block.since)) return "park-at-morning";
	if (now < resumeDueAt(block)) return isHoldDue(block, now) ? "hold" : "wait";
	return dueAct(block);
};

/**
 * A resumed-idle session is resumed by typing once its restart row has
 * waited the window, and typed into once more after another window with no
 * turn; one still idle after that is handed off to a fresh launch, since the
 * fault is the session's own (workflow-core#2659, workflow-core#2978). Under the swap hold it is
 * stopped at once until the hold clears, its host's restart having retaken
 * the memory the hold is short of, or handed off where its typed resumes are
 * spent (workflow-core#3093).
 * @type {Rule}
 */
const resumedIdle = (block, now) => {
	const tries = block.tries ?? 0;
	if (block.swapHeld) return tries < IDLE_TRIES ? "hold" : "handoff-relaunch";
	if (now - block.since < (tries === 0 ? RESUMED_IDLE_MS : IDLE_RETYPE_MS))
		return "wait";
	return tries < IDLE_TRIES ? "resume" : "handoff-relaunch";
};

/**
 * Away-mode QUESTION: workflow-core#2355. PERMISSION as a question: workflow-core#2360. API_ERROR:
 * workflow-core#2359. LIMIT: workflow-core#2125. UNKNOWN: workflow-core#2358 F9. RESUMED_IDLE: workflow-core#2659, workflow-core#2978.
 * @type {Record<Cause, {away: Rule, normal: Rule}>}
 */
const TABLE = {
	QUESTION: { away: stopAtOnce, normal: stopAfterGrace },
	PERMISSION: { away: stopAtOnce, normal: stopAfterGrace },
	API_ERROR: { away: apiError(true), normal: apiError(false) },
	LIMIT: { away: leave, normal: leave },
	OTHER_DIALOG: { away: leave, normal: leave },
	RESUMED_IDLE: { away: resumedIdle, normal: resumedIdle },
	UNKNOWN: { away: leave, normal: leave },
};

/**
 * @param {Block} block
 * @param {"away"|"normal"} mode
 * @param {number} now ms
 * @returns {Act}
 */
const blockAct = (block, mode, now) => TABLE[block.cause][mode](block, now);

module.exports = { IDLE_TRIES, RESUME_CAP, blockAct, nextTryAt, resumeDueAt };
