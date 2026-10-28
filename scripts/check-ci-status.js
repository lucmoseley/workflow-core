#!/usr/bin/env node
/*
 * check-ci-status.js — report a red CI run on the branch, at session start.
 *
 * Usage:  npm run check:ci  [--branch <name>] [--notify [--recheck]]
 *
 * Why this exists (mantahostels#143): nothing in the repo ever asked GitHub whether a push
 * went red. `.husky/pre-commit` runs Biome, gitleaks and the roadmap-pair check
 * but no tests, and `.husky/post-commit` only counts unpushed commits — so
 * between the local gates (before the commit) and CI (after the push) there was
 * no gate at all (mantahostels#143).
 *
 * SessionStart, not the moment of failure. Nothing here runs on its own — no
 * daemon, no cron — so every detector is a poll, and the only things that fire
 * are hook events. Blocking the push on CI stalls the session for the 1-2
 * minutes a run takes; a background waiter still needs a hook to read what it
 * wrote. The residual is the delay: a failure that lands after the last session
 * of the day is not seen until the next one opens.
 *
 * A RED ACCUSES A RANGE, NOT A SHA (mantahostels#945, on the attribution ruling at
 * mantahostels#907). Sweeps run four times a day (mantahostels#3490;
 * `cron: "0 3,9,15,21 * * *"`) over whatever `main` holds, so one verdict
 * covers every commit since the last sweep. This
 * keys on the newest run that CARRIES A VERDICT — whatever its sha — and then
 * says what a reader needs to narrow the search without opening GitHub: the
 * failing STEP, the commit range back to the last green run of the same
 * workflow, and the command that fires the hand-flown bisect (mantahostels#947's
 * bisect.yml) when the range is too wide to read.
 *
 * mantahostels#907 chose reporting FIRST and a bisect only on escalation, deliberately: a
 * bisect is sound only if the suite is deterministic across the range, which is
 * unmeasured here, so nothing fires one automatically.
 *
 * A SWEEP THAT NEVER FIRED (mantahostels#1024, on the ruling at mantahostels#915). Conclusions say
 * nothing about recency, so a schedule that stopped reads here exactly as a
 * clean night does: nothing red. Three things can happen to a scheduled run, and
 * they want opposite responses —
 *
 *   LATE      queued and not yet finished. Not a fault.
 *   DROPPED   GitHub discarded the queued run under load. Transient, silent —
 *             no run, no red, no notification — and it heals at the next slot.
 *   DISABLED  GitHub's idle auto-disable stopped the workflow FILE outright
 *             (mantahostels#909). Permanent: nothing fires again until someone re-enables it.
 *
 * So this reads two things GitHub will not volunteer: whether each cron slot of
 * the last 24 hours produced a run, and whether every workflow still reads
 * `active`. Session start is the only trigger that survives the fault it
 * detects — the fault being "the workflow did not run", a reporter living on
 * that same schedule would go down with it, which is why filing an issue was
 * rejected (it needs a run) and why a commit or push gate was too (a dropped run
 * is GitHub's fault and heals itself).
 *
 * --notify is the SessionStart path, on check-guard-errors.js's contract: silent and
 * exit 0 when there is nothing new, so it can run every session without
 * becoming noise the reader learns to skip. It is also what keeps a BROKEN run
 * from blocking a session start — under the family alphabet every --notify
 * outcome exits 0 (mantahostels#155 — the checker family's exit-code and
 * severity model — decision 3).
 *
 * A STALE VERDICT NOW FIRES ITS OWN SWEEP (mantahostels#1816). --notify fires one itself
 * when the NEWEST SWEEP is older than SWEEP_STALE_MS, rationed three ways: only
 * where HEAD has moved past that sweep, only outside AUTOFIRE_COOLDOWN_MS, and
 * never on the on-demand form, where a human is at the keyboard. It never keys
 * on the missed-slot count (mantahostels#1816): a sweep tests HEAD now, never
 * the tree a dropped slot would have tested, so what is available is
 * refreshing a stale verdict and never recovering a lost one.
 *
 * A GREEN SAYS WHAT IT COVERED (mantahostels#976, on the ruling at mantahostels#949). Under a schedule
 * "green" is a claim about whatever `main` held at the last sweep, so the
 * on-demand form names that run, its age and how many commits HEAD sits ahead of
 * it, and says how long HEAD stays untested when the next sweep is hours off.
 * It offers no `gh workflow run scheduled-checks.yml` beside it
 * (mantahostels#2203), which would print at nearly every session start; it
 * names the newest sweep's red instead, down to the failing `job › step`.
 * --notify prints none of this, except on the missed-slot path, which carries
 * the red itself.
 *
 * EVERY `gh workflow` LINE HERE SAYS WHO CAN RUN IT (mantahostels#1069). Any session can:
 * the PAT holds the repository's `Actions: Read and write` permission.
 * `actions/permissions/workflow` answers 403: it reads the `administration`
 * permission, which was not granted.
 *
 * EVERY gh() CALL IN THIS FILE PASSES `timeout: 8000` AT MOST (mantahostels#2134), so none
 * can hang the check outright. Whether a trip reads BROKEN or SKIP still
 * follows the split above: an ETIMEDOUT with no UNREACHABLE-matching stderr
 * (the ordinary case — the Node-side clock, not gh's own, fires first) is
 * BROKEN.
 *
 * THE SUM IS ALSO BOUNDED, UNDER --notify ONLY (mantahostels#2177). Three gh() calls fire
 * on every --notify run before any conditional one — the branch query, then
 * readSweepRuns() and readInactiveWorkflows() inside buildLivenessReport(). The
 * conditional ones are runFailures(), once per red run, and once more where a
 * missed slot reports a red newest sweep (mantahostels#2203); and one
 * tracking-issue lookup where a red is the suite's (#532). So a
 * GitHub answering slowly but inside its own 8000ms bound on each sums past
 * this hook's timeout in `self-plugin/hooks/hooks.json` as the reds grow.
 * That entry is `async`, where build 2.1.252 enforced no timeout
 * (mantahostels#2331): the run dies only with its session, so the budget
 * bounds how late the report lands, and holds the run inside the registered
 * ceiling should a build enforce it — a run killed there sees nothing, worse
 * than the report this file exists to give. NOTIFY_BUDGET_MS is a wall-clock
 * deadline from run() start over a --notify run's gh() calls; ghTimeout()
 * shrinks each call's own timeout to
 * whatever is left of it, and a call given less than NOTIFY_BUDGET_FLOOR_MS is
 * skipped outright rather than fired on a timeout so small it would read as
 * gh being broken. Skipped calls fail open exactly as an unreachable GitHub
 * does — null, printed as unreadable — never as a false all-clear. Left
 * unbounded: the on-demand form, run by a human at a terminal with no hook
 * over it.
 *
 * --recheck IS THE DELIVERY MOD'S MID-SESSION RUN (#856): --notify that fires
 * no sweep, the autofire staying at session start (`rule:sweep-fire-budget`),
 * and that neither reads nor writes the delivery stamps. Reading them would
 * silence a red some other session's start was shown; writing them would hide
 * the persisted report from the next session start's replay (#849 §Reports).
 * The staleness line still prints.
 *
 * REPORTS, AND FILES IN ONE CASE (#2480). Exit 1 means "a human should look",
 * never that something must be fixed before a commit lands. Where a red suite
 * job has no open issue and the day's repo-checks reading shows the red-suite
 * filer did not file, it launches that filer detached
 * (lib/red-suite-fallback.js), at no gh call of this run's own.
 *
 * IMPLICIT:  at every session start, asks GitHub whether the last sweep on the branch went red, injects the verdict into the session's context, dispatches a sweep the session never asked for when that verdict has gone stale (mantahostels#1816), and launches the red-suite filer, which files or comments on the tracker, where the daily filer did not (#2480).
 * JUSTIFIED: fail-safe — nothing reports a red between the local gates and the next sweep, so every detector here is a poll and this is the only one that fires unasked; a verdict nothing refreshes is the fault mantahostels#1816 measured at a 15h35m blind window; and a broken daily filer left a red unticketed for three days (#2480).
 * DEFEAT:    none at the hook; --notify is silent unless the run it reads is red or the newest sweep is older than SWEEP_STALE_MS. The dispatch is capped by AUTOFIRE_COOLDOWN_MS and withheld where HEAD is already covered; the filer launch at one an hour, on the core host only.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * A workflow run and a workflow, as `gh`'s `--json` selections spell them, and
 * where HEAD sits against the sha a run tested.
 *
 * @typedef {import("./lib/check").CheckContext} Ctx
 * @typedef {{databaseId: number, headSha?: string, conclusion?: string|null,
 *   createdAt?: string, event?: string, workflowName?: string,
 *   url?: string}} Run
 * @typedef {{name?: string, path?: string, state?: string}} Workflow
 * @typedef {{head: string, ahead: number|null, line: string|null}} Coverage
 */

const { now, runCheck } = require("./lib/check");
const {
	buildBisectAdvice,
	countRange,
	readRange,
	renderRange,
} = require("./lib/commit-range");
const { gh, parseErrLine, parseGhFailureReason } = require("./lib/gh");
const { openTrackingIssue } = require("./lib/tracking-issue");
/* scheduled-checks.yml's aggregate that `main`'s ruleset requires (#2414). It
 * goes red only where another job did, so it owes no ticket of its own. */
const VERDICT_JOB = "Suite passed";

// The red-suite filer's own spellings (#532).
const redSuite = require("./report-red-suite");
const { fileWhereUnfiled } = require("./lib/red-suite-fallback");

// The daily sweep budget, shared with the hand-fire guard (mantahostels#2202).
const {
	AUTOFIRE_DAILY_CAP,
	markerPath: autofireMarkerPath,
	readState: readAutofireState,
	recordFiring,
	spentToday,
} = require("./lib/sweep-budget");

// The arbiter's store, not its CLI: session-arbiter.js exports nothing (mantahostels#158,
// built by mantahostels#159).
const deliveryStamp = require("./lib/delivery-stamp");
const { hostRoot } = require("./lib/host-root.js");
const { codeRepoArgs } = require("./lib/workflow-core-config.js");

/* The ` --repo <codeRepo>` a printed gh command needs to reach the runs, which
 * lib/gh.js adds for this file's own calls (#1963). */
const repoFlag = () =>
	codeRepoArgs()
		.map((a) => ` ${a}`)
		.join("");
const { NOT_A_TREE_VERDICT, hasVerdict } = require("./lib/ci-verdict.js");
const { execGit } = require("./lib/git.js");

/* Anything NOT in here is reported. Listing the good conclusions rather than the
 * bad ones means a conclusion string GitHub adds later surfaces as a report
 * instead of passing silently.
 *
 * `cancelled` is deliberately NOT here. A run a human or GitHub cancels carries
 * no verdict, and counting one as good would report all-clear over a commit
 * nothing ever ran. `replaced` below draws the line instead. */
const GOOD = new Set(["success", "skipped", "neutral"]);

/* A run that stopped before it could reach a verdict. Named so it moves as one
 * thing if GitHub ever spells it differently (`stale`, a timeout). */
/** @param {Run} r */
const carriesNoVerdict = (r) => r.conclusion === "cancelled";

/* How many runs back to look. It has to reach the last GREEN run, not merely
 * the newest red one, or there is no range to report — at mantahostels#3490's four sweeps a
 * day, ~12 days. Raising it costs one larger response, not a second call. */
const RUN_WINDOW = 50;

/* The workflow the range report hands off to (mantahostels#947). Dispatch-only and fired by
 * a human, never by this script. */
const BISECT_WORKFLOW = "bisect.yml";

/* The whole suite, on demand. */
const SWEEP_WORKFLOW = "scheduled-checks.yml";

/* The hours the sweep fires, UTC. Held here rather than parsed, and so able to
 * drift: `.github/workflows/scheduled-checks.yml` carries the real schedule
 * (mantahostels#3490, dropped from six slots at mantahostels#2166), and a test in check-ci-status.test.ts
 * reads its cron and fails if the two disagree. Ascending, which nextSweepAfter()
 * relies on. */
const SWEEP_HOURS_UTC = [3, 9, 15, 21];

/* How far off the next sweep must be before the on-demand form says HEAD is
 * going untested. An UNMEASURED first guess, named as one at mantahostels#949: nothing has
 * measured how long a founder waits before firing a sweep themselves. */
const HATCH_MIN_WAIT_MS = 2 * 60 * 60 * 1000;

/* How long after a slot passes before a run's absence is read as a miss (mantahostels#1024).
 * Sweeps run late as a matter of course, and 5h cleared the latest lag measured
 * to 26 Aug 2026 by ~7 minutes (mantahostels#1816).
 *
 * IT DOES NOT CLEAR THAT TAIL — mantahostels#2204 measured GitHub delivering slots
 * 310-687 minutes late from 27 Aug 2026. The schedule is four slots at
 * 3/9/15/21 UTC (mantahostels#3490; ruled on cadence at mantahostels#2228).
 * lucmoseley/mantahostels#2241 held this at 5h, its resolution pricing the tail
 * at ~6% of delivered slots read missed first. Widening grace enough to clear that tail would sit close to the 6h gap itself, costing the
 * detector its one job of telling a dropped run from a stopped schedule — a
 * noisy line and not a billed one: SWEEP_STALE_MS, not this, is what fires a
 * sweep.
 *
 * At the 6h gap (mantahostels#3490) only the newest slot is ever inside it —
 * grace (5h) is SHORTER than the gap. The newest becomes judgeable too in the
 * last hour of each gap, once its own age passes 5h, so sweepLedger() usually
 * holds back 1 of the window's 4 slots and holds back none in that last hour. */
const SWEEP_GRACE_MS = 5 * 60 * 60 * 1000;

/* How old the newest sweep must be before --notify fires one itself (mantahostels#1816).
 *
 * The designed blind window is a uniform 6h (.github/workflows/scheduled-checks
 * .yml, mantahostels#3490).
 * EIGHT HOURS, not six: six is the ordinary gap, so a threshold there would fire
 * at the tail of every gap once the usual lag is added — extra sweeps a day for
 * a schedule with nothing wrong with it (mantahostels#1816). Eight clears an
 * ordinary gap with a ~2h margin (mantahostels#1816), and clears the 16-83 minute
 * lag census — mantahostels#1816's, measured before 27 Aug 2026; the later tail
 * is mantahostels#2204's (SWEEP_GRACE_MS above).
 * What it costs: .github/workflows/scheduled-checks.yml.
 *
 * Against September's delivered gaps it trips on the tail rather than daily:
 * mantahostels#2228 measured 61 of 88 slots delivered over 1-15 Sep (69%) and the gaps
 * between consecutive runs at a 6.3h median, listing as its worst four 9h54m,
 * 9h06m, 8h24m and 8h00m — the trip is strict, so the last of those does not
 * fire. That tail is ACCEPTED: a verdict genuinely eight hours old is what this
 * exists to fire on. The census is the SIX-slot cadence's, though, and delivery
 * on mantahostels#3490's four-slot grid is unmeasured. mantahostels#2204's 310-687 minute lags stand as
 * the magnitude of the GitHub-side delay, not as a current delivery reading.
 * What bounds the firings either way is lib/sweep-budget.js's three-a-day cap,
 * not this. */
const SWEEP_STALE_MS = 8 * 60 * 60 * 1000;

/* A firing makes the newest sweep fresh, so SWEEP_STALE_MS is its own cooldown
 * — but only once GitHub lists the queued run, which is not instant. This
 * covers that race, in which two session starts seconds apart would each read a
 * stale verdict and each fire. The git common dir is the store because it is
 * shared across worktrees and untracked, matching lib/test-pass-marker.js.
 *
 * MEASURED (mantahostels#1832): dispatch-to-listing lag is 4.3-5.1s, n=5 over one day —
 * thin, like the sibling SWEEP_STALE_MS grace (mantahostels#1816). Two minutes is ~24x
 * the observed max, covering a slow outlier.
 *
 * RESIDUAL: at 2 minutes this barely rate-limits a degraded day — a queued
 * run's own `createdAt` clears SWEEP_STALE_MS the moment GitHub lists it, so a healthy day self-gates regardless of this
 * value (readSweepRuns() feeds the `staleMs` computed below).
 * AUTOFIRE_DAILY_CAP is what actually bounds a degraded one. */
const AUTOFIRE_COOLDOWN_MS = 2 * 60 * 1000;

/* The DAILY cap and the marker holding it live in lib/sweep-budget.js,
 * because a hand-fired `gh workflow run scheduled-checks.yml` (mantahostels#2202)
 * and a `gh workflow run ci.yml` (mantahostels#3514) spend the SAME three as the
 * autofire below: the ceiling is the sweep's, not the route's. The derivation
 * is there. */

/* How far back the slot ledger looks. Four slots is bounded work one gh call
 * covers, and it is what tells one missed slot (a transient drop that heals at
 * the next slot) from every judged slot missed (the schedule has stopped) — a
 * distinction the most-recent-slot form cannot make. The denominator is
 * `judgeable`, THREE OR FOUR and never fewer: SWEEP_GRACE_MS holds back the
 * newest slot except in the last hour of its 6h gap (mantahostels#3490 — see
 * SWEEP_GRACE_MS above). Reading back to the last green instead is unbounded: a
 * week away and this prints dozens of missed slots at session start. */
const SWEEP_LEDGER_MS = 24 * 60 * 60 * 1000;

/* The wall-clock deadline, from run() start, over a --notify run's gh()
 * calls (mantahostels#2177), held 8s under `self-plugin/hooks/hooks.json`'s
 * 40s timeout for this hook (#2471) for what falls outside it: Node startup
 * and module load before run(), and the rendering and stamping after the
 * last call. The 8s margin is a guess, its measurements on #2471. A test
 * pins the budget below that 40s.
 *
 * Injectable, the role WFC_NOW plays for the wall clock: a test that wants
 * a call to see the budget already spent needs only a small
 * WFC_NOTIFY_BUDGET_MS and a short stub sleep, not NOTIFY_BUDGET_MS's own
 * real seconds passing. */
const NOTIFY_BUDGET_MS = Number(process.env.WFC_NOTIFY_BUDGET_MS) || 32_000;

/* Below this much remaining budget, a gh() call is skipped rather than fired:
 * a call given less than this is a near-certain ETIMEDOUT, which would read
 * as gh itself being broken (mantahostels#2134's BROKEN split) when the fault is the
 * budget, not gh. */
const NOTIFY_BUDGET_FLOOR_MS = 1000;

/* Nothing catches a THIRD site added bare: the tests pin the two that exist,
 * and no checker reads for an unqualified `gh workflow` line. */
const WHO_CAN_RUN_IT =
	"any session — a 403 here means the PAT lost Actions: write";

/* What every git call reads. WFC_REPO_DIR is the injection point: the range
 * tests need a history of their own, and reaching into this repo's would both
 * move under a parallel session's commits and die in CI, where
 * `actions/checkout` clones at depth 1. */
const REPO = process.env.WFC_REPO_DIR || hostRoot();

/* Whether the host tree carries the sweep workflow at all (#403).
 * Residual: this reads the local working tree, while GitHub schedules from the
 * default branch, so a sweep deleted here but still live on `main` goes
 * unjudged until the deletion lands, and the reverse is judged. */
const hasSweepWorkflow = () =>
	fs.existsSync(path.join(REPO, ".github", "workflows", SWEEP_WORKFLOW));

/** @param {string|null|undefined} sha */
const short = (sha) => (sha || "").slice(0, 7);

/**
 * The wall-clock deadline a --notify run's gh() calls must not cross in sum
 * (mantahostels#2177), or null when nothing bounds this run — the on-demand form, run by
 * a human at a terminal with no hook timeout over it.
 *
 * @param {boolean} notify
 * @returns {number|null}
 */
const notifyDeadline = (notify) =>
	notify ? Date.now() + NOTIFY_BUDGET_MS : null;

/**
 * How long a gh() call may still take: capped at 8000 (mantahostels#2134) and, under
 * --notify, at whatever is left of NOTIFY_BUDGET_MS, whichever is smaller.
 * Null means the budget is spent — do not call gh() at all.
 *
 * @param {number|null} deadline
 * @returns {number|null}
 */
function ghTimeout(deadline) {
	if (deadline === null) return 8000;
	const remaining = deadline - Date.now();
	return remaining < NOTIFY_BUDGET_FLOOR_MS ? null : Math.min(8000, remaining);
}

/**
 * A span of milliseconds, at the coarseness a reader judges staleness by.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
	const mins = Math.max(0, Math.round(ms / 60_000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * How long ago a run started, or null when GitHub's timestamp will not parse.
 *
 * @param {Run} run
 * @returns {string|null}
 */
function ageOf(run) {
	const started = Date.parse(run.createdAt || "");
	return Number.isNaN(started) ? null : formatDuration(now() - started);
}

/**
 * Every time the schedule fires over the two UTC days beginning with `from`'s,
 * ascending.
 *
 * Two days, for the two reasons its callers each have one of: a time past the
 * last slot of the day rolls over to the first of the next, and a 24-hour window
 * straddles midnight for all but four hours of the day.
 *
 * Both readers of the cron table go through here.
 *
 * @param {number} from
 * @returns {number[]}
 */
function slotsFrom(from) {
	const d = new Date(from);
	/** @type {number[]} */
	const out = [];
	for (let day = 0; day <= 1; day++)
		for (const hour of SWEEP_HOURS_UTC)
			out.push(
				Date.UTC(
					d.getUTCFullYear(),
					d.getUTCMonth(),
					d.getUTCDate() + day,
					hour,
				),
			);
	return out;
}

/**
 * When the next scheduled sweep fires, or null if the schedule is empty.
 *
 * @param {number} t
 */
const nextSweepAfter = (t) => slotsFrom(t).find((at) => at > t) ?? null;

/**
 * Where HEAD sits relative to the sha a run tested.
 *
 * `ahead` carries three distinct answers, and they must not be conflated:
 *   >0    HEAD is that many untested commits past the run
 *   0     the run tested HEAD itself, so HEAD is covered
 *   null  UNKNOWN — git could not be read, or the two shas are not one line of
 *         history. NOT the same as covered, which is why buildSweepAdvice() tests
 *         `> 0` rather than truthiness: an unknown must not be reported as
 *         uncovered, and must not spend a sweep's price on a guess either.
 *
 * Both paths print this, so one keying rule serves them rather than two
 * (mantahostels#949 decision 1).
 *
 * @param {string} sha
 * @returns {Coverage}
 */
function headCoverage(sha) {
	let head = "";
	try {
		head = execGit(["rev-parse", "HEAD"], {
			encoding: "utf8",
			cwd: REPO,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Not a git repo, or git is gone: this line is a nicety, not the report.
	}
	// Unknown, not covered.
	if (!head) return { head: "", ahead: null, line: null };
	if (head === sha) return { head, ahead: 0, line: null };

	const ahead = countRange({ good: sha, bad: head, cwd: REPO });
	const behind = countRange({ good: head, bad: sha, cwd: REPO });
	/** @type {string} */
	let line;
	if (ahead)
		line = `Your HEAD is ${short(head)} — ${ahead} commit(s) after this run, which it never tested.`;
	else if (behind)
		line = `Your HEAD is ${short(head)} — ${behind} commit(s) behind this run. Fetch before chasing it.`;
	else
		line = `Your HEAD is ${short(head)}, which is not the sha this run tested.`;
	return { head, ahead, line };
}

/**
 * Where the verdict sits relative to HEAD, compressed to one clause.
 *
 * @param {Coverage} coverage
 * @param {string} sha
 */
const coverageGist = (coverage, sha) => {
	if (coverage.ahead) return `${coverage.ahead} commit(s) behind your HEAD`;
	if (coverage.ahead === 0) return "on your HEAD";
	return `at ${short(sha)}`;
};

/**
 * How long HEAD stays untested, as lines — or none at all.
 *
 * The HATCH_MIN_WAIT_MS gate keeps it quiet when the schedule is about to
 * answer the question anyway (mantahostels#2203).
 *
 * @param {Coverage} coverage
 * @returns {string[]}
 */
function buildSweepAdvice(coverage) {
	// Null tested apart from zero: headCoverage()'s null means "could not tell",
	// which must not read as uncovered.
	if (coverage.ahead === null || coverage.ahead <= 0) return [];
	const t = now();
	const next = nextSweepAfter(t);
	if (next === null || next - t <= HATCH_MIN_WAIT_MS) return [];
	return [
		"",
		`Nothing has tested HEAD, and the next sweep is ${formatDuration(next - t)} away ` +
			`(${new Date(next).toISOString().slice(11, 16)} UTC).`,
	];
}

/**
 * The cron slots that fell inside the ledger window ending at `t`, ascending.
 *
 * @param {number} t
 * @returns {number[]}
 */
function sweepSlots(t) {
	const from = t - SWEEP_LEDGER_MS;
	return slotsFrom(from).filter((at) => at > from && at <= t);
}

/**
 * A slot's time of day — carrying its date when that is not `ref`'s.
 *
 * A 24-hour window straddles midnight for most of the day, so a bare list read
 * `missed 16:00 UTC, 01:00 UTC`: chronological, but indistinguishable from a
 * misprint.
 *
 * @param {number} t
 * @param {number} ref
 */
const slotStamp = (t, ref) => {
	const d = new Date(t);
	/** @param {number} x */
	const day = (x) => new Date(x).toISOString().slice(0, 10);
	// "20 Aug " out of "Wed, 20 Aug 2026 16:00:00 GMT".
	const date = day(t) === day(ref) ? "" : d.toUTCString().slice(5, 12);
	return `${date}${d.toISOString().slice(11, 16)} UTC`;
};

/**
 * Which of the window's slots produced a run, and which did not.
 *
 * A run is attributed to the latest slot at or before it started, so a LATE run
 * still fills the slot it was queued for rather than reading as a miss beside a
 * run that plainly happened. The grace period governs only when a slot may be
 * judged at all: an empty slot says nothing until SWEEP_GRACE_MS has passed.
 *
 * Age is not the test (mantahostels#1024).
 *
 * @param {Run[]} runs
 * @param {number} t
 */
function sweepLedger(runs, t) {
	/** @type {{at: number, run: Run|null}[]} */
	const slots = sweepSlots(t).map((at) => ({ at, run: null }));
	/* SCHEDULED runs only. A hand-fired `workflow_dispatch` sweep does test the
	 * tree, so it counts for coverage — and it is read as coverage, in the newest-
	 * sweep line below. It must not fill a SLOT, though: firing one by hand is the
	 * documented response to a dropped run, so counting it would erase the very
	 * miss that prompted it. Left broken: an `event` GitHub spells some third way
	 * for a cron run would read as a miss at every slot. */
	for (const r of runs.filter((run) => run.event === "schedule")) {
		const started = Date.parse(r.createdAt || "");
		if (Number.isNaN(started)) continue;
		let owner = null;
		for (const s of slots) if (s.at <= started) owner = s;
		// The earliest run in a slot is the one the slot fired; a re-run is not it.
		if (
			owner &&
			(!owner.run || Date.parse(owner.run.createdAt || "") > started)
		)
			owner.run = r;
	}
	/* Judged against the slots old enough to judge, never against all four: at
	 * 15:30 the 15:00 slot is still inside the 5h grace, and counting it would
	 * read `3 of 4 slots fired` over a schedule with nothing wrong with it. At
	 * the 6h cadence (mantahostels#3490) the grace holds back only the newest slot, and only
	 * outside the last hour of its gap. */
	const judgeable = slots.filter((s) => t - s.at > SWEEP_GRACE_MS);
	return {
		slots,
		judgeable,
		pending: slots.length - judgeable.length,
		fired: judgeable.filter((s) => s.run),
		missed: judgeable.filter((s) => !s.run),
	};
}

/**
 * The most recently started run in a list, or null.
 *
 * @param {Run[]} runs
 * @returns {Run|null}
 */
const newestRun = (runs) =>
	runs.reduce(
		(/** @type {Run|null} */ best, r) =>
			Number.isNaN(Date.parse(r.createdAt || "")) ||
			(best &&
				Date.parse(best.createdAt || "") >= Date.parse(r.createdAt || ""))
				? best
				: r,
		null,
	);

/**
 * A workflow file's own name, as `gh workflow run` wants it.
 *
 * @param {Workflow} w
 */
const workflowFile = (w) => (w.path || "").split("/").pop() || w.name;

/**
 * Every run of the sweep workflow gh will admit to, or null when it cannot be
 * read. Its own call rather than a filter over the branch query above: that one
 * is capped at RUN_WINDOW runs of every workflow, so a busy window could push
 * the sweeps out of it entirely.
 *
 * `deadline` is mantahostels#2177's --notify budget: a call given no room left is skipped
 * outright, and this fails open to null exactly as a failed call does.
 *
 * @param {number|null} deadline
 */
function readSweepRuns(deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	try {
		const rows = JSON.parse(
			gh(
				[
					"run",
					"list",
					"--workflow",
					SWEEP_WORKFLOW,
					/* The ledger window holds four scheduled runs (mantahostels#3490). The rest of
					 * the allowance is for what shares the list with them — hand-fired
					 * sweeps and re-runs — because a run pushed out of the list by
					 * them reads as a slot that never fired. 50 leaves room for 46
					 * of those in one day. */
					"--limit",
					"50",
					/* Only what is read: the slot ledger, the newest-sweep line, the
					 * schedule/dispatch split, the newest sweep's own verdict, and the
					 * id and url the report needs to name the step that broke it. */
					"--json",
					"databaseId,headSha,createdAt,event,conclusion,url",
				],
				{ timeout },
			),
		);
		return Array.isArray(rows) ? rows : null;
	} catch {
		/* Fails open to UNKNOWN, never to "none" (mantahostels#1024): a miss claimed off a
		 * failed call is a false alarm at every session start until GitHub answers
		 * again. The null is printed: buildLivenessReport()'s ledger line says the
		 * ledger was unreadable. */
		return null;
	}
}

/**
 * Every workflow whose state is not `active`, or null when it cannot be read.
 *
 * `--all` is not optional: without it a DISABLED workflow vanishes from the list
 * rather than reporting a state, so the naive call sees nothing wrong precisely
 * when something is.
 *
 * `deadline`: see readSweepRuns() above.
 *
 * @param {number|null} deadline
 */
function readInactiveWorkflows(deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	try {
		const rows = JSON.parse(
			gh(["workflow", "list", "--all", "--json", "name,state,path"], {
				timeout,
			}),
		);
		if (!Array.isArray(rows)) return null;
		/* Shape-checked, not trusted: a row without both fields is not a workflow
		 * this understands, and reporting it as non-active would be noise. */
		return rows.filter(
			(w) =>
				typeof w?.name === "string" &&
				typeof w?.state === "string" &&
				w.state !== "active",
		);
	} catch {
		/* Fails open to UNKNOWN (mantahostels#1024), on the same rule as readSweepRuns() above:
		 * a workflow reported disabled off a failed call would send the reader to
		 * re-enable something that was never off. */
		return null;
	}
}

/**
 * Fire a sweep because the newest verdict has gone stale (mantahostels#1816).
 *
 * Returns the line to print, or null when it fired nothing. Never throws: a
 * session start must not die because GitHub refused a dispatch, and a 403 here
 * means the PAT lost `Actions: write` (mantahostels#948, mantahostels#1069).
 *
 * `deadline` is checked AFTER the cooldown and cap, and before the marker
 * write: a fire the budget blocks must not spend the cooldown or the daily
 * cap on a dispatch that never happened (mantahostels#2177).
 *
 * @param {number} t
 * @param {number|null} deadline
 * @returns {string|null}
 */
function fireSweepOnStale(t, deadline) {
	const marker = autofireMarkerPath(REPO);
	if (!marker) return null;

	/* A missing marker is the ordinary first run. Any OTHER fault means the
	 * cooldown cannot be read at all, and firing on a cooldown you cannot read
	 * is the uncapped case mantahostels#1816 ruled out — so say so and fire nothing, rather
	 * than swallowing it. */
	const { state, error } = readAutofireState(marker);
	if (error)
		return `  Could not read the sweep autofire cooldown, so fired nothing: ${parseErrLine(error)}`;

	/* ABSOLUTE distance, so a marker dated in the FUTURE expires. Under a plain
	 * `t - last` a clock skew or a WFC_NOW run leaves a marker nothing ages
	 * out, wedging autofire permanently and silently. */
	const last = Number(state.last);
	if (Number.isFinite(last) && Math.abs(t - last) < AUTOFIRE_COOLDOWN_MS)
		return null;

	/* Shared with the hand-fire guard (mantahostels#2202), so "already fired today" counts
	 * both routes. */
	const spent = spentToday(state, t);
	if (spent >= AUTOFIRE_DAILY_CAP)
		return `  Not firing one: ${AUTOFIRE_DAILY_CAP} sweeps already fired today (automatic and hand-fired share one budget, mantahostels#2202).`;

	const timeout = ghTimeout(deadline);
	if (timeout === null)
		return "  Not firing one: --notify's gh-call budget was already spent (mantahostels#2177).";

	/* Written BEFORE the dispatch, so a dispatch that hangs or half-succeeds
	 * still holds both the cooldown and the day's count. */
	try {
		recordFiring(marker, t, spent);
	} catch (e) {
		return `  Could not write the sweep autofire cooldown, so fired nothing: ${parseErrLine(e)}`;
	}

	try {
		gh(["workflow", "run", SWEEP_WORKFLOW], { timeout });
		return "  Fired one automatically (verdict was stale).";
	} catch (e) {
		return `  Could not fire one automatically: ${parseErrLine(e)}`;
	}
}

/**
 * The failing steps as lines under `indent`, or the one line saying why there
 * are none. Shared by the two places a red names its steps (mantahostels#2203).
 *
 * @param {string[]|null} steps
 * @param {string} indent
 * @returns {string[]}
 */
const buildStepLines = (steps, indent) => {
	if (steps === null)
		return [`${indent}(could not read which step failed — see the run)`];
	if (steps.length > 0) return steps.map((step) => `${indent}${step}`);
	return [`${indent}(the run reports no failing step — see the run)`];
};

/**
 * The open red-suite tracking issue; null where none is open, false where the
 * tracker could not be asked.
 *
 * @typedef {() => {number: number}|null|false} TrackingLookup
 */

/**
 * What the red-suite filer did about a red suite job, as one clause (#532).
 * Where no open issue covers it and the day's reading shows the filer did
 * not file, the filer is launched from here (#2480).
 *
 * @param {TrackingLookup} lookupIssue
 */
function suiteTicket(lookupIssue) {
	const found = lookupIssue();
	if (found) return `covered by #${found.number}`;
	if (found === false)
		return "could not ask the tracker whether an open issue covers this";
	const fallback = fileWhereUnfiled(REPO, now());
	if (fallback) return `no open issue covers this: ${fallback}`;
	return "no open issue covers this — the daily repo-checks run files the newest red, unless an issue was closed after it (#1963)";
}

/**
 * suiteTicket(), worked out at most once a run, so the filer is launched
 * once however many red runs name the suite job.
 *
 * @typedef {() => string} SuiteTicket its first call may launch the filer
 * @param {TrackingLookup} lookupIssue
 * @returns {SuiteTicket}
 */
function suiteTicketOrFileOnce(lookupIssue) {
	/** @type {string|undefined} */
	let clause;
	return () => {
		clause ??= suiteTicket(lookupIssue);
		return clause;
	};
}

/**
 * Whether an open issue already covers each failed job of a red run, as lines
 * under `indent` (#532). Only the sweep's suite job has a filer,
 * scripts/report-red-suite.js, and whether it files is its own call.
 *
 * @param {boolean} isSweep
 * @param {RunFailures|null} failures
 * @param {SuiteTicket} ticket
 * @param {string} indent
 * @returns {string[]}
 */
function buildTicketLines(isSweep, failures, ticket, indent) {
	if (!failures)
		return [
			`${indent}Ticket: could not read which job failed, so cannot say whether an issue covers it`,
		];
	/** @param {string} name */
	const filerOwns = (name) => isSweep && name.startsWith(redSuite.SUITE_JOB);
	const lines = failures.jobs
		.filter((name) => !filerOwns(name) && !(isSweep && name === VERDICT_JOB))
		.map((name) => `${indent}Ticket for ${name}: no filer covers this job`);
	if (!isSweep) return lines;
	if (redSuite.filesFor(failures.rows))
		lines.unshift(`${indent}Ticket for ${redSuite.SUITE_JOB}: ${ticket()}`);
	else if (failures.jobs.some((name) => name.startsWith(redSuite.SUITE_JOB)))
		lines.unshift(
			`${indent}Ticket for ${redSuite.SUITE_JOB}: none will be filed — the filer reads this job as carrying no verdict`,
		);
	return lines;
}

/**
 * The newest sweep's red, named down to the step that broke it — or no lines.
 *
 * A session that fires a sweep over an established red buys no green
 * certificate, so what it is handed instead is the verdict it would have
 * re-discovered (mantahostels#2203). Costs one extra gh call, and only on a red —
 * two where its suite job is the red, the second asking whether it is ticketed.
 *
 * @param {Run|null} newest
 * @param {number|null} deadline
 * @param {SuiteTicket} ticket
 * @returns {string[]}
 */
function buildRedSweepLines(newest, deadline, ticket) {
	/* An empty conclusion is a run still going, not a red — the same distinction
	 * hasVerdict() draws. Red is spelled as NOT-good, this file's convention
	 * throughout (mantahostels#945): a conclusion GitHub adds later surfaces rather than
	 * passing silently. */
	if (
		!newest?.conclusion ||
		GOOD.has(newest.conclusion) ||
		carriesNoVerdict(newest)
	)
		return [];
	const failures = runFailures(newest.databaseId, deadline);
	const lines = [
		`⚠ The newest sweep concluded ${newest.conclusion} — firing another tests the same tree.`,
		...buildStepLines(failures?.steps ?? null, "  "),
		...buildTicketLines(true, failures, ticket, "  "),
	];
	if (newest.url) lines.push(`  ${newest.url}`);
	return lines;
}

/**
 * The liveness report: whether the sweep is still firing, and whether any
 * workflow has been disabled.
 *
 * Returns lines to print and findings to raise, plus the one-line ledger the
 * on-demand form prints even when everything is healthy (mantahostels#1024 point 6).
 *
 * `sweepRed()` is the newest sweep's red detail for a caller that has not
 * already had it: the missed-slot branch prints it inline and hands back an
 * empty one so the green path does not repeat it. A function, not an array,
 * because reading it costs a gh call and the --notify paths that never print
 * it must not spend one (mantahostels#2177).
 *
 * `hasSweep` false (#403) judges only the other workflows' states: no ledger,
 * no staleness, no disabled-sweep warning.
 *
 * @param {Run[]|null} runs
 * @param {Workflow[]|null} inactive
 * @param {{ t: number, deadline: number|null, hasSweep: boolean, ticket: SuiteTicket }} opts
 */
function buildLivenessReport(
	runs,
	inactive,
	{ t, deadline, hasSweep, ticket },
) {
	/** @type {LivenessOut} */
	const out = { lines: [], findings: [] };
	const { lines, findings } = out;

	reportDisabledWorkflows(out, inactive);

	if (!hasSweep)
		return {
			lines,
			findings,
			ledgerLine: `Sweep ledger: no .github/workflows/${SWEEP_WORKFLOW} in this tree, so no sweep is judged.`,
			staleMs: null,
			sweepRed: () => [],
		};

	const stopped = (inactive || []).find(
		(w) => workflowFile(w) === SWEEP_WORKFLOW,
	);
	/* Null means the query failed, and an empty list means the workflow has never
	 * run at all — which is also what a workflow added an hour ago looks like, so
	 * neither is judged. A schedule that has genuinely never fired surfaces
	 * through the state read above and through the no-finished-runs path. */
	const ledger = runs && runs.length > 0 ? sweepLedger(runs, t) : null;
	const newest = runs && runs.length > 0 ? newestRun(runs) : null;

	/* Read once and shared. Each call is a pair of git subprocesses, and two
	 * readings of it could disagree if a neighbour commits in between. */
	const coverage = newest
		? headCoverage(newest.headSha ?? "")
		: { head: "", ahead: null, line: null };

	/** @returns {string[]} */
	const sweepRed = () => buildRedSweepLines(newest, deadline, ticket);

	const newestLine = buildNewestSweepLine(runs, newest, coverage, t);

	/* How stale the verdict is, for autofire (mantahostels#1816). Null on every path that
	 * cannot price it — a quiet repo HEAD's sweep already covers, an unreadable
	 * runs list, and a workflow GitHub has disabled outright, where
	 * `workflow_dispatch` goes down with the file (mantahostels#909). */
	const staleMs = stopped ? null : staleMsOf(newest, coverage, t);

	if (stopped) {
		reportStoppedSweep(out, stopped, newestLine);
		/* sweepRed() is handed back live here, unlike on the missed-slot path
		 * below: a workflow GitHub disabled can have gone red before it stopped,
		 * and nothing above has said so. */
		return { lines, findings, ledgerLine: null, staleMs, sweepRed };
	}

	if (ledger && ledger.missed.length > 0) {
		reportMissedSlots(out, { ledger, inactive, newestLine, t });
		/* A missed slot is exactly where a reader reaches for a hand-fired sweep,
		 * so the red that makes firing pointless belongs here — and blanked below,
		 * the green path printing it otherwise a second time (mantahostels#2203). */
		lines.push(...sweepRed());
		return { lines, findings, ledgerLine: null, staleMs, sweepRed: () => [] };
	}

	/* Healthy, or unreadable. Either way the on-demand form says which — a
	 * detector that has gone blind must not read as a clean bill of health, which
	 * is the whole fault this check exists to close. */
	const blind = inactive
		? ""
		: " Workflow states unreadable, so a disabled workflow would not be seen.";
	const ledgerLine = buildLedgerStateLine(runs, ledger, newestLine) + blind;
	return { lines, findings, ledgerLine, staleMs, sweepRed };
}

/**
 * @typedef {{lines: string[], findings: {tag: string, message: string}[]}} LivenessOut
 */

/**
 * Every workflow other than the sweep that GitHub reports disabled.
 *
 * @param {LivenessOut} out accumulator: a finding and its lines per disabled workflow
 * @param {Workflow[]|null} inactive
 */
function reportDisabledWorkflows(out, inactive) {
	for (const w of inactive || [])
		if (workflowFile(w) !== SWEEP_WORKFLOW) {
			out.findings.push({
				tag: "WORKFLOW-DISABLED",
				message: `${workflowFile(w)} is ${w.state}, so it will not run`,
			});
			out.lines.push(
				`⚠ ${workflowFile(w)} is ${w.state} — it will not run until re-enabled.`,
				`  Re-enable (${WHO_CAN_RUN_IT}): gh workflow enable ${workflowFile(w)}${repoFlag()}`,
			);
		}
}

/**
 * The newest sweep, its age and how far HEAD has moved past it, in one line.
 * A hand-fired run counts here even though it fills no slot: it tested the
 * tree.
 *
 * @param {Run[]|null} runs
 * @param {Run|null} newest
 * @param {Coverage} coverage
 * @param {number} t
 * @returns {string}
 */
function buildNewestSweepLine(runs, newest, coverage, t) {
	if (newest)
		return (
			`newest sweep ${slotStamp(Date.parse(newest.createdAt || ""), t)}, ${ageOf(newest)} ago, ` +
			`${coverageGist(coverage, newest.headSha ?? "")}`
		);
	if (runs) return "no sweep has ever run";
	return "and GitHub would not say when the last sweep was";
}

/**
 * The newest sweep's age, where it is older than SWEEP_STALE_MS and HEAD has
 * moved past it; null otherwise, or where that cannot be priced.
 *
 * @param {Run|null} newest
 * @param {Coverage} coverage
 * @param {number} t
 * @returns {number|null}
 */
function staleMsOf(newest, coverage, t) {
	const newestAt = newest ? Date.parse(newest.createdAt || "") : Number.NaN;
	return Number.isFinite(newestAt) &&
		coverage.ahead !== null &&
		coverage.ahead > 0 &&
		t - newestAt > SWEEP_STALE_MS
		? t - newestAt
		: null;
}

/**
 * @param {LivenessOut} out accumulator: the stopped-sweep finding and its lines
 * @param {Workflow} stopped
 * @param {string} newestLine
 */
function reportStoppedSweep(out, stopped, newestLine) {
	// The permanent variant. The slot misses below are its consequence, not a
	// second fault, so they are not printed alongside it.
	const [initial] = newestLine;
	if (initial === undefined) throw new Error("the newest-sweep line is empty");
	out.findings.push({
		tag: "SWEEP-STOPPED",
		message: `${SWEEP_WORKFLOW} is ${stopped.state} — no sweep will fire again until it is re-enabled`,
	});
	out.lines.push(
		`⚠ ${SWEEP_WORKFLOW} is ${stopped.state} — no sweep will fire again until re-enabled.`,
		`  ${initial.toUpperCase()}${newestLine.slice(1)}.`,
		`  Re-enable (${WHO_CAN_RUN_IT}): gh workflow enable ${SWEEP_WORKFLOW}${repoFlag()}`,
	);
}

/**
 * @param {LivenessOut} out accumulator: the missed-slots finding and its lines
 * @param {{ledger: ReturnType<typeof sweepLedger>, inactive: Workflow[]|null, newestLine: string, t: number}} opts
 */
function reportMissedSlots(out, { ledger, inactive, newestLine, t }) {
	const n = `${ledger.missed.length} of ${ledger.judgeable.length}`;
	out.findings.push({
		tag: "SWEEP-MISSED",
		message: `${n} sweep slot(s) in the last 24h produced no run`,
	});
	out.lines.push(
		`⚠ Scheduled sweeps missing: ${n} slots in the last 24h produced no run`,
		`  (missed ${ledger.missed.map((s) => slotStamp(s.at, t)).join(", ")}; ${newestLine}).`,
		inactive
			? `  ${SWEEP_WORKFLOW} reads \`active\` — GitHub dropped queued runs.`
			: `  Could not read whether ${SWEEP_WORKFLOW} is still enabled.`,
	);
}

/**
 * The on-demand ledger line on the healthy-or-unreadable path.
 *
 * @param {Run[]|null} runs
 * @param {ReturnType<typeof sweepLedger>|null} ledger
 * @param {string} newestLine
 * @returns {string}
 */
function buildLedgerStateLine(runs, ledger, newestLine) {
	if (!runs)
		return `Sweep ledger unreadable — could not ask GitHub for ${SWEEP_WORKFLOW} runs.`;
	if (ledger)
		return (
			`Sweep ledger: ${ledger.fired.length} of ${ledger.judgeable.length} judgeable slots fired in the last 24h` +
			`${ledger.pending ? ` (${ledger.pending} still inside its grace)` : ""} — ${newestLine}.`
		);
	return `Sweep ledger: no ${SWEEP_WORKFLOW} run on record yet, so no slot can be judged.`;
}

/**
 * @typedef {{name: string, conclusion?: string|null,
 *   steps?: {name: string, conclusion?: string|null}[]}} Job
 * @typedef {{steps: string[], jobs: string[], rows: Job[]}} RunFailures
 */

/**
 * The `job › step` of everything that failed inside a run, and the failed
 * jobs' own names.
 *
 * A second gh call, made only once a red is already established, so the green
 * path still costs one query. Returns null when it cannot be read, so a missing
 * step name degrades the report rather than taking the check down.
 *
 * Called once PER failed run (mantahostels#2177): a sha with several red workflows makes
 * several of these, the one term in this file's --notify aggregate that is
 * not bounded to a fixed count, so `deadline` is checked here too.
 *
 * @param {number|string} runId
 * @param {number|null} deadline
 * @returns {RunFailures|null}
 */
function runFailures(runId, deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	let jobs;
	try {
		jobs = JSON.parse(
			gh(["run", "view", String(runId), "--json", "jobs"], {
				timeout,
			}),
		).jobs;
	} catch {
		return null;
	}
	if (!Array.isArray(jobs)) return null;

	const failed = failedSteps(jobs);

	/* The jobs asked "is this ticketed" of. A cancelled job reached no verdict,
	 * so there is nothing to ticket. */
	const failedJobs = jobs
		.filter((j) => badNotCancelled(j.conclusion))
		.map((j) => String(j.name));

	return { steps: failed, jobs: failedJobs, rows: jobs };
}

/** @param {string|null|undefined} c */
const bad = (c) => Boolean(c) && !GOOD.has(c ?? "");
/** @param {string|null|undefined} c */
const badNotCancelled = (c) => bad(c) && c !== "cancelled";

/**
 * The `job › step` of every failed step, or the failed jobs' own names where
 * no step reached a verdict.
 *
 * @param {Job[]} jobs
 * @returns {string[]}
 */
function failedSteps(jobs) {
	/** @type {string[]} */
	const failed = [];
	/* `cancelled` excluded here, unlike at run level: the steps after a
	 * failing one are cancelled as a consequence of it, so listing them
	 * buries the one step that actually broke. */
	for (const j of jobs)
		for (const s of j.steps || [])
			if (badNotCancelled(s.conclusion)) failed.push(`${j.name} › ${s.name}`);

	/* A job that died before any step reached a verdict — the runner vanished, the
	 * job timed out — leaves nothing above. Naming the job is still a narrowing. */
	if (failed.length === 0)
		for (const j of jobs) if (bad(j.conclusion)) failed.push(j.name);
	return failed;
}

/**
 * The newest run BEFORE `run` that the same workflow passed. Its sha is the
 * known-good end of the range, and the default `good` bisect.yml resolves for
 * itself.
 *
 * Same workflow, deliberately: another workflow's green says nothing about this
 * one.
 *
 * @param {Run} run
 * @param {Run[]} judged
 * @returns {Run|null}
 */
const lastGreenBefore = (run, judged) =>
	judged.find(
		(r) =>
			r.workflowName === run.workflowName &&
			r.databaseId < run.databaseId &&
			GOOD.has(r.conclusion ?? ""),
	) || null;

/** This checker's name, shared with its delivery-stamp file. */
const CHECKER = "ci-status";

/**
 * @typedef {ReturnType<typeof buildLivenessReport>} Liveness
 */

/**
 * The newest runs on `branch`. SKIPs where GitHub is unreachable or the
 * --notify budget is spent, and BROKENs on anything else.
 *
 * @param {Ctx} ctx
 * @param {string} branch
 * @param {number|null} deadline
 * @returns {Run[]}
 */
function readBranchRuns(ctx, branch, deadline) {
	const branchTimeout = ghTimeout(deadline);
	/* Unreachable in practice — deadline was just set, so a fresh budget
	 * always clears NOTIFY_BUDGET_FLOOR_MS — but ghTimeout()'s contract is
	 * "null means do not call gh()", so this call honours it like every
	 * other one rather than assuming its own timing. */
	if (branchTimeout === null)
		ctx.skip(
			`--notify's gh-call budget was already spent before asking GitHub for runs on ${branch} (mantahostels#2177).`,
		);

	try {
		const out = gh(
			[
				"run",
				"list",
				"--branch",
				branch,
				"--limit",
				String(RUN_WINDOW),
				"--json",
				"databaseId,headSha,status,conclusion,workflowName,event,url,createdAt",
			],
			{ timeout: branchTimeout },
		);
		const runs = JSON.parse(out);
		if (!Array.isArray(runs))
			throw new Error("gh returned JSON that is not a list of runs");
		return runs;
	} catch (e) {
		/* A detector that cannot see must not claim all-clear. What it must also
		 * not do is misattribute the cause (mantahostels#164, the ticket that made an
		 * unreachable GitHub a SKIP and a gh crash a BROKEN). Under --notify,
		 * which is how SessionStart invokes this, both still exit 0. */
		if (parseGhFailureReason(e) === "unreachable")
			ctx.skip(
				`could not ask GitHub for runs on ${branch} (GitHub unreachable: ${parseErrLine(e)}).`,
			);
		return ctx.broken(
			`could not ask GitHub for runs on ${branch}, and GitHub was reachable —\n` +
				`        this check is broken, not idle: ${parseErrLine(e)}`,
		);
	}
}

/**
 * The tracking-issue lookup, asked at most once a run, and only where a red
 * suite job needs it (#532).
 *
 * @param {number|null} deadline
 * @returns {TrackingLookup}
 */
function trackingLookupOnce(deadline) {
	/* `undefined` is not yet asked; `false` is asked and unanswerable. */
	/** @type {ReturnType<TrackingLookup>|undefined} */
	let tracking;
	return () => {
		if (tracking !== undefined) return tracking;
		const timeout = ghTimeout(deadline);
		try {
			tracking =
				timeout !== null &&
				openTrackingIssue(
					{ title: redSuite.TITLE, label: redSuite.LABEL },
					{ timeout },
				);
		} catch {
			tracking = false;
		}
		return tracking;
	};
}

/**
 * Under --notify, says how stale the newest sweep is and fires one where
 * that is allowed — appended to the liveness lines.
 *
 * @param {Liveness} live
 * @param {{notify: boolean, isRecheck: boolean, deadline: number|null}} opts
 * @returns {Liveness} `live` with those lines appended, or `live` itself
 */
function noteStaleSweep(live, { notify, isRecheck, deadline }) {
	if (!notify || live.staleMs === null) return live;
	/* The staleness is REPORTED whether or not a sweep is fired: the
	 * cooldown and the daily cap ration the spending, never the reader's
	 * view of how old the verdict they are starting on is. */
	const stale = `⚠ Newest sweep is ${formatDuration(live.staleMs)} old — past the ${formatDuration(SWEEP_STALE_MS)} a session should start on.`;
	const fired = isRecheck ? null : fireSweepOnStale(now(), deadline);
	return { ...live, lines: [...live.lines, stale, ...(fired ? [fired] : [])] };
}

/**
 * Emit it; answer whether it found a fault. Called once per exit path.
 *
 * @param {Ctx} ctx
 * @param {Liveness} live
 */
const livenessEmitter = (ctx, live) => () => {
	for (const f of live.findings) ctx.fail(f.tag, f.message);
	for (const line of live.lines) ctx.say(line);
	// The healthy ledger is the on-demand form's alone (mantahostels#949 decision 2).
	if (!ctx.notify && live.ledgerLine) ctx.say(live.ledgerLine);
	return live.findings.length > 0;
};

/**
 * The finished runs that carry a verdict, newest first; SKIPs where none does.
 *
 * @param {Ctx} ctx
 * @param {Run[]} runs
 * @param {Run[]} completed
 * @param {string} branch
 * @returns {Run[]}
 */
function judgedRuns(ctx, runs, completed, branch) {
	/* A cancelled run a newer run of the same workflow took over carries no
	 * verdict, so it is dropped rather than judged, and the sha it belongs to is
	 * passed over in favour of one that was actually run.
	 *
	 * A cancellation with nothing newer behind it is NOT dropped. Nothing took
	 * over from it, so that commit genuinely went unverified. `runs` rather
	 * than `completed` on purpose: the run that superseded this one may not
	 * have finished. */
	/** @type {Map<string|undefined, number>} */
	const newestId = new Map();
	for (const r of runs)
		newestId.set(
			r.workflowName,
			Math.max(r.databaseId, newestId.get(r.workflowName) ?? -1),
		);
	/** @param {Run} r */
	const replaced = (r) =>
		carriesNoVerdict(r) && (newestId.get(r.workflowName) ?? -1) > r.databaseId;

	/* SKIP, not OK. OK means "looked, found nothing wrong"; here nothing in
	 * the window carried a verdict at all, and RUN_WINDOW is the whole
	 * window — a newer run always sorts into it while an older one falls out,
	 * so repeated cancellations can fill it with superseded runs while a
	 * genuinely red run sits just outside. */
	const judged = completed.filter((r) => !replaced(r));
	if (judged.length === 0)
		ctx.skip(
			`every finished run in the window on ${branch} was superseded before it\n` +
				"        finished, so none of them carries a verdict — and a run that does may\n" +
				`        sit outside the ${RUN_WINDOW}-run window this reads.`,
		);

	judged.sort(
		(a, b) =>
			Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") ||
			b.databaseId - a.databaseId,
	);
	return judged;
}

/**
 * @param {Ctx} ctx
 * @param {{branch: string, sha: string, run: Run, hasSweep: boolean, live: Liveness, emitLiveness: () => boolean}} opts
 */
function reportGreen(ctx, { branch, sha, run, hasSweep, live, emitLiveness }) {
	/* mantahostels#949 decision 2: the SessionStart hook speaks only when something is
	 * red, so a coverage report there would give the one channel meaning
	 * "something is wrong" a second meaning. */
	if (ctx.notify) {
		emitLiveness();
		return {
			okLine: `CI is green on ${branch} (${short(sha)}).`,
			noun: SWEEP_NOUN,
		};
	}

	const age = ageOf(run);
	const coverage = headCoverage(sha);
	ctx.say(
		`Newest verdict on ${branch}: ${run.workflowName} ${run.conclusion}` +
			`${run.event ? ` (${run.event})` : ""} at ${short(sha)}, ` +
			`${age ? `${age} ago` : "age unreadable"}.`,
	);
	if (coverage.line) ctx.say(coverage.line);
	if (hasSweep) for (const line of buildSweepAdvice(coverage)) ctx.say(line);
	for (const line of live.sweepRed()) ctx.say(line);
	emitLiveness();

	// Summary and payload carry it too, so a --json reader is covered.
	return {
		okLine:
			`CI is green on ${branch} — ${age ? `${age}-old` : "undated"} verdict ` +
			`${coverageGist(coverage, sha)}.`,
		noun: SWEEP_NOUN,
		data: { branch, sha, age, ahead: coverage.ahead },
	};
}

const SWEEP_NOUN = "CI liveness fault(s)";

/**
 * @typedef {{
 *   branch: string,
 *   sha: string,
 *   failed: Run[],
 *   keyed: Run[],
 *   deadline: number|null,
 *   ticket: SuiteTicket,
 *   stampCtx: Ctx | {notify: boolean, persisting: boolean},
 *   live: Liveness,
 *   emitLiveness: () => boolean,
 * }} RedState
 */

/**
 * The red (or never-finished) report, stamped once it is out.
 *
 * @param {Ctx} ctx
 * @param {RedState} st
 */
function reportRed(ctx, st) {
	const {
		branch,
		sha,
		failed,
		deadline,
		ticket,
		live,
		emitLiveness,
		stampCtx,
	} = st;
	/* Two different faults, and a sha can carry both. A run nothing took over
	 * from never finished — no test failed, so "red" would send the reader
	 * hunting a failure that does not exist. Not `every`: that reads a mixed
	 * sha wholly as red. */
	const unfinished = failed.filter(carriesNoVerdict);
	const broken = failed.filter((r) => !carriesNoVerdict(r));

	/* Stamped on the highest run id reported, never on the clock. Run ids rise
	 * with creation, so an id orders runs by arrival whatever WSL2's clock did on
	 * resume, and a re-run of the same failure gets a fresh higher id and so
	 * reports again. */
	const newestRunId = Math.max(...failed.map((r) => r.databaseId));
	/* Marked a high-water mark rather than an identity, so that whoever
	 * delivers the report applies "no newer than the last one shown" and not
	 * equality (mantahostels#1975). */
	const signature = deliveryStamp.highWater(newestRunId);

	// Already reported: an OK outcome, which --notify prints nothing for. The
	// liveness report is a separate fault and still speaks. Never taken under
	// persist mode (mantahostels#1975).
	if (deliveryStamp.alreadyDelivered(stampCtx, CHECKER, signature)) {
		emitLiveness();
		return {
			okLine: buildAlreadyReportedLine(branch, broken),
			noun: SWEEP_NOUN,
		};
	}

	failRuns(ctx, failed);
	sayVerdict(ctx, { branch, sha, broken, unfinished });
	/* The failing STEP, per red run — the strongest single narrowing signal
	 * this can print, since a red is as often Biome, shellcheck or a doc guard
	 * as it is a test. Not asked for an unfinished run: nothing in it failed. */
	for (const r of failed) sayFailedRun(ctx, r, { deadline, ticket });

	sayBisectRange(ctx, branch, broken, st.keyed);

	const coverage = headCoverage(sha);
	if (coverage.line) ctx.say(`\n${coverage.line}`);
	ctx.say(`\nLogs: gh run view ${newestRunId} --log-failed${repoFlag()}`);

	if (live.lines.length > 0 || (!ctx.notify && live.ledgerLine)) ctx.say("");
	emitLiveness();

	// Stamped only AFTER the report is out. Stamping first loses the report
	// entirely if this process dies in between — its session exiting, a closed
	// terminal — and this failure would then be suppressed for good. A no-op
	// under persist mode (mantahostels#1975).
	deliveryStamp.markDelivered(stampCtx, CHECKER, signature);

	return {
		stamp: signature,
		/* Counted on the runs alone, so the noun and the number agree. */
		count: failed.length,
		noun: redNoun(branch, broken, live),
		data: { branch, sha, failed },
	};
}

/**
 * @param {string} branch
 * @param {Run[]} broken
 */
const buildAlreadyReportedLine = (branch, broken) =>
	broken.length > 0
		? `CI is red on ${branch}, already reported.`
		: `CI never finished on ${branch}, already reported.`;

/**
 * @param {string} branch
 * @param {Run[]} broken
 * @param {Liveness} live
 */
const redNoun = (branch, broken, live) =>
	(broken.length > 0
		? `failing CI run(s) on ${branch}`
		: `unverified CI run(s) on ${branch}`) +
	(live.findings.length > 0
		? `, plus ${live.findings.length} ${SWEEP_NOUN}`
		: "");

/**
 * @param {Ctx} ctx
 * @param {Run[]} failed
 */
function failRuns(ctx, failed) {
	for (const r of failed)
		ctx.fail(
			carriesNoVerdict(r) ? "UNVERIFIED-RUN" : "RED-RUN",
			`${r.workflowName}: ${r.conclusion} — ${r.url}`,
			r,
		);
}

/**
 * @param {Ctx} ctx
 * @param {{branch: string, sha: string|undefined, broken: Run[], unfinished: Run[]}} opts
 */
function sayVerdict(ctx, { branch, sha, broken, unfinished }) {
	const at = `on ${branch} at ${short(sha)}`;
	const redPart = `${broken.length} failing run(s)`;
	const unrunPart = `${unfinished.length} cancelled run(s) nothing superseded, so this commit is unverified`;

	// No severity prefix: check.js owns the one `SEVERITY:` line a run emits.
	/** @type {string} */
	let verdict;
	if (broken.length > 0 && unfinished.length > 0)
		verdict = `CI is red ${at} — ${redPart}, and ${unrunPart}.\n`;
	else if (broken.length > 0) verdict = `CI is red ${at} — ${redPart}.\n`;
	else verdict = `CI never finished ${at} — ${unrunPart}.\n`;
	ctx.say(verdict);
}

/**
 * @param {Ctx} ctx
 * @param {Run} r
 * @param {{deadline: number|null, ticket: SuiteTicket}} opts
 */
function sayFailedRun(ctx, r, { deadline, ticket }) {
	/* The trigger, because it changes what the verdict means: `schedule` is a
	 * sweep covering every commit since the last one, `workflow_dispatch` is
	 * somebody's hand-fired run of one sha. */
	ctx.say(
		`  ${r.workflowName}: ${r.conclusion}${r.event ? ` (${r.event})` : ""}`,
	);
	if (!carriesNoVerdict(r)) {
		const failures = runFailures(r.databaseId, deadline);
		for (const line of buildStepLines(failures?.steps ?? null, "    "))
			ctx.say(line);
		for (const line of buildTicketLines(
			r.workflowName === redSuite.SWEEP_NAME,
			failures,
			ticket,
			"    ",
		))
			ctx.say(line);
	}
	ctx.say(`    ${r.url}`);
}

/**
 * The commit range back to the newest red run's last green, or how to find
 * that green where it is outside the window.
 *
 * @param {Ctx} ctx
 * @param {string} branch
 * @param {Run[]} broken
 * @param {Run[]} keyed
 */
function sayBisectRange(ctx, branch, broken, keyed) {
	const culprit = broken[0];
	const green = culprit ? lastGreenBefore(culprit, keyed) : null;
	if (culprit && !green) {
		ctx.say(
			`\nNo green ${culprit.workflowName} run inside the last ${RUN_WINDOW}, so the range back to\n` +
				"one cannot be read from here. Find its sha with:\n" +
				`  gh run list --branch ${branch} --workflow "${culprit.workflowName}" --status success --limit 1 --json headSha${repoFlag()}`,
		);
		/* `green` is redundant — the arm above took `culprit && !green` — and is
		 * what says the range below has both its ends. */
	} else if (culprit && green) {
		const ends = {
			good: green.headSha ?? "",
			bad: culprit.headSha ?? "",
		};
		const range = readRange({ ...ends, cwd: REPO });
		ctx.say("");
		for (const line of renderRange(range, ends)) ctx.say(line);
		for (const line of buildBisectAdvice(range, {
			...ends,
			workflow: BISECT_WORKFLOW,
			repoFlag: repoFlag(),
		}))
			ctx.say(line);
	}
}

runCheck({
	name: CHECKER,
	usage: "node check-ci-status.js [--branch <name>] [--notify [--recheck]]",
	valueFlags: ["--branch"],
	flags: ["--recheck"],
	run(/** @type {Ctx} */ ctx) {
		const branch = ctx.value("--branch", "main");
		/* mantahostels#2177: null under the on-demand form, which no hook times out. Set
		 * once, at the top, so it covers every gh() call this run makes —
		 * including this first one. */
		const deadline = notifyDeadline(ctx.notify);
		const isRecheck = ctx.has("--recheck");
		// `persisting` is delivery-stamp.js's "this run is not the delivery".
		const stampCtx = isRecheck ? { notify: ctx.notify, persisting: true } : ctx;

		const runs = readBranchRuns(ctx, branch, deadline);

		/* Whether the schedule is still firing at all (mantahostels#1024) — an independent
		 * fault from a red, and one every path below has to be able to report, so
		 * it is read once here and emitted wherever that path ends. Both calls sit
		 * after the branch query, so a GitHub that is down costs one call and not
		 * three. */
		const hasSweep = hasSweepWorkflow();

		const ticket = suiteTicketOrFileOnce(trackingLookupOnce(deadline));

		/* Done here, once, before any exit path emits — emitLiveness() is called
		 * from several (mantahostels#1816). */
		const live = noteStaleSweep(
			buildLivenessReport(
				hasSweep ? readSweepRuns(deadline) : [],
				readInactiveWorkflows(deadline),
				{ t: now(), deadline, hasSweep, ticket },
			),
			{ notify: ctx.notify, isRecheck, deadline },
		);

		const emitLiveness = livenessEmitter(ctx, live);

		/* Runs that reached a VERDICT, not runs the API calls completed. A queued or
		 * running one is passed over, so the last finished verdict is still reported
		 * while a newer run is in flight — the exact case this check exists for. */
		const completed = runs.filter((r) => hasVerdict(r) && r.headSha);
		if (completed.length === 0) {
			emitLiveness();
			return {
				okLine: `no finished CI runs on ${branch} yet.`,
				noun: SWEEP_NOUN,
			};
		}

		const judged = judgedRuns(ctx, runs, completed, branch);
		/* Fall back to the whole set rather than reporting nothing: a repo whose
		 * only runs in the window are denylisted is better read as unknown-but-
		 * looked-at than as silently green. */
		const verdicts = judged.filter(
			(r) => !NOT_A_TREE_VERDICT.has(r.workflowName ?? ""),
		);
		const keyed = verdicts.length > 0 ? verdicts : judged;

		// judgedRuns() skips on an empty set, and `completed` kept only runs
		// carrying a headSha.
		const newest = /** @type {Run} */ (keyed[0]);
		const sha = /** @type {string} */ (newest.headSha);
		const failed = keyed.filter(
			(r) => r.headSha === sha && !GOOD.has(r.conclusion ?? ""),
		);

		if (failed.length === 0)
			return reportGreen(ctx, {
				branch,
				sha,
				run: newest,
				hasSweep,
				live,
				emitLiveness,
			});

		return reportRed(ctx, {
			branch,
			sha,
			failed,
			keyed,
			deadline,
			ticket,
			stampCtx,
			live,
			emitLiveness,
		});
	},
});
