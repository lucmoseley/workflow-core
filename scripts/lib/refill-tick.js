/*
 * refill-tick.js — one tick of the refill loop (#2012, #2123, spec #1995),
 * with the child processes, files and listings it reads and writes:
 * scripts/refill-loop.js's `run` drives it and its `dry-run` prints one. The
 * CLI logs through the same say and log, at the same files (#3392).
 *
 * A TICK: read founder presence, and in away mode write what it changes under
 * the control lock (#2522), reap (the reaper's --not-a-session mode, since the loop has no
 * session id), take the quiet bench route's step (lib/quiet-bench-tick.js, #3852),
 * stop each job that never started, judge the loop's finished
 * launches for progress, take `parked` off each answered park in every checkout
 * it could serve (lib/refill-blocks.js's unparkAnswered, #3940, #3950) and each
 * closed issue on a served tracker (lib/parked.js's unparkClosed, #3940),
 * stop each parked one its cause and mode's row says
 * to and label its ticket `parked` (lib/block-act.js, #2699), resume each
 * stopped by a transient API error on its schedule, stopping it between
 * tries (#2705), resume each its host restarted that took no turn and hand
 * one still idle after that to a fresh launch (#2707), read
 * admission, the allowance per seat and what its cap would launch, hold, resume or move each blocked on its seat's limit
 * (#3735), ask lib/refill-decide.js, and launch each repo's picks
 * through one dispatch-sessions.sh call in its checkout, so that repo's ledger,
 * duplicate drop, memory re-read and allowance cap apply. The decision core
 * is asked first with an empty frontier: the per-repo shortlists cost GitHub
 * calls, so they are read only on a tick that could launch. Before the
 * decision, the landing queue of each served checkout, and of each checkout
 * a recorded launch ran in, is supervised
 * (scripts/supervise-landing.js, #2692): a dead lander started, a stall
 * ticketed, each earlyoom kill incident that is over is ticketed
 * (scripts/file-memory-kill-tickets.js, #3094), each process runaway memwatch
 * fired on is ticketed (scripts/file-process-runaway-tickets.js, #3807), each repo hold whose clear
 * check passes is lifted (lib/repo-holds.js, #3857), and each served checkout's
 * shared `.git` is probed, a failure stopping launches into it (#3860). Last, the morning review is
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
const { listedAgents, readAgentsAfterBoot } = require("./agent-liveness.js");
const {
	bootSparedJobs,
	isEmptyListingTrusted,
	settleBootKilled,
	withManagerRestart,
} = require("./refill-boot.js");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { buildDriftLines, readRegistryAgents } = require("./registry-agents.js");
const { readActsBy } = require("./arbiter-store.js");
const { PROBE_CWD, PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { hasSeatRunSince } = require("./project-dirs.js");
const { projectSlug } = require("./project-slug.js");
const { readAllowance } = require("./allowance.js");
const { claudeBin } = require("./claude-bin.js");
const { buildTypedAttach } = require("./claude-attach.js");
const { buildErrorText, caught } = require("./caught.js");
const { childFailure } = require("./child-failure.js");
const { CHILD_TIMEOUT_MS, spawnChild } = require("./child-spawn.js");
const { parseErrLine, gh } = require("./gh.js");
const gates = require("./gate-sweep.js");
const {
	readRecentEntries,
	readOverflowLookup,
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
	moveParkedBy,
	newestMarkerListing,
	readParkMarkers,
	readParkMarkersOrThrow,
	readParkedBy,
	setParked,
	unparkClosed,
	unparkIssues,
	writeParkedBy,
} = require("./parked.js");
const { movePassMarkers } = require("./move-pass-markers.js");
const { read: readTranscript } = require("./session-transcript.js");
const { findNewestTranscript, mainChainRecords } = require("./transcript.js");
const { findResumed } = require("./resumed-copy.js");
const { hasConfig, resolveKey } = require("./workflow-core-config.js");
const { readLastTyped } = require("./presence.js");
const {
	MODEL,
	NOTHING_LAUNCHABLE,
	decideTick,
	hasRoom,
	isParked,
	isOnPlanSeat,
} = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const {
	appendTick,
	concurrencyFiles,
	buildTickRecord,
} = require("./concurrency.js");
const { appendConsoleRow, isConsoleReadDue } = require("./console-credit.js");
const { seatBudget, stopOverAllowance } = require("./overflow-budget.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
} = require("./refill-seats.js");
const { runOf } = require("./headless-sessions.js");
const {
	buildCheckoutEnv,
	discoverRepos,
	homeDir,
	isOptedOut,
	readExclusionWhy,
} = require("./refill-repos.js");
const loop = require("./refill-loop.js");
const {
	dropManagerRestart,
	loopFiles,
	readManagerRestart,
	REVIEW_RUNNER,
	readControlChecked,
	readJson,
	readStateFile,
	withControlLock,
	writeControlFile,
	writeLoopPause,
	writeJson,
} = require("./refill-files.js");
const refillBatch = require("./refill-batch.js");
const blocks = require("./refill-blocks.js");
const {
	dropLiftedJobs,
	readLiftedHolds,
	readTickHolds,
	tendHolds,
} = require("./repo-holds.js");
const { tendHoldNotices } = require("./repo-hold-notices.js");
const { sleepSync } = require("./sleep-sync.js");
const { localDate } = require("./morning-review.js");
const { pidLock } = require("./pid-lock.js");
const { tendQuietBench } = require("./quiet-bench-tick.js");
const { parkedPromptOf } = require("./loop-prompts.js");
const { writeFd } = require("./write-fd.js");

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

/** What the loop may serve now, whatever its scope chose. */
const readIncluded = () => discoverRepos(homeDir()).included;

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
const servedRoots = (scope) => loop.scopeRoots(scope, readExclusionWhy);

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
 * full session until it goes. The log lines. `spared` go unjudged (#3983).
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Set<string>} spared
 */
function stopNeverStarted(registry, spared) {
	const jobs = readJobs()?.filter((j) => !spared.has(j.job)) ?? null;
	return loop.stopNeverStarted(registry, jobs, (j) => {
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
			{ cwd: root, env: buildCheckoutEnv(root) },
		);
		if (r.out || r.failed) log(blocks.buildChildLine(`landing in ${root}`, r));
	}
}

/**
 * Run one of the machine incident filers on the review checkout's tracker: the
 * incidents are the machine's, so one checkout files them. Logged only where it
 * filed or failed. Earlyoom kills (scripts/file-memory-kill-tickets.js, #3094);
 * memwatch's process runaways (scripts/file-process-runaway-tickets.js, #3807).
 * @param {string} script
 * @param {string} label
 */
function fileMachineTickets(script, label) {
	if (!hasConfig(REVIEW_ROOT)) return;
	const r = runChild(process.execPath, [path.join(SCRIPTS, script)], {
		cwd: REVIEW_ROOT,
		env: buildCheckoutEnv(REVIEW_ROOT),
	});
	if (r.out || r.failed) log(blocks.buildChildLine(label, r));
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
			env: { ...buildCheckoutEnv(root), CLAUDE_CONFIG_DIR: seat },
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
 * The probes of each seat due a read for the panel's figures, past the launch
 * walk's own (lib/refill-loop.js's seatsDueRead). A probe writes its own log,
 * under its working directory's slug, so that slug is no sign a session ran.
 * @param {string[]} seats
 * @param {Record<string, number>} triedAt
 */
function probeDueSeats(seats, triedAt) {
	const now = Date.now();
	const due = loop.seatsDueRead(seats, {
		barsOf: (seat) => readAllowance({ configDir: seat, now }),
		triedAt,
		hasRunSince: (seat, since) =>
			hasSeatRunSince(seat, since, projectSlug(PROBE_CWD)),
		now,
	});
	return readPrintedUsage(due).probes;
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
 * Run a script of this directory detached in REVIEW_ROOT, its stderr the loop's
 * log. Fails open (#3765): a failed start is logged and the next tick decides
 * again. A stop leaves a started run to finish.
 * @param {string} label
 * @param {string[]} args the script and its arguments
 */
function startDetached(label, args) {
	/** @param {unknown} err */
	const notStarted = (err) =>
		log(`${label}: not started (${buildErrorText(err)})`);
	try {
		const child = spawn(process.execPath, args, {
			cwd: REVIEW_ROOT,
			env: buildCheckoutEnv(REVIEW_ROOT),
			detached: true,
			stdio: ["ignore", "ignore", "inherit"],
		});
		child.on("error", notStarted);
		child.unref();
	} catch (err) {
		notStarted(err);
	}
}

/**
 * Start the review runner; its result is logged on the next start.
 * @param {import("./refill-loop.js").ReviewStart} start
 */
function startReview(start) {
	startDetached(start.label, [
		path.join(SCRIPTS, REVIEW_RUNNER),
		JSON.stringify(start),
	]);
}

/**
 * Start each overflow key's Console read that is due (lib/console-credit.js),
 * detached. The started row is what stops the next tick
 * starting it again.
 * @param {ReturnType<typeof readDeclaredSeats>} declared
 * @param {import("./refill-decide.js").SeatReading[]} plan
 * @param {string|undefined} root
 */
function startDueConsoleReads(declared, plan, root) {
	const now = Date.now();
	for (const seat of declared.seats) {
		if (seat.kind !== "overflow") continue;
		const budget = seatBudget(seat, root);
		if ("why" in budget || !isConsoleReadDue(seat, budget, plan, now)) continue;
		try {
			appendConsoleRow(seat, { at: now, started: true });
		} catch (err) {
			log(`console read of ${seat.dir}: not started (${buildErrorText(err)})`);
			continue;
		}
		startDetached(`console read of ${seat.dir}`, [
			path.join(SCRIPTS, "read-console-credit.js"),
			seat.keyVar,
		]);
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
 * The stores a launch in `root`'s acts are read from: every served repo's and
 * its own.
 * @param {string} root
 * @param {string[]} served
 */
const actRootsOf = (root, served) => [...new Set([...served, root])];

/**
 * The reader of the acts a session made before a new launch row wakes it, from
 * actRootsOf's stores.
 * @param {string[]} served
 * @returns {import("./refill-blocks.js").ReadActsBefore}
 */
const buildActsBeforeReader = (served) => (root, sessionId) =>
	loop.readActsSoFar(sessionId, actRootsOf(root, served), readActsBy);

/**
 * A finishing launch's acts, read from actRootsOf's stores, and logged.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string[]} served
 */
function readProgress(l, served) {
	const progress = loop.actsOf(l, actRootsOf(l.root, served), readActsBy);
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
				? {
						seat: l.seat,
						...(l.keyVar ? { keyVar: l.keyVar } : {}),
						jobId: l.jobId,
						cwd: readJobCwd(l.seat, l.jobId),
					}
				: null,
			limitParks,
			cause: l.block?.cause,
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
			env: { ...buildCheckoutEnv(l.root), CLAUDE_CODE_SESSION_ID: sessionId },
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
 * lib/parked.js's moveParkedBy for `l`. Fails open (#3709): a marker left names a job a
 * resume then falls back from.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar">} l
 * @param {string} from
 * @param {{sessionId: string|null, jobId: string, cwd: string}} copy
 */
function moveParked(
	{ root, issues, seat, keyVar },
	from,
	{ sessionId, jobId, cwd },
) {
	try {
		moveParkedBy(from, issues, {
			root,
			copySessionId: sessionId,
			job: { seat, ...(keyVar ? { keyVar } : {}), jobId, cwd },
		});
	} catch (e) {
		log(`marker of ${from} not moved: ${buildErrorText(e)}`);
	}
}

/**
 * lib/move-pass-markers.js's movePassMarkers for `l`. Fails open (#4105): a marker
 * left only owes its pass again.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root">} l
 * @param {string} from
 * @param {string} to
 */
function movePasses({ root }, from, to) {
	try {
		const left = movePassMarkers(root, from, to);
		if (left) log(`pass markers of ${from} not moved: ${left}`);
	} catch (e) {
		log(`pass markers of ${from} not moved: ${buildErrorText(e)}`);
	}
}

/**
 * Mark an overflow session's copy overflow in the dispatch ledger, the only such
 * mark a parking session can read (#4147). No issues, so the row holds nothing:
 * the first job keeps the ledger hold. Fails open, logged: unmarked, the copy's
 * own park reads as a plan seat's.
 * @param {{root: string, keyVar: string}} on
 * @param {string} from the session it copies
 * @param {{jobId: string, sessionId: string|null}} copy
 */
function recordOverflowCopy({ root, keyVar }, from, { jobId, sessionId }) {
	const failure = `overflow copy ${jobId} of ${from} not marked in the dispatch ledger`;
	try {
		const lookup = readOverflowLookup([root]);
		/* Marked already where a kill came after the mark and before the state
		 * write, and the next step adopts the copy (#4157). */
		if (lookup({ jobId })) return;
		const first = lookup({ sessionId: from });
		if (!first) {
			log(`${failure}: no launch of ${from} on key=${keyVar} is recorded`);
			return;
		}
		const written = recordLaunch({
			issues: [],
			model: MODEL,
			prompt: `copy of ${from}`,
			root,
			jobId,
			overflow: { keyVar, allowanceUsd: first.allowanceUsd, sessionId },
		});
		if (!written) log(failure);
	} catch (e) {
		log(`${failure}: ${buildErrorText(e)}`);
	}
}

/**
 * `claude --bg --resume <full id> "<prompt>"` of `l`'s stopped job, from its
 * cwd (#2354 F6). The launcher exits 0 whatever happens (F8). On 2.1.310 it
 * wakes a stopped job in place, else starts a copy under a new job and
 * session id, which carries the conversation on and takes the issue claims
 * (#2963, #2968). The resume counts where the launcher named the job it
 * started (lib/bg-resume.js) and that job's state.json does not read failed;
 * a later tick judges the resumed turn.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar">} l
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
	return settleCopy(l, sessionId, { jobId, sessionId: copySession, cwd });
}

/**
 * Hand copy `copy` of session `from` what the session held: its issue claims,
 * pass markers, park marker and, on an overflow seat, its ledger mark.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar">} l
 * @param {string} from
 * @param {{jobId: string, sessionId: string|null, cwd: string}} copy
 * @returns {Extract<import("./refill-blocks.js").Resumed, {failed: null}>}
 */
function settleCopy(l, from, copy) {
	const { jobId, sessionId } = copy;
	if (sessionId) {
		moveClaims(l, from, sessionId);
		movePasses(l, from, sessionId);
	} else
		log(
			`no session id read for copy ${jobId}: its issue claims and pass markers not moved`,
		);
	moveParked(l, from, copy);
	if (l.keyVar)
		recordOverflowCopy({ root: l.root, keyVar: l.keyVar }, from, {
			jobId,
			sessionId,
		});
	return { failed: null, jobId, sessionId, copy: true };
}

/**
 * lib/resumed-copy.js's findResumed for `l`'s seat, past `l`'s earlier
 * sessions: a copy found is handed what the session held (#4157, #4180); why
 * not, where the job store or a transcript will not read.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar"|"pastSessionIds">} l
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @returns {import("./refill-blocks.js").Adopted}
 */
function adoptResumed(l, target, since) {
	const found = findResumed(l.seat, target, since, l.pastSessionIds ?? []);
	if (found === null || "unread" in found) return found;
	const { jobId, sessionId } = found;
	return found.copy
		? settleCopy(l, target.sessionId, { jobId, sessionId, cwd: target.cwd })
		: { failed: null, jobId, sessionId, copy: false };
}

/**
 * The state file with launch `l` in place of the unfinished one it was, matched
 * by the job its ledger rows name, or added where none is (#4180).
 * @param {import("./refill-loop.js").LoopLaunch} l
 */
function writeLaunch(l) {
	const state = readStateFile(log);
	const job = blocks.ledgerJobOf(l);
	/** @param {import("./refill-loop.js").LoopLaunch} x */
	const isIt = (x) => x.finishedAt === null && blocks.ledgerJobOf(x) === job;
	const launches = state.launches.some(isIt)
		? state.launches.map((x) => (isIt(x) ? l : x))
		: [...state.launches, l];
	writeJson(files.state, { ...state, launches });
}

/**
 * `state` with the members of the batch a kill cut off that started tracked
 * (lib/refill-batch.js's adoptLaunching, #4180), each gated one's judgement
 * dropped as its launch would have.
 * @param {import("./refill-loop.js").LoopState} state
 * @param {string[]} served
 */
const adoptKilledLaunches = (state, served) =>
	loop.settleLaunching(state, (launching) => {
		const launched = refillBatch.adoptLaunching(launching, {
			entriesOf: (root) => readRecentEntries(root, LEDGER_WINDOW_HOURS).entries,
			sessionOf: readHeadlessSession,
			readActsBefore: buildActsBeforeReader(served),
			recordLaunch,
			adoptResumed: (l, { seat, sessionId, cwd }, since) =>
				adoptResumed({ ...l, seat }, { sessionId, cwd }, since),
			log,
		});
		for (const l of launched)
			log(
				`${blocks.launchName(l)}'s launch at ${blocks.iso(launching.at)} started job ${l.jobId}, which a kill left out of the state: tracking it`,
			);
		gates.dropTried(files.gates, launched, log);
		return launched;
	});

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
		const { job, sessionId, limitParks, cause } = marker;
		return [
			{
				root: row.root,
				number: row.number,
				sessionId,
				job,
				resumeCwd: job?.cwd ?? row.root,
				...(limitParks === undefined ? {} : { limitParks }),
				...(cause === undefined ? {} : { parkCause: cause }),
			},
		];
	});
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
		s.fits === null &&
		hasRoom(s) &&
		parkers.some((p) => p.job && isOnPlanSeat(p.job, s.seat))
			? { ...s, fits: readCapFits(root, s.seat, 1, "") }
			: s,
	);

/**
 * The park markers in `root`'s checkout, null, logged, where they will not read,
 * for the resume step to wait rather than read a parked session as answered
 * (#3863).
 * @param {string} root
 */
function readParkMarkersOrNull(root) {
	try {
		return readParkMarkersOrThrow(root);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		log(`park markers unread in ${root}: ${buildErrorText(e)}`);
		return null;
	}
}

/**
 * `issues` no longer parked, as its session has gone back (#3863) or ended
 * unblocked (#3940): the label off and out of `sessionId`'s marker, as
 * unpark-on-prompt.js takes them. An issue whose write fails stays in the marker.
 * Null, or what failed.
 * @param {string} root
 * @param {string} sessionId
 * @param {number[]} issues
 * @returns {string|null}
 */
function unparkSession(root, sessionId, issues) {
	const tracker = resolveKey("tracker", { root });
	if (typeof tracker !== "string") return "no tracker configured";
	try {
		const failed = unparkIssues(tracker, sessionId, issues, root);
		return failed.map((f) => `#${f.n}: ${f.why}`).join("; ") || null;
	} catch (e) {
		return `marker not trimmed: ${buildErrorText(e)}`;
	}
}

/**
 * `marker`'s session's newest transcript, found by id on the marker's seat or any
 * configured one, as a move leaves a stale copy and a copy's job record may name
 * the transcript it came from.
 * @param {import("./parked.js").ParkMarkerRead} marker
 */
const findParkTranscript = ({ sessionId, job }) =>
	findNewestTranscript(
		[...(job ? [job.seat] : []), ...readConfiguredSeats()],
		sessionId,
	);

/**
 * `parked` off each closed issue in `served`'s trackers (lib/parked.js's
 * unparkClosed), logged, at one `gh issue list` a tracker a tick, on a tick that
 * launches nothing too. A failure waits for the next tick.
 * @param {string[]} served
 */
function tendClosedParks(served) {
	const trackers = new Set(
		served.map((root) => resolveKey("tracker", { root })),
	);
	for (const tracker of trackers) {
		if (typeof tracker !== "string") continue;
		try {
			const { cleared, failed } = unparkClosed(tracker);
			for (const n of cleared) log(`closed ${tracker}#${n}: parked off`);
			for (const { n, why } of failed)
				log(`closed ${tracker}#${n}: still labelled parked: ${why}`);
		} catch (e) {
			/* Fails open: a label left on a closed issue harms nothing (#3940). */
			log(`closed parks unread in ${tracker}: ${parseErrLine(e)}`);
		}
	}
}

/**
 * The dispatcher's per-member re-read for a resume: null, or why it waits.
 * @returns {string|null}
 */
const admitResume = () =>
	readFreeSlots().slots > 0 ? null : "admission's re-read finds no free slot";

const staggerResume = () => sleepSync(refillBatch.readStaggerMs());

/**
 * `batch` launched (lib/refill-batch.js's launchOrResume): each parked member
 * routed to resume resumed in place (resumeStopped), the rest through one
 * dispatcher call (launchBatch).
 * @param {import("./refill-decide.js").Launch[]} batch
 * @param {string[]} served
 */
const launchOrResume = (batch, served) =>
	refillBatch.launchOrResume(batch, {
		readActsBefore: buildActsBeforeReader(served),
		resume: ({ root, issues }, { seat, sessionId, cwd, parkCause }) =>
			resumeStopped({ root, issues, seat }, parkedPromptOf(parkCause), {
				sessionId,
				cwd,
			}),
		admitResume,
		stagger: staggerResume,
		recordLaunch,
		launchFresh: launchBatch,
		log,
		now: Date.now,
	});

/**
 * Every main-chain row of transcript `file`, `who`'s; null, logged where it will
 * not read.
 * @param {string} file
 * @param {string|null} who
 * @returns {Record<string, unknown>[]|null}
 */
function readMainChain(file, who) {
	try {
		return [...mainChainRecords(readTranscript(file), "main")];
	} catch (e) {
		log(`transcript unread for ${who}: ${buildErrorText(e)}`);
		return null;
	}
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
	return typeof file === "string" ? readMainChain(file, l.jobId) : null;
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
 * checkout: it posts a `**Hand-off:**` comment on each issue and releases its
 * claim, `l.sessionId` standing in for a job record that is gone (#3988).
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
			...(l.sessionId ? ["--session", l.sessionId] : []),
			...l.issues.flatMap((n) => ["--issue", String(n)]),
		],
		{ cwd: l.root, env: buildCheckoutEnv(l.root) },
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
	adoptResumed,
	writeLaunch,
	admitResume,
	stagger: staggerResume,
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
	readParkMarkers: readParkMarkersOrNull,
	findParkTranscript,
	readMainChain,
	unparkSession,
	comment: commentOn,
	postHandOff,
	release: (l) => release({ jobId: blocks.ledgerJobOf(l), root: l.root }),
	progressOf: (l) => readProgress(l, served),
	readActsBefore: buildActsBeforeReader(served),
	log,
});

/**
 * What a real tick does for its checkouts ahead of its decision; the served
 * checkouts whose probe failed.
 * @param {string[]} served
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {number} now
 */
function tendCheckouts(served, launches, now) {
	const roots = loop.landingRoots(served, launches);
	superviseLanding(roots);
	fileMachineTickets("file-memory-kill-tickets.js", "memory kills");
	fileMachineTickets("file-process-runaway-tickets.js", "process runaways");
	return tendHolds(roots, served, now, log);
}

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
	const merged = await refillFrontier(served.roots, scope.goal);
	const read = {
		rows: merged.frontier.length,
		ms: Date.now() - readStart,
		goal: merged.goal,
	};
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
 * The limit acts made, and what a tick decides its launches on: the free slots
 * and the seats. A paused tick launches nothing, so it reads none of them, making
 * no admission, `/usage` or cap read, and leaves the limit acts, which need them,
 * for the tick after the resume (#3856); a hold its finishes ended is still
 * released, as that tick's `before` no longer shows it holding.
 * @param {{dryRun: boolean, control: import("./refill-loop.js").Control,
 *   seatListRead: boolean, before: import("./refill-loop.js").LoopLaunch[],
 *   judged: import("./refill-loop.js").LoopLaunch[],
 *   seen: Omit<Parameters<typeof actOnLimitsAndRelease>[3],
 *     "typedSeat"|"readMoveSeats"|"seatListRead"|"slots">, served: string[],
 *   declared: ReturnType<typeof readDeclaredSeats>,
 *   typedSeat: string|null, seatTriedAt: Record<string, number>}} tick
 */
function settleRoom({
	dryRun,
	control,
	seatListRead,
	before,
	judged,
	seen,
	served,
	declared,
	typedSeat,
	seatTriedAt,
}) {
	if (control.paused) {
		if (!dryRun) blocks.releaseEndedHolds(before, judged, seen.io);
		return {
			launches: judged,
			slots: 0,
			admission: null,
			workingChange: 0,
			seats: [],
			probes: [],
			overflow: [],
		};
	}
	const { slots: free, admission } = readFreeSlots();
	/** @type {import("./refill-loop.js").Probe[]} */
	const moveProbes = [];
	const { launches, slots, workingChange } = dryRun
		? { launches: judged, slots: free, workingChange: 0 }
		: actOnLimitsAndRelease(before, judged, control.scope.mode, {
				...seen,
				typedSeat,
				readMoveSeats: () => {
					const read = readSeats(control.seats, 1, served[0], {
						typedSeat,
						sizeAll: true,
					});
					moveProbes.push(...read.probes);
					return read.seats;
				},
				seatListRead,
				slots: free,
			});
	const { seats, probes: walked } = readSeats(control.seats, slots, served[0], {
		typedSeat,
	});
	const walks = [...moveProbes, ...walked];
	/* A dry run previews launches, so it makes only the walk's probes. The walks'
	 * stamps are for this read alone: settleTick writes the tick's own. */
	const probes = dryRun
		? walks
		: [
				...walks,
				...probeDueSeats(
					control.seats,
					loop.seatTriedAfter(seatTriedAt, walks, Date.now()),
				),
			];
	const overflow = loop.overflowReadings(declared, seats, (seat) =>
		seatBudget(seat, served[0]),
	);
	if (!dryRun && !control.stopRequested)
		startDueConsoleReads(declared, seats, served[0]);
	return { launches, slots, admission, workingChange, seats, probes, overflow };
}

/**
 * The stopped sessions due back: none on a paused tick, which resumes none,
 * though a stop still names those it leaves.
 * @param {import("./refill-loop.js").Control} control
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {Parameters<typeof blocks.resumableOf>[1]} seen
 */
const resumesDue = (control, launches, seen) =>
	control.paused && !control.stopRequested
		? []
		: blocks.resumableOf(launches, seen);

/**
 * The checkouts whose answered parks a tick takes off: `served` and every other
 * it could serve, the idle alarm's set, as a label left on an open ticket hides
 * it from that alarm (#3950). This sets no launch running there. Discovery that
 * will not read leaves `served`, logged.
 * @param {string[]} served
 * @returns {string[]}
 */
function readParkSweepRoots(served) {
	try {
		return [...new Set([...served, ...readIncluded()])];
	} catch (e) {
		log(`unserved parks unread: ${buildErrorText(e)}`);
		return served;
	}
}

/**
 * The tick's acts on its blocked and idle launches, then each away park's ledger
 * row released once normal mode is live.
 * @param {import("./refill-loop.js").LoopLaunch[]} listed
 * @param {import("./refill-loop.js").Control} control
 * @param {string[]} served
 * @param {Parameters<typeof blocks.actOnBlocks>[2]} seen
 */
const actOnLaunches = (listed, { scope: { mode } }, served, seen) => {
	blocks.unparkAnswered(readParkSweepRoots(served), seen);
	tendClosedParks(served);
	return blocks.releaseAwayParks(
		blocks.actOnIdle(blocks.actOnBlocks(listed, mode, seen), mode, seen),
		mode,
		served,
		seen.io,
	);
};

/**
 * The state file as this tick starts on it: the manager's restart applied, and,
 * on a live tick, what a kill left out of it settled (settleKilled).
 * @param {ReturnType<typeof readManagerRestart>} managerRestart
 * @param {string[]} served
 * @param {boolean} dryRun
 */
function readTickState(managerRestart, served, dryRun) {
	const onDisk = withManagerRestart(
		readStateFile(log),
		managerRestart,
		readCurrentBootId(),
	);
	return dryRun ? onDisk : settleKilled(onDisk, served);
}

/**
 * `state` with what a kill before the last tick's own write left out of it
 * settled (#4180): its cut-off batch's launches adopted, then each resume left
 * with no outcome (lib/refill-blocks.js's settleStartedResumes), ahead of any
 * judging of the launches. Written at once where either changed it, so a stamp
 * later this tick lands on what was settled.
 * @param {import("./refill-loop.js").LoopState} read
 * @param {string[]} served
 */
function settleKilled(read, served) {
	const adopted = adoptKilledLaunches(read, served);
	const { launches, settled } = blocks.settleStartedResumes(
		adopted.launches,
		blockIo(served),
	);
	const state = settled ? { ...adopted, launches } : adopted;
	if (state !== read) writeJson(files.state, state);
	return state;
}

/**
 * `launches` with the sessions parked on each lifted hold queued for the resume
 * step. A dry run, a paused tick or a stopping one sets nothing running, and the
 * lifted holds keep for a later tick.
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {{setsNothingRunning: boolean, roots: string[],
 *   seen: Parameters<typeof blocks.queueLifted>[2]}} tick
 */
const queueLiftedHolds = (launches, { setsNothingRunning, roots, seen }) =>
	setsNothingRunning
		? { launches, settled: [] }
		: blocks.queueLifted(launches, readLiftedHolds(roots, log), seen);

/**
 * What of each lifted hold the written state now carries, dropped.
 * @param {ReturnType<typeof queueLiftedHolds>["settled"]} settled
 */
function dropSettledLifted(settled) {
	for (const { hold, jobs } of settled) dropLiftedJobs(hold, jobs, log);
}

/* Untraced: another writer holds it for one read and write, and the next tick
 * tries again. */
const TICK_LOCK_WAIT_MS = 1000;

/**
 * The control `change` leaves, made on a fresh read under the control lock and
 * `said` called on what it wrote; `control` where it changes nothing. A lock
 * held past the wait leaves the change to the next tick, this one going on as
 * stored. A dry run previews the change and writes none.
 * @param {import("./refill-loop.js").Control|null} control
 * @param {(c: import("./refill-loop.js").Control) => import("./refill-loop.js").Control|null} change
 * @param {{dryRun: boolean, what: string,
 *   said: (write: import("./refill-loop.js").Control, fresh: import("./refill-loop.js").Control) => void}} how
 *   `what`, the change's name in the busy line
 */
function settleUnderLock(control, change, { dryRun, what, said }) {
	const next = control && change(control);
	if (!next) return control;
	if (dryRun) return next;
	const written = withControlLock(() => {
		const fresh = readControl().control;
		const write = fresh && change(fresh);
		if (!fresh || !write) return fresh;
		writeControlFile(write);
		said(write, fresh);
		return write;
	}, TICK_LOCK_WAIT_MS);
	if ("busy" in written) {
		log(`${what} waits for the next tick: ${written.busy}`);
		return control;
	}
	return written.done;
}

/**
 * The control after this tick's read of the founder (controlAfterPresence).
 * @param {import("./refill-loop.js").Control|null} control
 * @param {number|null} lastPromptAt
 * @param {{dryRun: boolean, now: number}} tick
 */
const settleAwayMode = (control, lastPromptAt, { dryRun, now }) =>
	settleUnderLock(
		control,
		(c) => loop.controlAfterPresence(c, lastPromptAt, now),
		{
			dryRun,
			what: "away mode's change",
			said: (write) => {
				if (write.scope.mode === "normal")
					log(
						`mode normal: the founder is back, a prompt typed at ${new Date(lastPromptAt ?? now).toISOString()} after a tick read him absent`,
					);
			},
		},
	);

/**
 * The control with each ticked repo its owner has opted out unticked
 * (controlWithoutOptedOut). A busy lock leaves it ticked a tick longer, which
 * serves nothing: scopeRoots drops it meanwhile.
 * @param {import("./refill-loop.js").Control|null} control
 * @param {boolean} dryRun
 */
const settleOptedOut = (control, dryRun) =>
	settleUnderLock(
		control,
		(c) => loop.controlWithoutOptedOut(c, isOptedOut)?.control ?? null,
		{
			dryRun,
			what: "the opt-out untick",
			said: (write, fresh) => {
				for (const root of fresh.scope.repos)
					if (!write.scope.repos.includes(root))
						log(`unticked: ${root} (opted out); a return needs a fresh tick`);
			},
		},
	);

/**
 * The log lines of stopNeverStarted, none on a dry run.
 * @param {boolean} dryRun
 * @param {import("./refill-loop.js").LoopState} state
 * @param {Parameters<typeof stopNeverStarted>[0]} registry
 */
const stopsOfNeverStarted = (dryRun, state, registry) =>
	dryRun ? [] : stopNeverStarted(registry, bootSparedJobs(state));

/**
 * Stop each overflow session past its allowance (lib/overflow-budget.js,
 * #3698), logged; none on a dry run. Paused or stopping alike: a running
 * overflow session spends either way.
 * @param {boolean} dryRun
 * @param {Parameters<typeof stopOverAllowance>[0]} declared
 * @param {Parameters<typeof stopOverAllowance>[1]} agents
 */
function capOverflowSessions(dryRun, declared, agents) {
	if (dryRun) return;
	for (const line of stopOverAllowance(declared, agents)) log(line);
}

/**
 * The tick's listing, an empty one read as nothing live where a boot's killed
 * launches allow it. A dry run judges nothing by it, so it reads the plain one.
 * @param {boolean} dryRun
 * @param {import("./refill-loop.js").LoopState} state
 * @param {import("./registry-agents.js").RegistryListing} registry
 */
function readTickListing(dryRun, state, registry) {
	const trusted = !dryRun && isEmptyListingTrusted(state, registry);
	const read = trusted
		? readAgentsAfterBoot()
		: listedAgents({ requireSelf: false });
	if (read.why && (trusted || (!dryRun && state.sameBootRestart)))
		log(`a restart's killed launches wait on the listing: ${read.why}`);
	return read.agents ?? null;
}

/**
 * The control after the quiet bench route's step; as it was on a dry run, with no
 * control to pause, or on a step that failed, which is logged, the next tick
 * deciding it again.
 * @param {import("./refill-loop.js").Control} control
 * @param {{dryRun: boolean, parsed: unknown, lastTypedAt: number|null, now: number}} tick
 */
function settleQuietBench(control, { dryRun, parsed, lastTypedAt, now }) {
	if (dryRun || parsed === null || control.stopRequested) return control;
	try {
		return tendQuietBench({
			control,
			lastTypedAt,
			served: servedRoots(control.scope).roots,
			now,
			log,
		});
	} catch (e) {
		/* Fails open, as a failed read inside a tick does (#3852). */
		log(`quiet bench: step failed: ${buildErrorText(e)}`);
		return control;
	}
}

/**
 * Each repo hold's phone notice; a dry run sends none. The listing refuses an empty
 * answer, so a registry that read and holds nobody stands in for it: that is the
 * quiet the notice is for.
 * @param {boolean} dryRun
 * @param {string[]} roots
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {{agents: Parameters<typeof tendHoldNotices>[1]["agents"], paused: boolean, now: number}} seen
 */
function settleHoldNotices(dryRun, roots, registry, { agents, paused, now }) {
	if (dryRun) return;
	const isRegistryEmpty =
		registry.seats.length > 0 &&
		registry.faults.length === 0 &&
		registry.agents.length === 0;
	tendHoldNotices(
		roots,
		{ agents: agents ?? (isRegistryEmpty ? [] : null), isPaused: paused },
		now,
		log,
	);
}

/**
 * One tick: its decision and the start it judged against. Under `dryRun`
 * nothing is reaped, launched or written.
 * @param {{dryRun: boolean}} opts
 */
async function tick({ dryRun }) {
	const now = Date.now();
	const { control: stored, damaged } = readControl();
	const declared = readDeclaredSeats();
	const typed = readLastTyped(declared);
	const parsed = settleOptedOut(
		settleAwayMode(stored, typed.at, { dryRun, now }),
		dryRun,
	);
	const unsettled = parsed ?? {
		noProgressFrom: now,
		/* No control file is a loop nobody started: a real tick stops. */
		stopRequested: !dryRun,
		seats: readConfiguredSeats(),
		/* With no set written, a dry run previews every checkout it may serve. */
		scope: {
			mode: "normal",
			repos: readIncluded(),
			goal: null,
		},
	};
	reapFinished(dryRun);
	const control = settleQuietBench(unsettled, {
		dryRun,
		parsed,
		lastTypedAt: typed.at,
		now,
	});
	const managerRestart = dryRun ? null : readManagerRestart(log);
	const served = servedRoots(control.scope).roots;
	const state = readTickState(managerRestart, served, dryRun);
	/* Relief first, off the registry alone: the CLI listing below can outrun
	 * its caps under the very pressure relief exists for (#2665). */
	const registry = readRegistryAgents();
	for (const line of stopsOfNeverStarted(dryRun, state, registry)) log(line);
	const broken = dryRun ? [] : tendCheckouts(served, state.launches, now);
	const agents = readTickListing(dryRun, state, registry);
	/* Read side by side here anyway, so the undocumented registry the relief
	 * steps trust is checked against the documented listing every tick. */
	if (agents)
		for (const line of buildDriftLines(agents, registry.agents)) log(line);
	capOverflowSessions(dryRun, declared, agents);
	const seen = {
		agents,
		now,
		io: blockIo(served),
		swapHold: readSwapHold(),
		paused: control.paused !== undefined,
	};
	settleHoldNotices(
		dryRun,
		loop.landingRoots(served, state.launches),
		registry,
		seen,
	);
	const booted = dryRun ? state : settleBootKilled(state, seen, registry);
	const listed = judgeFinished(booted.launches, agents, now, served);
	const acted = dryRun ? listed : actOnLaunches(listed, control, served, seen);
	const { launches: judged, settled: liftedSettled } = queueLiftedHolds(acted, {
		setsNothingRunning: dryRun || seen.paused || control.stopRequested,
		roots: loop.landingRoots(served, state.launches),
		seen,
	});
	const {
		launches,
		slots,
		admission,
		workingChange: limitChange,
		seats,
		probes,
		overflow,
	} = settleRoom({
		dryRun,
		control,
		seatListRead: isSeatListRead(parsed),
		before: state.launches,
		judged,
		seen,
		served,
		declared,
		typedSeat: typed.seat,
		seatTriedAt: state.seatTriedAt,
	});
	const resumable = resumesDue(control, launches, seen);
	/** @type {import("./refill-decide.js").TickInput} */
	const input = {
		now,
		mode: control.scope.mode,
		noProgressFrom: control.noProgressFrom,
		stopRequested: control.stopRequested,
		...(control.paused ? { paused: control.paused } : {}),
		/* A dry run previews launches over any control, as over none. */
		controlDamaged: dryRun ? null : damaged,
		frontier: [],
		retroBundles: [],
		running: loop.runningOf(launches),
		freeSlots: slots,
		limitHeldLines: launches
			.filter(blocks.isLimitHeld)
			.map(blocks.buildHeldStopText),
		typedSeat: typed.seat,
		seats: loop.sizeResumeSeats(seats, resumable, slots, (seat, members) =>
			readCapFits(served[0], seat, members, ""),
		),
		overflow,
		history: launches,
		judgements: gates
			.readGateStore(files.gates, log)
			.pending.filter((j) => served.includes(j.root)),
		resumable,
		holds: readTickHolds(served, broken).holds,
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
		{
			input,
			decision,
			state,
			judged: launches,
			probes,
			read,
			probeBrokenRoots: broken,
			bootedAt: booted.bootedAt,
			sameBootRestart: booted.sameBootRestart,
			away: control.away,
		},
		{
			readControl,
			launchBatch: (batch) => launchOrResume(batch, served),
			resumeHeld: (resumes, held, isStopped, record) =>
				blocks.resumeHeldLaunches(resumes, held, seen, { isStopped, record }),
			writePause: (pause) => writeLoopPause(pause, control.noProgressFrom, log),
			runReview,
			writeState: (next) => writeJson(files.state, next),
			readOmittedDirs: () => readOmittedDirs(declared),
			log,
			now: Date.now,
		},
	);
	dropSettledLifted(liftedSettled);
	if (managerRestart) dropManagerRestart(managerRestart, log);
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
