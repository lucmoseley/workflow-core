/*
 * sweep-budget.js — the one daily budget every sweep firing spends (mantahostels#2202).
 *
 * `scripts/check-ci-status.js` fires a sweep for itself (mantahostels#1816) when the
 * newest verdict goes stale, and a sweep is also hand-fired with
 * `gh workflow run scheduled-checks.yml` (mantahostels#2188). This module is the
 * counter every route spends, `ci.yml` included (mantahostels#3514), so
 * the day's ceiling is a property of the SWEEP rather than of the route that
 * fired it.
 *
 * ONE MODULE, BOTH ROUTES. The whole guarantee mantahostels#2202 buys is that
 * the guard's arithmetic and the autofire's are the same arithmetic, so the
 * guard spends through `spendHandFire` below and the bytes the hook enforces
 * are the bytes the tests cover.
 *
 * THE STORE IS THE GIT COMMON DIR, untracked and shared across worktrees by
 * construction, matching `lib/test-pass-marker.js`. That is what lets a hand-fire
 * in a throwaway worktree spend the same day's budget as an autofire in the
 * canonical checkout, with no new store to reconcile.
 *
 * THE DAY IS UTC, matching the cron the cap is spent against
 * (`.github/workflows/scheduled-checks.yml`), so the budget resets at 00:00 UTC
 * and not at local midnight.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitCommonDir } = require("./git.js");

/* The DAILY cap, which the autofire's 2-minute cooldown is not (mantahostels#1816 asked for
 * one): the cooldown alone bounds a bad day at 720 firings. It bounds both
 * routes together (mantahostels#2202).
 *
 * THREE is mantahostels#3495's value, which was sized on GitHub Free's minutes
 * and kept by #1965's ruling when the core's minutes became free (#1930); it
 * was not re-derived. What the cap still buys: on the core, a bound on noisy
 * failed fires (mantahostels#2188 counted 44.6% of dispatched sweeps failing,
 * and 35 fires in one day); on a private adopter (mantahostels), a bound on
 * that repo's Actions minutes.
 *
 * Once the cap is spent the session-start notice still reports; only the firing
 * stops. */
const AUTOFIRE_DAILY_CAP = 3;
const AUTOFIRE_MARKER = ".sweep-autofire";

/**
 * The UTC day a timestamp spends against.
 *
 * @param {number} t
 * @returns {string}
 */
function dayOf(t) {
	return new Date(t).toISOString().slice(0, 10);
}

/**
 * Where the shared marker lives. Null when git will not say, which disables
 * autofire rather than firing uncooled and fails the guard OPEN rather than
 * refusing a fire it cannot count — an uncapped fire is the one failure mode
 * mantahostels#1816 ruled out, and a guard that cannot read its own state denies nothing
 * (mantahostels#103 §6).
 *
 * THE NULL BRANCH IS UNVERIFIED ON THE AUTOFIRE SIDE. A tree git will not answer
 * for also reports no coverage, so staleMs is null there and it is never reached
 * with a fire pending. The guard side reaches it.
 *
 * @param {string} repo
 * @returns {string|null}
 */
function markerPath(repo) {
	const dir = gitCommonDir(repo);
	return dir ? path.join(dir, AUTOFIRE_MARKER) : null;
}

/**
 * The marker's contents. A missing file is the ordinary first run and reads as
 * empty state; any OTHER fault is returned as `error` rather than swallowed,
 * because firing on a budget you cannot read is the uncapped case.
 *
 * @param {string} marker
 * @returns {{state: {last?: number, day?: string, count?: number}, error: unknown}} `error` null where the read succeeded or found no file
 */
function readState(marker) {
	try {
		return { state: JSON.parse(fs.readFileSync(marker, "utf8")), error: null };
	} catch (e) {
		if (caught(e).code === "ENOENT") return { state: {}, error: null };
		return { state: {}, error: e };
	}
}

/**
 * How much of `t`'s day the marker records as already spent. A marker from an
 * earlier day reads as zero.
 *
 * @param {{day?: string, count?: number}} state
 * @param {number} t
 * @returns {number}
 */
function spentToday(state, t) {
	return state.day === dayOf(t) ? Number(state.count) || 0 : 0;
}

/**
 * Record one firing: the day's count, and `last` for the autofire cooldown.
 *
 * BOTH ROUTES WRITE `last`, not just the autofire. The cooldown exists for the
 * 4-5 s window in which GitHub has not yet listed a queued run (mantahostels#1832), and a
 * hand-fire opens exactly that window — leaving `last` alone would let a session
 * start seconds later read the same stale verdict and autofire on top of the
 * hand-fire, which is the double-fire the cooldown was built to stop.
 *
 * READ-THEN-WRITE, UNLOCKED, and that is a trade rather than an oversight. Two
 * sessions firing in the same instant both read `count: n` and both write
 * `n + 1`, so the day can run one over per collision. No lock, on
 * price: the cap bounds a runaway rather than being exact at the boundary, and a
 * lock file here would be a new stale-lock failure mode on a `PreToolUse` path — where a wedged lock
 * costs every `gh workflow run` in every session, against a worst case of one
 * extra sweep. Revisit only if the boundary is ever load-bearing.
 *
 * Throws on an unwritable marker; the caller decides what an uncountable fire
 * means for it.
 *
 * @param {string} marker
 * @param {number} t
 * @param {number} spent
 */
function recordFiring(marker, t, spent) {
	fs.writeFileSync(
		marker,
		JSON.stringify({ last: t, day: dayOf(t), count: spent + 1 }),
	);
}

/**
 * Spend one unit of the day's budget on a hand-fire, or report that the day
 * is out — the guard's half (lib/sweep-fire-host.js). `out` false is spent,
 * `spent` the count after; `out` true is refused, nothing written. A `fault`
 * is a budget this could not decide, which the guard fails open on
 * (mantahostels#103 §6).
 *
 * IT SPENDS BEFORE THE COMMAND RUNS, the guard being a `PreToolUse` hook, so a
 * fire the session then abandons — another guard denying the same command, a
 * `gh` that 403s — still costs a unit. The autofire makes the same trade for
 * the same reason (`check-ci-status.js` writes its marker before the
 * dispatch): a fire that hangs or half-succeeds must not leave the budget
 * unspent.
 *
 * @param {string} repo the tree whose common dir holds the marker
 * @param {number} t
 * @returns {{ out: boolean, spent: number, cap: number, day: string } | { fault: string }}
 */
function spendHandFire(repo, t) {
	const marker = markerPath(repo);
	if (!marker) return { fault: "git would not name a common dir" };
	const { state, error } = readState(marker);
	if (error !== null)
		return {
			fault: `could not read ${AUTOFIRE_MARKER}: ${caught(error).message}`,
		};
	const spent = spentToday(state, t);
	const day = dayOf(t);
	if (spent >= AUTOFIRE_DAILY_CAP)
		return { out: true, spent, cap: AUTOFIRE_DAILY_CAP, day };
	recordFiring(marker, t, spent);
	return { out: false, spent: spent + 1, cap: AUTOFIRE_DAILY_CAP, day };
}

module.exports = {
	AUTOFIRE_DAILY_CAP,
	markerPath,
	readState,
	recordFiring,
	spendHandFire,
	spentToday,
};
