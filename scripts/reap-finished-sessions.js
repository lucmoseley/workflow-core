#!/usr/bin/env node
/*
 * reap-finished-sessions.js — stops background sessions that have FINISHED but
 * are still resident, so their memory returns to the admission arithmetic.
 *
 * THE PROBLEM (mantahostels#421, which measured it and holds the census). A background
 * session that finishes does not exit: it stays resumable, holding 330-450 MB
 * PSS, so pick-next.js reads the pool as spent memory and admits fewer sessions
 * than fit.
 *
 * WHY STOPPING IS NOT DESTRUCTIVE. Resume is transcript-based
 * (~/.claude/projects/<slug>/<session-id>.jsonl), not process-based, so
 * `claude stop` keeps the conversation for a later `claude attach`. A kill
 * would destroy the host, which is what mantahostels#319 rejected reaping over; measured
 * at mantahostels#492, the live-pool verification.
 *
 * IT READS NO CLI LISTING (#2665). Its pool is lib/registry-agents.js: each
 * seat's registry, pid-verified, joined to its job records. That reader's header says why acting on it
 * is safe here and nowhere that judges a session dead by its absence.
 *
 * IT REAPS ONLY WHAT IT CAN PROVE IS FINISHED, AND DEGRADES TO REAPING NOTHING.
 * Five gates, every one of which must pass:
 *   1. its registry record says `kind: bg` (the listing's `background`) AND
 *      its job record says `state: done` — a session mid-decision reads
 *      `working`;
 *   2. it is not this very session — waived under `--not-a-session`, for a
 *      caller with no session of its own (the refill loop, #2012), and only
 *      where CLAUDE_CODE_SESSION_ID is unset: a session that passes it is
 *      still told apart from the rest;
 *   3. its registry record names a job id — `claude stop` is addressed by that, and
 *      answers anything else with "No job matching" and exit 1;
 *   4. it finished at least GRACE_MS ago (lib/reaper.js, which holds the
 *      gates' code and the constants this header names);
 *   5. its last `claude stop` did not fail inside the retry window that failure
 *      opened — see HOW A STOP THAT FAILED IS LEFT ALONE in lib/reaper.js.
 * Reaping stops entirely on an unset CLAUDE_CODE_SESSION_ID without
 * `--not-a-session`, because gate 2 cannot be applied without knowing which
 * session is this one. A seat whose registry will not read costs that seat's
 * sessions, named in the report, and the rest are reaped. An unreadable claim store costs the
 * naming below and nothing else (mantahostels#747).
 *
 * NO GATE READS `status` (mantahostels#768;
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md):
 * a gate reading `status === "idle"` would exclude finished sessions
 * invisibly — such a session would be a candidate in no reap log.
 *
 * A FILE CLAIM DOES NOT KEEP A SESSION (mantahostels#747).
 * `release --force` cannot serve this case either, its gate being whether the
 * holder is LISTED (mantahostels#411).
 *
 * AND THE CLAIMS ARE NOT RELEASED — nothing here touches a lock. A lock is
 * breakable once its holder's HOST PROCESS is dead (arbiter-core.js's
 * liveEntryIn, which re-resolves the holder's pid against /proc). `claude stop`
 * ends that host, so the lock falls into the ordinary stale class and the next
 * claimant breaks it by the same rule that breaks any dead session's lock.
 *
 * GATE 4 READS A REAL FINISH TIME, NOT A SIGHTING (mantahostels#654, which chose the clock;
 * mantahostels#652, which measured the sources; readFinishAt below).
 * The first session start after a burst finishes reaps it (mantahostels#632, the burst a
 * sighting clock could not reap: only a session start runs this script, so a
 * burst was always sighted at an age of zero). The first-sighting clock
 * survives as the fallback, for a session whose finish time cannot be read.
 *
 * IT REAPS EVERY SEAT, NOT ONLY ITS OWN (#1571). The listing spans every seat,
 * but `claude stop` and the job record are scoped to CLAUDE_CONFIG_DIR. So each
 * session is addressed on the seat whose `jobs/<id>` record names it
 * (lib/claude-stop.js's seatsFor).
 *
 * NO AGE EVER EXPIRES A CLAIM HERE. mantahostels#318 refused claim expiry outright; the
 * grace (lib/reaper.js's GRACE_MS) is an age on a session's own idleness, never on a lock — still
 * true with the claim gate gone (mantahostels#747).
 *
 * Usage: node scripts/reap-finished-sessions.js [--dry-run] [--json] [--notify] [--not-a-session]
 * Runs at every session start, from self-plugin/hooks/hooks.json's SessionStart hooks,
 * and, when the pretest headroom check finds the machine short, from
 * scripts/pretest-reap.js's own call at `npm run test`'s pretest (mantahostels#1840).
 *
 * WHAT IS COVERED, AND WHAT IS NOT. mantahostels#493 holds the mutation-by-mutation
 * roll of what is covered. UNVERIFIED: lib/reaper.js's isFinished `kind` limb,
 * the rest of main()'s readings, and gate 5's `failures &&` conjunct, an equivalent
 * mutant — lib/reaper.js's entryOf gives every non-record row `retryAt: 0`, so `now < retryAt`
 * is false there anyway. Also UNVERIFIED: that `main()` threads its own `runs`
 * read into `openRun` rather than a second `readRuns()` there — the two reads
 * agree outside a concurrent session start, which nothing here reproduces.
 *
 * Exit codes: always 0. A session start must never be blocked by this. The
 * one exception is a command line lib/cli-args.js refuses — exit 2, before
 * anything is read or stopped (#920).
 *
 * IT PERSISTS ITS REPORT UNDER `WFC_NOTIFY_PERSIST=1 … --notify` (mantahostels#2152).
 * See PERSIST MODE below. Without both, every path is exactly as it was; the
 * SessionStart registration passes both.
 *
 * IMPLICIT:  at every session start, runs `claude stop` against OTHER background sessions, on every seat, judged finished but still resident, so their 330-450 MB returns to the admission arithmetic; and writes a record of the run itself to `wfc-reap-run.json` in the session's Claude config dir (`CLAUDE_CONFIG_DIR`, else ~/.claude), whether or not it took anything, and, on any run that can judge, its fallback finish clock to `wfc-reap-state.json` beside it; under persist mode it also writes a report and an open-run record into the shared notify-reports directory under whichever ~/.claude config dir can hold state.
 * JUSTIFIED: fail-safe — a finished session that stays resident is read as spent memory and pick-next admits fewer sessions than fit (mantahostels#421); the conversation is kept and resumable.
 * DEFEAT:    --dry-run exists on the script, but the SessionStart registration does not pass it, so the wired path has no escape.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");

/**
 * @typedef {import("./lib/reaper.js").State} State
 * @typedef {import("./lib/reaper.js").Claims} Claims
 * @typedef {import("./lib/reaper.js").RunRecord} RunRecord
 */
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");
const { jobStatePath, seatsFor, stopSession } = require("./lib/claude-stop.js");
const { registryAgents } = require("./lib/registry-agents.js");
const { readLocks, subjectDirty } = require("./lib/arbiter-store");
const { projectSlug } = require("./lib/project-slug.js");
/* Required eagerly, unlike notify-report.js below: this one pulls in nothing. */
const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { persisting: sharedPersisting } = require("./lib/persist-mode.js");
const { fromEnv: sessionFromEnv } = require("./lib/session-id.js");
/* The judgement and the report, every reading below handed in (#1369). */
const { DEGRADED, openedRecord, reap } = require("./lib/reaper.js");

/* PERSIST MODE (mantahostels#2152, the ticket that joined the reaper to mantahostels#1949's
 * persist-and-replay set).
 *
 * WHY THE REPORT IS FILED HERE RATHER THAN THROUGH runCheck. The other slow
 * SessionStart producers get persistence free from `lib/check.js`'s
 * checker tail (mantahostels#1974); this script is not a member of that family and cannot
 * become one cheaply. It owns its own `--json` document, which
 * `lib/admission.js` parses, and its own exit contract; runCheck owns both, so
 * routing through it would change a machine-read envelope to buy a tail that
 * is a dozen lines here. So the reaper calls `lib/notify-report.js` directly
 * instead.
 *
 * THE GATE ITSELF IS NOT HAND-ROLLED: it is `lib/persist-mode.js` (mantahostels#2252),
 * which `lib/check.js` requires too, so the two cannot drift into giving one
 * producer a different gate. */

/* The name the persisted report and run record are filed under. Same spelling
 * rule as the checker family's `spec.name`: the script's basename without a
 * `check-` prefix it does not have. The reader keys on it. */
const CHECKER = "reap-finished-sessions";

/* The one limb check.js's callers have no use for, their checkers having no dry
 * run: both modes would file under the one CHECKER key, so a hand
 * `--dry-run --notify` would overwrite the live report the next start reads.
 * Excluded rather than given a key of its own, which would leave the reader a
 * second producer that reports at no session start and so reads as permanently
 * wedged. */
const PERSIST_OPTS = { forbid: ["--dry-run"] };

/** @param {string[]} argv */
const persisting = (argv) => sharedPersisting(argv, PERSIST_OPTS);

const statePath = () => path.join(configDir(), "wfc-reap-state.json");

/**
 * A session's proportional set size in MB, or null where it cannot be read.
 * PSS, never RSS: RSS double-counts the pages a repetitive process set shares,
 * so summing it across sessions overstates what stopping them returns (mantahostels#421).
 * Must be read BEFORE the stop — /proc/<pid> is gone afterwards.
 *
 * @param {number|null|undefined} pid
 * @returns {number|null}
 */
function pssMb(pid) {
	try {
		const m = fs
			.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
			.match(/^Pss:\s+(\d+) kB$/m);
		return m ? Math.round(Number(m[1]) / 1024) : null;
	} catch {
		return null;
	}
}

/**
 * When each session was FIRST seen finished — the fallback clock, used only
 * where the finish stamp below cannot be read. The listing carries no idle age,
 * so this has to be remembered between runs. Unreadable state is read as empty,
 * which at a zero grace window delays nothing.
 */
/** @returns {State} */
function readState() {
	try {
		const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
		return s && typeof s === "object" && !Array.isArray(s) ? s : {};
	} catch {
		return {};
	}
}

/** @param {State} state */
function writeState(state) {
	try {
		fs.mkdirSync(configDir(), { recursive: true });
		fs.writeFileSync(statePath(), `${JSON.stringify(state, null, "\t")}\n`);
	} catch {
		/* The clock is an optimisation; losing it is not worth a throw. */
	}
}

/* THE RUN RECORD (mantahostels#1920, the session start whose reaper was cancelled on its own
 * 30 s timeout and reaped none of five eligible sessions).
 *
 * A reap that takes nothing prints nothing and exits 0, and the SessionStart
 * registration ends `|| true`, so a healthy start and a reaper that never ran
 * were byte-identical. Every run now leaves a record of itself: when it started, how many
 * sessions the listing named, and per listed session the `state` read and the
 * gate that turned it away. A run that listed nothing is thereby distinguishable
 * from one whose candidates were all rejected.
 *
 * IT IS NOT IN wfc-reap-state.json. That file's contract is one row per
 * session listed THIS run, rewritten whole each time, so a run of this shape
 * cannot survive `saveState` without a reserved key fighting that contract.
 *
 * TWO RECORDS, LIVE AND DRY. `scripts/lib/admission.js` fires `--dry-run --json`
 * from pick-next, which would otherwise overwrite the session-start record this
 * exists to expose.
 *
 * THE START HALF IS WHAT CATCHES A CANCELLATION. It is written before the listing
 * read and the stops — the slow part, and where a cancelled hook dies — so a record with no
 * `finishedAt` is a run that began and never returned, and the next run of the
 * same mode says so.
 *
 * THE ONLY READER IS scripts/check-hook-liveness.js's `reapAssertion`
 * (mantahostels#1931's own pointer, which that ticket could not land here itself — this
 * file was claimed by a live session and the in-band request went
 * unanswered, so mantahostels#1952 lands it instead). It reads a row's single-run
 * staleness (`startedAt` with no `finishedAt`, aged past its own grace) for
 * the `dry` mode, which is not reopened every session start and so can
 * genuinely sit unfinished long enough to age past it. `live` cannot: this
 * file's own `openRun` reopens that mode at every session start regardless
 * of whether the previous attempt closed, so a `live` row read by the
 * checker is always the current start's — never old enough for a single read
 * to call it dead. `openedSince` and `deaths` (lib/reaper.js's `openedRecord`) are what let the
 * checker see a `live` mode cancelled at consecutive starts anyway: a signal
 * carried across runs in the row itself, not read fresh each time. */
const runPath = () => path.join(configDir(), "wfc-reap-run.json");

/**
 * Consecutive deaths before `check-hook-liveness.js` reports a mode's row.
 *
 * A GUESS, STATED AS ONE (mirroring detached-run.js's DEATHS_TO_REPORT, mantahostels#1999)
 * — no rate for this machine's session-start cadence is derived here either.
 * 3 is past what one burst of concurrent starts against an already-stale row
 * could reach on its own (lib/reaper.js's LIVE_DEATH_GRACE_MS, and its reason — a burst inside
 * the grace counts as at most one death together), while still firing inside
 * a handful of starts on a mode genuinely wedged every time.
 */
const REAP_LIVE_DEATHS_TO_REPORT = 3;

/**
 * Both modes' last records, or `{}` where none can be read.
 *
 * FAILS OPEN, AND THAT COSTS THE WARNING. A record file that will not parse
 * reads as no record at all, so the cancellation this change exists to report
 * goes unreported. Accepted because a throw here blocks a session start, which the file's
 * exit-code contract forbids; the residual is one missed warning per corrupt
 * file, self-clearing at the next run, which writes the file whole.
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
 * Files one record under its own mode, leaving the other mode's alone.
 * Re-reads rather than holding the object from startup, so a run that overlaps
 * another loses only its own mode's row.
 * @param {RunRecord} record
 */
function writeRuns(record) {
	try {
		fs.mkdirSync(configDir(), { recursive: true });
		const all = readRuns();
		all[record.mode] = record;
		fs.writeFileSync(runPath(), `${JSON.stringify(all, null, "\t")}\n`);
	} catch {
		/* Same trade as writeState: a lost record is not worth a throw at a
		 * session start. */
	}
}

/**
 * Opens this run's record and hands back its start half for the caller to close.
 *
 * CALLED BEFORE ANY READING OF THE OUTSIDE WORLD, so a record opened after a
 * read that hung, where a cancelled SessionStart hook dies, is not missing in
 * exactly the case it exists for. Opening it inside reap() does not work:
 * main() evaluates that call's arguments, the listing read among them, before
 * entering it (mantahostels#1920).
 *
 * `runs` IS THE CALLER'S OWN PRIOR READ, NOT A SECOND readRuns() HERE (mantahostels#1952).
 * `main()` already reads the run file once, before this call, to know whether
 * the OTHER mode's record should carry a "previous run unfinished" warning —
 * threading that same read in rather than reading again keeps this file's
 * single-read-of-the-run-file invariant, and matters more than it looks: two
 * independent reads a write apart could disagree under a concurrent session
 * start, and only one of them would then be judging the same prior row `deaths`
 * is meant to be building on.
 *
 * What the record carries, `deaths` and `openedSince` included, is
 * lib/reaper.js's `openedRecord`; this writes it.
 * @param {string[]} argv
 * @param {Record<string, RunRecord>} runs
 * @returns {RunRecord}
 */
function openRun(argv, runs) {
	const record = openedRecord(argv, runs, Date.now());
	writeRuns(record);
	return record;
}

/**
 * What each session holds — `{held, unnamed}`, a Map of session id to the paths
 * it has claimed plus the records whose holder could not be named — or `{why}`
 * where the store cannot be opened at all.
 *
 * THIS DECIDES NOTHING; IT ONLY REPORTS (mantahostels#747). The paths are read to say
 * which locks a stop has just left stale, and which carry uncommitted work.
 * A `{why}` does not refuse the run — see reap() — it only costs the naming.
 *
 * ONE BAD RECORD IS SKIPPED, NOT FATAL (mantahostels#1692): the bad one is named and the
 * rest are judged.
 *
 * THE LIST SAYS ONLY THAT A HOLDER IS UNKNOWN, NEVER WHICH FAULT. A record that
 * will not parse is named by its lock FILENAME, all readLocks() has for it; one
 * that parses but carries no session id is named by the PATH it claims.
 * check-stranded-file-claims.js keeps the two apart and is the reader to go to
 * for which fault a given record has.
 */
/** @returns {Claims} */
function claimHolders() {
	const locks = readLocks();
	if (locks === null)
		return {
			why: "the claim store could not be read, so no session can be shown to hold nothing",
		};

	/** @type {Map<string, string[]>} */
	const held = new Map();
	/** @type {string[]} */
	const unnamed = [];
	for (const l of locks) {
		if (!l || l.unreadable || !l.sessionId) {
			unnamed.push(l?.file ?? l?.path ?? "an unnamed record");
			continue;
		}
		const mine = held.get(l.sessionId) ?? [];
		mine.push(l.path);
		held.set(l.sessionId, mine);
	}
	return { held, unnamed };
}

/**
 * Where a session's transcript lives. The project dir is `projectSlug`'s
 * spelling of its cwd (mantahostels#1982). Derived rather than read from the job record's
 * own `linkScanPath`, which on a RESUMED session still names the transcript it
 * resumed FROM (mantahostels#655).
 *
 * @param {string} seat
 * @param {string} cwd
 * @param {string} sessionId
 */
const transcriptPath = (seat, cwd, sessionId) =>
	path.join(seat, "projects", projectSlug(cwd), `${sessionId}.jsonl`);

/**
 * When a session actually finished, in ms, or null where that cannot be shown.
 *
 * `max(firstTerminalAt, transcript mtime)`, per mantahostels#652 (which measured both) and
 * mantahostels#654 (which chose this clock). Each term alone errs, and in opposite
 * directions: `firstTerminalAt` is stamped at the FIRST terminal transition and
 * is never advanced by a resume, so it reads older than the truth for a session
 * that finished, resumed and finished again; transcript mtime means "last
 * touched", so it reads newer.
 *
 * MUST ONLY BE CALLED ON A SESSION THE ORACLE HAS ALREADY CALLED FINISHED —
 * that gate excludes a session still resumed and working, which reads
 * `working`/`busy`. It does NOT cover the hazard above: a session that
 * finished, resumed and finished AGAIN reads `done`/`idle` and does reach
 * here, carrying its first finish stamp. The mtime term is what bounds that one.
 *
 * BOTH TERMS OR NEITHER. Missing either one gives no max to take, so this
 * returns null and the caller falls back to the observation clock — which
 * reproduces today's behaviour exactly.
 *
 * @param {{id?: string, sessionId: string}} agent
 * @returns {number|null}
 */
function readFinishAt(agent) {
	/* `?? ""` rather than a guard: the one caller reaches here only past its
	 * own `!a.id` gate. */
	const jobId = agent.id ?? "";
	const seat = seatsFor(jobId, agent.sessionId)[0];
	if (!seat) return null;
	let record;
	try {
		record = JSON.parse(fs.readFileSync(jobStatePath(seat, jobId), "utf8"));
	} catch {
		return null;
	}
	const stamp = Date.parse(record?.firstTerminalAt ?? "");
	if (!Number.isFinite(stamp)) return null;
	/* EXPLICIT, because `projectSlug` DEFAULTS a missing cwd to this process's
	 * own — which would resolve a record with no cwd against the reaping
	 * session's transcript directory and hand back somebody else's mtime as
	 * this agent's finish time. Until mantahostels#1982 the same case threw inside
	 * `transcriptPath` and fell into the catch below; a default turned that
	 * throw into a wrong answer. */
	if (!record.cwd) return null;
	try {
		return Math.max(
			stamp,
			fs.statSync(transcriptPath(seat, record.cwd, agent.sessionId)).mtimeMs,
		);
	} catch {
		return null;
	}
}

/**
 * Land a persist-mode run: the report file, then the open run record closed.
 * Both halves are `lib/check.js`'s `persistReport`.
 *
 * CLOSED ONLY WHERE THE REPORT LANDED, so a write that failed leaves the record
 * open and the reader names this run a cancellation rather than reading its
 * silence as nothing to say.
 *
 * A FAILED WRITE FALLS BACK TO STDOUT: notify-report.js degrades to a no-op
 * rather than throwing, so an unwritable state directory would otherwise
 * swallow a reap that stopped a session and told nobody. The fallback reaches a
 * hand run alone — an `async` hook's stdout is discarded.
 *
 * @param {typeof import("./lib/notify-report.js")} notify
 * @param {"OK"|"WARN"|"BROKEN"} outcome
 * @param {string[]} lines
 * @param {number} startedMs
 */
function persistReport(notify, outcome, lines, startedMs) {
	const text = lines.map((line) => `${line}\n`).join("");
	const wrote = notify.writeReport(CHECKER, {
		outcome,
		text,
		durationMs: Date.now() - startedMs,
		// The session whose start ran this hook, for scripts/deliver-to-session.js (#853).
		owner: sessionFromEnv(),
	});
	if (wrote) notify.closeRun(CHECKER);
	// writeFd rather than console.log: this is a hook's pipe, and the run
	// is about to end.
	if (!wrote && text) writeFd(1, text);
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `usage: node ${scriptPath("reap-finished-sessions.js")} [--dry-run] [--json] [--notify] [--not-a-session]

Stops other background sessions that have finished and are still resident.
The conversation is kept: \`claude attach\` resumes it.

  --dry-run  name what would be stopped, and stop nothing
  --json     print the run as one JSON document
  --notify   print the session-start report; lib/persist-mode.js says when it goes to a file
  --not-a-session  the caller is no session, so none is spared as this one;
             ignored where CLAUDE_CODE_SESSION_ID is set`,
	flags: {
		"--dry-run": "boolean",
		"--json": "boolean",
		"--notify": "boolean",
		"--not-a-session": "boolean",
	},
};

/** @param {string[]} argv */
function main(argv) {
	/* First, before any read: every limb below acts on argv. */
	const { flags } = parseOrExit(argv, CLI);
	/* Required lazily, exactly as check.js requires it: only a run that persists
	 * should pay for notify-report.js's dependency tree. */
	const notify = persisting(argv) ? require("./lib/notify-report.js") : null;
	/** @type {string[]} */
	const lines = [];
	/* The reaper keeps its OWN run record (openRun/writeRuns above) as well as
	 * this one, and they answer to different readers: that one tells the reaper's
	 * NEXT run it was cancelled, this one tells the replay reader (mantahostels#1976). */
	if (notify) notify.openRun(CHECKER);
	const began = Date.now();
	/** @type {"OK"|"WARN"|"BROKEN"} */
	let outcome = "OK";
	try {
		/* Both before the deps literal below, which evaluates its listing read
		 * eagerly: the prior record must be read before openRun replaces it, and
		 * the start half must be on disk before anything slow runs. */
		const runs = readRuns();
		const { startedAt } = openRun(argv, runs);
		const verdict = reap({
			argv,
			listed: registryAgents(),
			claims: claimHolders(),
			self:
				process.env.CLAUDE_CODE_SESSION_ID ||
				(flags["--not-a-session"] ? null : undefined),
			now: Date.now(),
			state: readState(),
			stop: stopSession,
			readPss: pssMb,
			saveState: writeState,
			finishAt: readFinishAt,
			isDirty: subjectDirty,
			runs,
			startedAt,
			recordRun: writeRuns,
			/* Buffered rather than printed under persist mode: stdout must stay empty
			 * for an `async` hook, whose stdout the harness discards. */
			log: notify
				? (/** @type {string} */ line) => lines.push(line)
				: console.log,
		});
		/* ANY LINE IS A WARN, deliberately. The reaper is silent unless something
		 * happened — a session stopped, a stop refused, a retry held back, a
		 * previous run cut off — so "it spoke" and "it has a finding" are the same
		 * fact here. BROKEN is the narrower
		 * claim: it ran and could judge nothing at all. */
		if (verdict === DEGRADED) outcome = "BROKEN";
		else if (lines.length > 0) outcome = "WARN";
		else outcome = "OK";
	} catch (e) {
		/* Only a persisting run swallows this. Without persistence a throw reaches
		 * the terminal; with it, an unreported crash is the silence mantahostels#1854 names,
		 * so it is written as the report instead.
		 *
		 * RESIDUAL: this covers the run, never the load. A throw from this file's
		 * own top-level requires happens before any of it, leaving no report and
		 * no open record — the window check.js closes with a require-time
		 * reportCrash and this script does not have.
		 *
		 * The stack, not the message: under an `async` hook the report is the only
		 * place it will ever be printed. */
		if (!notify) throw e;
		outcome = "BROKEN";
		const said = e instanceof Error ? (e.stack ?? e.message) : String(e);
		lines.push(`reap: the run threw and reaped nothing — ${said}`);
	}
	if (notify) persistReport(notify, outcome, lines, began);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { REAP_LIVE_DEATHS_TO_REPORT };
