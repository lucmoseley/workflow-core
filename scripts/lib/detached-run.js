/*
 * detached-run.js — the completion record a DETACHED session-start child leaves
 * behind, so that a child which never returns is visible to a later session.
 *
 * THE GAP (mantahostels#1910, raised by /code-review on mantahostels#1899). Three session-start jobs are
 * spawned detached and unwatched: `session-arbiter.js prune-markers` (detached
 * at mantahostels#1899), and `debt sweep` and `retire-stale-containers.js` (detached by
 * sweep-debts-detached.sh, mantahostels#1251 and mantahostels#1632). Each is spawned `stdio: "ignore"`
 * with its spawn error swallowed, and the launching hook returns 0 whatever the
 * child then does. Detaching is right — none of the three fits a 10 s hook
 * budget and nothing in the starting session reads a byte of them — but it
 * removes the only signal there was.
 *
 * AN ERROR LOG IS NOT ENOUGH, WHICH IS WHY THIS IS A COMPLETION RECORD. A
 * throwing sweep already reaches session-arbiter.js's top-level catch and
 * `store.logError`, and check-guard-errors.js reports it at the next start. What
 * that cannot see is a child KILLED MID-SWEEP, after it opened its row: only
 * something the child writes on its way OUT distinguishes that from a healthy
 * run, which is what `deaths` counts.
 *
 * WHAT THIS STILL CANNOT SEE (mantahostels#1999): `deaths` is incremented by `openRun`,
 * which the child itself calls, so
 * a spawn that never happened at all (the ENOENT swallowed at
 * session-arbiter.js's `child.on("error", () => {})`) or a missing `setsid`
 * swallowed by the launcher's own `try` writes NO row — there is no writer left
 * to write one. The last real row's `finishedAt`/`lastFinishedAt` simply stands,
 * looking exactly like a job that is still healthy and merely hasn't run since.
 * A total-absence check would need a staleness limb keyed to how often each job
 * is expected to fire, which mantahostels#1910 proposed and this file does not implement;
 * none of the three jobs currently derives that rate. Nor does a config dir
 * that is gone: `writeRuns` never makes it (#2889), so every record is lost
 * silently and the last row on disk, if any, stands.
 *
 * THE SHAPE IS THE REAPER'S, DELIBERATELY. scripts/reap-finished-sessions.js
 * answers the same question for the reaper with `wfc-reap-run.json` — a start
 * half written before the slow work, a finish half written at the end, and
 * check-hook-liveness.js's `reapAssertion` reading a row that carries the first
 * and not the second (mantahostels#1920). This is that instrument, generalised to a job name
 * so three children can share one file and one assertion. `bg-run.sh`'s
 * heartbeat shape was the alternative and was not taken (mantahostels#1910): its run root is
 * per-job scratch no later session finds, it keeps one run of history, and its
 * heartbeat exists to catch a harness SIGKILL of a FOREGROUND job, which is not
 * what happens to these children.
 *
 * `git gc --auto` IS THE ONE DETACHED CHILD NOT COVERED, ruled at mantahostels#1910: it is a
 * no-op below git's own loose-object thresholds, so its rows would be
 * near-permanently "nothing happened" and a staleness check on them would be
 * noise. The throttling sweep needs nothing
 * here: check-self-throttling.js already writes `sweptAt` into its own state
 * file and already reports on its age.
 *
 * NEVER THROWS, ON EITHER HALF. Every caller is on a session-start path whose
 * contract is to exit 0, so a read-only or full disk costs one missing record
 * rather than a broken start.
 *
 * IN NO SCRIPT FAMILY (§N3): a library under `scripts/lib/`, called by the
 * children themselves; check-hook-liveness.js is the checker that reads what it
 * writes. lib/reaper.js imports `deathCount` alone, for its own run record.
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDir } = require("./config-dir.js");
const { caught } = require("./caught.js");

/**
 * The record file, one per config dir, keyed by job name.
 *
 * Read by check-hook-liveness.js's `detachedAssertion` and nothing else.
 */
const RUN_FILE = "wfc-detached-run.json";

/**
 * The three jobs that file a record here — `check-hook-liveness.js` imports
 * these same three for `DETACHED_HOW`'s keys.
 */
const JOB_PRUNE_MARKERS = "prune-markers";
const JOB_DEBT_SWEEP = "debt-sweep";
const JOB_RETIRE_STALE_CONTAINERS = "retire-stale-containers";

/**
 * Named so the checker can report a job that has a row and has stopped
 * finishing WITHOUT inventing a finding for one that has never run at all.
 *
 * TYPED AS A TUPLE OF LITERALS, not widened to `string[]`, so
 * check-hook-liveness.js's `DETACHED_HOW` can be typed against
 * `(typeof JOBS)[number]` — a job added here without a matching key there is
 * then a `tsc` error (§N8) rather than a session-start throw (mantahostels#2001).
 * @type {readonly [typeof JOB_PRUNE_MARKERS, typeof JOB_DEBT_SWEEP, typeof JOB_RETIRE_STALE_CONTAINERS]}
 */
const JOBS = [JOB_PRUNE_MARKERS, JOB_DEBT_SWEEP, JOB_RETIRE_STALE_CONTAINERS];

// File-local: `readRuns`/`writeRuns` are the only callers — RUN_FILE is what a
// reader outside needs, and check-hook-liveness.js takes that instead.
const runPath = () => path.join(configDir(), RUN_FILE);

/**
 * @typedef {{
 *   job: string,
 *   startedAt: string,
 *   openedSince: string,
 *   deaths: number,
 *   finishedAt?: string,
 *   lastFinishedAt?: string,
 *   ok?: boolean,
 *   error?: string,
 *   counts?: Record<string, number>,
 * }} RunRecord
 */

/**
 * How long a row may sit open before the NEXT `openRun` counts the run that
 * opened it as dead.
 *
 * IT IS A GRACE ON THE PREVIOUS RUN, NOT A TIMEOUT ON THIS ONE — nothing here
 * ever kills anything. Five minutes is far past what any of the three costs
 * (mantahostels#1111), and the reaper's own record uses the same figure (mantahostels#1920).
 *
 * WITHOUT IT THE COUNTER WOULD FIRE ON CONCURRENCY ALONE: concurrent starts
 * would each read the last one's still-open row as a death.
 */
const INFLIGHT_MS = 300_000;

/**
 * Consecutive deaths before check-hook-liveness.js reports the job.
 *
 * NOT A CLOCK, DELIBERATELY. mantahostels#1910 proposed reporting when the newest completion
 * was older than some multiple of the session rate; a count of starts says the
 * same thing without a rate to guess at, and it cannot fire on a machine that
 * was simply switched off for a week — no session start, no start to count.
 *
 * A GUESS, STATED AS ONE (mantahostels#1999): this machine runs ~200 session starts a day,
 * roughly one every 7 minutes and closer in bursts, so 3 is past what a single
 * burst of concurrent starts could rack up (each of those leaves the count
 * untouched — INFLIGHT_MS's own reason) while still firing within the hour on a
 * job that is genuinely wedged. No measurement backs the number beyond that.
 */
const DEATHS_TO_REPORT = 3;

/**
 * Every job's last record, or `{}` where the file is missing or will not parse.
 *
 * FAILS OPEN, AND THAT COSTS THE WARNING — a corrupt file reads as no record at
 * all, so a death it held goes unreported. Accepted for `writeRuns`'s reason,
 * and self-clearing at the next run, which writes the file whole.
 * @returns {Record<string, RunRecord>}
 */
function readRuns() {
	try {
		const r = JSON.parse(fs.readFileSync(runPath(), "utf8"));
		return r && typeof r === "object" && !Array.isArray(r) ? r : {};
	} catch {
		return {};
	}
}

/**
 * Files one record under its own job, leaving every other job's alone.
 *
 * RE-READS RATHER THAN HOLDING THE OBJECT, so two children running at once lose
 * only their own job's row to each other rather than the whole file. Two
 * sessions starting together still run the SAME job twice concurrently, and
 * there the later `openRun` reopens the row the earlier one is about to close —
 * so an overlap under-reports, showing one run where there were two. Bounded at
 * the handful of starts that can collide, and the condition being reported is
 * standing rather than per-run.
 *
 * NEVER MAKES THE CONFIG DIR, which is the harness's: a child that outlives a
 * test's sandbox would otherwise rebuild the deleted sandbox in the temp root,
 * one leaked directory per run (#2889).
 * @param {RunRecord} record
 */
function writeRuns(record) {
	try {
		const all = readRuns();
		all[record.job] = record;
		fs.writeFileSync(runPath(), `${JSON.stringify(all, null, "\t")}\n`);
	} catch {
		/* A lost record is not worth a throw at a session start. */
	}
}

/**
 * A new open's `deaths` and `openedSince`, judged against the row it replaces.
 * The death-count rule: `openRun` here and lib/reaper.js's `openedRecord`
 * both call it, each with its own grace.
 *
 * DECIDED AT OPEN, because this is the only moment a previous run's fate is
 * knowable: the run that opened the row is not around to say it died. A prior
 * row that closed clears the count; one still open past `graceMs` adds to it;
 * one open and still inside its grace leaves it untouched, since it may yet
 * finish.
 *
 * THE GRACE IS AGED AGAINST `openedSince`, NOT `startedAt` (mantahostels#1999).
 * `startedAt` is overwritten on every open, so on a machine restarting a job
 * every few minutes — far closer together than the grace — a permanently dead
 * job never ages past its own grace: each reopen resets the clock its
 * successor will be judged against, and `deaths` sits at 0 forever.
 * `openedSince` is set once, on the first open after the last close, and
 * carried forward unchanged by every reopen until one closes, ages out, or
 * cannot be parsed — so it is the START of the unbroken run of opens, not the
 * most recent one, and a job stuck reopening keeps accumulating against it.
 *
 * AND ONLY ONCE PER GRACE WINDOW: the moment a death IS counted, `openedSince`
 * resets to `now`, opening a fresh window for the next grace to elapse before
 * another counts. Without that reset, every open past the first stale one
 * would count its own death — a burst of concurrent starts hitting an
 * already-wedged row would each add one, reaching the report threshold on
 * concurrency alone rather than elapsed time, which is exactly what the grace
 * exists to rule out (mantahostels#1999).
 * @param {{deaths?: unknown, openedSince?: string, finishedAt?: string} | undefined} prior
 * @param {number} graceMs
 * @param {number} now
 * @returns {{deaths: number, openedSince: string}}
 */
function deathCount(prior, graceMs, now) {
	let deaths = Number.isFinite(prior?.deaths) ? Number(prior?.deaths) : 0;
	let openedSince = new Date(now).toISOString();
	if (prior?.finishedAt) {
		deaths = 0;
	} else if (prior?.openedSince) {
		const sinceMs = Date.parse(prior.openedSince);
		// An unparseable stamp cannot be aged, so it cannot be told from a run in
		// flight and is left alone rather than counted either way.
		if (Number.isFinite(sinceMs)) {
			openedSince = prior.openedSince;
			if (now - sinceMs > graceMs) {
				deaths += 1;
				// Fresh window: this death is counted, so nothing past this point
				// re-counts the same staleness until another whole grace elapses.
				openedSince = new Date(now).toISOString();
			}
		}
	}
	return { deaths, openedSince };
}

/**
 * Opens this run's record and hands back its start half for `closeRun` to
 * close.
 *
 * CALLED BEFORE THE WORK, never after: a record opened after the slow step is
 * missing in exactly the case it exists for.
 *
 * THE PREVIOUS FINISH IS CARRIED FORWARD as `lastFinishedAt` and `finishedAt`
 * is cleared. Without that a reader could never see a healthy job at all — every
 * start reopens the row, so a `finishedAt` alone would be absent for the whole
 * of every run and present only between them.
 * @param {string} job
 * @param {number} [now]
 * @returns {RunRecord}
 */
function openRun(job, now = Date.now()) {
	const prior = readRuns()[job];
	const priorFinish = prior?.finishedAt || prior?.lastFinishedAt;
	const { deaths, openedSince } = deathCount(prior, INFLIGHT_MS, now);

	/** @type {RunRecord} */
	const record = {
		job,
		startedAt: new Date(now).toISOString(),
		openedSince,
		deaths,
	};
	if (priorFinish) record.lastFinishedAt = priorFinish;
	writeRuns(record);
	return record;
}

/**
 * Closes the record `openRun` opened.
 *
 * `ok` SAYS THE WORK RETURNED RATHER THAN THREW — never that it achieved
 * anything. A debt sweep that cannot reach GitHub returns `offline` and prints
 * its own SKIP, and that is `ok: true` here: the child ran and came back, which
 * is the whole question this file asks.
 *
 * A THROW STILL LEAVES A `finishedAt`, so the checker keys its finding on the
 * ABSENCE of one — a child that threw got further than one that was killed.
 * @param {RunRecord} record
 * @param {{ ok: boolean, error?: string, counts?: Record<string, number> }} outcome
 */
function closeRun(record, outcome) {
	/** @type {RunRecord} */
	const closed = {
		...record,
		finishedAt: new Date().toISOString(),
		ok: outcome.ok,
	};
	if (outcome.error) closed.error = outcome.error;
	if (outcome.counts) closed.counts = outcome.counts;
	writeRuns(closed);
}

/**
 * The single seam every production caller passes through, so a caller cannot
 * open a record without closing it — `openRun`/`closeRun` are exported
 * separately only because this file's own test drives them apart.
 *
 * RETHROWS. The record is instrumentation; it must not change what the child
 * does, and session-arbiter.js's top-level catch is still what logs the fault.
 * @template T
 * @param {string} job
 * @param {() => T} fn
 * @returns {T}
 */
function recordRun(job, fn) {
	const record = openRun(job);
	try {
		const out = fn();
		closeRun(record, { ok: true });
		return out;
	} catch (e) {
		closeRun(record, { ok: false, error: caught(e).message });
		throw e;
	}
}

module.exports = {
	DEATHS_TO_REPORT,
	JOBS,
	JOB_PRUNE_MARKERS,
	JOB_DEBT_SWEEP,
	JOB_RETIRE_STALE_CONTAINERS,
	RUN_FILE,
	closeRun,
	deathCount,
	openRun,
	recordRun,
};
