#!/usr/bin/env node
/*
 * `npm run test`, wrapped so the suite's full stdout/stderr survive a pipe
 * (mantahostels#1943). scripts/vitest-pass-reporter.ts already records WHICH tests
 * failed (mantahostels#1942); this keeps WHY — the assertion diffs and stack frames that
 * exist only on the terminal, gone the moment a session's pipe is `head`,
 * `tail` or the wrong grep.
 *
 * TEE, NOT REDIRECT. The child's output is forwarded to this process's own
 * stdout/stderr chunk for chunk, unchanged, and copied to a durable,
 * gitignored, per-run log at the same time. A log that cannot be opened or
 * written costs the log, never the suite's exit code.
 *
 * FORCE_COLOR ON A TTY SESSION. Capturing every byte means the child's
 * stdout is a pipe rather than `inherit`, and a pipe reads as a non-TTY to
 * vitest, which would otherwise drop the colour a bare `vitest run` shows a
 * terminal.
 *
 * AND IT KILLS A STALLED RUN, naming the file it parked in (mantahostels#1910).
 * A synchronous call that never returns inside a worker cannot be timed out
 * from within vitest — `testTimeout` is enforced on the event loop, which such
 * a call never yields to — so the worker parks forever and the parent waits on
 * it, silently and without limit.
 *
 * cli-args-exempt: a pass-through wrapper; every argv word it does not
 * consume is vitest's, which refuses its own unknown flags.
 *
 * TWO KILLS, WHICHEVER FIRES FIRST. The silence watchdog kills a run that
 * shows no sign of life for five minutes — no output, and no test or hook
 * event the in-flight reporter stamps on its file (#1149). The suite ceiling
 * (lib/suite-ceiling.js) kills every run 14 minutes after vitest spawns,
 * whatever its output or the machine's load: no run may hold the machine
 * longer (#2667). Either kill takes vitest's whole process group, exits 1 and
 * names the files in flight.
 *
 * A SCOPE OF ITS OWN (#3401). vitest starts in a pids-capped user scope
 * (lib/user-scope.js), killed whole when the run ends; a run that hit the cap
 * exits 1, naming it.
 *
 * AND IT PRINTS THE RUN-COST REPORT after the suite's own summary (#1883):
 * each new or changed test file over budget. It never touches the exit code
 * (mantahostels#2255).
 */

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
	EDGES_FILE,
	DEFAULT_SUITE,
	recordFailure,
	shortSha,
} = require("./lib/test-pass-marker.js");
const { launchEnv } = require("./lib/suite-handoff.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const {
	WHOLE_SUITE_WORKERS,
	resolvedFileCount,
	weighFiles,
} = require("./lib/suite-bounded.js");
const { readVitestCollected } = require("./lib/vitest-collected.js");
const { freshenManifest } = require("./lib/manifest-freshen.js");
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
	QUEUE_SIGNALS,
	SEAT_ENV,
	gateDenies,
	heldSeat,
	queueJoin,
	queueSpawned,
	queueStamps,
	queueLeave,
	passingTurn,
	waitForGate,
} = require("./lib/suite-queue.js");
const { readOwnPaths, readOwnWork } = require("./lib/own-work.js");
const idSeam = require("./lib/session-id.js");
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
	SETTLE_MS,
	armCeiling,
	ceilingHeadline,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killGroup,
} = require("./lib/suite-ceiling.js");
const { spawnInRunScope, endRunScope } = require("./lib/user-scope.js");
const {
	CHANGED_FLAG,
	PACKAGE_JSON,
	SelectionFailed,
	changedFlag,
	readChangedPaths,
	readCommittedEdges,
	expandChanged,
	isChangedOnlyArgv,
	readDefaultChangedBase,
	findDefaultEscalationReason,
	liveEdges,
	selectionFlagClash,
} = require("./lib/changed-selection.js");
/** @typedef {import("./lib/dirty-tree.js").ExecFn} ExecFn */
/** @typedef {{ write: (s: string) => unknown }} Writer */
/** @typedef {import("./lib/test-inflight.js").InflightRecord} InflightRecord */
/** @typedef {import("./lib/changed-selection.js").ExpandFs} ExpandFs */
/** @typedef {import("./lib/isolated-worktree.js").WorktreeFs} WorktreeFs */
/** @typedef {import("./lib/own-selection.js").Ledger} Ledger */
/** @typedef {import("./lib/launch-route.js").LaunchRoute} LaunchRoute */
const { worktreeRoot } = require("./lib/host-root.js");
const {
	readCommandOrDefault,
	moduleOn,
} = require("./lib/workflow-core-config.js");
const { pushedRef } = require("./lib/landing-refs.js");
const { pushGateState } = require("./lib/test-gate.js");
const { selectTouched } = require("./lib/touched-tests.js");
const { yieldToWhole } = require("./lib/cpu-yield.js");
const { appendEmptyTouchedLine } = require("./lib/run-ledger.js");
const {
	attributeDirty,
	lastCommitAt,
	ownDefaultWork,
	ownSelection,
} = require("./lib/own-selection.js");
const {
	createIsolated,
	overlayFiles,
	removeIsolated,
	sweepIsolated,
} = require("./lib/isolated-worktree.js");
/* The working-tree reads and the path quoting, shared with
 * scripts/guard-uncommitted-work.js so the two refusals name the same set
 * (mantahostels#2196). */
const {
	REFUSAL_NAMED_MAX,
	shellWord,
	readTrackedStatus,
	readUntrackedFiles,
} = require("./lib/dirty-tree.js");
const {
	QUEUE_FLAG,
	FULL_FLAG,
	FULL_PREFIX,
	fullFlagWord,
	launchRoute,
	isTouchedRun,
	npmSwallowedRefusal,
} = require("./lib/launch-route.js");

/*
 * How long the suite may show NO sign of life before it is treated as parked.
 *
 * The threshold is the longest gap between two test or hook events, so it is
 * bounded by the slowest single test, not the slowest file. Five minutes is
 * about 6x the longest test #1115 measured — a margin, not derived from it —
 * and hooks were never timed.
 */
const STALL_MS = 300_000;
const STALL_ENV = "WFC_TEST_STALL_MS";

/**
 * The silence threshold, from the environment where it is a non-negative
 * number.
 *
 * ZERO DISABLES THE WATCHDOG, for the one case that legitimately wants none: a
 * debugger attached to a worker, where a paused process is the point. The
 * suite ceiling still holds.
 * A value that is not a number is IGNORED rather than obeyed as zero — a typo
 * must not silently remove the protection.
 */
function stallMs() {
	const raw = process.env[STALL_ENV];
	if (raw === undefined || raw === "") return STALL_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : STALL_MS;
}

/* The tree under test — the host repository, or the linked worktree of it
 * the run was launched in (#2940): its node_modules (so `vitest` resolves to
 * the copy it installed), its `docs/test-read-edges.json`, its tracked tree
 * for the dirty-tree and worktree machinery below. The log, marker and
 * refusal stores go through `repoRoot()`, so they stay in the canonical
 * checkout. Never `__dirname` (#1): in a plugin install the core's files sit
 * in the plugin cache, not the tree whose suite this runs. */
const TREE_ROOT = worktreeRoot();

/** HEAD, or "unknown" where git will not answer — never thrown. */
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
 * Open the log stream for this run, or null where it cannot be opened — a
 * store this wrapper cannot write to must degrade to "no log", never to a
 * suite that fails to run. The failure is still reported: §N5, fail open and
 * say so.
 *
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
 * What a killed run prints.
 *
 * IT NAMES THE MECHANISM, not just the timeout. A reader meeting "timed out"
 * looks for a slow test and tunes workers or memory.
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
 * What a run killed at the suite ceiling prints (#2696): the ceiling, how long
 * the run held the machine and at what load, the files in flight, the files
 * never started, and how many finished.
 * @param {InflightRecord} record
 * @param {{ ceiling: number, elapsed: number, root: string,
 *   machine: ReturnType<typeof cpuDelta> }} run
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
 * The scheduled files neither finished nor in flight; null where no schedule
 * was recorded.
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
 * The environment `runOnce` hands vitest: the parent's own, the in-flight
 * file, and the launch record the certificate is written from.
 * @param {{ inflightFile: string, timingsFile: string, plan: ReturnType<typeof expandChanged>, launch: LauncherLaunch }} run
 */
function vitestEnv({ inflightFile, timingsFile, plan, launch }) {
	/* The deadline file is this run's alone: a runner a test drives inside
	 * vitest would otherwise overwrite it, then remove it, disarming bg-run's
	 * backstop (#2704). A runner a test drives must queue as its own launch,
	 * never inside this run's seat (#2918). */
	const {
		[DEADLINE_ENV]: _deadline,
		[SEAT_ENV]: _seat,
		...inherited
	} = process.env;
	return {
		...inherited,
		[inflight.INFLIGHT_ENV]: inflightFile,
		[timings.TIMINGS_ENV]: timingsFile,
		...launchEnv({
			...launch,
			admissible: plan?.admissible === true,
			changedPaths: plan ? (plan.changed ?? []) : null,
			base: plan?.base ?? null,
		}),
		...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}),
	};
}

/**
 * The launch record's fields the launcher sets: built once in `main`, then
 * overridden by the route that knows better — `runIsolated` and the overlays
 * set `isolated`; `runDefault` clears `viaChanged`, its synthesised
 * `--changed <base>` not being the `test:changed` route it looks like
 * (mantahostels#2303); `escalateDefault` names the escalation in `full`.
 * `slotFree`: `isTouchedRun`'s reading of the route, a run that never takes
 * the whole-suite slot and whose workers are capped at its files; the child's
 * record does not carry it.
 * @typedef {Partial<Omit<import("./lib/suite-handoff.js").Launch, "admissible"|"changedPaths"|"base">> & { slotFree?: boolean }} LauncherLaunch
 */

/**
 * The run-cost report for the timings the in-flight reporter left at `file`,
 * then the file removed. An absent file is a run that timed nothing — vitest
 * died before its end, or a config without the reporter — and prints nothing.
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
 * The admission weight a run carries in its launch record (#2931), weighed
 * once a launch: the test files `plan` selects, else those `argv` resolves to
 * in its own repo's suite, and whether that count takes the whole-suite slot,
 * which a touched run never does (#2935).
 * @param {string[]} argv the launch's argv, its wrapper flags stripped
 * @param {ReturnType<typeof expandChanged>} plan
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
 * `launchWeight` over a queued launch's probe; uncounted where the probe
 * failed, and so whole unless it is a touched run.
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
 * The `--maxWorkers` a touched run of `files` test files forks (#2935): one
 * per file below a whole suite's workers, and none added at or above them,
 * where the config's own count stands. Never where the argv sets its own.
 * @param {LauncherLaunch} launch
 * @param {string[]} runArgv
 * @returns {string[]}
 */
function touchedWorkers(launch, runArgv) {
	const files = launch.resolvedFiles;
	if (!launch.slotFree || typeof files !== "number") return [];
	if (files >= WHOLE_SUITE_WORKERS) return [];
	if (runArgv.some((w) => /^--maxWorkers(=|$)/.test(w))) return [];
	/* An empty selection runs on a filter matching nothing, and vitest
	 * refuses `--maxWorkers=0`. */
	return [`--maxWorkers=${Math.max(files, 1)}`];
}

/**
 * The repo's tracked test files vitest collects, or null where git or vitest
 * will not list them.
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
		/* Null charges the run the whole slot: the over-charging direction. */
		err.write(
			`run-vitest: the suite could not be listed (${error}) — this run is weighed whole (#2931).\n`,
		);
		return null;
	}
}

/**
 * `options` with `fields` laid over its launch record.
 * @template {{ launch?: LauncherLaunch }} T
 * @param {T} options
 * @param {LauncherLaunch} fields
 * @returns {T}
 */
function withLaunch(options, fields) {
	return { ...options, launch: { ...options.launch, ...fields } };
}

/**
 * `bin` lets a real subprocess test point at a stand-in executable instead of
 * paying for a real vitest invocation to prove the pipe survives a real,
 * slow-reading `head`.
 *
 * The default `inflightFile` and `timingsFile` are paths of this run's own,
 * never the repo-root one: 2-3 concurrent suites are sanctioned here, and one
 * shared name means a neighbour's run end deletes the rows this run's stall
 * would be named from.
 *
 * @param {string[]} argv
 * @param {{ spawnFn?: typeof import("node:child_process").spawn, root?: string, fs?: WrapperFs, bin?: string, stall?: number, ceiling?: number, inflightFile?: string, timingsFile?: string,
 *   expand?: typeof expandChanged, out?: { write: (s: string) => unknown },
 *   execFn?: ExecFn, loadEdges?: () => Record<string, string[]>, err?: { write: (s: string) => unknown },
 *   launch?: LauncherLaunch, onSpawn?: () => void, emptyOnly?: boolean,
 *   escalationRequeues?: boolean, session?: string|null,
 *   yieldCpu?: (child: { pid?: number }, options: { err: Writer }) => unknown }} [options]
 * @returns {Promise<number>}
 */
function runOnce(
	argv = process.argv.slice(2),
	{
		/* spawn's last overload, the one this file calls, is spawnInRunScope's
		 * own signature; the cast keeps the piped `stdout` non-null. */
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
		// Called once vitest is spawned, so a `--queue` run can tell the waiters
		// behind it that it is now visible to the guard.
		onSpawn = () => {
			/* no queue waits behind this run */
		},
		// Set only on a run that left the queue early (#1158): it may run an
		// empty selection and nothing else, the gate being shut.
		emptyOnly = false,
		/* A queued part-suite's (#2931): a plan that now takes the whole slot
		 * queues again, whole, rather than run beside a held one. */
		escalationRequeues = false,
		/* Whose run record the finished run joins (#1575); none is kept
		 * without one. */
		session = idSeam.fromEnv(),
		yieldCpu = yieldToWhole,
		err = process.stderr,
		...expandOptions
	} = {},
) {
	/* Consumed here, never passed on: vitest is handed the union as an explicit
	 * file list instead. A null plan is an argv with no selection flag or a
	 * `--changed` run's unreadable manifest, both of which run argv unchanged. */
	/** @type {ReturnType<typeof expandChanged>} */
	let plan;
	try {
		plan = expand(argv, { root, bin, err, ...expandOptions });
	} catch (error) {
		return refuseNarrowing({ err }, error);
	}
	if (emptyOnly && plan && plan.files.length > 0)
		return Promise.resolve(REQUEUE);
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
	if (plan && launch.touched && plan.files.length === 0) {
		out.write(plan.banner);
		appendEmptyTouchedLine(repoRoot(root) || root, root, {
			suite: DEFAULT_SUITE,
			sessionId: session,
			argv: launch.argv ?? [],
		});
		return Promise.resolve(0);
	}
	/* An empty selection runs too, on a filter matching nothing, so the
	 * reporter's end hook fires and the marker is written (#189 §6). */
	const runArgv = plan ? plan.argv : argv;

	const target = repoRoot(root) || root;
	const sha = readHeadSha(root);
	const file = logPath(target, sha, new Date(), process.pid);
	const opened = openLog(file, { fs: fsImpl });
	/* Reassigned to null on a late write failure (ENOSPC, EIO — anything past
	 * the open itself), which createWriteStream reports asynchronously through
	 * `error` rather than throwing. Unhandled, that `error` event is a fatal
	 * uncaughtException; handled, it is the same "no log" degradation as a
	 * failed open. */
	let stream = opened.stream;
	if (opened.error)
		err.write(
			`test log not written (${opened.error}) — this run's output is not being saved to ${file}\n`,
		);
	if (plan) {
		out.write(plan.banner);
		stream?.write(plan.banner);
	}
	stream?.on("error", (error) => {
		stream = null;
		err.write(
			`test log write failed (${error}) — the rest of this run's output is not being saved to ${file}\n`,
		);
	});

	const startedAt = new Date();
	/* Spans are read off the monotonic clock, which a host suspend does not
	 * advance; the wall clock steps forward on resume (#2829). */
	const startedAtMono = performance.now();
	/* A previous run in this process may have left one; this run's report
	 * must read only its own. */
	timings.clear(timingsFile, err);
	return new Promise((resolve) => {
		/* A group of its own, so a kill reaches every worker vitest forks. */
		const child = spawnFn(
			bin,
			["run", ...touchedWorkers(weighed, runArgv), ...runArgv],
			{
				cwd: root,
				stdio: ["inherit", "pipe", "pipe"],
				env: vitestEnv({
					inflightFile,
					timingsFile,
					plan,
					launch: weighed,
				}),
				detached: true,
			},
		);
		if (!weighed.wholeSlot) yieldCpu(child, { err });
		const spawnedAt = Date.now();
		const spawnedAtMono = performance.now();
		const machineStart = sampleCpu();
		/* A signal to this process would otherwise leave the group running:
		 * the handlers exit, and the exit kills every group still held. */
		if (child.pid) armSignals(fs);
		onSpawn();

		// ENOENT, EACCES: spawn reports these through an `error` event on an
		// async child, same shape as spawnSync's `.error` in run-pytest.js.
		// A real ChildProcess always has `.on`; the only caller that would not is
		// a test double built wrong, and that should throw rather than hide it.
		child.on("error", (error) => {
			err.write(`vitest could not be run from ${bin}: ${error}\n`);
		});

		/* Set while the watchdog is armed; cleared once it kills or the child
		 * closes, so a resolved run leaves no timer holding the event loop open. */
		/** @type {ReturnType<typeof setTimeout>|null} */
		let watchdog = null;
		/* Which trigger killed the run, once one has. */
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
		/* When the current silence began: the last output chunk, or the last
		 * heartbeat the in-flight reporter left on its file (#1149). */
		let since = 0;
		const arm = (from = Date.now()) => {
			if (!stall || killedFor) return;
			disarm();
			since = from;
			const left = stall - (Date.now() - from);
			watchdog = setTimeout(killUnlessBeat, Math.max(0, Math.min(stall, left)));
			/* The timer must not by itself keep this process alive — a run that
			 * finishes with the watchdog armed should exit at once. */
			watchdog.unref?.();
		};
		/** @param {string} report */
		const announce = (report) => {
			err.write(report);
			if (stream) stream.write(report);
		};
		/* SIGKILL, not SIGTERM: the parent may be wedged waiting on a worker
		 * that cannot be asked to stop. */
		const kill = (/** @type {"stall"|"ceiling"} */ why) => {
			killedFor = why;
			disarm();
			const unkilled = child.pid ? killGroup(child.pid) : null;
			if (unkilled) err.write(groupUnkilled("vitest", unkilled));
			child.kill("SIGKILL");
			/* `close` needs stdio EOF as well as exit, which a descendant that
			 * left the group can withhold; settling on a timer keeps the report
			 * from hanging on it. */
			giveUp = setTimeout(() => {
				/* Ref'd pipes a descendant holds open would keep this process
				 * alive past its own verdict. */
				child.stdout.destroy();
				child.stderr.destroy();
				settle(null);
			}, SETTLE_MS);
			giveUp.unref?.();
		};
		/** What either kill's fail record carries.
		 * @param {InflightRecord} record */
		const killed = (record) => ({
			sha,
			at: new Date().toISOString(),
			suite: DEFAULT_SUITE,
			inflight: record.open,
			finished: record.finished,
			argv: launch.argv ?? [],
			/* A killed run writes no scope, and an escalated whole run's argv
			 * names no `--full=`; the margin check reads this (#3237). */
			...(weighed.full ? { full: weighed.full } : {}),
		});
		/* Read only when the timer fires, so a heartbeat costs the wrapper one
		 * stat per threshold rather than one per test. */
		const killUnlessBeat = () => {
			const beat = inflight.lastBeat(inflightFile);
			if (beat > since) return arm(beat);
			const record = inflight.readRecord(inflightFile);
			announce(buildStallReport(record.open, stall, target));
			recordKill(target, err, {
				...killed(record),
				startedAt: startedAt.toISOString(),
				durationMs: performance.now() - startedAtMono,
				stalled: true,
				stallMs: stall,
			});
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
			recordKill(target, err, {
				...killed(record),
				startedAt: new Date(spawnedAt).toISOString(),
				durationMs: elapsed,
				ceilingKill: true,
				ceilingMs: ceiling,
				neverStarted: neverStarted(record),
				...(machine ? { machine } : {}),
			});
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
				/* Any byte is progress. */
				arm();
				sink.write(chunk);
				if (stream) stream.write(chunk);
			});
		};
		arm();
		/* vitest's own bytes go to the real streams; `out` and `err` carry
		 * only the wrapper's messages (#3175). */
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);

		/** @type {string|null} */
		let capped = null;
		/* On exit, not close: a process left in the scope can hold vitest's
		 * pipes open, and `close` waits on them. */
		const endScope = () => {
			capped ??= endRunScope(child);
		};
		child.on("exit", endScope);

		let settled = false;
		/** @param {number|null} code */
		const settle = (code) => {
			if (settled) return;
			settled = true;
			disarm();
			held.release();
			endScope();
			if (capped) announce(capped);
			/* After the suite's summary and into the log, so the teed record
			 * keeps it. A stalled or killed run never reaches the reporter's
			 * run end, so it leaves no timings and prints nothing here. */
			const report = readRunCostLines(root, timingsFile, err).join("\n");
			if (report) {
				out.write(`${report}\n`);
				stream?.write(`${report}\n`);
			}
			const finish = () => {
				if (stream) {
					// A log nobody knows exists is never re-read, so announce it
					// (mantahostels#1942).
					// Relative to `target` (the canonical checkout `file` was built
					// under), not `root` — a worktree's own root differs from the
					// canonical checkout, and `path.relative(root, file)` would print
					// a confusing `../` chain there instead of a short path.
					process.stdout.write(`TEST LOG: ${path.relative(target, file)}\n`);
					/* The line above is the one a `grep` or `head` on the
					 * output drops; this record is how
					 * scripts/guard-lost-verdict.js finds the log then. */
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
				/* A killed run must never be able to exit 0. A negative code is
				 * the errno of a child that never spawned, -2 for ENOENT: passed
				 * on, it reads as REQUEUE or REQUEUE_WHOLE and re-queues the run
				 * for ever (#3140). */
				resolve(killedFor || capped || code === null || code < 0 ? 1 : code);
			};
			if (stream) stream.end(finish);
			else finish();
		};
		child.on("close", settle);
	});
}

/**
 * Markers `releaseAndExit` removes if this process is killed, and whether the
 * handlers that call it are armed (mantahostels#2034).
 *
 * ARMED ONCE PER PROCESS, not once per marker: `main` can run many
 * times in a test run, and a listener per call exhausts the emitter's cap and
 * leaks handlers into whatever runs next.
 */
const heldMarkers = new Set();
/* Isolated worktrees `releaseAndExit` removes if this process is killed
 * rather than resolved, since a `.finally()` does not run on a signal and a
 * leaked worktree is a whole checkout (mantahostels#2034, mantahostels#2169). */
/** @type {Set<{ root: string, dir: string }>} */
const heldWorktrees = new Set();
/* Each still-waiting queue run's exit-log writer (#1215): a killed waiter
 * leaves the queue through the handler below, never through `waitForGate`. */
/** @type {Set<(signal: string) => void>} */
const waitingExits = new Set();
let signalsArmed = false;

/**
 * @param {string} signal
 * @param {number} code
 * @param {typeof fs} queueFs
 * @returns {void}
 */
function releaseAndExit(signal, code, queueFs) {
	for (const logExit of waitingExits) logExit(signal);
	for (const file of heldMarkers) {
		try {
			queueFs.unlinkSync(file);
		} catch {
			/* already gone */
		}
	}
	/* Synchronous by necessity: the handler exits at the end of this tick,
	 * so anything deferred never runs. Each removal is best effort, and one
	 * that throws must not strand the rest. */
	for (const held of heldWorktrees) {
		try {
			removeIsolated(held.root, held.dir);
		} catch {
			/* Reported inside removeIsolated. */
		}
	}
	process.exit(code);
}

/**
 * Remove this process's markers if it is terminated rather than resolved.
 *
 * A promise `.finally()` does not run on a signal, so without this every
 * killed waiter would leak its place in the queue and later waiters would
 * queue behind processes that had stopped waiting (mantahostels#2034).
 *
 * @param {typeof fs} queueFs
 * @returns {void}
 */
function armSignals(queueFs) {
	if (signalsArmed) return;
	signalsArmed = true;
	for (const [signal, code] of Object.entries(QUEUE_SIGNALS)) {
		process.once(/** @type {NodeJS.Signals} */ (signal), () =>
			releaseAndExit(String(signal), Number(code), queueFs),
		);
	}
}

/* What an `emptyOnly` run resolves to where its selection is not empty: a
 * commit landed between the re-check and the run, so it queues again. */
const REQUEUE = -1;

/* What a queued part-suite whose plan takes the whole slot resolves to: it
 * re-joins whole (#2931). */
const REQUEUE_WHOLE = -2;

/**
 * The refusal for argv carrying more than one selection flag, naming them —
 * or null where it carries one at most (#2764).
 *
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
 * The refusal text for a `--full` launch naming no reason, or one outside
 * `FULL_CAUSES` (#182's acceptance criteria).
 *
 * @param {string} word the offending word, exactly as argv carried it
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
 * Records a refused `--full` launch to the fail store (#182's acceptance
 * criterion: "A refused launch leaves a record that can be counted"), so the
 * refusal rate is measurable — without it, a session routing around the
 * flag is invisible.
 *
 * NEVER THROWS, NEVER BLOCKS THE REFUSAL ON IT: a store this cannot write to
 * costs the count, never the refusal message the session actually needs.
 *
 * @param {string} root
 * @param {string} word
 * @param {string[]} argv
 */
function recordFullRefusal(root, word, argv) {
	try {
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
		);
	} catch {
		/* a store this cannot write to costs the count, never the refusal */
	}
}

/**
 * A kill's fail record: the fields both kills carry, required.
 * @typedef {import("./lib/test-pass-marker.js").Marker & { sha: string,
 *   at: string, startedAt: string, durationMs: number, suite: string,
 *   inflight: { module: string, stage: string }[], finished: string[],
 *   argv: string[] }} KillRecord
 */

/**
 * Records a stall or ceiling kill to the fail store (#1149, #2696), which a
 * killed run otherwise never reaches: the pass reporter writes only at
 * `onTestRunEnd`. It carries no `scope`, so no reader of red runs mistakes it
 * for a verdict on any file.
 *
 * NEVER THROWS: a store this cannot write to costs the count, never the kill,
 * and says so, since a missing record reads as no kill.
 *
 * @param {string} root
 * @param {Writer} err
 * @param {KillRecord} kill
 */
function recordKill(root, err, kill) {
	let landed = false;
	try {
		landed = recordFailure(kill, { root });
	} catch {
		/* reported below with the false return */
	}
	if (!landed)
		err.write(
			"This kill was not recorded to the fail store, so it will not be counted.\n",
		);
}

/**
 * `options` carrying the id `route` was decided with, which an overlay
 * attributes its files by.
 * @template {{ sessionId?: string }} T
 * @param {LaunchRoute} route
 * @param {T} options
 * @returns {T}
 */
function withSession(route, options) {
	return route.sessionId ? { ...options, sessionId: route.sessionId } : options;
}

/*
 * mantahostels#3208: THE DEFAULT'S BASE. Bare `npm run test` — argv `isFullRunArgv` calls
 * full-shaped, without a session-typed `--full` — narrows to the diff
 * against `merge-base(HEAD, <pushed ref>)`, the pushed ref being
 * lib/landing-refs.js's `pushedRef`. IT IS NEVER FETCHED: a stale remote ref only widens the selection where the merge-base
 * still resolves against it. WHERE IT DOES
 * NOT EXIST OR THE MERGE-BASE CANNOT BE RESOLVED, the base falls back to
 * `HEAD` instead — which NARROWS the selection to uncommitted work alone,
 * silently dropping every already-committed change since the true base from
 * an admissible run's certificate. `runDefault` prints the resolved base on the
 * selection banner so a session can see which one it got.
 */

/**
 * One line of why bare argv escalated to the whole suite (mantahostels#3208).
 * Either way out is an explicit --changed: a manifest or render that fails
 * still narrows under it (uncertified), and a dependency-root diff narrows
 * too (mantahostels#2160's allow-list is the default path's own check, not
 * --changed's).
 * @param {"stale-manifest"|"dependency-root"} reason
 */
function escalationBanner(reason) {
	const why = {
		"stale-manifest": `${EDGES_FILE} is unreadable or the read graph could not be rendered from this tree, so nothing can show which tests read this diff`,
		"dependency-root": `the diff touches ${PACKAGE_JSON} outside the narrowing allow-list, which vitest treats as a dependency-graph root`,
	};
	return `DEFAULT ESCALATED TO THE WHOLE SUITE (${reason}) — ${why[reason]} (mantahostels#3208). Name \`--changed\` yourself to keep this narrowed instead.\n`;
}

/**
 * Refuses a narrowing that failed (#2698), resolving 1 with nothing run.
 * @param {{ err?: { write: (s: string) => unknown } }} options
 * @param {unknown} cause
 * @returns {Promise<number>}
 */
function refuseNarrowing(options, cause) {
	const text = cause instanceof Error ? cause.message : String(cause);
	(options.err ?? process.stderr).write(
		`\nNARROWING FAILED, SO NOTHING RAN (#2698) — ${text.trim()}\n\n` +
			"A failed narrowing is never widened to the whole suite. Fix the cause and re-run, or run the whole suite on purpose:\n\n" +
			`  npm run test -- --full=<cause>    (one of: ${FULL_CAUSES.join(", ")})\n\n`,
	);
	return Promise.resolve(1);
}

/**
 * Bare argv's own entry point (mantahostels#3208): narrow to the diff against
 * `readDefaultChangedBase`, or escalate to the whole suite where that narrowing
 * would be worthless, on the tree `route` names.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runOnce>[1] & Parameters<typeof runIsolated>[1] &
 *   { renderEdges?: () => Record<string, string[]>,
 *     commitLedger?: import("./lib/own-work.js").CommitLedger,
 *     claimFn?: import("./lib/manifest-freshen.js").ClaimFn }} [options]
 * @returns {Promise<number>}
 */
function runDefault(route, options = {}) {
	const { root = TREE_ROOT } = options;
	return onTree(route, {
		overlay: () => runOverlaid(route, withSession(route, options)),
		/*
		 * THE FROZEN-WORKTREE INVARIANT (mantahostels#2169) COMES FIRST: `runIsolated` ->
		 * `runOnce({ root: dir })` lets `expandChanged` run AGAINST THE
		 * WORKTREE, so the file list selected reflects HEAD, not whatever a
		 * neighbour has uncommitted in the shared tree right now. The plan
		 * `narrowDefault` computes here, before the worktree exists, is
		 * necessarily against the shared root — so it is used ONLY to decide
		 * escalate-or-not and is then discarded. That is a second `vitest list`
		 * call, paid only on this explicit `--isolated` path.
		 */
		worktree: () =>
			narrowDefault(route, root, options, {
				run: (argv) =>
					runIsolated(argv, {
						...withLaunch(options, { viaChanged: false }),
						/* The worktree's re-expansion leaves out what the plan did. */
						expand: (a, o = {}) =>
							expandChanged(a, {
								...o,
								ownWork: readOwnWorkAt(
									o.root ?? root,
									changedFlag(a)?.ref ?? "HEAD",
									options,
								),
							}),
					}),
			}),
		/* No worktree here: `runOnce` runs against the root just probed, so the
		 * plan is reused rather than recomputed. */
		shared: () =>
			narrowDefault(route, root, options, {
				run: (argv, plan) =>
					runOnce(argv, {
						...withLaunch(options, { viaChanged: false }),
						expand: () => plan,
					}),
			}),
	});
}

/**
 * Run `route` on its tree: the overlay where it builds, else the
 * `route.fallback` it names.
 * @param {LaunchRoute} route
 * @param {{ overlay: () => Promise<number>|null, worktree: () => Promise<number>, shared: () => Promise<number> }} runs
 * @returns {Promise<number>}
 */
async function onTree(route, runs) {
	if (route.tree === "overlay") {
		const overlaid = runs.overlay();
		if (overlaid !== null) return overlaid;
	}
	return route.fallback === "worktree" ? runs.worktree() : runs.shared();
}

/**
 * The narrowed default's plan in the tree at `at`: the base, then either why
 * it escalates or the narrowed argv and its selection.
 *
 * ANY FAILURE TO PLAN THROWS `SelectionFailed` (#2698) — the diff, `vitest
 * list` (a timeout included) or anything else thrown — carrying the error's
 * own text.
 * `findDefaultEscalationReason` deliberately does not run `vitest list` itself:
 * on the common, non-isolated branch that would mean paying for it twice on
 * the success path.
 *
 * NEVER HANDS `options.fs` TO `expandChanged`: that channel is `runOnce`'s
 * `WrapperFs` (the log's), incompatible with the `ExpandFs` it needs.
 *
 * OWN WORK ONLY (#1216): where `readOwnPaths` leaves a neighbour's commit out, the
 * selection, the escalation check and the marker's `changedPaths` all read
 * its path set. Where it leaves none out, or cannot say, the run is exactly
 * the diff's. The base never moves, so an explicit `--changed <ref>` is how a
 * session takes a neighbour's commit on.
 *
 * @param {string[]} rest
 * @param {string} at
 * @param {Parameters<typeof runDefault>[1] & { ownWork?: OwnSet|null }} options
 * @returns {{ base: string, reason: "stale-manifest"|"dependency-root" }
 *   | { base: string, argv: string[], plan: NonNullable<ReturnType<typeof expandChanged>>,
 *       dropped: string[] }}
 */
function planDefault(rest, at, options) {
	const { execFn = execFileSync } = options;
	/** @type {{ edges?: Record<string, string[]>, error?: unknown } | undefined} */
	let rendered;
	const renderEdges = () => {
		if (!rendered)
			try {
				rendered = {
					edges: (options.renderEdges ?? (() => liveEdges(at)))(),
				};
			} catch (error) {
				rendered = { error };
			}
		if ("error" in rendered) throw rendered.error;
		return /** @type {Record<string, string[]>} */ (rendered.edges);
	};
	const base = readDefaultChangedBase(at, execFn);
	try {
		/* A queue probe hands its own set in (#1221). */
		const ownWork =
			options.ownWork === undefined
				? readOwnWorkAt(at, base, options)
				: options.ownWork;
		const reason = findDefaultEscalationReason(at, base, {
			execFn,
			renderEdges,
			...(options.loadEdges ? { loadEdges: options.loadEdges } : {}),
			...(ownWork ? { changed: ownWork.paths } : {}),
		});
		if (reason) return { base, reason };
		const argv = [...rest, CHANGED_FLAG, base];
		const { fs: _fs, ...expandOptions } = options;
		const plan = expandChanged(argv, {
			...expandOptions,
			root: at,
			renderEdges,
			ownWork,
		});
		/* Null only where the manifest is unreadable, which the reason above
		 * has already escalated. */
		if (!plan) return { base, reason: "stale-manifest" };
		return { base, argv, plan, dropped: ownWork?.dropped ?? [] };
	} catch (error) {
		if (error instanceof SelectionFailed) throw error;
		throw new SelectionFailed(
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	}
}

/**
 * `readOwnWork` at `at`, where it leaves a neighbour's commit out — else null
 * (#1216).
 *
 * @param {string} at
 * @param {string} base
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function readOwnWorkAt(at, base, options) {
	return readOwnWork(at, base, ownOptions(options));
}

/**
 * `readOwnPaths` at `at` with the launch's session and seams.
 *
 * @param {string} at
 * @param {string} base
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function readOwnPathsAt(at, base, options) {
	return readOwnPaths(at, base, ownOptions(options));
}

/**
 * The launch's session and seams, as the own-work reads take them.
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function ownOptions(options) {
	return {
		/* `||`, not `??`: the suite stubs the id to "", which is no session. */
		sessionId: options.sessionId || idSeam.fromEnv(),
		execFn: options.execFn ?? execFileSync,
		...(options.commitLedger ? { ledger: options.commitLedger } : {}),
	};
}

/**
 * `teardown` runs before an escalation, after the run, and on a throw.
 *
 * @param {LaunchRoute} route
 * @param {string} at
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @param {{ run: (argv: string[], plan: NonNullable<ReturnType<typeof expandChanged>>) => Promise<number>,
 *   teardown?: () => void }} hooks
 * @returns {Promise<number>}
 */
function narrowDefault(
	route,
	at,
	options,
	{
		run,
		teardown = () => {
			/* nothing to tear down */
		},
	},
) {
	const { out = process.stdout } = options;
	/** @type {Promise<number>} */
	let running;
	try {
		const planned = planDefault(route.rest, at, options);
		if ("reason" in planned) {
			teardown();
			return escalateDefault(route, planned.reason, options);
		}
		out.write(
			`DEFAULT NARROWED TO THE DIFF AGAINST ${planned.base} (mantahostels#3208).\n`,
		);
		if (planned.dropped.length > 0)
			out.write(
				`OWN WORK ONLY — ${planned.dropped.length} neighbour commit(s) in that range left to their own sessions' certificates, which the push composes (#1216): ${planned.dropped.map(shortSha).join(", ")}. Take one on with \`npm run test -- --changed <ref>\`.\n`,
			);
		running = run(planned.argv, planned.plan);
	} catch (error) {
		teardown();
		if (error instanceof SelectionFailed)
			return refuseNarrowing(options, error);
		throw error;
	}
	return running.finally(teardown);
}

/**
 * The default's escalation to the whole suite, on `route.escalation`: it
 * isolates unless `--shared` was typed, exactly as `--full` does
 * (mantahostels#2278) — independent of whether the NARROWED run would have
 * used a worktree.
 *
 * @param {LaunchRoute} route
 * @param {"stale-manifest"|"dependency-root"} reason
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @returns {Promise<number>}
 */
function escalateDefault(route, reason, options) {
	/* A run that left the queue holds no slot, so its escalation queues again
	 * rather than run whole (#1158, #2931). */
	if (options.emptyOnly) return Promise.resolve(REQUEUE);
	const { out = process.stdout } = options;
	out.write(escalationBanner(reason));
	/* The probe's weight is left behind, so `runOnce` weighs the whole run. */
	const {
		resolvedFiles: _files,
		wholeSlot: _slot,
		...unweighed
	} = options.launch ?? {};
	const escalated = {
		...options,
		launch: { ...unweighed, full: reason, viaChanged: false },
	};
	return route.escalation === "shared"
		? runOnce(route.rest, escalated)
		: runIsolated(route.rest, escalated);
}

/**
 * Bare argv under the `landing` module (#2930): run the session's touched
 * tests on the tree `route` names. It never escalates.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @returns {Promise<number>}
 */
function runTouched(route, options) {
	/* `runOnce` hands its own root, so the plan is made in the tree it runs. */
	/** @type {typeof expandChanged} */
	const expand = (_argv, o = {}) =>
		planTouched(route.rest, o.root ?? options.root ?? TREE_ROOT, opts);
	const opts = { ...withSession(route, options), expand };
	return onTree(route, {
		overlay: () => runChangedOverlaid(route, opts),
		worktree: () => runIsolated(route.rest, opts),
		shared: () => runOnce(route.rest, opts),
	});
}

/**
 * The touched-test plan in the tree at `at`: the session's own changed paths
 * since the default's base, resolved by `selectTouched`, as the plan
 * `runOnce` hands vitest. Admissible never: the lander is the full gate.
 *
 * Throws `SelectionFailed` where the diff or the own-work read fails (#2698).
 *
 * @param {string[]} rest
 * @param {string} at
 * @param {Parameters<typeof runDefault>[1] & { ownWork?: OwnSet|null }} options
 * @returns {NonNullable<ReturnType<typeof expandChanged>>}
 */
function planTouched(rest, at, options) {
	try {
		const { base, changed, files, banner } = selectTouched(at, {
			...ownOptions(options),
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
 * What the refusal prints.
 *
 * THE HARM IT NAMES IS THE SESSION'S OWN BELIEF, never a push reading a stale
 * certificate — a certificate attests a tree and its read closure (ADR-0007), and
 * committing these files changes paths in a full run's closure, or falls
 * outside the diff a narrowed run was selected from, so it attests nothing
 * about that commit
 * (mantahostels#2169).
 *
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
			: `Commit them first — \`git commit -m "<why, in plain language>" -- ${shown.map(shellWord).join(" ")}\`.`,
		"Or run with --shared to accept a shared-tree run instead.",
		"",
	].join("\n");
}

/**
 * The two argv shapes that would quietly defeat the freeze, or null where the
 * argv is fine (mantahostels#2169).
 *
 * A BARE `--changed` SELECTS NOTHING IN A FROZEN WORKTREE, and exits 0 saying
 * so. `readChangedPaths` diffs the working tree against HEAD, and vitest's own
 * `--changed` does the same; in a tree checked out at HEAD both are empty by
 * construction. The run then prints its banner and returns 0 without spawning —
 * a no-op that reads as a certificate. `--changed <ref>` is unaffected and stays allowed.
 *
 * AN ABSOLUTE PATH INTO THE CANONICAL CHECKOUT reads the live shared tree from
 * inside a run advertised as frozen. It is the form a session pastes out of a
 * failure report, so it is refused rather than rewritten: rewriting would
 * silently run a different file from the one asked for.
 *
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
			"is a clean checkout and any uncommitted edits in the shared tree are unseen\n" +
			"inside it — so the run would exit 0 having tested nothing, its certificate\n" +
			"looking exactly like a real one.\n\n" +
			"Name a ref (`--changed HEAD~1`), or drop --isolated.\n\n"
		);
	const escaping = argv.filter(
		(word) =>
			path.isAbsolute(word) &&
			!path.relative(root, word).startsWith("..") &&
			path.relative(root, word) !== "",
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
 * The sweep and the dirty-set attribution both worktree routes start from.
 * Null where git would not say which tracked files are dirty.
 *
 * `withQuotes` is the overlay's: it counts the selection ledger (#1220).
 *
 * @param {string} root
 * @param {{ execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, sessionId?: string, ledger?: Ledger, alive?: (pid: number) => boolean, withQuotes?: boolean }} options
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
		withQuotes = false,
	},
) {
	sweepIsolated(root, { execFn, worktreeFs, err, ...(alive ? { alive } : {}) });
	const status = readTrackedStatus(root, execFn);
	if (status === null) return null;
	/* A null untracked read is not fatal the way the tracked one is: it can
	 * only be the narrower failure, and attributing no new file from it is the
	 * same degradation as an unreadable ledger — `--isolated` refuses less, and
	 * the overlay reads HEAD without that file, the conservative miss
	 * `runOverlaid` names. */
	return attributeDirty(status.dirty, {
		...(sessionId ? { sessionId } : {}),
		...(ledger ? { ledger } : {}),
		untracked: readUntrackedFiles(root, execFn) ?? [],
		renames: status.renames,
		...(withQuotes ? { committedAt: lastCommitAt(root, execFn) } : {}),
	});
}

/*
 * `--isolated`: RUN THE SUITE AGAINST A FROZEN TREE (mantahostels#2169).
 *
 * A DETACHED WORKTREE AT HEAD IS IMMUNE BY CONSTRUCTION, for its tracked
 * content. Nothing but this run writes into it and its HEAD cannot move, so
 * `headMovedDuringRun` is false. `readLinkedPaths` is the named exception —
 * live, gitignored content symlinked in from the canonical checkout, mutable
 * by a neighbour for as long as this run holds it (mantahostels#2213).
 * mantahostels#2169 shows the certificate machinery follows the run into the
 * worktree.
 *
 * mantahostels#2278 makes this the default for a full run, `--shared` the
 * escape. Readings: `docs/environment.md` §6.
 */
/**
 * The worktree both routes run in, with a teardown that takes it down once
 * however many exits reach it.
 *
 * It takes a `worktreeFs` of its OWN, never `runOnce`'s `WrapperFs`. That one
 * is the log's — a stub whose `createWriteStream` buffers into memory — and it
 * carries no `symlinkSync` at all, so sharing the option would either widen the
 * log's stub or narrow this one to what it happens to expose. A caller passing
 * `fs` stubs the LOG and still gets the real filesystem for the worktree, a
 * real `git worktree add` needing a real directory.
 *
 * @param {{ root?: string, execFn?: ExecFn, worktreeFs?: WorktreeFs, err?: { write: (s: string) => unknown }, pid?: number }} options
 * @returns {{ dir: string, teardown: () => void, error: null }|{ dir: null, teardown: null, error: string }}
 */
function openWorktree({
	root = TREE_ROOT,
	execFn = execFileSync,
	worktreeFs = fs,
	err = process.stderr,
	pid = process.pid,
}) {
	const made = createIsolated(root, { execFn, worktreeFs, pid, err });
	if (made.error !== null)
		return { dir: null, teardown: null, error: made.error };
	const dir = made.dir;
	/* Held from here, so a kill — which no teardown reaches — still takes it
	 * down. `armSignals` is idempotent and shared with the queue markers. */
	const held = { root, dir };
	armSignals(fs);
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
 * The `--isolated` path: refuse or warn on the tree's state, build the frozen
 * worktree, run there, and take it down on both the green and the red path.
 *
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
			`--isolated: ${String(theirs.length)} tracked file(s) are uncommitted and not attributable to this session — the frozen worktree carries HEAD's version of each, not theirs.\n`,
		);

	const made = openWorktree(options);
	if (made.error !== null) {
		err.write(`--isolated: ${made.error}\n`);
		return Promise.resolve(1);
	}
	const { dir, teardown } = made;
	/* `readHeadSha(dir)`, never `readHeadSha(root)`: a neighbour can commit between the
	 * `worktree add` and this line, and naming the canonical HEAD would print a
	 * sha this run is NOT frozen at (mantahostels#2169). */
	out.write(
		`--isolated: running in a detached worktree at ${path.relative(root, dir)}, frozen at ${readHeadSha(dir)}\n`,
	);
	/* `root` is the ONLY override. Everything the wrapper derives from it —
	 * `bin`, the child's cwd, the drift snapshot the globalSetup takes — follows
	 * to the worktree, while `repoRoot()` keeps the log and the marker store in
	 * the canonical checkout. */
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
 * `run`, with `teardown` after it settles or where it throws before it can.
 *
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
 * The narrowed default with a session id (#812): a detached worktree at HEAD
 * carrying this session's own uncommitted files and nobody else's, so neither
 * a live neighbour's edit nor an orphan can enter or void its certificate.
 * The marker's `treeAtEnd` is taken there, so it is HEAD with the session's
 * own files on top — the tree its commit will be.
 *
 * THE OVERLAY REPLACES `runIsolated`'s REFUSAL ON `mine`, for this path and
 * `runChangedOverlaid`'s only. An escalation is a full run and still goes
 * through `runIsolated`, refusal and all.
 *
 * THE NARROWING IS JUDGED INSIDE THE WORKTREE, escalation included, so a
 * neighbour's dirty `package.json` neither widens the selection nor escalates
 * the run.
 *
 * A file of this session's that `mine` misses is read at HEAD's version: a
 * Bash-route write (mantahostels#296) neither the code credit
 * (mantahostels#2778) nor the selection ledger's quoted paths (#1220) caught, a
 * path a live neighbour holds, everything where the ledger will not read, and a
 * new file where the untracked list will not. Its certificate then fails `holdsAt`'s
 * rule 3 (the tree-match test, `scripts/lib/test-pass-marker.js`) at the
 * commit, and the session re-runs.
 *
 * Null where the overlay cannot be built, said on `err`: the caller runs on
 * `route.fallback`.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @returns {Promise<number>|null}
 */
function runOverlaid(route, options) {
	return withOverlay(route, options, "narrowed default", (dir, teardown) =>
		narrowDefault(route, dir, options, {
			run: (argv, plan) =>
				runOnce(argv, {
					...withLaunch(options, { isolated: true, viaChanged: false }),
					root: dir,
					expand: () => plan,
				}),
			teardown,
		}),
	);
}

/**
 * `npm run test:changed` with a session id (#1217): the bare run's overlay,
 * so its diff against HEAD is the session's own uncommitted files and a
 * neighbour's edit neither selects a reader nor is read. A certificate made after a
 * commit therefore selects nothing from it; `npm run test` tests that. A
 * `--retest` takes the same overlay (#1860), and so does a touched run (#2930).
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runOverlaid>[1]} options
 * @returns {Promise<number>|null}
 */
function runChangedOverlaid(route, options) {
	const label = overlayLabel(route);
	return withOverlay(route, options, label, (dir, teardown) =>
		runThenTeardown(
			() =>
				runOnce(route.rest, {
					...withLaunch(options, { isolated: true }),
					root: dir,
				}),
			teardown,
		),
	);
}

/** @param {LaunchRoute} route */
function overlayLabel(route) {
	if (route.kind === "touched") return "touched tests";
	return route.source === "retest" ? "--retest" : "test:changed";
}

/**
 * Build the overlay worktree and hand it to `run`, which owns its teardown.
 * Null where it cannot be built, said on `err` under `label`, naming the
 * `route.fallback` the caller runs on instead.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runOverlaid>[1]} options
 * @param {string} label
 * @param {(dir: string, teardown: () => void) => Promise<number>} run
 * @returns {Promise<number>|null}
 */
function withOverlay(route, options, label, run) {
	const {
		root = TREE_ROOT,
		err = process.stderr,
		out = process.stdout,
	} = options;
	const instead =
		route.fallback === "worktree"
			? "running in a frozen worktree instead"
			: "reading the shared tree instead";
	/** @param {string} why */
	const fallback = (why) => {
		err.write(`${label}: ${why} — ${instead} (#812).\n`);
		return null;
	};

	const attributed = sweepAndAttribute(root, { ...options, withQuotes: true });
	if (attributed === null)
		return fallback("git would not say which files are uncommitted");
	const { mine, theirs, quoted } = attributed;

	const made = openWorktree(options);
	if (made.error !== null) return fallback(made.error);
	const { dir, teardown } = made;
	const overlayError = overlayFiles(root, dir, mine, options);
	if (overlayError) {
		teardown();
		return fallback(overlayError);
	}

	out.write(
		`${label}: running in a detached worktree at ${path.relative(root, dir)}, at ${readHeadSha(dir)}, carrying ${String(mine.length)} uncommitted file(s) of this session's own (#812).\n`,
	);
	if (quoted.length > 0)
		out.write(
			`${label}: ${String(quoted.length)} of them only because an inline python/node program quoted them (#1220): ${quoted.join(" ")}\n`,
		);
	if (theirs.length > 0)
		err.write(
			`${label}: ${String(theirs.length)} uncommitted tracked file(s) not attributable to this session are read at HEAD's version, not theirs.\n`,
		);
	freshenOverlay(dir, root, options);
	return run(dir, teardown);
}

/**
 * The overlay's read-edge manifest brought up to date before the run is
 * planned (`manifest-freshen.js`, #1860), so the plan selects its readers
 * and names it among the paths the certificate attests.
 *
 * @param {string} dir the overlay
 * @param {string} home the shared checkout
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function freshenOverlay(dir, home, options) {
	let rendered;
	try {
		rendered = (options.renderEdges ?? (() => liveEdges(dir)))();
	} catch {
		/* The plan renders again and its banner says why it cannot (#998). */
		return;
	}
	freshenManifest(rendered, {
		root: dir,
		home,
		session: options.sessionId || idSeam.fromEnv(),
		claimFn: options.claimFn,
		out: options.out ?? process.stdout,
		err: options.err ?? process.stderr,
	});
}

/** @typedef {import("./lib/own-selection.js").OwnSet} OwnSet */
/** @typedef {OwnSet & { label: string }} ProbeSet what the probe says it read */

/**
 * The path set an overlaid run will select from, read in the shared tree with
 * `ownSelection` (#1221), so a probe never counts a neighbour's file the
 * overlay leaves out, nor misses an own new file it carries. Null where the
 * route selects from anything but the session's own work, or where the set
 * will not read, said on `err`: the probe then reads the shared tree's diff.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @returns {ProbeSet|null}
 */
function ownProbeSet(route, options) {
	const { root = TREE_ROOT, err = process.stderr } = options;
	if (route.source !== "own") return null;
	const isDefault = route.kind === "bare" || route.kind === "touched";
	/* An own source is only ever decided with a session id. */
	const sessionId = /** @type {string} */ (route.sessionId);
	if (isDefault) {
		const set = ownDefaultWork(root, sessionId, options);
		if (set)
			return { ...set, label: `this session's own work since ${set.base}` };
	} else {
		const paths = ownSelection(root, sessionId, options)?.uncommitted;
		if (paths)
			return {
				paths,
				dropped: [],
				carriesUntracked: true,
				label: "this session's own uncommitted work",
			};
	}
	err.write(
		"--queue: this session's own work could not be read, so the probe reads the shared tree's diff instead (#1221).\n",
	);
	return null;
}

/**
 * What a narrowed run's EMPTY selection was taken from — `the diff against
 * <base>`, the session's own work, or the adopted path list — or null where the
 * run is full, escalates, selects anything, or the probe fails. Judged in the
 * shared tree before a `--queue` run joins the queue (#1016), so a run with
 * nothing to test never waits for a slot, and again during the wait where
 * `buildQueueRecheck` lets it (#1158).
 *
 * The run itself still re-selects in its own tree, overlay or worktree, and
 * writes its marker there — so a non-empty `--queue` run pays for the
 * selection twice, once here and once after the gate. Where the overlay then
 * fails to build, the run takes `route.fallback` unqueued, the gate's backstop
 * still counting it.
 *
 * Throws `SelectionFailed` where the selection itself fails.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @param {ProbeSet|null} [own] the re-check's, already read
 * @returns {string|null}
 */
function emptySelectionSource(route, options, own) {
	return probeSelection(route, options, own).source;
}

/**
 * `emptySelectionSource`'s probe, with the plan it read: null for an
 * escalation, an unreadable manifest or an argv with no selection to expand.
 * `probed` is false where the probe itself failed, so no plan can weigh the
 * run (#2931).
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @param {ProbeSet|null} [own]
 * @returns {{ source: string|null, plan: ReturnType<typeof expandChanged>, probed: boolean }}
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
 * The selection `emptySelectionSource` judges, quietly: null for an
 * escalation or an unreadable manifest, which the run after the gate prints
 * itself. Throws `SelectionFailed` where the selection fails (#2698).
 *
 * @param {LaunchRoute} route
 * @param {string} root
 * @param {Parameters<typeof runDefault>[1] & { ownWork?: ProbeSet }} options
 */
function probedPlan(route, root, options) {
	if (route.kind === "bare") {
		const planned = planDefault(route.rest, root, options);
		return "plan" in planned ? planned.plan : null;
	}
	if (route.kind === "touched") return planTouched(route.rest, root, options);
	const { fs: _fs, ...expandOptions } = options;
	return expandChanged(route.rest, {
		...expandOptions,
		root,
		err: { write: () => true },
	});
}

/* A changed path the manifest cannot vouch for: source and shell a test
 * imports or spawns, a test itself, or a root vitest reruns everything on. */
const MAY_SELECT =
	/\.(?:[cm]?[jt]sx?|sh)$|(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.[^/]+)$/;

/**
 * Build a queued run's re-check (#1158): called on every poll, it answers
 * what the selection has emptied against since it was built, else null.
 *
 * #1016's probe runs once, before the queue. A selection then empties during
 * the wait when a push moves the default's base or a commit clears what
 * `--changed` read.
 *
 * THE PROBE IS SLOW UNDER LOAD, so it is never re-run on a timer. Each
 * poll reads only HEAD and the pushed ref; on a move, the paths the run would
 * select from are listed — its own set where it has one (#1221) — and only
 * where none of them could select a test — `MAY_SELECT`, or a key in the
 * committed read-edge manifest — does the full probe confirm. A selection
 * that fails throws `SelectionFailed`;
 * every other failure keeps the run waiting and says so once. A missing
 * pushed ref reads as an empty tip, not a failure.
 *
 * Residual: a moved diff that still touches code waits out the queue even
 * where its selection is empty; only the probe could tell, at its full cost.
 *
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
	const pushed = pushedRef({ root });
	const readTips = () => `${readTip("HEAD")} ${readTip(pushed)}`;
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
 * `buildQueueRecheck`'s answer once the tips have moved: what the selection
 * has emptied against, else null. Throws where the paths cannot be read, and
 * `SelectionFailed` where the selection fails.
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof emptySelectionSource>[1]} options
 * @returns {string|null}
 */
function emptiedSince(route, options) {
	const { root = TREE_ROOT, execFn = execFileSync } = options;
	const own = ownProbeSet(route, options);
	const ref =
		route.kind === "bare" || route.kind === "touched"
			? readDefaultChangedBase(root, execFn)
			: (changedFlag(route.rest)?.ref ?? null);
	const edges = (options.loadEdges ?? (() => readCommittedEdges(root)))();
	const reachable = (own?.paths ?? readChangedPaths(root, ref, execFn)).some(
		(p) => MAY_SELECT.test(p) || Object.hasOwn(edges, p),
	);
	return reachable ? null : emptySelectionSource(route, options, own);
}

/**
 * The queue wait's outcome, or `"refused"` once the re-check's selection
 * fails.
 *
 * @param {() => Promise<import("./lib/suite-queue.js").WaitOutcome>} wait
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
 * Whether a `--full` word is refused for naming no cause, or one outside
 * `FULL_CAUSES` (#182) — saying so, and recording it, where it is.
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
 * Run the launch on the tree `route` names.
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {Promise<number>}
 */
function runByRoute(route, opts) {
	if (route.kind === "bare") return runDefault(route, opts);
	if (route.kind === "touched") return runTouched(route, opts);
	const noted = withCommittedNote(route, opts);
	return onTree(route, {
		overlay: () => runChangedOverlaid(route, withSession(route, noted)),
		worktree: () => runIsolated(route.rest, noted),
		shared: () => runOnce(route.rest, noted),
	});
}

/**
 * A bare `--changed` whose selection is empty names the command that tests
 * the session's unpushed commits (#2182): it diffs against HEAD, so a certificate
 * made after a commit selects nothing from it.
 *
 * Residual: a selection that is not empty leaves those commits out unsaid,
 * and so does one where `readOwnPaths` cannot read the range or the ledger.
 *
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {RunOptions}
 */
function withCommittedNote(route, opts) {
	if (route.kind !== "changed" || changedFlag(route.rest)?.ref) return opts;
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
 * @param {Parameters<typeof runDefault>[1] & {}} opts
 * @returns {string|null}
 */
function buildCommittedNote(route, opts) {
	const { root = TREE_ROOT, execFn = execFileSync } = opts;
	const base = readDefaultChangedBase(root, execFn);
	const own = readOwnPathsAt(root, base, withSession(route, opts));
	if (!own || own.kept.length === 0) return null;
	return `UNPUSHED WORK NOT SELECTED — \`--changed\` reads only uncommitted files, so none of your ${own.kept.length} unpushed commit(s) since ${shortSha(base)} is tested here. \`${readCommandOrDefault("test")}\` tests them, narrowed to your own work (#2182).\n`;
}

/**
 * The note naming the neighbour commits an explicit `--changed <ref>`'s range
 * takes on (#2182), or null where it takes none on or the ledger cannot say.
 * Never a refusal: taking one on is the flag's job (#1216).
 *
 * @param {LaunchRoute} route
 * @param {RunOptions} opts
 * @returns {string|null}
 */
function buildNeighbourRangeNote(route, opts) {
	const ref = changedFlag(route.rest)?.ref;
	if (!ref) return null;
	const own = readOwnWorkAt(
		opts.root ?? TREE_ROOT,
		ref,
		withSession(route, opts),
	);
	if (!own) return null;
	return `NEIGHBOURS' COMMITS TAKEN ON — \`--changed ${ref}\` takes on ${own.dropped.length} neighbour commit(s) in its range, whose reds are theirs: ${own.dropped.map(shortSha).join(", ")}. For your own unpushed commits and uncommitted files alone, run \`${readCommandOrDefault("test")}\` (#2182).\n`;
}

/**
 * The `--queue` line for a selection that reaches no test file (#1016): the
 * lander where no push gate exists (#2961), else push_check — which also
 * reports a config pushGateState cannot read.
 * @param {string} emptySource
 * @param {string} root
 */
function buildQueueSkipLine(emptySource, root) {
	const gate = pushGateState({ root });
	const pushLine =
		gate.state === "skip"
			? `${gate.line} (#2961)`
			: `\`${readCommandOrDefault("push_check")}\` says whether a certificate attests your push`;
	return `--queue: ${emptySource} reaches no test file, so this run skips the queue (#1016). ${pushLine}.\n`;
}

/**
 * A part-suite inside a held seat (#2918): no turn, the seat having waited
 * once for the loop, and the memory rung alone holds it, refusing at the
 * bound. Its marker carries the admitted and spawned stamps, so no two
 * launches pass the rung on one reading before either shows in `ps` (#2622),
 * and the memoryHeld stamp, so a younger part-suite passes it while the rung
 * holds it (#3058).
 * Only a wait that held it, or a refusal, is an exit line, of kind `seat`:
 * the alarm keeps counting a rung wait (#2911).
 *
 * @param {{ options: import("./lib/suite-queue.js").QueuedLaunchOptions & { loadHold?: () => Promise<boolean>, err?: { write: (s: string) => unknown }, queueLog?: string|null, root?: string }, words: string[], weight: import("./lib/suite-handoff.js").CarriedWeight, session: string|null, run: (extra?: { escalationRequeues?: boolean, onSpawn?: () => void }) => Promise<number>, queued: () => Promise<number>, requeueWhole: () => Promise<number> }} seat
 * @returns {Promise<number>}
 */
async function runSeated({
	options,
	words,
	weight,
	session,
	run,
	queued,
	requeueWhole,
}) {
	if (weight.wholeSlot || !heldSeat(options)) return queued();
	const gate =
		options.gate ?? (() => gateDenies(words, options.gateRead, weight));
	const logExit = queueExitLogger({
		file: queueLogFile(options),
		kind: "seat",
		session,
		label: "--queue",
		err: options.err ?? process.stderr,
	});
	const ticket = queueJoin({ ...options, weight });
	if (ticket) heldMarkers.add(ticket);
	const started = Date.now();
	const onKill = (/** @type {string} */ signal) =>
		logExit("killed", Date.now() - started, { signal });
	waitingExits.add(onKill);
	armSignals(options.queueFs ?? fs);
	const sleep =
		options.sleepFn ??
		((/** @type {number} */ ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)));
	let slept = false;
	try {
		const outcome = await waitForGate({
			hold: options.loadHold,
			...options,
			gate: () => {
				const denial = gate();
				return denial?.limb === "memory" ? denial : null;
			},
			turn: () => true,
			...queueStamps(ticket, options),
			part: true,
			sleepFn: (ms) => {
				slept = true;
				return sleep(ms);
			},
			onExit: (reason, waitMs, heldBy) => {
				waitingExits.delete(onKill);
				if (reason !== "opened" || slept) logExit(reason, waitMs, heldBy);
			},
		});
		if (outcome === "refused") return 1;
		const code = await run({
			escalationRequeues: true,
			onSpawn: () => queueSpawned(ticket, options),
		});
		if (code !== REQUEUE_WHOLE) return code;
	} finally {
		waitingExits.delete(onKill);
		heldMarkers.delete(ticket);
		queueLeave(ticket, options);
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
	/* `--full` is refused BEFORE anything is stripped (#182): a bare `--full`,
	 * or one naming a cause outside `FULL_CAUSES`, must never reach `rest` or
	 * run anything. */
	const fullWord = fullFlagWord(argv);
	if (fullWord && refusesFullCause(fullWord, argv, options))
		return Promise.resolve(1);
	/* All four flags are consumed here and none reaches vitest, which rejects
	 * an unknown one. Stripping them before `expandChanged` also keeps
	 * `--isolated --changed <ref>` admissible at the push (mantahostels#2146): isolation
	 * freezes what the suite reads, it does not narrow what it selects.
	 * `||`, not `??`: the suite stubs the id to "", which is no session. */
	const route = launchRoute(argv, options.sessionId || idSeam.fromEnv(), {
		landing: moduleOn("landing", { root: options.root ?? TREE_ROOT }),
	});
	const { rest } = route;
	const fullFlag = route.kind === "full";
	/* The launcher's half of the record, threaded to every run below so the
	 * marker carries it whichever path the launch takes (#182). */
	const launch = {
		isolated: false,
		viaChanged: isChangedOnlyArgv(rest),
		touched: route.kind === "touched",
		slotFree: isTouchedRun(route),
		/* "flag" for a typed `--full`; an escalation names its own reason
		 * (mantahostels#3207, mantahostels#3208). */
		full: fullFlag ? "flag" : null,
		/* Null for anything `runDefault` escalates to: its cause is the
		 * escalation `full` names (#182). */
		fullCause: fullCauseOf(fullWord),
		argv,
	};
	const runOptions = { ...options, launch };
	const ranged = buildNeighbourRangeNote(route, runOptions);
	if (ranged) (options.out ?? process.stdout).write(ranged);
	const run = (extra = {}) => runByRoute(route, { ...runOptions, ...extra });
	if (!argv.includes(QUEUE_FLAG)) return run();
	/* Built before the first probe, so a push during that probe is a move the
	 * re-check sees (#1158). */
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
	const emptySource = probe.source;
	/* The queue, the gate and the `ps` weighers all read this one weight
	 * (#2931). */
	let weight = probedWeight(probe, rest, {
		...options,
		slotFree: launch.slotFree,
	});
	const reweigh = (/** @type {typeof weight} */ next) => {
		weight = next;
		runOptions.launch = { ...launch, ...weight };
	};
	reweigh(weight);
	const logFile = queueLogFile(options);
	const logExit = queueExitLogger({
		file: logFile,
		kind: route.kind,
		slotFree: launch.slotFree,
		session: route.sessionId,
		label: "--queue",
		err: options.err ?? process.stderr,
	});
	if (emptySource !== null) {
		(options.out ?? process.stdout).write(
			buildQueueSkipLine(emptySource, options.root ?? TREE_ROOT),
		);
		logExit("left", 0, { skipped: true });
		return run();
	}
	const requeueWhole = () => {
		reweigh({ resolvedFiles: null, wholeSlot: true });
		return queued();
	};
	/** @returns {Promise<number>} */
	const queued = async () => {
		/* A part-suite takes no slot, as the gate never holds it at the count
		 * cap (#2558). */
		const part = !weight.wholeSlot;
		const ticket = queueJoin({ ...options, weight });
		if (ticket) heldMarkers.add(ticket);
		const started = Date.now();
		const onKill = (/** @type {string} */ signal) =>
			logExit("killed", Date.now() - started, { signal });
		waitingExits.add(onKill);
		armSignals(options.queueFs ?? fs);
		runOptions.onSpawn = () => queueSpawned(ticket, options);
		let held = true;
		const release = () => {
			if (held) {
				heldMarkers.delete(ticket);
				queueLeave(ticket, options);
			}
			held = false;
		};
		/* The marker is HELD until the run finishes, not dropped when the wait
		 * ends. Dropped at launch, a waiter could take this run's slot in the gap
		 * before vitest is up far enough for the guard to see it. Held, queued
		 * runs fill at most WHOLE_SUITE_MAX slots, and the gate holds unqueued
		 * ones. A run that LEAVES holds no slot, so it drops its marker
		 * at once and runs `emptyOnly`. */
		/* The worktree is built AFTER the gate opens, so its frozen sha is the
		 * one the run actually starts from rather than the one the wait began at. */
		try {
			const { turn, exitFields } = passingTurn(options);
			const outcome = await waitOrRefuse(
				() =>
					waitForGate({
						turn,
						leave: recheck,
						gateWords: rest,
						gateWeight: weight,
						hold: options.loadHold,
						...options,
						...queueStamps(ticket, options),
						part,
						onExit: (reason, waitMs, heldBy) => {
							waitingExits.delete(onKill);
							logExit(reason, waitMs, exitFields(reason, heldBy));
						},
					}),
				options,
				() => logExit("refused", Date.now() - started),
			);

			if (outcome === "refused") return 1;
			if (outcome === "run") {
				const code = await run({ escalationRequeues: part });
				if (code !== REQUEUE_WHOLE) return code;
				release();
				(options.err ?? process.stderr).write(
					"--queue: the selection now takes the whole-suite slot it was admitted without — joining the queue again, whole (#2931).\n",
				);
				/* Residual: re-admitted, it re-plans, and a plan narrowed again runs
				 * charged whole — the over-charging direction. */
				return requeueWhole();
			}
			release();
			const code = await run({ emptyOnly: true });
			if (code !== REQUEUE) return code;
			(options.err ?? process.stderr).write(
				"--queue: a commit refilled the selection after the re-check — joining the queue again (#1158).\n",
			);
			return queued();
		} finally {
			waitingExits.delete(onKill);
			release();
		}
	};
	return runSeated({
		options,
		words: rest,
		weight,
		session: route.sessionId,
		run,
		queued,
		requeueWhole,
	});
}

if (require.main === module) {
	/* Refused before the load hold, so a launch npm half-swallowed, or one
	 * vitest would be handed a selection flag raw, never waits for a slot it
	 * would then misuse (#2284, #2764). */
	const argv = process.argv.slice(2);
	const refusal =
		npmSwallowedRefusal(argv, process.env) ?? selectionClashRefusal(argv);
	if (refusal) {
		process.stderr.write(refusal);
		process.exitCode = 1;
	} else
		holdForLoad()
			.then((go) =>
				go
					? // WFC_RUN_VITEST_BIN is test-only: a real subprocess test needs to run
						// THIS file for real, as a child process, to prove the pipe survives —
						// which is outside a JS test's reach unless the stand-in executable is
						// named through the environment rather than an argument this entry point
						// never sees.
						main(process.argv.slice(2), {
							loadHold: () => holdForLoad(),
							...(process.env.WFC_RUN_VITEST_BIN
								? { bin: process.env.WFC_RUN_VITEST_BIN }
								: {}),
						})
					: 1,
			)
			// `process.exitCode`, never `process.exit()`: stdout is a pipe here, so
			// writes to it are queued rather than synchronous, and exit() tears the
			// process down before a piped `| head` or `| grep` has drained that
			// queue — losing exactly the failure text this wrapper exists to keep
			// (mantahostels#1943 review). Setting the code and returning lets Node exit once its
			// own streams are actually flushed.
			.then((code) => {
				process.exitCode = code;
			})
			.catch((error) => {
				process.stderr.write(`run-vitest.js crashed: ${error}\n`);
				process.exitCode = 1;
			});
}

module.exports = { main };
