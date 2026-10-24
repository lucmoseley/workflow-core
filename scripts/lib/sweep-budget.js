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
 * WHY A MODULE AND NOT TWO IMPLEMENTATIONS. The guard is bash and the autofire
 * is node, and the whole guarantee mantahostels#2202 buys is that the two arithmetics are
 * the same arithmetic. A jq transcription of the marker's schema in
 * `guard-sweep-fire.sh` would be a second place for the day boundary, the
 * counter's name and the cap to drift — so the guard shells out to the CLI at
 * the foot of this file and the bytes the hook enforces are the bytes the tests
 * cover.
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

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { caught } = require("./caught.js");

/* The DAILY cap, which the autofire's 2-minute cooldown is not (mantahostels#1816 asked for
 * one): the cooldown alone bounds a bad day at 720 firings, ~5,900 billed
 * minutes, over the whole month's allowance in a day. It bounds both routes
 * together (mantahostels#2202).
 *
 * THREE (mantahostels#3495): the most firings a worst day can make every day and keep the
 * month inside GitHub Free's 2,000 minutes; four breaches it. The arithmetic is
 * `.github/workflows/scheduled-checks.yml`'s WHAT IT COSTS — re-derive it when
 * the cadence or the sweep price moves.
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
	try {
		const dir = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return dir ? path.join(dir, AUTOFIRE_MARKER) : null;
	} catch {
		return null;
	}
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
 * extra 15.78-minute sweep. Revisit only if the boundary is ever load-bearing.
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

module.exports = {
	AUTOFIRE_DAILY_CAP,
	markerPath,
	readState,
	recordFiring,
	spentToday,
};

/*
 * CLI mode, for `scripts/guard-sweep-fire.sh`: spend one unit of today's budget
 * on a hand-fire, or report that the day is out. The exit status is the verdict
 * and stdout carries the figures the deny text needs.
 *
 *   0  spent — stdout `<spent-after> <cap> <day>`
 *   1  the day's budget is gone — stdout `<spent> <cap> <day>`
 *   2  this script could not decide, so the guard must fail open (mantahostels#103 §6) —
 *      stdout carries the reason
 *
 * `WFC_REPO_DIR` picks the tree whose common dir holds the marker; `WFC_NOW`
 * pins the clock, both matching check-ci-status.js.
 *
 * IT SPENDS BEFORE THE COMMAND RUNS, this being a `PreToolUse` hook, so a fire
 * the session then abandons — another guard denying the same command, a `gh`
 * that 403s — still costs a unit. The autofire makes the same trade for the same
 * reason (`check-ci-status.js` writes its marker before the dispatch): a fire
 * that hangs or half-succeeds must not leave the budget unspent.
 */
if (require.main === module) {
	try {
		/* `spend` is required rather than assumed. Spending is the only thing this
		 * CLI does and it does it as a side effect, so an argv it does not
		 * recognise — a `status` subcommand somebody adds later, a typo — must not
		 * silently burn a unit of the day. */
		if (process.argv[2] !== "spend") {
			process.stdout.write("usage: sweep-budget.js spend\n");
			process.exit(2);
		}
		const raw = process.env.WFC_NOW;
		const t = raw ? Date.parse(raw) : Date.now();
		if (Number.isNaN(t)) {
			process.stdout.write(`WFC_NOW is not a date: ${raw}\n`);
			process.exit(2);
		}
		const repo = process.env.WFC_REPO_DIR || hostRoot();
		const marker = markerPath(repo);
		if (!marker) {
			process.stdout.write("git would not name a common dir\n");
			process.exit(2);
		}
		const { state, error } = readState(marker);
		if (error !== null) {
			process.stdout.write(
				`could not read ${AUTOFIRE_MARKER}: ${caught(error).message}\n`,
			);
			process.exit(2);
		}
		const spent = spentToday(state, t);
		if (spent >= AUTOFIRE_DAILY_CAP) {
			process.stdout.write(`${spent} ${AUTOFIRE_DAILY_CAP} ${dayOf(t)}\n`);
			process.exit(1);
		}
		recordFiring(marker, t, spent);
		process.stdout.write(`${spent + 1} ${AUTOFIRE_DAILY_CAP} ${dayOf(t)}\n`);
		process.exit(0);
	} catch (e) {
		process.stdout.write(`${caught(e).message || e}\n`);
		process.exit(2);
	}
}
