/*
 * neighbour-dirt.js — the paths a DIFFERENT live session claims or observes,
 * which `scripts/guard-uncommitted-work.js` subtracts from this session's write
 * ledger to judge which uncommitted tracked paths are its own (workflow-core#615), and
 * `lib/own-selection.js` subtracts for `--isolated`'s dirty-tree attribution
 * (claims only, workflow-core#1922).
 */

const { listedSessionIds } = require("./agent-liveness");
const proc = require("./arbiter-proc");
const store = require("./arbiter-store");

/**
 * @typedef {{ unreadable?: boolean, sessionId?: string, path?: string,
 *   pid?: number, procStart?: string|number, bootId?: string }} Lock
 */
/**
 * @typedef {{ readLocks: () => Lock[]|null,
 *   subjectPath: (p: string) => string }} LockSource
 */

/**
 * Paths a DIFFERENT live session holds a claim on.
 *
 * The write ledger answers "did this session ever write this path", never "is
 * this dirt this session made" — so a file you wrote and committed hours ago,
 * which a neighbour is editing now, would otherwise be named back at you with a
 * commit command that puts their bytes under your message (mantahostels#63, an
 * incident in its closing comment — its title names other work). Their live
 * claim is the one signal that separates the two, so it is subtracted.
 *
 * It reaches only the claimed tiers — `docs/`, `.claude/`, `CLAUDE.md`,
 * `AGENTS.md` and `scripts/`. Outside them the false positive stands: the
 * guard's block carries a diff-before-commit instruction for it.
 * A neighbour who wrote from Bash and so holds no claim is caught by
 * `observedElsewhere` below instead (mantahostels#2282).
 *
 * An unreadable lock store yields the empty set, subtracting nothing; a lock
 * naming no path is passed over.
 * @param {string|undefined} sid
 * @param {LockSource} [ledger] `lib/own-selection.js` passes its injected one
 * @returns {Set<string>}
 */
function claimedElsewhere(sid, { readLocks, subjectPath } = store) {
	const locks = readLocks();
	if (locks === null) return new Set();
	/** @type {Set<string>} */
	const out = new Set();
	for (const lock of locks) {
		if (!lock || lock.unreadable) continue;
		if (lock.sessionId === sid) continue;
		if (!lock.path) continue;
		if (!proc.holderAlive(lock)) continue;
		out.add(subjectPath(lock.path));
	}
	return out;
}

/**
 * Every path a DIFFERENT LIVE session holds an OBSERVATION on
 * — its own baseline on a file it wrote without holding the claim (mantahostels#363,
 * `lib/arbiter-observations.js`). Ruled at mantahostels#2282.
 *
 * A claim is not the only way a neighbour comes to own bytes in a file. On the
 * detect-only `scripts/` tier nothing refuses a Bash-route write and nothing
 * mints a lock for it, so a neighbour can hold uncommitted work with no claim
 * to find (mantahostels#2272).
 *
 * SUBTRACTS ON EXISTENCE, NOT ON PROOF OF BYTES. The neighbour's pinned blob is
 * never compared against HEAD: a live session with an observation on the path is
 * enough. That over-subtracts — this session's own genuinely-uncommitted work
 * goes unnagged whenever a live neighbour touched the same file inside
 * `OBSERVATION_AGE_MS` (7 days) — and the direction is deliberate. A missed nag
 * costs an uncommitted file; a wrong block costs a neighbour's bytes committed
 * under someone else's message.
 *
 * AN OBSERVATION CARRIES NO PID (`lib/arbiter-records.js`'s `ObservationRecord`),
 * so `proc.holderAlive` cannot judge one as it judges a lock. Liveness comes
 * from the `claude agents --json` oracle, as `check-stranded-file-claims.js`
 * reads it — and "live" there INCLUDES the finished-but-resident pool
 * (`lib/agent-liveness.js`'s `finished`, a subset of `ids`), so a completed
 * background session keeps subtracting until the reaper takes it — left alone,
 * its bytes being genuinely still on disk.
 *
 * IT WALKS THE LIVE SESSIONS AND ASKS EACH WHAT IT OBSERVES, rather than
 * reading the whole observation store and judging each record's session — the
 * direction `arbiter-store.js` exports. It is not free: `observedBy` filters by
 * filename but readdirs the WHOLE store to do it, so the cost is one full scan
 * per live session, not the single prefix scan the ruling costed.
 *
 * A CALLER MUST NOT REACH HERE WITH NOTHING TO NAME. The oracle
 * costs ~465 ms (`lib/agent-liveness.js`'s header, which bars it from a
 * `PreToolUse` hook) and is spent before anything else here.
 *
 * NOR MUST THE GUARD FOR A SESSION PAST ITS BLOCK CAP (mantahostels#2383): its cap
 * is decided inside `blockStop`, after this call, so it asks `hookBlock.capSpent`
 * first, which reads that counter without minting it.
 *
 * WHERE THE CHECK CANNOT RUN — an oracle that will not vouch, an observation
 * store that will not open — nothing is subtracted and the path stays named,
 * matching `claimedElsewhere` on an unreadable lock store. `why` is the sentence
 * the refusal then carries.
 *
 * RESIDUAL: a single observation record that will not PARSE is dropped inside
 * `observedBy` and reaches no reader, so a neighbour whose one record is corrupt
 * is invisible here and their path is named. Only a directory that will not open
 * is reported.
 *
 * @param {string} sid
 * @returns {{paths: Set<string>, why: string|null}}
 */
function observedElsewhere(sid) {
	const { ids, why } = listedSessionIds();
	if (!ids) return { paths: new Set(), why };

	const paths = new Set();
	/* One flag, not a count: `observedBy` opens the one shared observations
	 * directory on every call, so darkness is the store's and not a session's. */
	let dark = false;
	for (const id of ids) {
		if (id === sid) continue;
		const observed = store.observedBy(id);
		/* null is "the store would not open", never "observes nothing" (mantahostels#174), so
		 * it sets `why` rather than being read as a clean answer. */
		if (observed === null) {
			dark = true;
			continue;
		}
		/* `subjectPath` is defensive: `recordObservation` already strips the region
		 * at write time, an observation being whole-file where a lock is not. */
		for (const rel of observed) paths.add(store.subjectPath(rel));
	}
	return {
		paths,
		why: dark ? "the arbiter's observation store could not be read" : null,
	};
}

module.exports = { claimedElsewhere, observedElsewhere };
