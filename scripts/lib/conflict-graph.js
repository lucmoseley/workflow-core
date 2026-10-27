/*
 * conflict-graph.js — the substrate-conflict graph selection reads (mantahostels#1002).
 *
 * WHAT THIS MODULE MAY SAY, AND WHAT IT MAY NOT (mantahostels#506).
 *
 * It may say two issues name the same file, and that a live session holds a file
 * a candidate names. It may NOT say that file is a SUBSTRATE — the half of a
 * write-set that disqualifies, as against a STAMP written once at the end to
 * record a result. That call turns on WHEN a ticket writes the file, which no
 * path can carry, and it stays the reader's, in
 * `.claude/skills/pick-next/SKILL.md` §5. The exceptions below are
 * `docs/doc-map.md`, ruled a stamp for this backlog at mantahostels#422, and `CLAUDE.md`,
 * ruled one at mantahostels#1281, and already discounted by the collision block this
 * graph sits under.
 *
 * `docs/reference-roadmap.html` IS ABSENT BY RULING, NOT BY OVERSIGHT (mantahostels#1074).
 * The pairs naming it are exactly the pressure STAMP_PATHS' comment below exists
 * to resist. It was considered and ruled READER-TESTED PER TICKET
 * instead, the test being in `.claude/skills/pick-next/SKILL.md` §5. Do not
 * re-litigate the absence, and do not add `docs/roadmap-digest.md` either — the
 * pair is one unit and takes one verdict (mantahostels#1075).
 *
 * `CLAUDE.md` IS PRESENT BY RULING (mantahostels#1281). Of the 34
 * issues predicted to write it, 30 only cite the path and NONE uses it as a
 * substrate (mantahostels#1279). A collision takes the `docs/doc-map.md` regime,
 * abandon-and-debt, in all 12 measured cases (mantahostels#1277). The always-loaded byte
 * cap, the coupling unique to this file, is orthogonal (mantahostels#1280). Do not
 * un-stamp it on contention: `docs/doc-map.md` collides nearly three times as
 * often and is the ruled stamp (mantahostels#422).
 *
 * So the proposed set is a CANDIDATE, never a verdict: the skill still admits by
 * default and removes only on a named disqualifier. NOTHING IS EVER REFUSED ON
 * IT — `scripts/lib/file-claim.js` stays the only enforcement tier.
 */

const { isListedLive } = require("./agent-liveness.js");
const arbiter = require("./arbiter-store");

/**
 * A candidate row as `writeSetsFor` builds it, and the held-file rows
 * `readHeldFiles` answers with. `sizeBand` is free text off the band read, so it stays
 * a string here and is normalised where it is compared.
 *
 * @typedef {{number: number, writeSet: string[], source: string,
 *   sizeBand: string|null, unrevalidated: boolean}} Candidate
 * @typedef {{path: string, sessionId: string|null, session: string}} HeldFile
 * @typedef {{files: HeldFile[], kept: boolean, why: string|null}} Held
 * @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions
 * @typedef {{a: number, b: number, paths: string[]}} Pair
 * @typedef {{paths: Set<string>, with: Set<number>}} Nomination
 */

/*
 * The stamp allowlist. A file earns a place here only by a ruling that issues
 * sharing it run together — never by how many candidates name it.
 */
const STAMP_PATHS = ["docs/doc-map.md", "CLAUDE.md"];

/*
 * Whether a band read could still tell you anything about this row's `sizeBand`.
 *
 * THE TEST IS THE SOURCE, NEVER `sizeBand` ITSELF (mantahostels#1484). A provisional row's size
 * is null precisely because nobody has read it, so testing `sizeBand == null` would
 * exclude the very rows a nomination list exists to name; `band-read` is the
 * only source that carries a size at all.
 *
 * ⚠ RESIDUAL: a band read stored without one — `write-set-cache.js` writes
 * `sizeBand: sizeBand ?? null` and validates nothing — reads as `band-read` with no
 * size, and is never nominated.
 */
/** @param {{source: string}} c */
const isSizeless = (c) => c.source !== "band-read";

/**
 * @param {string} p
 * @param {string[]} stamps
 */
const isStamp = (p, stamps) => stamps.includes(p);
/**
 * @param {string[]} paths
 * @param {string[]} stamps
 */
const withoutStamps = (paths, stamps) =>
	paths.filter((p) => !isStamp(p, stamps));

/**
 * Every candidate's predicted write-set, in the ranking order handed in.
 *
 * THREE SOURCES, NAMED RATHER THAN BLENDED. `band-read` is a write-set an agent
 * derived, and carries the `small` size the merge test needs. `grep` is a
 * PROVISIONAL entry the selection run predicted for itself off the same body
 * (mantahostels#1001) — a write-set with no size, so it can never enter the merge test.
 * `body` is a cache miss falling back to the repo paths the body happens to
 * backtick, which is the floor the collision block already prints. The source
 * rides on every row, because nothing here may be refused on a prediction (mantahostels#588)
 * and a reader has to be able to tell which rows are one.
 *
 * @param {{number: number, paths?: string[]}[]} frontier
 * @param {{number: number, writeSet?: string[], provisional?: boolean,
 *   sizeBand?: string|null, unrevalidated?: boolean}[]|null|undefined} warm
 * @returns {Candidate[]}
 */
function writeSetsFor(frontier, warm) {
	const byNumber = new Map((warm || []).map((w) => [w.number, w]));
	return frontier.map((i) => {
		const hit = byNumber.get(i.number);
		return hit
			? {
					number: i.number,
					writeSet: [...(hit.writeSet || [])].sort(),
					source: hit.provisional === true ? "grep" : "band-read",
					sizeBand: hit.sizeBand || null,
					unrevalidated: hit.unrevalidated === true,
				}
			: {
					number: i.number,
					writeSet: [...(i.paths || [])].sort(),
					source: "body",
					sizeBand: null,
					unrevalidated: false,
				};
	});
}

/**
 * The files live sessions hold, from the arbiter's claim store.
 *
 * LIVENESS IS THE AGENTS ORACLE, NOT THE LOCK'S OWN PID TEST. `session-arbiter
 * list` judges a holder by pid and process start, which calls a RESUMED session
 * dead; this script already decides every other liveness question by the set
 * `claude agents --json` reports — listed and not terminal (#637).
 *
 * FAIL-OPEN, ALOUD. An unreadable oracle keeps every claim rather than dropping
 * it, and an unreadable store reports why instead of returning an empty set.
 *
 * @param {ListedSessions|null|undefined} listed
 * @param {Set<number>|null|undefined} openIssues Every open issue's number,
 *   off the same listing the frontier is built from. Omitted, the
 *   closed-issue check below is skipped.
 * @returns {Held}
 */
function readHeldFiles(listed, openIssues) {
	// No try/catch: readLocks() catches its own errors and answers `null` for a
	// store it could not read at all, so a throw here would be unreachable and
	// its handler untestable.
	const locks = arbiter.readLocks();
	if (locks === null)
		return {
			files: [],
			kept: false,
			why: "the claim store could not be read, so no held file was checked",
		};
	const live = listed?.ids ?? null;
	/*
	 * A FINISHED SESSION `claude agents --json` HAS NOT YET REAPED, AND DOES NOT
	 * MARK TERMINAL, STAYS "LIVE" BY THAT TEST ALONE — release is Unenforced
	 * (mantahostels#121, mantahostels#126), so a session that closed its issue an
	 * hour ago can still hold every claim it never gave up. `listIssueClaims()`
	 * is the same register the assignee itself is read off (mantahostels#645,
	 * arbiter-issue-claims.js): a lock's holder is stranded on a closed issue,
	 * not in flight, only where EVERY issue it has ever claimed sits outside
	 * `openIssues`.
	 *
	 * A SESSION SITS ON MORE THAN ONE RECORD. `claimIssue` writes one file per
	 * (issue, session) and never clears an earlier one on a later claim, so a
	 * session working open #B with a stale, unreleased record on closed #A
	 * holds both. Picking either record ALONE — first- or last-written — risks
	 * the unsafe direction: a live #B session judged by its #A record would
	 * have every file it holds dropped from `held.files`, and pick-next would
	 * propose a candidate onto a file that session is still writing. So every
	 * issue a session has ever claimed is kept, and the drop fires only where
	 * none of them is open.
	 *
	 * UNREADABLE, THIS SKIPS AND SAYS SO, never a silent skip: the store's own
	 * `why` — a torn record dropped, or the directory unreadable outright — is
	 * folded into the return below.
	 */
	const claimsList = openIssues ? arbiter.listIssueClaims() : null;
	const issuesOf = issuesBySession(claimsList);
	const claimsWhy = openIssues ? claimsReadWhy(claimsList) : null;
	/*
	 * THIS RUN'S OWN CLAIMS ARE NOT A HOLD, exactly as admission counts sessions
	 * "less this run's own". Selection only ever reads, so a file the picking
	 * session holds is left over from work it has already finished — and treating
	 * it as in flight would rule out candidates on the strength of the reader's
	 * own history.
	 */
	const me = process.env.CLAUDE_CODE_SESSION_ID || null;
	/** @type {HeldFile[]} */
	const files = [];
	for (const lock of locks) {
		if (!isReadableOtherLock(lock, me)) continue;
		if (!isLiveHolder(lock.sessionId, { listed, issuesOf, openIssues }))
			continue;
		files.push({
			path: lock.path,
			sessionId: lock.sessionId ?? null,
			session: holderName(lock.sessionId, listed),
		});
	}
	const liveWhy =
		live === null ? listed?.why || "liveness was not read at all" : null;
	return {
		files,
		kept: live === null || Boolean(claimsWhy),
		why: joinWhy(liveWhy, claimsWhy),
	};
}

/**
 * @param {NonNullable<ReturnType<typeof arbiter.readLocks>>[number]} lock
 * @param {string|null} me
 * @returns {boolean}
 */
function isReadableOtherLock(lock, me) {
	if (!lock || lock.unreadable || !lock.path) return false;
	return !(me && lock.sessionId === me);
}

/**
 * Whether `sessionId`'s claims still count as in flight: listed live where
 * liveness was read, and not stranded on closed issues where those were.
 *
 * @param {string|null|undefined} sessionId
 * @param {{listed: ListedSessions|null|undefined,
 *   issuesOf: Map<string, Set<number>>,
 *   openIssues: Set<number>|null|undefined}} at
 */
function isLiveHolder(sessionId, { listed, issuesOf, openIssues }) {
	const live = listed?.ids ?? null;
	if (live !== null && !isListedLive(sessionId, live, listed?.terminal))
		return false;
	return !(openIssues && strandedOnClosed(sessionId, issuesOf, openIssues));
}

/**
 * @param {{why: string|null}|null} claimsList
 * @returns {string|null}
 */
function claimsReadWhy(claimsList) {
	if (claimsList === null)
		return "the issue-claims store could not be read, so a claim held on a since-closed issue may still be shown as in flight";
	return claimsList.why;
}

/**
 * Every issue each session has ever claimed, off the issue-claims register.
 *
 * @param {ReturnType<typeof arbiter.listIssueClaims>} claimsList
 * @returns {Map<string, Set<number>>}
 */
function issuesBySession(claimsList) {
	/** @type {Map<string, Set<number>>} */
	const issuesOf = new Map();
	if (!claimsList) return issuesOf;
	for (const c of claimsList.claims)
		if (c?.sessionId && typeof c.issue === "number") {
			const set = issuesOf.get(c.sessionId) || new Set();
			set.add(c.issue);
			issuesOf.set(c.sessionId, set);
		}
	return issuesOf;
}

/**
 * Whether every issue `sessionId` has claimed sits outside `openIssues` —
 * false for a session with no claim on record.
 *
 * @param {string|null|undefined} sessionId
 * @param {Map<string, Set<number>>} issuesOf
 * @param {Set<number>} openIssues
 */
function strandedOnClosed(sessionId, issuesOf, openIssues) {
	if (!sessionId) return false;
	const claimed = issuesOf.get(sessionId);
	if (!claimed) return false;
	return ![...claimed].some((n) => openIssues.has(n));
}

/**
 * @param {string|null|undefined} sessionId
 * @param {ListedSessions|null|undefined} listed
 * @returns {string}
 */
function holderName(sessionId, listed) {
	return (
		listed?.names?.get(/** @type {string} */ (sessionId)) ||
		(sessionId ? String(sessionId).slice(0, 8) : "an unnamed session")
	);
}

/**
 * @param {string|null} liveWhy
 * @param {string|null} claimsWhy
 * @returns {string|null}
 */
function joinWhy(liveWhy, claimsWhy) {
	if (liveWhy && claimsWhy) return `${liveWhy}; also, ${claimsWhy}`;
	return liveWhy || claimsWhy || null;
}

/**
 * The graph itself. `candidates` is writeSetsFor()'s output, in ranking order;
 * `held` is readHeldFiles()'s.
 *
 * Pure: it reads no store, no clock and no machine.
 *
 * @param {{candidates: Candidate[], held: Held, stamps?: string[]}} input
 */
function buildGraph({ candidates, held, stamps = STAMP_PATHS }) {
	const { conflicts, stampPairs, stampsShared, nominations } = pairUp(
		candidates,
		stamps,
	);
	const { inFlight, stampQueued } = heldOverlaps(candidates, held, stamps);
	const { proposed, dropped } = proposeSet(candidates, inFlight, stamps);
	const mergeable = mergeablePairs(candidates, [...conflicts, ...stampPairs]);
	const conflictsByFile = countByFile(conflicts);

	return {
		stamps,
		/*
		 * The rows themselves, so a consumer of the graph can tell a band-read
		 * write-set from a body's passing backtick.
		 */
		candidates: candidates.map((c) => ({
			number: c.number,
			writeSet: c.writeSet,
			source: c.source,
			sizeBand: c.sizeBand,
			unrevalidated: c.unrevalidated === true,
		})),
		conflicts,
		conflictsByFile,
		stampSharing: {
			pairs: stampPairs.length,
			paths: [...stampsShared].sort(),
			list: stampPairs,
		},
		inFlight,
		stampQueued,
		proposed,
		dropped,
		mergeable,
		/*
		 * BAND-READ NOMINATIONS — the issues §4 of
		 * `.claude/skills/pick-next/SKILL.md` band-reads, and the only ones (mantahostels#1484).
		 *
		 * A band read buys `sizeBand`, and `sizeBand` is consumed by exactly one thing —
		 * the merge test in `mergeablePairs`, whose third limb is "every issue in the merge sized
		 * `small`" (mantahostels#503). So a candidate's size can change an outcome only where
		 * it (a) has none and (b) shares a non-stamp path with another candidate.
		 *
		 * STAMP-ONLY OVERLAPS NOMINATE NOBODY. Issues sharing only
		 * `docs/doc-map.md` (mantahostels#422) or `CLAUDE.md` (mantahostels#1281) run together, so their
		 * sizes decide nothing — this list is built off `substrate`, the
		 * stamp-stripped overlap, for that reason. ⚠ CONSEQUENCE: `mergeable`
		 * still admits a stamp-only pair, so one with a sizeless side can now never
		 * acquire the size that would surface it. Rejected the wider list because
		 * a stamp pair runs together whether or not it is called a merge.
		 *
		 * ONE CLASS WIDER THAN `provisional`: mantahostels#1484 wrote the rule as "either side
		 * of the pair is provisional", but a `body`-sourced row carries no size
		 * either, so omitting it would reproduce the same blindness one class down.
		 *
		 * ONLY THE SIZELESS SIDE IS NOMINATED. A warm partner already has its size;
		 * nominating it back would pay for a read whose answer is already stored.
		 *
		 * ⚠ RESIDUAL: the overlap driving this is a PREDICTED write-set, so a
		 * candidate in `noWriteSet`, or one whose real shared path was never
		 * predicted, is not nominated and its merge is silently lost.
		 */
		nominated: candidates
			.filter((c) => nominations.has(c.number))
			.map((c) => {
				/* Filtered on `nominations.has` one line above. */
				const row = /** @type {Nomination} */ (nominations.get(c.number));
				return {
					number: c.number,
					paths: [...row.paths].sort(),
					with: [...row.with].sort((x, y) => x - y),
				};
			}),
		// A candidate nothing predicted for cannot appear in any block above, so
		// its absence from them means nothing at all.
		noWriteSet: candidates
			.filter((c) => c.writeSet.length === 0)
			.map((c) => c.number),
		heldDegraded: held.why ? { why: held.why, kept: held.kept } : null,
	};
}

/**
 * Every pair of candidates sharing a path, split into substrate conflicts and
 * stamp-only pairs, with the sizeless sides a substrate overlap nominates for
 * a band read.
 *
 * @param {Candidate[]} candidates
 * @param {string[]} stamps
 */
function pairUp(candidates, stamps) {
	/** @type {Pair[]} */
	const conflicts = [];
	/** @type {Pair[]} */
	const stampPairs = [];
	// The stamps actually shared, not the whole allowlist.
	/** @type {Set<string>} */
	const stampsShared = new Set();
	/** @type {Map<number, Nomination>} */
	const nominations = new Map();
	const acc = { conflicts, stampPairs, stampsShared, nominations };
	for (const [i, a] of candidates.entries())
		for (const b of candidates.slice(i + 1)) recordPair(acc, a, b, stamps);
	return acc;
}

/**
 * @param {{conflicts: Pair[],
 *   stampPairs: Pair[],
 *   stampsShared: Set<string>,
 *   nominations: Map<number, Nomination>}} acc accumulator: the pair is
 *   recorded as a conflict, with its nominations, or as a stamp pair
 * @param {Candidate} a
 * @param {Candidate} b
 * @param {string[]} stamps
 */
function recordPair(acc, a, b, stamps) {
	const shared = a.writeSet.filter((p) => b.writeSet.includes(p));
	if (shared.length === 0) return;
	const substrate = withoutStamps(shared, stamps);
	const pair = {
		a: a.number,
		b: b.number,
		paths: substrate.length > 0 ? substrate : shared,
	};
	if (substrate.length > 0) {
		acc.conflicts.push(pair);
		nominate(acc.nominations, a, b, substrate);
		nominate(acc.nominations, b, a, substrate);
	} else {
		acc.stampPairs.push(pair);
		for (const path of shared) acc.stampsShared.add(path);
	}
}

/**
 * @param {Map<number, Nomination>} nominations accumulator: a sizeless candidate's row gains the paths and partner
 * @param {Candidate} c
 * @param {Candidate} partner
 * @param {string[]} paths
 */
function nominate(nominations, c, partner, paths) {
	if (!isSizeless(c)) return;
	const row = nominations.get(c.number) || {
		paths: new Set(),
		with: new Set(),
	};
	for (const p of paths) row.paths.add(p);
	row.with.add(partner.number);
	nominations.set(c.number, row);
}

/**
 * The candidates naming a file a live session holds: on a substrate path
 * in flight, on stamps alone queued behind it.
 *
 * @param {Candidate[]} candidates
 * @param {Held} held
 * @param {string[]} stamps
 */
function heldOverlaps(candidates, held, stamps) {
	// One lock file per path, so the map cannot collide; first writer wins all the
	// same, since which session is named changes nothing about the overlap.
	/** @type {Map<string, HeldFile>} */
	const holderOf = new Map();
	for (const f of held.files)
		if (!holderOf.has(f.path)) holderOf.set(f.path, f);

	/** @type {{candidate: number, paths: string[], session: string,
	 *   sessionId: string|null}[]} */
	const inFlight = [];
	/** @type {typeof inFlight} */
	const stampQueued = [];
	for (const c of candidates) {
		const hits = c.writeSet.filter((p) => holderOf.has(p));
		if (hits.length === 0) continue;
		const substrate = withoutStamps(hits, stamps);
		const paths = substrate.length > 0 ? substrate : hits;
		/* `hits` is exactly the paths `holderOf` carries and `paths` is a
		 * non-empty subset of it, so the lookup always answers. */
		const [first] = paths;
		const holder = first === undefined ? undefined : holderOf.get(first);
		if (!holder)
			throw new Error(`#${c.number}'s held paths name no holding session`);
		const row = {
			candidate: c.number,
			paths,
			session: holder.session,
			sessionId: holder.sessionId,
		};
		if (substrate.length > 0) inFlight.push(row);
		else stampQueued.push(row);
	}
	return { inFlight, stampQueued };
}

/**
 * @param {Candidate[]} candidates
 * @param {{candidate: number, paths: string[], session: string,
 *   sessionId: string|null}[]} inFlight
 * @param {string[]} stamps
 */
function proposeSet(candidates, inFlight, stamps) {
	/*
	 * The proposed set: admitted greedily down the ranking, each candidate
	 * dropped only where a non-stamp path it names is already spoken for. Greedy
	 * rather than a maximum-independent-set search, because the order it walks is
	 * the ranking — a larger set found by
	 * dropping a top-ranked issue for two tail ones is not the better set.
	 *
	 * A candidate with an empty write-set is admitted: nothing predicted is not
	 * the same as nothing written, and the skill admits by default.
	 */
	const ruledOutBySession = new Map(inFlight.map((r) => [r.candidate, r]));
	/** @type {Map<string, number>} */
	const taken = new Map();
	/** @type {number[]} */
	const proposed = [];
	/* `why` is the printed sentence; the fields after it are its parts, for a
	 * reader that must not parse it (#591's not-launched list). */
	/** @type {({number: number, why: string, paths: string[]} &
	 *   ({kind: "held", heldBy: string, sessionId: string|null} |
	 *    {kind: "clash", with: number}))[]} */
	const dropped = [];
	for (const c of candidates) {
		const running = ruledOutBySession.get(c.number);
		if (running) {
			dropped.push({
				number: c.number,
				why: `${running.session} holds ${running.paths.join(", ")}`,
				kind: "held",
				heldBy: running.session,
				sessionId: running.sessionId,
				paths: running.paths,
			});
			continue;
		}
		const clash = withoutStamps(c.writeSet, stamps).find((p) => taken.has(p));
		if (clash) {
			dropped.push({
				number: c.number,
				why: `#${taken.get(clash)} already in the set names ${clash}`,
				kind: "clash",
				with: /** @type {number} */ (taken.get(clash)),
				paths: [clash],
			});
			continue;
		}
		for (const p of withoutStamps(c.writeSet, stamps)) taken.set(p, c.number);
		proposed.push(c.number);
	}
	return { proposed, dropped };
}

/**
 * @param {Candidate[]} candidates
 * @param {Pair[]} pairs
 */
function mergeablePairs(candidates, pairs) {
	/*
	 * The merge test's MECHANICAL limbs only (mantahostels#503): the pair names one file and
	 * both are sized `small`. Its third limb — disjoint edit targets, one entry
	 * of a file against another, say `§B15` against `§B17` — is a judgement made
	 * from the band read and held in the
	 * session's context, never persisted and never derived here (mantahostels#506).
	 *
	 * Stamp-sharing pairs belong here: a doc-map §B entry apiece is the canonical
	 * merge.
	 */
	/*
	 * `sizeBand` is free text — `pick-next-cache.js put` validates nothing — so a band
	 * read writing `Small` must not silently vanish from the merge list.
	 */
	/** @param {unknown} v */
	const small = (v) =>
		String(v ?? "")
			.trim()
			.toLowerCase() === "small";
	const byBand = new Map(candidates.map((c) => [c.number, c.sizeBand]));
	return pairs
		.filter((p) => small(byBand.get(p.a)) && small(byBand.get(p.b)))
		.map((p) => ({ ...p }));
}

/**
 * @param {Pair[]} conflicts
 * @returns {{path: string, pairs: number}[]}
 */
function countByFile(conflicts) {
	/*
	 * The shape the capped pair list cannot show. One hot file — the roadmap pair,
	 * `CLAUDE.md` — makes hundreds of pairs, and 20 of them printed all name the
	 * same issue, which reads as one crowded candidate rather than one crowded
	 * file.
	 */
	/** @type {Map<string, number>} */
	const perFile = new Map();
	for (const c of conflicts)
		for (const p of c.paths) perFile.set(p, (perFile.get(p) || 0) + 1);
	return [...perFile]
		.map(([path, pairs]) => ({ path, pairs }))
		.sort((a, b) => b.pairs - a.pairs || a.path.localeCompare(b.path));
}

module.exports = { STAMP_PATHS, writeSetsFor, readHeldFiles, buildGraph };
