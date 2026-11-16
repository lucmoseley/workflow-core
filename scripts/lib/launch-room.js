/*
 * launch-room.js — how many launches and resumes a refill tick may start in a
 * checkout, and why it starts none (#5290). Every site that sizes or explains
 * a checkout's room reads it here.
 */

/* Three finishes in a row with no progress pause their checkout (#1920, #3859),
 * and as many launches since its last act are all that run unproven there
 * (#4200, #4223, #5275). */
const NO_PROGRESS_RUN = 3;

const UNPROVEN_HELD = `${NO_PROGRESS_RUN} launches since its checkout's last act are running`;
const REPO_PAUSED = "a no-progress pause stops launches into its checkout";
/* A row in a checkout whose open throughput breaker leaves it no launch
 * (#5275). */
const BREAKER_OPEN = "its checkout's throughput breaker is open";
const PROBE_HELD = "a probe hold stops launches into its checkout";

/**
 * `breakerRoom` holds each checkout whose
 * breaker is open: 0 where it takes nothing, 1 where it takes its one trial
 * launch, never a resume (lib/refill-breaker.js).
 * @typedef {{history: import("./refill-decide.js").LaunchRecord[],
 *   lastActAt: Record<string, number>,
 *   resumable?: import("./refill-decide.js").HeldResume[],
 *   repoPaused?: Record<string, import("./refill-decide.js").Pause>,
 *   breakerRoom?: Record<string, number>,
 *   holds?: import("./refill-decide.js").TickHold[]}} RoomInput
 */

/**
 * When `l` last took a slot, from which the unproven cap counts it: a restart
 * that kept its slot, in place, moved or typed-resume's fallback, adds no
 * session, so leaves its date (#4684). Residual: a launch resumed from held
 * before slotTakenAt was written counts from its launch until it finishes.
 * @param {{launchedAt: number, slotTakenAt?: number}} l */
const unprovenFrom = (l) => Math.max(l.launchedAt, l.slotTakenAt ?? 0);

/**
 * How many more launches and resumes may start in `root` before an act proves
 * one (#4223, #5275): NO_PROGRESS_RUN less its running launches launched, or
 * resumed into a slot, after its `lastActAt`, every one where it has none, a
 * launch with no job yet among them (so not refill-blocks' isActionable). One the
 * loop stopped, for a park or on its seat's limit and not since resumed, runs no
 * session, and one due back this tick is counted as its resume.
 * @param {Pick<RoomInput, "history"|"lastActAt"|"resumable">} input
 * @param {string} root
 */
function unprovenRoom({ history, lastActAt, resumable = [] }, root) {
	const due = new Set(resumable.map((r) => r.jobId));
	const since = lastActAt[root] ?? null;
	const unproven = history.filter(
		(l) =>
			l.root === root &&
			l.finishedAt === null &&
			l.parkStopped === undefined &&
			!(l.limitHeld && l.limitHeld.resumedAt === undefined) &&
			!(l.jobId && due.has(l.jobId)) &&
			(since === null || unprovenFrom(l) > since),
	).length;
	return Math.max(0, NO_PROGRESS_RUN - unproven);
}

/**
 * The checkouts launches are stopped from: those with a `probe` hold, the only
 * kind that stops any (#3860).
 * @param {import("./refill-decide.js").TickHold[]} [holds]
 */
const buildProbeHeldRoots = (holds = []) =>
	new Set(holds.filter((h) => h.kind === "probe").map((h) => h.root));

/**
 * @param {(root: string) => number} roomOf
 */
function buildSpentRoom(roomOf) {
	/** @type {Map<string, number>} */
	const spent = new Map();
	return {
		/** @param {string} root */
		left: (root) => roomOf(root) - (spent.get(root) ?? 0),
		/** @param {string} root */
		spend: (root) => spent.set(root, (spent.get(root) ?? 0) + 1),
	};
}

/**
 * Each checkout's launch room this tick, spent as launches and resumes start:
 * `heldWhy`, why a hold stops every start there whatever its room (a probe
 * hold, else an open breaker with no trial due, else a no-progress pause), or
 * null; `launchLeft`, the launches it may still take; `resumeLeft`, the
 * resumes, none under an open breaker; `spentWhy`, why `launchLeft` is 0, or
 * null; `spend`, one start taken.
 * @param {RoomInput} input
 */
function buildLaunchRoom(input) {
	const { repoPaused = {}, breakerRoom = {} } = input;
	const probeHeld = buildProbeHeldRoots(input.holds);
	/** @param {string} root @returns {string|null} */
	const heldWhy = (root) => {
		if (probeHeld.has(root)) return PROBE_HELD;
		if ((breakerRoom[root] ?? 1) <= 0) return BREAKER_OPEN;
		return repoPaused[root] === undefined ? null : REPO_PAUSED;
	};
	const launch = buildSpentRoom((root) =>
		heldWhy(root) === null
			? Math.min(
					unprovenRoom(input, root),
					breakerRoom[root] ?? Number.POSITIVE_INFINITY,
				)
			: 0,
	);
	/** @param {string} root */
	const isBreakerOpen = (root) => breakerRoom[root] !== undefined;
	return {
		heldWhy,
		launchLeft: launch.left,
		/** @param {string} root */
		resumeLeft: (root) => (isBreakerOpen(root) ? 0 : launch.left(root)),
		/** @param {string} root @returns {string|null} */
		spentWhy: (root) => {
			if (launch.left(root) > 0) return null;
			return (
				heldWhy(root) ?? (isBreakerOpen(root) ? BREAKER_OPEN : UNPROVEN_HELD)
			);
		},
		spend: launch.spend,
	};
}

/** @typedef {ReturnType<typeof buildLaunchRoom>} LaunchRoom */

module.exports = {
	BREAKER_OPEN,
	buildLaunchRoom,
	buildProbeHeldRoots,
	NO_PROGRESS_RUN,
	PROBE_HELD,
	REPO_PAUSED,
	buildSpentRoom,
	UNPROVEN_HELD,
};
