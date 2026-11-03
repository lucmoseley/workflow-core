/*
 * quiet-bench-tick.js — one refill-loop tick's step on the quiet bench route
 * (lib/quiet-bench.js, workflow-core#3852): the reads its decision asks for, the pause written
 * under the control lock against a fresh read, and the runner's detached start,
 * outside every session as the lander's is, so no session waits on it.
 *
 * The state is written only once the pause's change is, so a lock held past the
 * wait leaves the step for the next tick to decide again.
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./caught.js");
const { CHILD_TIMEOUT_MS, spawnChild } = require("./child-spawn.js");
const { countSessions, readProcCwd } = require("./claude-sessions.js");
const { gh, parseErrLine } = require("./gh.js");
const { spawnDetachedRun } = require("./lander-start.js");
const { readAvailableMb } = require("./meminfo.js");
const { pidLock } = require("./pid-lock.js");
const { presenceAt } = require("./presence.js");
const {
	BENCH_RUNNER,
	HOLD_DRAINING,
	HOLD_RUNNING,
	LADDER_BENCH,
	decideQuietBench,
	isRunAnswering,
	parseBenchState,
} = require("./quiet-bench.js");
const {
	postRun,
	quietBenchFiles,
	readKeptRuns,
	readRunResult,
	readUnpostedRuns,
} = require("./quiet-bench-runs.js");
const { QUIET_BENCH_PAUSE } = require("./refill-decide.js");
const {
	readControlChecked,
	readJson,
	withControlLock,
	writeControlFile,
	writeJson,
} = require("./refill-files.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { PS_BIN } = require("./suite-ladder.js");
const { resolveKey } = require("./workflow-core-config.js");

const SCRIPTS = path.dirname(__dirname);

/* A guess: a control writer holds its lock for one read and write. */
const HOLD_LOCK_WAIT_MS = 1000;

/**
 * Whether the suite has outgrown the ladder (check-suite-size-drift's WARN), no
 * kept run answers the ladder as it stands, and no open issue blocks workflow-core#2862, whose
 * rows that issue would make unusable. A read that fails is no due measurement.
 * @param {string} root
 * @param {(line: string) => void} log
 */
function readDue(root, log) {
	const r = spawnChild(
		process.execPath,
		[path.join(SCRIPTS, "check-suite-size-drift.js"), "--json"],
		{ cwd: root, env: buildCheckoutEnv(root), timeout: CHILD_TIMEOUT_MS },
	);
	try {
		if (JSON.parse(r.stdout).outcome !== "WARN") return false;
		if (readKeptRuns().some(isRunAnswering)) return false;
		const open = gh([
			"api",
			`repos/${resolveKey("tracker", { root })}/issues/${LADDER_BENCH.issue}/dependencies/blocked_by`,
			"--jq",
			'[.[] | select(.state == "open")] | length',
		]);
		return Number(open) === 0;
	} catch (e) {
		log(`quiet bench: its due read failed: ${buildErrorText(e)}`);
		return false;
	}
}

/**
 * The bench's own two readings; an unread one is null, which is not quiet.
 * @returns {import("./quiet-bench.js").QuietReading}
 */
function readQuiet() {
	const ps = spawnChild(PS_BIN(), ["-eo", "pid=,ppid=,args="], {
		timeout: CHILD_TIMEOUT_MS,
	});
	const available = readAvailableMb();
	return {
		sessions: ps.failed ? null : countSessions(ps.stdout, readProcCwd),
		availableMb: available.ok ? available.mb : null,
	};
}

/**
 * How the newest kept run ended, null where it left no result since `since`.
 * @param {number} since ms
 */
function readLastEnding(since) {
	const [run] = readKeptRuns();
	const result = run ? readRunResult(run.dir) : null;
	return result && result.endedAt >= since ? result.ending : null;
}

const readRunnerPid = () =>
	pidLock(quietBenchFiles().pid, BENCH_RUNNER).holder();

/**
 * Stop the runner, which stops its bench and posts what it has. Gone already is
 * stopped.
 */
function stopRunner() {
	const pid = readRunnerPid();
	if (pid === null) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch (e) {
		if (caught(e).code !== "ESRCH") throw e;
	}
}

/**
 * The control with the pause `kind` asks for, written against a fresh read, or
 * null where the lock stayed held or a take finds a pause already set: a pause
 * another writer has set is never overwritten, nor lifted.
 * @param {"take"|"lift"|"running"} kind
 * @param {number} now
 * @param {(line: string) => void} log
 * @returns {import("./refill-loop.js").Control|null}
 */
function writeHold(kind, now, log) {
	const written = withControlLock(() => {
		const { control } = readControlChecked(log);
		if (control === null) return null;
		if (kind === "take") {
			if (control.paused !== undefined) return null;
			const paused = { by: QUIET_BENCH_PAUSE, at: now, why: HOLD_DRAINING };
			const next = { ...control, paused };
			writeControlFile(next);
			return next;
		}
		if (control.paused?.by !== QUIET_BENCH_PAUSE) return control;
		/** @type {import("./refill-loop.js").Control} */
		const next =
			kind === "running"
				? { ...control, paused: { ...control.paused, why: HOLD_RUNNING } }
				: (({ paused: _lifted, ...rest }) => rest)(control);
		writeControlFile(next);
		return next;
	}, HOLD_LOCK_WAIT_MS);
	if ("busy" in written) {
		log(`quiet bench: its pause waits for the next tick: ${written.busy}`);
		return null;
	}
	return written.done;
}

/**
 * Start the runner detached in `root`.
 * @param {string} root
 */
const startRunner = (root) =>
	spawnDetachedRun({
		root,
		script: path.join(SCRIPTS, BENCH_RUNNER),
		log: quietBenchFiles().log,
	});

/**
 * Post each run a failed post or a dead runner left unposted, with no runner
 * holding the newest.
 * @param {string} root
 * @param {(line: string) => void} log
 */
function postLeftRuns(root, log) {
	if (readRunnerPid() !== null) return;
	for (const run of readUnpostedRuns()) {
		try {
			postRun(run, root);
			log(`quiet bench: posted run ${run.id}`);
		} catch (e) {
			log(`quiet bench: run ${run.id} not posted: ${parseErrLine(e)}`);
		}
	}
}

/**
 * The route's step on one tick; the control the rest of the tick goes on.
 * @param {{control: import("./refill-loop.js").Control, lastTypedAt: number|null,
 *   served: string[], now: number, log: (line: string) => void,
 *   start?: (root: string) => unknown}} tick
 * @returns {import("./refill-loop.js").Control}
 */
function tendQuietBench({
	control,
	lastTypedAt,
	served,
	now,
	log,
	start = startRunner,
}) {
	const files = quietBenchFiles();
	const root = served.find((r) =>
		fs.existsSync(path.join(r, LADDER_BENCH.script)),
	);
	const step = decideQuietBench({
		now,
		off: control.quietBenchOff === true || root === undefined,
		present: presenceAt(lastTypedAt, new Date(now)) === "present",
		...(control.paused ? { paused: control.paused } : {}),
		state: parseBenchState(readJson(files.state, log)),
		readDue: () => readDue(/** @type {string} */ (root), log),
		readQuiet,
		readRunner: (since) => ({
			alive: readRunnerPid() !== null,
			ended: readLastEnding(since),
		}),
	});
	const next = step.hold ? writeHold(step.hold, now, log) : control;
	if (next === null) return control;
	if (step.line) log(`quiet bench: ${step.line}`);
	if (step.stop) stopRunner();
	if (step.start && root !== undefined) {
		try {
			start(root);
		} catch (e) {
			/* Fails open: with no runner the next tick past the grace lifts the hold. */
			log(`quiet bench: not started: ${buildErrorText(e)}`);
		}
	}
	writeJson(files.state, step.state);
	if (root !== undefined) postLeftRuns(root, log);
	return next;
}

module.exports = { tendQuietBench };
