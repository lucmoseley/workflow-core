const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");
const { outlivingEnv, REPORT_OWNER, reportOwner } = require("./session-id.js");
const { REAL_PROC } = require("./proc-root.js");
const { OUTLIVES_KEY, outlivesMark } = require("./session-scope.js");
const {
	MANAGER_TIMEOUT_MS,
	systemctl,
	systemdRun,
} = require("./systemd-bins.js");
const { writeFd } = require("./write-fd.js");

const USER_SCOPE = ["--user", "--scope", "--quiet"];

// #3407 guess
const TASKS_MAX = 1024;
// #2667
const RUNTIME_MAX_SEC = 900;
const TASKS_MAX_ENV = "WFC_RUN_TASKS_MAX";
const UNIT_PREFIX = "wfc-test-";
const CGROUP_ROOT = "/sys/fs/cgroup";
// #3407 guess
const FIND_EVERY_MS = 10;

/** @returns {string[]} */
function probeUserScope() {
	const { status } = spawnSync(systemdRun(), [...USER_SCOPE, "--", "true"], {
		stdio: "ignore",
		timeout: MANAGER_TIMEOUT_MS,
	});
	return status === 0 ? [systemdRun(), ...USER_SCOPE, "--"] : [];
}

const USER_MANAGER_ENV = "WFC_USER_MANAGER";
/** @type {boolean|null} */
let managerAnswers = null;
const managerAnswersOnce = () => {
	if (managerAnswers !== null) return managerAnswers;
	const handed = process.env[USER_MANAGER_ENV];
	managerAnswers =
		handed === "yes" || handed === "no"
			? handed === "yes"
			: probeUserScope().length > 0;
	return managerAnswers;
};

const OUTLIVE_CEILING_S = 2700;

/** @param {number|null} ceilingS @returns {string[]} */
function buildOutlivingScope(ceilingS) {
	if (!managerAnswersOnce()) return [];
	const cap = ceilingS === null ? [] : ["-p", `RuntimeMaxSec=${ceilingS}`];
	return [systemdRun(), ...USER_SCOPE, ...cap, "--"];
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions & { owner?: string|null,
 *   ceilingS?: number|null, wrap?: string[] }} options
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnOutliving(
	command,
	args,
	{ owner, ceilingS = OUTLIVE_CEILING_S, wrap, ...options },
) {
	const starterEnv = options.env ?? process.env;
	const env = outlivingEnv(starterEnv);
	const named = owner === undefined ? reportOwner(starterEnv) : owner;
	if (named) env[REPORT_OWNER] = named;
	const [cmd, ...pre] = wrap ?? buildOutlivingScope(ceilingS);
	if (cmd !== undefined && starterEnv.CLAUDE_PID)
		env[OUTLIVES_KEY] = outlivesMark(starterEnv.CLAUDE_PID, ceilingS);
	const spawnOptions = { ...options, env, detached: true };
	return cmd === undefined
		? spawn(command, args, spawnOptions)
		: spawn(cmd, [...pre, command, ...args], spawnOptions);
}

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
/** @type {Set<RunScope>} */
const live = new Set();
let exitArmed = false;
let started = 0;

/** @param {string} command @param {NodeJS.ProcessEnv} env */
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
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnInRunScope(command, args, options) {
	const env = options.env ?? process.env;
	if (!isRunnable(command, env)) return spawn(command, args, options);
	if (!managerAnswersOnce()) {
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
		systemdRun(),
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

/** @param {string} text */
const cgroupOf = (text) => text.trim().split("::")[1] ?? "";

/** @param {RunScope} scope @param {number} pid */
function find(scope, pid) {
	let line;
	try {
		line = fs.readFileSync(`${REAL_PROC}/${String(pid)}/cgroup`, "utf8");
	} catch {
		stopLooking(scope);
		return;
	}
	const cgroup = cgroupOf(line);
	if (path.basename(cgroup) !== `${scope.unit}.scope`) return;
	stopLooking(scope);
	const dir = path.join(CGROUP_ROOT, cgroup);
	scope.dir = dir;
	noteRefused(scope);
	ignoreFailure(() => {
		scope.watcher = fs.watch(path.join(dir, "pids.events"), () =>
			noteRefused(scope),
		);
		scope.watcher.on("error", () => scope.watcher?.close());
		scope.watcher.unref();
	});
}

/** @param {RunScope} scope */
function stopLooking(scope) {
	if (scope.timer) clearInterval(scope.timer);
	scope.timer = null;
}

/** @param {RunScope} scope */
function noteRefused(scope) {
	if (!scope.dir) return;
	const n = readRefusedCount(scope.dir);
	if (n !== null && n > scope.refused) scope.refused = n;
}

/** @param {string} dir @returns {number|null} */
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
		if (caught(e).code !== "ENOENT") throw e;
	}
}

function armExitKill() {
	if (exitArmed) return;
	exitArmed = true;
	process.on("exit", () => {
		for (const scope of live) ignoreFailure(() => killScope(scope));
	});
}

/** @param {string} unit @returns {string|null} */
function dirOfUnit(unit) {
	const { stdout } = spawnSync(
		systemctl(),
		["--user", "show", "-p", "ControlGroup", "--value", `${unit}.scope`],
		{ encoding: "utf8", timeout: MANAGER_TIMEOUT_MS },
	);
	const cgroup = (stdout ?? "").trim();
	return cgroup ? path.join(CGROUP_ROOT, cgroup) : null;
}

/** @param {object} child @returns {string|null} */
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

/** @returns {boolean} */
function hasOwnScopeHitCap() {
	let cgroup;
	try {
		cgroup = cgroupOf(fs.readFileSync(`${REAL_PROC}/self/cgroup`, "utf8"));
	} catch {
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
	OUTLIVE_CEILING_S,
	probeUserScope,
	spawnOutliving,
	spawnInRunScope,
	endRunScope,
	hasOwnScopeHitCap,
};
