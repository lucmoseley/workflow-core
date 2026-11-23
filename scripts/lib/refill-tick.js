const fs = require("node:fs");
const path = require("node:path");
const { listedAgents, readAgentsAfterBoot } = require("./agent-liveness.js");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { readRegistryAgents } = require("./registry-agents.js");
const { readActsBy, readLastActAt } = require("./arbiter-store.js");
const { PROBE_CWD, PROBE_TIMEOUT_MS } = require("./usage-probe.js");
const { hasSeatRunSince } = require("./project-dirs.js");
const { projectSlug } = require("./project-slug.js");
const { printsWeek, readAllowance } = require("./allowance.js");
const { readUsageCache } = require("./usage-cache.js");
const seatReading = require("./seat-reading.js");
const { probeNetwork } = require("./net-probe.js");
const { buildTypedAttach } = require("./claude-attach.js");
const { buildErrorText, caught, readLogged } = require("./caught.js");
const { childFailure } = require("./child-failure.js");
const { runTickChild: runChild } = require("./child-spawn.js");
const { checkoutPeakMb } = require("./tsc-slot.js");
const { parseErrLine, gh } = require("./gh.js");
const gates = require("./gate-sweep.js");
const {
	DEFAULT_WINDOW_HOURS,
	readRecentEntries,
	record: recordLaunch,
	recordListedSessionIds,
	release,
} = require("./dispatch-ledger.js");
const { readJobs } = require("./hung-jobs.js");
const { readSwapHold } = require("./admission.js");
const {
	resumedIdleSince,
	syntheticStopAt,
	hasRepliedSince,
	isResumedSinceApiStop,
	hasFounderTypedSinceApiStop,
	hasTurnedSince,
} = require("./block-cause.js");
const { stopOn } = require("./claude-stop.js");
const { jobDirPath, readJobCwd } = require("./job-paths.js");
const { resumeSteps } = require("./refill-resume.js");
const {
	adoptOnSeat,
	parkedCarryOf,
	resumeOnSeat,
} = require("./refill-carry.js");
const { buildSeatEnv } = require("./seat-claude.js");
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
const { readLastTypedSeat } = require("./presence.js");
const { MODEL } = require("./refill-decide.js");
const { refillFrontier } = require("./refill-frontier.js");
const { appendTick, concurrencyFiles } = require("./concurrency.js");
const { appendBreakerEvents, buildLookbackOf } = require("./refill-breaker.js");
const { readThroughput } = require("./throughput-reads.js");
const { appendConsoleRow, isConsoleReadDue } = require("./console-credit.js");
const { seatBudget } = require("./overflow-budget.js");
const { stopOverAllowance } = require("./overflow-cap.js");
const {
	buildSeatLabel,
	overflowSeatsOf,
	readConfiguredSeats,
	readDeclaredSeats,
	readOmittedDirs,
} = require("./refill-seats.js");
const { readRun } = require("./headless-runs.js");
const { buildLaunchRecordReader } = require("./launch-record.js");
const {
	buildCheckoutEnv,
	discoverRepos,
	startDetachedIn,
	homeDir,
	isOptedOut,
} = require("./refill-repos.js");
const { startLevelling } = require("./level-main.js");
const loop = require("./refill-loop.js");
const core = require("./refill-tick-core.js");
const { buildLaunchesLine } = require("./refill-tick-settle.js");
const { runTick } = core;
const {
	dropManagerRestart,
	readManagerRestart,
	REVIEW_RUNNER,
	readControlChecked,
	withControlLock,
	writeControlFile,
	writeRepoPauses,
} = require("./refill-files.js");
const { readJson, writeJson } = require("./refill-json.js");
const { actOnOutside } = require("./refill-outside.js");
const { OUTSIDE_FILE, refillPath } = require("./refill-dir.js");
const { readReaped, writeReapedRead } = require("./reaped-jobs.js");

const {
	launchRecorded,
	ledgerJobOf,
	readState,
	updateState,
} = require("./refill-state.js");
const refillBatch = require("./refill-batch.js");
const { iso, launchName } = require("./refill-block-core.js");
const blocks = require("./refill-blocks.js");
const {
	attachProbeParks,
	holdLockedOut,
	dropLiftedJobs,
	readLiftedHolds,
	readTickHolds,
	tendHolds,
	withTickStores,
} = require("./repo-holds.js");
const { tendHoldNotices } = require("./repo-hold-notices.js");
const { buildPauseFiler, tendPauseNotices } = require("./pause-notices.js");
const { sleepSync } = require("./sleep-sync.js");
const { localDate } = require("./local-date.js");
const { pidLock } = require("./pid-lock.js");
const { parkedPromptOf } = require("./loop-prompts.js");
const { files, log, servedRoots } = require("./refill-io.js");
const { registrationGate } = require("./git-file.js");

// guess, #2306
const PROBE_CHILD_TIMEOUT_MS = PROBE_TIMEOUT_MS + 15 * 1000;

const SCRIPTS = path.dirname(__dirname);
const REVIEW_ROOT = path.dirname(SCRIPTS);
const DISPATCHER = path.join(SCRIPTS, "dispatch-sessions.js");
const reviewRootReads = registrationGate(REVIEW_ROOT, (fault) =>
	log(`machine children not run: git does not read ${REVIEW_ROOT}, ${fault}`),
);

/** @param {string} root */
const inCheckout = (root) => ({ cwd: root, env: buildCheckoutEnv(root) });

const readIncluded = () => discoverRepos(homeDir()).included;

const readControl = () => readControlChecked(log);

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
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Set<string>} spared
 * @returns {string[]}
 */
function stopNeverStarted(registry, spared) {
	const jobs = readJobs()?.filter((j) => !spared.has(j.job)) ?? null;
	return core.stopNeverStarted(registry, jobs, (j) => {
		const r = stopOn(j.seat, j.job);
		return r.ok ? null : r.why;
	});
}

/** @param {string} root */
function superviseLanding(root) {
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, "supervise-landing.js")],
		inCheckout(root),
	);
	if (r.out || r.failed) log(blocks.buildChildLine(`landing in ${root}`, r));
}

/** @param {string} root */
const levelMain = (root) =>
	startLevelling(root, (err) =>
		log(`levelling ${root}: not started (${buildErrorText(err)})`),
	);

/** @param {string} root */
const startWarmPass = (root) =>
	startDetached(
		`warming the dependency store in ${root}`,
		[path.join(SCRIPTS, "session-checkout.js"), "warm"],
		root,
	);

/** @param {string} root */
const startReapPass = (root) =>
	startDetached(
		`reaping worktrees in ${root}`,
		[path.join(SCRIPTS, "session-checkout.js"), "reap"],
		root,
	);

/**
 * @param {string} script
 * @param {string} label
 */
function runMachineChild(script, label) {
	if (!hasConfig(REVIEW_ROOT) || !reviewRootReads()) return;
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, script)],
		inCheckout(REVIEW_ROOT),
	);
	if (r.out || r.failed) log(blocks.buildChildLine(label, r));
}

/**
 * @param {string|undefined} root
 * @returns {{slots: number,
 *   admission: import("./admission.js").AdmissionJson | null}}
 */
function readFreeSlots(root) {
	const r = runChild(
		process.execPath,
		[path.join(SCRIPTS, "admission.js"), ...core.FREE_SLOT_ARGS],
		root ? inCheckout(root) : {},
	);
	try {
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

/** @param {string[]} seats */
function readPrintedUsage(seats) {
	const usage = new Map();
	/** @type {import("./seat-reading.js").Probe[]} */
	const probes = [];
	for (const seat of seats) {
		const startMs = Date.now();
		const r = runChild(
			process.execPath,
			[path.join(SCRIPTS, "usage-probe.js"), "--config-dir", seat],
			{ timeout: PROBE_CHILD_TIMEOUT_MS },
		);
		if (r.failed && r.status !== 3) log(`/usage on ${seat}: ${r.failed}`);
		usage.set(seat, r.stdout);
		const cache = readUsageCache(seat);
		const stampMs = cache.state === "ok" ? cache.fetchedAtMs : null;
		const outcome = seatReading.probeOutcome(
			core.parseProbeOutcome(r.stderr, r.failed),
			{ printedWeek: printsWeek(r.stdout), stampMs, startMs },
		);
		probes.push({ seat, outcome, stampMs });
	}
	return { usage, probes };
}

/**
 * @param {string[]} seats
 * @param {number} slots
 * @param {string|undefined} root
 * @param {{typedSeat: string|null, sizeAll?: boolean,
 *   tries: {triedAt: Record<string, number>, now: number}}} how
 */
function readSeats(seats, slots, root, { typedSeat, sizeAll = false, tries }) {
	return seatReading.readSizedSeats(slots, {
		read: (usage) => seatReading.readSeatReadings(seats, usage),
		probe: readPrintedUsage,
		sizeOf: seatReading.capSizer(root, log),
		typedSeat,
		sizeAll,
		tries,
	});
}

/**
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

/** @param {import("./refill-decide.js").Launch[]} batch */
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
		entriesOf: (root) => readRecentEntries(root, DEFAULT_WINDOW_HOURS).entries,
		sessionOf: readHeadlessSession,
		now: Date.now,
	});
	log(blocks.buildChildLine(`dispatch ${buildLaunchesLine(batch)}`, r));
	gates.dropTried(files.gates, r.tried, log);
	return { launched: r.launched, refused: r.refused };
}

/** @param {string} jobId */
const readHeadlessSession = (jobId) =>
	readLogged(log, `headless run ${jobId}`, () => readRun(jobId))?.sessionId;

/** @returns {import("./refill-loop.js").ReviewResult|null} */
function takeReviewResult() {
	const taken = `${files.review}.${process.pid}`;
	// #3765
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

const isReviewRunning = () =>
	pidLock(files.reviewPid, REVIEW_RUNNER).holder() !== null;

/**
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
 * @param {string} label
 * @param {string[]} args
 * @param {string} [root]
 */
function startDetached(label, args, root = REVIEW_ROOT) {
	startDetachedIn(root, args, (err) =>
		log(`${label}: not started (${buildErrorText(err)})`),
	);
}

/** @param {import("./refill-loop.js").ReviewStart} start */
function startReview(start) {
	startDetached(start.label, [
		path.join(SCRIPTS, REVIEW_RUNNER),
		JSON.stringify(start),
	]);
}

/**
 * @param {ReturnType<typeof readDeclaredSeats>} declared
 * @param {import("./refill-decide.js").SeatReading[]} plan
 * @param {string|undefined} root
 */
function startDueConsoleReads(declared, plan, root) {
	const now = Date.now();
	for (const seat of overflowSeatsOf(declared.seats)) {
		const budget = seatBudget(seat, root);
		if ("why" in budget || !isConsoleReadDue(seat, budget, plan, now)) continue;
		try {
			appendConsoleRow(seat, { at: now, started: true });
		} catch (err) {
			log(
				`console read of ${buildSeatLabel(seat)}: not started (${buildErrorText(err)})`,
			);
			continue;
		}
		startDetached(`console read of ${buildSeatLabel(seat)}`, [
			path.join(SCRIPTS, "read-console-credit.js"),
			seat.keyVar,
		]);
	}
}

/**
 * @param {string} root
 * @param {string[]} served
 */
const actRootsOf = (root, served) => [...new Set([...served, root])];

/**
 * @param {string[]} served
 * @returns {import("./refill-blocks.js").ReadActsBefore}
 */
const buildActsBeforeReader = (served) => (root, sessionId) =>
	loop.readActsSoFar(sessionId, actRootsOf(root, served), readActsBy);

/**
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {string[]} served
 */
function readProgress(l, served) {
	const progress = loop.actsOf(l, actRootsOf(l.root, served), readActsBy);
	log(core.buildFinishLine({ ...l, ...progress }));
	return progress;
}

/**
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {string[]} served
 */
function readLoopLastActAt(launches, served) {
	const { at, unread } = loop.lastActOf(
		launches,
		(l) => actRootsOf(l.root, served),
		readLastActAt,
	);
	for (const { sessionId, root } of unread)
		log(`act time of ${sessionId} in ${root} unread: counted as no act`);
	return at;
}

const readCause = blocks.causeReader({
	readJob: (l) => readJobRecordOf(l),
	readTail: (l, job) => readTranscriptRows(l, job),
	log,
});

/** @param {import("./refill-loop.js").LoopLaunch} l */
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

/** @type {import("./refill-blocks.js").BlockIo["recordParked"]} */
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

/** @param {import("./refill-blocks.js").SessionRef} l */
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

const resumeIo = buildResumeIo(log);
const resume = resumeSteps(resumeIo);
const readJobRecordOf = buildLaunchRecordReader(resumeIo);

/**
 * @param {import("./refill-blocks.js").SessionRef} l
 * @param {string} prompt
 */
function typeResume(l, prompt) {
	const [file, args, opts] = buildTypedAttach(l.jobId, prompt);
	return childFailure(
		runChild(file, args, {
			...opts,
			cwd: l.root,
			env: buildSeatEnv(resumeIo.env(), l.seat),
		}),
	);
}

/** @returns {import("./refill-outside.js").Outside[]} */
function readOutside() {
	const raw = readJson(refillPath(OUTSIDE_FILE), log);
	return Array.isArray(raw) ? raw : [];
}

/**
 * @param {import("./refill-blocks.js").SessionRef} l
 * @param {number} [since]
 */
function isResumedSinceStop(l, since) {
	const job = readJobRecordOf(l);
	return isResumedSinceApiStop(job, {
		rows: readTranscriptRows(l, job),
		timeline: readTimelineOf(l),
		since,
	});
}

/** @param {import("./refill-loop.js").LoopLaunch} l */
const writeLaunch = (l) => updateState(launchRecorded(l), log);

/**
 * @param {import("./refill-state.js").LoopState} state
 * @param {string[]} served
 */
const adoptKilledLaunches = (state, served) =>
	core.settleLaunching(state, (launching) => {
		const launched = refillBatch.adoptLaunching(launching, {
			entriesOf: (root) =>
				readRecentEntries(root, DEFAULT_WINDOW_HOURS).entries,
			sessionOf: readHeadlessSession,
			readActsBefore: buildActsBeforeReader(served),
			recordLaunch,
			adoptResumed: (l, target, since) => {
				const { from, to, ids } = parkedCarryOf(target);
				return adoptOnSeat(resume.adoptResumed, { ...l, seat: from }, to, {
					ids,
					since,
				});
			},
			log,
		});
		for (const l of launched)
			log(
				`${launchName(l)}'s launch at ${iso(launching.at)} started job ${l.jobId}, which a kill left out of the state: tracking it`,
			);
		gates.dropTried(files.gates, launched, log);
		return launched;
	});

/** @param {string} root */
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

/** @param {import("./parked.js").ParkMarkerRead} marker */
const findParkTranscript = ({ sessionId, job }) =>
	findNewestTranscript(
		[...(job ? [job.seat] : []), ...readConfiguredSeats()],
		sessionId,
	);

/** @param {string[]} served */
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
			log(`closed parks unread in ${tracker}: ${parseErrLine(e)}`);
		}
	}
}

/**
 * @param {string} root
 * @returns {string|null}
 */
const admitResume = (root) =>
	readFreeSlots(root).slots > 0
		? null
		: "admission's re-read finds no free slot";

const staggerResume = () => sleepSync(refillBatch.readStaggerMs());

/**
 * @param {import("./refill-decide.js").Launch[]} batch
 * @param {string[]} served
 */
const launchOrResume = (batch, served) =>
	refillBatch.launchOrResume(batch, {
		readActsBefore: buildActsBeforeReader(served),
		resume: ({ root, issues, prompt }, target) => {
			const { from, to, ids } = parkedCarryOf(target);
			return resumeOnSeat(resume, { root, issues, prompt, seat: from }, to, {
				prompt: parkedPromptOf(target.parkCause),
				ids,
			});
		},
		admitResume,
		stagger: staggerResume,
		recordLaunch,
		launchFresh: launchBatch,
		log,
		now: Date.now,
	});

/**
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
 * @param {import("./refill-blocks.js").SessionRef} l
 * @param {unknown} job
 * @returns {Record<string, unknown>[]|null}
 */
function readTranscriptRows(l, job) {
	const file = /** @type {{linkScanPath?: unknown}|null} */ (job)?.linkScanPath;
	return typeof file === "string" ? readMainChain(file, l.jobId) : null;
}

/** @param {import("./refill-loop.js").LoopLaunch & {jobId: string}} l */
function readIdleSince(l) {
	const job = readJobRecordOf(l);
	const rows = readTranscriptRows(l, job);
	const since = resumedIdleSince({ job, rows });
	if (since === "unread" && l.idleResumes)
		log(
			`resumed-idle records unread for ${launchName(l)}: its idle count held`,
		);
	return since;
}

/**
 * @param {string} root
 * @param {string[]} args
 */
const postHandOff = (root, args) =>
	runChild(
		process.execPath,
		[path.join(SCRIPTS, "rescue-sessions.js"), ...args],
		inCheckout(root),
	);

/**
 * @param {string[]} served
 * @returns {import("./refill-blocks.js").BlockIo}
 */
const blockIo = (served) => ({
	stop: stopOn,
	type: typeResume,
	resumeTargetOf: resume.readResumeTarget,
	resumeStopped: resume.resumeStopped,
	resumeOwnId: resume.resumeOwnId,
	adoptResumed: resume.adoptResumed,
	writeLaunch,
	admitResume,
	stagger: staggerResume,
	moveSession: resume.moveSession,
	removeJobRecord: resume.removeJobRecord,
	retireJob: resume.retireJob,
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
	syntheticStopOf: (l) => {
		const job = readJobRecordOf(l);
		return syntheticStopAt({ job, rows: () => readTranscriptRows(l, job) });
	},
	hasTurnedSince: (l, at) =>
		hasTurnedSince(readTranscriptRows(l, readJobRecordOf(l)), at),
	hasRepliedSince: (l, at) =>
		hasRepliedSince(readTranscriptRows(l, readJobRecordOf(l)), at),
	probeNetwork,
	isResumedSinceStop,
	hasFounderTypedSinceStop: (l) =>
		hasFounderTypedSinceApiStop(readTranscriptRows(l, readJobRecordOf(l))),
	readOutside,
	writeOutside: (records) => writeJson(refillPath(OUTSIDE_FILE), records),
	readReaped: () => readReaped(log),
	writeReapedRead,
	holdLockedOut: (l, { refusal, call }, now) =>
		holdLockedOut(l.root, { job: l.jobId, refusal, call }, now, log),
	labelParked,
	recordParked,
	readJobCwd: (seat, jobId) =>
		readLogged(log, `job ${jobId} on ${seat}`, () => readJobCwd(seat, jobId)),
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

/** @param {ReturnType<typeof blocks.queueLifted>["settled"]} settled */
function dropSettledLifted(settled) {
	for (const { hold, jobs } of settled) dropLiftedJobs(hold, jobs, log);
}

/**
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

/** @param {import("./agent-liveness.js").AgentRecord[]} agents */
function recordListedOverflowSessions(agents) {
	try {
		for (const line of recordListedSessionIds(agents)) log(line);
	} catch (e) {
		log(`overflow session ids not recorded: ${buildErrorText(e)}`);
	}
}

// guess, #4188
const TICK_LOCK_WAIT_MS = 1000;

/** @type {import("./refill-tick-core.js").TickIo} */
const productionIo = {
	now: Date.now,
	log,
	readControl,
	changeControl: (change) => changeControl(change, TICK_LOCK_WAIT_MS),
	isOptedOut,
	readConfiguredSeats,
	readIncluded,
	servedRoots,
	previewReap: () => reapFinished(true),
	reap: () => reapFinished(false),
	readManagerRestart: () => readManagerRestart(log),
	readCurrentBootId,
	readState: () => readState(log),
	adoptKilledLaunches,
	readRegistry: readRegistryAgents,
	stopNeverStarted,
	hasConfig,
	superviseLanding,
	levelMain,
	startReapPass,
	startWarmPass,
	runMachineChild,
	tendHolds: (roots, served, now) => tendHolds(roots, served, now, { log }),
	readListing: (trusted) =>
		trusted ? readAgentsAfterBoot() : listedAgents({ requireSelf: false }),
	recordListedOverflowSessions,
	stopOverAllowance,
	blockIo,
	readSwapHold,
	sendHoldNotices: (roots, { agents, isPaused }, now) =>
		tendHoldNotices(roots, { agents, isPaused }, now, log),
	sendPauseNotices: (repoPaused, now) =>
		tendPauseNotices(repoPaused, now, log, buildPauseFiler(REVIEW_ROOT)),
	readProgress,
	readLoopLastActAt,
	readThroughput: (launches, served, now) =>
		readThroughput({
			roots: served,
			launches,
			lookbackOf: (root, record) =>
				buildLookbackOf(launches, root, now, record),
			now,
		}),
	readCause,
	tendClosedParks,
	actOnOutside: (launches, registry, seen) =>
		actOnOutside(launches, registry, readCause, seen),
	releaseAwayParks: (launches, mode, served, seen) =>
		blocks.releaseAwayParks(launches, mode, served, seen.io),
	attachProbeParks: (broken, launches) =>
		attachProbeParks(broken, launches, log),
	readLiftedHolds: (roots) => readLiftedHolds(roots, log),
	typecheckPeakMb: checkoutPeakMb,
	readFreeSlots,
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
	writePauses: (pauses, noProgressFrom) =>
		writeRepoPauses(pauses, noProgressFrom, log),
	runReview,
	updateState: (transition) => updateState(transition, log),
	readOmittedDirs,
	dropSettledLifted,
	dropManagerRestart: (marker) => dropManagerRestart(marker, log),
	appendTick: (record) => {
		if (!appendTick(record))
			log(`concurrency record: not written to ${concurrencyFiles().record}`);
	},
	appendBreakerEvents: (events) => appendBreakerEvents(events, log),
};

/** @param {{dryRun: boolean}} opts */
function tick({ dryRun }) {
	const now = Date.now();
	const control = readControl();
	const declared = readDeclaredSeats();
	return withTickStores(() =>
		runTick(productionIo, {
			dryRun,
			now,
			opening: {
				control,
				declared,
				typedSeat: readLastTypedSeat(declared),
			},
		}),
	);
}

module.exports = { DISPATCHER, isReviewRunning, tick };
