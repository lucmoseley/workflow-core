/*
 * refill-tick.js — the refill loop's tick adapter (#2012, #2123, spec #1995,
 * #4212): the child processes, files and listings lib/refill-tick-core.js's
 * runTick reads and writes, which owns the tick's step order and its dry-run
 * policy. scripts/refill-loop.js's `run` drives it and its `dry-run` prints
 * one, through the same adapter, the core calling none of its acts. The CLI logs through
 * the same say and log, at the same files (#3392).
 *
 * SEATS, in failover order, are the plan seats `~/.claude/refill-seats`
 * declares (lib/refill-seats.js), else the seat `start` ran on alone. Its
 * overflow seats, read each tick, launch `--bg` jobs under their plan seat's
 * config dir billed to that plan's API credits once every plan seat is
 * weekly-full, sized by their budget gate and never probed with `/usage`
 * (#2611, spec #2570; #3701). Host configuration, not code, because the
 * plugin ships to adopters. Every
 * listing a tick and its reaper read must span them all
 * (scripts/refill-loop.js's LISTING).
 *
 * A failed read inside a tick is logged and the tick carries on with what it
 * has.
 */

const fs = require("node:fs");
const path = require("node:path");
const { listedAgents, readAgentsAfterBoot } = require("./agent-liveness.js");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { readRegistryAgents } = require("./registry-agents.js");
const { readActsBy } = require("./arbiter-store.js");
const { PROBE_CWD, PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { hasSeatRunSince } = require("./project-dirs.js");
const { projectSlug } = require("./project-slug.js");
const { readAllowance } = require("./allowance.js");
const seatReading = require("./seat-reading.js");
const { buildTypedAttach } = require("./claude-attach.js");
const { buildErrorText, caught } = require("./caught.js");
const { childFailure } = require("./child-failure.js");
const { runTickChild: runChild } = require("./child-spawn.js");
const { parseErrLine, gh } = require("./gh.js");
const gates = require("./gate-sweep.js");
const {
	readRecentEntries,
	record: recordLaunch,
	recordListedSessionIds,
	release,
} = require("./dispatch-ledger.js");
const { readJobs } = require("./hung-jobs.js");
const { readSwapHold } = require("./admission.js");
const {
	resumedIdleSince,
	hasRepliedSince,
	hasTurnedSince,
} = require("./block-cause.js");
const { stopOn } = require("./claude-stop.js");
const { jobDirPath, readJobCwd, readJobRecord } = require("./job-paths.js");
const { resumeSteps } = require("./refill-resume.js");
const { buildResumeIo } = require("./resume-io.js");
const { parseJsonl } = require("./jsonl.js");
const {
	readParkMarkers,
	readParkMarkersOrThrow,
	readParkedBy,
	setParked,
	unparkClosed,
	unparkIssues,
	writeParkedBy,
} = require("./parked.js");
const { read: readTranscript } = require("./session-transcript.js");
const { findNewestTranscript, mainChainRecords } = require("./transcript.js");
const { hasConfig, resolveKey } = require("./workflow-core-config.js");
const { readLastTyped } = require("./presence.js");
const { MODEL } = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const { appendTick, concurrencyFiles } = require("./concurrency.js");
const { appendConsoleRow, isConsoleReadDue } = require("./console-credit.js");
const { seatBudget, stopOverAllowance } = require("./overflow-budget.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
} = require("./refill-seats.js");
const {
	buildCheckoutEnv,
	discoverRepos,
	startDetachedIn,
	homeDir,
	isOptedOut,
	readExclusionWhy,
} = require("./refill-repos.js");
const { startLevelling } = require("./level-main.js");
const loop = require("./refill-loop.js");
const core = require("./refill-tick-core.js");
const { buildLaunchesLine } = require("./refill-tick-settle.js");
const { runTick } = core;
const {
	dropManagerRestart,
	loopFiles,
	readManagerRestart,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	writeLoopPause,
} = require("./refill-files.js");
const { readJson } = require("./refill-json.js");
const {
	killSettled,
	launchRecorded,
	ledgerJobOf,
	readState,
	updateState,
} = require("./refill-state.js");
const refillBatch = require("./refill-batch.js");
const blocks = require("./refill-blocks.js");
const {
	attachProbeParks,
	dropLiftedJobs,
	readLiftedHolds,
	readTickHolds,
	tendHolds,
	withTickStores,
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
 * (lib/refill-tick-core.js's stopNeverStarted, #2467): admission charges each a
 * full session until it goes. The log lines. `spared` go unjudged (#3983).
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Set<string>} spared
 */
function stopNeverStarted(registry, spared) {
	const jobs = readJobs()?.filter((j) => !spared.has(j.job)) ?? null;
	return core.stopNeverStarted(registry, jobs, (j) => {
		const r = stopOn(j.seat, j.job);
		return r.ok ? null : r.why;
	});
}

/**
 * Supervise `root`'s landing queue, in that checkout
 * (scripts/supervise-landing.js), logged where it said anything.
 * @param {string} root
 */
function superviseLanding(root) {
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, "supervise-landing.js")],
		{ cwd: root, env: buildCheckoutEnv(root) },
	);
	if (r.out || r.failed) log(blocks.buildChildLine(`landing in ${root}`, r));
}

/** @param {string} root */
const levelMain = (root) =>
	startLevelling(root, (err) =>
		log(`levelling ${root}: not started (${buildErrorText(err)})`),
	);

/**
 * Start a reap pass over `root`'s worktrees folder (`session-checkout.js
 * reap`, #4247), detached: removing a store may outlast a tick. Its report goes
 * to the loop's log; its pid lock turns away a pass started while one runs.
 * @param {string} root
 */
const startReapPass = (root) =>
	startDetached(
		`reaping worktrees in ${root}`,
		[path.join(SCRIPTS, "session-checkout.js"), "reap"],
		root,
	);

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
 * (lib/refill-tick-core.js's FREE_SLOT_ARGS); 0 where it could not judge, so a
 * broken read launches nothing (#2012). `admission` is the verdict behind
 * them, for the concurrency record, or null where it did not read.
 * @returns {{slots: number,
 *   admission: import("./admission.js").AdmissionJson | null}}
 */
function readFreeSlots() {
	const r = runChild(process.execPath, [
		path.join(SCRIPTS, "admission.js"),
		...core.FREE_SLOT_ARGS,
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
 * A printed `/usage` per seat named, through the dispatcher's own probe
 * (scripts/usage-probe.js, #2306): empty where it found the cache fresh or
 * stopped once it refreshed it, with each probe's outcome. A failed one is
 * logged and leaves that seat unread, so the tick waits on it. Timed out, the
 * wrapper's SIGTERM stops the probe's group too.
 * @param {string[]} seats
 */
function readPrintedUsage(seats) {
	const usage = new Map();
	/** @type {import("./seat-reading.js").Probe[]} */
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
		probes.push({ seat, outcome: core.parseProbeOutcome(r.stderr, r.failed) });
	}
	return { usage, probes };
}

/**
 * Each seat's reading, refreshed and sized for this tick by
 * lib/seat-reading.js's readSizedSeats; with the refreshing probes' outcomes.
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
	return seatReading.readSizedSeats(slots, {
		read: (usage) => seatReading.readSeatReadings(seats, usage),
		probe: readPrintedUsage,
		sizeOf: seatReading.capSizer(root, log),
		typedSeat,
		sizeAll,
	});
}

/**
 * The probes of each seat due a read for the panel's figures, past the launch
 * walk's own (lib/seat-reading.js's seatsDueRead). A probe writes its own log,
 * under its working directory's slug, so that slug is no sign a session ran.
 * @param {string[]} seats
 * @param {Record<string, number>} triedAt
 */
function probeDueSeats(seats, triedAt) {
	const now = Date.now();
	const due = seatReading.seatsDueRead(seats, {
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
		now: Date.now,
	});
	log(blocks.buildChildLine(`dispatch ${buildLaunchesLine(batch)}`, r));
	gates.dropTried(files.gates, r.tried, log);
	return { launched: r.launched, refused: r.refused };
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
		const skip = core.buildReviewSkip({
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
 * Run a script of this directory detached in `root`, its stderr the loop's
 * log. Fails open (#3765): a failed start is logged and the next tick decides
 * again. A stop leaves a started run to finish.
 * @param {string} label
 * @param {string[]} args the script and its arguments
 * @param {string} [root]
 */
function startDetached(label, args, root = REVIEW_ROOT) {
	startDetachedIn(root, args, (err) =>
		log(`${label}: not started (${buildErrorText(err)})`),
	);
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
	log(core.buildFinishLine({ ...l, ...progress }));
	return progress;
}

/** lib/refill-blocks.js's CauseOf on the job record and transcript. */
const readCause = blocks.causeReader({
	readJob: (l) => readJobRecordOf(l),
	readTail: (l, job) => readTranscriptRows(l, job),
	log,
});

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
 * Add `numbers` to session `sessionId`'s `.parked-` marker with `record`;
 * null once written, else why not. Fails open: an unwritten marker leaves the
 * label for a claim to clear, and the loop line says so (#3584).
 * @type {import("./refill-blocks.js").BlockIo["recordParked"]}
 */
function recordParked(sessionId, numbers, record) {
	try {
		writeParkedBy(
			sessionId,
			[...readParkedBy(sessionId, record.root), ...numbers],
			record,
		);
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

const resume = resumeSteps(buildResumeIo(log));

/**
 * Type `prompt` into `l`'s live session through a pseudo-terminal
 * `claude attach` (#2354 F6). Null once typed, else why not.
 * @param {import("./refill-blocks.js").JobLaunch} l
 * @param {string} prompt
 */
function typeResume(l, prompt) {
	const [file, args, opts] = buildTypedAttach(l.jobId, prompt);
	return childFailure(
		runChild(file, args, { ...opts, cwd: l.root, env: resume.seatEnv(l) }),
	);
}

/** @param {import("./refill-loop.js").LoopLaunch} l */
const writeLaunch = (l) => updateState(launchRecorded(l), log);

/**
 * `state` with the members of the batch a kill cut off that started tracked
 * (lib/refill-batch.js's adoptLaunching, #4180), each gated one's judgement
 * dropped as its launch would have.
 * @param {import("./refill-state.js").LoopState} state
 * @param {string[]} served
 */
const adoptKilledLaunches = (state, served) =>
	core.settleLaunching(state, (launching) => {
		const launched = refillBatch.adoptLaunching(launching, {
			entriesOf: (root) => readRecentEntries(root, LEDGER_WINDOW_HOURS).entries,
			readActsBefore: buildActsBeforeReader(served),
			recordLaunch,
			adoptResumed: (l, { seat, sessionId, cwd }, since) =>
				resume.adoptResumed({ ...l, seat }, { sessionId, cwd }, since),
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
			resume.resumeStopped({ root, issues, seat }, parkedPromptOf(parkCause), {
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
 * `rescue-sessions.js` run with `args` in `root`'s checkout.
 * @param {string} root
 * @param {string[]} args
 */
const postHandOff = (root, args) =>
	runChild(
		process.execPath,
		[path.join(SCRIPTS, "rescue-sessions.js"), ...args],
		{
			cwd: root,
			env: buildCheckoutEnv(root),
		},
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
	resumeTargetOf: resume.readResumeTarget,
	resumeStopped: resume.resumeStopped,
	adoptResumed: resume.adoptResumed,
	writeLaunch,
	admitResume,
	stagger: staggerResume,
	moveSession: resume.moveSession,
	removeJobRecord: resume.removeJobRecord,
	jobStateOf: readJobRecordOf,
	writeLedgerHold: (l, until) =>
		recordLaunch({
			issues: l.issues,
			model: MODEL,
			prompt: l.prompt,
			root: l.root,
			jobId: ledgerJobOf(l),
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
	readJobCwd,
	readParkMarkers: readParkMarkersOrNull,
	findParkTranscript,
	readMainChain,
	unparkSession,
	comment: commentOn,
	postHandOff,
	release,
	progressOf: (l) => readProgress(l, served),
	readActsBefore: buildActsBeforeReader(served),
	log,
});

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
 * `state` with what a kill before the last tick's own write left out of it
 * settled (#4180): its cut-off batch's launches adopted, then each resume left
 * with no outcome (lib/refill-blocks.js's settleStartedResumes), ahead of any
 * judging of the launches. Written at once where either changed it, so a stamp
 * later this tick lands on what was settled; what was written is returned, so
 * the tick reads on from the file (#4232).
 * @param {import("./refill-state.js").LoopState} read
 * @param {string[]} served
 */
function settleKilled(read, served) {
	const adopted = adoptKilledLaunches(read, served);
	const { launches, settled } = blocks.settleStartedResumes(
		adopted.launches,
		blockIo(served),
	);
	if (adopted === read && !settled) return read;
	return updateState(
		killSettled({ launches, launchCount: adopted.launchCount }, read),
		log,
	);
}

/**
 * What of each lifted hold the written state now carries, dropped.
 * @param {ReturnType<typeof blocks.queueLifted>["settled"]} settled
 */
function dropSettledLifted(settled) {
	for (const { hold, jobs } of settled) dropLiftedJobs(hold, jobs, log);
}

/**
 * The control lock's half of a control change: `change` made on a fresh read
 * and written, or the lock's holder where it stayed held past `waitMs`.
 * @param {(c: import("./refill-loop.js").Control) => import("./refill-loop.js").Control|null} change
 * @param {number} waitMs
 * @returns {import("./refill-tick-core.js").ControlWrite|{busy: string}}
 */
function changeControl(change, waitMs) {
	const written = withControlLock(() => {
		const fresh = readControl().control;
		const write = fresh && change(fresh);
		if (!fresh || !write) return { control: fresh, wrote: null };
		writeControlFile(write);
		return { control: write, wrote: { write, fresh } };
	}, waitMs);
	return "busy" in written ? { busy: written.busy } : written.done;
}

/**
 * Give each overflow launch the session id `agents` lists for its job
 * (lib/dispatch-ledger.js's recordListedSessionIds), logging what fails.
 * @param {import("./agent-liveness.js").AgentRecord[]} agents
 */
function recordListedOverflowSessions(agents) {
	try {
		for (const line of recordListedSessionIds(agents)) log(line);
	} catch (e) {
		log(`overflow session ids not recorded: ${buildErrorText(e)}`);
	}
}

/**
 * The quiet bench route's step; the control as it was on a step that failed,
 * which is logged, the next tick deciding it again.
 * @param {import("./refill-loop.js").Control} control
 * @param {{lastTypedAt: number|null, served: string[], now: number}} tick
 */
function stepQuietBench(control, { lastTypedAt, served, now }) {
	try {
		return tendQuietBench({ control, lastTypedAt, served, now, log });
	} catch (e) {
		/* Fails open, as a failed read inside a tick does (#3852). */
		log(`quiet bench: step failed: ${buildErrorText(e)}`);
		return control;
	}
}

/* Untraced: another writer holds it for one read and write, and the next tick
 * tries again. */
const TICK_LOCK_WAIT_MS = 1000;

/**
 * The adapter of lib/refill-tick-core.js's runTick: this module's reads,
 * writes and child processes.
 * @type {import("./refill-tick-core.js").TickIo}
 */
const productionIo = {
	now: Date.now,
	log,
	readControl,
	changeControl: (change) => changeControl(change, TICK_LOCK_WAIT_MS),
	isOptedOut,
	readConfiguredSeats,
	readIncluded,
	servedRoots,
	reap: reapFinished,
	tendQuietBench: stepQuietBench,
	readManagerRestart: () => readManagerRestart(log),
	readCurrentBootId,
	readState: () => readState(log),
	settleKilled,
	readRegistry: readRegistryAgents,
	stopNeverStarted,
	hasConfig,
	superviseLanding,
	levelMain,
	startReapPass,
	fileMachineTickets,
	tendHolds: (roots, served, now) => tendHolds(roots, served, now, log),
	readListing: (trusted) =>
		trusted ? readAgentsAfterBoot() : listedAgents({ requireSelf: false }),
	recordListedOverflowSessions,
	stopOverAllowance,
	blockIo,
	readSwapHold,
	sendHoldNotices: (roots, { agents, isPaused }, now) =>
		tendHoldNotices(roots, { agents, isPaused }, now, log),
	readProgress,
	readCause,
	unparkAnswered: blocks.unparkAnswered,
	tendClosedParks,
	actOnBlocks: blocks.actOnBlocks,
	actOnIdle: blocks.actOnIdle,
	releaseAwayParks: (launches, mode, served, seen) =>
		blocks.releaseAwayParks(launches, mode, served, seen.io),
	attachProbeParks: (broken, launches) =>
		attachProbeParks(broken, launches, log),
	readLiftedHolds: (roots) => readLiftedHolds(roots, log),
	releaseEndedHolds: blocks.releaseEndedHolds,
	readFreeSlots,
	actOnLimits: actOnLimitsAndRelease,
	readSeats,
	probeDueSeats,
	seatBudget,
	startDueConsoleReads,
	capSizer: (root) => seatReading.capSizer(root, log),
	readGateJudgements: () => gates.readGateStore(files.gates, log).pending,
	readTickHolds,
	readFrontier: refillFrontier,
	readParkMarkers,
	launchBatch: launchOrResume,
	resumeHeld: (resumes, held, seen, how) =>
		blocks.resumeHeldLaunches(resumes, held, seen, how),
	writePause: (pause, noProgressFrom) =>
		writeLoopPause(pause, noProgressFrom, log),
	runReview,
	updateState: (transition) => updateState(transition, log),
	readOmittedDirs,
	dropSettledLifted,
	dropManagerRestart: (marker) => dropManagerRestart(marker, log),
	appendTick: (record) => {
		if (!appendTick(record))
			log(`concurrency record: not written to ${concurrencyFiles().record}`);
	},
};

/**
 * One tick (lib/refill-tick-core.js's runTick): its decision and the start it
 * judged against. Under `dryRun` nothing is reaped, launched or written.
 * @param {{dryRun: boolean}} opts
 */
function tick({ dryRun }) {
	const now = Date.now();
	const control = readControl();
	const declared = readDeclaredSeats();
	return withTickStores(() =>
		runTick(productionIo, {
			dryRun,
			now,
			opening: { control, declared, typed: readLastTyped(declared) },
		}),
	);
}

module.exports = {
	DISPATCHER,
	files,
	log,
	isReviewRunning,
	say,
	servedRoots,
	tick,
};
