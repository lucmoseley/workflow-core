#!/usr/bin/env node

const {
	describeAge: describeAgeText,
	MINUTE_MS,
} = require("./lib/age-text.js");
const { now, runCheck } = require("./lib/check");
const { listedAgents } = require("./lib/agent-liveness");
const deliveryStamp = require("./lib/delivery-stamp");
const { pidLock } = require("./lib/pid-lock");
const { loopFiles } = require("./lib/refill-files");
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
const {
	SYNTHETIC_AFTER_MINUTES,
	findSyntheticStops,
} = require("./lib/synthetic-jobs.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {NonNullable<ReturnType<typeof readJobs>>} Jobs */
/**
 * @typedef {NonNullable<Parameters<typeof findHungJobs>[0][number]["rec"]>} JobRecord
 */
/** @typedef {{seat: string, job: string, rec: JobRecord}} WorkingJob */
/** @typedef {ReturnType<typeof ghostOf>} Ghost */
/** @typedef {ReturnType<typeof findHungJobs>[number]} Hung */
/** @typedef {{store: string, job: string, reason: string}} UnreadableJob */
/** @typedef {import("./lib/synthetic-jobs.js").SyntheticJob} SyntheticJob */

const CHECKER = "ghost-jobs";

/**
 * @param {{job: string, sessionId: string}} g
 */
const keyOf = (g) => `${g.job}\t${g.sessionId}`;

/**
 * @param {{store: string, job: string}} u
 */
const unreadableKeyOf = (u) => `unreadable\t${u.store}\t${u.job}`;

/**
 * @param {{job: string, sessionId: string}} h
 */
const hungKeyOf = (h) => `hung\t${h.job}\t${h.sessionId}`;

const SYNTHETIC_KEY = "synthetic\t";
/**
 * @param {{job: string, at: number}} s
 */
const syntheticKeyOf = (s) => `${SYNTHETIC_KEY}${s.job}\t${s.at}`;

/**
 * @param {{notify: boolean, persisting: boolean}} ctx
 */
function readNotified(ctx) {
	const raw = deliveryStamp.readSeenStamp(ctx, CHECKER);
	if (raw === null) return new Set();
	try {
		const seen = JSON.parse(raw);
		return new Set(Array.isArray(seen) ? seen : []);
	} catch {
		return new Set();
	}
}

/**
 * @param {number | null} minutes
 * @param {string} [stem]
 */
function describeAge(minutes, stem = "stuck") {
	if (minutes === null) return `${stem} since an unreadable time`;
	return `${stem} ${describeAgeText(minutes * MINUTE_MS)}`;
}

/**
 * @returns {ReturnType<typeof livenessOf>}
 */
function liveSessions() {
	const answer = listedAgents();
	if (!answer.agents) return { why: answer.why };

	return livenessOf(answer.agents);
}

/**
 * @param {{seat: string, job: string}} j
 * @param {string} reason
 * @returns {UnreadableJob}
 */
const unreadableOf = ({ seat, job }, reason) => ({
	store: jobStorePath(seat),
	job,
	reason,
});

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
		rosterPath: rosterPath(seat),
	};
}

/**
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
	if (me && sessionId === me) return "skip";

	const ghost = ghostTest({ ...rec, sessionId }, { ids, pids }, minutes);
	if (ghost === "live") return "skip";
	if (ghost === "young") return "young";
	return { ghost: ghostOf(entry, sessionId, ghost) };
}

/**
 * @returns {{ghosts: Ghost[], hung: Hung[], young: number, listed: number, unjudged?: string}}
 */
function judgeWorking(
	/** @type {{jobs: Jobs, working: WorkingJob[], unreadable: UnreadableJob[], minutes: number, hungMinutes: number}} */ opts,
) {
	const { jobs, working, unreadable, minutes, hungMinutes } = opts;
	const live = liveSessions();
	if (!live.ids)
		return {
			ghosts: [],
			hung: [],
			young: 0,
			listed: 0,
			unjudged: `${live.why}. ${working.length} working job(s) went unjudged — none is being called a ghost or hung on an oracle this run could not read.`,
		};
	const ids = live.ids;
	const pids = /** @type {Map<string, number>} */ (live.pids);
	const me = process.env.CLAUDE_CODE_SESSION_ID;

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

function sayAdvice(
	/** @type {Ctx} */ ctx,
	/** @type {{ghosts: Ghost[], hung: Hung[], unreadable: UnreadableJob[]}} */ found,
) {
	const { ghosts, hung, unreadable } = found;
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

function saySynthetic(
	/** @type {Ctx} */ ctx,
	/** @type {SyntheticJob[]} */ stops,
) {
	if (stops.length === 0) return;
	ctx.say(
		`\nSYNTHETIC-STOP (${stops.length}) — a background job the harness ended on "No response requested.", over ${SYNTHETIC_AFTER_MINUTES}m: its task is not done.`,
	);
	for (const s of stops)
		ctx.say(
			`  ${s.name}\n` +
				`    job ${s.job}, session ${s.sessionId}, ${describeClaims(s.issues)}\n` +
				`    stopped at ${new Date(s.at).toISOString()}; ${s.loop}\n` +
				`    reopen it: claude attach ${s.job}`,
		);
}

/** @param {number[]|null} issues */
function describeClaims(issues) {
	if (issues === null) return "its claims unread";
	if (issues.length === 0) return "claiming no issue";
	return `claiming ${issues.map((n) => `#${n}`).join(", ")}`;
}

function report(
	/** @type {Ctx} */ ctx,
	/** @type {{ghosts: Ghost[], hung: Hung[], unreadable: UnreadableJob[], synthetic: SyntheticJob[], working: number, listed: number, minutes: number, hungMinutes: number}} */ r,
) {
	const { ghosts, hung, unreadable, synthetic } = r;
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
	for (const s of synthetic)
		ctx.warn(
			"SYNTHETIC-STOP",
			`${s.name} — the harness ended its turn on a synthetic reply at ${new Date(s.at).toISOString()}; ${s.loop}`,
			s,
		);

	sayGhosts(ctx, ghosts, r.minutes);
	sayHung(ctx, hung, r);
	if (unreadable.length > 0) {
		ctx.say(`\nUNREADABLE-JOB (${unreadable.length}):`);
		for (const u of unreadable) ctx.say(`  ${u.job}\n    ${u.reason}`);
	}
	saySynthetic(ctx, synthetic);
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

		const opened = readJobs();
		if (opened === null)
			ctx.skip(
				`no job store under ${jobStores().join(" or ")} could be read, so what is running is unknown — not nothing.`,
			);
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

		const judged =
			working.length > 0
				? judgeWorking({ jobs, working, unreadable, minutes, hungMinutes })
				: { ghosts: [], hung: [], young: 0, listed: 0 };
		const { young, listed } = judged;

		const standing = judged.ghosts;
		const standingUnreadable = unreadable;
		const standingHung = judged.hung;
		const standingSynthetic = findSyntheticStops(jobs, { now: now() });
		const seen = readNotified(ctx);
		const ghosts = standing.filter((g) => !seen.has(keyOf(g)));
		unreadable = standingUnreadable.filter(
			(u) => !seen.has(unreadableKeyOf(u)),
		);
		const hung = standingHung.filter((h) => !seen.has(hungKeyOf(h)));
		const synthetic = standingSynthetic.filter(
			(s) => !seen.has(syntheticKeyOf(s)),
		);
		if (judged.unjudged && synthetic.length === 0) ctx.skip(judged.unjudged);
		const carried = judged.unjudged
			? [...seen].filter((k) => !k.startsWith(SYNTHETIC_KEY))
			: [];
		const signature = JSON.stringify(
			[
				...new Set([
					...standing.map(keyOf),
					...standingUnreadable.map(unreadableKeyOf),
					...standingHung.map(hungKeyOf),
					...standingSynthetic.map(syntheticKeyOf),
					...carried,
				]),
			].sort(),
		);

		if (judged.unjudged && synthetic.length > 0) ctx.say(judged.unjudged);
		report(ctx, {
			ghosts,
			hung,
			unreadable,
			synthetic,
			working: working.length,
			listed,
			minutes,
			hungMinutes,
		});

		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			stamp: signature,
			okLine:
				standing.length > 0 ||
				standingHung.length > 0 ||
				standingSynthetic.length > 0
					? `${standing.length} ghost, ${standingHung.length} hung and ${standingSynthetic.length} synthetic-stopped job(s), every one already reported.`
					: `all ${working.length} working job(s) are backed by a listed session with a process, and none has gone silent.`,
			noun: "ghost job(s)",
			data: {
				hung,
				hungCount: hung.length,
				standingHungCount: standingHung.length,
				hungThresholdMinutes: hungMinutes,
				synthetic,
				standingSyntheticCount: standingSynthetic.length,
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
