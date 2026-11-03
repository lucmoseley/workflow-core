/*
 * stranded-count.js — STRANDED_AFTER_HOURS and hoursHeld are shared with
 * check-stranded-file-claims.js's presentation; countStranded is the
 * headline count pick-next.js prints from the same threshold, so the two
 * numbers never drift apart (mantahostels#1206).
 *
 * The same module owns the ACTIONABLE SUBSET (mantahostels#1780) — which standing
 * claims sit on a file carrying uncommitted work — for the same reason: the
 * stranded-claim report and pick-next's headline both print it.
 *
 * classifyClaims owns the WHOLE LOOP, not just the per-lock predicate
 * (mantahostels#1800) — check-stranded-file-claims.js keeps only its own presentation
 * shapes and the dirty-file annotation. `countStranded` still calls it with no
 * `hours`, by design (its signature is frozen so pick-next.js does not
 * change), so a `--hours` sweep and pick-next's default-threshold headline can
 * still disagree, at that one call site only.
 *
 * "NEVER DRIFT APART" IS THE SHARED LOOP'S GUARANTEE AND THE READER'S. Both
 * read the STRICT `listedSessionIds()` (workflow-core#1390), so the two never answer from
 * different readers (mantahostels#2555): neither the sweep nor pick-next is a
 * SessionStart hook, and the WAIVED `sweepSessionIds()` would bite mostly on a
 * short list, where it calls a live claim stranded. RESIDUAL: a session that
 * runs pick-next before the daemon lists it — measured within 5 s for an
 * interactive one, unmeasured for a background one (docs/environment.md
 * §Counting live sessions) — reads the headline as unknown, as its admission
 * count does. The two numbers can still disagree on an
 * ordinary race between two processes' oracle reads, and on a `--hours` sweep
 * against pick-next's frozen default (above).
 */

const { isListedLive } = require("./agent-liveness.js");

// The arbiter's module, not its CLI: session-arbiter.js exports nothing (mantahostels#158).
const { paths, subjectPath } = require("./arbiter-store");
const { gitOrNull } = require("./git.js");

/*
 * How long a claim must stand after its holder stops being listed before the
 * reports count it as stranded.
 *
 * A THRESHOLD ON WHAT IS SAID, NEVER ON WHAT IS DONE: nothing releases a claim
 * at any age (mantahostels#318 refused expiry), and the caller's oracle read already keeps
 * live sessions out of the count. So its job is keeping noise out of an
 * informational report, plus one piece of insurance: sitting above the longest
 * a claim has ever been legitimately held, so that even where the liveness
 * oracle wrongly lists a live session as gone, the count names only the
 * certainly dead.
 *
 * DERIVED at mantahostels#1746 from mantahostels#1745's census of 151 stale claims
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/stranded-claim-age-distribution.md): no holder lived more
 * than 9.2 h after taking a claim (median 0.9 h), and 12 is the smallest of
 * the census's measured candidate thresholds (1/3/6/12/24/48/72/168 h) above
 * that ceiling.
 */
const STRANDED_AFTER_HOURS = 12;

/*
 * Every caller in this repo passes a real `terminal` set today
 * (listedSessionIds() carries one) — this default exists
 * only so a bare call, as
 * the tests below still make, does not throw. A future caller with a real
 * oracle read that forgets to pass its `terminal` set silently re-creates
 * mantahostels#2765's exemption rather than failing loud.
 */
const EMPTY_IDS = new Set();

/**
 * Whole hours a claim has stood, or null where its timestamp is unreadable.
 * @param {string | undefined} claimedAt
 */
function hoursHeld(claimedAt) {
	const at = Date.parse(claimedAt ?? "");
	if (!Number.isFinite(at)) return null;
	return (Date.now() - at) / 3_600_000;
}

/*
 * Paths git reports as carrying uncommitted work, as a set of repo-relative
 * spellings matching the ones a lock holds.
 *
 * `-uall` rather than guard-uncommitted-work.js's `-uno`: an untracked scratch
 * file is exactly where an abandoned session's findings sit.
 *
 * `-z` because porcelain v1 C-quotes any path with a space or a non-ASCII byte,
 * and a quoted path never matches the raw one the lock holds.
 *
 * NOTHING BUT THE `git status` CALL IS INSIDE THE try. A catch wide enough to
 * cover the whole body means "anything threw", not "git could not answer", and
 * reads as every claim being clean (mantahostels#1747).
 *
 * ONE FORK FOR THE WHOLE SET. arbiter-store's subjectDirty() is the precise
 * per-claim test and costs three git calls each, which neither caller can
 * spend (mantahostels#1780).
 *
 * @returns {Set<string> | null} null where git could not answer at all — the
 *   caller then reports the count and itemises nothing, rather than calling
 *   every claim clean.
 */
function readDirtyPaths() {
	const root = paths.repoRoot();
	const out = gitOrNull(["status", "--porcelain", "-z", "-uall"], {
		cwd: root,
	});
	if (out === null) return null;
	const fields = out.split("\0").values();
	const dirty = new Set();
	for (const entry of fields) {
		// "XY <path>": two status letters, a space, then the path. Anything
		// shorter is the trailing empty field `-z` leaves, never a record.
		if (entry.length < 4) continue;
		dirty.add(entry.slice(3));
		// A rename or copy spends the NEXT NUL-separated field on its source, and
		// the letter sits in either column — `R ` staged, ` R` unstaged.
		if (/[RC]/.test(entry.slice(0, 2))) {
			const source = fields.next().value;
			if (source) dirty.add(source);
		}
	}
	return dirty;
}

/**
 * Whether a claim's subject carries uncommitted work.
 *
 * THROUGH subjectPath, NEVER the raw claim. A lock's `path` is a claim SUBJECT,
 * so a region claim spells itself `docs/doc-map.md#B42` and git has never heard
 * of it (mantahostels#1747). A region claim is judged by its WHOLE file, so a neighbour's
 * live edit elsewhere in that file reads as work to recover.
 *
 * @param {Set<string> | null} dirty readDirtyPaths()'s result.
 * @param {string} subject the lock's `path`.
 */
function isDirtyClaim(dirty, subject) {
	return dirty?.has(subjectPath(subject)) === true;
}

/** @typedef {import("./arbiter-store").ListedLock} Lock */

/**
 * Whether a lock is stranded, and where not, why not — the one place either
 * reader decides it. check-stranded-file-claims.js branches on this verdict,
 * through `classifyClaims`, for its own unreadable/young split rather than
 * repeating the tests, so a change here moves both numbers together (mantahostels#1780, on mantahostels#1206's rule).
 *
 * `unreadable` is the coarse verdict: the sweep splits it further, into a lock
 * that would not parse and one naming no session, which need different words.
 *
 * @param {Lock} lock
 * @param {Set<string>} listedIds the caller's oracle read — listedSessionIds()
 *   for both the stranded-claim report and pick-next's headline (workflow-core#1390).
 * @param {number} [hours] the sweep's `--hours <n>` override; the derived
 *   threshold otherwise.
 * @param {Set<string>} [terminalIds] the same oracle read's `terminal` pool —
 *   sessions the oracle still lists but has marked done, failed or stopped
 *   (mantahostels#2765, widened past `done` alone at mantahostels#2774). A holder in this set is judged
 *   exactly like an unlisted one, never exempted as `listed`, because the
 *   oracle listing it proves nothing about liveness once it has stopped working
 *   and simply not been reaped yet.
 * @returns {"unreadable" | "listed" | "young" | "stranded"}
 */
function strandedVerdict(
	lock,
	listedIds,
	hours = STRANDED_AFTER_HOURS,
	terminalIds = EMPTY_IDS,
) {
	if (lock.unreadable || !lock.sessionId) return "unreadable";
	if (isListedLive(lock.sessionId, listedIds, terminalIds)) return "listed";
	const held = hoursHeld(lock.claimedAt);
	// An unreadable timestamp is reported, not suppressed: the substantive test
	// — the holder is not listed and live — has already passed, and the
	// threshold only exists to keep noise down.
	if (held !== null && held < hours) return "young";
	return "stranded";
}

/**
 * A lock past the unreadable/no-sessionId check — `sessionId` narrowed to
 * `string`, matching the `!lock.sessionId` test that put it in this bucket.
 * @typedef {Exclude<Lock, { unreadable: true }> & { sessionId: string }} ReadableLock
 */

/**
 * Every lock, sorted into the four buckets `strandedVerdict` can name (mantahostels#1800).
 *
 * The unreadable/no-sessionId check is repeated here rather than read off
 * `strandedVerdict`'s return alone, so a lock that clears it is narrowed to
 * `ReadableLock` for the three buckets that need `.path`/`.sessionId`.
 *
 * @param {Lock[]} locks readLocks()'s result. A caller with a `null` store
 *   decides what that means before calling this — the same split
 *   `countStranded` makes below.
 * @param {Set<string>} listedIds as below — either oracle reader. Ditto for a
 *   caller with no oracle.
 * @param {{ hours?: number, terminal?: Set<string> }} [opts] `terminal` is the
 *   same oracle read's stopped-but-resident pool — see `EMPTY_IDS` above for
 *   why omitting it is not a safe default (mantahostels#2765, mantahostels#2774).
 * @returns {{ stranded: ReadableLock[], young: ReadableLock[], unreadable: Lock[], live: ReadableLock[] }}
 */
function classifyClaims(
	locks,
	listedIds,
	{ hours = STRANDED_AFTER_HOURS, terminal = EMPTY_IDS } = {},
) {
	/** @type {{ stranded: ReadableLock[], young: ReadableLock[], unreadable: Lock[], live: ReadableLock[] }} */
	const buckets = { stranded: [], young: [], unreadable: [], live: [] };
	for (const lock of locks) {
		if (lock.unreadable || !lock.sessionId) {
			buckets.unreadable.push(lock);
			continue;
		}
		const readable = /** @type {ReadableLock} */ (lock);
		const verdict = strandedVerdict(lock, listedIds, hours, terminal);
		if (verdict === "listed") buckets.live.push(readable);
		else if (verdict === "young") buckets.young.push(readable);
		else buckets.stranded.push(readable);
	}
	return buckets;
}

/**
 * The stranded-claim headline counts pick-next.js prints: the standing count,
 * and the actionable subset carrying uncommitted work.
 *
 * Returns `{ ok:false, error }` or `{ ok:true, stranded, carrying }`, where
 * `carrying` is null on a `dirty` of null — a working tree git would not report
 * on, which is NOT the same as none of them being dirty.
 *
 * @param {Lock[] | null} locks readLocks()'s result, or null where the store
 *   could not be read.
 * @param {Set<string> | null | undefined} listedIds
 *   either oracle reader's ids, or null/undefined where the running-session
 *   oracle could not be read.
 * @param {Set<string> | null} [dirty] readDirtyPaths()'s result; omitted where the
 *   caller wants the standing count alone.
 * @param {Set<string>} [terminal] the same oracle read's stopped-but-resident
 *   pool — see `EMPTY_IDS` above for why omitting it is not a safe default
 *   (mantahostels#2765, mantahostels#2774).
 */
function countStranded(locks, listedIds, dirty = null, terminal = EMPTY_IDS) {
	if (locks === null)
		return { ok: false, error: "the file-claim store could not be read" };
	if (!listedIds)
		return { ok: false, error: "the running-session oracle could not be read" };

	const { stranded } = classifyClaims(locks, listedIds, { terminal });
	const carrying = dirty
		? stranded.filter((lock) => isDirtyClaim(dirty, lock.path)).length
		: null;
	return { ok: true, stranded: stranded.length, carrying };
}

module.exports = {
	STRANDED_AFTER_HOURS,
	hoursHeld,
	classifyClaims,
	readDirtyPaths,
	isDirtyClaim,
	countStranded,
};
