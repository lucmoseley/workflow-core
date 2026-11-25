const { STAMP_PATHS } = require("./stamp-paths.js");
const { claimHolder } = require("./pick-next-sessions.js");
const { pathsNamedIn } = require("./write-set-predict.js");

/** @typedef {{ok: true, files: string[]} | {ok: false, error: string}} TrackedFiles */
/** @typedef {import("./pick-next-verdict.js").Issue} Issue */

/** @typedef {Issue & {paths: string[]}} Pathed */

/**
 * @param {Issue[]} list
 * @param {TrackedFiles} tracked
 * @returns {Pathed[]}
 */
function annotatePaths(list, tracked) {
	return list.map((i) => ({
		...i,
		paths: tracked.ok ? pathsNamedIn(i.body, tracked.files) : [],
	}));
}

/**
 * @param {{paths: string[]}} a
 * @param {{paths: string[]}} b
 */
const sharedPaths = (a, b) => a.paths.filter((p) => b.paths.includes(p));

/**
 * @param {Pathed[]} list
 * @returns {{a: number, b: number, paths: string[]}[]}
 */
function pairwiseCollisions(list) {
	const out = [];
	for (const [at, a] of list.entries())
		for (const b of list.slice(at + 1)) {
			const shared = sharedPaths(a, b);
			if (shared.length > 0)
				out.push({ a: a.number, b: b.number, paths: shared });
		}
	return out;
}

/**
 * @param {Pathed[]} candidates
 * @param {Pathed[]} inFlight
 * @param {Map<number, any>} held
 */
function crossCollisions(candidates, inFlight, held) {
	const out = [];
	for (const c of candidates)
		for (const r of inFlight) {
			const shared = sharedPaths(c, r);
			if (shared.length > 0)
				out.push({
					candidate: c.number,
					inFlight: r.number,
					claimedBy: r.assignees,
					claimedSession: held.get(r.number) ?? null,
					paths: shared,
				});
		}
	return out;
}

/**
 * @param {Pathed[]} frontier
 * @param {Issue[]} enriched
 * @param {Map<number, any>} held
 * @param {TrackedFiles} tracked
 */
function collisionsOf(frontier, enriched, held, tracked) {
	const collisions = tracked.ok ? pairwiseCollisions(frontier) : [];
	const inFlight = annotatePaths(
		enriched.filter((i) => held.has(i.number)),
		tracked,
	);
	const inFlightCollisions = tracked.ok
		? crossCollisions(frontier, inFlight, held)
		: [];
	return { collisions, inFlightCollisions };
}

// measured 94 pairs in one live run, lucmoseley/mantahostels#384
const INFLIGHT_PRINT_CAP = 20;

/**
 * @param {{tracked: TrackedFiles, collisions: ReturnType<typeof collisionsOf>["collisions"], inFlightCollisions: ReturnType<typeof collisionsOf>["inFlightCollisions"], docMapQueue: number[], claims: {kept?: boolean}, listed: {names?: Map<string, string>|null}}} state
 * @returns {string[]}
 */
function collisionBlockLines(state) {
	const {
		tracked,
		collisions,
		inFlightCollisions,
		docMapQueue,
		claims,
		listed,
	} = state;
	if (!tracked.ok)
		return [
			`\nPOSSIBLE FILE COLLISIONS — unavailable: could not list tracked files\n  ${tracked.error}`,
		];
	if (collisions.length === 0 && inFlightCollisions.length === 0) return [];
	/** @param {{paths: string[]}} c */
	const isStampPair = (c) => c.paths.every((p) => STAMP_PATHS.includes(p));
	const stampCollisions = collisions.filter(isStampPair);
	const suppressed = stampCollisions.length;
	const stampsShared = STAMP_PATHS.filter((p) =>
		stampCollisions.some((c) => c.paths.includes(p)),
	);
	const lines = [
		"\nPOSSIBLE FILE COLLISIONS — repo paths named in both issue bodies.\nAdvisory: the order above is unchanged, and a body may name a file it\nonly refers to. Bodies naming no file can still collide.\n`in flight` is a claimed issue: a session may be writing that file now.\n",
		...collisions
			.filter((c) => !isStampPair(c))
			.map(
				(c) =>
					`  possible collision: #${c.a} <-> #${c.b} on ${c.paths.join(", ")}`,
			),
	];
	if (suppressed) {
		const pointToQueue =
			docMapQueue.length > 0 && stampsShared.includes("docs/doc-map.md");
		lines.push(
			`  ${suppressed} pair${suppressed === 1 ? "" : "s"} sharing only a stamp path (${stampsShared.join(", ")}) suppressed${
				pointToQueue ? " — see the DOC-MAP QUEUE below" : ""
			}; --json carries every pair.`,
		);
	}
	for (const c of inFlightCollisions.slice(0, INFLIGHT_PRINT_CAP))
		lines.push(
			`  in flight: #${c.candidate} <-> #${c.inFlight} (claimed by ${claimHolder(c.claimedBy, c.claimedSession, claims.kept, listed.names)}) on ${c.paths.join(", ")}`,
		);
	if (inFlightCollisions.length > INFLIGHT_PRINT_CAP)
		lines.push(
			`  ... and ${inFlightCollisions.length - INFLIGHT_PRINT_CAP} more in-flight pairs — --json carries every one.`,
		);
	return lines;
}

module.exports = { annotatePaths, collisionBlockLines, collisionsOf };
