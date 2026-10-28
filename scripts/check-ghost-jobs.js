#!/usr/bin/env node
/*
 * check-ghost-jobs.js — report a BACKGROUND JOB that never started, or that
 * stopped without ever reaching a terminal state, so it sits in the agents view
 * as "working" for good.
 *
 * Usage:  npm run check:ghost-jobs  [--minutes <n>] [--hung-minutes <n>] [--notify] [--json]
 *
 * WHAT IT IS FOR (mantahostels#1495). A job is created with
 * `state: "working"` and `detail: "starting…"`, and the daemon hands it a
 * pre-warmed spare. Where that spare never initialises a session, the job keeps
 * both values for good: no transcript is written, no pid is registered, and
 * nothing times out a job that never reached its first turn.
 *
 * `firstTerminalAt: null` IS NOT THE TEST, and nor is a stale `updatedAt`. It is
 * set when a job first reaches a terminal state, so it is null for the whole of
 * a healthy run too, and a session mid-suite updates nothing for minutes. The
 * test is LIVENESS.
 *
 * THE ORACLE IS `claude agents --json`, read through lib/agent-liveness.js. A job
 * record enumerates CANDIDATES and never decides whether one is alive: mantahostels#104 ruled
 * ~/.claude/jobs/<id>/state.json unfit for that, CLAUDE_JOB_DIR being cleaned
 * under a session still running, so its absence proves nothing. The inference
 * here runs the other way — a record that is PRESENT, saying "working", about a
 * session the oracle can show no process for.
 *
 * A MISSING pid, NOT A MISSING RECORD, IS THE SIGNATURE, so both cases count:
 * absent from the listing, and listed with nothing behind it.
 *
 * WHICH MAKES `pid` LOAD-BEARING ON A FIELD agent-liveness DOES NOT GUARD,
 * and this report tells its reader to retire a job by hand. That test and the
 * changed-shape guard on it live in lib/hung-jobs.js (#1989), as
 * `ghostTest` and `livenessOf`.
 *
 * THE LIVE-BUT-HUNG CASE IS ITS OWN FINDING (HUNG-JOB, mantahostels#2588). A job that
 * claimed its spare and hung has live processes behind it, so the pid test
 * above passes and it is no ghost — it simply never writes another line. The
 * second test is its TRANSCRIPT: a "working" job the oracle lists with a pid,
 * whose `projects/<project>/<sessionId>.jsonl` under any config dir has not
 * been appended to for `--hung-minutes`, or was never written at all — the
 * second on the shorter `--minutes` window, having no healthy look-alike.
 * Reading roster.json as a second liveness source stays open, not decided (mantahostels#2049).
 *
 * A SESSION WAITING ON A BACKGROUND JOB IS INDISTINGUISHABLE FROM A HUNG ONE.
 * Both hold live processes and write nothing — CLAUDE.md's own waiting rule has
 * a session end its turn and sit silent until a notification wakes it, and a
 * long tool call (a full suite) is silent for minutes too. A THIRD look-alike
 * comes from the seam itself: `findTranscript` reads only the top-level
 * `<sessionId>.jsonl` (lib/transcript.js RESIDUAL), which does not move while a
 * delegated SUBAGENT works, so a session mid-dispatch reads here exactly as a
 * hung one.
 *
 * DEGRADES TO SILENCE, NEVER TO "DEAD". An oracle that will not run, reads short
 * or has changed shape leaves through ctx.skip() and raises no finding.
 *
 * IT REPORTS; A HUMAN DECIDES. WARN, never FAIL, and nothing here writes a job
 * record: a job seconds from its first turn is indistinguishable from outside
 * from one that will never take it, which is what the grace window buys.
 *
 * LOCAL ONLY, AND EVERY PLAN. It reads `jobs/` under every config dir
 * sessionDirs() names — this machine runs three — and asks the local daemon what
 * runs; a CI runner finds neither and reports all-clear for ever.
 *
 * Mutated at mantahostels#1495, ten of them, each failing exactly its own test: dropping the
 * pid half of the liveness test; removing the grace window; sweeping every state
 * rather than "working"; reporting an already-notified ghost again; raising a
 * finding where the oracle refused; dropping the pid-shape guard; restoring the
 * strict self-test; sweeping only the first store; leaving an unreadable record
 * out of the stamp; and removing the own-session skip.
 *
 * The strict self-test that ledger restored was ruled back in at #1558, and its
 * test inverted to pin it.
 *
 * Mutated again at mantahostels#2049, two more, each failing exactly its own test: swapping
 * the roster-route remedy text for a placeholder, and breaking `rosterPath`'s
 * derivation.
 *
 * Mutated again at mantahostels#2588, five more, each failing exactly its own test:
 * dropping the transcript-silence test so a live job is never called hung;
 * calling a job with a FRESH transcript hung anyway; leaving hung jobs out of
 * the delivery signature, which would reprint one on every --notify run; and
 * judging a transcript-less job on `updatedAt`, which the daemon rewrites, so
 * a job that never took a turn would read as fresh for ever; and holding a
 * transcript-LESS job to the four-hour window, which leaves unnamed the very
 * incident the finding was filed on.
 *
 * HUNG-JOB detection is `lib/hung-jobs.js#findHungJobs` (mantahostels#2598), called
 * off the SAME `liveSessions()` listing, so `admission.js` and
 * `dispatch-sessions.sh` share the test without a second `claude agents --json`
 * spawn.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reports a background job stuck in "working" with no live process behind it; --notify alone says each one once. It never clears one; where the refill loop runs, it names the loop as the route that stops one listed with no pid and no transcript (#2467).
 * JUSTIFIED: fail-safe — such a job is invisible to every other checker here, and a run that cannot tell live from finished reports nothing rather than calling a job dead.
 * DEFEAT:    none; --minutes <n> and --hung-minutes <n> move the two windows on a hand run.
 */

const { runCheck } = require("./lib/check");
const { listedAgents } = require("./lib/agent-liveness");
const deliveryStamp = require("./lib/delivery-stamp");
const { pidLock } = require("./lib/pid-lock");
const { loopFiles } = require("./lib/refill-loop");
const {
	GHOST_AFTER_MINUTES,
	HUNG_AFTER_MINUTES,
	jobStores,
	readJobs,
	livenessOf,
	ghostTest,
	findHungJobs,
} = require("./lib/hung-jobs");
const { jobStorePath, rosterPath } = require("./lib/job-paths.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {NonNullable<ReturnType<typeof readJobs>>} Jobs */
/**
 * One parsed state.json, as far as it is read here — `findHungJobs`'s shape.
 * @typedef {NonNullable<Parameters<typeof findHungJobs>[0][number]["rec"]>} JobRecord
 */
/** @typedef {{seat: string, job: string, rec: JobRecord}} WorkingJob */
/** @typedef {ReturnType<typeof ghostOf>} Ghost */
/** @typedef {ReturnType<typeof findHungJobs>[number]} Hung */
/** @typedef {{store: string, job: string, reason: string}} UnreadableJob */

/** This checker's name, shared with its delivery-stamp file. */
const CHECKER = "ghost-jobs";

/**
 * A ghost's identity across runs — its job and session, never its age.
 * @param {{job: string, sessionId: string}} g
 */
const keyOf = (g) => `${g.job}\t${g.sessionId}`;

/**
 * An unreadable record's identity. Namespaced away from keyOf's: nothing repairs
 * one, so unstamped it would reprint on every --notify run for ever.
 * @param {{store: string, job: string}} u
 */
const unreadableKeyOf = (u) => `unreadable\t${u.store}\t${u.job}`;

/**
 * A hung job's identity, namespaced away from `keyOf`'s (mantahostels#2588): the same job
 * can be reported hung today and a ghost tomorrow, and one delivery must not
 * suppress the other.
 * @param {{job: string, sessionId: string}} h
 */
const hungKeyOf = (h) => `hung\t${h.job}\t${h.sessionId}`;

/**
 * The ghost keys already delivered into a session — empty where none were, and
 * empty on a run that is not itself the delivery, so nothing is filtered out.
 * @param {{notify: boolean, persisting: boolean}} ctx
 */
function readNotified(ctx) {
	const raw = deliveryStamp.readSeenStamp(ctx, CHECKER);
	// Not this run's to judge — a hand run, or persist mode — or never stamped.
	if (raw === null) return new Set();
	try {
		const seen = JSON.parse(raw);
		return new Set(Array.isArray(seen) ? seen : []);
	} catch {
		// A stamp that will not parse means report it: a repeat notice is the
		// safe way round.
		return new Set();
	}
}

/**
 * @param {number | null} minutes
 * @param {string} [stem] the state being described — "silent" for a HUNG-JOB,
 *   which is not stuck in the ghost sense: it is alive and saying nothing.
 */
function describeAge(minutes, stem = "stuck") {
	if (minutes === null) return `${stem} since an unreadable time`;
	if (minutes < 90) return `${stem} ${Math.floor(minutes)}m`;
	if (minutes < 48 * 60) return `${stem} ${Math.floor(minutes / 60)}h`;
	return `${stem} ${Math.floor(minutes / 1440)}d`;
}

/**
 * Which sessions are live, as `{ids, pids}` — or `{why}`, the sentence
 * explaining why nothing can be said.
 *
 * STRICT, NOT WAIVED (#1558, ruling as #1390 and #1446 did on its siblings).
 * The `requireSelf: false` waiver exists for a SessionStart caller the daemon
 * has not yet registered. This check runs under `npm run status` and
 * `check:ghost-jobs`: mid-session, where the oracle lists its caller, or from a
 * plain terminal, where there is no self to test. So the waiver could only bite
 * on a genuinely short list — and a live neighbour missing from it reads as a
 * ghost "not listed at all". Strict, that list is skipped unjudged — HUNG-JOB
 * included, though a short list could never invent a hung one.
 * Residual: a plain-terminal run has no self to test, so its short list is
 * still judged and can still name a live neighbour's job a ghost.
 * @returns {ReturnType<typeof livenessOf>}
 */
function liveSessions() {
	/* Tested on `agents` rather than on `why`: the same condition, and the field
	 * actually read below (the idiom pick-next.js:1089 states). */
	const answer = listedAgents();
	if (!answer.agents) return { why: answer.why };

	return livenessOf(answer.agents);
}

/**
 * The finding for one job whose record cannot be judged.
 * @param {{seat: string, job: string}} j
 * @param {string} reason
 * @returns {UnreadableJob}
 */
const unreadableOf = ({ seat, job }, reason) => ({
	store: jobStorePath(seat),
	job,
	reason,
});

/** The finding for one working job judged a ghost. */
function ghostOf(
	/** @type {WorkingJob} */ { seat, job, rec },
	/** @type {string} */ sessionId,
	/** @type {{age: number | null, reason: string}} */ { age, reason },
) {
	return {
		job,
		store: jobStorePath(seat),
		sessionId,
		intent: typeof rec.intent === "string" ? rec.intent : null,
		detail: typeof rec.detail === "string" ? rec.detail : null,
		cwd: typeof rec.cwd === "string" ? rec.cwd : null,
		minutesStuck: age,
		reason,
		// The non-realpath seat `store` is built from, so a symlinked jobs/
		// prints the same path a reader would already be using to find the job.
		rosterPath: rosterPath(seat),
	};
}

/**
 * Judges one working job against the listing: "skip" (live, young-excluded
 * or this session), "young", `{unreadable}` or `{ghost}`.
 * @returns {"skip" | "young" | {unreadable: UnreadableJob} | {ghost: Ghost}}
 */
function judgeJob(
	/** @type {WorkingJob} */ entry,
	/** @type {{ids: Set<string>, pids: Map<string, number>, me: string | undefined, minutes: number}} */ live,
) {
	const { seat, job, rec } = entry;
	const { ids, pids, me, minutes } = live;
	const sessionId = rec.sessionId;
	if (typeof sessionId !== "string" || !sessionId)
		return {
			unreadable: unreadableOf(
				{ seat, job },
				"the record names no session, so nothing can be asked about it",
			),
		};
	// This very session, which the oracle need not list yet.
	if (me && sessionId === me) return "skip";

	// Live-with-pid jobs were already judged above, by findHungJobs.
	const ghost = ghostTest({ ...rec, sessionId }, { ids, pids }, minutes);
	if (ghost === "live") return "skip";
	if (ghost === "young") return "young";
	return { ghost: ghostOf(entry, sessionId, ghost) };
}

/**
 * Judges every working job against the oracle, pushing the ones naming no
 * session onto `unreadable`.
 */
function judgeWorking(
	/** @type {Ctx} */ ctx,
	/** @type {{jobs: Jobs, working: WorkingJob[], unreadable: UnreadableJob[], minutes: number, hungMinutes: number}} */ opts,
) {
	const { jobs, working, unreadable, minutes, hungMinutes } = opts;
	const live = liveSessions();
	if (!live.ids)
		ctx.skip(
			`${live.why}. ${working.length} working job(s) went unjudged — none is being called a ghost or hung on an oracle this run could not read.`,
		);
	// ctx.skip throws, which the checker below cannot see through.
	const ids = /** @type {Set<string>} */ (live.ids);
	const pids = /** @type {Map<string, number>} */ (live.pids);
	const me = process.env.CLAUDE_CODE_SESSION_ID;

	// HUNG-JOB off the SAME listing, in lib/hung-jobs.js (mantahostels#2598) — shared
	// with admission.js and dispatch-sessions.sh, neither of which spawns
	// a second oracle to get it.
	const hung = findHungJobs(jobs, { ids, pids }, { hungMinutes, minutes });

	const ghosts = [];
	let young = 0;
	for (const entry of working) {
		const verdict = judgeJob(entry, { ids, pids, me, minutes });
		if (verdict === "young") young++;
		else if (verdict === "skip") continue;
		else if ("unreadable" in verdict) unreadable.push(verdict.unreadable);
		else ghosts.push(verdict.ghost);
	}
	return { ghosts, hung, young, listed: ids.size };
}

function sayGhosts(
	/** @type {Ctx} */ ctx,
	/** @type {Ghost[]} */ ghosts,
	/** @type {number} */ minutes,
) {
	if (ghosts.length === 0) return;
	ctx.say(
		`GHOST-JOB (${ghosts.length}) — "working" with no live process, over ${minutes}m:`,
	);
	for (const g of ghosts)
		ctx.say(
			`  ${g.intent || "(no intent recorded)"}\n` +
				`    job ${g.job}, session ${g.sessionId}, ${describeAge(g.minutesStuck)}, ${g.reason}\n` +
				`    last said: ${g.detail || "(nothing)"}\n` +
				`    roster: ${g.rosterPath}`,
		);
}

function sayHung(
	/** @type {Ctx} */ ctx,
	/** @type {Hung[]} */ hung,
	/** @type {{minutes: number, hungMinutes: number}} */ {
		minutes,
		hungMinutes,
	},
) {
	if (hung.length === 0) return;
	ctx.say(
		`\nHUNG-JOB (${hung.length}) — "working", alive, and silent: over ${hungMinutes}m with a transcript, over ${minutes}m with none:`,
	);
	for (const h of hung)
		ctx.say(
			`  ${h.intent || "(no intent recorded)"}\n` +
				`    job ${h.job}, session ${h.sessionId}, pid ${h.pid ?? "unknown"}, ${describeAge(h.minutesQuiet, "silent")}\n` +
				`    ${h.reason}\n` +
				`    last said: ${h.detail || "(nothing)"}\n` +
				`    transcript: ${h.transcript || "(never written)"}\n` +
				`    roster: ${h.rosterPath}`,
		);
	ctx.say(
		"\n  A session waiting on a background job looks exactly like this one, so\n" +
			"  read its last turn before retiring it: a `waiting:` hand-off is a live\n" +
			"  session with nothing to say, not a hung one. So is one waiting on a\n" +
			"  SUBAGENT — only the top-level transcript is read here, and it does not\n" +
			"  move for as long as a delegated agent works.\n",
	);
}

/** Says the trailing advice blocks the findings call for. */
function sayAdvice(
	/** @type {Ctx} */ ctx,
	/** @type {{ghosts: Ghost[], hung: Hung[], unreadable: UnreadableJob[]}} */ found,
) {
	const { ghosts, hung, unreadable } = found;
	/* HUNG-JOB is deliberately out of this block: its opening line — that the
	 * job did no work — is the one thing that is NOT true of a job which is
	 * alive and may be mid-tool-call. */
	if (ghosts.length > 0 || unreadable.length > 0)
		ctx.say(
			"\n  Nothing was cleared, and this sweep has no way to clear anything.\n" +
				"  Such a job did no work: check its transcript is absent before believing that.\n" +
				'  Editing state.json\'s "state" to "done" does NOT stop it and does NOT drop it\n' +
				"  from the agents view — the daemon never reads state.json back. That edit only\n" +
				'  hides the job from THIS checker\'s own sweep of "working" records; the job\n' +
				"  stays live in the daemon and in the founder's Working list.\n" +
				"  Keep a copy first — the record is the only account of what it was asked to do.\n",
		);
	const loopPid = pidLock(loopFiles().pid, "refill-loop.js").holder();
	if (ghosts.length > 0 && loopPid !== null)
		ctx.say(
			`  The refill loop (pid ${loopPid}) retires a GHOST-JOB listed with no process\n` +
				"  behind it and no transcript, through `claude stop <short-id>` on its seat,\n" +
				"  on its next tick (#2467). One not listed at all, or with a transcript, it\n" +
				"  leaves to the route below.\n",
		);
	if (ghosts.length > 0 || hung.length > 0)
		ctx.say(
			"  To actually retire a GHOST-JOB or HUNG-JOB above: at its own roster path,\n" +
				'  workers["<short-id>"] carries pid (the bg-pty-host) and replPid (the\n' +
				"  bg-spare). Confirm each against /proc/<pid>/stat field 22\n" +
				"  (procStart/replProcStart) to rule out pid reuse, then SIGTERM both pids —\n" +
				"  that drops the entry from the roster and from `claude agents --json`\n" +
				"  within seconds, with no daemon restart.\n" +
				"  An UNREADABLE-JOB names no session to look up in the roster this way; it\n" +
				"  needs its own investigation before it can be retired at all.\n",
		);
}

/** Warns and says every finding this run reports. */
function report(
	/** @type {Ctx} */ ctx,
	/** @type {{ghosts: Ghost[], hung: Hung[], unreadable: UnreadableJob[], working: number, listed: number, minutes: number, hungMinutes: number}} */ r,
) {
	const { ghosts, hung, unreadable } = r;
	// The header rides the findings: under --notify say() reaches the session's
	// context, so a clean sweep must be silent.
	if (ghosts.length > 0 || unreadable.length > 0 || hung.length > 0)
		ctx.say(
			`Checked ${r.working} working job(s) against ${r.listed} listed session(s).\n`,
		);

	for (const g of ghosts)
		ctx.warn(
			"GHOST-JOB",
			`${g.intent || g.job} — ${describeAge(g.minutesStuck)} in "working", ${g.reason}`,
			g,
		);
	for (const h of hung)
		ctx.warn(
			"HUNG-JOB",
			`${h.intent || h.job} — ${describeAge(h.minutesQuiet, "silent")}, ${h.reason}`,
			h,
		);
	for (const u of unreadable)
		ctx.warn("UNREADABLE-JOB", `${u.job} — ${u.reason}`, u);

	sayGhosts(ctx, ghosts, r.minutes);
	sayHung(ctx, hung, r);
	if (unreadable.length > 0) {
		ctx.say(`\nUNREADABLE-JOB (${unreadable.length}):`);
		for (const u of unreadable) ctx.say(`  ${u.job}\n    ${u.reason}`);
	}
	sayAdvice(ctx, r);
}

runCheck({
	name: CHECKER,
	usage:
		"node check-ghost-jobs.js [--minutes <n>] [--hung-minutes <n>] [--notify] [--json]",
	valueFlags: ["--minutes", "--hung-minutes"],
	run(ctx) {
		const minutes = ctx.numberValue(
			"--minutes",
			GHOST_AFTER_MINUTES,
			"non-negative",
		);
		const hungMinutes = ctx.numberValue(
			"--hung-minutes",
			HUNG_AFTER_MINUTES,
			"non-negative",
		);

		// null is a store that would not open, never an empty one — and the store
		// lives outside the repo, so it is SKIP, not BROKEN.
		const opened = readJobs();
		if (opened === null)
			ctx.skip(
				`no job store under ${jobStores().join(" or ")} could be read, so what is running is unknown — not nothing.`,
			);
		// ctx.skip throws, which the checker below cannot see through.
		const jobs = /** @type {NonNullable<ReturnType<typeof readJobs>>} */ (
			opened
		);
		if (jobs.length === 0)
			return { okLine: "no background jobs are recorded.", data: { jobs: 0 } };

		const working = jobs.filter(
			/** @returns {j is WorkingJob} */ (j) =>
				j.rec && j.rec.state === "working",
		);
		let unreadable = jobs
			.filter((j) => j.unreadable)
			.map((j) => unreadableOf(j, "its state.json would not parse"));

		// Ask only where there is something to ask about: the oracle costs ~465 ms
		// (mantahostels#411, which barred it from a PreToolUse hook on that figure).
		const judged =
			working.length > 0
				? judgeWorking(ctx, { jobs, working, unreadable, minutes, hungMinutes })
				: { ghosts: [], hung: [], young: 0, listed: 0 };
		const { young, listed } = judged;

		/*
		 * --notify reports each finding ONCE. A ghost stands for hours and every
		 * run would otherwise reprint it into the same reader's context.
		 * The stamp holds the set reported, not a high-water mark, so one that
		 * disappears and returns is reported again. Both stores are swept in one
		 * run, so the stamp — one per machine, in notify-report.js's `base()` —
		 * is never half-written by one plan.
		 */
		const standing = judged.ghosts;
		const standingUnreadable = unreadable;
		const standingHung = judged.hung;
		const seen = readNotified(ctx);
		const ghosts = standing.filter((g) => !seen.has(keyOf(g)));
		unreadable = standingUnreadable.filter(
			(u) => !seen.has(unreadableKeyOf(u)),
		);
		const hung = standingHung.filter((h) => !seen.has(hungKeyOf(h)));
		/* Sorted, because this is also the signature the reader compares one
		 * persisted report against the last delivered one by (mantahostels#1975). */
		const signature = JSON.stringify(
			[
				...standing.map(keyOf),
				...standingUnreadable.map(unreadableKeyOf),
				...standingHung.map(hungKeyOf),
			].sort(),
		);

		report(ctx, {
			ghosts,
			hung,
			unreadable,
			working: working.length,
			listed,
			minutes,
			hungMinutes,
		});

		// Stamped only AFTER the report is out: stamping first loses it entirely if
		// this process dies in between, and those findings would be suppressed for
		// good. A no-op under persist mode (mantahostels#1975).
		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			stamp: signature,
			okLine:
				standing.length > 0 || standingHung.length > 0
					? `${standing.length} ghost and ${standingHung.length} hung job(s), every one already reported.`
					: `all ${working.length} working job(s) are backed by a listed session with a process, and none has gone silent.`,
			noun: "ghost job(s)",
			data: {
				hung,
				hungCount: hung.length,
				standingHungCount: standingHung.length,
				hungThresholdMinutes: hungMinutes,
				// `ghosts` is what this run REPORTED, which under --notify excludes any
				// already notified; `standing` is every one that is a ghost now.
				ghosts,
				ghostCount: ghosts.length,
				standingCount: standing.length,
				unreadable,
				young,
				jobs: jobs.length,
				working: working.length,
				listed,
				thresholdMinutes: minutes,
			},
		};
	},
});
