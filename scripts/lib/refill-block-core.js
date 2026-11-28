const { buildLoopComment } = require("./loop-comment.js");
const path = require("node:path");
const { buildLimitCapText, isAtLimitCap } = require("./refill-decide.js");
const { seatIdOf } = require("./refill-seats.js");
const { ledgerJobOf } = require("./refill-state.js");

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").BlockedLaunch} BlockedLaunch
 * @typedef {import("./refill-blocks.js").ParkWhy} ParkWhy
 * @typedef {import("./block-act.js").Act} Act
 * @typedef {import("./refill-blocks.js").AgentRecord} AgentRecord
 * @typedef {import("./refill-blocks.js").StepResume} StepResume
 * @typedef {import("./refill-blocks.js").Resumed} Resumed
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-blocks.js").BlockIo} BlockIo
 * @typedef {import("./refill-limits.js").LimitHeld} LimitHeld
 */

/* The listed state of a session parked on a question
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F1). */
const PARKED_STATE = "blocked";

/** @param {JobLaunch} l */
const ledgerOf = (l) => ({ jobId: ledgerJobOf(l), root: l.root });

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** @param {{root: string, prompt: string}} l */
const launchName = (l) => `${path.basename(l.root)} ${l.prompt}`;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isLive = (l) => l.finishedAt === null && l.jobId !== null;

/**
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isActionable = (l) => isLive(l) && l.parkStopped === undefined;

/** @param {LoopLaunch} l */
const isResuming = (l) =>
	l.block?.cause === "API_ERROR" &&
	l.block.sub === "transient" &&
	l.parkStopped === undefined;

/**
 * @template {LoopLaunch} L
 * @param {L} l
 * @returns {l is L & {stepResume: StepResume}}
 */
const isStepResume = (l) => l.stepResume !== undefined;

/**
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isLimitHeld = (l) => l.limitHeld !== undefined;

/** @param {LoopLaunch} l */
const isHeld = (l) =>
	(isResuming(l) && l.resumes?.heldAt !== undefined) ||
	isStepResume(l) ||
	isLimitHeld(l);

/** @param {AgentRecord[]} agents */
const blockedIdsOf = (agents) =>
	new Set(agents.filter((a) => a.state === PARKED_STATE).map((a) => a.id));

/**
 * @param {BlockedLaunch & {act?: Act, whyEnded?: string,
 *   hold?: ParkWhy["hold"]}} l
 * @param {"away"|"normal"} mode
 * @param {{failed: string|null, unlabelled: {n: number, why: string}[],
 *   unmarkedWhy?: string|null}} outcome
 * @param {{brief?: boolean}} [opts]
 */
function buildParkStopLine(
	l,
	mode,
	{ failed, unlabelled, unmarkedWhy = null },
	{ brief = false } = {},
) {
	const reason = (/** @type {string} */ why) =>
		brief ? why.split(/\r?\n/)[0] : why;
	const tried = l.resumes ? `, ${l.resumes.tries} resumes` : "";
	const morning = l.act === "park-at-morning" ? ", at the morning cut-off" : "";
	const ended = l.whyEnded ? `, ${l.whyEnded}` : "";
	const held = l.hold
		? `, attached to repo hold ${l.hold.id} (#${l.hold.issue})`
		: "";
	const what = `${l.block.cause} park ${launchName(l)} (${mode} mode, blocked since ${iso(l.block.since)}${tried}${morning}${ended}${held})`;
	if (failed) return `could not stop ${what}: ${failed}`;
	const labelled = labelledOf(l, unlabelled);
	return [
		`stopped ${what}`,
		`labelled parked: ${labelled.map((n) => `#${n}`).join(", ") || "none"}`,
		...unlabelled.map((u) => `not labelled #${u.n}: ${reason(u.why)}`),
		...(unmarkedWhy
			? [`left parked until claimed, not on his typing: ${reason(unmarkedWhy)}`]
			: []),
	].join("; ");
}

/**
 * @param {{issues: number[]}} l
 * @param {{n: number}[]} unlabelled
 */
function labelledOf(l, unlabelled) {
	const missed = new Set(unlabelled.map((u) => u.n));
	return l.issues.filter((n) => !missed.has(n));
}

/**
 * @param {LoopLaunch} l
 * @param {number[]} labelled
 * @param {number|undefined} limitParks
 * @param {BlockIo} io
 */
function markLabelled(l, labelled, limitParks, io) {
	if (labelled.length === 0) return null;
	if (!l.sessionId) return "no session id read";
	return io.recordParked(l.sessionId, labelled, {
		root: l.root,
		job: l.jobId
			? { ...seatIdOf(l), jobId: l.jobId, cwd: io.readJobCwd(l.seat, l.jobId) }
			: null,
		limitParks,
		cause: l.block?.cause,
	});
}

/** @param {number|undefined} limitParks */
const buildRelaunchEndText = (limitParks) =>
	isAtLimitCap(limitParks)
		? ` The loop will not relaunch it: ${buildLimitCapText(limitParks)}.`
		: "";

/**
 * @param {JobLaunch} l
 * @param {BlockIo} io
 */
function stopJob(l, io) {
	const r = io.stop(l.seat, l.jobId);
	if (r.ok) return null;
	return isHeld(l) && r.noJob ? null : r.why;
}

/**
 * @param {BlockedLaunch} l
 * @param {ParkWhy} why
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function parkOnceStopped(l, why, mode, { now, io }) {
	const parking = { ...l, ...why };
	const unlabelled = io.labelParked(l);
	const outcome = {
		failed: null,
		unlabelled,
		unmarkedWhy: markLabelled(l, labelledOf(l, unlabelled), why.limitParks, io),
	};
	io.log(buildParkStopLine(parking, mode, outcome));
	io.comment(
		l,
		buildLoopComment(
			`${buildParkStopLine(parking, mode, outcome, { brief: true })}. The conversation is kept: \`claude attach\` reopens it.${why.hold ? " The loop resumes it once the hold clears." : ""}${outcome.unmarkedWhy ? "" : buildRelaunchEndText(why.limitParks)}`,
		),
	);
	return {
		...l,
		parkStopped: now,
		...(mode === "away" && !why.hold ? { parkedAway: true } : {}),
	};
}

/**
 * @param {BlockedLaunch} l
 * @param {ParkWhy} why
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function stopPark(l, why, mode, seen) {
	const failed = stopJob(l, seen.io);
	if (failed) {
		seen.io.log(
			buildParkStopLine({ ...l, ...why }, mode, { failed, unlabelled: [] }),
		);
		return l;
	}
	return parkOnceStopped(l, why, mode, seen);
}

/**
 * @param {JobLaunch} l
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} resumed
 * @param {number} now
 * @param {{tookSlot: boolean}} how
 * @returns {JobLaunch}
 */
function relaunched(l, resumed, now, { tookSlot }) {
	const { jobId, sessionId, fromSessionId } = resumed;
	const at = { relaunchedAt: now, ...(tookSlot ? { slotTakenAt: now } : {}) };
	if (!resumed.copy)
		return {
			...l,
			jobId,
			...(sessionId ? { sessionId } : {}),
			...at,
		};
	const { sessionId: _, ...rest } = l;
	const past = new Set([...(l.pastSessionIds ?? []), fromSessionId]);
	return withUnretired(
		{
			...rest,
			jobId,
			copiedFrom: l.copiedFrom ?? l.jobId,
			...at,
			...(sessionId ? { sessionId } : {}),
			pastSessionIds: [...past],
		},
		resumed,
	);
}

/**
 * @template {import("./refill-blocks.js").HasUnretired} L
 * @param {L} l
 * @param {Extract<Resumed, {failed: null}>} r
 * @returns {L}
 */
const withUnretired = (l, r) =>
	r.copy && r.unretired
		? { ...l, unretired: [...(l.unretired ?? []), r.unretired] }
		: l;

/** @param {Extract<Resumed, {failed: null}>} r */
const buildResumedHow = (r) =>
	r.copy ? `as its copy ${r.jobId} (${r.why})` : "woken in place";
module.exports = {
	PARKED_STATE,
	blockedIdsOf,
	buildResumedHow,
	isActionable,
	isHeld,
	isLimitHeld,
	isLive,
	isResuming,
	isStepResume,
	iso,
	launchName,
	ledgerOf,
	parkOnceStopped,
	relaunched,
	stopJob,
	stopPark,
	withUnretired,
};
