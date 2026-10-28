#!/usr/bin/env node
/*
 * replay-notify-reports.js — the synchronous half of persist-and-replay
 * (mantahostels#1976, the reader mantahostels#1949 specifies).
 *
 * Usage:
 *   node scripts/replay-notify-reports.js [--notify | --status] [--json]
 *
 * `--status` is `npm run status`'s view: only the reports a start holds back
 * (`HELD_FOR_STATUS`).
 *
 * The slow SessionStart producers are wired `async: true`, whose stdout the
 * harness discards, so each writes its finished report to a file instead
 * (lib/notify-report.js). This runs FIRST and SYNCHRONOUSLY at the next start,
 * reads every one of those files, and injects them — which is the only route
 * a report from a hook that took 34 s now takes to reach the session.
 *
 * A CHECKER WITHOUT THE `check-` PREFIX, deliberately (§G4). It is a member of
 * the family in every other respect — `runCheck` owns its argv, severity,
 * summary line and mantahostels#155 exit alphabet — but it checks nothing about the repo,
 * so `check-` would misname it.
 *
 * WHAT IT DECIDES, per producer:
 *   inject     a report whose text it has not shown before
 *   suppress   text already shown, or a delivery stamp saying the founder has
 *              already seen this exact finding (mantahostels#1975)
 *   stale      older than the report's own `maxAgeMs`, or 4 hours where it
 *              carries none — dropped, counted in one line
 *   silent     no NEW run for several starts AND long enough since the last
 *              report to rule out a healthy run still in flight (mantahostels#2327): a
 *              wedged producer, reported
 *   never-ran  wired at SessionStart, persisting, but with neither a report
 *              nor an open run on disk — a producer `notify.list()` cannot
 *              see at all, reported once it has had several starts and long
 *              enough to try (mantahostels#2284, mantahostels#2327)
 *   cancelled  an open run record whose process is gone
 *   unwired    a key left in the store by a producer the repo's hooks
 *              no longer wire as a persisting SessionStart one — its last
 *              report is still replayed while fresh, but no fault is ever
 *              raised about it, since nothing will run it again (mantahostels#2679)
 *
 * SUPPRESSION IS ON THE TEXT, SILENCE ON THE TIMESTAMP, and they have to be
 * two things (mantahostels#1976). A producer that runs at every start and prints the same
 * standing finding every time — the reaper with an un-stoppable session —
 * writes a new timestamp each start, so a timestamp-keyed
 * suppression would show it forever and a timestamp-keyed silence rule would
 * never fire.
 *
 * DELIVERY IS WHAT `--notify` MEANS HERE. Only a `--notify` run consumes what
 * it shows — recording the digest and applying the delivery stamps. A hand run
 * shows everything, stale and long-silent reports included, and records
 * nothing, so a session start's reports can be inspected without spending them
 * (mantahostels#1949 story 23).
 *
 * IMPLICIT:  reads the persisted report files at every session start and
 *            injects into the session whatever a slow async producer finished
 *            after the harness had stopped listening to it, bar the reports
 *            `isHeldForStatus` keeps for `npm run status`.
 * JUSTIFIED: fail-safe — it touches local files and nothing else, under
 *            --notify writing only its own shown-records, start count and
 *            delivery stamps, so it cannot inherit the cancellation it exists
 *            to repair (mantahostels#1949 story 15);
 *            the alternative is a finished report no session ever sees.
 * DEFEAT:    none at the hook. --notify shows and consumes only what is fresh
 *            and unshown, so a start with nothing outstanding is silent, and a
 *            hand run without it shows everything and records nothing.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/*
 * PERSIST MODE IS REFUSED, and unset rather than merely ignored: `persisting()`
 * reads the environment inside runCheck, and an inherited `WFC_NOTIFY_PERSIST`
 * would send this reader's own output to a report file for itself to read at the
 * NEXT start — the reader silently delivering nothing, forever. Unset here,
 * before check.js is required, so there is one moment to reason about.
 */
delete process.env.WFC_NOTIFY_PERSIST;

const { runCheck } = require("./lib/check");
const notify = require("./lib/notify-report.js");
const { delivered, recordDelivery } = require("./lib/delivery-stamp.js");
const {
	readSessionStartRoster: rosterOf,
	hasReadableHooks,
	KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
const { hostRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { isRepoChecksReport } = require("./lib/repo-checks-reading.js");
const { trimEndRun } = require("./lib/trim-run.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

/** This checker's own name, skipped in its own scan. */
const SELF = "replay-notify-reports";

/** The host repository (#1), whose hooks the roster reads — never the plugin
 * cache a `__dirname` would have named. */
const repoRoot = () => hostRoot();

/*
 * THE KEY, NOT THE PATH: every producer wired today files its report under
 * `runCheck`'s `name:` (or the reaper's own `CHECKER`), which is that script's
 * basename with a leading `check-` stripped — except `check-cleared-trackers.js`,
 * which keeps it. `KEY_OVERRIDES` is `lib/session-start-roster.js`'s own, not a local
 * copy (mantahostels#2366) — check-hook-liveness.js's census reads the same export, so the
 * two callers cannot drift.
 */

/**
 * Every checker the repo's hooks wire as a persisting SessionStart
 * producer — read fresh each run, not cached, so a hook added or removed
 * there is picked up at the next start with no restart of anything (mantahostels#2284).
 * Each entry carries the script basename alongside its derived key, so a
 * caller can point the founder at the file to run by hand.
 *
 * THE READ, THE PARSE, THE JOIN AND THE UNREADABLE-HOOKS POLICY ARE ALL
 * lib/session-start-roster.js's, not this file's own (mantahostels#2302) — no subprocess,
 * no directory walk, no second dependency on check-hook-liveness.js's
 * `hookPaths`, so the hot synchronous reader path does not inherit that
 * file's dependency tree, and an exec-form entry's `args` is read the one way
 * every JS reader now reads it, through `lib/rule-emission.js`'s shared
 * `buildHookCommandLine`/`WIRED_SCRIPT_RE`.
 * @returns {Array<{ key: string, script: string }>}
 */
function readSessionStartRoster() {
	return rosterOf(repoRoot(), { keyOverrides: KEY_OVERRIDES, self: SELF });
}

/*
 * THE ONE PRODUCER WHOSE CANCELLATION THIS READER DOES NOT NAME (mantahostels#1976).
 *
 * `reap-finished-sessions.js` keeps a run record of its own as well as
 * notify-report.js's, and its next run prints "the previous run started … and
 * never finished" as a line of the report this reader then injects. Both
 * describe one cancellation, so without this the founder reads it twice.
 *
 * THE READER YIELDS, NOT THE REAPER. The reaper's own cancellation line
 * (mantahostels#1920) has to keep working when nothing reads the persisted record at
 * all — a hand run, or a machine where persist mode was never wired.
 * Suppressing it there would cost the only report; suppressing this one
 * costs a start's timeliness, since the reaper's own line reaches the
 * founder one start later than this would. The `--json` envelope still
 * carries it, having no reader to say it twice to.
 *
 * The residual: a reaper cancelled at EVERY start never reaches its own print,
 * which sits inside `reap()` past the oracle read that keeps killing it, so
 * neither line fires. That chronic case is check-hook-liveness.js's
 * `reapAssertion`, which reads the `deaths` count mantahostels#1952 put in the reaper's own
 * row precisely for it.
 *
 * Spelled here rather than required: pulling the reaper in would cost this hot
 * synchronous path its whole dependency tree.
 */
const SELF_REPORTS_CANCELLATION = new Set(["reap-finished-sessions"]);

/*
 * REPORTS A SESSION START HOLDS BACK, for `npm run status` (#2038, re-ruling
 * #1553's delivery for the start only): no starting session acts on them. The
 * reap has already run; the reconcile deferral retries itself at the next exit;
 * the repo-checks findings also stand on their own tracker issue. Only their
 * text is held — a fault about the producer itself is still raised at start.
 */
const HELD_FOR_STATUS = new Set(["reap-finished-sessions", "reconcile-plugin"]);

/** @param {string} key */
const isHeldForStatus = (key) =>
	HELD_FOR_STATUS.has(key) || isRepoChecksReport(key);

/*
 * How many starts a producer may go without a new run before it is named as
 * wedged (mantahostels#1949 story 12). Three, so a single missed start — a producer that
 * lost one race with the machine — is not an alarm, while a permanently stuck
 * one surfaces inside a morning's work.
 *
 * COUNTED IN STARTS, NOT HOURS, deliberately: staleness below already carries
 * the clock, and the two answer different questions. Five starts in an hour is
 * a wedged producer; one start after a night away is not.
 */
const SILENT_STARTS = 3;

/*
 * A start count alone over-fires (mantahostels#2327): parallel background jobs start
 * several sessions inside a minute, so SILENT_STARTS starts can land inside
 * one run of a perfectly healthy producer, and the staleness check above
 * does not catch it — a report this young looks exactly like a false alarm,
 * not a stale one. WEDGED now also needs the last report to be older than a
 * multiple of ITS OWN measured run time, so a slow producer earns a wider
 * berth than a fast one.
 *
 * The fallback below is twice check-cleared-trackers's worst measured run,
 * the slowest producer measured to date (mantahostels#2327). It applies wherever a
 * producer has no measured duration of its own — an old report predating
 * durationMs, or a never-ran roster member with no report at all.
 *
 * WHY ×2 AND NOT SOME OTHER MULTIPLE (mantahostels#2342): unmeasured — no producer here
 * has its run time sampled more than once, so there is no variance to size a
 * margin against. ×2 is the smallest round multiple that clears the actual
 * regression this margin exists to fix — mantahostels#2327's false alarm, a 72s-old
 * report against check-cleared-trackers's ~65.3s worst measured run (72 /
 * 65.3 ≈ 1.10, so any multiple at or above 2 clears it) — without giving a
 * permanently stuck producer an unreasonably long berth before it is named.
 */
const SILENT_AGE_MARGIN = 2;
const SILENT_AGE_FLOOR_MS = SILENT_AGE_MARGIN * 65_300;

/*
 * A producer's own `durationMs` is one sample, not a distribution — its last
 * run may have short-circuited (nothing to check, a cache hit) and finished
 * far faster than its ordinary pass, which would otherwise hand that
 * producer a margin too short to survive the very clustering mantahostels#2327 was filed
 * over: several session starts landing inside one of its normal-length runs.
 * A reading this far under any producer measured to date is more likely a
 * fluke than a genuine ordinary run, so below it `durationMs` is not trusted
 * at all — the reader falls back to SILENT_AGE_FLOOR_MS exactly as it would
 * for a producer with no measured duration. Unmeasured, like the margin
 * above.
 *
 * RESIDUAL (mantahostels#2342): the guarantee is only that under a 1s reading. A
 * short-circuit landing above the threshold — check-cleared-trackers, whose
 * only measured duration is 65.3s, finishing in 3s instead — is still
 * trusted, earns a 6s margin, and a 72s-old report against it reproduces
 * mantahostels#2327's exact false alarm. The live-open-run check below narrows that gap
 * to the window where no run record is live either — not yet opened, or
 * already cleaned up.
 */
const MIN_PLAUSIBLE_DURATION_MS = 1000;

/**
 * The wall-clock age a report must clear before its start count may call it
 * wedged.
 * @param {number|null} durationMs
 */
const silentAgeFloor = (durationMs) =>
	durationMs !== null && durationMs >= MIN_PLAUSIBLE_DURATION_MS
		? durationMs * SILENT_AGE_MARGIN
		: SILENT_AGE_FLOOR_MS;

/**
 * @typedef {{ at: string, start: number, digest: string }} Shown what this
 *   reader last saw of one producer: the timestamp and start number of its
 *   last NEW run, and the digest of the last text actually shown
 */

/**
 * ONE FILE PER CHECKER, like the delivery stamps and for the same reason: two
 * sessions can start at once, and a single shared map would have the later
 * writer's copy replace the earlier's — re-showing a report already injected
 * into the other session.
 * @param {string} checker
 */
const shownFile = (checker) =>
	path.join(
		notify.base(),
		`${checker.replace(/[^A-Za-z0-9_-]/g, "-")}.shown.json`,
	);

/** The count of starts this reader has served; its own file, for the reason above. */
const startsFile = () => path.join(notify.base(), "replay-starts.json");

/**
 * What was last shown of `checker`, or null where nothing was — never written,
 * or too mangled to trust. Unreadable reads as never-shown: the cost is a
 * report repeated once, never a report lost.
 * @param {string} checker
 * @returns {Shown|null}
 */
function readShown(checker) {
	const raw = notify.readJSON(shownFile(checker));
	if (!raw || typeof raw.at !== "string") return null;
	return {
		at: raw.at,
		start: Number.isFinite(raw.start) ? Number(raw.start) : 0,
		digest: typeof raw.digest === "string" ? raw.digest : "",
	};
}

/**
 * How many starts this reader has served, counting this one, and the write
 * that lands it.
 *
 * A LOST UPDATE COSTS ONE START OF THE SILENCE COUNT and nothing else: two
 * sessions starting in the same instant both write the same number, so a
 * wedged producer is named at the fourth start rather than the third. Locking
 * a counter inside a hook that must never block is the wrong trade.
 */
function bumpStarts() {
	const raw = notify.readJSON(startsFile());
	const starts = (Number.isFinite(raw?.starts) ? Number(raw.starts) : 0) + 1;
	return {
		starts,
		write: () => notify.atomicWriteJSON(startsFile(), { starts }),
	};
}

/**
 * An age a person reads at a glance. Rounded, and never more precise than the
 * quantity deserves — the founder is deciding whether a reading is current,
 * not measuring it.
 * @param {number|null} ms
 */
const humanAge = (ms) => {
	if (ms === null) return "of an unreadable date";
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
};

/**
 * Enough of a hash to tell two reports apart; nothing here is adversarial.
 * @param {string} text
 */
const digestOf = (text) =>
	crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

/** @typedef {import("./lib/notify-report.js").Report} Report */

/**
 * @typedef {{
 *   ctx: Ctx,
 *   now: number,
 *   delivering: boolean,
 *   spending: boolean,
 *   startNo: number,
 *   gated: (key: string) => boolean,
 *   record: [string, Shown][],
 *   blocks: string[],
 *   injected: { checker: string, outcome: Report["outcome"], age: number|null }[],
 *   stale: { checker: string, age: number|null }[],
 *   silent: { checker: string, starts: number, age: number|null }[],
 *   neverRan: { checker: string, starts: number }[],
 *   unreadable: string[],
 *   cancelled: { checker: string, startedAt: string }[],
 * }} Pass `record` is
 *   deferred to the end of the pass, so a partial run records nothing;
 *   `blocks` are report blocks, held back so every one prints above this
 *   reader's own faults.
 */

/**
 * @typedef {{
 *   name: string,
 *   age: number|null,
 *   digest: string,
 *   shown: Shown|null,
 *   next: Shown,
 *   empty: boolean,
 *   silentFor: number,
 * }} Reading what this pass makes of one producer's persisted report
 */

/*
 * WHAT THE REPO'S HOOKS WIRE TODAY, read once per pass — the
 * gate on every fault this reader raises about a producer (mantahostels#2679).
 *
 * A FAULT IS ABOUT A PRODUCER THAT IS SUPPOSED TO RUN, and nothing
 * refreshes or removes an unwired one's files, so ungated it repeats at
 * every start forever. WEDGED, the
 * stale count, UNREADABLE and CANCELLED all say a wired producer failed
 * to deliver; none of them means anything of one nothing invokes.
 * INJECTION is NOT gated: a finding written just before the hook was
 * removed still reached nobody, and staleness retires it on its own
 * clock.
 *
 * SKIPPED SILENTLY AT A SESSION START, NAMED ON A HAND RUN — the same
 * split a held (wedged or stale) report already takes in `alreadyShown`
 * and `inject`, called from replayKey below. A one-shot `UNWIRED`
 * finding was the alternative and was not taken: it needs its own
 * persisted "already said" record, and the founder who unwires a hook
 * is the one person who does not need telling.
 *
 * THE GATE FAILS OPEN, NEVER SILENT. A hooks file that is absent at the
 * core or half-written anywhere comes back from `readSessionStartRoster()` as an
 * empty roster, indistinguishable from a repo that wires no persisting
 * producer at all — and read as fact it would mark every producer
 * unwired and suppress every fault for that start. So `rosterKnown`
 * false gates nothing: the reader reverts to judging off the store
 * alone, which over-reports rather than going quiet.
 *
 * RESIDUAL: a producer RENAMED rather than unwired reads as unwired
 * under its old key until that key's files are deleted.
 */
function readGate() {
	const rosterKnown = hasReadableHooks(repoRoot());
	const roster = readSessionStartRoster();
	const wired = new Set(roster.map((r) => r.key));
	/**
	 * True where this key is one a fault may be raised about.
	 * @param {string} key
	 */
	const gated = (key) => !rosterKnown || wired.has(key);
	/* Read off the store rather than pushed from the report loop below, so
	 * a key whose only file is a leftover `.run.json` — or a `.report.json`
	 * that will not parse — is counted too. */
	const unwired = rosterKnown
		? notify
				.list()
				/* repo-checks.js's daily report, one per repo: refreshed by the
				 * session-start launcher's detached job, never by a hook of its
				 * own, so it is not unwired, and not gated either — a once-a-day
				 * producer would read as WEDGED (#1553). */
				.filter((k) => k !== SELF && !wired.has(k) && !isRepoChecksReport(k))
		: [];
	return { roster, gated, unwired };
}

/**
 * @param {Pass} pass accumulator: record is filled, and its helpers fill the rest
 * @param {string} key
 */
function replayKey(pass, key) {
	const report = notify.readReport(key);
	if (!report) {
		noteUnreadable(pass, key);
		return;
	}
	const r = readingOf(pass, key, report);
	const wedged = isWedged(pass, key, report, r);
	const tooOld = notify.isStale(
		report,
		report.maxAgeMs ?? notify.DEFAULT_STALE_MS,
		pass.now,
	);
	flagSilence(pass, key, r, { wedged, tooOld });
	const heldAtStart = pass.ctx.notify && isHeldForStatus(key);
	pass.record.push([
		key,
		heldAtStart ? r.next : offer(pass, report, r, heldAs(wedged, tooOld)),
	]);
}

/**
 * Injects the report unless it is empty or a start has shown it already.
 * @param {Pass} pass accumulator: inject fills injected and blocks; delivering is read
 * @param {Report} report
 * @param {Reading} r
 * @param {"wedged" | "stale" | null} held
 * @returns {Shown} what to record for the next start
 */
function offer(pass, report, r, held) {
	if (r.empty) return r.next;

	/* A hand run is a diagnosis, so it shows what a start would have
	 * dropped — marked, never passed off as current. */
	const stamps = stampsOf(report, r.name);
	if (pass.delivering && alreadyShown(held, r, stamps)) return r.next;
	return inject(pass, report, r, { held, stamps });
}

/**
 * @param {Pass} pass accumulator: unreadable is filled; gated and ctx are read
 * @param {string} key
 */
function noteUnreadable(pass, key) {
	/* A key with a run record and no report is a producer part-way
	 * through its first run — not a fault. A report file that IS there
	 * and will not parse is one. */
	if (pass.gated(key) && fs.existsSync(notify.reportFile(key))) {
		pass.unreadable.push(key);
		pass.ctx.warn(
			"UNREADABLE",
			`${key}'s persisted report will not parse — its findings are lost for this start.`,
			{ checker: key },
		);
	}
}

/**
 * @param {Pass} pass
 * @param {string} key
 * @param {Report} report
 * @returns {Reading}
 */
function readingOf(pass, key, report) {
	/* The report's own field rather than the filename: `list()` hands back
	 * the slug, which differs wherever a checker's name carries a character
	 * a filename could not. */
	const name = report.checker || key;
	const age = notify.ageMs(report, pass.now);
	const digest = digestOf(report.text);
	const shown = readShown(key);
	const lastRun =
		shown === null || shown.at !== report.at ? pass.startNo : shown.start;
	/** What to leave on disk for the next start, if this run is the delivery. */
	const next = {
		at: report.at,
		start: lastRun,
		digest: shown?.digest ?? "",
	};
	/* Nothing to say, and it said so: an OK run persists an empty text
	 * precisely so this is distinguishable from never having run. Read ahead
	 * of staleness in `flagSilence`, or a producer quiet since this morning is counted
	 * among the reports dropped for being too old to show. */
	const empty = !report.text.trim();
	return {
		name,
		age,
		digest,
		shown,
		next,
		empty,
		silentFor: pass.startNo - lastRun,
	};
}

/**
 * @param {Pass} pass
 * @param {string} key
 * @param {Report} report
 * @param {Reading} r
 */
function isWedged(pass, key, report, r) {
	/* WEDGED is judged off the last COMPLETED report and has no other
	 * route to see a run in progress right now, so it must check the
	 * open-run record itself (mantahostels#2342) — narrower than NEVER-RAN's
	 * `present.has(key)` below, which skips on ANY run record, dead
	 * ones included: a cancelled record must not suppress WEDGED, since
	 * that is the very finding it would otherwise permanently hide.
	 *
	 * RESIDUAL: `isCancelled` is dead-PROCESS detection only
	 * (notify-report.js's `holderAlive`) — a producer whose process is
	 * alive but hung stays `hasLiveRun` forever, so it is never named
	 * WEDGED (suppressed here) and never CANCELLED (its process still
	 * lives). Accepted because an `async: true` SessionStart hook's
	 * process does not outlive its session in the ordinary case; a
	 * reparented survivor (docs/agents/guard-registry.md §Conventions, mantahostels#2012/mantahostels#2042) is the
	 * shape that would break it, and nothing here measures whether one
	 * of these hooks specifically can produce one. */
	const openRun = notify.readRun(key);
	const hasLiveRun = openRun !== null && !notify.isCancelled(openRun);
	/* An unparseable `at` can't prove the report is fresh, so `age === null`
	 * falls back to the count alone here — the same direction notify.isStale
	 * already takes with a bad timestamp. */
	return (
		pass.gated(key) &&
		!hasLiveRun &&
		r.silentFor >= SILENT_STARTS &&
		(r.age === null || r.age >= silentAgeFloor(report.durationMs))
	);
}

/**
 * @param {Pass} pass accumulator: silent and stale are filled; gated and ctx are read
 * @param {string} key
 * @param {Reading} r
 * @param {{ wedged: boolean, tooOld: boolean }} verdict
 */
function flagSilence(pass, key, r, { wedged, tooOld }) {
	if (wedged) {
		pass.silent.push({ checker: r.name, starts: r.silentFor, age: r.age });
		pass.ctx.warn(
			"SILENT",
			`${r.name} has not finished a run for ${r.silentFor} session starts — ` +
				`its last report is ${humanAge(r.age)}. A producer wedged at every ` +
				"start reads as nothing to say; run it by hand to see what it is stuck on.",
			{ checker: r.name, starts: r.silentFor },
		);
	} else if (
		tooOld &&
		!r.empty &&
		pass.gated(key) &&
		!(pass.ctx.notify && isHeldForStatus(key))
	) {
		/* Dropped rather than shown: a CI verdict from this morning
		 * presented as current is worse than no verdict (mantahostels#1949 story 18).
		 * Not a finding — the ordinary first start of a day drops every
		 * report at once. */
		pass.stale.push({ checker: r.name, age: r.age });
	}
}

/**
 * @param {boolean} wedged
 * @param {boolean} tooOld
 * @returns {"wedged" | "stale" | null}
 */
function heldAs(wedged, tooOld) {
	if (wedged) return "wedged";
	if (tooOld) return "stale";
	return null;
}

/**
 * @param {Report} report
 * @param {string} name
 */
function stampsOf(report, name) {
	/* The producer's own `stamp` (this checker's one signature, under its
	 * own name) merged with `stamps` (any further signature under a name of
	 * its own — check-hook-liveness.js's eight assertions,
	 * check-guard-errors.js's INERT warning). One map, one code path: a
	 * single-stamp checker's map has exactly the one entry it always had
	 * (mantahostels#1975); a multi-stamp checker's map has all of them (mantahostels#2277). Keyed on
	 * its OWN name, never `name` — writing all of them under the producer's
	 * report key would let one assertion's signature suppress another's.
	 * `stamps` wins a collision with `[name]`: no producer today names one
	 * of its `stamps` entries after its own report key, so this never
	 * fires, but a checker that ever did would mean its `stamps` value. */
	const stampMap = {
		...(report.stamp && { [name]: report.stamp }),
		...report.stamps,
	};
	return Object.entries(stampMap);
}

/**
 * @param {"wedged" | "stale" | null} held
 * @param {Reading} r
 * @param {[string, string][]} stamps
 */
function alreadyShown(held, r, stamps) {
	if (held) return true;
	if (r.digest === r.shown?.digest) return true; // this text has been shown
	/* THE STAMPS ARE A FINER GATE THAN THE DIGEST. check-hook-liveness.js's
	 * scan-progress narration ("N of M transcript files accounted for")
	 * differs run to run even where the failing set does not, so the digest
	 * above cannot suppress a standing condition on its own — that is what
	 * the producer's per-assertion stamps exist to do (mantahostels#2277). Only where
	 * EVERY entry is already delivered is there truly nothing new; a
	 * checker carrying no stamp at all (a report made of findings none of
	 * which stamp, such as GUARD-LIBRARY) has an empty map here and falls
	 * through to injecting, gated by the digest check above alone. */
	return stamps.length > 0 && stamps.every(([k, stamp]) => delivered(k, stamp));
}

/**
 * @param {Pass} pass accumulator: injected and blocks are filled; spending is read
 * @param {Report} report
 * @param {Reading} r
 * @param {{ held: "wedged" | "stale" | null, stamps: [string, string][] }} display
 * @returns {Shown} `r.next`, carrying this report's digest
 */
function inject(pass, report, r, { held, stamps }) {
	pass.injected.push({ checker: r.name, outcome: report.outcome, age: r.age });
	pass.blocks.push(
		`▸ ${r.name} — ${humanAge(r.age)}` +
			`${held ? ` (${held}: a session start would not be shown this)` : ""}\n` +
			trimEndRun(report.text, "\n"),
	);
	/* The producer carried its once-only signature(s) rather than applying
	 * them, so this — the delivery — is where they are spent (mantahostels#1975, mantahostels#2277). */
	if (pass.spending) for (const [k, stamp] of stamps) recordDelivery(k, stamp);
	return { ...r.next, digest: r.digest };
}

/**
 * NEVER-RAN: a wired producer with no report and no open run.
 * Counted the same way as a wedged producer, off its own first-seen
 * start rather than a report's `at`, since there is no report to
 * carry one. That wall clock is captured the first time this key is
 * seen and held fixed from then on, so the same age floor as WEDGED
 * applies here too — a never-ran producer with no measured duration
 * of its own gets the fallback floor (mantahostels#2327).
 *
 * @param {Pass} pass accumulator: record and neverRan are filled; the rest is read
 * @param {{ key: string, script: string }} entry
 */
function checkNeverRan(pass, { key, script }) {
	const shown = readShown(key);
	const firstSeen = shown?.start ?? pass.startNo;
	const firstSeenAt = shown?.at ?? new Date(pass.now).toISOString();
	const silentFor = pass.startNo - firstSeen;
	pass.record.push([
		key,
		{ at: firstSeenAt, start: firstSeen, digest: shown?.digest ?? "" },
	]);
	if (silentFor < SILENT_STARTS) return;
	const firstSeenMs = Date.parse(firstSeenAt);
	const firstSeenAge = Number.isNaN(firstSeenMs)
		? null
		: pass.now - firstSeenMs;
	if (firstSeenAge !== null && firstSeenAge < SILENT_AGE_FLOOR_MS) return;
	pass.neverRan.push({ checker: key, starts: silentFor });
	pass.ctx.warn(
		"NEVER-RAN",
		`${key} is wired at SessionStart as a persisting producer but has ` +
			`never written a report or an open run, across ${silentFor} ` +
			"session starts — it may be wedged before its first openRun, or " +
			"misnamed against notify-report.js's checker key; run " +
			`\`node scripts/${script} --notify\` by hand to see what it does.`,
		{ checker: key, starts: silentFor },
	);
}

/**
 * @param {Pass} pass accumulator: cancelled is filled; gated, now and ctx are read
 * @param {string} key
 */
function checkCancelled(pass, key) {
	const run = notify.readRun(key);
	/* Nothing open is not a cancellation, and a record whose process is
	 * still alive is a producer mid-run. */
	if (!run || !notify.isCancelled(run)) return;
	if (!pass.gated(key)) return;
	const name = run.checker || key;
	pass.cancelled.push({ checker: name, startedAt: run.startedAt });
	if (SELF_REPORTS_CANCELLATION.has(key)) return;
	/* Parsed here rather than through ageMs(), whose argument is a report:
	 * an open run record carries a start, not a finish. */
	const opened = Date.parse(run.startedAt);
	/* THE CAUSE IS ALWAYS A DEAD PROCESS, NEVER A TIMEOUT, so this text
	 * must never send a reader after the ceiling in the hook's registration
	 * — on an `async` entry that number does nothing (mantahostels#2331,
	 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md). */
	pass.ctx.warn(
		"CANCELLED",
		`${name} was cut off mid-run — it opened at ${run.startedAt}` +
			`${Number.isNaN(opened) ? "" : ` (${humanAge(Math.max(0, pass.now - opened))})`}` +
			" and its process is gone, so whatever it would have reported was never written.",
		{ checker: name, startedAt: run.startedAt },
	);
}

/**
 * @param {Ctx} ctx
 * @param {[string, Shown][]} record
 * @param {() => unknown} writeStarts
 */
function persistShown(ctx, record, writeStarts) {
	let unrecorded = 0;
	for (const [key, next] of record)
		if (!notify.atomicWriteJSON(shownFile(key), next)) unrecorded += 1;
	writeStarts();
	/* SAID, NOT SWALLOWED (§N5). Every other failure in this family costs
	 * one report; this one costs suppression itself, so every report
	 * repeats at every start and no producer is ever named as wedged. */
	if (unrecorded)
		ctx.warn(
			"UNRECORDED",
			`${unrecorded} of ${record.length} shown-records could not be written under ` +
				`${notify.base()} — until that directory takes a write again, every ` +
				"report repeats at every start and no wedged producer is named.",
			{ count: unrecorded },
		);
}

/**
 * @param {Ctx} ctx
 * @param {Pass} pass
 * @param {string[]} unwired
 */
function printSummary(ctx, { blocks, stale }, unwired) {
	for (const block of blocks) {
		ctx.say(block);
		ctx.say("");
	}
	for (const f of ctx.findings) ctx.say(f.message);
	if (stale.length > 0)
		ctx.say(
			`${stale.length} report(s) dropped as stale, the oldest ` +
				`${humanAge(Math.max(...stale.map((s) => s.age ?? 0)))}: ` +
				`${stale.map((s) => s.checker).join(", ")}. ` +
				"Each refreshes when its own producer finishes this start.",
		);
	if (!ctx.notify && unwired.length > 0)
		ctx.say(
			`${unwired.length} key(s) in the store that the repo's hooks do not ` +
				`wire as a persisting SessionStart producer: ${unwired.join(", ")}. ` +
				"No fault is raised about these and none can refresh; delete each " +
				`one's .report.json, .run.json and .shown.json under ${notify.base()} ` +
				"to drop it for good.",
		);
}

/**
 * @param {Pick<Pass, "ctx" | "delivering" | "spending" | "startNo" | "gated">} given
 * @returns {Pass}
 */
const newPass = (given) => ({
	...given,
	now: Date.now(),
	record: [],
	blocks: [],
	injected: [],
	stale: [],
	silent: [],
	neverRan: [],
	unreadable: [],
	cancelled: [],
});

/**
 * `--status`: the held-back reports alone, recording nothing, and none of the
 * producer faults a start already raises.
 * @param {Ctx} ctx
 */
function statusView(ctx) {
	if (ctx.notify) ctx.usageError("--status is a hand run; drop --notify.");
	/* Shows every held report, but spends its once-only stamps: no start
	 * delivers a held report, so without this a repo-checks reading would
	 * name every held key as new, forever. */
	const pass = newPass({
		ctx,
		delivering: false,
		spending: !ctx.asJson,
		startNo: bumpStarts().starts,
		gated: () => false,
	});
	for (const key of notify.list().filter(isHeldForStatus)) replayKey(pass, key);
	for (const block of pass.blocks) {
		ctx.say(block);
		ctx.say("");
	}
	/* A WARN, or `npm run status` folds the blocks away as clean. */
	for (const { checker, age } of pass.injected)
		ctx.warn("HELD", `${checker} reported ${humanAge(age)}.`, { checker });
	return {
		okLine: "no held-back report on disk.",
		noun: "held-back report(s)",
		data: { injected: pass.injected },
	};
}

runCheck({
	name: SELF,
	usage: `node ${scriptPath("replay-notify-reports.js")} [--notify | --status] [--json]`,
	flags: ["--status"],
	run(/** @type {Ctx} */ ctx) {
		if (ctx.has("--status")) return statusView(ctx);
		/* Only a --notify run is the delivery, so only it spends what it shows.
		 * `--json` is excluded because say() prints nothing under it: nothing
		 * reached anybody, so nothing may be marked as having done. */
		const delivering = ctx.notify && !ctx.asJson;
		const { starts: startNo, write: writeStarts } = bumpStarts();

		const { roster, gated, unwired } = readGate();
		const pass = newPass({
			ctx,
			delivering,
			spending: delivering,
			startNo,
			gated,
		});

		for (const key of notify.list()) {
			if (key === SELF) continue;
			replayKey(pass, key);
		}

		const present = new Set(notify.list());
		for (const entry of roster) {
			if (present.has(entry.key)) continue;
			checkNeverRan(pass, entry);
		}

		for (const key of notify.list()) {
			if (key === SELF) continue;
			checkCancelled(pass, key);
		}

		if (delivering) persistShown(ctx, pass.record, writeStarts);

		printSummary(ctx, pass, unwired);

		const { injected, stale, silent, neverRan, unreadable, cancelled } = pass;
		const data = {
			injected,
			stale,
			silent,
			neverRan,
			unreadable,
			cancelled,
			unwired,
		};
		if (ctx.findings.length > 0) return { noun: "producer fault(s)", data };
		return {
			okLine:
				injected.length > 0
					? `${injected.length} report(s) replayed.`
					: "no persisted reports outstanding.",
			data,
		};
	},
});
