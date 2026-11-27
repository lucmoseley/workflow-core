// guess, workflow-core#1920
const UNPROVEN_LIMIT = 3;

const UNPROVEN_HELD = `${UNPROVEN_LIMIT} launches since its checkout's last act are running`;
const BREAKER_OPEN = "its checkout's throughput breaker is open";
const PROBE_HELD = "a probe hold stops launches into its checkout";

/**
 * @typedef {{history: import("./refill-decide.js").LaunchRecord[],
 *   lastActAt: Record<string, number>,
 *   resumable?: import("./refill-decide.js").HeldResume[],
 *   breakerRoom?: Record<string, number>,
 *   holds?: import("./refill-decide.js").TickHold[]}} RoomInput
 */

/**
 * @param {{launchedAt: number, slotTakenAt?: number}} l */
const unprovenFrom = (l) => Math.max(l.launchedAt, l.slotTakenAt ?? 0);

/**
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
	return Math.max(0, UNPROVEN_LIMIT - unproven);
}

/**
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
 * @param {RoomInput} input
 */
function buildLaunchRoom(input) {
	const { breakerRoom = {} } = input;
	const probeHeld = buildProbeHeldRoots(input.holds);
	/** @param {string} root @returns {string|null} */
	const heldWhy = (root) => {
		if (probeHeld.has(root)) return PROBE_HELD;
		return (breakerRoom[root] ?? 1) <= 0 ? BREAKER_OPEN : null;
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
	UNPROVEN_LIMIT,
	PROBE_HELD,
	buildSpentRoom,
	UNPROVEN_HELD,
};
