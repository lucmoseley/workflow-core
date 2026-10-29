/*
 * refill-commands.js — what the refill loop's `start` and `status` commands
 * compute and print, pure (#2012, #2123, spec #1995): the scope a `start`
 * writes over a running loop's, and the lines naming a loop's scope, its
 * launches and its last tick. The control and state they read are
 * lib/refill-loop.js's.
 */

const path = require("node:path");
const { RESUME_CAP } = require("./block-act.js");
const {
	isResuming,
	isSwapHeld,
	iso,
	nextResumeAt,
} = require("./refill-blocks.js");
const {
	buildSeatText,
	buildSkipText,
	buildSeatName,
} = require("./refill-loop.js");

/* Untraced. */
const STATUS_LAUNCHES = 10;
/* The skipped rows `status` lists. Untraced. */
const STATUS_SKIPS = 10;

/** @typedef {import("./refill-loop.js").Control} Control */
/** @typedef {import("./refill-loop.js").Scope} Scope */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-loop.js").LoopState} LoopState */

/**
 * The scope a `start` writes, given the running loop's (null where none
 * runs) and the one asked for from `root`. A normal start adds its repos to
 * a running normal loop's; an away start widens whatever runs; a normal
 * start never narrows a running away mode, nor renews its 24 hours. In
 * every case the asked goal replaces `root`'s, a bare start clearing it
 * (#2119, #2123).
 * @param {Scope|null} running
 * @param {Scope} asked
 * @param {string} root
 * @returns {{scope: Scope, renew: boolean}}
 */
function mergedScope(running, asked, root) {
	if (running === null) return { scope: asked, renew: true };
	const goals = { ...running.goals };
	delete goals[root];
	Object.assign(goals, asked.goals);
	if (asked.mode === "away") return { scope: { ...asked, goals }, renew: true };
	if (running.mode === "away")
		return { scope: { ...running, goals }, renew: false };
	const repos = [...new Set([...running.repos, ...asked.repos])];
	return { scope: { ...asked, repos, goals }, renew: true };
}

/**
 * @param {Control} control
 * @param {number} runMs
 */
const buildStopLine = (control, runMs) =>
	control.stopRequested
		? "stops:     at its next tick, on request"
		: `stops by:  ${iso(control.startedAt + runMs)}`;

/**
 * The lines naming what a loop serves, on which seats and until when.
 * @param {Control} control
 * @param {{runMs: number, served: string[], running: boolean}} opts
 *   `served`, scopeRoots's roots
 */
function buildScopeLines(control, { runMs, served, running }) {
	const { scope } = control;
	const names = (/** @type {string[]} */ roots) =>
		roots.map((r) => path.basename(r)).join(", ") || "none";
	const goals = Object.entries(scope.goals).map(
		([root, issues]) =>
			`${path.basename(root)} ${issues.map((n) => `#${n}`).join(", ")}`,
	);
	const away = scope.mode === "away";
	return [
		away ? "mode:      away (every included repo)" : "mode:      normal",
		`repos:     ${names(served)}`,
		...(away ? [`excluding: ${names(scope.exclude)}`] : []),
		`goal:      ${goals.join("; ") || "none"}`,
		...(running ? [buildStopLine(control, runMs)] : []),
		`seats:     ${control.seats.join(", ") || "none"}`,
	];
}

/**
 * Where a launch stands, for `status`.
 * @typedef {"park-stopped"|"handed-off"|"hand-off-owed"|"finished"
 *   |"resuming"|"swap-held"|"resumed-idle"|"parked"|"running"} LaunchKind
 * @param {LoopLaunch} l
 * @returns {LaunchKind}
 */
function launchKindOf(l) {
	if (l.parkStopped !== undefined) return "park-stopped";
	if (l.handedOff !== undefined) return "handed-off";
	if (l.handOffTries !== undefined) return "hand-off-owed";
	if (l.finishedAt !== null) return "finished";
	if (isResuming(l)) return "resuming";
	if (isSwapHeld(l)) return "swap-held";
	if (l.idleSince !== undefined) return "resumed-idle";
	return l.parked ? "parked" : "running";
}

/** The kinds `status` lists past its launch window: each waits on the
 * founder or on the loop's resumes or hand-off. */
const UNSETTLED = new Set([
	"park-stopped",
	"hand-off-owed",
	"resuming",
	"swap-held",
	"resumed-idle",
	"parked",
]);

/** @param {LoopLaunch} l */
function launchStateOf(l) {
	switch (launchKindOf(l)) {
		case "park-stopped":
			return "parked, stopped";
		case "handed-off":
			return "handed off: stopped idle after its host's restart";
		case "hand-off-owed":
			return `stopped idle after its host's restart, its hand-off failed ${l.handOffTries} times`;
		case "finished":
			return "finished";
		case "resuming": {
			const blocked =
				/** @type {LoopLaunch & {block: import("./block-act.js").Block}} */ (l);
			const next =
				l.resumes?.attachAt === undefined
					? `next at ${iso(nextResumeAt(blocked))}`
					: "its typed resume being checked";
			return `resuming after an API error, ${l.resumes?.tries ?? 0} of ${RESUME_CAP} tries, ${next}`;
		}
		case "swap-held":
			return `stopped under the swap hold since ${iso(/** @type {number} */ (l.swapHeld?.at))}, resumed once it clears`;
		case "resumed-idle": {
			const r = l.idleResumes;
			return `resumed-idle since ${iso(/** @type {number} */ (l.idleSince))}, ${r ? `resumed ${r.tries} times, last at ${iso(r.triedAt)}` : "not yet resumed"}`;
		}
		case "parked":
			return "parked";
		default:
			return "running";
	}
}

/**
 * The launches `status` counts, those since the start and any still running
 * from before a renewal, and of them those it lists: the last
 * STATUS_LAUNCHES and every unsettled one.
 * @param {Control} control
 * @param {LoopState} state
 */
function shownLaunches(control, state) {
	const shown = state.launches.filter(
		(l) => l.launchedAt >= control.startedAt || l.finishedAt === null,
	);
	const listed = shown.filter(
		(l, i) =>
			i >= shown.length - STATUS_LAUNCHES || UNSETTLED.has(launchKindOf(l)),
	);
	return { shown, listed };
}

/**
 * The lines a recorded start gives `status`: launches since it, and any still
 * running from before a renewal.
 * @param {Control} control
 * @param {LoopState} state
 * @param {{runMs: number, served: string[], running: boolean}} opts
 */
function buildControlLines(control, state, opts) {
	const lines = [`started:   ${iso(control.startedAt)}`];
	lines.push(...buildScopeLines(control, opts));
	const since = state.launches.filter(
		(l) => l.launchedAt >= control.startedAt,
	).length;
	const { shown, listed } = shownLaunches(control, state);
	const kinds = shown.map(launchKindOf);
	const running = kinds.filter(
		(k) => k === "running" || k === "resumed-idle",
	).length;
	const parked = kinds.filter(
		(k) => k === "park-stopped" || k === "parked",
	).length;
	lines.push(
		`launches:  ${since} since start, ${running} running, ${parked} parked`,
	);
	for (const l of listed) {
		const at = launchStateOf(l);
		const session = l.sessionId ? `  session ${l.sessionId}` : "";
		lines.push(
			`  ${iso(l.launchedAt)}  ${path.basename(l.root)}  ${l.prompt}  ${at}  ${buildSeatText(l)}${session}`,
		);
	}
	return lines;
}

/**
 * The last tick's line, then the rows it skipped (#2561).
 * @param {NonNullable<LoopState["lastTick"]>} t
 */
function buildLastTickLines(t) {
	const skipped = t.skipped ?? [];
	return [
		`last tick: ${iso(t.at)}  ${t.summary}`,
		...skipped
			.slice(0, STATUS_SKIPS)
			.map((s) => `  skipped ${buildSkipText(s)}`),
		...(skipped.length > STATUS_SKIPS
			? [`  … and ${skipped.length - STATUS_SKIPS} more skipped`]
			: []),
	];
}

/**
 * @param {{control: Control|null, state: LoopState, pid: number|null,
 *   runMs: number, served: string[], codeSha?: string|null}} input `served`,
 *   scopeRoots's roots; `codeSha`, lib/refill-code.js's readRunningCode
 * @returns {string[]}
 */
function buildStatusLines({
	control,
	state,
	pid,
	runMs,
	served,
	codeSha = null,
}) {
	return [
		pid === null
			? "refill loop: not running"
			: `refill loop: running, pid ${pid}`,
		...(pid !== null && codeSha ? [`code:      ${codeSha}`] : []),
		...(control
			? buildControlLines(control, state, {
					runMs,
					served,
					running: pid !== null,
				})
			: ["never started on this machine"]),
		...(state.lastTick ? buildLastTickLines(state.lastTick) : []),
		...(state.stopped
			? [
					`last stop: ${iso(state.stopped.at)}  ${state.stopped.reason} — ${state.stopped.detail}`,
				]
			: []),
	];
}

/**
 * `status --json`: whether the loop runs, and the launch rows `status`
 * lists, each with its seat as a tilde path and why it was picked (#3732),
 * null on a record from before that.
 * @param {{control: Control|null, state: LoopState, pid: number|null}} input
 */
function buildStatusJson({ control, state, pid }) {
	return {
		running: pid !== null,
		pid,
		launches: control
			? shownLaunches(control, state).listed.map((l) => ({
					launchedAt: iso(l.launchedAt),
					root: l.root,
					prompt: l.prompt,
					state: launchStateOf(l),
					seat: buildSeatName(l.seat),
					reason: l.reason ?? null,
					sessionId: l.sessionId ?? null,
				}))
			: [],
	};
}

module.exports = {
	buildScopeLines,
	buildStatusJson,
	buildStatusLines,
	mergedScope,
};
