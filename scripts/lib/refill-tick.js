/*
 * refill-tick.js — one tick of the refill loop (#2012, #2123, spec #1995),
 * with the child processes, files and listings it reads and writes:
 * scripts/refill-loop.js's `run` drives it and its `dry-run` prints one. The
 * CLI logs through the same say and log, at the same files (#3392).
 *
 * A TICK: reap (the reaper's --not-a-session mode, since the loop has no
 * session id), stop each job that never started, judge the loop's finished
 * launches for progress, stop each parked one its cause and mode's row says
 * to and label its ticket `parked` (lib/block-act.js, #2699), resume each
 * stopped by a transient API error on its schedule, stopping it between
 * tries (#2705), resume each its host restarted that took no turn and hand
 * one still idle after that to a fresh launch (#2707), read
 * admission, the allowance per seat and what its cap would launch, and
 * founder presence, hold, resume or move each blocked on its seat's limit
 * (#3735), ask lib/refill-decide.js, and launch each repo's picks
 * through one dispatch-sessions.sh call in its checkout, so that repo's ledger,
 * duplicate drop, memory re-read and allowance cap apply. The decision core
 * is asked first with an empty frontier: the per-repo shortlists cost GitHub
 * calls, so they are read only on a tick that could launch. Before the
 * decision, the landing queue of each served checkout, and of each checkout
 * a recorded launch ran in, is supervised
 * (scripts/supervise-landing.js, #2692): a dead lander started, a stall
 * ticketed, and each earlyoom kill incident that is over is ticketed
 * (scripts/file-memory-kill-tickets.js, #3094). Last, the morning review is
 * filed from the first tick after 07:00, and its reversals are answered on
 * every tick (scripts/answer-review-reversals.js, #2017), each by a detached
 * runner the tick never waits on (scripts/refill-review-run.js, #3765). Then
 * the tick's line is
 * appended to the concurrency record (lib/concurrency.js, #2497).
 *
 * SEATS, in failover order, are the plan seats `~/.claude/refill-seats`
 * declares (lib/refill-seats.js), else the seat `start` ran on alone. Its
 * overflow seats, read each tick, launch headless `claude -p` billed to a
 * plan's API credits once every plan seat is weekly-full, sized by their
 * budget gate and never probed with `/usage` (#2611, spec #2570). Host
 * configuration, not code, because the plugin ships to adopters. Every
 * listing a tick and its reaper read must span them all
 * (scripts/refill-loop.js's LISTING).
 *
 * A failed read inside a tick is logged and the tick carries on with what it
 * has.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedAgents } = require("./agent-liveness.js");
const { buildDriftLines, readRegistryAgents } = require("./registry-agents.js");
const { readActsBy } = require("./arbiter-store.js");
const { PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { readAllowance } = require("./allowance.js");
const { claudeBin } = require("./claude-bin.js");
const { buildTypedAttach } = require("./claude-attach.js");
const { buildErrorText, caught } = require("./caught.js");
const { childFailure } = require("./child-failure.js");
const { spawnChild } = require("./child-spawn.js");
const { parseErrLine, gh } = require("./gh.js");
const gates = require("./gate-sweep.js");
const {
	readRecentEntries,
	record: recordLaunch,
	release,
} = require("./dispatch-ledger.js");
const { readJobs } = require("./hung-jobs.js");
const { readSwapHold } = require("./admission.js");
const {
	blockCause,
	resumedIdleSince,
	hasRepliedSince,
	hasTurnedSince,
} = require("./block-cause.js");
const { parseResumed } = require("./bg-resume.js");
const { stopOn } = require("./claude-stop.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const {
	jobDirPath,
	readJobCwd,
	readJobRecord,
	shortJobId,
} = require("./job-paths.js");
const { copyTranscript } = require("./seat-move.js");
const { parseJsonl } = require("./jsonl.js");
const {
	newestMarkerListing,
	readParkMarkers,
	readParkedBy,
	setParked,
	writeParkedBy,
} = require("./parked.js");
const { read: readTranscript } = require("./session-transcript.js");
const { mainChainRecords } = require("./transcript.js");
const { hasConfig, resolveKey } = require("./workflow-core-config.js");
const { readLastTyped } = require("./presence.js");
const {
	MODEL,
	NOTHING_LAUNCHABLE,
	decideTick,
	hasRoom,
	isParked,
} = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const {
	appendTick,
	concurrencyFiles,
	buildTickRecord,
} = require("./concurrency.js");
const { seatBudget } = require("./overflow-budget.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
} = require("./refill-seats.js");
const { runOf } = require("./headless-sessions.js");
const {
	checkoutEnv,
	discoverRepos,
	exclusionOf,
	homeDir,
} = require("./refill-repos.js");
const loop = require("./refill-loop.js");
const {
	loopFiles,
	REVIEW_RUNNER,
	readControlChecked,
	readJson,
	readStateFile,
	writeJson,
} = require("./refill-files.js");
const refillBatch = require("./refill-batch.js");
const blocks = require("./refill-blocks.js");
const { sleepSync } = require("./sleep-sync.js");
const { localDate } = require("./morning-review.js");
const { pidLock } = require("./pid-lock.js");
const { PARKED_PROMPT } = require("./loop-prompts.js");
const { writeFd } = require("./write-fd.js");

/* Every child but the `/usage` probe; untraced. */
const CHILD_TIMEOUT_MS = 120 * 1000;
/* The probe's ceiling plus node's start, so the probe meets its own ceiling
 * and stops its group before this one kills the wrapper; the 15 s is a guess. */
const PROBE_CHILD_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15 * 1000;
/* The ledger's own hour, ample for one dispatcher call. */
const LEDGER_WINDOW_HOURS = 1;

const SCRIPTS = path.dirname(__dirname);
/* The checkout the loop's own scripts sit in, workflow-core's, whose tracker
 * spec #1995 files the review on. A plugin install has no config there and
 * runs no review. */
const REVIEW_ROOT = path.dirname(SCRIPTS);
const DISPATCHER = path.join(SCRIPTS, "dispatch-sessions.sh");

const files = loopFiles();

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const log = (line) => say(`${new Date().toISOString()} ${line}`);

const readControl = () => readControlChecked(log);

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 */
const runChild = (file, args, opts = {}) =>
	spawnChild(file, args, { timeout: CHILD_TIMEOUT_MS, ...opts });

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
		if (r.out || r.failed) log(blocks.buildChildLine(`landing in ${root}`, r));
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
	if (r.out || r.failed) log(blocks.buildChildLine("memory kills", r));
}

/**
 * Admission's free slots, read as the dispatcher's re-read reads them
 * (lib/refill-loop.js's FREE_SLOT_ARGS); 0 where it could not judge, so a
 * broken read launches nothing (#2012). `admission` is the verdict behind
 * them, for the concurrency record, or null where it did not read.
 * @returns {{slots: number,
 *   admission: import("./admission.js").AdmissionJson | null}}
 */
function readFreeSlots() {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "admission.js"),
		...loop.FREE_SLOT_ARGS,
	]);
	try {
		/* admission.js's own `--json` shape (writeJson), typed, not checked. */
		/** @type {import("./admission.js").AdmissionJson | {ok: false}} */
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
function readSeatReadings(seats, usage = new Map()) {
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
function readPrintedUsage(seats) {
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
 * @returns {{fits: number, why?: undefined, fault?: undefined}
 *   | {fits: null, why: string, fault: boolean}}
 */
function readCap(root, seat, members, usageText) {
	if (root === undefined)
		return {
			fits: null,
			why: "the loop serves no checkout to size it in",
			fault: true,
		};
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
	if (cap.fits !== null || !r.failed) return cap;
	return { fits: null, why: `${cap.why} (${r.failed})`, fault: true };
}

/**
 * The line naming a cap unsized; a fault where it could not be sized off a
 * trustworthy reading.
 * @param {string} seat
 * @param {{why: string, fault: boolean}} cap
 */
const buildCapUnsizedLine = (seat, cap) =>
	`${cap.fault ? "fault: " : ""}cap on ${seat} unsized: ${cap.why}`;

/**
 * readCap's count for a tick, logged where it is unsized.
 * @param {string|undefined} root
 * @param {string} seat
 * @param {number} members
 * @param {string} usageText
 */
function readCapFits(root, seat, members, usageText) {
	const cap = readCap(root, seat, members, usageText);
	if (cap.fits === null) log(buildCapUnsizedLine(seat, cap));
	return cap.fits;
}

/**
 * Each seat's reading, refreshed and sized for this tick by
 * lib/refill-loop.js's readSizedSeats; with the refreshing probes' outcomes.
 * Seats are sized before any repo is picked, so against the first served
 * checkout, `root` (#2937). Residual: a launch into a later served checkout
 * whose cost table differs is capped by the dispatcher on that table instead.
 * @param {string[]} seats in seat-file order
 * @param {number} slots
 * @param {string|undefined} root
 * @param {{typedSeat: string|null, sizeAll?: boolean}} how  `sizeAll`, each
 *   seat with room sized, for a move
 */
function readSeats(seats, slots, root, { typedSeat, sizeAll = false }) {
	return loop.readSizedSeats(slots, {
		read: (usage) => readSeatReadings(seats, usage),
		probe: readPrintedUsage,
		sizeOf: (seat, members, usageText) =>
			readCapFits(root, seat, members, usageText),
		typedSeat,
		sizeAll,
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
		sessionOf: readHeadlessSession,
		now: Date.now,
	});
	log(blocks.buildChildLine(`dispatch ${loop.buildLaunchesLine(batch)}`, r));
	gates.dropTried(files.gates, r.tried, log);
	return { launched: r.launched, refused: r.refused };
}

/**
 * The session id lib/headless-sessions.js recorded for `jobId` at launch
 * (#2611); undefined for a job it did not launch or a record that will not
 * read, the first listing that shows the job then giving it.
 * @param {string} jobId
 */
function readHeadlessSession(jobId) {
	let record = null;
	try {
		record = runOf(jobId);
	} catch (err) {
		log(`headless record unread for job ${jobId}: ${buildErrorText(err)}`);
	}
	return record?.sessionId;
}

/**
 * The review runner's finished run, moved aside before it is read so a
 * result written meanwhile is never removed unread; null where none waits
 * or it will not parse, which is logged.
 * @returns {import("./refill-loop.js").ReviewResult|null}
 */
function takeReviewResult() {
	const taken = `${files.review}.${process.pid}`;
	try {
		fs.renameSync(files.review, taken);
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
	try {
		return /** @type {import("./refill-loop.js").ReviewResult|null} */ (
			readJson(taken, log)
		);
	} finally {
		fs.rmSync(taken, { force: true });
	}
}

/** Whether a review runner is running now. */
const isReviewRunning = () =>
	pidLock(files.reviewPid, REVIEW_RUNNER).holder() !== null;

/**
 * Take the morning review's step (lib/refill-loop.js's reviewStep), returning
 * the date of the last filing. A missing config at REVIEW_ROOT is
 * logged once a day.
 * @param {string|null} lastRunOn
 * @param {number} now
 */
function runReview(lastRunOn, now) {
	if (!hasConfig(REVIEW_ROOT)) {
		const skip = loop.buildReviewSkip({
			due: loop.isReviewRunDue(new Date(now), lastRunOn),
			root: REVIEW_ROOT,
			lastRunOn,
			today: localDate(new Date(now)),
		});
		for (const line of skip.lines) log(line);
		return skip.runOn;
	}
	/* The holder first: a runner writes its result before letting go (#3765). */
	const running = isReviewRunning();
	const step = loop.reviewStep({
		lastRunOn,
		now: new Date(now),
		running,
		finished: takeReviewResult(),
	});
	for (const line of step.lines) log(line);
	if (step.start) startReview(step.start);
	return step.runOn;
}

/**
 * Start the review runner detached in REVIEW_ROOT, its stderr the loop's
 * log. Fails open (#3765): a failed start is logged and the next tick tries
 * again, so the review never stops the launching. A stop leaves a started run
 * to finish, its result logged on the next start.
 * @param {import("./refill-loop.js").ReviewStart} start
 */
function startReview(start) {
	/** @param {unknown} err */
	const notStarted = (err) =>
		log(`${start.label}: not started (${buildErrorText(err)})`);
	try {
		const child = spawn(
			process.execPath,
			[path.join(SCRIPTS, REVIEW_RUNNER), JSON.stringify(start)],
			{
				cwd: REVIEW_ROOT,
				env: checkoutEnv(REVIEW_ROOT),
				detached: true,
				stdio: ["ignore", "ignore", "inherit"],
			},
		);
		child.on("error", notStarted);
		child.unref();
	} catch (err) {
		notStarted(err);
	}
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
		progressOf: (l) => readProgress(l, served),
		causeOf: readCause,
	});
}

/**
 * A finishing launch's acts, read from every served repo's store and its
 * own, and logged.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string[]} served
 */
function readProgress(l, served) {
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
function readCause(l, row) {
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
 * Add `numbers` to session `sessionId`'s `.parked-` marker in `l`'s checkout,
 * with `l`'s seat, job and cwd for a normal-mode loop to resume (#3709); null
 * once written, else why not. Fails open: an unwritten marker leaves the
 * label for a claim to clear, and the loop line says so (#3584).
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {number} [limitParks]  a limit-cap park's count in a row (#3804)
 */
function recordParked(l, sessionId, numbers, limitParks) {
	try {
		writeParkedBy(sessionId, [...readParkedBy(sessionId, l.root), ...numbers], {
			root: l.root,
			job: l.jobId
				? { seat: l.seat, jobId: l.jobId, cwd: readJobCwd(l.seat, l.jobId) }
				: null,
			limitParks,
		});
		return null;
	} catch (e) {
		return buildErrorText(e);
	}
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
 * `l`'s job's timeline rows. Null where the file will not read, which
 * reads as the typed resume unseen and falls back to stop and resume, logged.
 * @param {import("./refill-blocks.js").JobLaunch} l
 */
function readTimelineOf(l) {
	const file = path.join(jobDirPath(l.seat, l.jobId), "timeline.jsonl");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		log(`timeline unread for ${l.jobId}: ${buildErrorText(e)}`);
		return null;
	}
	return parseJsonl(text).rows;
}

/**
 * `l`'s job record, its state.json parsed; null where it has no job or the
 * record will not read.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "seat"|"jobId">} l
 */
const readJobRecordOf = (l) =>
	l.jobId ? readJobRecord(l.seat, l.jobId) : null;

/**
 * The environment a `claude` call on `l`'s seat runs in: `stop`, `attach` and
 * the job record are scoped to CLAUDE_CONFIG_DIR.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "seat">} l
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
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root">} l
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
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues">} l
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
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat">} l
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
	if (!started.copy) {
		/* A stopped job's record already names its session, so its state says
		 * whether it woke. */
		return after?.sessionId === sessionId && after.state !== "stopped"
			? { failed: null, jobId, sessionId, copy: false }
			: {
					failed: `not confirmed: job ${jobId}'s state.json reads ${after?.state ?? "(unread)"}, session ${after?.sessionId ?? "(unread)"}, not ${sessionId}`,
				};
	}
	const copySession =
		typeof after?.sessionId === "string" ? after.sessionId : null;
	if (copySession) moveClaims(l, sessionId, copySession);
	else log(`no session id read for copy ${jobId}: its issue claims not moved`);
	return { failed: null, jobId, sessionId: copySession, copy: true };
}

/**
 * Remove any job record for session `sessionId`'s short id on seat `seat`
 * (`claude rm`, which keeps transcripts); null once none is left, else why not.
 * @param {string} seat
 * @param {string} sessionId
 * @param {string} cwd
 */
function removeJobRecord(seat, sessionId, cwd) {
	const jobId = shortJobId(sessionId);
	if (!fs.existsSync(jobDirPath(seat, jobId))) return null;
	const failed = childFailure(
		runChild(claudeBin(), ["rm", jobId], {
			cwd,
			env: seatEnv({ seat }),
		}),
	);
	return failed && `removing its stale job record on ${seat}: ${failed}`;
}

/**
 * Carry `l`'s stopped session to seat `target` and resume it there under its
 * own session id (#2159's steps, #3734): its transcript copied, any job record
 * for it on `target` removed so its resume keeps the id instead of starting a
 * copy, then resumeStopped under `target`, which reads back the job's state. A resume that failed may still be starting, so it is
 * stopped, and two live processes never share the id; the old seat's
 * transcript is left whole, for its next try.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {string} target
 * @param {string} prompt
 * @param {{sessionId: string, cwd: string}} ids
 * @returns {import("./refill-blocks.js").Resumed}
 */
function moveSession(l, target, prompt, ids) {
	const { sessionId, cwd } = ids;
	const prepared =
		copyTranscript({ from: l.seat, to: target, sessionId, cwd }) ??
		removeJobRecord(target, sessionId, cwd);
	if (prepared) return { failed: prepared };
	const r = resumeStopped({ ...l, seat: target }, prompt, ids);
	if (r.failed === null) return r;
	const stop = stopOn(target, shortJobId(sessionId));
	if (!stop.ok && !stop.noJob)
		log(`could not stop ${shortJobId(sessionId)}'s failed resume: ${stop.why}`);
	return r;
}

/**
 * Each parked row's park marker, the newest written where several list it,
 * with the seat and job it names and the directory its session resumes in,
 * its marker's, else the checkout holding the marker (#3773).
 * @param {import("./refill-decide.js").MergedRow[]} frontier
 * @returns {import("./refill-decide.js").ParkerReading[]}
 */
function readParkers(frontier) {
	/** @type {Map<string, ReturnType<typeof readParkMarkers>>} */
	const byRoot = new Map();
	const readMarkersIn = (/** @type {string} */ root) => {
		const read = byRoot.get(root) ?? readParkMarkers(root);
		byRoot.set(root, read);
		return read;
	};
	return frontier.flatMap((row) => {
		if (!isParked(row)) return [];
		const marker = newestMarkerListing(readMarkersIn(row.root), row.number);
		if (!marker) return [];
		const { job, sessionId, limitParks } = marker;
		return [
			{
				root: row.root,
				number: row.number,
				sessionId,
				job,
				resumeCwd: job?.cwd ?? row.root,
				...(limitParks === undefined ? {} : { limitParks }),
			},
		];
	});
}

/**
 * Drop `issues` from session `sessionId`'s marker in `root`'s checkout, once
 * a copy carries its conversation on, so no later tick resumes the old one
 * (#3709). Fails open: a marker left names a job a resume then falls back
 * from.
 * @param {string} root
 * @param {string} sessionId
 * @param {number[]} issues
 */
function dropParked(root, sessionId, issues) {
	try {
		writeParkedBy(
			sessionId,
			readParkedBy(sessionId, root).filter((n) => !issues.includes(n)),
			{ root },
		);
	} catch (e) {
		log(`marker of ${sessionId} not trimmed: ${buildErrorText(e)}`);
	}
}

/**
 * `seats` with each parker's seat that has room but no cap sized, sized for
 * one resume: only the first seat with room is sized for the decision, and a
 * resume is held to the same cap as a launch (#3669). In away mode, where none
 * resumes, a cap sized 0 still reads full for the idle alarm's hold (#3850).
 * @param {import("./refill-decide.js").SizedSeat[]} seats
 * @param {import("./refill-decide.js").ParkerReading[]} parkers
 * @param {string|undefined} root the checkout the cap is sized in
 */
const sizeParkerSeats = (seats, parkers, root) =>
	seats.map((s) =>
		s.fits === null && hasRoom(s) && parkers.some((p) => p.job?.seat === s.seat)
			? { ...s, fits: readCapFits(root, s.seat, 1, "") }
			: s,
	);

/**
 * `batch` launched (lib/refill-batch.js's launchOrResume): each parked member
 * routed to resume resumed in place (resumeStopped), the rest through one
 * dispatcher call (launchBatch).
 * @param {import("./refill-decide.js").Launch[]} batch
 */
const launchOrResume = (batch) =>
	refillBatch.launchOrResume(batch, {
		resume: ({ root, issues }, { seat, sessionId, cwd }) => {
			const r = resumeStopped({ root, issues, seat }, PARKED_PROMPT, {
				sessionId,
				cwd,
			});
			if (r.failed === null && r.copy) dropParked(root, sessionId, issues);
			return r;
		},
		recordLaunch,
		launchFresh: launchBatch,
		log,
		now: Date.now,
	});

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
		log(`transcript unread for ${l.jobId}: ${buildErrorText(e)}`);
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
function readIdleSince(l) {
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
	admitResume: () =>
		readFreeSlots().slots > 0 ? null : "admission's re-read finds no free slot",
	stagger: () => sleepSync(refillBatch.readStaggerMs()),
	moveSession,
	removeJobRecord,
	jobStateOf: readJobRecordOf,
	writeLedgerHold: (l, until) =>
		recordLaunch({
			issues: l.issues,
			model: MODEL,
			prompt: l.prompt,
			root: l.root,
			jobId: blocks.ledgerJobOf(l),
			heldUntil: until,
		}),
	readTimeline: readTimelineOf,
	idleSince: readIdleSince,
	hasTurnedSince: (l, at) =>
		hasTurnedSince(readTranscriptRows(l, readJobRecordOf(l)), at),
	hasRepliedSince: (l, at) =>
		hasRepliedSince(readTranscriptRows(l, readJobRecordOf(l)), at),
	labelParked,
	recordParked,
	comment: commentOn,
	postHandOff,
	release: (l) => release({ jobId: blocks.ledgerJobOf(l), root: l.root }),
	progressOf: (l) => readProgress(l, served),
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
	const frontier = /** @type {import("./refill-decide.js").MergedRow[]} */ (
		merged.frontier
	);
	const parkers = readParkers(frontier);
	const decision = decideTick({
		...input,
		seats: sizeParkerSeats(input.seats, parkers, served.roots[0]),
		frontier,
		retroBundles: merged.retroBundles,
		failedShortlists: merged.failed,
		parkers,
	});
	return { decision, read };
}

/**
 * Whether a tick's seats are the loop's own list: read off a sound control that
 * names some (#3790).
 * @param {{seats: string[]}|null} parsed
 */
const isSeatListRead = (parsed) => parsed !== null && parsed.seats.length > 0;

/**
 * `actOnLimits`, then the ledger holds it ended released.
 * @param {import("./refill-loop.js").LoopLaunch[]} before the launches as the last tick left them
 * @param {Parameters<typeof blocks.actOnLimits>[0]} judged
 * @param {Parameters<typeof blocks.actOnLimits>[1]} mode
 * @param {Parameters<typeof blocks.actOnLimits>[2]} seen
 */
function actOnLimitsAndRelease(before, judged, mode, seen) {
	const acted = blocks.actOnLimits(judged, mode, seen);
	blocks.releaseEndedHolds(before, acted.launches, seen.io);
	return acted;
}

/**
 * One tick: its decision and the start it judged against. Under `dryRun`
 * nothing is reaped, launched or written.
 * @param {{dryRun: boolean}} opts
 */
async function tick({ dryRun }) {
	const now = Date.now();
	const { control: parsed, damaged } = readControl();
	const control = parsed ?? {
		noProgressFrom: now,
		/* No control file is a loop nobody started: a real tick stops. */
		stopRequested: !dryRun,
		seats: readConfiguredSeats(),
		scope: loop.parseScope(null),
	};
	reapFinished(dryRun);
	const state = readStateFile(log);
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
	const { slots: free, admission } = readFreeSlots();
	const declared = readDeclaredSeats();
	const typed = readLastTyped(declared);
	const {
		launches,
		slots,
		workingChange: limitChange,
	} = dryRun
		? { launches: judged, slots: free, workingChange: 0 }
		: actOnLimitsAndRelease(state.launches, judged, control.scope.mode, {
				...seen,
				typedSeat: typed.seat,
				readMoveSeats: () =>
					readSeats(control.seats, 1, served[0], {
						typedSeat: typed.seat,
						sizeAll: true,
					}).seats,
				seatListRead: isSeatListRead(parsed),
				slots: free,
			});
	const { seats, probes } = readSeats(control.seats, slots, served[0], {
		typedSeat: typed.seat,
	});
	const overflow = loop.overflowReadings(declared, seats, (seat) =>
		seatBudget(seat, served[0]),
	);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		mode: control.scope.mode,
		noProgressFrom: control.noProgressFrom,
		stopRequested: control.stopRequested,
		/* A dry run previews launches over any control, as over none. */
		controlDamaged: dryRun ? null : damaged,
		frontier: [],
		retroBundles: [],
		running: loop.runningOf(launches),
		freeSlots: slots,
		limitHeldLines: launches
			.filter(blocks.isLimitHeld)
			.map(blocks.buildHeldStopText),
		lastPromptAt: typed.at,
		typedSeat: typed.seat,
		seats,
		overflow,
		history: launches,
		judgements: gates
			.readGateStore(files.gates, log)
			.pending.filter((j) => served.includes(j.root)),
		resumable: blocks.resumableOf(launches, seen),
	};
	const { decision, read } = await decide(input, control.scope);
	if (dryRun)
		return {
			decision,
			read,
			noProgressFrom: control.noProgressFrom,
			agents,
		};
	const { decision: settled, launched } = loop.settleTick(
		{ input, decision, state, judged: launches, probes, read },
		{
			readControl,
			launchBatch: launchOrResume,
			resumeHeld: (resumes, held, isStopped) =>
				blocks.resumeHeldLaunches(resumes, held, seen, isStopped),
			runReview,
			writeState: (next) => writeJson(files.state, next),
			readOmittedDirs: () => readOmittedDirs(declared),
			log,
			now: Date.now,
		},
	);
	if (
		!appendTick(
			buildTickRecord({
				input,
				decision: settled,
				admission,
				workingChange: limitChange + launched,
			}),
		)
	)
		log(`concurrency record: not written to ${concurrencyFiles().record}`);
	return {
		decision: settled,
		noProgressFrom: control.noProgressFrom,
		agents,
	};
}

module.exports = {
	DISPATCHER,
	files,
	log,
	buildCapUnsizedLine,
	readCap,
	isReviewRunning,
	say,
	servedRoots,
	tick,
};
