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
 * SILENCE, NOT TOTAL ELAPSED TIME. A wall-clock ceiling has to be set above the
 * slowest legitimate run, which on a contended machine is unknowable, so it is
 * either too tight to trust or too loose to help. A healthy run shows a sign of
 * life continuously — output, or a test or hook event the in-flight reporter
 * stamps on its file (#1149) — and a parked one shows none.
 *
 * AND IT PRINTS THE RUN-COST REPORT after the suite's own summary (#1883):
 * each new or changed test file over budget. It never touches the exit code
 * (mantahostels#2255).
 */

const { spawn, execFileSync } = require("node:child_process");
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
	isPartSuite,
	queueJoin,
	queueAdmit,
	queueSpawned,
	queueLeave,
	queueTurn,
	waitForGate,
} = require("./lib/suite-queue.js");
const { ownPaths } = require("./lib/own-work.js");
const idSeam = require("./lib/session-id.js");
const {
	queueExitLogPath,
	queueExitLogger,
} = require("./lib/queue-exit-log.js");
const { holdForLoad } = require("./lib/cpu-sample.js");
const {
	CHANGED_FLAG,
	PACKAGE_JSON,
	changedFlag,
	changedPaths,
	committedEdges,
	expandChanged,
	isChangedOnlyArgv,
	defaultChangedBase,
	defaultEscalationReason,
	liveEdges,
} = require("./lib/changed-selection.js");
/** @typedef {import("./lib/dirty-tree.js").ExecFn} ExecFn */
/** @typedef {import("./lib/changed-selection.js").ExpandFs} ExpandFs */
/** @typedef {import("./lib/isolated-worktree.js").WorktreeFs} WorktreeFs */
/** @typedef {import("./lib/own-selection.js").Ledger} Ledger */
/** @typedef {import("./lib/launch-route.js").LaunchRoute} LaunchRoute */
const { hostRoot } = require("./lib/host-root.js");
const { commandOrDefault } = require("./lib/workflow-core-config.js");
const { pushedRef } = require("./lib/landing-refs.js");
const {
	attributeDirty,
	lastCommitAt,
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
	GIT_TIMEOUT_MS,
	REFUSAL_NAMED_MAX,
	shellWord,
	trackedStatus,
	untrackedFiles,
} = require("./lib/dirty-tree.js");
const {
	QUEUE_FLAG,
	FULL_FLAG,
	FULL_PREFIX,
	fullFlagWord,
	stripWrapperFlags,
	isFullRunArgv,
	launchRoute,
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

/* How long after the kill this wrapper waits for the child's `close` before
 * settling anyway. Ten seconds is far past the kill's own cost and short enough
 * that a session is not left waiting on a process that will never report. */
const SETTLE_MS = 10_000;

/**
 * The stall ceiling, from the environment where it is a non-negative number.
 *
 * ZERO DISABLES THE WATCHDOG, for the one case that legitimately wants no
 * ceiling: a debugger attached to a worker, where a paused process is the point.
 * A value that is not a number is IGNORED rather than obeyed as zero — a typo
 * must not silently remove the protection.
 */
function stallMs() {
	const raw = process.env[STALL_ENV];
	if (raw === undefined || raw === "") return STALL_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : STALL_MS;
}

/* The HOST repository under test — its node_modules (so `vitest` resolves to
 * the copy it installed), its `docs/test-read-edges.json`, its tracked tree
 * for the dirty-tree and worktree machinery below. Never `__dirname` (#1): in
 * a plugin install the core's files sit in the plugin cache, not the host
 * repo whose suite this runs. */
const HOST_ROOT = hostRoot();

/** HEAD, or "unknown" where git will not answer — never thrown. */
/** @param {string} root */
function headSha(root) {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
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
function stallReport(rows, ms, root) {
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
		`Raise or disable the ceiling with ${STALL_ENV}=<ms>, 0 to disable.`,
		"No partial result counts: once fixed, re-run the same command whole.",
		"",
	);
	return lines.join("\n");
}

/**
 * The environment `runOnce` hands vitest: the parent's own, the in-flight
 * file, and the launch record the certificate is written from.
 * @param {{ inflightFile: string, timingsFile: string, plan: ReturnType<typeof expandChanged>, launch: LauncherLaunch }} run
 */
function vitestEnv({ inflightFile, timingsFile, plan, launch }) {
	return {
		...process.env,
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
 * @typedef {Partial<Omit<import("./lib/suite-handoff.js").Launch, "admissible"|"changedPaths"|"base">>} LauncherLaunch
 */

/**
 * The run-cost report for the timings the in-flight reporter left at `file`,
 * then the file removed. An absent file is a run that timed nothing — vitest
 * died before its end, or a config without the reporter — and prints nothing.
 * @param {string} root
 * @param {string} file
 * @returns {string[]}
 */
function runCostLines(root, file) {
	if (!fs.existsSync(file)) return [];
	try {
		return reportForFile(root, file);
	} finally {
		timings.clear(file);
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
 * `spawnFn`, `root`, `fs` and `bin` are injectable so the wrapper's own
 * behaviour is assertable without a real vitest run. `bin` also lets a real
 * subprocess test point at a stand-in executable instead of paying for a real
 * vitest invocation to prove the pipe survives a real, slow-reading `head`.
 *
 * `stall`, `inflightFile` and `timingsFile` are injectable for the same
 * reason. The defaults are paths of this run's own, never the repo-root one: 2-3
 * concurrent suites are sanctioned here, and one shared name means a
 * neighbour's run end deletes the rows this run's stall would be named from.
 *
 * @param {string[]} argv
 * @param {{ spawnFn?: typeof spawn, root?: string, fs?: WrapperFs, bin?: string, stall?: number, inflightFile?: string, timingsFile?: string,
 *   expand?: typeof expandChanged, out?: { write: (s: string) => unknown },
 *   execFn?: ExecFn, loadEdges?: () => Record<string, string[]>, err?: { write: (s: string) => unknown },
 *   launch?: LauncherLaunch, onSpawn?: () => void, emptyOnly?: boolean, session?: string|null }} [options]
 * @returns {Promise<number>}
 */
function runOnce(
	argv = process.argv.slice(2),
	{
		spawnFn = spawn,
		root = HOST_ROOT,
		fs: fsImpl = fs,
		bin = path.join(root, "node_modules", ".bin", "vitest"),
		stall = stallMs(),
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
		/* Whose run record the finished run joins (#1575); none is kept
		 * without one. */
		session = idSeam.fromEnv(),
		...expandOptions
	} = {},
) {
	/* Consumed here, never passed on: vitest is handed the union as an explicit
	 * file list instead. A null plan is a --changed-free argv or an expansion
	 * that failed open, both of which run argv unchanged. */
	const plan = expand(argv, { root, bin, ...expandOptions });
	if (emptyOnly && plan && plan.files.length > 0)
		return Promise.resolve(REQUEUE);
	/* An empty selection runs too, on a filter matching nothing, so the
	 * reporter's end hook fires and the marker is written (#189 §6). */
	const runArgv = plan ? plan.argv : argv;

	const target = repoRoot(root) || root;
	const sha = headSha(root);
	const file = logPath(target, sha, new Date(), process.pid);
	const opened = openLog(file, { fs: fsImpl });
	/* Reassigned to null on a late write failure (ENOSPC, EIO — anything past
	 * the open itself), which createWriteStream reports asynchronously through
	 * `error` rather than throwing. Unhandled, that `error` event is a fatal
	 * uncaughtException; handled, it is the same "no log" degradation as a
	 * failed open. */
	let stream = opened.stream;
	if (opened.error)
		process.stderr.write(
			`test log not written (${opened.error}) — this run's output is not being saved to ${file}\n`,
		);
	if (plan) {
		out.write(plan.banner);
		stream?.write(plan.banner);
	}
	stream?.on("error", (error) => {
		stream = null;
		process.stderr.write(
			`test log write failed (${error}) — the rest of this run's output is not being saved to ${file}\n`,
		);
	});

	const startedAt = new Date();
	/* A previous run in this process may have left one; this run's report
	 * must read only its own. */
	timings.clear(timingsFile);
	return new Promise((resolve) => {
		const child = spawnFn(bin, ["run", ...runArgv], {
			cwd: root,
			stdio: ["inherit", "pipe", "pipe"],
			env: vitestEnv({ inflightFile, timingsFile, plan, launch }),
		});
		onSpawn();

		// ENOENT, EACCES: spawn reports these through an `error` event on an
		// async child, same shape as spawnSync's `.error` in run-pytest.js.
		// A real ChildProcess always has `.on`; the only caller that would not is
		// a test double built wrong, and that should throw rather than hide it.
		child.on("error", (error) => {
			process.stderr.write(`vitest could not be run: ${error}\n`);
		});

		/* Set while the watchdog is armed; cleared once it kills or the child
		 * closes, so a resolved run leaves no timer holding the event loop open. */
		/** @type {ReturnType<typeof setTimeout>|null} */
		let watchdog = null;
		let stalled = false;
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
			if (!stall) return;
			disarm();
			since = from;
			const left = stall - (Date.now() - from);
			watchdog = setTimeout(killUnlessBeat, Math.max(0, Math.min(stall, left)));
			/* The timer must not by itself keep this process alive — a run that
			 * finishes with the watchdog armed should exit at once. */
			watchdog.unref?.();
		};
		/* Read only when the timer fires, so a heartbeat costs the wrapper one
		 * stat per ceiling rather than one per test. */
		const killUnlessBeat = () => {
			const beat = inflight.lastBeat(inflightFile);
			if (beat > since) return arm(beat);
			stalled = true;
			const record = inflight.readRecord(inflightFile);
			const report = stallReport(record.open, stall, target);
			process.stderr.write(report);
			if (stream) stream.write(report);
			recordStall(target, {
				sha,
				at: new Date().toISOString(),
				startedAt: startedAt.toISOString(),
				durationMs: Date.now() - startedAt.getTime(),
				stallMs: stall,
				inflight: record.open,
				finished: record.finished,
				argv: launch.argv ?? [],
			});
			/* SIGKILL, not SIGTERM: the parent is wedged waiting on a worker
			 * that cannot be asked to stop. */
			child.kill("SIGKILL");
			/* SIGKILL reaches the vitest PARENT. Under `pool: "forks"` the
			 * parked worker is a separate process holding the pipe's write
			 * end, so `close` — which needs stdio EOF as well as exit — can
			 * never arrive and this promise would never settle, leaving the
			 * wrapper hung after announcing its own kill. Settling on a timer
			 * costs an orphaned worker; not settling costs the report. */
			giveUp = setTimeout(() => resolve(1), SETTLE_MS);
			giveUp.unref?.();
		};

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
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);

		child.on("close", (code) => {
			disarm();
			/* After the suite's summary and into the log, so the teed record
			 * keeps it. A stalled or killed run never reaches the reporter's
			 * run end, so it leaves no timings and prints nothing here. */
			const report = runCostLines(root, timingsFile).join("\n");
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
					 * scripts/guard-lost-verdict.sh finds the log then. */
					const run = {
						log: file,
						pid: process.pid,
						startedAt: startedAt.toISOString(),
						endedAt: new Date().toISOString(),
					};
					if (session && !recordRun(target, session, run))
						process.stderr.write(
							`run record not written to ${runsPath(target, session)} — a hook cannot hand back this run's verdict if the output loses it\n`,
						);
					reap(dirPath(target), { fs: fsImpl });
				}
				inflight.clearFile(inflightFile);
				/* A stall must never be able to exit 0. */
				resolve(stalled || code === null ? 1 : code);
			};
			if (stream) stream.end(finish);
			else finish();
		});
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
 * The exit codes are the shell's own convention, 128 + signal number, so a
 * killed waiter still reports as killed rather than as a clean exit.
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
				sha: headSha(root),
				at: new Date().toISOString(),
				suite: DEFAULT_SUITE,
				refused: true,
				refusedWhy: "full-cause",
				refusedWord: word,
				argv,
			},
			{ root },
		);
	} catch {
		/* a store this cannot write to costs the count, never the refusal */
	}
}

/**
 * Records a stall kill to the fail store (#1149), which a killed run otherwise
 * never reaches: the pass reporter writes only at `onTestRunEnd`. It carries
 * no `scope`, so no reader of red runs mistakes it for a verdict on any file.
 *
 * NEVER THROWS: a store this cannot write to costs the count, never the kill,
 * and says so, since a missing record reads as no kill.
 *
 * @param {string} root
 * @param {{ sha: string, at: string, startedAt: string, durationMs: number,
 *   stallMs: number, inflight: { module: string, stage: string }[],
 *   finished: string[], argv: string[] }} kill
 */
function recordStall(root, kill) {
	let landed = false;
	try {
		landed = recordFailure(
			{ ...kill, suite: DEFAULT_SUITE, stalled: true },
			{ root },
		);
	} catch {
		/* reported below with the false return */
	}
	if (!landed)
		process.stderr.write(
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
 * full-shaped, without a session-typed `--full` — now narrows to the diff
 * against `merge-base(HEAD, <pushed ref>)` rather than running the whole
 * suite, the pushed ref being lib/landing-refs.js's `pushedRef`. IT IS NEVER
 * FETCHED: a stale remote ref only widens the selection where the merge-base
 * still resolves against it. WHERE IT DOES
 * NOT EXIST OR THE MERGE-BASE CANNOT BE RESOLVED, the base falls back to
 * `HEAD` instead — which NARROWS the selection to uncommitted work alone,
 * silently dropping every already-committed change since the true base from
 * a certifying, admissible run. `runDefault` prints the resolved base on the
 * selection banner so a session can see which one it got.
 */

/**
 * One line of why bare argv escalated to the whole suite (mantahostels#3208).
 * @param {"stale-manifest"|"dependency-root"|"expansion-failed"} reason
 * @param {string} ref
 */
function escalationBanner(reason, ref) {
	/** @type {Record<string, string>} */
	const why = {
		"stale-manifest": `${EDGES_FILE} is unreadable or the read graph could not be rendered from this tree, so nothing can show which tests read this diff`,
		"dependency-root": `the diff touches ${PACKAGE_JSON} outside the narrowing allow-list, which vitest treats as a dependency-graph root`,
		"expansion-failed": `the diff against ${ref}, or vitest's own listing of it, could not be resolved into a test selection`,
	};
	/* The way out differs by reason: a manifest or render that fails still
	 * narrows under an explicit --changed (uncertified); a dependency-root
	 * diff narrows too (mantahostels#2160's allow-list is the default path's
	 * own check, not --changed's);
	 * but an unreadable diff fails the same way under --changed, so naming it
	 * as an escape would be false. */
	const wayOut = {
		"stale-manifest":
			"Name `--changed` yourself to keep this narrowed instead.",
		"dependency-root":
			"Name `--changed` yourself to keep this narrowed instead.",
		"expansion-failed":
			"Naming a ref by hand hits the same failure — run `--full=<cause>` instead.",
	};
	return `DEFAULT ESCALATED TO THE WHOLE SUITE (${reason}) — ${why[reason] ?? reason} (mantahostels#3208). ${wayOut[reason] ?? ""}\n`;
}

/**
 * Bare argv's own entry point (mantahostels#3208): narrow to the diff against
 * `defaultChangedBase`, or escalate to the whole suite where that narrowing
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
	const { root = HOST_ROOT } = options;
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
								ownWork: ownWorkAt(
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
 * A PROBE FAILURE DOWNSTREAM OF `changedPaths` — `vitest list`, via
 * `packageJsonNarrowable`'s config write or `vitestSelection` itself —
 * must escalate exactly as a failed `git diff` already does, instead of
 * `expandChanged` silently returning null and the run that follows
 * falling back to a bare, unnarrowed, uncertified `--changed <base>`
 * with no banner (mantahostels#3251). `defaultEscalationReason` deliberately
 * does not exercise this probe itself: on the common, non-isolated
 * branch that would mean paying for `vitest list` twice on the
 * success path. The probe's `err` is a sink: its own failure text would
 * contradict the escalation banner, which is what a caller actually sees
 * happen next.
 *
 * NEVER HANDS `options.fs` TO `expandChanged`: that channel is `runOnce`'s
 * `WrapperFs` (the log's), incompatible with the `ExpandFs` it needs.
 *
 * OWN WORK ONLY (#1216): where `ownPaths` leaves a neighbour's commit out, the
 * selection, the escalation check and the marker's `changedPaths` all read
 * its path set. Where it leaves none out, or cannot say, the run is exactly
 * the diff's. The base never moves, so an explicit `--changed <ref>` is how a
 * session takes a neighbour's commit on.
 *
 * @param {string[]} rest
 * @param {string} at
 * @param {Parameters<typeof runDefault>[1] & { ownWork?: OwnSet|null }} options
 * @returns {{ base: string, reason: "stale-manifest"|"dependency-root"|"expansion-failed" }
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
	const base = defaultChangedBase(at, execFn);
	/* A queue probe hands its own set in (#1221). */
	const ownWork =
		options.ownWork === undefined
			? ownWorkAt(at, base, options)
			: options.ownWork;
	const reason = defaultEscalationReason(at, base, {
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
		err: { write: () => true },
	});
	if (!plan) return { base, reason: "expansion-failed" };
	return { base, argv, plan, dropped: ownWork?.dropped ?? [] };
}

/**
 * `ownPaths` at `at`, where it leaves a neighbour's commit out — else null
 * (#1216).
 *
 * @param {string} at
 * @param {string} base
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function ownWorkAt(at, base, options) {
	const resolved = ownPathsAt(at, base, options);
	return resolved && resolved.dropped.length > 0 ? resolved : null;
}

/**
 * `ownPaths` at `at` with the launch's session and seams.
 *
 * @param {string} at
 * @param {string} base
 * @param {Parameters<typeof runDefault>[1] & {}} options
 */
function ownPathsAt(at, base, options) {
	return ownPaths(at, base, {
		/* `||`, not `??`: the suite stubs the id to "", which is no session. */
		sessionId: options.sessionId || idSeam.fromEnv(),
		execFn: options.execFn ?? execFileSync,
		...(options.commitLedger ? { ledger: options.commitLedger } : {}),
	});
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
			return escalateDefault(route, planned.reason, planned.base, options);
		}
		out.write(
			`DEFAULT NARROWED TO THE DIFF AGAINST ${planned.base} (mantahostels#3208).\n`,
		);
		if (planned.dropped.length > 0)
			out.write(
				`OWN WORK ONLY — ${planned.dropped.length} neighbour commit(s) in that range left to their own sessions' greens, which the push composes (#1216): ${planned.dropped.map(shortSha).join(", ")}. Take one on with \`npm run test -- --changed <ref>\`.\n`,
			);
		running = run(planned.argv, planned.plan);
	} catch (error) {
		teardown();
		throw error;
	}
	return running.finally(teardown);
}

/**
 * The default's escalation to the whole suite, on `route.escalation`: it
 * isolates unless `--shared` was typed, exactly as `--full` does
 * (mantahostels#2278) — independent of whether the NARROWED run would have
 * used a worktree. Every escalation site comes through here, so they print and
 * dispatch identically.
 *
 * @param {LaunchRoute} route
 * @param {"stale-manifest"|"dependency-root"|"expansion-failed"} reason
 * @param {string} base
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @returns {Promise<number>}
 */
function escalateDefault(route, reason, base, options) {
	const { out = process.stdout } = options;
	out.write(escalationBanner(reason, base));
	const escalated = withLaunch(options, { full: reason, viaChanged: false });
	return route.escalation === "shared"
		? runOnce(route.rest, escalated)
		: runIsolated(route.rest, escalated);
}

/**
 * What the refusal prints. Built as a string so the test can assert the whole
 * message without a real run.
 *
 * THE HARM IT NAMES IS THE SESSION'S OWN BELIEF, never a push reading a stale
 * green — a certificate attests a tree and its read closure (ADR-0007), and
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
		"one byte of these files. Its green would say nothing whatever about them,",
		"while looking exactly like a green that did.",
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
 * so. `changedPaths` diffs the working tree against HEAD, and vitest's own
 * `--changed` does the same; in a tree checked out at HEAD both are empty by
 * construction. The run then prints its banner and returns 0 without spawning —
 * a no-op that reads as a green, which is the one outcome that must not be
 * silent. `--changed <ref>` is unaffected and stays allowed.
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
			"inside it — so the run would exit 0 having tested nothing, looking exactly\n" +
			"like a green.\n\n" +
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
	const status = trackedStatus(root, execFn);
	if (status === null) return null;
	/* A null untracked read is not fatal the way the tracked one is: it can
	 * only be the narrower failure, and attributing no new file from it is the
	 * same degradation as an unreadable ledger — `--isolated` refuses less, and
	 * the overlay reads HEAD without that file, the conservative miss
	 * `runOverlaid` names. */
	return attributeDirty(status.dirty, {
		...(sessionId ? { sessionId } : {}),
		...(ledger ? { ledger } : {}),
		untracked: untrackedFiles(root, execFn) ?? [],
		renames: status.renames,
		...(withQuotes ? { committedAt: lastCommitAt(root, execFn) } : {}),
	});
}

/*
 * `--isolated`: RUN THE SUITE AGAINST A FROZEN TREE (mantahostels#2169).
 *
 * A DETACHED WORKTREE AT HEAD IS IMMUNE BY CONSTRUCTION, for its tracked
 * content. Nothing but this run writes into it and its HEAD cannot move, so
 * `headMovedDuringRun` is false. `linkedPaths` is the named exception —
 * live, gitignored content symlinked in from the canonical checkout, mutable
 * by a neighbour for as long as this run holds it (mantahostels#2213).
 * The certificate machinery already follows it there:
 * `scripts/vitest-tree-watch.ts` resolves its ROOT from its own file, so the
 * drift snapshot is taken against the worktree, and `repoRoot()` roots the
 * marker store at the parent of `--git-common-dir`, so the marker still lands
 * in the canonical checkout's store, keyed by the sha that ran.
 *
 * It also removes the re-run a neighbour's mid-run commit forces (mantahostels#2098).
 *
 * mantahostels#2278 makes this the default for a full run, `--shared` the
 * escape. `docs/environment.md` §6 carries the readings and the rest
 * of what a session needs to use this flag.
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
	root = HOST_ROOT,
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
		root = HOST_ROOT,
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
	/* `headSha(dir)`, never `headSha(root)`: a neighbour can commit between the
	 * `worktree add` and this line, and naming the canonical HEAD would print a
	 * sha this run is NOT frozen at (mantahostels#2169). */
	out.write(
		`--isolated: running in a detached worktree at ${path.relative(root, dir)}, frozen at ${headSha(dir)}\n`,
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
 * new file where the untracked list will not. Its green then fails `holdsAt`'s
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
 * neighbour's edit neither selects a reader nor is read. A green made after a
 * commit therefore selects nothing from it; `npm run test` covers that. A
 * `--retest` takes the same overlay (#1860).
 *
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runOverlaid>[1]} options
 * @returns {Promise<number>|null}
 */
function runChangedOverlaid(route, options) {
	const label = route.source === "retest" ? "--retest" : "test:changed";
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
		root = HOST_ROOT,
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
		`${label}: running in a detached worktree at ${path.relative(root, dir)}, at ${headSha(dir)}, carrying ${String(mine.length)} uncommitted file(s) of this session's own (#812).\n`,
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
 * and names it among the paths the green covers.
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

/** @typedef {{ paths: string[], dropped: string[], carriesUntracked?: boolean }} OwnSet */
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
	const { root = HOST_ROOT, err = process.stderr } = options;
	if (route.source !== "own") return null;
	const isDefault = route.kind === "bare";
	/* An own source is only ever decided with a session id. */
	const sessionId = /** @type {string} */ (route.sessionId);
	const own = ownSelection(root, sessionId, options);
	const paths = isDefault ? (own?.scoped?.paths ?? own?.net) : own?.uncommitted;
	if (!own || !paths) {
		err.write(
			"--queue: this session's own work could not be read, so the probe reads the shared tree's diff instead (#1221).\n",
		);
		return null;
	}
	return {
		paths,
		dropped: (isDefault && own.scoped?.dropped) || [],
		carriesUntracked: true,
		label: isDefault
			? `this session's own work since ${own.base}`
			: "this session's own uncommitted work",
	};
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
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} options
 * @param {ProbeSet|null} [own] the re-check's, already read
 * @returns {string|null}
 */
function emptySelectionSource(route, options, own) {
	const { root = HOST_ROOT, err = process.stderr } = options;
	try {
		const set = own === undefined ? ownProbeSet(route, options) : own;
		const ownWork = set ? { ownWork: set } : {};
		/* A null plan is an escalation or an expansion that failed open; the
		 * run after the gate prints either itself, so the probe stays quiet. */
		let plan = null;
		if (route.kind === "bare") {
			const planned = planDefault(route.rest, root, { ...options, ...ownWork });
			if ("plan" in planned) plan = planned.plan;
		} else {
			const { fs: _fs, ...expandOptions } = options;
			plan = expandChanged(route.rest, {
				...expandOptions,
				...ownWork,
				root,
				err: { write: () => true },
			});
		}
		if (!plan || plan.files.length > 0) return null;
		if (set) return set.label;
		return plan.base
			? `the diff against ${plan.base}`
			: "the adopted path list";
	} catch (error) {
		err.write(
			`--queue: the selection could not be probed (${error}) — the run waits for its slot (#1016).\n`,
		);
		return null;
	}
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
 * committed read-edge manifest — does the full probe confirm. Every failure
 * keeps the run waiting and says so once. A missing pushed ref reads as an
 * empty tip, not a failure.
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
		root = HOST_ROOT,
		execFn = execFileSync,
		err = process.stderr,
	} = options;
	const tip = (/** @type {string} */ ref) => {
		try {
			return String(
				execFn("git", ["rev-parse", "--verify", "--quiet", ref], {
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
				}) ?? "",
			).trim();
		} catch {
			return "";
		}
	};
	const pushed = pushedRef({ root });
	const tips = () => `${tip("HEAD")} ${tip(pushed)}`;
	let seen = tips();
	let warned = false;
	return () => {
		const now = tips();
		if (now === seen) return null;
		seen = now;
		try {
			const own = ownProbeSet(route, options);
			const ref =
				route.kind === "bare"
					? defaultChangedBase(root, execFn)
					: (changedFlag(route.rest)?.ref ?? null);
			const edges = (options.loadEdges ?? (() => committedEdges(root)))();
			const reachable = (own?.paths ?? changedPaths(root, ref, execFn)).some(
				(p) => MAY_SELECT.test(p) || Object.hasOwn(edges, p),
			);
			return reachable ? null : emptySelectionSource(route, options, own);
		} catch (error) {
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
	recordFullRefusal(options.root ?? HOST_ROOT, fullWord, argv);
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
		? queueExitLogPath(options.root ?? HOST_ROOT)
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
	const noted = withCommittedNote(route, opts);
	return onTree(route, {
		overlay: () => runChangedOverlaid(route, withSession(route, noted)),
		worktree: () => runIsolated(route.rest, noted),
		shared: () => runOnce(route.rest, noted),
	});
}

/**
 * A bare `--changed` whose selection is empty names the command that covers
 * the session's unpushed commits (#2182): it diffs against HEAD, so a green
 * made after a commit selects nothing from it.
 *
 * Residual: a selection that is not empty leaves those commits out unsaid,
 * and so does one where `ownPaths` cannot read the range or the ledger.
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
			const note = committedNote(route, opts);
			return note ? { ...plan, banner: plan.banner + note } : plan;
		},
	};
}

/**
 * @param {LaunchRoute} route
 * @param {Parameters<typeof runDefault>[1] & {}} opts
 * @returns {string|null}
 */
function committedNote(route, opts) {
	const { root = HOST_ROOT, execFn = execFileSync } = opts;
	const base = defaultChangedBase(root, execFn);
	const own = ownPathsAt(root, base, withSession(route, opts));
	if (!own || own.kept.length === 0) return null;
	return `UNPUSHED WORK NOT SELECTED — \`--changed\` reads only uncommitted files, so none of your ${own.kept.length} unpushed commit(s) since ${shortSha(base)} is tested here. \`${commandOrDefault("test")}\` covers them, narrowed to your own work (#2182).\n`;
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
function neighbourRangeNote(route, opts) {
	const ref = changedFlag(route.rest)?.ref;
	if (!ref) return null;
	const own = ownWorkAt(opts.root ?? HOST_ROOT, ref, withSession(route, opts));
	if (!own) return null;
	return `NEIGHBOURS' COMMITS TAKEN ON — \`--changed ${ref}\` takes on ${own.dropped.length} neighbour commit(s) in its range, whose reds are theirs: ${own.dropped.map(shortSha).join(", ")}. For your own unpushed commits and uncommitted files alone, run \`${commandOrDefault("test")}\` (#2182).\n`;
}

/**
 * The entry point. `--queue` waits for the suite gate's count cap and memory
 * rung to open and then runs, the gate judging the run by its own words
 * (#2558); without it the suite starts now.
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
 * @param {Parameters<typeof runOnce>[1] & Parameters<typeof waitForGate>[0] & Parameters<typeof queueJoin>[0] & Parameters<typeof queueTurn>[0] & { loadHold?: () => Promise<boolean>, queueLog?: string|null, sessionId?: string }} [options]
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
	const route = launchRoute(argv, options.sessionId || idSeam.fromEnv());
	const { rest } = route;
	const fullFlag = route.kind === "full";
	/* The launcher's half of the record, threaded to every run below so the
	 * marker carries it whichever path the launch takes (#182). */
	const launch = {
		isolated: false,
		viaChanged: isChangedOnlyArgv(rest),
		/* "flag" for a typed `--full`; an escalation names its own reason
		 * (mantahostels#3207, mantahostels#3208). */
		full: fullFlag ? "flag" : null,
		/* Null for anything `runDefault` escalates to: its cause is the
		 * escalation `full` names (#182). */
		fullCause: fullCauseOf(fullWord),
		argv,
	};
	const runOptions = { ...options, launch };
	const ranged = neighbourRangeNote(route, runOptions);
	if (ranged) (options.out ?? process.stdout).write(ranged);
	const run = (extra = {}) => runByRoute(route, { ...runOptions, ...extra });
	if (!argv.includes(QUEUE_FLAG)) return run();
	/* Built before the first probe, so a push during that probe is a move the
	 * re-check sees (#1158). */
	const recheck = fullFlag ? () => null : buildQueueRecheck(route, runOptions);
	const emptySource = fullFlag ? null : emptySelectionSource(route, runOptions);
	const logFile = queueLogFile(options);
	const logExit = queueExitLogger({
		file: logFile,
		kind: route.kind,
		session: route.sessionId,
		label: "--queue",
		err: options.err ?? process.stderr,
	});
	if (emptySource !== null) {
		(options.out ?? process.stdout).write(
			`--queue: ${emptySource} reaches no test file, so this run skips the queue (#1016). \`${commandOrDefault("push_check")}\` says whether its marker covers your push.\n`,
		);
		logExit("left", 0, { skipped: true });
		return run();
	}
	/** @returns {Promise<number>} */
	const queued = async () => {
		/* A part-suite takes no slot, as the gate never holds it at the count
		 * cap (#2558). */
		const ticket = queueJoin({ ...options, part: isPartSuite(rest) });
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
		 * runs fill at most SUITE_MAX slots, and the gate is the backstop for
		 * unqueued ones. A run that LEAVES holds no slot, so it drops its marker
		 * at once and runs `emptyOnly`. */
		/* The worktree is built AFTER the gate opens, so its frozen sha is the
		 * one the run actually starts from rather than the one the wait began at. */
		try {
			const outcome = await waitForGate({
				turn: () => queueTurn(options),
				leave: recheck,
				gateWords: rest,
				hold: options.loadHold,
				admit: () => queueAdmit(ticket, options),
				...options,
				onExit: (reason, waitMs) => {
					waitingExits.delete(onKill);
					logExit(reason, waitMs);
				},
			});

			if (outcome === "refused") return 1;
			if (outcome === "run") return await run();
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
	return queued();
}

if (require.main === module) {
	/* Refused before the load hold, so a launch npm half-swallowed never waits
	 * for a slot it would then misuse (#2284). */
	const refusal = npmSwallowedRefusal(process.argv.slice(2), process.env);
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

module.exports = {
	/* guard-suite-concurrency.sh reads these two through this program, so it
	 * judges argv exactly as a launch does (#188). */
	stripWrapperFlags,
	isFullRunArgv,
	main,
};
