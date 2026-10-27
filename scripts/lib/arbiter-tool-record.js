/*
 * arbiter-tool-record.js — what the arbiter records after a tool call
 * lands: a tool write's ledger entry and content, and the refresh after a
 * Bash call. The `record` and `refresh` subcommands of session-arbiter.js
 * and the PostToolUse dispatcher cores (#2787) both run these.
 *
 * THE WRITE LEDGER: recordToolWrite notes that THIS session wrote this file
 * (mantahostels#114).
 *
 * The ledger it appends to is what scripts/concision-backstop.sh intersects its
 * diff against; that file's header carries why.
 *
 * POST, NOT PRE. Only a tool call that returned actually wrote a file. Recording
 * at PreToolUse would bill a session for a write the file-claim guard had just
 * denied it — the precise second-order harm mantahostels#114 exists to remove, since acting
 * on that demand means editing a file a live session holds.
 *
 * TOOL WRITES ONLY — a Bash-route write is credited to NOBODY, deliberately
 * (ruled a silent gap at mantahostels#114, reaffirmed and measured at mantahostels#296). A write
 * reaching a file by cp, mv, tee, a > redirect, sed -i, perl -i, a heredoc,
 * git restore, git checkout -- <path> or a script is absent from this ledger and
 * is attributed to no session at all rather than guessed at.
 *
 * What decides it is not the price of a parser: BOTH consumers prefer a missing
 * entry to a false one, in OPPOSITE directions. A false entry makes
 * concision-backstop.sh LOUDER — it bills a session for a diff it does not own,
 * and the nag then sends that session to edit a file a live neighbour holds, the
 * collision guard-file-claim.sh exists to refuse. A false entry makes
 * guard-commit-form.js QUIETER — a neighbour's staged path reads as the
 * session's own work and the warn goes silent, and that warn is the last line
 * before mantahostels#63.
 *
 * Measured cost of the gap (mantahostels#296, 1,579 transcripts / 789 sessions,
 * 18 Jul - 15 Aug 2026): 16 sessions Bash-wrote a watched path they never
 * tool-wrote and then ran a pathspec-less `git commit`, so the commit-form warn
 * named their own work as foreign — capped by that warn printing its own caveat
 * inline. On the concision backstop, 28 sessions had a tracked file changed only
 * via Bash and 0 went un-nagged; every one was caught on its other files, so the
 * miss is the pass's scope, not the pass.
 *
 * Crediting held paths instead adds almost nothing: 84% of Bash-write hits
 * reaching a watched prefix (495 of 586) and 75% of session-path pairs (156 of
 * 207) go to a path the session had already tool-written — and refreshAfterBash refreshes only
 * paths a session already holds a claim on, normally minted by that same tool
 * write, so the ledger-invisible residual holds no claim to refresh. And no Bash
 * parser, because completeness
 * is unreachable — 46.7% of raw Bash-write hits have a destination hidden behind
 * a variable, glob or command substitution.
 *
 * PARTLY REVERSED AT mantahostels#2778, and this file is not where it happened. The ruling
 * left THIS recorder tool-only; scripts/lib/claimed-bash-write.js, which
 * already parses a Bash command's write targets AND already reads the live-claim
 * store at that moment, now also appends an uncontended code target to the same
 * ledger. What answered the "no Bash parser" objection above is not a better
 * parser — completeness is still unreachable — but the contention filter: a path
 * another live session holds is never credited, so the parser's errors can no
 * longer produce the collision that made over-billing the worse direction.
 *
 * Its warrant is a figure the measurement above does not cover: mantahostels#296's "28
 * sessions, 0 un-nagged" was the PROSE pass catching them on other files, and a
 * prose catch does not fire the code-review nag. concision-backstop.sh's header
 * carries what the code signal actually missed.
 *
 * What would invalidate this: a consumer that would rather over-attribute than
 * under-attribute, or a route to attribution that does not depend on parsing a
 * command line. Figures move with the corpus. DO NOT mix mantahostels#296's corpus with
 * mantahostels#286's (709 transcripts, 15 Jul - 13 Aug): their watched-prefix hit counts
 * differ by an order of magnitude (660 vs 47), the bulk being mutation-test
 * traffic counted per target, so the two do not measure the same quantity.
 */

const store = require("./arbiter-store.js");

/** @typedef {import("./arbiter-store.js").Identity} Identity */

/**
 * The PostToolUse path, after a tool write that actually landed.
 *
 * It does two separate things to two separate stores: attributes the write to
 * this session in the ledger (mantahostels#114), and re-records what the file now holds
 * against this session's claim (mantahostels#295).
 * @param {string|undefined} filePath
 * @param {string} sessionId
 */
function recordToolWrite(filePath, sessionId) {
	if (!filePath) return;
	const rel = store.recordWrite(filePath, sessionId);
	if (rel !== null && store.isWatched(rel))
		recordFor(rel, store.identify(sessionId));
}

/**
 * Re-record `rel` against whichever record this session has on it (mantahostels#363).
 *
 * recordContent answers null for every case the observation covers, so the first
 * non-null is the right one.
 *
 * It takes an identity rather than a session id because refreshAfterBash loops:
 * identify() walks the sessions registry, and paying that per path would charge
 * every Bash call in every session for it.
 * @param {string} rel
 * @param {Identity} me
 * @param {{viaBash?: boolean}} [options]
 */
function recordFor(rel, me, options) {
	return (
		store.recordContent(rel, me) ?? store.recordObservation(rel, me, options)
	);
}

/**
 * The PostToolUse-on-Bash path (mantahostels#295): re-record every path this session holds,
 * because a Bash command may have written any of them and no other hook sees it.
 *
 * Without it, a session's own `sed -i` version bump on a file it holds reports as
 * a clobber (the measured share is in mantahostels#288).
 *
 * It refreshes what this session HOLDS, never what the command names: parsing a
 * shell command for its write targets is the arms race mantahostels#287 declined, and the
 * held set is both smaller and exactly right.
 *
 * It also SCANS (mantahostels#419): the held set is right for a session that tool-wrote
 * the file first, and empty for one that only ever reached it from Bash. The
 * scan mints a baseline for what moved, never a lock.
 * @param {string} sessionId
 */
function refreshAfterBash(sessionId) {
	const held = store.readHeldBy(sessionId);
	// The observed paths ride the same refresh (mantahostels#363).
	const observed = store.readObservedBy(sessionId);
	// null is an unreadable store, not an empty hold (mantahostels#174) — so each is skipped on
	// its own. Nothing to say either way: this runs after every Bash call in every
	// session, and the fault is already logged where it happened.
	if (held === null && observed === null) return;
	const me = store.identify(sessionId);
	const covered = new Set([...(held ?? []), ...(observed ?? [])]);
	// viaBash on BOTH loops, not the scan's alone. An observation the scan minted
	// stands on a path with no lock at all, and refreshing it under the tool
	// route's rules records nothing — so the session's SECOND `sed -i` on its own
	// file reports as a clobber.
	for (const rel of covered) recordFor(rel, me, { viaBash: true });
	// The scan must not give one writer two baselines.
	for (const rel of store.scanChanged(sessionId))
		if (!covered.has(rel)) recordFor(rel, me, { viaBash: true });
}

module.exports = { recordToolWrite, refreshAfterBash };
