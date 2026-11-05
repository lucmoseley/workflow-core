/*
 * pick-next-collisions.js — which issues scripts/pick-next.js reports as
 * naming the same repo file: two shortlisted candidates (mantahostels#192), and a
 * candidate with an issue a live session is on (mantahostels#384).
 *
 * ADVISORY ONLY, and deliberately not a sort input or an exclusion. A body may
 * name a file as context rather than as an edit target, and inferring edit
 * *intent* from prose is where precision dies — mantahostels#185 measured a prose-content
 * detector at ~15% while its presence check was fine.
 *
 * Out of pick-next.js so each pairing is tested by calling it (#4329). The
 * tracked-file list and the claims are read there and handed in.
 */

const { pathsNamedIn } = require("./write-set-predict.js");

/** @typedef {{ok: true, files: string[]} | {ok: false, error: string}} TrackedFiles */
/** @typedef {import("./pick-next-verdict.js").Issue} Issue */

/**
 * An issue `annotatePaths` has run over, which is the only place `paths` is
 * safe to read.
 * @typedef {Issue & {paths: string[]}} Pathed
 */

/*
 * Path resolution and the backtick scan live in `lib/write-set-predict.js`, so
 * the prediction a run STORES and the collisions it PRINTS are read off one
 * scanner rather than two that can drift (mantahostels#1001).
 */

/**
 * Each issue with the tracked paths its body names; none if git failed.
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
 * The paths two annotated issues both name, in the first one's order.
 *
 * Typed on the one field it reads rather than on `Issue`: the second argument
 * is an in-flight record as often as a candidate, and those two agree on
 * `paths` and on nothing else worth asserting here (mantahostels#1460).
 * @param {{paths: string[]}} a
 * @param {{paths: string[]}} b
 */
const sharedPaths = (a, b) => a.paths.filter((p) => b.paths.includes(p));

/**
 * Every pair of the given issues sharing at least one named path, in list order.
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
 * Every pair of a candidate and an in-flight (claimed) issue sharing a path.
 * The in-flight set is dropped from the shortlist, so `pairwiseCollisions`
 * above can never see it — yet it is the set someone is writing right now.
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
					// Joined only at the print; --json readers get the list.
					claimedBy: r.assignees,
					// The claim's own session (mantahostels#708): `claimedBy` is empty where a
					// session recorded without assigning.
					claimedSession: held.get(r.number) ?? null,
					paths: shared,
				});
		}
	return out;
}

/**
 * The run's two collision lists: frontier pairs, and frontier-to-in-flight
 * pairs. Both empty where git could not list the tracked files.
 *
 * The in-flight set is the issues a live session is on — the arbiter claim
 * alone (mantahostels#270, narrowed at mantahostels#645), never the assignee, so a claim recorded by a
 * session that never assigned counts. They are excluded from the shortlist, so
 * nothing else ever pairs them; a candidate that shares a file with one is
 * a candidate whose session would be writing under a live one.
 *
 * An assignment with no live claim is deliberately NOT in flight: the run
 * offers that issue as takeable, so pairing it here would warn against work it
 * is simultaneously recommending — and pairwiseCollisions already covers it.
 * @param {Pathed[]} frontier the whole frontier, annotated
 * @param {Issue[]} enriched every open issue
 * @param {Map<number, any>} held the claims a live session holds, by issue
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

module.exports = { annotatePaths, collisionsOf };
