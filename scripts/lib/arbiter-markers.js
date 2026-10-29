/*
 * arbiter-markers.js — the session-suffixed marker files.
 *
 * The concision backstop's base SHA, the once-per-session nags, the rule latches
 * guard-entry.js writes (mantahostels#1804). Not the `.said-` markers, which live in locks/
 * and are arbiter-locks.js's `sweepDebris` to clear.
 *
 * All three families live under `.claude/tmp/markers` (`marker-root.js`'s
 * `markersDir`), not the repository root — the breadcrumbs moved to a
 * directory of their own at mantahostels#3382, and the other two moved off the root
 * entirely at F8 (mantahostels#3515, issue #2), so no pass here may assume the root.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const core = require("./arbiter-core.js");
/* A leaf outside the arbiter families, exempt from the split rule's cycle
 * discipline and named as such in arbiter-store.js. Required rather than having
 * its directory name copied here: a second copy of that path is a second thing
 * to miss on the next move. The `.hook-ran-` PREFIX below stays duplicated — it
 * is pinned by a test, and predates this (mantahostels#3382). */
const hookRecord = require("./hook-record.js");
/* The marker directory itself — .claude/tmp/markers rather than the repo root,
 * since F8 (mantahostels#3515, #2). Required for the same reason
 * hookRecord is: one place to miss, not two. */
const { markersDir } = require("./marker-root.js");
/* guard-priced-options.js's markers, read off its limb table rather than
 * copied: a limb added there is swept here with no second edit (#1474). A
 * data-only leaf, so destructured like hook-record.js. */
const {
	PREFIXES: pricedOptionsPrefixes,
} = require("./priced-options-limbs.js");

// ---------------------------------------------------------------------------
// The hook markers — under .claude/tmp/markers (F8, mantahostels#3515, issue #2),
// not the repo root
//
// Not the `.said-` markers: those live in locks/ and are sweepDebris's.
// ---------------------------------------------------------------------------

/**
 * Session-suffixed marker files whose whole suffix is the raw session id, kept
 * for MARKER_AGE_MS: the concision backstop's base SHA, the once-per-session nag
 * flags, and the pass markers the skills write — plus the Stop guards' block
 * counters, which `lib/hook-block.js` writes in the same shape (mantahostels#1278).
 *
 * The first five are written by concision-backstop.sh; the rest are block
 * counters — guard-priced-options.js's sixteen markers come from
 * lib/priced-options-limbs.js, which lists them; guard-session-ceiling.js holds three, one per
 * band (mantahostels#2601); guard-selection-sum.js two, one per stake tier (mantahostels#3431);
 * guard-uncommitted-work.js, guard-lost-deny.js, guard-automode-refusal.js,
 * guard-unpushed-commits.js, guard-paste-self-match.js (#921) and
 * guard-session-id-prose.js (#3557) one each;
 * guard-inventory.js two, its draft-and-act limb on its own (#989). `.lost-deny-seen-` is the exception and NOT a counter:
 * guard-lost-deny.js writes it itself, a set of the tool calls it has already
 * reported, and it is swept here because it is session-suffixed in the same
 * shape; so are `.automode-refusal-seen-`, guard-automode-refusal.js's set of
 * the refused calls it has shown the rule for (#860), and `.unpushed-seen-`, guard-unpushed-commits.js's set of the
 * commits it has warned about (#766), and guard-priced-options.js's
 * close-rivals record of the questions it last refused (#489).
 * `.jev-advisory-outage-` is guard-jev-advisory.js's second counter (#204),
 * the once-a-session outage notice's, kept off the warn counter, and `.jev-advisory-malformed-` its third (#226), the once-a-session
 * notice for a vendor reply that arrived whole and unreadable, kept off both.
 * `.unasked-rerun-refused-` is lib/unasked-rerun.js's once-a-session latch
 * (#815), a marker rather than a counter. `.session-ceiling-compactions-` is
 * guard-session-ceiling.js's set of the autocompactions it has counted (#1032).
 * `.scratch-written-` is lib/scratch-overwrite.js's record of the scratch
 * paths a session has written or been refused once on (#1167, #1728). `.compaction-trigger-` is
 * inject-compaction-count.js's hand-off from PreCompact to SessionStart (#1148).
 * `.self-plugin-loaded-` is write-self-plugin-marker.sh's proof, read by the
 * self-plugin canary, that the self-plugin loaded (#2438).
 * `.parked-blocked-` is park-blocked.sh's record, read by the session-ceiling
 * guard.
 * lib/parked.js's `.parked-<sid>` shares the directory and has no
 * clock: its park waits on the founder for days after the session finishes,
 * and unpark-on-prompt.js deletes it once empty (#3589). Residual: a marker
 * whose session never takes another prompt stays, a few bytes for good.
 * .gitignore hides them all under `.claude/tmp/`. A new one needs this list
 * and its writer edited; hook-block.test.ts pins that against the
 * call sites for the counters (mantahostels#1308).
 */
const MARKER_PREFIXES = [
	".concision-base-",
	".concision-nagged-",
	".concision-pass-",
	".codereview-nagged-",
	".codereview-pass-",
	...pricedOptionsPrefixes,
	".selection-sum-nagged-",
	".selection-sum-shape-nagged-",
	".uncommitted-nagged-",
	".session-ceiling-nagged-windup-",
	".session-ceiling-nagged-hard-",
	".session-ceiling-nagged-turns-",
	".session-ceiling-compactions-",
	".scratch-written-",
	".compaction-trigger-",
	".self-plugin-loaded-",
	".lost-deny-nagged-",
	".lost-deny-seen-",
	".automode-refusal-nagged-",
	".automode-refusal-seen-",
	".unpushed-nagged-",
	".unpushed-seen-",
	".paste-self-match-nagged-",
	".session-id-prose-nagged-",
	".parked-blocked-",
	".jev-advisory-nagged-",
	".jev-advisory-outage-",
	".jev-advisory-malformed-",
	".inventory-nagged-",
	".inventory-draft-nagged-",
	".unasked-rerun-refused-",
];

/**
 * `lib/hook-record.js`'s per-invocation breadcrumbs, swept on their own longer
 * clock. Its filename is PREFIX + guard + "-" + sessionId, and the guard name is
 * derived from argv[1] at run time, so the session id cannot be recovered by
 * slicing a fixed prefix the way MARKER_PREFIXES' can — see liveBreadcrumb.
 *
 * UNLIKE EVERY OTHER FAMILY HERE, these do not sit at the repository root: they
 * are in `hookRecord.recordsDir(root)` (mantahostels#3382). The stem is duplicated from
 * hook-record.js's own PREFIX and pinned against it by arbiter-markers.test.ts;
 * the DIRECTORY is not duplicated, and is asked for by name.
 */
const BREADCRUMB_PREFIX = ".hook-ran-";

/**
 * A guard's per-session, per-rule latch: `.rule-injected-<id>-<agent>-<sid>`
 * (scripts/lib/guard-entry.js's latchPath). Kept on the marker clock, but matched as a
 * SUFFIX like a breadcrumb, not by slicing this prefix: TWO segments sit between
 * the prefix and the id, so a fixed-length slice yields `<rule-id>-<agent>-<sid>`
 * whole, matches no live id, and every latch is swept at 24h under a live
 * session — which un-latches a rule mid-run (mantahostels#1804).
 *
 * A SECOND matching hazard, intended rather than a defect: guard-entry.js
 * replaces every character outside `[A-Za-z0-9_-]` in the session id before
 * using it as a path segment, while liveBreadcrumb compares against the
 * registry's RAW ids. So an id failing that test can never match a live session
 * and has only the clock to retire its latch — the same trade
 * `.hook-ran-<guard>-unknown-session` takes above.
 *
 * arbiter-markers.test.ts pins this spelling against guard-entry.js's: the two
 * are coupled by a string literal and nothing else (mantahostels#1804).
 */
const RULE_LATCH_PREFIX = ".rule-injected-";

/**
 * Grace for a session that has started but not yet reached the sessions
 * registry, whose markers would otherwise read as belonging to nobody.
 */
const MARKER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Breadcrumbs are evidence, not state, so they outlive the session that wrote
 * them by a week rather than a day (mantahostels#1278, choosing this over the shared day).
 *
 * What sizes it is mantahostels#1291's sample, 200 invocations per guard across >=20
 * distinct sessions (mantahostels#1308), at the rate of a QUIET week, because traffic swings
 * by two orders of magnitude (mantahostels#3381). Re-measured 14 Sep 2026: 1-7 Sep ran ~250
 * sessions a day, filling the sample in about 3 hours; 9-13 Sep ran 0-1 a day
 * and 22 invocations per guard across all five days, which no shorter clock
 * would have kept. So a busy week makes seven days far more than enough, and the
 * quiet week is why it is not two — cutting it consumes the evidence mantahostels#1004
 * exists to produce. Disk does not bind: the busiest 7-day window held 9.6 MB
 * in 5,261 files.
 */
const BREADCRUMB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a breadcrumb belongs to a live session.
 *
 * Matched as a suffix rather than by slicing BREADCRUMB_PREFIX, because the
 * guard name sits between the two and itself contains hyphens
 * (`.hook-ran-guard-priced-options-<sid>`), so no fixed prefix length recovers
 * the id. Suffix matching also means a Stop guard added later is swept without
 * this list being edited — the residual MARKER_PREFIXES still carries.
 *
 * `.hook-ran-<guard>-unknown-session`, which hook-record.js writes when a session
 * id fails its safe-character test, matches no live id, so it ages out a week
 * after its last write; no exemption (mantahostels#1278).
 * @param {string} f
 * @param {Iterable<string>} live
 */
function liveBreadcrumb(f, live) {
	for (const id of live) if (f.endsWith(`-${id}`)) return true;
	return false;
}

/**
 * Delete the hook markers of sessions that are both finished and old.
 *
 * .gitignore hides every family this sweeps, so a clean `git status` is no sign
 * the repo root is clean of them — hook-block.test.ts is what keeps that true.
 *
 * Liveness gates this for the same reason it gates pruneLedgers (mantahostels#137), and an
 * unreadable registry stops both sweeps, never just one: a partial pass is
 * harder to reason about than none.
 *
 * RESIDUAL, the same shape as pruneLedgers' but a day rather than a week: a
 * session with no readable entry in any registry sessionDirs walks is swept
 * whether or not it is running. Read it as two populations — a session that has
 * started but not yet registered, and a session registered under a config dir
 * sessionDirs does not reach (mantahostels#1309). An
 * unregistered session still runs the concision gate, and the backstop exits
 * silently once `.concision-base-<sid>` has gone. They are not spared: the
 * cost of the residual is one missed quality pass, the direction
 * the backstop already chooses when attribution fails; the breadcrumb case is
 * weighed on mantahostels#1278.
 *
 * The rule latches pay MORE for that same residual, and it was not weighed when
 * the clock was chosen (mantahostels#1804). Sweeping an unregistered-but-running session's
 * latch un-latches the rule, so the next trigger re-injects text that session
 * has already been given, mid-run. Bounded at one repeat per rule per 24 hours,
 * so the shared clock stands — but a family latching anything costlier than a
 * paragraph of prose should not simply inherit it.
 */
function pruneMarkers() {
	const live = core.readLiveOrLog("pruneMarkers");
	if (live === null) return; // cannot tell live from finished: delete nothing
	const root = core.repoRoot();
	const markers = markersDir(root);
	// Three passes because the families are kept for different lengths of time
	// and sweepAged takes one age. Each spares everything outside its own family,
	// so none can reach another's files. The third shares the first's age and the
	// second's suffix matching — see RULE_LATCH_PREFIX for why it is not simply an
	// entry in MARKER_PREFIXES.
	//
	// All three sweep `.claude/tmp/markers` rather than the repo root since F8
	// (mantahostels#3515, #2) — root itself before that.
	core.sweepAged(markers, MARKER_AGE_MS, (f) => {
		const prefix = MARKER_PREFIXES.find((p) => f.startsWith(p));
		if (!prefix) return true;
		// The suffix is the raw session id — the backstop interpolates it
		// unchanged — so it compares directly against the registry's ids.
		return live.has(f.slice(prefix.length));
	});
	/* Its own directory (mantahostels#3382), under the markers directory
	 * rather than the repo root (F8). The prefix test stays: a
	 * file in there under another name is not this family's to delete. */
	core.sweepAged(hookRecord.recordsDir(root), BREADCRUMB_AGE_MS, (f) =>
		f.startsWith(BREADCRUMB_PREFIX) ? liveBreadcrumb(f, live) : true,
	);
	core.sweepAged(markers, MARKER_AGE_MS, (f) =>
		f.startsWith(RULE_LATCH_PREFIX) ? liveBreadcrumb(f, live) : true,
	);
}

module.exports = {
	pruneMarkers,
};
