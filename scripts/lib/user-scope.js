/*
 * user-scope.js — starting a command in a cgroup of its own under the user's
 * systemd manager: the lander's scope (#2956) and each test run's (#3401).
 *
 * A TEST RUN'S SCOPE IS CAPPED AND KILLED WHOLE. Its child starts in
 * `wfc-test-<pid>-<n>.scope` at `TasksMax`, so a runaway fork chain is refused
 * forks at the cap instead of filling `/init.scope`, whose abort takes WSL's
 * init down (#3400). `RuntimeMaxSec` stops the scope at #2667's 15 minutes
 * even where the wrapper died before its own ceiling fired. When the run
 * ends, `cgroup.kill` takes every process in the scope, those that left the
 * process group included.
 *
 * RESIDUAL: a cap hit whose forks all exit before the scope is first found,
 * some 20-120 ms after the spawn, and that leaves no refused fork after it,
 * goes unseen by the wrapper. The suite's own end-of-run read, from inside
 * the scope, still sees it.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const SYSTEMD_RUN = "systemd-run";
const USER_SCOPE = ["--user", "--scope", "--quiet"];
/* A guess: a user manager that has not answered in this long is read as none. */
const SCOPE_PROBE_TIMEOUT_MS = 5000;

/* The delegated decision on #3401. */
const TASKS_MAX = 1024;
/* #2667's 15 minutes. */
const RUNTIME_MAX_SEC = 900;
/* Lower only, as the suite ceiling's override is: for the cap's own tests. */
const TASKS_MAX_ENV = "WFC_RUN_TASKS_MAX";
const UNIT_PREFIX = "wfc-test-";
const CGROUP_ROOT = "/sys/fs/cgroup";
/* How often the wrapper looks for its child's scope until it appears. A
 * guess. */
const FIND_EVERY_MS = 10;

/**
 * The words that start a command in a cgroup of its own under the user's
 * systemd manager, or none where that manager will not make one (#2956).
 * Where sessions and their hooks share one cgroup (WSL's `/init.scope`), CFS
 * weighs the lander's cgroup against theirs as one sibling, at equal
 * `cpu.weight`, however many processes they run. `systemd-run --scope` execs
 * the command, keeping its pid, environment and file descriptors.
 * @returns {string[]}
 */
function probeUserScope() {
	const { status } = spawnSync(SYSTEMD_RUN, [...USER_SCOPE, "--", "true"], {
		stdio: "ignore",
		timeout: SCOPE_PROBE_TIMEOUT_MS,
	});
	return status === 0 ? [SYSTEMD_RUN, ...USER_SCOPE, "--"] : [];
}

/* The probe's answer, taken once per process by `spawnInRunScope`. */
/** @type {boolean|null} */
let managerAnswers = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function tasksMax(env = process.env) {
	const n = Number(env[TASKS_MAX_ENV]);
	return Number.isInteger(n) && n > 0 && n < TASKS_MAX ? n : TASKS_MAX;
}

/**
 * @typedef {{ unit: string, cap: number, dir: string|null,
 *   refused: number, timer: ReturnType<typeof setInterval>|null,
 *   watcher: fs.FSWatcher|null }} RunScope
 */

/** @type {WeakMap<object, RunScope>} */
const scopes = new WeakMap();
/* The scopes not yet ended, which `armExitKill`'s exit handler kills. */
/** @type {Set<RunScope>} */
const live = new Set();
let exitArmed = false;
/* Numbers each scope this process starts, so a run that follows one the
 * manager has not yet collected never meets its unit name. */
let started = 0;

/**
 * Whether `command` names a file this process may execute, found on `PATH`
 * as `spawn` would find it.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 */
function isRunnable(command, env) {
	const candidates = command.includes("/")
		? [command]
		: (env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, command));
	return candidates.some((file) => {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

/**
 * `spawn`'s signature, the child started in a capped scope of its own where
 * the user manager makes one, else in this process's cgroup with one warning
 * line. A command it cannot execute is spawned bare, so its ENOENT or EACCES
 * reaches the caller as spawn's own `error`, not as systemd-run's exit 1.
 * `endRunScope` must be called on the child once the run ends.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnInRunScope(command, args, options) {
	const env = options.env ?? process.env;
	if (!isRunnable(command, env)) return spawn(command, args, options);
	if (managerAnswers === null) managerAnswers = probeUserScope().length > 0;
	if (!managerAnswers) {
		writeFd(
			2,
			"no user scope: this test run shares its starter's cgroup, uncapped (#3401)\n",
		);
		return spawn(command, args, options);
	}
	started += 1;
	const unit = `${UNIT_PREFIX}${String(process.pid)}-${String(started)}`;
	const cap = tasksMax(env);
	const child = spawn(
		SYSTEMD_RUN,
		[
			...USER_SCOPE,
			"--collect",
			`--unit=${unit}`,
			"-p",
			`TasksMax=${String(cap)}`,
			"-p",
			`RuntimeMaxSec=${String(RUNTIME_MAX_SEC)}`,
			"--",
			command,
			...args,
		],
		options,
	);
	if (child.pid === undefined) return child;
	/** @type {RunScope} */
	const scope = {
		unit,
		cap,
		dir: null,
		refused: 0,
		timer: null,
		watcher: null,
	};
	scopes.set(child, scope);
	live.add(scope);
	armExitKill();
	const pid = child.pid;
	scope.timer = setInterval(() => find(scope, pid), FIND_EVERY_MS);
	scope.timer.unref();
	return child;
}

/** @param {string} text a `/proc/<pid>/cgroup` file, cgroup v2 */
const cgroupOf = (text) => text.trim().split("::")[1] ?? "";

/**
 * Looks for the child in its scope, which systemd-run joins before it execs
 * the command; once found, watches `pids.events`, which the kernel notifies
 * on every refused fork, so a count is read before the scope is collected.
 * accumulator: sets `scope`'s `dir`, `timer` and `watcher`.
 * @param {RunScope} scope
 * @param {number} pid
 */
function find(scope, pid) {
	let line;
	try {
		line = fs.readFileSync(`/proc/${String(pid)}/cgroup`, "utf8");
	} catch {
		/* The child is gone: there is no scope left to find. */
		stopLooking(scope);
		return;
	}
	const cgroup = cgroupOf(line);
	if (path.basename(cgroup) !== `${scope.unit}.scope`) return;
	stopLooking(scope);
	scope.dir = path.join(CGROUP_ROOT, cgroup);
	noteRefused(scope);
	try {
		scope.watcher = fs.watch(path.join(scope.dir, "pids.events"), () =>
			noteRefused(scope),
		);
		scope.watcher.on("error", () => scope.watcher?.close());
		scope.watcher.unref();
	} catch {
		/* Unwatched, the end-of-run read alone counts the refusals (#3401). */
	}
}

/** accumulator: clears `scope.timer`. @param {RunScope} scope */
function stopLooking(scope) {
	if (scope.timer) clearInterval(scope.timer);
	scope.timer = null;
}

/** accumulator: raises `scope.refused`. @param {RunScope} scope */
function noteRefused(scope) {
	if (!scope.dir) return;
	const n = readRefusedCount(scope.dir);
	if (n !== null && n > scope.refused) scope.refused = n;
}

/**
 * The forks a cgroup's `pids.max` has refused, or null where it is gone.
 * @param {string} dir
 * @returns {number|null}
 */
function readRefusedCount(dir) {
	try {
		const text = fs.readFileSync(path.join(dir, "pids.events"), "utf8");
		const m = /^max (\d+)$/m.exec(text);
		return m ? Number(m[1]) : 0;
	} catch {
		return null;
	}
}

/** @param {RunScope} scope */
function killScope(scope) {
	if (!scope.dir) return;
	try {
		fs.writeFileSync(path.join(scope.dir, "cgroup.kill"), "1");
	} catch (e) {
		/* An empty scope has already been collected. */
		if (caught(e).code !== "ENOENT") throw e;
	}
}

/* So a wrapper that exits on a signal or an error leaves no scope running. */
function armExitKill() {
	if (exitArmed) return;
	exitArmed = true;
	process.on("exit", () => {
		for (const scope of live)
			try {
				killScope(scope);
			} catch {
				/* Exiting: RuntimeMaxSec still stops it (#3401). */
			}
	});
}

/**
 * The scope's cgroup by its unit name, for a child that exited before
 * `find` saw it in its scope; null where the manager no longer has it.
 * @param {string} unit
 * @returns {string|null}
 */
function dirOfUnit(unit) {
	const { stdout } = spawnSync(
		"systemctl",
		["--user", "show", "-p", "ControlGroup", "--value", `${unit}.scope`],
		{ encoding: "utf8", timeout: SCOPE_PROBE_TIMEOUT_MS },
	);
	const cgroup = (stdout ?? "").trim();
	return cgroup ? path.join(CGROUP_ROOT, cgroup) : null;
}

/**
 * Ends a run's scope, by whatever route the run ended: reads the refused
 * forks, then kills everything left in the scope. Call it once the child has
 * exited, not when its pipes close, which a process left in the scope can
 * withhold. A child started with no scope, or one already ended, ends
 * nothing.
 * @param {object} child
 * @returns {string|null} the report of a run that hit the cap, else null
 */
function endRunScope(child) {
	const scope = scopes.get(child);
	if (!scope) return null;
	scopes.delete(child);
	live.delete(scope);
	stopLooking(scope);
	scope.watcher?.close();
	scope.dir ??= dirOfUnit(scope.unit);
	noteRefused(scope);
	try {
		killScope(scope);
	} catch (e) {
		writeFd(
			2,
			`test run's scope ${scope.unit} could not be killed (${caught(e).message}); a process in it may outlive the run.\n`,
		);
	}
	return scope.refused > 0 ? capReport(scope.refused, scope.cap) : null;
}

/**
 * @param {number} refused
 * @param {number} cap
 */
const capReport = (refused, cap) =>
	`TASK CAP — this run hit its scope's cap at ${String(cap)} tasks, and ${String(refused)} fork(s) were refused (#3401). The run fails: find the test that forks without bound in the output above.\n`;

/**
 * Whether the calling process's own test-run scope has refused a fork, read
 * from inside it. Only a test-run scope counts: any other cgroup's count
 * runs from boot.
 * @returns {boolean}
 */
function hasOwnScopeHitCap() {
	let cgroup;
	try {
		cgroup = cgroupOf(fs.readFileSync("/proc/self/cgroup", "utf8"));
	} catch {
		/* No procfs: no scope was made, so there is no cap to have hit. */
		return false;
	}
	if (!path.basename(cgroup).startsWith(UNIT_PREFIX)) return false;
	const refused = readRefusedCount(path.join(CGROUP_ROOT, cgroup));
	if (refused === null) {
		writeFd(
			2,
			"test run's scope count unreadable: its task cap is unchecked here (#3401)\n",
		);
		return false;
	}
	return refused > 0;
}

module.exports = {
	probeUserScope,
	spawnInRunScope,
	endRunScope,
	hasOwnScopeHitCap,
};
