#!/usr/bin/env node
// cli-args-exempt: #5540

const { execFileSync } = require("node:child_process");
const {
	execGit,
	gitBinary,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./lib/git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	repoRoot,
	FULL_CAUSES,
	DEFAULT_SUITE,
	recordFailure,
	recordKill,
	shortSha,
	formatCachedClause,
} = require("./lib/test-pass-marker.js");
const {
	launchEnv,
	buildLaunchScope,
	readLaunch,
} = require("./lib/suite-handoff.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { markStart, START_MARK_ENV } = require("./lib/tree-drift.js");
const {
	WHOLE_SUITE_WORKERS,
	resolvedFileCount,
	weighFiles,
} = require("./lib/suite-bounded.js");
const { readVitestCollected } = require("./lib/vitest-collected.js");
const {
	driftClause,
	freshenManifest,
	renderDrift,
	renderFreshEdges,
} = require("./lib/manifest-freshen.js");
const {
	dirPath,
	logPath,
	reap,
	recordRun,
	runsPath,
} = require("./lib/test-log.js");
const inflight = require("./lib/test-inflight.js");
const timings = require("./lib/test-file-timings.js");
const { reportForFile } = require("./lib/run-cost-report.js");
const {
	SEAT_ENV,
	armSeatSignals,
	gateDenies,
	heldSeat,
	partLaneOf,
	peerClimbTurn,
	queueSeat,
} = require("./lib/suite-queue.js");
const { partKindOfRoute } = require("./lib/part-suite-peak.js");
const { readOwnPaths, readOwnWork } = require("./lib/own-work.js");
const idSeam = require("./lib/session-id.js");
const { monotonicMs } = require("./lib/clock.js");
const {
	queueExitLogPath,
	queueExitLogger,
} = require("./lib/queue-exit-log.js");
const {
	delta: cpuDelta,
	holdForLoad,
	sample: sampleCpu,
} = require("./lib/cpu-sample.js");
const {
	CEILING_CLOSE,
	DEADLINE_ENV,
	OWNER_ENV,
	SETTLE_MS,
	armCeiling,
	carrierUnkilled,
	ceilingHeadline,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killCarrying,
	killGroup,
	killPid,
	sweepAtStart,
} = require("./lib/suite-ceiling.js");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const readAudit = require("./lib/read-audit.js");
const {
	makeRunRoot,
	removeRunRoot,
	sweepDeadRunRoots,
} = require("./lib/run-temp-root.js");
const { spawnInRunScope, endRunScope } = require("./lib/user-scope.js");
const { writeFd } = require("./lib/write-fd.js");
const { narrowingRefusal } = require("./lib/narrowing-refusal.js");
const {
	SelectionFailed,
	changedFlag,
	readChangedPaths,
	readCommittedEdges,
	expandChanged,
	isChangedOnlyArgv,
	readDefaultChangedBase,
	selectionFlagClash,
} = require("./lib/changed-selection.js");
/** @typedef {import("./lib/dirty-tree.js").ExecFn} ExecFn */
/** @typedef {{ write: (s: string) => unknown }} Writer */
/** @typedef {NonNullable<ReturnType<typeof expandChanged>> & { leftOut?: string[], boundedFrom?: number|null }} Plan */
/** @typedef {import("./lib/cached-plan.js").Looked<Plan>} LookedPlan */
/** @typedef {import("./lib/test-inflight.js").InflightRecord} InflightRecord */
/** @typedef {import("./lib/changed-selection.js").ExpandFs} ExpandFs */
/** @typedef {import("./lib/isolated-worktree.js").WorktreeFs} WorktreeFs */
/** @typedef {import("./lib/own-selection.js").Ledger} Ledger */
/** @typedef {import("./lib/launch-route.js").LaunchRoute} LaunchRoute */
/** @typedef {import("./lib/part-suite-peak.js").PartAdmission} PartAdmission */
const { worktreeRoot } = require("./lib/host-root.js");
const { readDeclaredCommand } = require("./lib/workflow-core-config.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { readTouchedBase, selectTouched } = require("./lib/touched-tests.js");
const { yieldToWhole } = require("./lib/cpu-yield.js");
const { appendEmptyTouchedLine, kindOfLaunch } = require("./lib/run-ledger.js");
const runMemory = require("./lib/run-memory.js");
const { lookupLaunch, recordAllCached } = require("./lib/cached-plan.js");
const {
	CACHED_ENV,
	buildPragmaRefusal,
	writeCachedHandoff,
} = require("./lib/pass-store.js");
const { attributeDirty, ownDefaultWork } = require("./lib/own-selection.js");
const {
	createIsolated,
	removeIsolated,
	sweepIsolated,
} = require("./lib/isolated-worktree.js");
const { launchSnapshotTree } = require("./lib/tree-drift.js");
const { readClaimedElsewhere } = require("./lib/neighbour-dirt.js");
const { recordRun: recordInFlight } = require("./lib/in-flight-runs.js");
const {
	REFUSAL_NAMED_MAX,
	isLinkedWorktree,
	readTrackedStatus,
	readUntrackedFiles,
} = require("./lib/dirty-tree.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { relativeUnder } = require("./lib/is-under.js");
const {
	QUEUE_FLAG,
	FULL_FLAG,
	FULL_PREFIX,
	fullFlagWord,
	isPassStoreLaunch,
	launchRoute,
	isTouchedRun,
	noCacheRefusal,
	npmSwallowedRefusal,
} = require("./lib/launch-route.js");

// #1115 guess: about 6x the longest test measured there
const STALL_MS = 300_000;
const STALL_ENV = "WFC_TEST_STALL_MS";

function stallMs() {
	const raw = process.env[STALL_ENV];
	if (raw === undefined || raw === "") return STALL_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : STALL_MS;
}

const TREE_ROOT = worktreeRoot();

/** @param {string} root */
function readHeadSha(root) {
	try {
		return execGit(["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}

/**
 * @typedef {{ mkdirSync: typeof import("node:fs").mkdirSync,
 *   createWriteStream: typeof import("node:fs").createWriteStream,
 *   readdirSync: typeof import("node:fs").readdirSync,
 *   statSync: typeof import("node:fs").statSync,
 *   unlinkSync: typeof import("node:fs").unlinkSync }} WrapperFs
 */

/**
 * @param {string} file
 * @param {{ fs?: WrapperFs }} [options]
 * @returns {{ stream: ReturnType<WrapperFs["createWriteStream"]>|null, error: unknown }}
 */
function openLog(file, { fs: fsImpl = fs } = {}) {
	try {
		fsImpl.mkdirSync(path.dirname(file), { recursive: true });
		return { stream: fsImpl.createWriteStream(file), error: null };
	} catch (error) {
		return { stream: null, error };
	}
}

/**
 * @param {{ module: string, stage: string }[]} rows
 * @param {number} ms
 * @param {string} root
 */
function buildStallReport(rows, ms, root) {
	const seconds = Math.round(ms / 1000);
	const lines = [
		"",
		`SUITE STALLED — no output or test event for ${seconds}s, so the run was killed.`,
		"",
	];
	if (rows.length > 0) {
		lines.push("Started and never finished:");
		for (const row of rows)
			lines.push(`  ${path.relative(root, row.module)} — ${row.stage}`);
	} else {
		lines.push(
			"No module was recorded as in flight, so the stall is before the first",
			"file was queued or the in-flight reporter could not write.",
		);
	}
	lines.push(
		"",
		"This is a STOPPED run, not a slow one. The usual cause is a synchronous",
		"call that never returns — vitest cannot time one out, because its own",
		"timeouts run on the event loop that call never yields to. Reach for the",
		"blocking syscall in the file above, not for worker or memory settings.",
		`Raise or disable this silence watchdog with ${STALL_ENV}=<ms>, 0 to disable;`,
		"the suite ceiling holds either way.",
		"No partial result counts: once fixed, re-run the same command whole.",
		"",
	);
	return lines.join("\n");
}

/**
 * @param {InflightRecord} record
 * @param {{ ceiling: number, elapsed: number, root: string,
 *    machine: ReturnType<typeof cpuDelta> }} run
 */
function buildCeilingReport(record, { ceiling, elapsed, root, machine }) {
	const rel = (/** @type {string} */ m) => path.relative(root, m);
	const load = machine
		? `load1 ${machine.load1 ?? "unread"}, CPU ${machine.busyPct}% of ${machine.ceilingPct}% busy`
		: "machine reading unavailable";
	const lines = [
		"",
		`${ceilingHeadline("vitest", { elapsed, ceiling })}; ${load}.`,
		"",
	];
	if (record.open.length > 0) {
		lines.push("In flight:");
		for (const row of record.open)
			lines.push(`  ${rel(row.module)} — ${row.stage}`);
	} else lines.push("No file was in flight.");
	const never = neverStarted(record);
	if (never === null)
		lines.push(
			"",
			"No schedule was recorded, so the files never started cannot be named:",
			"the kill came before vitest scheduled a file, or the in-flight reporter",
			"could not write.",
		);
	else {
		lines.push("", `Never started: ${never.length}`);
		for (const m of never) lines.push(`  ${rel(m)}`);
	}
	lines.push(
		"",
		`Finished: ${record.finished.length} file(s).`,
		"",
		...CEILING_CLOSE,
		"",
	);
	return lines.join("\n");
}

/**
 * @param {InflightRecord} record
 * @returns {string[]|null}
 */
function neverStarted(record) {
	if (record.scheduled === null) return null;
	const reached = new Set([
		...record.finished,
		...record.open.map((r) => r.module),
	]);
	return record.scheduled.filter((m) => !reached.has(m));
}

/**
 * @param {string[]} argv
 * @param {() => Plan|null} expand
 * @param {{ root: string, launch: LauncherLaunch, out: Writer, err: Writer,
 *    session: string|null, emptyOnly: boolean, execFn?: ExecFn }} run
 * @returns {{ code: Promise<number>, looked?: undefined }
 *    | { code: null, looked: LookedPlan }}
 */
function planRun(argv, expand, run) {
	const { launch, err } = run;
	let plan;
	try {
		plan = expand();
	} catch (error) {
		return { code: refuseNarrowing({ err }, error) };
	}
	const looked = lookupLaunch(argv, plan, {
		root: run.root,
		on: launch.passStore === true && !launch.full,
	});
	if (looked.refused.length > 0) {
		err.write(buildPragmaRefusal(looked.refused));
		return { code: Promise.resolve(1) };
	}
	if (looked.notice) err.write(`${looked.notice}\n`);
	if (looked.allCached)
		return { code: Promise.resolve(finishAllCached(looked, run)) };
	const leftToRun = looked.cached !== null || (plan?.files.length ?? 0) > 0;
	if (run.emptyOnly && leftToRun) return { code: Promise.resolve(REQUEUE) };
	return { code: null, looked };
}

/**
 * @param {LookedPlan} looked
 * @param {{ root: string, launch: LauncherLaunch, out: Writer,
 *    session: string|null, execFn?: ExecFn }} run
 * @returns {number}
 */
function finishAllCached(looked, { root, launch, out, session, execFn }) {
	const { plan } = looked;
	out.write(looked.banner);
	const landed = recordAllCached(looked.cached ?? [], {
		root,
		launch: {
			...launch,
			admissible: plan?.admissible === true,
			leftOut: plan?.leftOut ?? null,
			boundedFrom: plan?.boundedFrom ?? null,
		},
		changedPaths: plan ? (plan.changed ?? []) : null,
		base: readRunBase(launch, plan, root, execFn),
		startedAtMs: Date.now(),
		sessionId: session,
	});
	const clause = formatCachedClause((looked.cached ?? []).map((c) => c.file));
	out.write(
		`Every selected file was cached — ${clause} — so nothing ran, ${landed ? "and the certificate is written" : "but the certificate could not be written"}.\n`,
	);
	return 0;
}

/** @param {{ inflightFile: string, timingsFile: string, plan: Plan|null, launch: LauncherLaunch, base: string|null, cached: Record<string, string>|null, startMark: bigint|null, tmpRoot: string|null, memoryFile: string }} run */
function vitestEnv({
	inflightFile,
	timingsFile,
	plan,
	launch,
	base,
	cached,
	startMark,
	tmpRoot,
	memoryFile,
}) {
	const {
		[DEADLINE_ENV]: _deadline,
		[SEAT_ENV]: _seat,
		[CACHED_ENV]: _cached,
		...inherited
	} = process.env;
	return {
		...inherited,
		...cached,
		[inflight.INFLIGHT_ENV]: inflightFile,
		[OWNER_ENV]: String(process.pid),
		[timings.TIMINGS_ENV]: timingsFile,
		...launchEnv({
			...launch,
			admissible: plan?.admissible === true,
			leftOut: plan?.leftOut ?? null,
			boundedFrom: plan?.boundedFrom ?? null,
			changedPaths: plan ? (plan.changed ?? []) : null,
			base,
		}),
		...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}),
		...(tmpRoot === null ? {} : { TMPDIR: tmpRoot }),
		[runMemory.MEMORY_ENV]: memoryFile,
		...(startMark === null ? {} : { [START_MARK_ENV]: String(startMark) }),
	};
}

/** @typedef {Partial<Omit<import("./lib/suite-handoff.js").Launch, "admissible"|"changedPaths">> & { slotFree?: boolean, passStore?: boolean }} LauncherLaunch */

/**
 * @param {string} root
 * @param {string} file
 * @param {Writer} err
 * @returns {string[]}
 */
function readRunCostLines(root, file, err) {
	if (!fs.existsSync(file)) return [];
	try {
		return reportForFile(root, file);
	} finally {
		timings.clear(file, err);
	}
}

/**
 * @param {string[]} argv
 * @param {Plan|null} plan
 * @param {{ root: string, execFn?: ExecFn, slotFree?: boolean, err?: Writer }} options
 * @returns {import("./lib/suite-handoff.js").CarriedWeight}
 */
function launchWeight(
	argv,
	plan,
	{ root, execFn = execFileSync, slotFree = false, err = process.stderr },
) {
	const resolvedFiles = plan
		? plan.files.length
		: resolvedFileCount(argv, () => readSuiteFiles(root, execFn, err));
	return {
		resolvedFiles,
		wholeSlot: !slotFree && !weighFiles(resolvedFiles).part,
	};
}

/**
 * @param {ReturnType<typeof probeSelection>} probe
 * @param {string[]} rest
 * @param {{ root?: string, execFn?: ExecFn, slotFree?: boolean, err?: Writer }} options
 * @returns {import("./lib/suite-handoff.js").CarriedWeight}
 */
function probedWeight(
	probe,
	rest,
	{ root = TREE_ROOT, execFn, slotFree, err },
) {
	return probe.probed
		? launchWeight(rest, probe.plan, { root, execFn, slotFree, err })
		: { resolvedFiles: null, wholeSlot: !slotFree };
}

/**
 * @param {LauncherLaunch} launch
 * @param {string[]} runArgv
 * @returns {string[]}
 */
function touchedWorkers(launch, runArgv) {
	const files = launch.resolvedFiles;
	if (!launch.slotFree || typeof files !== "number") return [];
	if (files >= WHOLE_SUITE_WORKERS) return [];
	if (runArgv.some((w) => /^--maxWorkers(=|$)/.test(w))) return [];
	return [`--maxWorkers=${Math.max(files, 1)}`];
}

/**
 * @param {string} root
 * @param {ExecFn} execFn
 * @param {Writer} err
 * @returns {string[] | null}
 */
function readSuiteFiles(root, execFn, err) {
	try {
		const listed = execFn(
			gitBinary(),
			["ls-files", "-z"],
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: CHILD_MAX_BUFFER,
			}),
		);
		return typeof listed === "string"
			? readVitestCollected(root, listed.split("\0").filter(Boolean), execFn)
			: null;
	} catch (error) {
		err.write(
			`run-vitest: the suite could not be listed (${error}) — this run is weighed whole (#2931).\n`,
		);
		return null;
	}
}

/**
 * @template {{ launch?: LauncherLaunch }} T
 * @param {T} options
 * @param {LauncherLaunch} fields
 * @returns {T}
 */
function withLaunch(options, fields) {
	return { ...options, launch: { ...options.launch, ...fields } };
}

/**
 * @param {string[]} argv
 * @param {{ spawnFn?: typeof import("node:child_process").spawn, root?: string, fs?: WrapperFs, bin?: string, stall?: number, ceiling?: number, inflightFile?: string, timingsFile?: string,
 *    expand?: typeof expandChanged, out?: { write: (s: string) => unknown },
 *    execFn?: ExecFn, loadEdges?: () => Record<string, string[]>, err?: { write: (s: string) => unknown },
 *    launch?: LauncherLaunch, onSpawn?: (charge?: import("./lib/suite-queue.js").SpawnCharge) => void, emptyOnly?: boolean,
 *    escalationRequeues?: boolean, session?: string|null,
 *    admission?: PartAdmission|null,
 *    readAdmission?: ((words: string[]) => PartAdmission|null)|null,
 *    yieldCpu?: (child: { pid?: number }, options: { err: Writer }) => unknown,
 *    killCarrier?: typeof killPid }} [options]
 * @returns {Promise<number>}
 */
function runOnce(
	argv = process.argv.slice(2),
	{
		spawnFn = /** @type {typeof import("node:child_process").spawn} */ (
			spawnInRunScope
		),
		root = TREE_ROOT,
		fs: fsImpl = fs,
		bin = path.join(root, "node_modules", ".bin", "vitest"),
		stall = stallMs(),
		ceiling = ceilingMs(),
		inflightFile = path.join(os.tmpdir(), `wfc-inflight-${process.pid}.json`),
		timingsFile = path.join(os.tmpdir(), `wfc-timings-${process.pid}.json`),
		expand = expandChanged,
		out = process.stdout,
		launch = {},
		onSpawn = noop,
		emptyOnly = false,
		escalationRequeues = false,
		session = idSeam.fromEnv(),
		yieldCpu = yieldToWhole,
		err = process.stderr,
		killCarrier = killPid,
		admission: admitted = null,
		readAdmission = null,
		...expandOptions
	} = {},
) {
	const planned = planRun(
		argv,
		() => expand(argv, { root, bin, err, ...expandOptions }),
		{
			root,
			launch,
			out,
			err,
			session,
			emptyOnly,
			execFn: expandOptions.execFn,
		},
	);
	if (planned.code !== null) return planned.code;
	const { looked } = planned;
	argv = looked.argv;
	/** @type {Plan|null} */
	const plan = looked.plan;
	const weighed =
		launch.wholeSlot === undefined || escalationRequeues
			? {
					...launch,
					...launchWeight(argv, plan, {
						root,
						execFn: expandOptions.execFn,
						slotFree: launch.slotFree,
						err,
					}),
				}
			: launch;
	if (escalationRequeues && weighed.wholeSlot)
		return Promise.resolve(REQUEUE_WHOLE);
	const admission = admissionOf(admitted, readAdmission, weighed, launch.argv);
	if (plan && launch.touched && plan.files.length === 0) {
		out.write(plan.banner);
		appendEmptyTouchedLine(repoRoot(root) || root, root, {
			suite: DEFAULT_SUITE,
			sessionId: session,
			argv: launch.argv ?? [],
			leftOut: plan.leftOut ?? [],
			boundedFrom: plan.boundedFrom,
			touchedBase: launch.touchedBase ?? "merge-base",
		});
		return Promise.resolve(0);
	}
	const runArgv = plan ? plan.argv : argv;

	const target = repoRoot(root) || root;
	const sha = readHeadSha(root);
	const file = logPath(target, sha, new Date(), process.pid);
	const opened = openLog(file, { fs: fsImpl });
	let stream = opened.stream;
	if (opened.error)
		err.write(
			`test log not written (${opened.error}) — this run's output is not being saved to ${file}\n`,
		);
	if (looked.banner) {
		out.write(looked.banner);
		stream?.write(looked.banner);
	}
	const cachedFile = path.join(os.tmpdir(), `wfc-cached-${process.pid}.json`);
	const cached = writeCachedHandoff(looked.cached, cachedFile);
	stream?.on("error", (error) => {
		stream = null;
		err.write(
			`test log write failed (${error}) — the rest of this run's output is not being saved to ${file}\n`,
		);
	});

	const startedAt = new Date();
	const startedAtMono = performance.now();
	timings.clear(timingsFile, err);
	const dropCached = () => {
		if (cached) fs.rmSync(cachedFile, { force: true });
	};
	return new Promise((resolve) => {
		armSignals();
		heldRuns.set(inflightFile, killCarrier);
		const tmpRoot = openRunRoot(err);
		const runLaunch = {
			session,
			kind: kindOfLaunch({
				argv: launch.argv ?? null,
				touched: launch.touched === true,
				full: Boolean(weighed.full),
				lander: idSeam.isLanderRun(),
			}),
			argv: launch.argv ?? [],
			files: plan?.files ?? [],
			fileCount: plan?.files.length ?? 0,
			repo: path.basename(target),
			...admissionFields(admission),
		};
		const memory = takeWrapperMemory() ?? runMemory.startSampler(runLaunch);
		memory.setLaunch(runLaunch);
		const env = vitestEnv({
			inflightFile,
			timingsFile,
			plan,
			launch: weighed,
			base: readRunBase(weighed, plan, root, expandOptions.execFn),
			cached,
			startMark: markStart(root),
			tmpRoot,
			memoryFile: memory.file,
		});
		const child = spawnFn(
			bin,
			["run", ...touchedWorkers(weighed, runArgv), ...runArgv],
			{
				cwd: root,
				stdio: ["inherit", "pipe", "pipe"],
				env,
				detached: true,
			},
		);
		memory.setMain(child.pid ?? null);
		if (!weighed.wholeSlot) yieldCpu(child, { err });
		const spawnedAt = Date.now();
		const spawnedAtMono = performance.now();
		const machineStart = sampleCpu();
		onSpawn(admission?.mode === "peak" ? { chargeMb: admission.p99Mb } : {});

		child.on("error", (error) => {
			err.write(`vitest could not be run from ${bin}: ${error}\n`);
		});

		/** @type {ReturnType<typeof setTimeout>|null} */
		let watchdog = null;
		/** @type {"stall"|"ceiling"|null} */
		let killedFor = null;
		/** @type {ReturnType<typeof setTimeout>|null} */
		let giveUp = null;
		const disarm = () => {
			if (giveUp) clearTimeout(giveUp);
			giveUp = null;
			if (watchdog) clearTimeout(watchdog);
			watchdog = null;
		};
		let since = 0;
		const arm = (from = Date.now()) => {
			if (!stall || killedFor) return;
			disarm();
			since = from;
			const left = stall - (Date.now() - from);
			watchdog = setTimeout(killUnlessBeat, Math.max(0, Math.min(stall, left)));
			watchdog.unref?.();
		};
		/** @param {string} report */
		const announce = (report) => {
			err.write(report);
			if (stream) stream.write(report);
		};
		const kill = (/** @type {"stall"|"ceiling"} */ why) => {
			killedFor = why;
			disarm();
			const unkilled = child.pid ? killGroup(child.pid) : null;
			if (unkilled) err.write(groupUnkilled("vitest", unkilled));
			child.kill("SIGKILL");
			giveUp = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				settle(null);
			}, SETTLE_MS);
			giveUp.unref?.();
		};
		/** @param {InflightRecord} record */
		const killed = (record) => ({
			sha,
			at: new Date().toISOString(),
			suite: DEFAULT_SUITE,
			inflight: record.open,
			finished: record.finished,
			argv: launch.argv ?? [],
			scope: buildLaunchScope(readLaunch(env)),
			...(session ? { sessionId: session } : {}),
			memory: memory.current(),
			...markerAdmission(admission),
			...(idSeam.isLanderRun() ? { lander: true } : {}),
		});
		const killUnlessBeat = () => {
			const beat = inflight.lastBeat(inflightFile);
			if (beat > since) return arm(beat);
			const record = inflight.readRecord(inflightFile);
			announce(buildStallReport(record.open, stall, target));
			recordKill(
				{
					...killed(record),
					startedAt: startedAt.toISOString(),
					durationMs: performance.now() - startedAtMono,
					stalled: true,
					stallMs: stall,
				},
				{ root: target, say: (text) => err.write(text) },
			);
			kill("stall");
		};
		const onCeiling = () => {
			if (killedFor) return;
			const record = inflight.readRecord(inflightFile);
			const elapsed = performance.now() - spawnedAtMono;
			const machine = cpuDelta(machineStart, sampleCpu());
			announce(
				buildCeilingReport(record, { ceiling, elapsed, root: target, machine }),
			);
			recordKill(
				{
					...killed(record),
					startedAt: new Date(spawnedAt).toISOString(),
					durationMs: elapsed,
					ceilingKill: true,
					ceilingMs: ceiling,
					neverStarted: neverStarted(record),
					...(machine ? { machine } : {}),
				},
				{ root: target, say: (text) => err.write(text) },
			);
			kill("ceiling");
		};
		const held = armCeiling({
			pgid: child.pid,
			ms: ceiling,
			onCeiling,
		});
		if (held.error) err.write(deadlineUnwritten(held.error));

		/**
		 * @param {{ on: (event: string, cb: (chunk: Buffer) => void) => void }} childStream
		 * @param {{ write: (chunk: Buffer) => void }} sink
		 */
		const forward = (childStream, sink) => {
			childStream.on("data", (chunk) => {
				arm();
				sink.write(chunk);
				if (stream) stream.write(chunk);
			});
		};
		arm();
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);

		/** @type {string|null} */
		let capped = null;
		const endScope = () => {
			capped ??= endRunScope(child);
		};
		child.on("exit", endScope);
		child.on("exit", (_code, signal) => {
			if (!signal) return;
			const unkilled = killCarrying(inflight.INFLIGHT_ENV, inflightFile, {
				kill: killCarrier,
			});
			if (unkilled) err.write(carrierUnkilled(unkilled));
		});

		let settled = false;
		/** @param {number|null} code */
		const settle = (code) => {
			if (settled) return;
			settled = true;
			heldRuns.delete(inflightFile);
			memory.stop();
			dropRunRoot(tmpRoot, err);
			dropCached();
			disarm();
			held.release();
			endScope();
			if (capped) announce(capped);
			const report = readRunCostLines(root, timingsFile, err).join("\n");
			if (report) {
				out.write(`${report}\n`);
				stream?.write(`${report}\n`);
			}
			const finish = () => {
				if (stream) {
					process.stdout.write(`TEST LOG: ${path.relative(target, file)}\n`);
					const run = {
						log: file,
						pid: process.pid,
						startedAt: startedAt.toISOString(),
						endedAt: new Date().toISOString(),
					};
					if (session && !recordRun(target, session, run))
						err.write(
							`run record not written to ${runsPath(target, session)} — a hook cannot hand back this run's verdict if the output loses it\n`,
						);
					reap(dirPath(target), { fs: fsImpl });
				}
				inflight.clearFile(inflightFile);
				// #3140
				resolve(killedFor || capped || code === null || code < 0 ? 1 : code);
			};
			if (stream) {
				stream.once("close", finish);
				stream.end();
			} else finish();
		};
		child.on("close", settle);
	});
}

/**
 * @param {PartAdmission|null} admission
 * @returns {{ mode?: PartAdmission["mode"], admission?: PartAdmission }}
 */
const admissionFields = (admission) =>
	admission ? { mode: admission.mode, admission } : {};

/** @param {PartAdmission|null} admission */
const markerAdmission = (admission) => (admission ? { admission } : {});

/**
 * @param {PartAdmission|null} admitted
 * @param {((words: string[]) => PartAdmission|null)|null} readAdmission
 * @param {{ wholeSlot?: boolean }} weighed
 * @param {string[]|null|undefined} words
 * @returns {PartAdmission|null}
 */
function admissionOf(admitted, readAdmission, weighed, words) {
	if (admitted) return admitted;
	if (!readAdmission || weighed.wholeSlot || idSeam.isLanderRun()) return null;
	return readAdmission(words ?? []);
}

/**
 * @param {string[]} words
 * @returns {PartAdmission | null}
 */
function readDirectAdmission(words) {
	/** @type {PartAdmission | null} */
	let heard = null;
	gateDenies(words, undefined, null, {
		onAdmission: (a) => {
			heard = a;
		},
	});
	return heard;
}

/** @type {import("./lib/run-memory.js").Sampler|null} */
let wrapperMemory = null;

/** @param {string[]} argv */
function openWrapperMemory(argv) {
	wrapperMemory = runMemory.startSampler({
		session: idSeam.fromEnv(),
		kind: "queued",
		argv,
		files: [],
		fileCount: 0,
		repo: path.basename(repoRoot(TREE_ROOT) || TREE_ROOT),
	});
}

function takeWrapperMemory() {
	const taken = wrapperMemory;
	wrapperMemory = null;
	return taken;
}

/** @type {Set<{ root: string, dir: string }>} */
const heldWorktrees = new Set();
/** @type {Map<string, typeof killPid>} */
const heldRuns = new Map();
/** @type {Set<string>} */
const heldRoots = new Set();

/**
 * @param {Writer} err
 * @returns {string|null}
 */
function openRunRoot(err) {
	try {
		const root = makeRunRoot("vitest");
		heldRoots.add(root);
		return root;
	} catch (error) {
		err.write(
			`run-vitest: no temp root for this run (${caught(error).message}); vitest's cache dir stays in ${os.tmpdir()} if it is killed\n`,
		);
		return null;
	}
}

/**
 * @param {string|null} root
 * @param {Writer} err
 */
function dropRunRoot(root, err) {
	if (root === null) return;
	heldRoots.delete(root);
	try {
		removeRunRoot(root);
	} catch (error) {
		err.write(
			`run-vitest: ${root} would not go (${caught(error).message}); a wrapper start removes it an hour after this wrapper exits\n`,
		);
	}
}

/** @returns {void} */
function releaseRunsAndWorktrees() {
	for (const [file, kill] of heldRuns) {
		const unkilled = killCarrying(inflight.INFLIGHT_ENV, file, { kill });
		if (!unkilled) continue;
		ignoreFailure(() => writeFd(2, carrierUnkilled(unkilled)));
	}
	for (const root of heldRoots)
		dropRunRoot(root, { write: (s) => ignoreFailure(() => writeFd(2, s)) });
	for (const held of heldWorktrees)
		ignoreFailure(() => removeIsolated(held.root, held.dir));
}

/** @returns {void} */
function armSignals() {
	armSeatSignals({ cleanup: releaseRunsAndWorktrees });
}

const REQUEUE = -1;

const REQUEUE_WHOLE = -2;

/**
 * @param {string[]} argv
 * @returns {string|null}
 */
function selectionClashRefusal(argv) {
	const clash = selectionFlagClash(argv);
	return clash
		? `\n${clash.join(" and ")} each pick the run's tests, and one launch takes one. Nothing ran. Launch each on its own.\n\n`
		: null;
}

/**
 * @param {string} word
 * @returns {string}
 */
function fullCauseRefusal(word) {
	const named =
		word === FULL_FLAG
			? "names no reason"
			: `names \`${word.slice(FULL_PREFIX.length)}\`, not one of these`;
	return (
		`\n--full REFUSED: ${named} — spell it \`--full=<cause>\`, one of:\n\n` +
		FULL_CAUSES.map((c) => `  ${c}`).join("\n") +
		"\n\n`other` is the escape hatch; its share is the signal to extend this list (#182).\n\n"
	);
}

/**
 * @param {string} root
 * @param {string} word
 * @param {string[]} argv
 */
function recordFullRefusal(root, word, argv) {
	ignoreFailure(() =>
		recordFailure(
			{
				sha: readHeadSha(root),
				at: new Date().toISOString(),
				suite: DEFAULT_SUITE,
				refused: true,
				refusedWhy: "full-cause",
				refusedWord: word,
				argv,
			},
			{ root: repoRoot(root) || root },
		),
	);
}

/**
 * @template {{ sessionId?: string }} T
 * @param {LaunchRoute} route
 * @param {T} options
 * @returns {T}
 */
function withSession(route, options) {
	return route.sessionId ? { ...options, sessionId: route.sessionId } : options;
}

/** @param {string} base */
const committedBase = (base) => (base === "HEAD" ? null : base);

/**
 * @param {string} root
 * @param {ExecFn} execFn
 */
const readCommittedBase = (root, execFn) =>
	committedBase(readDefaultChangedBase(root, execFn));

/**
 * @param {LauncherLaunch} launch
 * @param {Plan|null} plan
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string|null}
 */
function readRunBase(launch, plan, root, execFn = execFileSync) {
	if (launch.base !== undefined) return launch.base;
	if (plan?.base) return plan.base;
	if (launch.full === "flag") return readCommittedBase(root, execFn);
	return null;
}

/**
 * @param {{ err?: { write: (s: string) => unknown } }} options
 * @param {unknown} cause
 * @returns {Promise<number>}
 */
function refuseNarrowing(options, cause) {
	(options.err ?? process.stderr).write(
		narrowingRefusal({
			ruling: "(#2698)",
			cause,
			wholeSuite: `npm run test -- --full=<cause>    (one of: ${FULL_CAUSES.join(", ")})`,
		}),
	);
	return Promise.resolve(1);
}

/**
 * @typedef {Parameters<typeof runOnce>[1] & Parameters<typeof runIsolated>[1] &
 *    { renderEdges?: () => Record<string, string[]>,
 *      commitLedger?: import("./lib/own-work.js").CommitLedger,
 *      claimFn?: import("./lib/manifest-freshen.js").ClaimFn,
 *      renderSnapshot?: import("./lib/manifest-freshen.js").RenderSnapshot }} RouteOptions
 */

/**
 * @param {LaunchRoute} route
 * @param {{ snapshot: () => Promise<number>|null, worktree: () => Promise<number>, shared: () => Promise<number> }} runs
 * @returns {Promise<number>}
 */
async function onTree(route, runs) {
	if (route.tree === "snapshot") {
		const snapped = runs.snapshot();
		if (snapped !== null) return snapped;
	}
	return route.fallback === "worktree" ? runs.worktree() : runs.shared();
}

/**
 * @param {string} at
 * @param {string} base
 * @param {RouteOptions} options
 */
function readOwnWorkAt(at, base, options) {
	return readOwnWork(at, base, ownOptions(options));
}

/**
 * @param {string} at
 * @param {string} base
 * @param {RouteOptions} options
 */
function readOwnPathsAt(at, base, options) {
	return readOwnPaths(at, base, ownOptions(options));
}

/** @param {RouteOptions} options */
function ownOptions(options) {
	return {
		sessionId: options.sessionId || idSeam.fromEnv(),
		execFn: options.execFn ?? execFileSync,
		...(options.commitLedger ? { ledger: options.commitLedger } : {}),
	};
}

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} options
 * @returns {Promise<number>}
 */
function runTouched(route, options) {
	/** @type {typeof expandChanged} */
	const expand = (_argv, o = {}) =>
		planTouched(route.rest, o.root ?? options.root ?? TREE_ROOT, opts);
	const opts = withRenderCheck({ ...withSession(route, options), expand });
	return onTree(route, {
		snapshot: () => runSnapshot(route, opts),
		worktree: () => runIsolated(route.rest, opts),
		shared: () => runOnce(route.rest, opts),
	});
}

/**
 * @param {string[]} rest
 * @param {string} at
 * @param {RouteOptions & { ownWork?: OwnSet|null }} options
 * @returns {Plan}
 */
function planTouched(rest, at, options) {
	try {
		const { base, changed, files, leftOut, boundedFrom, banner } =
			selectTouched(at, {
				...ownOptions(options),
				from: options.launch?.touchedBase ?? "merge-base",
				...(options.ownWork === undefined ? {} : { ownWork: options.ownWork }),
				...(options.loadEdges ? { loadEdges: options.loadEdges } : {}),
				...(options.renderEdges ? { renderEdges: options.renderEdges } : {}),
			});
		return {
			argv: [...rest, "--passWithNoTests", ...files],
			files,
			own: files,
			added: [],
			admissible: false,
			narrowed: false,
			changed,
			base,
			banner,
			leftOut,
			boundedFrom,
		};
	} catch (error) {
		if (error instanceof SelectionFailed) throw error;
		throw new SelectionFailed(
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	}
}

/**
 * @param {string[]} mine
 */
function isolatedRefusal(mine) {
	const shown = mine.slice(0, REFUSAL_NAMED_MAX);
	const rest = mine.length - shown.length;
	return [
		"",
		`--isolated REFUSED: ${String(mine.length)} file(s) this session wrote are uncommitted.`,
		"",
		"An isolated run reads a worktree checked out at HEAD, so it would read not",
		"one byte of these files. Its certificate would attest nothing whatever about",
		"them, while looking exactly like one that did.",
		"",
		...shown.map((p) => `  ${p}`),
		...(rest
			? [
					`  (and ${String(rest)} more — read the full set off \`git status --porcelain\`)`,
				]
			: []),
		"",
		rest
			? "Commit them by pathspec first, reading the full set off `git status --porcelain` — NOT `-uno`, which drops the untracked half of this set (mantahostels#2196)."
			: `Commit them first — \`git commit -m "<why, in plain language>" -- ${shown.map(shellQuote).join(" ")}\`.`,
		"Or run with --shared to run in the working tree instead.",
		"",
	].join("\n");
}

/**
 * @param {string[]} argv
 * @param {string} root
 * @returns {string|null}
 */
function isolatedArgvRefusal(argv, root) {
	const changed = changedFlag(argv);
	if (changed && !changed.ref)
		return (
			"\n--isolated REFUSED: a bare `--changed` selects nothing in a worktree checked\n" +
			"out at HEAD — there is no diff against HEAD there, because the frozen worktree\n" +
			"is a clean checkout and any uncommitted edits in the working tree are unseen\n" +
			"inside it — so the run would exit 0 having tested nothing, its certificate\n" +
			"looking exactly like a real one.\n\n" +
			"Name a ref (`--changed HEAD~1`), or drop --isolated.\n\n"
		);
	const escaping = argv.filter(
		(word) => path.isAbsolute(word) && Boolean(relativeUnder(root, word)),
	);
	if (escaping.length > 0)
		return (
			`\n--isolated REFUSED: ${String(escaping.length)} argument(s) name an absolute path inside the\n` +
			"canonical checkout, which the frozen worktree would read from the LIVE shared\n" +
			"tree rather than from HEAD:\n\n" +
			escaping.map((p) => `  ${p}`).join("\n") +
			"\n\nGive the path relative to the repo root instead, and it resolves inside the\nworktree.\n\n"
		);
	return null;
}

/**
 * @param {string} root
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, sessionId?: string, ledger?: Ledger, alive?: (pid: number) => boolean }} options
 * @returns {{ mine: string[], theirs: string[], quoted: string[] }|null}
 */
function sweepAndAttribute(
	root,
	{
		execFn = execFileSync,
		worktreeFs = fs,
		err = process.stderr,
		sessionId,
		ledger,
		alive,
	},
) {
	const { status, untracked } = sweptStatus(root, {
		execFn,
		worktreeFs,
		err,
		alive,
	});
	if (status === null) return null;
	return attributeDirty(status.dirty, {
		...(sessionId ? { sessionId } : {}),
		...(ledger ? { ledger } : {}),
		untracked: untracked ?? [],
		renames: status.renames,
		tree: root,
		ownTree: isLinkedWorktree(root, execFn),
	});
}

/**
 * @param {string} root
 * @param {{ execFn: ExecFn, worktreeFs: WorktreeFs, err: { write: (s: string) => unknown }, alive?: (pid: number) => boolean }} options
 */
function sweptStatus(root, { execFn, worktreeFs, err, alive }) {
	sweepIsolated(root, { execFn, worktreeFs, err, ...(alive ? { alive } : {}) });
	return {
		status: readTrackedStatus(root, execFn),
		untracked: readUntrackedFiles(root, execFn),
	};
}

/**
 * @param {{ root?: string, execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, pid?: number, tree?: string }} options
 * @returns {{ dir: string, teardown: () => void, error: null }|{ dir: null, teardown: null, error: string }}
 */
function openWorktree({
	root = TREE_ROOT,
	execFn = execFileSync,
	worktreeFs = fs,
	err = process.stderr,
	pid = process.pid,
	tree,
}) {
	const made = createIsolated(root, {
		execFn,
		worktreeFs,
		pid,
		err,
		...(tree === undefined ? {} : { tree }),
	});
	if (made.error !== null)
		return { dir: null, teardown: null, error: made.error };
	const dir = made.dir;
	const held = { root, dir };
	armSignals();
	heldWorktrees.add(held);
	let removed = false;
	const teardown = () => {
		if (removed) return;
		removed = true;
		heldWorktrees.delete(held);
		removeIsolated(root, dir, { execFn, worktreeFs, err });
	};
	return { dir, teardown, error: null };
}

/**
 * @param {string[]} argv
 * @param {Parameters<typeof runOnce>[1] & { execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, pid?: number, sessionId?: string, ledger?: Ledger, alive?: (pid: number) => boolean }} [options]
 * @returns {Promise<number>}
 */
function runIsolated(argv, options = {}) {
	const {
		root = TREE_ROOT,
		err = process.stderr,
		out = process.stdout,
	} = options;

	const argvRefusal = isolatedArgvRefusal(argv, root);
	if (argvRefusal) {
		err.write(argvRefusal);
		return Promise.resolve(1);
	}

	const attributed = sweepAndAttribute(root, options);
	if (attributed === null) {
		err.write(
			"--isolated REFUSED: git would not say whether the tree is clean, so this run\n" +
				"cannot know what a worktree at HEAD would leave out. Re-run with --shared.\n",
		);
		return Promise.resolve(1);
	}
	const { mine, theirs } = attributed;
	if (mine.length > 0) {
		err.write(isolatedRefusal(mine));
		return Promise.resolve(1);
	}
	if (theirs.length > 0)
		err.write(
			`--isolated: ${String(theirs.length)} tracked file(s) are uncommitted and not attributable to this session — the frozen worktree carries HEAD's version of each, not theirs: ${namedList(theirs)}\n`,
		);

	const made = openWorktree(options);
	if (made.error !== null) {
		err.write(`--isolated: ${made.error}\n`);
		return Promise.resolve(1);
	}
	const { dir, teardown } = made;
	out.write(
		`--isolated: running in a detached worktree at ${path.relative(root, dir)}, frozen at ${readHeadSha(dir)}\n`,
	);
	return runThenTeardown(
		() =>
			runOnce(argv, {
				...withLaunch(options, { isolated: true }),
				root: dir,
			}),
		teardown,
	);
}

/**
 * @param {() => Promise<number>} run
 * @param {() => void} teardown
 * @returns {Promise<number>}
 */
function runThenTeardown(run, teardown) {
	try {
		return run().finally(teardown);
	} catch (error) {
		teardown();
		throw error;
	}
}

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} options
 * @returns {Promise<number>|null}
 */
function runSnapshot(route, options) {
	const { root = TREE_ROOT, err = process.stderr } = options;
	const label = snapshotLabel(route);
	/** @param {string} why */
	const fallback = (why) => {
		err.write(`${label}: ${why} — reading the working tree instead.\n`);
		return null;
	};
	const snapshot = buildSnapshot(root, options);
	if (snapshot.error !== null) return fallback(snapshot.error);
	const made = openWorktree({ ...options, tree: snapshot.tree });
	if (made.error !== null) return fallback(made.error);
	const { dir, teardown } = made;
	const out = options.out ?? process.stdout;
	out.write(
		`${label}: running in a detached worktree at ${path.relative(root, dir)}, at ${readHeadSha(dir)}, reading a launch snapshot of this tree that carries ${String(snapshot.carried)} uncommitted file(s).\n`,
	);
	if (snapshot.atHead.length > 0)
		err.write(
			`${label}: ${String(snapshot.atHead.length)} uncommitted file(s) another live session holds are read at HEAD's version, not theirs: ${namedList(snapshot.atHead)}\n`,
		);
	freshenSnapshot(dir, root, options);
	return runThenTeardown(
		() =>
			runOnce(inSnapshot(route.rest, root), {
				...withLaunch(options, { isolated: true }),
				root: dir,
			}),
		teardown,
	);
}

/** @param {LaunchRoute} route */
function snapshotLabel(route) {
	if (route.kind === "touched") return "touched tests";
	if (route.source === "retest") return "--retest";
	return route.kind === "changed" ? "test:changed" : "named tests";
}

/**
 * @param {string[]} words
 * @param {string} root
 */
const inSnapshot = (words, root) =>
	words.map((word) =>
		path.isAbsolute(word) ? (relativeUnder(root, word) ?? word) : word,
	);

/**
 * @param {string} root
 * @param {RouteOptions & { ledger?: Ledger }} options
 * @returns {{ tree: string, carried: number, atHead: string[], error: null }|{ error: string }}
 */
function buildSnapshot(root, options) {
	const {
		execFn = execFileSync,
		worktreeFs = fs,
		err = process.stderr,
	} = options;
	const { status, untracked } = sweptStatus(root, {
		execFn,
		worktreeFs,
		err,
		...(options.alive ? { alive: options.alive } : {}),
	});
	if (status === null || untracked === null)
		return { error: "git would not say which files are uncommitted" };
	const uncommitted = new Set([...status.dirty, ...untracked]);
	const atHead = neighbourHeld(root, uncommitted, options);
	try {
		return {
			tree: launchSnapshotTree(root, { atHead }),
			carried: uncommitted.size - atHead.length,
			atHead,
			error: null,
		};
	} catch (error) {
		return { error: `could not write the launch snapshot: ${error}` };
	}
}

/**
 * @param {string} root
 * @param {Set<string>} uncommitted
 * @param {RouteOptions & { ledger?: Ledger }} options
 * @returns {string[]}
 */
function neighbourHeld(root, uncommitted, options) {
	const sessionId = options.sessionId || idSeam.fromEnv();
	if (!sessionId || uncommitted.size === 0) return [];
	if (isLinkedWorktree(root, options.execFn ?? execFileSync)) return [];
	const held = readClaimedElsewhere(sessionId, {
		tree: root,
		...(options.ledger ? { source: options.ledger } : {}),
	});
	return [...held].filter((p) => uncommitted.has(p)).sort();
}

/** @param {string[]} paths */
function namedList(paths) {
	const rest = paths.length - REFUSAL_NAMED_MAX;
	return (
		paths.slice(0, REFUSAL_NAMED_MAX).join(" ") +
		(rest > 0 ? ` (and ${String(rest)} more)` : "")
	);
}

/**
 * @param {string} dir
 * @param {string} home
 * @param {RouteOptions} options
 */
function freshenSnapshot(dir, home, options) {
	const session = options.sessionId || idSeam.fromEnv();
	const render =
		options.renderEdges ??
		(() =>
			renderFreshEdges(dir, home, {
				sessionId: session,
				...(options.ledger ? { ledger: options.ledger } : {}),
			}));
	freshenManifest(render, {
		root: dir,
		home,
		session,
		claimFn: options.claimFn,
		snapshot: options.renderSnapshot,
		out: options.out ?? process.stdout,
		err: options.err ?? process.stderr,
	});
}

/** @typedef {import("./lib/own-selection.js").OwnSet} OwnSet */
/** @typedef {OwnSet & { label: string }} ProbeSet */

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} options
 * @returns {ProbeSet|null}
 */
function ownProbeSet(route, options) {
	const { root = TREE_ROOT, err = process.stderr } = options;
	if (route.source !== "own") return null;
	if (options.launch?.touchedBase === "head") return null;
	const sessionId = /** @type {string} */ (route.sessionId);
	const set = ownDefaultWork(root, sessionId, options);
	if (set)
		return { ...set, label: `this session's own work since ${set.base}` };
	err.write(
		"--queue: this session's own work could not be read, so the probe reads the working tree's diff instead (#1221).\n",
	);
	return null;
}

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} options
 * @param {ProbeSet|null} [own]
 * @returns {string|null}
 */
function emptySelectionSource(route, options, own) {
	return probeSelection(route, options, own).source;
}

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} options
 * @param {ProbeSet|null} [own]
 * @returns {{ source: string|null, plan: Plan|null, probed: boolean }}
 */
function probeSelection(route, options, own) {
	const { root = TREE_ROOT, err = process.stderr } = options;
	try {
		const set = own === undefined ? ownProbeSet(route, options) : own;
		const ownWork = set ? { ownWork: set } : {};
		const plan = probedPlan(route, root, { ...options, ...ownWork });
		const probed = { plan, probed: true };
		if (!plan || plan.files.length > 0) return { source: null, ...probed };
		if (set) return { source: set.label, ...probed };
		return {
			source: plan.base
				? `the diff against ${plan.base}`
				: "the adopted path list",
			...probed,
		};
	} catch (error) {
		if (error instanceof SelectionFailed) throw error;
		err.write(
			`--queue: the selection could not be probed (${error}) — the run waits for its slot (#1016).\n`,
		);
		return { source: null, plan: null, probed: false };
	}
}

/**
 * @param {string} source
 * @param {boolean} allCached
 * @param {{ options: { out?: Writer, err?: Writer },
 *    logExit: ReturnType<typeof queueExitLogger>,
 *    run: (extra?: { emptyOnly?: boolean }) => Promise<number>,
 *    queued: () => Promise<number> }} exits
 */
async function leaveQueue(
	source,
	allCached,
	{ options, logExit, run, queued },
) {
	(options.out ?? process.stdout).write(buildQueueSkipLine(source));
	logExit("left", 0, { skipped: true });
	if (!allCached) return run();
	const code = await run({ emptyOnly: true });
	if (code !== REQUEUE) return code;
	(options.err ?? process.stderr).write(
		"--queue: the run's own tree holds a file the pass store does not cache — joining the queue (#4790).\n",
	);
	return queued();
}

/**
 * @param {ReturnType<typeof probeSelection>} probe
 * @param {string[]} rest
 * @param {LauncherLaunch} launch
 * @param {string} [root]
 */
function lookupProbe(probe, rest, launch, root = TREE_ROOT) {
	if (!probe.probed) return { probe, argv: rest, allCached: false };
	const looked = lookupLaunch(rest, probe.plan, {
		root,
		on: launch.passStore === true,
	});
	const source = looked.allCached
		? "a selection the pass store caches whole (#4790)"
		: probe.source;
	return {
		probe: { ...probe, plan: looked.plan, source },
		argv: looked.argv,
		allCached: looked.allCached,
	};
}

/**
 * @param {LaunchRoute} route
 * @param {string} root
 * @param {RouteOptions & { ownWork?: ProbeSet }} options
 */
function probedPlan(route, root, options) {
	if (route.kind === "touched") return planTouched(route.rest, root, options);
	const { fs: _fs, ...expandOptions } = options;
	return expandChanged(route.rest, {
		...expandOptions,
		root,
		err: { write: () => true },
	});
}

const MAY_SELECT =
	/\.(?:[cm]?[jt]sx?|sh)$|(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.[^/]+)$/;

/**
 * @param {LaunchRoute} route
 * @param {Parameters<typeof emptySelectionSource>[1]} options
 * @returns {() => string|null}
 */
function buildQueueRecheck(route, options) {
	const {
		root = TREE_ROOT,
		execFn = execFileSync,
		err = process.stderr,
	} = options;
	const readTip = (/** @type {string} */ ref) => {
		try {
			return String(
				execFn(
					gitBinary(),
					["rev-parse", "--verify", "--quiet", ref],
					gitSpawnOptions({
						cwd: root,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
						timeout: GIT_TIMEOUT_MS,
					}),
				) ?? "",
			).trim();
		} catch {
			return "";
		}
	};
	const start = VERIFIED_REF;
	const readTips = () => `${readTip("HEAD")} ${readTip(start)}`;
	let seen = readTips();
	let warned = false;
	return () => {
		const now = readTips();
		if (now === seen) return null;
		seen = now;
		try {
			return emptiedSince(route, options);
		} catch (error) {
			if (error instanceof SelectionFailed) throw error;
			if (!warned)
				err.write(
					`--queue: the selection could not be re-checked while waiting (${error}) — the run keeps its place (#1158).\n`,
				);
			warned = true;
			return null;
		}
	};
}

/**
 * @param {LaunchRoute} route
 * @param {Parameters<typeof emptySelectionSource>[1]} options
 * @returns {string|null}
 */
function emptiedSince(route, options) {
	const { root = TREE_ROOT, execFn = execFileSync } = options;
	const own = ownProbeSet(route, options);
	const ref =
		route.kind === "touched"
			? readTouchedRef(options, root, execFn)
			: (changedFlag(route.rest)?.ref ?? null);
	const edges = (options.loadEdges ?? (() => readCommittedEdges(root)))();
	const reachable = (own?.paths ?? readChangedPaths(root, ref, execFn)).some(
		(p) => MAY_SELECT.test(p) || Object.hasOwn(edges, p),
	);
	return reachable ? null : emptySelectionSource(route, options, own);
}

/**
 * @param {RouteOptions} options
 * @param {string} root
 * @param {ExecFn} execFn
 */
const readTouchedRef = (options, root, execFn) =>
	options.launch?.touchedBase === "head"
		? "HEAD"
		: readDefaultChangedBase(root, execFn);

/**
 * @param {() => Promise<import("./lib/gate-wait.js").WaitOutcome>} wait
 * @param {{ err?: { write: (s: string) => unknown } }} options
 * @param {() => void} onRefused
 */
async function waitOrRefuse(wait, options, onRefused) {
	try {
		return await wait();
	} catch (error) {
		if (!(error instanceof SelectionFailed)) throw error;
		onRefused();
		await refuseNarrowing(options, error);
		return "refused";
	}
}

/**
 * @param {string} fullWord
 * @param {string[]} argv
 * @param {{ err?: { write: (s: string) => unknown }, root?: string }} options
 */
function refusesFullCause(fullWord, argv, options) {
	const cause =
		fullWord === FULL_FLAG ? null : fullWord.slice(FULL_PREFIX.length);
	if (cause && FULL_CAUSES.includes(cause)) return false;
	const err = options.err ?? process.stderr;
	err.write(fullCauseRefusal(fullWord));
	recordFullRefusal(options.root ?? TREE_ROOT, fullWord, argv);
	return true;
}

/**
 * @param {string|null} fullWord
 */
function fullCauseOf(fullWord) {
	return fullWord && fullWord !== FULL_FLAG
		? fullWord.slice(FULL_PREFIX.length)
		: null;
}

/**
 * @param {{ queueLog?: string|null, root?: string }} options
 */
function queueLogFile(options) {
	return options.queueLog === undefined
		? queueExitLogPath(options.root ?? TREE_ROOT)
		: options.queueLog;
}

/**
 * @typedef {NonNullable<Parameters<typeof main>[1]> & { launch: LauncherLaunch }} RunOptions
 */

/**
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {Promise<number>}
 */
function runByRoute(route, opts) {
	if (route.kind === "touched") return runTouched(route, opts);
	const noted = withRenderCheck(
		withCommittedNote(route, withChangedBase(route, opts)),
	);
	return onTree(route, {
		snapshot: () => runSnapshot(route, withSession(route, noted)),
		worktree: () => runIsolated(route.rest, noted),
		shared: () => runOnce(route.rest, noted),
	});
}

/** @param {LaunchRoute} route */
const isBareChanged = (route) =>
	route.kind === "changed" && !changedFlag(route.rest)?.ref;

/**
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {RunOptions}
 */
function withChangedBase(route, opts) {
	if (!isBareChanged(route)) return opts;
	const { root = TREE_ROOT, execFn = execFileSync } = opts;
	return withLaunch(opts, {
		base: readCommittedBase(root, execFn),
	});
}

/**
 * @template {{ root?: string, expand?: typeof expandChanged,
 *   renderSnapshot?: import("./lib/manifest-freshen.js").RenderSnapshot }} T
 * @param {T} opts
 * @returns {T}
 */
function withRenderCheck(opts) {
	const expand = opts.expand ?? expandChanged;
	const home = opts.root ?? TREE_ROOT;
	return {
		...opts,
		expand: (argv, o) => {
			const plan = expand(argv, o);
			const drift =
				plan && renderDrift(o?.root ?? home, home, opts.renderSnapshot);
			if (!plan || !drift) return plan;
			return {
				...plan,
				admissible: false,
				banner: `${plan.banner}Readers selected while ${driftClause(drift)}, so this run is not admissible: its certificate attests no selection. Rerun it once the tree holds the render code a run loads — after the commit a queue wait spanned, or with uncommitted render edits committed (#5635).\n`,
			};
		},
	};
}

/**
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {RunOptions}
 */
function withCommittedNote(route, opts) {
	if (!isBareChanged(route)) return opts;
	const expand = opts.expand ?? expandChanged;
	return {
		...opts,
		expand: (argv, o) => {
			const plan = expand(argv, o);
			if (!plan || plan.files.length > 0) return plan;
			const note = buildCommittedNote(route, opts);
			return note ? { ...plan, banner: plan.banner + note } : plan;
		},
	};
}

/**
 * @param {LaunchRoute} route
 * @param {RouteOptions} opts
 * @returns {string|null}
 */
function buildCommittedNote(route, opts) {
	const { root = TREE_ROOT, execFn = execFileSync } = opts;
	const base = readDefaultChangedBase(root, execFn);
	const own = readOwnPathsAt(root, base, withSession(route, opts));
	if (!own || own.kept.length === 0) return null;
	return `UNPUSHED WORK NOT SELECTED — \`--changed\` reads only uncommitted files, so none of your ${own.kept.length} unpushed commit(s) since ${shortSha(base)} is tested here. \`${readDeclaredCommand("test", { root })}\` tests them, narrowed to your own work (#2182).\n`;
}

/**
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {string|null}
 */
function buildNeighbourRangeNote(route, opts) {
	const ref = changedFlag(route.rest)?.ref;
	if (!ref) return null;
	const root = opts.root ?? TREE_ROOT;
	const own = readOwnWorkAt(root, ref, withSession(route, opts));
	if (!own) return null;
	return `NEIGHBOURS' COMMITS TAKEN ON — \`--changed ${ref}\` takes on ${own.dropped.length} neighbour commit(s) in its range, whose reds are theirs: ${own.dropped.map(shortSha).join(", ")}. For your own unpushed commits and uncommitted files alone, run \`${readDeclaredCommand("test", { root })}\` (#2182).\n`;
}

/** @param {string} emptySource */
const buildQueueSkipLine = (emptySource) =>
	`--queue: ${emptySource} reaches no test file, so this run skips the queue (#1016).\n`;

/**
 * @param {{ options: import("./lib/suite-queue.js").QueuedLaunchOptions & { loadHold?: () => Promise<boolean>, err?: { write: (s: string) => unknown }, queueLog?: string|null, root?: string }, words: string[], weight: import("./lib/suite-handoff.js").CarriedWeight, kind: import("./lib/suite-queue.js").PartKind, session: string|null, run: (extra?: { escalationRequeues?: boolean, onSpawn?: (charge?: import("./lib/suite-queue.js").SpawnCharge) => void, admission?: PartAdmission }) => Promise<number>, queued: () => Promise<number>, requeueWhole: () => Promise<number> }} seat
 * @returns {Promise<number>}
 */
async function runSeated({
	options,
	words,
	weight,
	kind,
	session,
	run,
	queued,
	requeueWhole,
}) {
	const seatFile = weight.wholeSlot ? null : heldSeat(options);
	if (!seatFile) return queued();
	/** @type {PartAdmission | undefined} */
	let admission;
	/** @type {(climbMb: number, hear?: (a: PartAdmission) => void) => import("./lib/gate-wait.js").GateDenial | null} */
	const gate =
		options.gate ??
		((climbMb, hear) =>
			gateDenies(words, options.gateRead, weight, {
				climbMb,
				onAdmission: (a) => {
					admission = a;
					hear?.(a);
				},
			}));
	const logExit = queueExitLogger({
		file: queueLogFile(options),
		kind: "seat",
		lane: kind,
		session,
		label: "--queue",
		err: options.err ?? process.stderr,
	});
	const sleep =
		options.sleepFn ??
		((/** @type {number} */ ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)));
	let slept = false;
	const peer = peerClimbTurn(seatFile, options);
	const seat = queueSeat({
		queue: options,
		join: { weight, kind },
		turn: peer.turn,
		logExit: (reason, waitMs, extra) => {
			if (reason !== "opened" || slept) logExit(reason, waitMs, extra);
		},
		signals: true,
	});
	try {
		const outcome = await seat
			.wait({
				hold: options.loadHold,
				...options,
				gate: (climbMb, hear) => {
					const denial = gate(climbMb, hear);
					return denial?.limb === "memory" ? denial : null;
				},
				turn: peer.turn,
				turnHold: peer.turnHold,
				part: true,
				sleepFn: (ms) => {
					slept = true;
					return sleep(ms);
				},
			})
			.finally(peer.release);
		if (outcome === "refused") return 1;
		const code = await run({
			escalationRequeues: true,
			onSpawn: seat.spawned,
			...(admission ? { admission } : {}),
		});
		if (code !== REQUEUE_WHOLE) return code;
	} finally {
		seat.leave();
	}
	(options.err ?? process.stderr).write(
		"--queue: the selection now takes the whole-suite slot, which no seat holds — joining the queue, whole (#2918).\n",
	);
	return requeueWhole();
}

/**
 * The entry point. `--queue` waits for the suite gate's count cap and memory
 * rung to open and then runs, the gate judging the run by its own words
 * (#2558); without it the suite starts now. A part-suite inside a
 * `queue-run.js --seat` skips the queue and waits on the memory rung alone
 * (#2918).
 *
 * `loadHold` re-reads the CPU load once a queued run's gate opens (#834): the
 * entry point's `holdForLoad` ran before a wait of up to 40 minutes. The gate
 * is read again after it, so a hold never ages the reading a run launches on
 * (#2622). Absent, nothing is re-read — tests call `main()` and must not read
 * the live load.
 *
 * @param {string[]} [argv]
 * `queueLog` overrides where queue exits are logged (#1215); null logs none.
 *
 * @param {Parameters<typeof runOnce>[1] & import("./lib/suite-queue.js").QueuedLaunchOptions & { loadHold?: () => Promise<boolean>, queueLog?: string|null, sessionId?: string }} [options]
 * @returns {Promise<number>}
 */
function main(argv = process.argv.slice(2), options = {}) {
	const fullWord = fullFlagWord(argv);
	if (fullWord && refusesFullCause(fullWord, argv, options))
		return Promise.resolve(1);
	const route = launchRoute(argv, options.sessionId || idSeam.fromEnv());
	const { rest } = route;
	const fullFlag = route.kind === "full";
	const launch = {
		isolated: false,
		viaChanged: isChangedOnlyArgv(rest),
		touched: route.kind === "touched",
		touchedBase: route.kind === "touched" ? readTouchedBase() : null,
		slotFree: isTouchedRun(route),
		full: fullFlag ? "flag" : null,
		fullCause: fullCauseOf(fullWord),
		argv,
		passStore: isPassStoreLaunch(route, argv),
	};
	const runOptions = { ...options, launch };
	const ranged = buildNeighbourRangeNote(route, runOptions);
	if (ranged) (options.out ?? process.stdout).write(ranged);
	const run = (extra = {}) => runByRoute(route, { ...runOptions, ...extra });
	if (!argv.includes(QUEUE_FLAG)) return run();
	const recheck = fullFlag ? () => null : buildQueueRecheck(route, runOptions);
	/** @type {ReturnType<typeof probeSelection>} */
	let probe;
	try {
		probe = fullFlag
			? { source: null, plan: null, probed: true }
			: probeSelection(route, runOptions);
	} catch (error) {
		return refuseNarrowing(options, error);
	}
	const looked = lookupProbe(probe, rest, launch, options.root);
	const emptySource = looked.probe.source;
	let weight = probedWeight(looked.probe, looked.argv, {
		...options,
		slotFree: launch.slotFree,
	});
	const reweigh = (/** @type {typeof weight} */ next) => {
		weight = next;
		runOptions.launch = { ...launch, ...weight };
	};
	reweigh(weight);
	const partKind = partLaneOf(partKindOfRoute(route));
	const logFile = queueLogFile(options);
	const logExit = queueExitLogger({
		file: logFile,
		kind: route.kind,
		lane: partKind,
		slotFree: launch.slotFree,
		session: route.sessionId,
		label: "--queue",
		err: options.err ?? process.stderr,
	});
	const requeueWhole = () => {
		reweigh({ resolvedFiles: null, wholeSlot: true });
		return queued();
	};
	/** @returns {Promise<number>} */
	const queued = async () => {
		const part = !weight.wholeSlot;
		const seat = queueSeat({
			queue: options,
			join: { weight, kind: partKind, session: route.sessionId },
			logExit,
			signals: true,
		});
		const started = monotonicMs();
		runOptions.onSpawn = seat.spawned;
		/** @type {PartAdmission | undefined} */
		let admission;
		try {
			const outcome = await waitOrRefuse(
				() =>
					seat.wait({
						leave: recheck,
						gateWords: rest,
						gateWeight: weight,
						hold: options.loadHold,
						...options,
						onAdmission: (/** @type {PartAdmission} */ a) => {
							admission = a;
						},
						part,
					}),
				options,
				() =>
					logExit("refused", monotonicMs() - started, seat.stamps.polledHold()),
			);

			if (outcome === "refused") return 1;
			if (outcome === "run") {
				const code = await run({
					escalationRequeues: part,
					...(admission ? { admission } : {}),
				});
				if (code !== REQUEUE_WHOLE) return code;
				seat.leave();
				(options.err ?? process.stderr).write(
					"--queue: the selection now takes the whole-suite slot it was admitted without — joining the queue again, whole (#2931).\n",
				);
				return requeueWhole();
			}
			const code = await run({ emptyOnly: true });
			if (code !== REQUEUE) return code;
			(options.err ?? process.stderr).write(
				"--queue: a commit refilled the selection after the re-check — joining the queue again (#1158).\n",
			);
			return queued();
		} finally {
			seat.leave();
		}
	};
	if (emptySource !== null)
		return leaveQueue(emptySource, looked.allCached, {
			options,
			logExit,
			run,
			queued,
		});
	return runSeated({
		options,
		words: rest,
		weight,
		kind: partKind,
		session: route.sessionId,
		run,
		queued,
		requeueWhole,
	});
}

/**
 * @param {string[]} argv
 * @returns {() => void}
 */
function openRunRecord(argv) {
	const session = idSeam.fromEnv();
	if (!session || idSeam.isLanderRun()) return noop;
	return recordInFlight({ session, args: argv });
}

if (require.main === module) {
	const argv = process.argv.slice(2);
	const refusal =
		npmSwallowedRefusal(argv, process.env) ??
		noCacheRefusal(argv) ??
		selectionClashRefusal(argv);
	if (refusal) {
		process.stderr.write(refusal);
		process.exitCode = 1;
	} else {
		sweepAtStart();
		sweepDeadRunRoots("vitest");
		readAudit.sweep(os.tmpdir());
		openWrapperMemory(argv);
		const dropRunRecord = openRunRecord(argv);
		process.once("exit", dropRunRecord);
		holdForLoad()
			.then((go) =>
				go
					? main(process.argv.slice(2), {
							loadHold: () => holdForLoad(),
							readAdmission: readDirectAdmission,
							...(process.env.WFC_RUN_VITEST_BIN
								? { bin: process.env.WFC_RUN_VITEST_BIN }
								: {}),
						})
					: 1,
			)
			// process.exit can cut a pending stdout write on a pipe short: https://nodejs.org/api/process.html#processexit
			.then((code) => {
				takeWrapperMemory()?.discard();
				process.exitCode = code;
			})
			.catch((error) => {
				takeWrapperMemory()?.discard();
				process.stderr.write(`run-vitest.js crashed: ${error}\n`);
				process.exitCode = 1;
			});
	}
}

module.exports = { main };
