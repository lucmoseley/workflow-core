const { isListedLive } = require("./agent-liveness.js");
const arbiter = require("./arbiter-store");
const { isReadableLock } = require("./arbiter-records.js");
const { STAMP_PATHS, withoutStamps } = require("./stamp-paths.js");

/**
 * @typedef {{number: number, writeSet: string[], source: string,
 *   sizeBand: string|null, unrevalidated: boolean}} Candidate
 * @typedef {{path: string, sessionId: string|null, session: string}} HeldFile
 * @typedef {{files: HeldFile[], kept: boolean, why: string|null}} Held
 * @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions
 * @typedef {{a: number, b: number, paths: string[]}} Pair
 * @typedef {{paths: Set<string>, with: Set<number>}} Nomination
 */

/** @param {{source: string}} c */
const isSizeless = (c) => c.source !== "band-read";

/**
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
 * @param {ListedSessions|null|undefined} listed
 * @param {Set<number>|null|undefined} openIssues
 * @returns {Held}
 */
function readHeldFiles(listed, openIssues) {
	const locks = arbiter.readLocks();
	if (locks === null)
		return {
			files: [],
			kept: false,
			why: "the claim store could not be read, so no held file was checked",
		};
	const live = listed?.ids ?? null;
	const claimsList = openIssues ? arbiter.listIssueClaims() : null;
	const issuesOf = issuesBySession(claimsList);
	const claimsWhy = openIssues ? claimsReadWhy(claimsList) : null;
	const me = process.env.CLAUDE_CODE_SESSION_ID || null;
	/** @type {HeldFile[]} */
	const files = [];
	for (const lock of locks.filter(isReadableLock)) {
		if (!isOtherLock(lock, me)) continue;
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
 * @param {import("./arbiter-records.js").LockRecord} lock
 * @param {string|null} me
 * @returns {boolean}
 */
function isOtherLock(lock, me) {
	if (!lock.path) return false;
	return !(me && lock.sessionId === me);
}

/**
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

/** @param {{candidates: Candidate[], held: Held, stamps?: string[]}} input */
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
		nominated: candidates
			.filter((c) => nominations.has(c.number))
			.map((c) => {
				const row = /** @type {Nomination} */ (nominations.get(c.number));
				return {
					number: c.number,
					paths: [...row.paths].sort(),
					with: [...row.with].sort((x, y) => x - y),
				};
			}),
		noWriteSet: candidates
			.filter((c) => c.writeSet.length === 0)
			.map((c) => c.number),
		heldDegraded: held.why ? { why: held.why, kept: held.kept } : null,
	};
}

/**
 * @param {Candidate[]} candidates
 * @param {string[]} stamps
 */
function pairUp(candidates, stamps) {
	/** @type {Pair[]} */
	const conflicts = [];
	/** @type {Pair[]} */
	const stampPairs = [];
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
 *   nominations: Map<number, Nomination>}} acc
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
 * @param {Map<number, Nomination>} nominations
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
 * @param {Candidate[]} candidates
 * @param {Held} held
 * @param {string[]} stamps
 */
function heldOverlaps(candidates, held, stamps) {
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
	const ruledOutBySession = new Map(inFlight.map((r) => [r.candidate, r]));
	/** @type {Map<string, number>} */
	const taken = new Map();
	/** @type {number[]} */
	const proposed = [];
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
	/** @type {Map<string, number>} */
	const perFile = new Map();
	for (const c of conflicts)
		for (const p of c.paths) perFile.set(p, (perFile.get(p) || 0) + 1);
	return [...perFile]
		.map(([path, pairs]) => ({ path, pairs }))
		.sort((a, b) => b.pairs - a.pairs || a.path.localeCompare(b.path));
}

module.exports = { writeSetsFor, readHeldFiles, buildGraph };
