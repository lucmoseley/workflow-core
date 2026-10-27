#!/usr/bin/env node
/*
 * check-hook-liveness.js — report a hook that is WIRED and does not RUN.
 *
 * check-guard-registry.js asserts that a guard named in CLAUDE.md exists and is
 * wired; this asks whether the wiring fires (mantahostels#1898, decided at mantahostels#1895).
 *
 * ASSERTION 1 — census (--notify). Per hook, the transcript records that say it
 * was cancelled or errored, against the ones that say it succeeded. A hook whose
 * failures dominate is reported.
 *
 * ASSERTION 2 — manifest (--notify). A plugin's CACHED hooks.json against the
 * marketplace's copy of the same file. The runtime reads the cache copy, and an
 * empty `{"hooks": {}}` there is not an error path in the binary — so a plugin
 * can be enabled, present, cached and wire nothing, silently (mantahostels#1892). For
 * each plugin enabled for this repo (user, project or local settings), also diffs the two
 * manifests hook-by-hook (a hook wired upstream and absent from the cache is
 * DROPPED IN PACKAGING) and applies assertion 4's own path/executable audit to
 * ${CLAUDE_PLUGIN_ROOT}-rooted commands in the cache (mantahostels#3515 F9). The
 * marketplace side accepts a `directory` source too, which is never cloned
 * under `plugins/marketplaces/<name>/` (`resolveMarketplaceDir`).
 *
 * ASSERTION 3 — reap record (--notify). `~/.claude/wfc-reap-run.json`, which
 * scripts/reap-finished-sessions.js writes at every run. A row with a start
 * stamp and no finish stamp is a reap that died mid-run — caught here for the
 * `dry` mode, which is not reopened every session start and so can genuinely
 * age past its grace while dead. The `live` mode is reopened at every start
 * regardless of whether the previous attempt closed, so a single read of it
 * can never be old enough to call dead; `deaths`, which
 * scripts/lib/reaper.js's `openedRecord` carries forward across
 * reopens, is what makes a `live` mode cancelled at consecutive starts visible
 * here instead (mantahostels#1952 — reapAssertion's own docstring carries the account).
 *
 * ASSERTION 4 — self-plugin (.husky/pre-commit). Every script path in the
 * file this repo registers its own hooks in — `self-plugin/hooks/hooks.json`
 * at the core, `.claude/settings.json` at an adopter (lib/core-hooks.js
 * `readOwnHooks`, workflow-core#2442) — in a hook's `command` or in its exec-form `args`
 * (mantahostels#2106) resolves to a file that exists and, where it is invoked directly
 * rather than through `node` or as another script's argument (workflow-core#83), is executable.
 *
 * ASSERTION 5 — detached children (--notify). `~/.claude/wfc-detached-run.json`,
 * which scripts/lib/detached-run.js writes for the three session-start jobs that
 * are spawned DETACHED — `prune-markers`, `debt sweep` and
 * `retire-stale-containers.js`, which assertion 1 cannot see. Only a count of
 * consecutive starts at which the job opened a record and never closed it can
 * (mantahostels#1910).
 *
 * WHY THE SURFACES DIFFER. 1, 2, 3 and 5 read ~/.claude, which exists only on the
 * machine the sessions ran on; a CI runner would find an empty corpus and report
 * all-clear forever.
 * 4 is repo-only, so it is free in pre-commit and gates there.
 *
 * NOTHING HERE ASSERTS ON THE ABSENCE OF A RECORD. An ordinary silent pass
 * leaves none at all (mantahostels#1895), so a hook with no records is never a finding.
 *
 * THE CENSUS KEYS ON THE RECORD'S OWN `.command`, NEVER ON A SCRIPT NAME FOUND
 * ANYWHERE IN THE RECORD. A hook's payload names other guards in its prose, and
 * a scan not keyed to `.command` counts those mentions as invocations (mantahostels#1893).
 * The exec form needs nothing here: the harness writes that record's `.command`
 * as `command` plus `args` joined by a space, so two registrations of one
 * script stay in distinct buckets however they are spelled (measured at mantahostels#2059,
 * left unchanged at mantahostels#2106).
 *
 * THE CENSUS IS BLIND IN BOTH DIRECTIONS, AND NEITHER GAP IS A FINDING (mantahostels#2296).
 * Keying on `.command` drops every record that carries none, and a PostToolUse
 * CANCELLATION carries none, so no PostToolUse hook is ever visible to
 * assertion 1 as a cancelled one, however often it is killed. Only
 * cancellations: a `hook_non_blocking_error` on the same event does carry its
 * command and is counted normally.
 * In the other direction a hook that prints nothing on success writes no
 * success record, so a hook that also never errors has an EMPTY tally rather
 * than a clean one — the post-write and scan-injection cores of
 * scripts/guard-dispatch.js both sit there. That is not the same as being unreportable: the
 * ZERO_SUCCESS_SESSION_RATE branch below exists to report a zero-success hook
 * off its failure records alone.
 *
 * A THIRD BLIND SPOT, NAMED RATHER THAN CLOSED (mantahostels#2366): a SessionStart hook
 * wired `async: true` writes no `hook_success` or `hook_cancelled` record at
 * all, ever — every persisting producer mantahostels#1949 built is wired this way today,
 * so the census can never see one fail OR succeed. Growing a second oracle
 * here was declined; instead the census names the roster it cannot cover and
 * points at scripts/replay-notify-reports.js, which reads notify-report.js's
 * own run/report files for exactly these.
 *
 * THE ROSTER IS KEYED ON PERSISTING (`WFC_NOTIFY_PERSIST=1`), NOT ON
 * `async`, because persisting is what makes replay-notify-reports.js able to
 * cover a producer at all — `async` is only why one needs covering. The two
 * coincide for every producer wired today, but do not have to: a future
 * SessionStart hook wired `async: true` without persisting would reproduce
 * this exact blind spot, unnamed by this census AND uncovered by that
 * reader, and a persisting hook that is not async would be named here
 * though the census could in principle see it.
 *
 * Under --notify every outcome exits 0, BROKEN included (mantahostels#155 — the checker
 * family's exit-code and severity model).
 *
 * THREE RESIDUALS, all in the census. A hook is keyed on its whole command
 * string, so editing that command starts a fresh tally and re-announces a hook
 * already reported. The window admits any calendar day it overlaps, so counts
 * near the edge run slightly wide. And a subagent transcript is reached only
 * through a parent whose own file moved inside the window.
 *
 * IMPLICIT:  on `npm run status` (lifted off SessionStart into scripts/status-report.js), censuses the retained transcripts and the plugin hook cache, reads the reaper's own run record, and reports any hook that is wired but failing, wiring nothing, or dead mid-run; separately, `.husky/pre-commit` runs assertion 4 alone, via `--only self-plugin`.
 * JUSTIFIED: fail-safe — a hook that never runs is indistinguishable from one that ran and found nothing, so silence is the failure mode.
 * DEFEAT:    none; --notify is silent while no hook is failing and no cached manifest has diverged.
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDirs, stateDir } = require("./lib/arbiter-store");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const detachedRun = require("./lib/detached-run.js");
const { REAP_LIVE_DEATHS_TO_REPORT } = require("./reap-finished-sessions.js");
const { runCheck } = require("./lib/check");
const { projectSlug: slugFor } = require("./lib/project-slug.js");
const {
	readSessionStartRoster,
	KEY_OVERRIDES: ROSTER_KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
/* The rule lib/notify-report.js resolves its directory by too, so an unwritable
 * store sends both to the same fallback config dir (mantahostels#1997). */
const { pinnedOrFirstUsable } = require("./lib/can-hold-state.js");
const deliveryStamp = require("./lib/delivery-stamp");
const { hostRoot } = require("./lib/host-root.js");
const { resolveMarketplace } = require("./lib/plugin-state.js");
const { caught } = require("./lib/caught.js");
const { flattenHooks, readOwnHookSources } = require("./lib/core-hooks.js");
const { spawnGitSync } = require("./lib/git.js");

/** Resolved once: pinnedOrFirstUsable() stats, and statePath is called per assertion. */
let stateBaseMemo = "";

/**
 * Where this checker's census cache lives: the arbiter's pinned store
 * (`stateDir()`, the first seat's, workflow-core#383), one for the machine whichever plan
 * runs it, so the cold scan is paid once over the shared corpus (workflow-core#385). Where
 * the store cannot be written, `pinnedOrFirstUsable`'s fallback keeps the cache
 * sticking rather than rescanning every run (mantahostels#1912).
 *
 * @param {string} name
 */
function statePath(name) {
	if (!stateBaseMemo) {
		stateBaseMemo = pinnedOrFirstUsable(
			stateDir(),
			configDirs().map((cfg) => path.join(cfg, "projects", projectSlug())),
		);
	}
	return path.join(stateBaseMemo, name);
}

/** The repo whose hooks are the subject. */
const repoRoot = () => hostRoot();

/**
 * How a project's transcript directory is spelled under a config dir
 * (lib/project-slug.js `projectSlug`, which owns the rule and its residual).
 *
 * ONE SPELLING, FOR THE CORPUS AND FOR THE STATE PATH BESIDE IT (mantahostels#1963). That
 * puts the census cache INSIDE the directory it describes, so a corpus that is
 * deleted takes it along.
 */
const projectSlug = () => slugFor(repoRoot());

/*
 * TWO TESTS, BECAUSE A HOOK SILENT ON SUCCESS RECORDS NO SUCCESS. The harness
 * writes hook_success only where the hook produced output, so a guard that
 * allows quietly has a permanent zero on the success side and no denominator of
 * its own. A hook that DOES record successes is judged on the ratio; one that
 * records none is judged on how many of the SESSIONS SCANNED it failed in.
 *
 * Sessions is the honest denominator for the silent case. A SessionStart hook
 * fires exactly once per session, so its session failure rate IS its failure
 * probability; a PreToolUse guard fires many times per session, so the same rate
 * is a floor far below its true one and it takes proportionally more to reach
 * the threshold. That asymmetry is what the rate buys and an absolute count
 * cannot, and it holds as --days moves, numerator and denominator scaling
 * together (mantahostels#1898).
 */
const MIN_FAILURES = 5;
const ZERO_SUCCESS_SESSION_RATE = 0.005;

/* Cache entries older than this are dropped, independent of --days, so a wider
 * window than the last run's still finds most of its files already counted. It
 * also bounds the enumeration: a session directory whose own transcript last
 * moved before this is never descended into for its subagents. */
const CACHE_RETENTION_DAYS = 7;

/*
 * A COLD SCAN IS ABANDONED, NEVER FINISHED LATE. Reading the 2-day corpus whole
 * takes ~165 s against the 10-15 s ceiling the SessionStart registration
 * ad6edc1e4 retired imposed — and on `npm run status`, against a founder
 * waiting — so files are read newest-first until the budget is spent and the
 * report says what fraction it covered. Each run caches what it read, so
 * successive runs converge on full coverage and the steady state is a stat per
 * file.
 */
const DEFAULT_BUDGET_MS = 8000;

const BUDGET_AFTER_ENV = "WFC_CENSUS_BUDGET_AFTER";

/**
 * When the census's budget reads as spent.
 *
 * Wall clock always. `WFC_CENSUS_BUDGET_AFTER` is the injection point — the
 * role `WFC_NOW` plays for check-ci-status.js's schedule — and its value is a
 * count of files whose bytes were READ: the budget reads as spent once that
 * many have been, OR once the clock says so (mantahostels#1945, mantahostels#2035).
 *
 * THE COUNT CAPS THE CLOCK, NEVER REPLACES IT. A seam set in a real environment
 * would otherwise leave `--budget-ms` bounding nothing.
 *
 * Its value is validated at the entry point, beside `--budget-ms`.
 *
 * @param {number} budgetMs
 * @returns {(filesRead: number) => boolean}
 */
function budgetSpender(budgetMs) {
	const deadline = Date.now() + budgetMs;
	const raw = process.env[BUDGET_AFTER_ENV];
	if (!raw) return () => Date.now() >= deadline;
	const after = Number(raw);
	return (filesRead) => filesRead >= after || Date.now() >= deadline;
}

/* The window both floors above were calibrated on, and short on purpose: a hook
 * repaired yesterday should stop being reported today. */
const DEFAULT_DAYS = 2;

/** The two attachment types that say a hook did not complete. */
const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);

/*
 * The needle is the attachment object's own opening bytes. Scanned over the
 * BUFFER, never a decoded string: decoding the corpus to reach its handful of
 * hook records measured 6× slower.
 */
const NEEDLE = Buffer.from('{"type":"hook_');

/**
 * @typedef {{ ok: number, bad: number, failSessions: number }} Tally
 * @typedef {{ scanned: number, days: Record<string, Record<string, [number, number]>>, bare: Record<string, number> }} FileEntry
 * @typedef {{ version: number, files: Record<string, FileEntry> }} Cache
 */

/* 2 because `bare` joined FileEntry at mantahostels#2296: a v1 entry has no such field, and
 * reading one as if it did would under-report the count for ever. */
const CACHE_VERSION = 2;

/** @param {string} file */
function readCache(file) {
	try {
		const c = JSON.parse(fs.readFileSync(file, "utf8"));
		if (c && c.version === CACHE_VERSION && c.files) return c;
	} catch {
		// No cache, or one this build cannot read: rescan everything.
	}
	return { version: CACHE_VERSION, files: {} };
}

/**
 * Count the hook attachment records in `buf`, from `from` to the last complete
 * line, into `days`.
 *
 * Scanning stops at the last newline: the bytes after it may be a line the
 * harness is appending right now, and counting a half-written record would
 * either throw it away (the offset moves past it) or double-count it.
 *
 * @param {Buffer} buf
 * @param {number} from
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {Record<string, number>} bare per day, the failures carrying no
 *   command — see the header's account of what that gap covers
 * @returns {number} the offset scanned to
 */
function countInto(buf, from, days, bare) {
	const end = buf.lastIndexOf(0x0a, buf.length - 1) + 1;
	if (end <= from) return from;
	let p = from;
	for (;;) {
		const i = buf.indexOf(NEEDLE, p);
		if (i < 0 || i >= end) break;
		const lineStart = buf.lastIndexOf(0x0a, i) + 1;
		let lineEnd = buf.indexOf(0x0a, i);
		if (lineEnd < 0 || lineEnd > end) lineEnd = end;
		p = lineEnd + 1;
		const parsed = parseLine(buf, lineStart, lineEnd);
		if (parsed) tallyRecord(parsed.rec, days, bare);
	}
	return end;
}

/**
 * One transcript line parsed, or null where it does not parse.
 *
 * @param {Buffer} buf
 * @param {number} lineStart
 * @param {number} lineEnd
 * @returns {{ rec: any } | null}
 */
function parseLine(buf, lineStart, lineEnd) {
	try {
		return {
			rec: JSON.parse(buf.subarray(lineStart, lineEnd).toString("utf8")),
		};
	} catch {
		// A line the needle matched inside some other field, or a torn one.
		return null;
	}
}

/**
 * Count one parsed record into `days`, or into `bare` where it names no command.
 *
 * @param {any} rec
 * @param {Record<string, Record<string, [number, number]>>} days accumulator: a command's record is counted here
 * @param {Record<string, number>} bare accumulator: a commandless failure is counted here by day
 */
function tallyRecord(rec, days, bare) {
	const a = rec?.attachment;
	if (!a || typeof a.type !== "string") return;
	const success = a.type === "hook_success";
	if (!success && !FAILURE_TYPES.has(a.type)) return;
	// Keyed on the record's own command and nothing else. A record carrying no
	// command is never pooled under a placeholder, which would then dominate
	// the report.
	const day =
		typeof rec.timestamp === "string" ? rec.timestamp.slice(0, 10) : "unknown";
	if (typeof a.command !== "string" || !a.command) {
		// Failures only: an unattributable SUCCESS says nothing about a hook that
		// did not run.
		if (!success) bare[day] = (bare[day] || 0) + 1;
		return;
	}
	bumpTally(days, day, a.command, success);
}

/**
 * Add one success or one failure to a command's tally for a day.
 *
 * @param {Record<string, Record<string, [number, number]>>} days accumulator: the day's command tally is bumped
 * @param {string} day
 * @param {string} command
 * @param {boolean} success
 */
function bumpTally(days, day, command, success) {
	if (!days[day]) days[day] = {};
	const bucket = days[day];
	let t = bucket[command];
	if (!t) {
		t = [0, 0];
		bucket[command] = t;
	}
	if (success) t[0]++;
	else t[1]++;
}

/**
 * The delivery-stamp name each assertion's stamp is held under.
 * @param {string} which
 */
const stampName = (which) => `hook-liveness-${which}`;

/**
 * The set each assertion found, keyed by stamp name, for flushStamps to write
 * once the report is out.
 *
 * MODULE-LEVEL, and safe to be: one process runs one check, and the test seam
 * purges the module registry between runs (lib/run-in-process.js).
 *
 * @type {Map<string, string>}
 */
const pendingStamps = new Map();

/**
 * Has --notify already reported exactly this set? Queues the stamp if not.
 *
 * BOTH ASSERTIONS DESCRIBE STANDING CONDITIONS, NOT EVENTS. A hook that times
 * out does so every session, and a diverged plugin cache stays diverged until
 * somebody repairs the packaging — so repeating either on every --notify run is
 * the noise --notify exists to avoid. A member joining or leaving the set is new
 * information and is said. Keyed on the set rather than a clock, because WSL2
 * steps its clock backwards on resume.
 *
 * An empty set clears the stamp, so a regression to the same set is said again
 * rather than silenced for good.
 *
 * DECIDES ONLY (mantahostels#2244): flushStamps writes, at the end of the run, so a process
 * that dies between deciding and reporting repeats the notice rather than
 * swallowing it for good.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {string} key
 * @returns {boolean}
 */
function saidBeforeElseQueue(ctx, which, key) {
	const checker = stampName(which);
	// CLEARED HERE AND NOW, where the write below is deferred: the two fail
	// opposite ways. A deferred write that never happens costs a repeated notice;
	// a deferred clear that never happens leaves a stamp standing over a set that
	// has emptied, silencing that fault's return for good.
	if (!key) {
		clearSaid(which);
		return false;
	}
	// False on a hand run, in CI, and under persist mode, where this run is not
	// the delivery and nothing may be suppressed on a stamp the founder may never
	// have been shown (mantahostels#1975).
	if (deliveryStamp.alreadyDelivered(ctx, checker, key)) return true;
	pendingStamps.set(checker, key);
	return false;
}

/** @param {string} which */
function clearSaid(which) {
	deliveryStamp.clearDelivery(stampName(which));
}

/**
 * Write what the assertions found, once their report is out. Only where this run
 * WAS the delivery — under persist mode the write below no-ops for every one of
 * these, and the run's own return carries `pendingStamps` as `stamps` instead,
 * for the reader to apply once it has actually shown the report (mantahostels#1975, mantahostels#2277).
 *
 * RESIDUAL: `stamps` rides the normal return in `run()`, which a `ctx.skip()`
 * never reaches. `censusAssertion` can still queue `hook-liveness-corpus` and
 * then return `{ unavailable }` when every config dir is unlistable — the one
 * assertion whose stamped branch and its unavailable-return branch are not
 * mutually exclusive — so on a machine where every config dir stays refused,
 * that stamp is queued every run and never carried, and the
 * CORPUS-UNREADABLE line repeats on every --notify run rather than once.
 *
 * @param {import("./lib/check").Ctx} ctx
 */
function flushStamps(ctx) {
	for (const [checker, key] of pendingStamps)
		deliveryStamp.markDelivered(ctx, checker, key);
	pendingStamps.clear();
}

/**
 * Every transcript this project has under every config dir on this machine that
 * a record inside the retention window could be in, newest first.
 *
 * THE UNION, NOT `CLAUDE_CONFIG_DIR` ALONE: sessions run across all three plans
 * (lib/arbiter-core.js `sessionDirs`), and a hook failing only on the plan this
 * session is not running under is exactly the one nobody would otherwise see.
 *
 * BOTH TIERS, BUT NOT VIA lib/guard-fires.js `readTranscriptFiles`. That one is
 * exhaustive by design — it readdirs a `subagents/` directory for every one of
 * the ~10,000 session directories here, which measured 5.8 s before a single
 * byte was read, against 0.26 s for this. The window does the pruning instead: a
 * subagent's transcript is reached only where its parent session's own file
 * moved inside the window, which holds because the two are written together.
 * RESIDUAL: a subagent transcript still growing under a parent whose own file
 * has gone quiet is not read.
 *
 * ONE COPY PER SESSION. A session resumed on another seat leaves a transcript
 * at the same relative path under each seat's own directory (workflow-core#375), so only the
 * largest is kept — `transcript_corpus.py`'s `one_copy_each()` (workflow-core#382).
 *
 * @param {number} cutoff epoch ms; a file last written before this is dropped
 * @returns {{ files: Array<{file: string, mtimeMs: number, size: number, id: string}>, dirs: string[], unreadable: string[] }}
 */
function readCorpusFiles(cutoff) {
	const slug = projectSlug();
	/** @type {TranscriptsByRel} */
	const byRel = new Map();
	const dirs = [];
	const unreadable = [];

	for (const cfg of configDirs()) {
		const dir = path.join(cfg, "projects", slug);
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			const { code } = caught(e);
			// A config dir this machine has never run this project under is the
			// ordinary case and must not speak; anything else is a corpus this run
			// could not read, which the caller reports.
			if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
			continue;
		}
		dirs.push(dir);
		takeProjectDir(byRel, cutoff, dir, entries);
	}
	const files = [...byRel.values()];
	// Newest first, so an abandoned scan abandons the least recent evidence.
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return { files, dirs, unreadable };
}

/**
 * @typedef {Map<string, {file: string, mtimeMs: number, size: number, id: string}>} TranscriptsByRel
 */

/**
 * Keep one transcript in `byRel` where it is inside the window and larger than
 * the copy already held at its relative path.
 *
 * @param {TranscriptsByRel} byRel accumulator: the transcript is set here where it is kept
 * @param {number} cutoff
 * @param {string} dir
 * @param {string} at
 * @returns {boolean} whether the file itself is inside the window
 */
function takeTranscript(byRel, cutoff, dir, at) {
	try {
		const st = fs.statSync(at);
		const rel = path.relative(dir, at);
		const held = byRel.get(rel);
		if (st.isFile() && st.mtimeMs >= cutoff && (!held || st.size > held.size))
			byRel.set(rel, {
				file: at,
				mtimeMs: st.mtimeMs,
				size: st.size,
				/* Two paths sharing an inode are one transcript read twice. Every
				 * ratio below divides that duplication out; a bare COUNT has no
				 * denominator, so it alone has to deduplicate (mantahostels#2299). */
				id: `${st.dev}:${st.ino}`,
			});
		return st.mtimeMs >= cutoff;
	} catch {
		return false;
	}
}

/**
 * Take every session transcript in one project dir, then the subagent
 * transcripts of each session whose own file is inside the window.
 *
 * @param {TranscriptsByRel} byRel
 * @param {number} cutoff
 * @param {string} dir
 * @param {fs.Dirent[]} entries
 */
function takeProjectDir(byRel, cutoff, dir, entries) {
	/** Session ids whose own transcript is inside the window. */
	const live = new Set();
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
		if (takeTranscript(byRel, cutoff, dir, path.join(dir, e.name)))
			live.add(e.name.replace(/\.jsonl$/, ""));
	}
	for (const e of entries) {
		if (!e.isDirectory() || !live.has(e.name)) continue;
		takeSubagents(byRel, cutoff, dir, path.join(dir, e.name, "subagents"));
	}
}

/**
 * @param {TranscriptsByRel} byRel
 * @param {number} cutoff
 * @param {string} dir
 * @param {string} subDir
 */
function takeSubagents(byRel, cutoff, dir, subDir) {
	let subs;
	try {
		subs = fs.readdirSync(subDir);
	} catch {
		// A session that dispatched nothing has no subagents/ at all.
		return;
	}
	for (const f of subs)
		if (f.endsWith(".jsonl"))
			takeTranscript(byRel, cutoff, dir, path.join(subDir, f));
}

/**
 * Is a day bucket recent enough to count? An `unknown` day is kept: a record
 * with no timestamp cannot be shown to fall outside the window.
 *
 * @param {string} day
 * @param {number} cutoff
 */
function inWindow(day, cutoff) {
	if (day === "unknown") return true;
	const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
	return !(Number.isFinite(dayEnd) && dayEnd < cutoff);
}

/**
 * Assertion 1. Reports a hook whose failure records dominate its successes.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {number} days
 * @param {number} budgetMs
 * @returns {{ reported: string[], scanned: number, bytes: number, covered: number, total: number, bare: number, asyncBlind: number } | { unavailable: string }}
 */
function censusAssertion(ctx, days, budgetMs) {
	const budgetSpent = budgetSpender(budgetMs);
	const retainCutoff = Date.now() - CACHE_RETENTION_DAYS * 86_400_000;
	const { files, dirs, unreadable } = readCorpusFiles(retainCutoff);
	/* Said as well as warned: a WARN's message reaches --json and a GitHub
	 * annotation, never the human text a reader sees (mantahostels#1898). Through the same
	 * once-per-set stamp as the findings themselves, and skipped in Actions,
	 * where the annotation already carries the sentence. */
	const saidDirs = saidBeforeElseQueue(
		ctx,
		"corpus",
		[...unreadable].sort().join("\n"),
	);
	/*
	 * MAY AN EMPTY SET CLEAR THE NOTIFY STAMP? Only where the emptiness is a
	 * reading rather than a failure to look — an EACCES on a config dir still
	 * full of transcripts empties the set the same way, and clearing on that
	 * re-announces the whole failing-hook set at the next start (mantahostels#1964).
	 *
	 * BOTH CLEAR SITES, AND NEITHER IS DEAD. The empty-`bad` clear below is
	 * reached whenever one config dir is refused and the state directory is still
	 * listable, which since mantahostels#1963 is the ordinary case. The unavailable return is
	 * reached when every dir is refused — mode `0o333` being the case that proves
	 * it, since a directory can refuse listing while the stamp inside stays
	 * readable by name (mantahostels#1964).
	 *
	 * EVERY STAMPED ASSERTION IN THIS FILE IS GATED THIS WAY (mantahostels#1981, mantahostels#2108).
	 *
	 * RESIDUAL: it governs the CLEAR alone. A partial corpus that still yields a
	 * finding writes its own narrower key, so the full set re-announces when the
	 * directory comes back.
	 */
	const mayClear = unreadable.length === 0;
	for (const dir of unreadable) {
		const line = `${dir} could not be listed, so any hook failing only in those sessions is invisible here`;
		ctx.warn("CORPUS-UNREADABLE", line, { dir });
		if (!saidDirs && !ctx.inActions) ctx.say(line);
	}
	if (dirs.length === 0) {
		/* Cleared BEFORE the return, as reapAssertion's and manifestAssertion's are:
		 * an empty set clears the stamp, and the corpus going away is one of the
		 * ways the set empties. The
		 * key is the empty string rather than a recomputed one because no corpus
		 * means no finding. */
		if (mayClear) clearSaid("census");
		// UNAVAILABLE, not BROKEN: the subject lives outside the repo (mantahostels#155's
		// split), and a fresh machine legitimately has no retained transcripts. It
		// is RETURNED rather than thrown so that a run asking for every assertion
		// still gates on the others.
		return { unavailable: buildNoCorpusReason(unreadable) };
	}

	const cacheFile = statePath("hook-liveness-census.json");
	const cache = readCache(cacheFile);
	const windowCutoff = Date.now() - days * 86_400_000;
	const scan = scanCorpus(files, cache, budgetSpent, windowCutoff);
	writeCensusCache(cacheFile, scan.next);

	const total = files.length;
	const bad = [...scan.totals]
		.filter(([, t]) => isFailingHook(t, scan.windowSessions))
		.sort((a, b) => b[1].bad - a[1].bad);

	sayBareRecords(ctx, scan.bareTotal, days, mayClear);
	const blindRoster = sayAsyncBlindRoster(ctx, mayClear);

	/** @param {string[]} reported */
	const result = (reported) => ({
		reported,
		scanned: scan.scanned,
		bytes: scan.bytes,
		covered: scan.covered,
		total,
		bare: scan.bareTotal,
		asyncBlind: blindRoster.length,
	});
	const key = bad
		.map(([cmd]) => cmd)
		.sort()
		.join("\n");
	if (bad.length === 0) {
		if (mayClear) clearSaid("census");
		return result([]);
	}
	if (saidBeforeElseQueue(ctx, "census", key)) return result([]);

	reportFailingHooks(ctx, bad, days, {
		windowSessions: scan.windowSessions,
		covered: scan.covered,
		dirs,
		total,
	});
	return result(bad.map(([cmd]) => cmd));
}

/**
 * Why the census has no corpus to read.
 *
 * @param {string[]} unreadable
 */
function buildNoCorpusReason(unreadable) {
	return unreadable.length > 0
		? `every config dir that could hold transcripts for ${repoRoot()} refused to be listed`
		: `no retained transcripts for ${repoRoot()} under any config dir on this machine`;
}

/**
 * @typedef {{
 *   next: Cache,
 *   totals: Map<string, Tally>,
 *   scanned: number,
 *   bytes: number,
 *   covered: number,
 *   windowSessions: number,
 *   bareTotal: number,
 * }} CensusScan
 */

/**
 * Read every transcript's new bytes until the budget is spent, and total each
 * hook's records inside the window.
 *
 * @param {Array<{file: string, mtimeMs: number, size: number, id: string}>} files
 * @param {Cache} cache
 * @param {(filesRead: number) => boolean} budgetSpent
 * @param {number} windowCutoff
 * @returns {CensusScan}
 */
function scanCorpus(files, cache, budgetSpent, windowCutoff) {
	/** @type {CensusScan} */
	const scan = {
		next: { version: CACHE_VERSION, files: {} },
		totals: new Map(),
		scanned: 0,
		bytes: 0,
		covered: 0,
		/* The denominator for a hook that records no successes: transcripts inside
		 * the window this run could account for. */
		windowSessions: 0,
		/* In-window failure records naming no hook. */
		bareTotal: 0,
	};

	/* Inodes whose bare records are already in bareTotal. */
	const countedBare = new Set();
	for (const { file, size, mtimeMs, id } of files) {
		const { entry, spent } = refreshEntry(
			scan,
			cache.files[file],
			{ file, size },
			budgetSpent,
		);
		scan.next.files[file] = entry;
		if (!spent) scan.covered++;

		// mtime is the right window filter precisely because the file is
		// append-only: a file last written before the cutoff cannot hold a record
		// inside it. Day buckets then narrow the tail file that straddles it.
		if (mtimeMs < windowCutoff) continue;
		scan.windowSessions++;
		if (!countedBare.has(id)) {
			countedBare.add(id);
			addBareInWindow(scan, entry.bare, windowCutoff);
		}
		addFileTotals(scan.totals, entry.days, windowCutoff);
	}
	return scan;
}

/**
 * One transcript's cache entry brought up to date, reading only the bytes past
 * the cached offset, and whether the budget left it unread.
 *
 * @param {CensusScan} scan accumulator: bytes and scanned count what this file's read cost
 * @param {FileEntry | undefined} prev
 * @param {{ file: string, size: number }} transcript
 * @param {(filesRead: number) => boolean} budgetSpent
 * @returns {{ entry: FileEntry, spent: boolean }}
 */
function refreshEntry(scan, prev, transcript, budgetSpent) {
	const { file, size } = transcript;
	/*
	 * A transcript is append-only, so a file no longer than it was when it was
	 * last read holds exactly the records already counted. Shorter means it was
	 * truncated or replaced, and the cached counts describe bytes that are gone
	 * — rescan from zero.
	 */
	const from = prev && prev.scanned <= size ? prev.scanned : 0;
	/** @type {FileEntry} */
	const entry =
		from && prev
			? { scanned: from, days: prev.days, bare: prev.bare }
			: { scanned: 0, days: {}, bare: {} };
	/*
	 * The budget is tested only where bytes would actually be read, so a
	 * fully-cached corpus always completes however long the stats took. A file
	 * the budget leaves unread keeps whatever the cache already holds for it,
	 * and those counts still go into the totals: they are true of the bytes they
	 * came from, and dropping them would make every budgeted run start over.
	 * Only `covered` records that this run saw all of it.
	 */
	const spent = from < size && budgetSpent(scan.scanned);
	if (from < size && !spent) {
		const { buf, got } = readTail(file, from, size);
		scan.bytes += got;
		scan.scanned++;
		const days = structuredClone(entry.days);
		const bare = { ...entry.bare };
		const scanned = from + countInto(buf.subarray(0, got), 0, days, bare);
		return { entry: { scanned, days, bare }, spent };
	}
	return { entry, spent };
}

/**
 * Only the bytes past the last offset. readFileSync would pull the whole
 * file back for a hundred new records, and the files that grow are the
 * large ones — a live session's transcript reaches 12 MB here. `from` is
 * always a line boundary, countInto having stopped at a newline, so a
 * read starting there never lands mid-record.
 *
 * @param {string} file
 * @param {number} from
 * @param {number} size
 * @returns {{ buf: Buffer, got: number }}
 */
function readTail(file, from, size) {
	const len = size - from;
	const buf = Buffer.allocUnsafe(len);
	const fd = fs.openSync(file, "r");
	let got = 0;
	try {
		got = fs.readSync(fd, buf, 0, len, from);
	} finally {
		fs.closeSync(fd);
	}
	return { buf, got };
}

/**
 * Add a file's in-window bare-record counts to the scan's total.
 *
 * @param {CensusScan} scan accumulator: bareTotal gains the in-window counts
 * @param {Record<string, number>} bare
 * @param {number} windowCutoff
 */
function addBareInWindow(scan, bare, windowCutoff) {
	for (const [day, n] of Object.entries(bare)) {
		if (!inWindow(day, windowCutoff)) continue;
		scan.bareTotal += n;
	}
}

/**
 * Add a file's in-window per-command counts to the running totals.
 *
 * @param {Map<string, Tally>} totals accumulator: each command's in-window counts are added
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {number} windowCutoff
 */
function addFileTotals(totals, days, windowCutoff) {
	/* Per file, so failSessions counts the transcript once however many times
	 * the hook failed inside it. */
	const failedHere = new Set();
	for (const [day, cmds] of Object.entries(days)) {
		if (!inWindow(day, windowCutoff)) continue;
		for (const [cmd, [ok, bad]] of Object.entries(cmds)) {
			const t = totals.get(cmd) || { ok: 0, bad: 0, failSessions: 0 };
			t.ok += ok;
			t.bad += bad;
			if (bad > 0 && !failedHere.has(cmd)) {
				failedHere.add(cmd);
				t.failSessions++;
			}
			totals.set(cmd, t);
		}
	}
}

/**
 * @param {string} cacheFile
 * @param {Cache} next
 */
function writeCensusCache(cacheFile, next) {
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify(next));
	} catch {
		// An unwritable cache costs the next run a full rescan, never a wrong
		// answer.
	}
}

/**
 * Do a hook's failure records dominate — over its successes where it records
 * any, over the sessions scanned where it records none?
 *
 * @param {Tally} t
 * @param {number} windowSessions
 */
function isFailingHook(t, windowSessions) {
	return (
		t.bad >= MIN_FAILURES &&
		(t.ok > 0
			? t.bad > t.ok
			: t.failSessions / Math.max(windowSessions, 1) >=
				ZERO_SUCCESS_SESSION_RATE)
	);
}

/**
 * Say the count of failure records naming no hook, once per presence.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {number} bareTotal
 * @param {number} days
 * @param {boolean} mayClear
 */
function sayBareRecords(ctx, bareTotal, days, mayClear) {
	if (bareTotal) {
		/* Keyed on PRESENCE, never on the number: a count over a rolling window
		 * moves at almost every start, and keying on it would re-announce a
		 * standing blind spot each time. */
		if (!saidBeforeElseQueue(ctx, "census-bare", "some"))
			ctx.say(
				`${bareTotal} failure record(s) in the last ${days} days named no hook command, so this census\n` +
					"could attribute them to nothing. Every PostToolUse cancellation lands here, by construction.",
			);
	} else if (mayClear) clearSaid("census-bare");
}

/**
 * Say the SessionStart producers this census cannot see, once per set.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} mayClear
 */
function sayAsyncBlindRoster(ctx, mayClear) {
	/*
	 * NO `self`: the sibling caller (replay-notify-reports.js) excludes
	 * itself because it does not persist its own report; this census IS one
	 * of the eight and genuinely cannot see itself either, so it belongs in
	 * its own roster.
	 *
	 * reap-finished-sessions excepted from the "replay reads them" claim
	 * below: its cancellation is left to its own next-run line rather than
	 * that reader (replay-notify-reports.js's own SELF_REPORTS_CANCELLATION,
	 * mantahostels#1976). readSessionStartRoster() is the shared reader that both this file
	 * and that one resolve the roster through, so a hook added or dropped
	 * from self-plugin/hooks/hooks.json moves this line and that reader together.
	 */
	const blindRoster = readSessionStartRoster(repoRoot(), {
		keyOverrides: ROSTER_KEY_OVERRIDES,
	});
	if (blindRoster.length > 0) {
		const sorted = [...blindRoster].sort((a, b) => byCodeUnit(a.key, b.key));
		if (
			!saidBeforeElseQueue(
				ctx,
				"census-async-blind",
				sorted.map((r) => r.key).join("\n"),
			)
		)
			ctx.say(
				`${sorted.length} SessionStart producer(s) persist their own report and write no transcript\n` +
					`record at all, so this census cannot see them: ${sorted.map((r) => `${r.key} (${r.script})`).join(", ")}.\n` +
					"scripts/replay-notify-reports.js reads their persisted run/report files instead, reap-finished-sessions's\n" +
					"own next-run line covering its cancellation there.",
			);
	} else if (mayClear) clearSaid("census-async-blind");
	return blindRoster;
}

/**
 * Fail and say every hook whose failures dominate.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<[string, Tally]>} bad
 * @param {number} days
 * @param {{ windowSessions: number, covered: number, dirs: string[], total: number }} corpus
 */
function reportFailingHooks(ctx, bad, days, corpus) {
	const { windowSessions, covered, dirs, total } = corpus;
	for (const [cmd, t] of bad)
		ctx.fail(
			"HOOK-FAILING",
			`${t.bad} failure record(s) against ${t.ok} success(es) in the last ${days} days, across ${t.failSessions} of ${windowSessions} session(s) — ${cmd}`,
			{
				command: cmd,
				failures: t.bad,
				successes: t.ok,
				failSessions: t.failSessions,
				sessions: windowSessions,
				days,
			},
		);

	ctx.say(
		`${bad.length} wired hook(s) whose failure records outnumber their successes over the last ${days} days.\n` +
			"Each of these is configured, reached and did not complete, so whatever it checks or injects did not happen.\n",
	);
	for (const [cmd, t] of bad)
		ctx.say(
			`  ${t.bad} failed / ${t.ok} succeeded, in ${t.failSessions} of ${windowSessions} session(s)\n    ${cmd}`,
		);
	ctx.say(
		"\nA hook that prints nothing when it passes records no success, so a zero on the right\n" +
			"is not a claim that it never worked. Run each command above by hand to see what it does\n" +
			`with no timeout on it. Transcripts read: ${dirs.join(", ")}`,
	);
	if (covered < total)
		ctx.say(
			`Budget spent at ${covered} of ${total} transcript file(s); the rest are read on the next run.`,
		);
}

/**
 * A plugin's declared source path within its marketplace checkout, or null where
 * the marketplace does not build the plugin from its own tree.
 *
 * A marketplace names each plugin's `source` either as a path relative to the
 * checkout ("./plugins/code-review", "./") or as an object pointing at another
 * repository entirely, which this machine does not hold — so there is nothing
 * local to compare and the entry is unverifiable rather than clean.
 *
 * @param {string} marketplaceDir
 * @param {string} name
 * A FAILURE TO LOOK IS FLAGGED `unreadable`, A SETTLED ANSWER IS NOT (mantahostels#1981).
 * Only the first may hold the notify stamp open: "not listed" and "sourced from
 * another repository" are permanent conditions, so gating the clear on those
 * would silence a repaired-and-recurring divergence for good.
 *
 * @returns {{ rel: string } | { unverifiable: string, unreadable?: boolean }}
 */
function readPluginSource(marketplaceDir, name) {
	const at = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		return {
			unverifiable: `${at} could not be read: ${caught(e).message}`,
			unreadable: true,
		};
	}
	const entry = (doc.plugins || []).find(
		(/** @type {any} */ p) => p && p.name === name,
	);
	if (!entry) return { unverifiable: `${name} is not listed in ${at}` };
	if (typeof entry.source !== "string")
		return {
			unverifiable: `${name} is sourced from another repository, which this machine does not hold`,
		};
	return { rel: entry.source.replace(/^\.\/?/, "") };
}

/**
 * Two hook manifests compared as documents rather than as bytes, so a reflow or
 * a trailing newline is not reported as a divergence. Unparseable text falls
 * back to its bytes, since an unparseable cached manifest wires nothing and is a
 * divergence in its own right.
 *
 * @param {string | null} a
 * @param {string | null} b
 */
function isSameManifest(a, b) {
	if (a === null || b === null) return a === b;
	const canon = (/** @type {string} */ s) => {
		try {
			return JSON.stringify(JSON.parse(s));
		} catch {
			return s;
		}
	};
	return canon(a) === canon(b);
}

/**
 * The marketplace's own copy of a plugin's hooks.json: the blob at the pinned
 * commit where the checkout is a git repository, the file on disk where it is
 * not.
 *
 * claude-plugins-official is fetched from object storage and holds no `.git` at
 * all, so its entries' `gitCommitSha` resolves against nothing; the working-tree
 * fallback is what keeps those eleven plugins checked rather than skipped.
 *
 * @param {string} marketplaceDir
 * @param {string} rel
 * @param {string | undefined} sha
 * @returns {{ text: string | null, basis: string }
 *   | { unverifiable: string, unreadable?: boolean }}
 */
function readUpstreamManifest(marketplaceDir, rel, sha) {
	const relFile = path.posix.join(rel, "hooks/hooks.json");
	if (sha && fs.existsSync(path.join(marketplaceDir, ".git"))) {
		/* A clone rotated to an older tag than the install lacks its commit, and
		 * `git show` then says "does not exist in" — the same words as a tree
		 * shipping no hooks — so the commit is proved present first. Absent, it
		 * is a failure to look, never another version's manifest read in its
		 * place (workflow-core#747). */
		const commitPresent = spawnGitSync(
			["-C", marketplaceDir, "cat-file", "-e", `${sha}^{commit}`],
			{ encoding: "utf8" },
		);
		if (commitPresent.status !== 0)
			return {
				unverifiable: `commit ${sha.slice(0, 8)} is not in ${marketplaceDir}, which sits on another version than the install`,
				unreadable: true,
			};
		const r = spawnGitSync(
			["-C", marketplaceDir, "show", `${sha}:${relFile}`],
			{
				encoding: "utf8",
			},
		);
		if (r.status === 0)
			return { text: r.stdout, basis: `${sha.slice(0, 8)}:${relFile}` };
		const err = (r.stderr || r.error?.message || "").trim();
		// git says "does not exist in" for a path absent from that tree. That is an
		// answer — the plugin ships no hooks — and not a failure to look.
		if (/does not exist in|exists on disk, but not in/.test(err))
			return { text: null, basis: `${sha.slice(0, 8)} (no hooks/hooks.json)` };
		return {
			unverifiable: `git show ${sha.slice(0, 8)}:${relFile} failed: ${err.slice(0, 120)}`,
			unreadable: true,
		};
	}
	const at = path.join(marketplaceDir, relFile);
	let text = null;
	try {
		text = fs.readFileSync(at, "utf8");
	} catch {
		// Absent upstream, which the comparison below reads as "ships no hooks".
	}
	return {
		text,
		basis: `${at} (the checkout as it stands, not a pinned commit)`,
	};
}

/**
 * Where a marketplace's own tree lives, for `readPluginSource`/`readUpstreamManifest`
 * to read — `scripts/lib/plugin-state.js`'s `resolveMarketplace`, which owns
 * the reading and documents it (mantahostels#3515 F9). This file used to hold a second copy
 * that ignored `installLocation` for a `git`/`github` source, so wherever the
 * CLI wrote one away from the clone path the two named different trees (workflow-core#251
 * item 11). Kept as a wrapper because this file's callers want a bare path,
 * never the source type beside it.
 *
 * @param {string} pluginsDir the config dir's `plugins` directory
 * @param {string} marketplace a real name, so `dir` is never null
 * @returns {string}
 */
function resolveMarketplaceDir(pluginsDir, marketplace) {
	const { dir } = resolveMarketplace(pluginsDir, marketplace);
	return dir ?? path.join(pluginsDir, "marketplaces", marketplace);
}

/**
 * `enabledPlugins` for a session running under config dir `cfg`, merged in the
 * harness's order: that dir's user `settings.json`, then this repo's committed
 * `.claude/settings.json`, then its `.claude/settings.local.json`, each later
 * key overriding an earlier one, so a project-level `false` switches off a
 * user-level `true`. workflow-core#43 supersedes
 * mantahostels#3566's committed-settings-only reading. Managed (enterprise)
 * settings are not read. Keyed
 * `<plugin>@<marketplace>`, the shape `manifestAssertion`'s `key` already is.
 *
 * An absent file contributes nothing. A file present but unparseable
 * contributes nothing AND warns, once per file per run: every plugin it would
 * have enabled then goes unaudited (workflow-core#43).
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} cfg
 * @param {Set<string>} warned accumulator: files already warned about this run; a newly warned one is added
 * @returns {Record<string, unknown>}
 */
function readEnabledPluginsFor(ctx, cfg, warned) {
	/** @type {Record<string, unknown>} */
	const merged = {};
	for (const at of [
		path.join(cfg, "settings.json"),
		path.join(repoRoot(), ".claude", "settings.json"),
		path.join(repoRoot(), ".claude", "settings.local.json"),
	]) {
		let doc;
		try {
			doc = JSON.parse(fs.readFileSync(at, "utf8"));
		} catch (e) {
			const { code, message } = caught(e);
			if (code === "ENOENT" || warned.has(at)) continue;
			warned.add(at);
			const line = `${at} does not parse, so no plugin it enables is audited: ${message}`;
			ctx.warn("SETTINGS-UNPARSEABLE", line, { path: at }, at);
			if (!ctx.inActions) ctx.say(line);
			continue;
		}
		const ep = doc?.enabledPlugins;
		if (ep && typeof ep === "object") Object.assign(merged, ep);
	}
	return merged;
}

/**
 * Every `{event, matcher, command}` a hooks.json document wires, as a set of
 * tab-joined tuples — `command` kept as its literal, unresolved string (so
 * `${CLAUDE_PLUGIN_ROOT}` stays a placeholder and the same script compares
 * equal on both sides of a diff without either being resolved to a real
 * path). Unparseable text yields the empty set: a manifest that fails to
 * parse has already been reported by `isSameManifest`'s caller, and an empty
 * set here just means "nothing to drop".
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function hookTuples(text) {
	/** @type {Set<string>} */
	const out = new Set();
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return out;
	}
	for (const { event, matcher, hook } of wiredHooks(doc))
		out.add(`${event}\t${matcher?.matcher ?? ""}\t${hook.command}`);
	return out;
}

/**
 * Every hook a parsed hooks.json document wires with a string `command`, in
 * document order, each with the event and matcher entry it sits under.
 *
 * @param {any} doc
 * @returns {Array<{ event: string, matcher: any, hook: any }>}
 */
function wiredHooks(doc) {
	/** @type {Array<{ event: string, matcher: any, hook: any }>} */
	const out = [];
	for (const [event, matchers] of Object.entries(doc?.hooks || {}))
		for (const matcher of Array.isArray(matchers) ? matchers : [])
			for (const hook of /** @type {any[]} */ (matcher?.hooks || []))
				if (typeof hook?.command === "string")
					out.push({ event, matcher, hook });
	return out;
}

/**
 * How a cached plugin manifest differs from the marketplace's, as one clause.
 *
 * @param {string|null} cached
 * @param {string|null} upstream
 * @returns {string}
 */
function divergenceShape(cached, upstream) {
	if (cached === null) return "the cache holds no hooks/hooks.json at all";
	if (upstream === null)
		return "the marketplace ships none, so the cache wires hooks the plugin does not declare";
	return `cached ${cached.length} B against ${upstream.length} B upstream`;
}

/**
 * @typedef {{
 *   compared: number,
 *   manifests: number,
 *   unverifiable: string[],
 *   unreadable: number,
 *   diverged: Array<{key: string, cachedAt: string, basis: string, installPath: string, cachedBytes: number | null, upstreamBytes: number | null, shape: string}>,
 *   droppedHooks: Array<{key: string, event: string, command: string, cachedAt: string, basis: string}>,
 *   brokenPluginPaths: Array<{key: string, event: string, rel: string, full: string, reason: HookPathFault}>,
 * }} ManifestAudit
 * @typedef {"missing" | "not-a-file" | "not-executable"} HookPathFault
 */

/**
 * Assertion 2. Reports a cached plugin manifest that differs from the
 * marketplace's copy of the same file.
 *
 * EXTENDED (mantahostels#3515 F9, mantahostels#3566): for each ENABLED plugin (`readEnabledPluginsFor()`),
 * also diffs the two manifests hook-by-hook, rather than only by whole-file
 * bytes, and applies `ownHooksAssertion`'s own path/executable audit to
 * `${CLAUDE_PLUGIN_ROOT}`-rooted commands in the CACHED (installed) manifest
 * — the one the runtime actually wires. "Expected" is sourced from the
 * marketplace's own copy (`readUpstreamManifest`, already fetched for the
 * whole-file compare above): a hook wired there and absent from the cache is
 * one the core authored and packaging dropped. Neither new check runs for a
 * plugin this repo has not itself enabled, so a fixture or a repo carrying no
 * plugin at all stays silent rather than red.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ compared: number, unverifiable: string[], droppedHooks: number, brokenPluginPaths: number } | { unavailable: string }}
 */
function manifestAssertion(ctx) {
	const root = repoRoot();
	/** @type {ManifestAudit} */
	const audit = {
		compared: 0,
		manifests: 0,
		unverifiable: [],
		/* The subset of `unverifiable` that is a failure to LOOK rather than a
		 * settled answer — the only arm that may hold the stamp open (mantahostels#1981). */
		unreadable: 0,
		diverged: [],
		droppedHooks: [],
		brokenPluginPaths: [],
	};
	/** @type {Set<string>} */
	const warnedSettings = new Set();

	for (const cfg of configDirs())
		auditConfigDir(ctx, audit, cfg, { root, warnedSettings });

	/* ABOVE THE UNAVAILABLE RETURN, for the reason reapAssertion gives: an empty
	 * set clears the stamp, and every plugin manifest going away is one of the
	 * ways the set empties.
	 *
	 * BUT NOT WHERE A MARKETPLACE COULD NOT BE READ (mantahostels#1981). A plugin whose
	 * marketplace refused to be read is skipped past the divergence check, so its
	 * divergence drops out of `diverged` without being repaired — and clearing on
	 * that re-announces the whole diverged set at the next start. Same gate the
	 * census puts on `unreadable`; the key is still the narrower one, so a
	 * divergence that survives the fault re-announces when the marketplace
	 * returns. On the READ failures alone — `readPluginSource` says why. */
	const divergedKey = audit.diverged
		.map((d) => d.key)
		.sort()
		.join("\n");
	const saidDiverged =
		divergedKey || !audit.unreadable
			? saidBeforeElseQueue(ctx, "manifest", divergedKey)
			: false;

	if (!audit.manifests)
		return {
			unavailable: "no plugin manifest under any config dir on this machine",
		};

	if (!saidDiverged) reportDiverged(ctx, audit.diverged);

	/*
	 * THE TWO PLUGIN-HOSTED CHECKS (mantahostels#3515 F9). Each keyed and stamped
	 * separately from `diverged` above: a byte-level divergence and a specific
	 * dropped hook or dead path are different facts about the same plugin, and
	 * folding them into one key would re-announce whichever repairs first
	 * whenever the other still stands.
	 */
	reportDroppedHooks(ctx, audit.droppedHooks);
	reportBrokenPluginPaths(ctx, audit.brokenPluginPaths);

	/*
	 * NOT A FINDING. A WARN would make --notify speak on every run about
	 * a condition nobody can act on, so the count rides in the summary line and
	 * the detail in --json.
	 */
	const { unverifiable } = audit;
	if (unverifiable.length > 0 && !ctx.notify)
		ctx.say(
			`${unverifiable.length} plugin(s) could not be compared:\n` +
				unverifiable.map((u) => `  ${u}`).join("\n"),
		);
	return {
		compared: audit.compared,
		unverifiable,
		droppedHooks: audit.droppedHooks.length,
		brokenPluginPaths: audit.brokenPluginPaths.length,
	};
}

/**
 * Audit every plugin installed under one config dir into `audit`.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit} audit accumulator: manifests is counted and each install audited into it
 * @param {string} cfg
 * @param {{ root: string, warnedSettings: Set<string> }} scope
 */
function auditConfigDir(ctx, audit, cfg, scope) {
	const { root, warnedSettings } = scope;
	const pluginsDir = path.join(cfg, "plugins");
	const installed = path.join(pluginsDir, "installed_plugins.json");
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(installed, "utf8"));
	} catch {
		// No plugins installed under this config dir, or a manifest this build
		// cannot read. Either way there is nothing to compare here; a config dir
		// with no plugins is the ordinary case and must not speak.
		return;
	}
	audit.manifests++;
	const enabledPlugins = readEnabledPluginsFor(ctx, cfg, warnedSettings);
	for (const [key, entries] of Object.entries(doc.plugins || {})) {
		const at = key.lastIndexOf("@");
		if (at <= 0) continue;
		const name = key.slice(0, at);
		const marketplace = key.slice(at + 1);
		const marketplaceDir = resolveMarketplaceDir(pluginsDir, marketplace);
		for (const entry of /** @type {any[]} */ (entries))
			auditInstall(audit, { key, name, marketplaceDir }, entry, {
				root,
				enabledPlugins,
			});
	}
}

/**
 * Audit one install of one plugin into `audit`: its cached manifest against the
 * marketplace's, and, where this repo enables it, hook by hook and path by path.
 *
 * @param {ManifestAudit} audit accumulator: the install's comparison, divergence and hook faults are added
 * @param {{ key: string, name: string, marketplaceDir: string }} plugin
 * @param {any} entry
 * @param {{ root: string, enabledPlugins: Record<string, unknown> }} scope
 */
function auditInstall(audit, plugin, entry, scope) {
	const { key, name, marketplaceDir } = plugin;
	const { root, enabledPlugins } = scope;
	// A plugin installed for a different project says nothing about this
	// repo's hooks.
	if (entry.scope === "project" && entry.projectPath !== root) return;
	const src = readPluginSource(marketplaceDir, name);
	if ("unverifiable" in src) {
		noteUnverifiable(audit, key, src);
		return;
	}
	const up = readUpstreamManifest(marketplaceDir, src.rel, entry.gitCommitSha);
	if ("unverifiable" in up) {
		noteUnverifiable(audit, key, up);
		return;
	}
	const cachedAt = path.join(entry.installPath, "hooks/hooks.json");
	let cached = null;
	try {
		cached = fs.readFileSync(cachedAt, "utf8");
	} catch {
		// Absent from the cache, which is a divergence wherever upstream has one.
	}
	audit.compared++;
	if (enabledPlugins[key] === true) {
		collectDroppedHooks(audit.droppedHooks, key, up, {
			text: cached,
			at: cachedAt,
		});
		collectBrokenPluginPaths(
			audit.brokenPluginPaths,
			key,
			entry.installPath,
			cached,
		);
	}
	if (isSameManifest(cached, up.text)) return;
	audit.diverged.push({
		key,
		cachedAt,
		basis: up.basis,
		installPath: entry.installPath,
		cachedBytes: cached === null ? null : cached.length,
		upstreamBytes: up.text === null ? null : up.text.length,
		shape: divergenceShape(cached, up.text),
	});
}

/**
 * @param {ManifestAudit} audit accumulator: the plugin is listed unverifiable, and counted if unreadable
 * @param {string} key
 * @param {{ unverifiable: string, unreadable?: boolean }} why
 */
function noteUnverifiable(audit, key, why) {
	audit.unverifiable.push(`${key} — ${why.unverifiable}`);
	if (why.unreadable) audit.unreadable++;
}

/**
 * Every hook the marketplace's manifest wires that the cached one does not.
 *
 * @param {ManifestAudit["droppedHooks"]} out accumulator: each dropped hook is pushed here
 * @param {string} key
 * @param {{ text: string | null, basis: string }} up
 * @param {{ text: string | null, at: string }} cache the cached manifest and where it sits
 */
function collectDroppedHooks(out, key, up, cache) {
	const { text: cached, at: cachedAt } = cache;
	const upTuples = up.text === null ? new Set() : hookTuples(up.text);
	const cachedTuples = cached === null ? new Set() : hookTuples(cached);
	for (const t of upTuples) {
		if (cachedTuples.has(t)) continue;
		const [event, , command] = t.split("\t");
		out.push({
			key,
			event,
			command,
			cachedAt,
			basis: up.basis,
		});
	}
}

/**
 * @param {ManifestAudit["brokenPluginPaths"]} out accumulator: each faulty hook path is pushed here
 * @param {string} key
 * @param {string} installPath
 * @param {string | null} cached
 */
function collectBrokenPluginPaths(out, key, installPath, cached) {
	let cachedDoc = null;
	if (cached !== null) {
		try {
			cachedDoc = JSON.parse(cached);
		} catch {
			// Unparseable is already a divergence in its own right below;
			// there is no hook set here to walk for path liveness.
		}
	}
	for (const { event, hook } of wiredHooks(cachedDoc))
		for (const { rel, direct } of hookPaths(
			hook.command,
			hook.args,
			"CLAUDE_PLUGIN_ROOT",
		)) {
			const full = path.join(installPath, rel);
			const reason = hookPathFault(full, direct);
			if (reason)
				out.push({
					key,
					event,
					rel,
					full,
					reason,
				});
		}
}

/**
 * What is wrong with a hook's resolved script path, or null where nothing is:
 * absent, not a file, or not executable where the command runs it directly.
 *
 * @param {string} full
 * @param {boolean} direct
 * @returns {HookPathFault | null}
 */
function hookPathFault(full, direct) {
	let st;
	try {
		st = fs.statSync(full);
	} catch {
		return "missing";
	}
	if (!st.isFile()) return "not-a-file";
	if (!direct) return null;
	try {
		fs.accessSync(full, fs.constants.X_OK);
	} catch {
		return "not-executable";
	}
	return null;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["diverged"]} diverged
 */
function reportDiverged(ctx, diverged) {
	for (const d of diverged) {
		ctx.fail(
			"MANIFEST-DIVERGED",
			`${d.key} — ${d.shape}. The runtime reads the cache copy, so what the marketplace declares is not what runs.`,
			{
				plugin: d.key,
				installPath: d.installPath,
				basis: d.basis,
				cachedBytes: d.cachedBytes,
				upstreamBytes: d.upstreamBytes,
			},
		);
		ctx.say(
			`${d.key}: ${d.shape}\n` +
				`  cache:       ${d.cachedAt}\n` +
				`  marketplace: ${d.basis}\n` +
				"  The runtime wires the cache copy; an empty `hooks` object there is not an error path.\n" +
				`  Repair by reinstalling the plugin, or copy the marketplace file over ${d.cachedAt}.\n`,
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["droppedHooks"]} droppedHooks
 */
function reportDroppedHooks(ctx, droppedHooks) {
	const dropKey = droppedHooks
		.map((d) => `${d.key}\t${d.event}\t${d.command}`)
		.sort()
		.join("\n");
	const saidDrop = saidBeforeElseQueue(ctx, "plugin-hook-drop", dropKey);
	if (saidDrop) return;
	for (const d of droppedHooks) {
		ctx.fail(
			"HOOK-DROPPED-IN-PACKAGING",
			`${d.key} ${d.event}: ${d.command} is wired in the marketplace's manifest (${d.basis}) but is absent from the installed manifest — dropped in packaging`,
			{
				plugin: d.key,
				event: d.event,
				command: d.command,
				cachedAt: d.cachedAt,
				basis: d.basis,
			},
		);
		ctx.say(
			`${d.key} ${d.event}: ${d.command} is dropped in packaging —\n` +
				`  wired upstream: ${d.basis}\n` +
				`  absent from:    ${d.cachedAt}\n` +
				"  This core expects that hook; nothing carried it into the installed manifest.\n",
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["brokenPluginPaths"]} brokenPluginPaths
 */
function reportBrokenPluginPaths(ctx, brokenPluginPaths) {
	const pathKey = brokenPluginPaths
		.map((b) => `${b.key}\t${b.event}\t${b.rel}\t${b.reason}`)
		.sort()
		.join("\n");
	const saidPath = saidBeforeElseQueue(ctx, "plugin-hook-path", pathKey);
	if (saidPath) return;
	for (const b of brokenPluginPaths) {
		const tag =
			b.reason === "not-executable"
				? "PLUGIN-HOOK-NOT-EXECUTABLE"
				: "PLUGIN-HOOK-PATH-MISSING";
		const message = buildBrokenPluginPathMessage(b);
		ctx.fail(tag, message, {
			plugin: b.key,
			event: b.event,
			path: b.rel,
			resolved: b.full,
		});
		ctx.say(`${message}\n  resolved: ${b.full}\n`);
	}
}

/**
 * @param {ManifestAudit["brokenPluginPaths"][number]} b
 * @returns {string}
 */
function buildBrokenPluginPathMessage(b) {
	if (b.reason === "not-executable")
		return `${b.key} ${b.event}: ${b.rel} is not executable under the plugin root, and the command runs it directly`;
	if (b.reason === "not-a-file")
		return `${b.key} ${b.event}: ${b.rel} is not a file under the plugin root`;
	return `${b.key} ${b.event}: ${b.rel} does not exist under the plugin root, so this plugin-hosted hook never runs`;
}

/* The interpreters whose script argument needs no exec bit. Matched on the
 * basename, so `/usr/bin/python3` counts; `env python3 x.py` and `exec node
 * x.js` need no entry, the interpreter still being the token before the path. */
const INTERPRETER_RE = /^(node|sh|bash|dash|zsh|python(\d+(\.\d+)?)?)$/;

/**
 * The repo-relative script paths a registered hook command invokes, each with
 * whether the command runs it directly (so it must be executable) or hands it to
 * an interpreter.
 *
 * Tokens are matched on carrying `CLAUDE_PROJECT_DIR` or opening `scripts/`,
 * which is deliberately wider than a `scripts/<name>.sh` shape: a command that
 * says `"$CLAUDE_PROJECT_DIR"/scrpits/guard-wide-read.sh` is exactly the typo this
 * assertion exists to catch, and a shape-matcher would pass it as no path at all.
 *
 * THE PATH MAY LIVE IN `args`. The exec form's vendor-documented spelling —
 * `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/scripts/x.js"]` — puts no
 * path in `command` at all, so a walk over `command` alone finds nothing to
 * check and the entry escapes HOOK-PATH-MISSING entirely (mantahostels#2106).
 *
 * GENERALISED TO `rootVar` (mantahostels#3515 F9): a plugin-hosted hook's command carries
 * `${CLAUDE_PLUGIN_ROOT}` rather than `${CLAUDE_PROJECT_DIR}`, and has no
 * reason to open with a bare `scripts/` — that second, wider match is kept
 * only for the default token, where it is the registration typo this
 * assertion exists to catch.
 *
 * @param {string} command
 * @param {string[] | string} [args] the entry's `args`, where it is in exec form
 * @param {string} [rootVar] the env var a hook command roots its script path
 *   on — `CLAUDE_PROJECT_DIR` for this repo's own registration, `CLAUDE_PLUGIN_ROOT` for a
 *   plugin's own hooks.json
 * @returns {Array<{ rel: string, direct: boolean }>}
 */
function hookPaths(command, args, rootVar = "CLAUDE_PROJECT_DIR") {
	/** @type {string[]} */
	let argv = [];
	if (typeof args === "string") argv = [args];
	else if (Array.isArray(args)) argv = args;
	const tokens = [...command.split(/\s+/), ...argv].filter(Boolean);
	/** @type {Array<{ rel: string, direct: boolean }>} */
	const out = [];
	let lastPathAt = -1;
	for (const [i, token] of tokens.entries()) {
		const rel = scriptRel(token, rootVar);
		if (!rel) continue;
		// A `cd` into the project root followed by `node scripts/x.js` puts the
		// interpreter one token earlier; a bare path is run directly. The scan
		// steps back over the interpreter's OWN flags — `node --enable-source-maps
		// scripts/x.js` — which otherwise read as the preceding token and make the
		// script look directly invoked, raising a false HOOK-NOT-EXECUTABLE in a
		// gate (mantahostels#2106).
		const j = precedingNonFlag(tokens, i);
		const prev = (tokens[j] || "").replace(/["']/g, "");
		// A path handed to a script that ran just before it is that script's
		// argument, and the wrapper decides how to run it — `at-trunk.sh
		// scripts/x.js` runs x.js through node (workflow-core#83). Residual: a wrapper that
		// `exec "$@"`s its argument unchanged now passes a non-executable one.
		const wrapped = j >= 0 && j === lastPathAt;
		lastPathAt = i;
		out.push({
			rel,
			direct: !wrapped && !INTERPRETER_RE.test(path.basename(prev)),
		});
	}
	return out;
}

/**
 * The root-relative script path one command token names, or "" where it names
 * none.
 *
 * @param {string} token
 * @param {string} rootVar
 * @returns {string}
 */
function scriptRel(token, rootVar) {
	const bare = token.replace(/["']/g, "");
	const bareScripts =
		rootVar === "CLAUDE_PROJECT_DIR" && bare.startsWith("scripts/");
	if (!bare.includes(rootVar) && !bareScripts) return "";
	const rel = bare
		.replace(new RegExp(`^\\$\\{?${rootVar}\\}?/?`), "")
		.replace(/^\/+/, "");
	// `cd "$CLAUDE_PROJECT_DIR"` names the root itself, which is a directory and
	// not a hook.
	if (!rel || rel === "." || rel.includes("$")) return "";
	return rel;
}

/**
 * The index of the nearest token before `i` that is not a flag, or -1.
 *
 * @param {string[]} tokens
 * @param {number} i
 * @returns {number}
 */
function precedingNonFlag(tokens, i) {
	let j = i - 1;
	let prevToken = tokens[j];
	while (prevToken !== undefined) {
		if (!prevToken.replace(/["']/g, "").startsWith("-")) break;
		prevToken = tokens[--j];
	}
	return j;
}

/**
 * Assertion 4. Every hook command this repo registers itself resolves to a
 * file that exists, and is executable where it is invoked directly.
 *
 * Reads the WORKING TREE, not the index: whether a hook can run is a property of
 * the files on this machine right now, and a commit that stages a correct
 * registration over a script that is not executable still leaves every session
 * on this machine running without that hook.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, files: string[] }}
 */
function ownHooksAssertion(ctx) {
	let sources;
	try {
		sources = readOwnHookSources(repoRoot());
	} catch (e) {
		// APPARATUS: the file is there and this could not read it, which
		// mantahostels#155 puts at BROKEN so the gate never goes green over scope it
		// never looked at.
		return ctx.broken(caught(e).message);
	}
	const named = sources.map((s) => ({
		file: path.relative(repoRoot(), s.file),
		hooks: s.settings?.hooks ?? {},
	}));
	let checked = 0;
	// An adopter with no settings.json wires no hooks of its own and so has none
	// to break — a temp fixture and a fresh checkout both look like this.
	for (const { file, hooks } of named)
		for (const { event, ...hook } of flattenHooks(hooks))
			checked += checkOwnHook(ctx, { event, hook, file });
	return { checked, files: named.map((n) => n.file) };
}

/**
 * Check every script path one registered hook names, reporting each fault.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ event: string, hook: import("./lib/core-hooks.js").Hook, file: string }} registered
 * @returns {number} the paths checked
 */
function checkOwnHook(ctx, { event, hook, file }) {
	if (typeof hook.command !== "string") return 0;
	const args =
		typeof hook.args === "string" || Array.isArray(hook.args)
			? hook.args
			: undefined;
	let checked = 0;
	for (const { rel, direct } of hookPaths(hook.command, args)) {
		checked++;
		const fault = hookPathFault(path.join(repoRoot(), rel), direct);
		if (fault)
			reportOwnPathFault(
				ctx,
				{ event, rel, command: hook.command, file },
				fault,
			);
	}
	return checked;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ event: string, rel: string, command: string, file: string }} hookPath
 * @param {HookPathFault} fault
 */
function reportOwnPathFault(ctx, hookPath, fault) {
	const { event, rel, command, file } = hookPath;
	if (fault === "missing") {
		ctx.fail(
			"HOOK-PATH-MISSING",
			`${event}: ${rel} does not exist, so this hook never runs`,
			{ event, path: rel, command },
		);
		ctx.say(
			`${event}: ${rel} does not exist — the hook is wired to nothing.\n` +
				`  Restore the file, or drop its entry from ${file}.`,
		);
		return;
	}
	if (fault === "not-a-file") {
		ctx.fail("HOOK-PATH-MISSING", `${event}: ${rel} is not a file`, {
			event,
			path: rel,
			command,
		});
		ctx.say(`${event}: ${rel} is not a file.`);
		return;
	}
	ctx.fail(
		"HOOK-NOT-EXECUTABLE",
		`${event}: ${rel} is not executable, and the command runs it directly`,
		{ event, path: rel, command },
	);
	ctx.say(`${event}: ${rel} is not executable — fix with  chmod +x ${rel}`);
}

/**
 * The reaper's own record of its last run, one file per config dir, with a row
 * per mode inside it (`live`, `dry`). Written by
 * scripts/reap-finished-sessions.js; nothing else reads it (mantahostels#1931).
 */
const REAP_RUN_FILE = "wfc-reap-run.json";

/*
 * How long a reap run may legitimately be open before an unclosed record is
 * read as a death. Neither mode can honestly reach this: the reaper's
 * registration is `async: true`, where the `timeout` is inert
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md), so a live run ends with
 * the session rather than at a ceiling, and a dry one stops nothing at all.
 */
const REAP_INFLIGHT_MS = 300_000;

/**
 * Assertion 3. A reap run that opened its record and never closed it.
 *
 * The reaper writes the start half before its slow oracle read and the finish
 * half at every exit, so a row carrying `startedAt` and no `finishedAt` is a run
 * that began and died — cancelled at its hook timeout, or killed under it.
 *
 * THE DRY HALF IS WHAT THIS BUYS, AND ONLY THAT HALF. A cancelled DRY run —
 * `admission.js` firing `--dry-run --json` from pick-next, away from any session
 * start — is announced to nobody (mantahostels#1931, which names the field and its one
 * consumer). Reading the record here reports it without giving admission a
 * route it would only fail closed on.
 *
 * WHY `open` CANNOT SEE A STANDING LIVE CANCELLATION (mantahostels#1952). The reaper is a
 * SessionStart hook and its `openRun` rewrites the live row within milliseconds
 * of starting, so the live row read here is whatever the newest session start
 * opened — on a busy machine, never old enough for the `open` check above to
 * call it dead. And the reaper's own warning
 * about its predecessor is printed from inside `reap()`, which `main()` enters
 * only after eagerly evaluating the oracle read — the slow step where a
 * cancelled hook dies — so a reap cancelled THERE is cancelled there again
 * next start and the line never prints.
 *
 * `deaths` IS THE SIGNAL THAT SURVIVES BOTH. `scripts/reap-finished-sessions.js`'s
 * `openRun` carries a count of consecutive un-closed opens forward in the row
 * itself, across the very reopens that erase `startedAt`'s own age — so a
 * single read of `row.deaths` here says what no single read of `row.startedAt`
 * ever could. Reported once it reaches `REAP_LIVE_DEATHS_TO_REPORT`, kept apart
 * from `open` above: the two ask different questions of the same row.
 *
 * `live` ONLY, THOUGH `openRun` CARRIES `deaths` FOR EITHER MODE. `dry` is not
 * reopened at every session start, so `open`'s own age check already catches
 * it dead, and the message this loop prints ("every session start reopens it
 * …") is true of `live` alone — printing it for a `dry` row would misdescribe
 * the very mode it names.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, unfinished: number, chronic: number } | { unavailable: string }}
 */
function reapAssertion(ctx) {
	/** @type {Array<{at: string, mode: string, startedAt: string, ageMs: number}>} */
	const open = [];
	/** @type {Array<{at: string, mode: string, deaths: number, startedAt: string}>} */
	const chronic = [];
	const read = [];
	/* `unread` marks a failure to LOOK, as against a record read whole and found
	 * to be the wrong shape — only the first may hold the stamp open (mantahostels#1981). */
	/** @type {UnreadableRecord[]} */
	const unreadable = [];

	for (const cfg of configDirs()) {
		const at = path.join(cfg, REAP_RUN_FILE);
		// A config dir the reaper has never run under is the ordinary case and
		// must not speak — the file's absence is not a finding (see NOTHING HERE
		// ASSERTS ON THE ABSENCE OF A RECORD above). Anything else is a record
		// this run could not read.
		const { doc, unreadable: skipped } = readRunRecord(at, "mode");
		if (skipped) unreadable.push(skipped);
		if (!doc) continue;
		read.push(at);
		for (const [mode, row] of Object.entries(doc)) {
			const sorted = classifyReapRow(at, mode, row);
			if (sorted.chronic) chronic.push(sorted.chronic);
			if (sorted.open) open.push(sorted.open);
		}
	}

	reportUnreadableRecords(
		ctx,
		{
			which: "reap-record",
			tag: "REAP-RECORD-UNREADABLE",
			consequence: "so a reap that died mid-run cannot be seen here",
		},
		unreadable,
	);

	/* Keyed on file and mode rather than the stamp: a reap cancelled at every
	 * session start opens a fresh record each time, and the standing condition is
	 * one fault, not one per start.
	 *
	 * ABOVE THE UNAVAILABLE RETURN, not below it. An empty set clears the stamp,
	 * and the record file going away is one of the ways a set empties — so
	 * returning first would leave the stamp standing over a fault that could come
	 * back, with its file, identical and silenced.
	 *
	 * BUT NOT WHERE A RECORD COULD NOT BE READ (mantahostels#1981).
	 * saidBeforeElseQueueUnlessUnread gates the CLEAR, never the announcement: a
	 * record refused by a permission bit empties `open`
	 * without the reap being repaired, and clearing on that re-announces the whole
	 * open set at the next start. Same gate the census puts on its own
	 * `unreadable`, and on the `unread` failures alone. */
	const openKey = open
		.map((o) => `${o.at}\t${o.mode}`)
		.sort()
		.join("\n");
	const said = saidBeforeElseQueueUnlessUnread(
		ctx,
		"reap",
		openKey,
		unreadable,
	);

	/* Same key shape as `open` above, and the same reason: a mode chronically
	 * cancelled reopens (and re-deaths) at every session start, so the standing
	 * fault is one, not one per start — and not one per `deaths` value either,
	 * which would re-announce on every further death past the threshold. */
	const chronicKey = chronic
		.map((c) => `${c.at}\t${c.mode}`)
		.sort()
		.join("\n");
	const saidChronic = saidBeforeElseQueueUnlessUnread(
		ctx,
		"reap-chronic",
		chronicKey,
		unreadable,
	);

	if (read.length === 0 && unreadable.length === 0)
		// UNAVAILABLE for the census's reason, above.
		return {
			unavailable: `no ${REAP_RUN_FILE} under any config dir on this machine`,
		};

	reportUnfinishedReaps(ctx, open, said);
	reportChronicReaps(ctx, chronic, saidChronic);

	return {
		checked: read.length,
		unfinished: open.length,
		chronic: chronic.length,
	};
}

/**
 * @typedef {{at: string, why: string, unread: boolean}} UnreadableRecord
 */

/**
 * A run record parsed whole as an object keyed by mode or job, or null where it
 * is absent, unreadable or the wrong shape — the last two returned as
 * `unreadable`, an absent file being the ordinary case and silent.
 *
 * @param {string} at
 * @param {string} keyedBy what the record's keys are, for the wrong-shape reason
 * @returns {{ doc: Record<string, any> | null, unreadable: UnreadableRecord | null }}
 */
function readRunRecord(at, keyedBy) {
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT" && code !== "ENOTDIR")
			return {
				doc: null,
				unreadable: { at, why: message, unread: true },
			};
		return { doc: null, unreadable: null };
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc))
		return {
			doc: null,
			unreadable: {
				at,
				why: `it parsed to ${Array.isArray(doc) ? "an array" : typeof doc}, not an object keyed by ${keyedBy}`,
				unread: false,
			},
		};
	return { doc, unreadable: null };
}

/**
 * Sort one reap-record row into `chronic` and/or `open`, or neither.
 *
 * @param {string} at
 * @param {string} mode
 * @param {any} row
 * @returns {{ open: {at: string, mode: string, startedAt: string, ageMs: number} | null, chronic: {at: string, mode: string, deaths: number, startedAt: string} | null }}
 *   the row's entry for each, null where it is not one
 */
function classifyReapRow(at, mode, row) {
	const neither = { open: null, chronic: null };
	// `!row` and nothing more: a null row would throw on the next line, and
	// every other non-object one falls through the two stamp guards below.
	if (!row) return neither;
	if (row.finishedAt) return neither;
	if (typeof row.startedAt !== "string") return neither;
	/* `live` only — see reapAssertion's own docstring. Unlike `open` below,
	 * not gated on age: `deaths` already excludes an open still inside ITS
	 * OWN grace (lib/reaper.js's `openedRecord` does that counting),
	 * so a row read here with `deaths` past the threshold is chronic
	 * regardless of how old this particular reopen is. */
	const chronic =
		mode === "live" &&
		Number.isFinite(row.deaths) &&
		row.deaths >= REAP_LIVE_DEATHS_TO_REPORT
			? { at, mode, deaths: row.deaths, startedAt: row.startedAt }
			: null;
	const startedMs = Date.parse(row.startedAt);
	// An unparseable stamp cannot be aged, so it cannot be told from a run in
	// flight.
	if (!Number.isFinite(startedMs)) return { open: null, chronic };
	const ageMs = Date.now() - startedMs;
	if (ageMs < REAP_INFLIGHT_MS) return { open: null, chronic };
	return { open: { at, mode, startedAt: row.startedAt, ageMs }, chronic };
}

/**
 * Warn each run record that could not be read, and say it once per set.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ which: string, tag: string, consequence: string }} kind the stamp
 *   name, the warning's tag, and the clause after the reason saying what goes unseen
 * @param {UnreadableRecord[]} unreadable
 */
function reportUnreadableRecords(ctx, kind, unreadable) {
	const { which, tag, consequence } = kind;
	const saidUnreadable = saidBeforeElseQueue(
		ctx,
		which,
		unreadable
			.map((u) => u.at)
			.sort()
			.join("\n"),
	);
	for (const u of unreadable) {
		const message = `${u.at} could not be read — ${u.why}, ${consequence}`;
		ctx.warn(tag, message, { file: u.at });
		if (!saidUnreadable && !ctx.inActions) ctx.say(message);
	}
}

/**
 * `saidBeforeElseQueue`, except that an empty key may not clear the stamp while a
 * record could not be READ — that reads as not said (mantahostels#1981, mantahostels#2108).
 * On the `unread` failures alone: a record parsed whole and found to be the
 * wrong shape is a STANDING corruption, and gating on it would hold the stamp
 * open for good.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {string} key
 * @param {UnreadableRecord[]} unreadable
 */
function saidBeforeElseQueueUnlessUnread(ctx, which, key, unreadable) {
	return key || !unreadable.some((u) => u.unread)
		? saidBeforeElseQueue(ctx, which, key)
		: false;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, mode: string, startedAt: string, ageMs: number}>} open
 * @param {boolean} said
 */
function reportUnfinishedReaps(ctx, open, said) {
	for (const o of open) {
		const mins = Math.round(o.ageMs / 60_000);
		const message = `the ${o.mode} reap recorded in ${o.at} started ${o.startedAt} (${mins} min ago) and never finished`;
		ctx.warn("REAP-UNFINISHED", message, {
			file: o.at,
			mode: o.mode,
			startedAt: o.startedAt,
		});
		if (!said && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  it was cancelled or died mid-run, so any session it should have stopped is still resident\n" +
					"  and pick-next is admitting against memory that is not really spent.\n" +
					`  Run it by hand with no timeout on it:  node scripts/reap-finished-sessions.js${o.mode === "dry" ? " --dry-run" : ""}`,
			);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, mode: string, deaths: number, startedAt: string}>} chronic
 * @param {boolean} saidChronic
 */
function reportChronicReaps(ctx, chronic, saidChronic) {
	for (const c of chronic) {
		const message = `the ${c.mode} reap recorded in ${c.at} has opened a record and failed to close it on ${c.deaths} consecutive session starts (most recently ${c.startedAt})`;
		ctx.warn("REAP-LIVE-CANCELLED", message, {
			file: c.at,
			mode: c.mode,
			deaths: c.deaths,
			startedAt: c.startedAt,
		});
		if (!saidChronic && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  every session start reopens it before this checker can read the age of the one it\n" +
					"  cancelled, so a single row never ages into the check above; this counts the reopens\n" +
					"  instead. Any session it should have stopped is still resident, and pick-next is\n" +
					"  admitting against memory that is not really spent.\n" +
					// Always `live`, this loop's own gate above having excluded `dry`.
					"  Run it by hand with no timeout on it:  node scripts/reap-finished-sessions.js",
			);
	}
}

/**
 * The completion records the three DETACHED session-start children leave, one
 * file per config dir, keyed by job. Written by scripts/lib/detached-run.js,
 * which owns the shape and the counting rule (mantahostels#1910).
 */
const {
	DEATHS_TO_REPORT,
	RUN_FILE: DETACHED_RUN_FILE,
	JOB_PRUNE_MARKERS,
	JOB_DEBT_SWEEP,
	JOB_RETIRE_STALE_CONTAINERS,
} = detachedRun;

/**
 * Assertion 5. A detached session-start child that has stopped coming back.
 *
 * WHY IT IS NOT ASSERTION 3 OVER AGAIN. The reaper runs in the foreground of its
 * hook, so a cancellation shows up as one unclosed row and the transcript
 * carries a `hook_cancelled` record beside it. These three are spawned detached
 * under `stdio: "ignore"` (mantahostels#1899, mantahostels#1251, mantahostels#1632): the launching hook returns 0
 * whatever the child does, no transcript record is written, and a single
 * unclosed row is the ordinary shape of a machine running 10-12 sessions at
 * once. So the finding is a COUNT of consecutive starts at which the previous
 * run had already outlived its grace and not returned — detached-run.js's
 * `deaths`.
 *
 * ONE FINDING PER JOB, NEVER PER START: `saidBeforeElseQueue` keys the notice on the
 * set of job names, so the set changing is what makes it speak again.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, dead: number } | { unavailable: string }}
 */
function detachedAssertion(ctx) {
	/** @type {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} */
	const dead = [];
	const read = [];
	/* `unread` marks a failure to LOOK, as against a record read whole and found
	 * to be the wrong shape — only the first may hold the stamp open (mantahostels#2108). */
	/** @type {UnreadableRecord[]} */
	const unreadable = [];

	for (const cfg of configDirs()) {
		const at = path.join(cfg, DETACHED_RUN_FILE);
		// A config dir under which no child has ever recorded itself is the
		// ordinary case and must not speak — the file's absence is not a finding.
		const { doc, unreadable: skipped } = readRunRecord(at, "job");
		if (skipped) unreadable.push(skipped);
		if (!doc) continue;
		read.push(at);
		collectDeadJobs(at, doc, dead);
	}

	reportUnreadableRecords(
		ctx,
		{
			which: "detached-record",
			tag: "DETACHED-RECORD-UNREADABLE",
			consequence:
				"so a detached session-start child that died cannot be seen here",
		},
		unreadable,
	);

	/* ABOVE THE UNAVAILABLE RETURN, BUT NOT WHERE A RECORD COULD NOT BE READ
	 * (mantahostels#2108): both for reapAssertion's reasons. */
	const deadKey = dead
		.map((d) => `${d.at}\t${d.job}`)
		.sort()
		.join("\n");
	const said = saidBeforeElseQueueUnlessUnread(
		ctx,
		"detached",
		deadKey,
		unreadable,
	);

	if (read.length === 0 && unreadable.length === 0)
		return {
			unavailable: `no ${DETACHED_RUN_FILE} under any config dir on this machine`,
		};

	reportDeadJobs(ctx, dead, said);

	return { checked: read.length, dead: dead.length };
}

/**
 * Every job in one detached-run record whose `deaths` has reached the
 * threshold.
 *
 * @param {string} at
 * @param {Record<string, any>} doc
 * @param {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} dead accumulator: each job past the threshold is pushed here
 */
function collectDeadJobs(at, doc, dead) {
	for (const [job, row] of Object.entries(doc)) {
		if (!row) continue;
		const deaths = Number(row.deaths);
		if (!Number.isFinite(deaths) || deaths < DEATHS_TO_REPORT) continue;
		dead.push({
			at,
			job,
			deaths,
			lastFinishedAt:
				typeof row.lastFinishedAt === "string"
					? row.lastFinishedAt
					: "never recorded",
		});
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} dead
 * @param {boolean} said
 */
function reportDeadJobs(ctx, dead, said) {
	for (const d of dead) {
		const message = `the detached ${d.job} recorded in ${d.at} has opened a record and failed to return on ${d.deaths} consecutive session starts (last completed: ${d.lastFinishedAt})`;
		ctx.warn("DETACHED-DEAD", message, {
			file: d.at,
			job: d.job,
			deaths: d.deaths,
		});
		if (!said && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  it is spawned detached and its launching hook returns 0 whatever it does, so nothing else reports this.\n" +
					"  Run it in the foreground, where its error is on the page:\n" +
					`  ${
						DETACHED_HOW[/** @type {keyof typeof DETACHED_HOW} */ (d.job)] ||
						"(unknown job — check scripts/lib/detached-run.js's JOBS)"
					}\n` +
					"  RUNNING IT CLOSES THE ROW, AND THE NEXT SESSION START WILL READ deaths AS 0\n" +
					"  REGARDLESS OF WHAT IT PRINTS (scripts/lib/detached-run.js's openRun) — read\n" +
					"  what it prints before deciding anything is fixed, because doing this\n" +
					"  silences the finding either way.",
			);
	}
}

/**
 * The foreground spelling of each detached job, for the notice to name.
 *
 * KEYED ON detached-run.js's OWN CONSTANTS AND TYPED AGAINST ITS JOBS TUPLE
 * (mantahostels#2001), not a fourth-spelled literal — a job dropped from either side, or
 * added to one and not the other, is then a `tsc` error (§N8) rather than a
 * fifth place silently out of step. Not a runtime check: one would
 * throw at module load, taking down every one of its five assertions on a typo,
 * not just this one.
 * @type {Record<(typeof detachedRun.JOBS)[number], string>}
 */
const DETACHED_HOW = {
	[JOB_PRUNE_MARKERS]: "node scripts/session-arbiter.js prune-markers",
	[JOB_DEBT_SWEEP]: "node scripts/session-arbiter.js debt sweep",
	[JOB_RETIRE_STALE_CONTAINERS]:
		"node scripts/retire-stale-containers.js --dry-run",
};

/**
 * @typedef {{ name: string, run: (ctx: import("./lib/check").Ctx, days: number, budgetMs: number) => any, part: (r: any) => string }} Assertion
 */

/**
 * @type {Assertion}
 */
const OWN_HOOKS_ASSERTION = {
	name: "self-plugin",
	run: (ctx) => ownHooksAssertion(ctx),
	part: (r) => `${r.checked} ${r.files.join(" and ")} hook path(s) resolved`,
};

/**
 * Each assertion by the name `--only` takes: how to run it, and the summary part
 * it adds where it could answer. An assertion that cannot answer returns
 * `{ unavailable }` instead.
 *
 * @type {Map<string, Assertion>}
 */
const ASSERTIONS = new Map(
	/** @type {Assertion[]} */ ([
		{
			name: "census",
			run: (ctx, days, budgetMs) => censusAssertion(ctx, days, budgetMs),
			part: (r) =>
				`${r.covered} of ${r.total} transcript file(s) accounted for (${r.scanned} read this run)`,
		},
		{
			name: "manifest",
			run: (ctx) => manifestAssertion(ctx),
			part: (r) => `${r.compared} plugin manifest(s) compared`,
		},
		{
			name: "reap",
			run: (ctx) => reapAssertion(ctx),
			part: (r) => `${r.checked} reap run record(s) read`,
		},
		{
			name: "detached",
			run: (ctx) => detachedAssertion(ctx),
			part: (r) => `${r.checked} detached run record(s) read`,
		},
		OWN_HOOKS_ASSERTION,
	]).map((a) => [a.name, a]),
);

/**
 * Which assertions this run asks for, in the order they run.
 *
 * --notify runs the four assertions that read ~/.claude and no more. The
 * self-plugin assertion is deliberately not among them: it gates
 * in pre-commit, where it is free, and a second voice on the --notify route
 * would be a second place for it to rot. A hand run runs all five.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {string[]}
 */
function wantedAssertions(ctx) {
	const only = ctx.value("--only", "");
	if (
		only &&
		!["census", "manifest", "self-plugin", "reap", "detached"].includes(only)
	)
		ctx.usageError(
			`--only takes census, manifest, self-plugin, reap or detached, not ${only}.`,
		);
	if (only) return [only];
	if (ctx.notify) return ["census", "manifest", "reap", "detached"];
	return ["census", "manifest", "reap", "detached", "self-plugin"];
}

/**
 * Run one assertion, filing its result under `data` and its summary part or
 * its reason for not answering.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {{ days: number, budgetMs: number, data: Record<string, unknown>, parts: string[], unavailable: string[] }} run accumulator: data, parts and unavailable are filled; days and budgetMs are read
 */
function runAssertion(ctx, which, run) {
	const assertion = ASSERTIONS.get(which) ?? OWN_HOOKS_ASSERTION;
	const r = assertion.run(ctx, run.days, run.budgetMs);
	run.data[assertion.name] = r;
	if ("unavailable" in r)
		run.unavailable.push(`${assertion.name} — ${r.unavailable}`);
	else run.parts.push(assertion.part(r));
}

/**
 * The noun names what was actually found: a run whose only finding was an
 * unreadable config dir still summarised as a hook (mantahostels#1898). Only where ONE
 * tag is present — a mixed set has no noun narrower than the general one.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @returns {string}
 */
function findingNoun(ctx) {
	const tags = new Set(ctx.findings.map((f) => f.tag));
	if (tags.size === 1)
		for (const [tag, noun] of ONLY_TAG_NOUNS) if (tags.has(tag)) return noun;
	return "hook that is wired and not running";
}

/**
 * @type {Array<[string, string]>}
 */
const ONLY_TAG_NOUNS = [
	["CORPUS-UNREADABLE", "config dir the census could not read"],
	["REAP-RECORD-UNREADABLE", "reap run record that could not be read"],
	["DETACHED-RECORD-UNREADABLE", "detached run record that could not be read"],
	[
		"DETACHED-DEAD",
		"detached session-start child that has stopped coming back",
	],
];

runCheck({
	name: "hook-liveness",
	usage:
		"node check-hook-liveness.js [--days <n>] [--budget-ms <n>] [--only <census|manifest|self-plugin|reap|detached>] [--notify]",
	valueFlags: ["--days", "--only", "--budget-ms"],
	run(ctx) {
		const days = ctx.numberValue("--days", DEFAULT_DAYS, "positive");
		const budgetMs = ctx.numberValue(
			"--budget-ms",
			DEFAULT_BUDGET_MS,
			"positive",
		);

		/* Here rather than inside the census, for the reason budgetSpender gives:
		 * a throw out of the first assertion would take the other three with it. */
		const budgetAfter = process.env[BUDGET_AFTER_ENV];
		if (budgetAfter && !/^\d+$/.test(budgetAfter))
			ctx.usageError(
				`${BUDGET_AFTER_ENV} must be a whole number of files, not ${budgetAfter}.`,
			);

		const want = wantedAssertions(ctx);

		/** @type {string[]} */
		const parts = [];
		/** @type {Record<string, unknown>} */
		const data = {};
		/* IN THE `finally` rather than before the return so that the two paths out
		 * of here that are not a return still write: the skip below, which throws,
		 * and an assertion throwing BROKEN after an earlier one has already said
		 * its piece.
		 *
		 * IT IS "AFTER THE REPORT", NOT "ONLY WHERE THERE WAS ONE" (mantahostels#2244). Under
		 * ctx.inActions a warned finding is not said at all, and a run whose
		 * assertions are all unavailable skips having said nothing — both stamp
		 * anyway. */
		try {
			/* An assertion that cannot answer RETURNS its reason rather than throwing,
			 * so it never becomes a finding: a WARN here would put "N hook(s) that are
			 * wired and not running" into every report on a machine that simply
			 * has no transcripts yet, naming nothing. The self-plugin assertion is the one
			 * exception and throws BROKEN — an unreadable tracked file is apparatus,
			 * which mantahostels#155 forbids capping. */
			/** @type {string[]} */
			const unavailable = [];
			for (const which of want)
				runAssertion(ctx, which, { days, budgetMs, data, parts, unavailable });

			// Said, never counted: a run reporting on some assertions where more were
			// asked for reads as a clean bill of health on all of them unless the gap is
			// on the page.
			for (const u of unavailable)
				if (!ctx.notify) ctx.say(`assertion not run: ${u}`);

			if (parts.length === 0)
				ctx.skip(unavailable.join("; ") || "nothing to check.");

			const noun = findingNoun(ctx);
			/* NO `stamp` ON THE RESULT, where every other checker on delivery-stamp.js
			 * carries one: that field is a single signature and this checker holds
			 * eight, one per assertion — carried instead as `stamps`, a name-to-
			 * signature map (mantahostels#2277). Read before the `finally` below clears
			 * `pendingStamps`; this return expression evaluates first. */
			const stamps = Object.fromEntries(pendingStamps);
			return {
				okLine: `every wired hook accounted for — ${parts.join(", ")}.`,
				noun,
				data: { ...data, unavailable },
				stamps,
			};
		} finally {
			flushStamps(ctx);
		}
	},
});
