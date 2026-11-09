/*
 * refill-block-core.js — what the refill loop's acts on blocked launches share
 * across causes (#4295): the launch predicates, the stop, the park and the
 * relaunch record, for lib/refill-blocks.js and lib/refill-limits.js. Its own
 * module because refill-blocks.js requires refill-limits.js, so the limit
 * module requiring these from refill-blocks.js would be a require cycle.
 */

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

/**
 * The dispatch-ledger row `l` holds its issues by: a copy's is its first
 * job's (#2963).
 * @param {JobLaunch} l
 */
const ledgerOf = (l) => ({ jobId: ledgerJobOf(l), root: l.root });

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** @param {{root: string, prompt: string}} l */
const launchName = (l) => `${path.basename(l.root)} ${l.prompt}`;

/**
 * Whether `l` is unfinished and tied to a job. A launch with no job id is never
 * judged, so it never finishes and is not live.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isLive = (l) => l.finishedAt === null && l.jobId !== null;

/**
 * Whether the loop may act on `l`'s session: live and not stopped already for
 * a park.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isActionable = (l) => isLive(l) && l.parkStopped === undefined;

/**
 * Whether `l` waits on the loop's resumes after a transient API stop.
 * @param {LoopLaunch} l
 */
const isResuming = (l) =>
	l.block?.cause === "API_ERROR" &&
	l.block.sub === "transient" &&
	l.parkStopped === undefined;

/**
 * Whether `l`'s stopped session waits on the tick's resume step.
 * @template {LoopLaunch} L
 * @param {L} l
 * @returns {l is L & {stepResume: StepResume}}
 */
const isStepResume = (l) => l.stepResume !== undefined;

/**
 * Whether the loop stopped `l`'s session on its seat's limit (#3735).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isLimitHeld = (l) => l.limitHeld !== undefined;

/**
 * Whether the loop stopped `l`'s session to wait for its next resume, for
 * the swap hold to clear (#3093) or for a seat with room (#3735): the launch
 * stays unfinished until a resume takes, it parks or it is handed off.
 * @param {LoopLaunch} l
 */
const isHeld = (l) =>
	(isResuming(l) && l.resumes?.heldAt !== undefined) ||
	isStepResume(l) ||
	isLimitHeld(l);

/**
 * The job ids the listing shows blocked.
 * @param {AgentRecord[]} agents
 */
const blockedIdsOf = (agents) =>
	new Set(agents.filter((a) => a.state === PARKED_STATE).map((a) => a.id));

/**
 * The loop log's line for a park it stopped, or could not; `brief`, the
 * issue comment's, each reason cut to its first line, never a stack (#3670).
 * @param {BlockedLaunch & {act?: Act, whyEnded?: string,
 *   hold?: ParkWhy["hold"]}} l  `whyEnded`, why a held session's wait ended
 * @param {"away"|"normal"} mode
 * @param {{failed: string|null, unlabelled: {n: number, why: string}[],
 *   unmarkedWhy?: string|null}} outcome  `unmarkedWhy`, why the labelled issues are
 *   not in the session's marker
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
 * Add `l`'s labelled issues to its session's `.parked-` marker, so the
 * founder's typing there takes the label off (unpark-on-prompt.js, #3584);
 * null once recorded or with none labelled, else why not.
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

/**
 * The park's closing words on the issue: where this limit-cap park ends the
 * loop's relaunches, says so (#3804).
 * @param {number|undefined} limitParks
 */
const buildRelaunchEndText = (limitParks) =>
	isAtLimitCap(limitParks)
		? ` The loop will not relaunch it: ${buildLimitCapText(limitParks)}.`
		: "";

/**
 * `claude stop` on `l`'s job; null once stopped, else why not. A job the loop
 * already stopped to wait for its next resume (isHeld) may be gone, so a
 * stop that finds no job is that stop, not a failure.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 */
function stopJob(l, io) {
	const r = io.stop(l.seat, l.jobId);
	if (r.ok) return null;
	return isHeld(l) && r.noJob ? null : r.why;
}

/**
 * Park `l`, its session stopped: label its issues `parked`, record them in its
 * session's marker and comment its cause on them, since a stopped session's own
 * words may not say why it waits (#2846). `l`, marked `parkStopped`, and
 * `parkedAway` in away mode.
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
		`Refill loop: ${buildParkStopLine(parking, mode, outcome, { brief: true })}. The conversation is kept: \`claude attach\` reopens it.${why.hold ? " The loop resumes it once the hold clears." : ""}${outcome.unmarkedWhy ? "" : buildRelaunchEndText(why.limitParks)}`,
	);
	/* A park on a hold comes back through the hold's resume step, so its ledger
	 * row is not released for a fresh launch to race it (#4228). */
	return {
		...l,
		parkStopped: now,
		...(mode === "away" && !why.hold ? { parkedAway: true } : {}),
	};
}

/**
 * Stop `l`'s park and, where the stop held, park it (parkOnceStopped).
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
 * `l` after a resume that restarted its job at `now`: `relaunchedAt` set,
 * from which it has the listing's grace. Where the job is a copy, `l` tracks
 * the copy's job and session id, its dispatch-ledger hold still the job
 * first launched (#2963), and `fromSessionId`, the session it resumed, kept
 * among its past ones for actsOf (#2969), with any original whose job would
 * not retire (withUnretired); a job woken in place keeps both, and a headless
 * resume keeps its session under the new run's job id (#4580).
 * @param {JobLaunch} l
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} resumed
 * @param {number} now
 * @returns {JobLaunch}
 */
function relaunched(l, resumed, now) {
	const { jobId, sessionId, fromSessionId } = resumed;
	if (!resumed.copy)
		return {
			...l,
			jobId,
			...(sessionId ? { sessionId } : {}),
			relaunchedAt: now,
		};
	const { sessionId: _, ...rest } = l;
	const past = new Set([...(l.pastSessionIds ?? []), fromSessionId]);
	return withUnretired(
		{
			...rest,
			jobId,
			copiedFrom: l.copiedFrom ?? l.jobId,
			relaunchedAt: now,
			...(sessionId ? { sessionId } : {}),
			pastSessionIds: [...past],
		},
		resumed,
	);
}

/**
 * `l` with copy `r`'s original, where its job would not retire, added to
 * those a later tick retries (lib/refill-blocks.js's retireOriginals, #4646).
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {Extract<Resumed, {failed: null}>} r
 * @returns {L}
 */
const withUnretired = (l, r) =>
	r.copy && r.unretired
		? { ...l, unretired: [...(l.unretired ?? []), r.unretired] }
		: l;

/**
 * How resume `r` started its job: woken in place, or as a copy with the
 * reason the harness gave (#4098).
 * @param {Extract<Resumed, {failed: null}>} r
 */
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
	withUnretired,
	stopJob,
	stopPark,
};
