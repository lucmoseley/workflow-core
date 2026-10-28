/*
 * refill-tick.js — one tick of the refill loop (#2012, #2123, spec #1995),
 * with the child processes, files and listings it reads and writes:
 * scripts/refill-loop.js's `run` drives it and its `dry-run` prints one.
 *
 * A TICK: reap (the reaper's --not-a-session mode, since the loop has no
 * session id), stop each job that never started, judge the loop's finished
 * launches for progress, stop each parked one its cause and mode's row says
 * to and label its ticket `parked` (lib/block-act.js, #2699), resume each
 * stopped by a transient API error on its schedule, stopping it between
 * tries (#2705), resume each its host restarted that took no turn and hand
 * one still idle after that to a fresh launch (#2707), read
 * admission, the allowance per seat and what its cap would launch, and
 * founder presence, ask lib/refill-decide.js, and launch each repo's picks
 * through one dispatch-sessions.sh call in its checkout, so that repo's ledger,
 * duplicate drop, memory re-read and allowance cap apply. The decision core
 * is asked first with an empty frontier: the per-repo shortlists cost GitHub
 * calls, so they are read only on a tick that could launch. Before the
 * decision, the landing queue of each served checkout, and of each checkout
 * a recorded launch ran in, is supervised
 * (scripts/supervise-landing.js, #2692): a dead lander started, a stall
 * ticketed, and each earlyoom kill incident that is over is ticketed
 * (scripts/file-memory-kill-tickets.js, #3094). Last, the morning review is
 * filed on the first tick after 07:00, and its reversals are answered on
 * every tick (scripts/answer-review-reversals.js, #2017). Then the tick's line is
 * appended to the concurrency record (lib/concurrency.js, #2497).
 *
 * SEATS, in failover order, are the plan seats `~/.claude/refill-seats`
 * declares (lib/refill-seats.js), else the seat `start` ran on alone. Its
 * overflow seats, read each tick, launch headless `claude -p` billed to a
 * plan's API credits once every plan seat is weekly-full, sized by their
 * budget gate and never probed with `/usage` (#2611, spec #2570). Host
 * configuration, not code, because the plugin ships to adopters. Every
 * listing a tick and its reaper read must span them all
 * (scripts/refill-loop.js's union oracle).
 *
 * A failed read inside a tick is logged and the tick carries on with what it
 * has.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedAgents } = require("./agent-liveness.js");
const { buildDriftLines, readRegistryAgents } = require("./registry-agents.js");
const { readActsBy } = require("./arbiter-store.js");
const { PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { readAllowance } = require("./allowance.js");
const { claudeBin } = require("./claude-bin.js");
const { buildTypedAttach } = require("./claude-attach.js");
const { childFailure, childVerdict } = require("./child-failure.js");
const { parseErrLine, gh } = require("./gh.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const gates = require("./gate-sweep.js");
const { readRecentEntries, release } = require("./dispatch-ledger.js");
const { readJobs } = require("./hung-jobs.js");
const { readSwapHold } = require("./admission.js");
const {
	blockCause,
	resumedIdleSince,
	turnedSince,
} = require("./block-cause.js");
const { parseResumed } = require("./bg-resume.js");
const { stopOn } = require("./claude-stop.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { jobDirPath, readJobRecord } = require("./job-paths.js");
const { setParked } = require("./parked.js");
const { read: readTranscript } = require("./session-transcript.js");
const { mainChainRecords } = require("./transcript.js");
const { hasConfig, resolveKey } = require("./workflow-core-config.js");
const { readLastTypedAt } = require("./presence.js");
const { NOTHING_LAUNCHABLE, decideTick } = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const {
	appendTick,
	concurrencyFiles,
	buildTickRecord,
} = require("./concurrency.js");
const { seatBudget } = require("./overflow-budget.js");
const { readConfiguredSeats, readDeclaredSeats } = require("./refill-seats.js");
const { runOf } = require("./headless-sessions.js");
const {
	checkoutEnv,
	discoverRepos,
	exclusionOf,
	homeDir,
} = require("./refill-repos.js");
const loop = require("./refill-loop.js");
const refillBatch = require("./refill-batch.js");
const blocks = require("./refill-blocks.js");
const { localDate } = require("./morning-review.js");
const { writeFd } = require("./write-fd.js");

/* Every child but the review and the `/usage` probe; untraced. */
const CHILD_TIMEOUT_MS = 120 * 1000;
/* The probe's ceiling plus node's start, so the probe meets its own ceiling
 * and stops its group before this one kills the wrapper; the 15 s is a guess. */
const PROBE_CHILD_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15 * 1000;
/* Untraced: room for the filing's reads of every included repo's closes with
 * their comments, and the reversals answered after it, kept under the
 * dispatch ceiling since it holds the tick: one budget the two review
 * children share. */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
/* The ledger's own hour, ample for one dispatcher call. */
const LEDGER_WINDOW_HOURS = 1;

const SCRIPTS = path.dirname(__dirname);
/* The checkout the loop's own scripts sit in, workflow-core's, whose tracker
 * spec #1995 files the review on. A plugin install has no config there and
 * runs no review. */
const REVIEW_ROOT = path.dirname(SCRIPTS);
const DISPATCHER = path.join(SCRIPTS, "dispatch-sessions.sh");

const files = loop.loopFiles();

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const log = (line) => say(`${new Date().toISOString()} ${line}`);

/** @param {unknown} err */
const parseErrText = (err) =>
	err instanceof Error ? (err.stack ?? err.message) : String(err);

const readControl = () => loop.readControlFile(log);

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 */
function runChild(file, args, opts = {}) {
	const r = spawnSync(file, args, {
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
		...opts,
	});
	const child = {
		status: r.status,
		stdout: String(r.stdout ?? ""),
		stderr: String(r.stderr ?? ""),
		error: r.error,
	};
	return { ...child, ...childVerdict(child) };
}

/**
 * The roots a scope serves now.
 * @param {import("./refill-loop.js").Scope} scope
 */
const servedRoots = (scope) =>
	loop.scopeRoots(scope, () => discoverRepos(homeDir()).included, exclusionOf);

/** @param {boolean} dryRun */
function reapFinished(dryRun) {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "reap-finished-sessions.js"),
		"--not-a-session",
		...(dryRun ? ["--dry-run"] : []),
	]);
	if (r.out) log(blocks.indented(r.out));
	if (r.failed) log(`reap: ${r.failed}`);
}

/**
 * Stop the working jobs with no live process and no transcript past the grace
 * (lib/refill-loop.js's stopNeverStarted, #2467): admission charges each a
 * full session until it goes. The log lines.
 * @param {import("./registry-agents.js").RegistryListing} registry
 */
function stopNeverStarted(registry) {
	return loop.stopNeverStarted(registry, readJobs(), (j) => {
		const r = stopOn(j.seat, j.job);
		return r.ok ? null : r.why;
	});
}

/**
 * Supervise each checkout's landing queue, in that checkout
 * (scripts/supervise-landing.js). A checkout gone since its launch is skipped
 * (#3284).
 * @param {string[]} roots
 */
function superviseLanding(roots) {
	for (const root of roots) {
		if (!hasConfig(root)) continue;
		const r = runChild(
			process.execPath,
			[path.join(SCRIPTS, "supervise-landing.js")],
			{ cwd: root, env: checkoutEnv(root) },
		);
		if (r.out || r.failed)
			log(
				`landing in ${root}: ${r.failed ?? "exit 0"}\n  ${blocks.indented(r.out)}`,
			);
	}
}

/**
 * Ticket each earlyoom kill incident that is over, on the review checkout's
 * tracker (scripts/file-memory-kill-tickets.js, #3094): the kills are the
 * machine's, so one checkout files them. Logged only where it filed or failed.
 */
function fileKillTickets() {
	if (!hasConfig(REVIEW_ROOT)) return;
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, "file-memory-kill-tickets.js")],
		{ cwd: REVIEW_ROOT, env: checkoutEnv(REVIEW_ROOT) },
	);
	if (r.out || r.failed)
		log(`memory kills: ${r.failed ?? "exit 0"}\n  ${blocks.indented(r.out)}`);
}

/**
 * Admission's free slots, read as the dispatcher's re-read reads them
 * (lib/refill-loop.js's FREE_SLOT_ARGS); 0 where it could not judge, so a
 * broken read launches nothing (#2012). `admission` is the verdict behind
 * them, for the concurrency record, or null where it did not read.
 * @returns {{slots: number, admission: any}}
 */
function freeSlots() {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "admission.js"),
		...loop.FREE_SLOT_ARGS,
	]);
	try {
		const verdict = JSON.parse(r.stdout);
		return verdict.ok
			? { slots: Number(verdict.slots) || 0, admission: verdict }
			: { slots: 0, admission: null };
	} catch {
		log(`admission unreadable: ${r.failed ?? ""} ${r.out.split("\n")[0]}`);
		return { slots: 0, admission: null };
	}
}

/**
 * Each seat's reading (lib/refill-loop.js's seatReadingOf). `usage` maps a
 * seat to a printed `/usage`, the fallback when its cache is stale.
 * @param {string[]} seats
 * @param {Map<string, string>} [usage]
 * @returns {import("./refill-loop.js").SeatReading[]}
 */
function seatReadings(seats, usage = new Map()) {
	const now = Date.now();
	return seats.map((seat) =>
		loop.seatReadingOf(
			seat,
			readAllowance({ configDir: seat, usageText: usage.get(seat), now }),
			now,
		),
	);
}

/**
 * A printed `/usage` per seat named, through the dispatcher's own probe
 * (scripts/usage-probe.js, #2306): empty where it found the cache fresh or
 * stopped once it refreshed it, with each probe's outcome. A failed one is
 * logged and leaves that seat unread, so the tick waits on it. Timed out, the
 * wrapper's SIGTERM stops the probe's group too.
 * @param {string[]} seats
 */
function printedUsage(seats) {
	const usage = new Map();
	/** @type {import("./refill-loop.js").Probe[]} */
	const probes = [];
	for (const seat of seats) {
		const r = runChild(
			process.execPath,
			[path.join(SCRIPTS, "usage-probe.js"), "--config-dir", seat],
			{ timeout: PROBE_CHILD_TIMEOUT_MS },
		);
		// Exit 3 is the probe's "none ran, the cache being fresh".
		if (r.failed && r.status !== 3) log(`/usage on ${seat}: ${r.failed}`);
		usage.set(seat, r.stdout);
		probes.push({ seat, outcome: loop.parseProbeOutcome(r.stderr, r.failed) });
	}
	return { usage, probes };
}

/**
 * How many of `members` the dispatcher's allowance cap launches on `seat`,
 * read through the `allowance.js --cap` call it makes, fed the seat's printed
 * `/usage` as the dispatcher feeds its probe's, run in `root` as the
 * dispatcher runs in the checkout it launches into, so both read that host's
 * cost table (#2937); null, logged, where it cannot be sized. A cap the loop
 * could not size off a trustworthy reading logs as a fault.
 * @param {string|undefined} root
 * @param {string} seat
 * @param {number} members
 * @param {string} usageText
 */
function capFits(root, seat, members, usageText) {
	if (root === undefined) {
		log(
			`fault: cap on ${seat} unsized: the loop serves no checkout to size it in`,
		);
		return null;
	}
	const r = runChild(
		process.execPath,
		[
			path.join(SCRIPTS, "allowance.js"),
			...loop.capArgs(seat, members, loop.ceilingsOf(process.env)),
		],
		{
			input: usageText,
			cwd: root,
			env: { ...checkoutEnv(root), CLAUDE_CONFIG_DIR: seat },
		},
	);
	const cap = loop.parseCapFits(r.stdout);
	if (cap.fits === null)
		log(
			`${cap.fault || r.failed ? "fault: " : ""}cap on ${seat} unsized: ${cap.why}${r.failed ? ` (${r.failed})` : ""}`,
		);
	return cap.fits;
}

/**
 * Each seat's reading, refreshed and sized for this tick by
 * lib/refill-loop.js's readSizedSeats; with the refreshing probes' outcomes.
 * Seats are sized before any repo is picked, so against the first served
 * checkout, `root` (#2937). Residual: a launch into a later served checkout
 * whose cost table differs is capped by the dispatcher on that table instead.
 * @param {string[]} seats
 * @param {number} slots
 * @param {string|undefined} root
 */
function readSeats(seats, slots, root) {
	return loop.readSizedSeats(slots, {
		read: (usage) => seatReadings(seats, usage),
		probe: printedUsage,
		sizeOf: (seat, members, usageText) =>
			capFits(root, seat, members, usageText),
	});
}

/**
 * Launch one repo's picks through one dispatcher call (lib/refill-batch.js's
 * launchBatch), logged; the records of those it launched and the reasons for
 * those it refused, with each it tried taken off the gate-judgement queue.
 * @param {import("./refill-decide.js").Launch[]} batch
 */
function launchBatch(batch) {
	const r = refillBatch.launchBatch(batch, {
		dispatcher: DISPATCHER,
		env: process.env,
		run: (call) =>
			runChild(call.file, call.args, {
				cwd: call.cwd,
				env: call.env,
				timeout: call.timeout,
			}),
		entriesOf: (root) => readRecentEntries(root, LEDGER_WINDOW_HOURS).entries,
		sessionOf: headlessSessionOf,
		now: Date.now,
	});
	log(
		`dispatch ${loop.buildLaunchesLine(batch)}: ${r.failed ?? "exit 0"}\n  ${blocks.indented(r.out)}`,
	);
	gates.dropTried(files.gates, r.tried, log);
	return { launched: r.launched, refused: r.refused };
}

/**
 * The session id lib/headless-sessions.js recorded for `jobId` at launch
 * (#2611); undefined for a job it did not launch or a record that will not
 * read, the first listing that shows the job then giving it.
 * @param {string} jobId
 */
function headlessSessionOf(jobId) {
	let record = null;
	try {
		record = runOf(jobId);
	} catch (err) {
		log(`headless record unread for job ${jobId}: ${parseErrText(err)}`);
	}
	return record?.sessionId;
}

/**
 * File the morning review where due, then answer its reversals
 * (scripts/answer-review-reversals.js) in what is left of REVIEW_TIMEOUT_MS,
 * returning the date of the last filing (lib/refill-loop.js's
 * reviewRunRecorded). A missing config at REVIEW_ROOT is logged once a day.
 * @param {string|null} lastRunOn
 * @param {number} now
 */
function runReview(lastRunOn, now) {
	const due = loop.isReviewRunDue(new Date(now), lastRunOn);
	const today = localDate(new Date(now));
	if (!hasConfig(REVIEW_ROOT)) {
		if (due)
			log(
				`morning review: not run, ${REVIEW_ROOT} has no workflow-core config`,
			);
		return due ? today : lastRunOn;
	}
	const deadline = Date.now() + REVIEW_TIMEOUT_MS;
	/* spawnSync reads a timeout of 0 as none, so a spent budget still kills. */
	/** @param {string} script */
	const runInReviewRoot = (script) =>
		runChild(process.execPath, [path.join(SCRIPTS, script)], {
			cwd: REVIEW_ROOT,
			env: checkoutEnv(REVIEW_ROOT),
			timeout: Math.max(deadline - Date.now(), 1),
		});
	const filed = due ? runInReviewRoot("file-morning-review.js") : null;
	if (filed)
		log(
			`morning review: ${filed.failed ?? "exit 0"}\n  ${blocks.indented(filed.out)}`,
		);
	const answered = runInReviewRoot("answer-review-reversals.js");
	if (answered.out || answered.failed)
		log(
			`morning review reversals: ${answered.failed ?? "exit 0"}\n  ${blocks.indented(answered.out)}`,
		);
	return loop.reviewRunRecorded({
		due,
		filed: filed === null ? 0 : filed.status,
		answered: answered.status,
		lastRunOn,
		today,
	});
}

/**
 * The launches judged against this tick's listing (lib/refill-loop.js's
 * judgedLaunches), each newly finished one's acts read from every served
 * repo's store and its own, and logged.
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {string[]} served
 */
function judgeFinished(launches, agents, now, served) {
	return loop.judgedLaunches(launches, agents, now, {
		progressOf: (l) => progressOf(l, served),
		causeOf,
	});
}

/**
 * A finishing launch's acts, read from every served repo's store and its
 * own, and logged.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string[]} served
 */
function progressOf(l, served) {
	const progress = loop.actsOf(
		l,
		[...new Set([...served, l.root])],
		readActsBy,
	);
	log(loop.buildFinishLine({ ...l, ...progress }));
	return progress;
}

/**
 * The job record's fields the classifier reads, for an UNKNOWN's log line.
 * @param {unknown} job
 */
function jobShape(job) {
	if (typeof job !== "object" || job === null) return job;
	const rec = /** @type {Record<string, unknown>} */ (job);
	return Object.fromEntries(
		[
			"state",
			"tempo",
			"detail",
			"needs",
			"needsOverlay",
			"block",
			"inFlight",
			"cliVersion",
		].map((k) => [k, rec[k]]),
	);
}

/** Each launch's last logged UNKNOWN why, by job id or launch name.
 * @type {Map<string, string>} */
const unknownLogged = new Map();

/**
 * A parked launch's block cause (lib/block-cause.js), from its listing row,
 * its job record and its transcript's user and assistant rows; an unread
 * transcript reads UNKNOWN and acts on nothing (#2358 F9), and an UNKNOWN is
 * logged with why, once per launch for each why (#3200).
 * @type {import("./refill-blocks.js").CauseOf}
 */
function causeOf(l, row) {
	const job = readJobRecordOf(l);
	const tail =
		readTranscriptRows(l, job)?.filter(
			(r) => r.type === "user" || r.type === "assistant",
		) ?? null;
	const reading = blockCause({ row, job, tail });
	const why = blocks.unknownNews(
		unknownLogged,
		l.jobId ?? blocks.launchName(l),
		reading,
	);
	if (why !== null)
		log(
			`block unread ${blocks.launchName(l)}: ${why}; row ${JSON.stringify(row)}; job ${JSON.stringify(jobShape(job))}`,
		);
	return reading;
}

/**
 * Label `l`'s issues `parked` in its checkout's tracker; each the label would
 * not go on, with why.
 * @param {import("./refill-loop.js").LoopLaunch} l
 */
function labelParked(l) {
	const tracker = resolveKey("tracker", { root: l.root });
	return l.issues.flatMap((n) => {
		const failed =
			typeof tracker === "string"
				? setParked(tracker, n, true)
				: "no tracker configured";
		return failed ? [{ n, why: failed }] : [];
	});
}

/**
 * Comment `body` on each of `l`'s issues in its checkout's tracker. A failure
 * is logged, never thrown: the comment tells the founder what the loop did
 * (#2359), and the act it reports has already happened.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string} body
 */
function commentOn(l, body) {
	const tracker = resolveKey("tracker", { root: l.root });
	for (const n of l.issues) {
		try {
			if (typeof tracker !== "string") throw new Error("no tracker configured");
			gh(["issue", "comment", String(n), "--repo", tracker, "--body", body]);
		} catch (e) {
			log(`could not comment on #${n}: ${parseErrLine(e)}`);
		}
	}
}

/**
 * `l`'s job's timeline rows (jsonlRows). Null where the file will not read, which
 * reads as the typed resume unseen and falls back to stop and resume, logged.
 * @param {import("./refill-blocks.js").JobLaunch} l
 */
function readTimelineOf(l) {
	const file = path.join(jobDirPath(l.seat, l.jobId), "timeline.jsonl");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		log(`timeline unread for ${l.jobId}: ${parseErrText(e)}`);
		return null;
	}
	return jsonlRows(text);
}

/**
 * The rows of JSONL `text`; a line that will not parse, such as one torn by a
 * write in flight, is skipped.
 * @param {string} text
 * @returns {unknown[]}
 */
const jsonlRows = (text) =>
	text.split("\n").flatMap((line) => {
		try {
			return line ? [JSON.parse(line)] : [];
		} catch {
			/* Skipped, not a fault: typically a line torn by a write in flight (#2707). */
			return [];
		}
	});

/**
 * `l`'s job record, its state.json parsed; null where it has no job or the
 * record will not read.
 * @param {import("./refill-loop.js").LoopLaunch} l
 */
const readJobRecordOf = (l) =>
	l.jobId ? readJobRecord(l.seat, l.jobId) : null;

/**
 * The environment a `claude` call on `l`'s seat runs in: `stop`, `attach` and
 * the job record are scoped to CLAUDE_CONFIG_DIR.
 * @param {import("./refill-loop.js").LoopLaunch} l
 */
const seatEnv = (l) => ({ ...process.env, CLAUDE_CONFIG_DIR: l.seat });

/**
 * Type `prompt` into `l`'s live session through a pseudo-terminal
 * `claude attach` (#2354 F6). Null once typed, else why not.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {string} prompt
 */
function typeResume(l, prompt) {
	const [file, args, opts] = buildTypedAttach(l.jobId, prompt);
	return childFailure(
		runChild(file, args, { ...opts, cwd: l.root, env: seatEnv(l) }),
	);
}

/**
 * `l`'s full session id, the listing's else its job record's, and its job's
 * cwd, else its checkout.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @returns {import("./refill-blocks.js").ResumeTarget}
 */
function readResumeTargetOf(l) {
	const job = /** @type {{sessionId?: unknown, cwd?: unknown}|null} */ (
		readJobRecordOf(l)
	);
	return {
		sessionId:
			l.sessionId ??
			(typeof job?.sessionId === "string" ? job.sessionId : null),
		cwd: typeof job?.cwd === "string" ? job.cwd : l.root,
	};
}

/**
 * `session-arbiter.js <cmd> <n>` as session `sessionId`, in `l`'s checkout;
 * what it printed, or null where it failed.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {"claim-issue"|"release-issue"} cmd
 * @param {number} n
 * @param {string} sessionId
 */
function arbiterAs(l, cmd, n, sessionId) {
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, "session-arbiter.js"), cmd, String(n)],
		{
			cwd: l.root,
			env: { ...checkoutEnv(l.root), CLAUDE_CODE_SESSION_ID: sessionId },
		},
	);
	if (!r.failed) return r.out;
	log(`${cmd} #${n} as ${sessionId} failed: ${childFailure(r)}`);
	return null;
}

/**
 * Move each issue claim session `from` holds on `l`'s issues to its copy's
 * session `to` (#2963).
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {string} from
 * @param {string} to
 */
function moveClaims(l, from, to) {
	for (const n of l.issues)
		if (arbiterAs(l, "release-issue", n, from)?.startsWith("Released"))
			arbiterAs(l, "claim-issue", n, to);
}

/**
 * `claude --bg --resume <full id> "<prompt>"` of `l`'s stopped job, from its
 * cwd (#2354 F6). The launcher exits 0 whatever happens (F8). On 2.1.310 it
 * wakes a stopped job in place, else starts a copy under a new job and
 * session id, which carries the conversation on and takes the issue claims
 * (#2963, #2968). The resume counts where the launcher named the job it
 * started (lib/bg-resume.js) and that job's state.json does not read failed;
 * a later tick judges the resumed turn.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {string} prompt
 * @param {{sessionId: string, cwd: string}} target
 * @returns {import("./refill-blocks.js").Resumed}
 */
function resumeStopped(l, prompt, { sessionId, cwd }) {
	const env = seatEnv(l);
	const refusal = launchAuthRefusal({ bin: claudeBin(), env, cwd });
	if (refusal) return { failed: refusal };
	const r = runChild(claudeBin(), ["--bg", "--resume", sessionId, prompt], {
		cwd,
		env,
	});
	const failed = childFailure(r);
	if (failed) return { failed };
	const started = parseResumed(r);
	if (!started)
		return {
			failed: `the launcher never said what it started: ${r.out.split("\n").pop()}`,
		};
	const { jobId } = started;
	const after = /** @type {{state?: unknown, detail?: unknown,
		sessionId?: unknown}|null} */ (readJobRecordOf({ ...l, jobId }));
	if (after?.state === "failed")
		return { failed: `state failed: ${after.detail}` };
	if (!started.copy) return { failed: null, jobId, sessionId, copy: false };
	const copySession =
		typeof after?.sessionId === "string" ? after.sessionId : null;
	if (copySession) moveClaims(l, sessionId, copySession);
	else log(`no session id read for copy ${jobId}: its issue claims not moved`);
	return { failed: null, jobId, sessionId: copySession, copy: true };
}

/**
 * Every main-chain row of `l`'s transcript, at the path its job record
 * `job` names; null, logged where the file will not read.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {unknown} job
 * @returns {Record<string, unknown>[]|null}
 */
function readTranscriptRows(l, job) {
	const file = /** @type {{linkScanPath?: unknown}|null} */ (job)?.linkScanPath;
	if (typeof file !== "string") return null;
	try {
		return [...mainChainRecords(readTranscript(file), "main")];
	} catch (e) {
		log(`transcript unread for ${l.jobId}: ${parseErrText(e)}`);
		return null;
	}
}

/**
 * When `l`'s harness restarted it with no turn since, read off its
 * job record and transcript alone (lib/block-cause.js's resumedIdleSince).
 * An unread reading holds its idle count, logged where it holds one: a record
 * that never reads keeps the count until the launch finishes (#2847).
 * @param {import("./refill-loop.js").LoopLaunch & {jobId: string}} l
 */
function idleSinceOf(l) {
	const job = readJobRecordOf(l);
	const rows = readTranscriptRows(l, job);
	const since = resumedIdleSince({ job, rows });
	if (since === "unread" && l.idleResumes)
		log(
			`resumed-idle records unread for ${blocks.launchName(l)}: its idle count held`,
		);
	return since;
}

/**
 * `rescue-sessions.js hand-off` of `l`'s stopped session, run in its
 * checkout: it posts its snapshot as a `**Hand-off:**` comment on each issue
 * and releases its claim.
 * @param {import("./refill-blocks.js").JobLaunch} l
 */
const postHandOff = (l) =>
	runChild(
		process.execPath,
		[
			path.join(SCRIPTS, "rescue-sessions.js"),
			"hand-off",
			"--from",
			l.seat,
			"--job",
			l.jobId,
			...l.issues.flatMap((n) => ["--issue", String(n)]),
		],
		{ cwd: l.root, env: checkoutEnv(l.root) },
	);

/**
 * The I/O lib/refill-blocks.js's acts run through, for a tick serving
 * `served`.
 * @param {string[]} served
 * @returns {import("./refill-blocks.js").BlockIo}
 */
const blockIo = (served) => ({
	stop: stopOn,
	type: typeResume,
	resumeTargetOf: readResumeTargetOf,
	resumeStopped,
	readTimeline: readTimelineOf,
	idleSince: idleSinceOf,
	turnedSince: (l, at) =>
		turnedSince(readTranscriptRows(l, readJobRecordOf(l)), at),
	labelParked,
	comment: commentOn,
	postHandOff,
	release: (l) => release({ jobId: l.copiedFrom ?? l.jobId, root: l.root }),
	progressOf: (l) => progressOf(l, served),
	log,
});

/**
 * The decision, and the shortlist read's size and time, null where it was not
 * read.
 * @param {import("./refill-decide.js").TickInput} input
 * @param {import("./refill-loop.js").Scope} scope
 * @returns {Promise<{decision: import("./refill-decide.js").Decision,
 *   read: import("./refill-loop.js").FrontierRead|null}>}
 */
async function decide(input, scope) {
	const first = decideTick(input);
	/* A tick launching gate judgements alone may still have slots for the
	 * ranking, so it reads the shortlists too. */
	if (
		"stop" in first ||
		(first.idle !== null && first.idle !== NOTHING_LAUNCHABLE)
	)
		return { decision: first, read: null };
	const served = servedRoots(scope);
	for (const d of served.dropped) log(`not served: ${d.root} (${d.why})`);
	const readStart = Date.now();
	const merged = await refillFrontier(served.roots, scope.goals);
	const read = { rows: merged.frontier.length, ms: Date.now() - readStart };
	for (const f of merged.failed)
		log(`shortlist failed in ${f.root}: ${f.error}`);
	for (const h of merged.held)
		log(
			`held outside the loop: ${h.ref} (${h.why}), holding ${h.holds.join(", ")}`,
		);
	const decision = decideTick({
		...input,
		frontier: /** @type {import("./refill-decide.js").MergedRow[]} */ (
			merged.frontier
		),
		retroBundles: merged.retroBundles,
		failedShortlists: merged.failed,
	});
	return { decision, read };
}

/**
 * One tick: its decision and the start it judged against. Under `dryRun`
 * nothing is reaped, launched or written.
 * @param {{dryRun: boolean}} opts
 */
async function tick({ dryRun }) {
	const now = Date.now();
	const control = readControl() ?? {
		startedAt: now,
		/* No control file is a loop nobody started: a real tick stops. */
		stopRequested: !dryRun,
		seats: readConfiguredSeats(),
		scope: loop.parseScope(null),
	};
	reapFinished(dryRun);
	const state = loop.parseState(loop.readJson(files.state, log));
	const served = servedRoots(control.scope).roots;
	/* Relief first, off the registry alone: the CLI listing below can outrun
	 * its caps under the very pressure relief exists for (#2665). */
	const registry = readRegistryAgents();
	if (!dryRun) for (const line of stopNeverStarted(registry)) log(line);
	if (!dryRun) superviseLanding(loop.landingRoots(served, state.launches));
	if (!dryRun) fileKillTickets();
	const agents = listedAgents({ requireSelf: false }).agents ?? null;
	/* Read side by side here anyway, so the undocumented registry the relief
	 * steps trust is checked against the documented listing every tick. */
	if (agents)
		for (const line of buildDriftLines(agents, registry.agents)) log(line);
	const listed = judgeFinished(state.launches, agents, now, served);
	const seen = {
		agents,
		now,
		io: blockIo(served),
		swapHold: readSwapHold(),
	};
	const judged = dryRun
		? listed
		: blocks.actOnIdle(
				blocks.actOnBlocks(listed, control.scope.mode, seen),
				control.scope.mode,
				seen,
			);
	const { slots, admission } = freeSlots();
	const { seats, probes } = readSeats(control.seats, slots, served[0]);
	const overflow = loop.overflowReadings(
		readDeclaredSeats(),
		seats,
		seatBudget,
	);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		startedAt: control.startedAt,
		stopRequested: control.stopRequested,
		frontier: [],
		retroBundles: [],
		running: loop.runningOf(judged),
		freeSlots: slots,
		lastPromptAt: readLastTypedAt(),
		seats,
		overflow,
		history: judged,
		judgements: gates
			.readGateStore(files.gates, log)
			.pending.filter((j) => served.includes(j.root)),
	};
	const { decision, read } = await decide(input, control.scope);
	if (dryRun) return { decision, read, startedAt: control.startedAt, agents };
	const settled = loop.settleTick(
		{ input, decision, state, judged, probes, read },
		{
			readControl,
			launchBatch,
			runReview,
			writeState: (next) => loop.writeJson(files.state, next),
			log,
			now: Date.now,
		},
	);
	if (!appendTick(buildTickRecord({ input, decision: settled, admission })))
		log(`concurrency record: not written to ${concurrencyFiles().record}`);
	return { decision: settled, startedAt: control.startedAt, agents };
}

module.exports = {
	DISPATCHER,
	servedRoots,
	tick,
};
