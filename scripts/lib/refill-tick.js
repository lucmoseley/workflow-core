/*
 * refill-tick.js — the refill loop's tick adapter (#2012, #2123, spec #1995,
 * #4212): the child processes, files and listings lib/refill-tick-core.js's
 * runTick reads and writes, which owns the tick's step order and its dry-run
 * policy. scripts/refill-loop.js's `run` drives it and its `dry-run` prints
 * one, through the dry-run adapter, whose acts are no-ops. The CLI logs through
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

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedAgents, readAgentsAfterBoot } = require("./agent-liveness.js");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { readRegistryAgents } = require("./registry-agents.js");
const { readActsBy } = require("./arbiter-store.js");
const { PROBE_CWD, PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { hasSeatRunSince } = require("./project-dirs.js");
const { projectSlug, transcriptPath } = require("./project-slug.js");
const { fileSpend, sessionSpendUsd } = require("./session-spend.js");
const { readAllowance } = require("./allowance.js");
const seatReading = require("./seat-reading.js");
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
	recordListedSessionIds,
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
const { buildKeySettings } = require("./overflow-key.js");
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
const { MODEL, hasRoom, isParked } = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const { appendTick, concurrencyFiles } = require("./concurrency.js");
const { appendConsoleRow, isConsoleReadDue } = require("./console-credit.js");
const { seatBudget, stopOverAllowance } = require("./overflow-budget.js");
const {
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
	isSameSeat,
	seatIdOf,
} = require("./refill-seats.js");
const {
	buildCheckoutEnv,
	discoverRepos,
	homeDir,
	isOptedOut,
	readExclusionWhy,
} = require("./refill-repos.js");
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
						...seatIdOf(l),
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
 * The environment and `--settings` a `--bg` launch of `l`'s session hands its
 * child: on an overflow seat, its key's helper and neither a key nor this
 * process's session id, as dispatch-sessions.sh launches it (#3701); why not
 * where the key cannot be read.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "seat"|"keyVar">} l
 * @returns {{env: NodeJS.ProcessEnv, settings?: string}|{why: string}}
 */
function buildSeatLaunch(l) {
	/** @type {NodeJS.ProcessEnv} */
	const env = seatEnv(l);
	if (!l.keyVar) return { env };
	const built = buildKeySettings(l.keyVar);
	if ("why" in built) return built;
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_SESSION_ID;
	delete env[l.keyVar];
	return { env, settings: built.settings };
}

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
			job: { ...seatIdOf({ seat, keyVar }), jobId, cwd },
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
 * mark a parking session can read (#4147), naming the session it copies so the
 * cap prices the two together (#4195). No issues, so the row holds nothing:
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
			overflow: {
				keyVar,
				allowanceUsd: first.allowanceUsd,
				sessionId,
				copyOf: from,
			},
		});
		if (!written) log(failure);
	} catch (e) {
		log(`${failure}: ${buildErrorText(e)}`);
	}
}

/**
 * The dispatch-ledger row for job `run`, which a resume of session `from`
 * started on `l`'s overflow seat, where it owes one: a move onto the key's
 * first launch there, at its allowance (#3736), else a copy's, at its first
 * job's. A plan seat's job, or one woken in place on its key, owes none.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"seat"|"keyVar">} l
 * @param {string} from
 * @param {{jobId: string, sessionId: string|null}} run
 * @param {{copy: boolean, cwd: string,
 *   move?: import("./refill-blocks.js").MoveTarget}} how  `move`, the target
 *   of a move onto the key
 * @returns {string|null} why a move's job could not be recorded, which stops
 *   it, else null
 */
function recordOnKey({ root, seat, keyVar }, from, run, how) {
	if (!keyVar) return null;
	const { copy, move } = how;
	if (!move) {
		if (copy) recordOverflowCopy({ root, keyVar }, from, run);
		return null;
	}
	const failed =
		move.allowanceUsd === undefined
			? "no allowance read for the key"
			: recordMovedOverflow({ root, keyVar }, from, {
					...run,
					allowanceUsd: move.allowanceUsd,
					offKeyUsd: readOffKeyUsd({ seat, from, cwd: how.cwd, copy }),
				});
	if (!failed) return null;
	/* Unrecorded, it would run on the key uncapped and unreserved. */
	const stop = stopOn(seat, run.jobId);
	return stop.ok || stop.noJob
		? failed
		: `${failed}, and its job not stopped: ${stop.why}`;
}

/**
 * What a session moved onto a key carries in its new transcript from before
 * the move, which its plan paid (#3736): a copy repeats its parent's
 * main-thread requests (#4195), and a job woken in place keeps its whole
 * session. Read off the parent's transcript the move put on `seat`; 0 where it
 * will not read, which charges the key for it.
 * @param {{seat: string, from: string, cwd: string, copy: boolean}} moved
 */
function readOffKeyUsd({ seat, from, cwd, copy }) {
	const file = transcriptPath(seat, cwd, from);
	return copy ? fileSpend(file).usd : sessionSpendUsd(file);
}

/**
 * Record the job a move onto an overflow seat started as a launch on its key,
 * with the allowance it moved with (#3736), so the budget gate reserves for it
 * and the allowance stop caps it as any overflow launch. No issues, as a
 * copy's: the launch it moved keeps the ledger hold.
 * @param {{root: string, keyVar: string}} on
 * @param {string} from the session it moved
 * @param {{jobId: string, sessionId: string|null, allowanceUsd: number,
 *   offKeyUsd: number}} run
 * @returns {string|null} why it was not recorded, else null
 */
function recordMovedOverflow({ root, keyVar }, from, run) {
	const failure = `moved overflow job ${run.jobId} of ${from} not recorded in the dispatch ledger`;
	try {
		/* Recorded already where a kill came after the record and before the
		 * state write, and the next step adopts the job (#4180). */
		if (readOverflowLookup([root])({ jobId: run.jobId })) return null;
		const written = recordLaunch({
			issues: [],
			model: MODEL,
			prompt: `move of ${from}`,
			root,
			jobId: run.jobId,
			overflow: {
				keyVar,
				allowanceUsd: run.allowanceUsd,
				sessionId: run.sessionId,
				offKeyUsd: run.offKeyUsd,
			},
		});
		return written ? null : failure;
	} catch (e) {
		return `${failure}: ${buildErrorText(e)}`;
	}
}

/**
 * `claude --bg --resume <full id> "<prompt>"` of `l`'s stopped job, from its
 * cwd (#2354 F6). The launcher exits 0 whatever happens (F8). On 2.1.310 it
 * wakes a stopped job in place, else starts a copy under a new job and
 * session id, which carries the conversation on and takes the issue claims
 * (#2963, #2968). An overflow session's carries its key's `--settings`
 * (buildSeatLaunch), so it never bills the plan, and the flags always start a
 * copy (#3692 (d)). The resume counts where the launcher named the job it
 * started (lib/bg-resume.js) and that job's state.json does not read failed;
 * a later tick judges the resumed turn.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar">} l
 * @param {string} prompt
 * @param {{sessionId: string, cwd: string}} target
 * @param {import("./refill-blocks.js").MoveTarget} [move] the target of a
 *   move onto `l`'s seat, which `l` already names
 * @returns {import("./refill-blocks.js").Resumed}
 */
function resumeStopped(l, prompt, { sessionId, cwd }, move) {
	const launch = buildSeatLaunch(l);
	if ("why" in launch) return { failed: launch.why };
	const { env, settings } = launch;
	const refusal = launchAuthRefusal({ bin: claudeBin(), env, cwd, settings });
	if (refusal) return { failed: refusal };
	const keyArgs = settings === undefined ? [] : ["--settings", settings];
	const r = runChild(
		claudeBin(),
		["--bg", "--resume", sessionId, ...keyArgs, prompt],
		{ cwd, env },
	);
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
	if (!started.copy)
		return settleWoken(l, { jobId, sessionId, cwd, after }, move);
	const copySession =
		typeof after?.sessionId === "string" ? after.sessionId : null;
	return settleCopy(l, sessionId, { jobId, sessionId: copySession, cwd }, move);
}

/**
 * A resume that woke the stopped job itself: confirmed where its state.json,
 * which already names its session, reads it no longer stopped; on a move onto
 * a key, recorded as that key's launch.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"seat"|"keyVar">} l
 * @param {{jobId: string, sessionId: string, cwd: string,
 *   after: {state?: unknown, sessionId?: unknown}|null}} woken
 * @param {import("./refill-blocks.js").MoveTarget} [move]
 * @returns {import("./refill-blocks.js").Resumed}
 */
function settleWoken(l, { jobId, sessionId, cwd, after }, move) {
	if (after?.sessionId !== sessionId || after.state === "stopped")
		return {
			failed: `not confirmed: job ${jobId}'s state.json reads ${after?.state ?? "(unread)"}, session ${after?.sessionId ?? "(unread)"}, not ${sessionId}`,
		};
	return recordWoken(l, { sessionId, cwd }, { jobId, sessionId }, move);
}

/**
 * Hand copy `copy` of session `from` what the session held: on an overflow
 * seat its ledger mark, then its issue claims, pass markers and park marker.
 * The mark comes first, so a move's copy that will not record, and is
 * stopped, takes nothing from the session it leaves held.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar">} l
 * @param {string} from
 * @param {{jobId: string, sessionId: string|null, cwd: string}} copy
 * @param {import("./refill-blocks.js").MoveTarget} [move] a move onto the
 *   key, whose allowance the copy, that key's first launch of the session,
 *   runs at (#3736)
 * @returns {import("./refill-blocks.js").Resumed} failed only where a move's
 *   job will not record, and is stopped
 */
function settleCopy(l, from, copy, move) {
	const { jobId, sessionId } = copy;
	const unrecorded = recordOnKey(
		l,
		from,
		{ jobId, sessionId },
		{ copy: true, cwd: copy.cwd, move },
	);
	if (unrecorded) return { failed: unrecorded };
	if (sessionId) {
		moveClaims(l, from, sessionId);
		movePasses(l, from, sessionId);
	} else
		log(
			`no session id read for copy ${jobId}: its issue claims and pass markers not moved`,
		);
	moveParked(l, from, copy);
	return { failed: null, jobId, sessionId, copy: true };
}

/**
 * lib/resumed-copy.js's findResumed for `l`'s seat, past `l`'s earlier
 * sessions: a copy found is handed what the session held (#4157, #4180); why
 * not, where the job store or a transcript will not read.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"issues"|"seat"|"keyVar"|"pastSessionIds">} l
 * @param {{sessionId: string, cwd: string}} target
 * @param {number} since
 * @param {import("./refill-blocks.js").MoveTarget} [move] the target of a
 *   move onto `l`'s seat, which `l` already names
 * @returns {import("./refill-blocks.js").Adopted}
 */
function adoptResumed(l, target, since, move) {
	const found = findResumed(l.seat, target, since, l.pastSessionIds ?? []);
	if (found === null || "unread" in found) return found;
	const { jobId, sessionId } = found;
	const r = found.copy
		? settleCopy(
				l,
				target.sessionId,
				{ jobId, sessionId, cwd: target.cwd },
				move,
			)
		: recordWoken(l, target, { jobId, sessionId }, move);
	/* A move's job that will not record is stopped, so it reads as no job. */
	return r.failed === null ? r : { unread: r.failed };
}

/**
 * The job a resume woke in place, confirmed or found after a kill; on a move
 * onto a key, recorded as that key's launch.
 * @param {Pick<import("./refill-loop.js").LoopLaunch, "root"|"seat"|"keyVar">} l
 * @param {{sessionId: string, cwd: string}} target
 * @param {{jobId: string, sessionId: string|null}} found
 * @param {import("./refill-blocks.js").MoveTarget} [move]
 * @returns {import("./refill-blocks.js").Resumed}
 */
function recordWoken(l, target, { jobId, sessionId }, move) {
	const unrecorded = recordOnKey(
		l,
		target.sessionId,
		{ jobId, sessionId },
		{ copy: false, cwd: target.cwd, move },
	);
	return unrecorded
		? { failed: unrecorded }
		: { failed: null, jobId, sessionId, copy: false };
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
 * @param {import("./refill-blocks.js").MoveTarget} target
 * @param {string} prompt
 * @param {{sessionId: string, cwd: string}} ids
 * @returns {import("./refill-blocks.js").Resumed}
 */
function moveSession(l, target, prompt, ids) {
	const { seat } = target;
	const { sessionId, cwd } = ids;
	const prepared =
		copyTranscript({ from: l.seat, to: seat, sessionId, cwd }) ??
		removeJobRecord(seat, sessionId, cwd);
	if (prepared) return { failed: prepared };
	const r = resumeStopped(blocks.movedOnto(l, target), prompt, ids, target);
	if (r.failed === null) return r;
	const stop = stopOn(seat, shortJobId(sessionId));
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
		parkers.some((p) => p.job && isSameSeat(p.job, s))
			? { ...s, fits: seatReading.capSizer(root, log)(s.seat, 1) }
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
	readParkMarkers: readParkMarkersOrNull,
	findParkTranscript,
	readMainChain,
	unparkSession,
	comment: commentOn,
	postHandOff,
	release: (l) => release({ jobId: ledgerJobOf(l), root: l.root }),
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
 * @param {"normal"|"away"} mode
 * @param {string[]} served
 * @param {Parameters<typeof blocks.actOnBlocks>[2]} seen
 */
function actOnLaunches(listed, mode, served, seen) {
	blocks.unparkAnswered(readParkSweepRoots(served), seen);
	tendClosedParks(served);
	return blocks.releaseAwayParks(
		blocks.actOnIdle(blocks.actOnBlocks(listed, mode, seen), mode, seen),
		mode,
		served,
		seen.io,
	);
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
 * Stop each overflow session past its allowance (lib/overflow-budget.js,
 * #3698), logged. Paused or stopping alike: a running overflow session spends
 * either way.
 * @param {Parameters<typeof stopOverAllowance>[0]} declared
 * @param {Parameters<typeof stopOverAllowance>[1]} agents
 */
function capOverflowSessions(declared, agents) {
	const hasOverflow = declared.seats.some((s) => s.kind === "overflow");
	if (agents && hasOverflow && declared.errors.length === 0)
		recordListedOverflowSessions(agents);
	for (const line of stopOverAllowance(declared, agents)) log(line);
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
 * The production adapter of lib/refill-tick-core.js's runTick: this module's
 * reads, writes and child processes.
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
	reap: () => reapFinished(false),
	tendQuietBench: stepQuietBench,
	readManagerRestart: () => readManagerRestart(log),
	readCurrentBootId,
	readState: () => readState(log),
	settleKilled,
	readRegistry: readRegistryAgents,
	stopNeverStarted,
	tendCheckouts,
	readListing: (trusted) =>
		trusted ? readAgentsAfterBoot() : listedAgents({ requireSelf: false }),
	capOverflowSessions,
	blockIo,
	readSwapHold,
	sendHoldNotices: (roots, { agents, isPaused }, now) =>
		tendHoldNotices(roots, { agents, isPaused }, now, log),
	readProgress,
	readCause,
	actOnLaunches,
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
	readParkers,
	sizeParkerSeats,
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

/** A dry run's act: none. */
const noAct = () => undefined;

/**
 * The dry run's adapter: the production one with every act a no-op answering as
 * though nothing was done, and the reap its own dry run.
 * @type {import("./refill-tick-core.js").TickIo}
 */
const dryRunIo = {
	...productionIo,
	changeControl: () => null,
	reap: () => reapFinished(true),
	tendQuietBench: (control) => control,
	settleKilled: (read) => read,
	stopNeverStarted: () => [],
	tendCheckouts: () => [],
	capOverflowSessions: noAct,
	sendHoldNotices: noAct,
	actOnLaunches: (listed) => listed,
	attachProbeParks: noAct,
	releaseEndedHolds: noAct,
	actOnLimits: (_before, judged, _mode, { slots }) => ({
		launches: judged,
		slots,
		workingChange: 0,
	}),
	probeDueSeats: () => [],
	startDueConsoleReads: noAct,
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
	return runTick(dryRun ? dryRunIo : productionIo, {
		dryRun,
		now,
		opening: { control, declared, typed: readLastTyped(declared) },
	});
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
