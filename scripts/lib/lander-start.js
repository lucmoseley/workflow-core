const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure, orFallback } = require("./caught.js");
const { gitOrNull } = require("./git.js");
const { markersDir } = require("./marker-root.js");
const { readJsonSafe } = require("./plugin-state.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { coreRoot } = require("./script-path.js");
const { reportOwner } = require("./session-id.js");
const { sleepSync } = require("./sleep-sync.js");
const { MANAGER_TIMEOUT_MS } = require("./systemd-bins.js");
const { probeUserScope, spawnOutliving } = require("./user-scope.js");

/**
 * @typedef {object} StartDeps
 * @property {() => number|null} holder
 * @property {() => string[]} waiting
 * @property {() => string[]} owed
 * @property {(ref: string) => boolean} isDeferred
 * @property {() => number} spawnRun
 */

/**
 * @param {StartDeps} deps
 * @returns {{started: number, waiting: string[], owed: string[]}
 *   | {skipped: string}}
 */
function startLander({ holder, waiting, owed, isDeferred, spawnRun }) {
	const pid = holder();
	if (pid !== null)
		return { skipped: `a lander is already running (pid ${pid})` };
	const refs = waiting();
	const drops = owed();
	if (refs.length === 0 && drops.length === 0)
		return { skipped: "no queue ref waits and no drop is owed a decision" };
	if (refs.length === 0 && drops.every(isDeferred))
		return {
			skipped: `no queue ref waits and each owed drop's owning session works: ${drops.join(", ")}`,
		};
	return { started: spawnRun(), waiting: refs, owed: drops };
}

/**
 * @param {string} [root]
 * @returns {string}
 */
function readCodeRef(root = coreRoot()) {
	if (fs.existsSync(path.join(root, ".git")))
		return gitOrNull(["rev-parse", "HEAD"], { cwd: root })?.trim() || "unread";
	const manifest = /** @type {{version?: unknown}|null} */ (
		readJsonSafe(path.join(root, ".claude-plugin", "plugin.json"))
	);
	return typeof manifest?.version === "string"
		? `v${manifest.version}`
		: "unread";
}

/**
 * @param {{started: number, waiting: string[], owed: string[]}} result
 * @param {{at: string, by: string, log: string, code: string}} o
 */
function buildStartedLine({ started, waiting, owed }, { at, by, log, code }) {
	/** @param {string[]} refs */
	const named = (refs) => (refs.length > 0 ? `: ${refs.join(", ")}` : "");
	return `${at} started the queue lander, ${waiting.length} queue ref(s) waiting${named(waiting)}, ${owed.length} drop(s) owed a decision${named(owed)} (launched by ${by}; pid ${started}; code ${code}); its output: ${log}`;
}

const CODE_OF = /; pid \d+; code (\S+)\); its output: /;

/**
 * @param {string} line
 * @returns {string|null}
 */
function parseStartedCode(line) {
	const code = CODE_OF.exec(line)?.[1];
	return code === undefined || code === "unread" ? null : code;
}

// guess, #2478
const NAME_TRIES = 5;
// guess, #2478
const NAME_PAUSE_MS = 2000;

/**
 * @param {() => import("./agent-liveness.js").Listing} listAgents
 * @param {string|null} [sessionId]
 * @param {(ms: number) => void} [pause]
 * @returns {string}
 */
function launcherName(
	listAgents,
	sessionId = reportOwner(),
	pause = sleepSync,
) {
	if (sessionId === null) return "no session";
	for (let tries = 1; ; tries++) {
		const { agents, why } = listAgents();
		const listed = agents?.find((a) => a.sessionId === sessionId);
		if (listed?.name) return listed.name;
		if (tries === NAME_TRIES)
			return `session ${sessionId.slice(0, 8)}${why ? ` (${why})` : ""}`;
		pause(NAME_PAUSE_MS);
	}
}

/** @param {string} root */
const landerLog = (root) => path.join(markersDir(root), ".lander.log");

// guess, #4239
const START_TIMEOUT_MS = 60_000;

/**
 * @param {string} root
 * @param {{ script?: string, args?: string[] }} [o]
 * @returns {{ ok: boolean, line: string }}
 */
function runStartLander(
	root,
	{ script = path.join(__dirname, "..", "start-lander.js"), args = [] } = {},
) {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: START_TIMEOUT_MS,
	});
	if (r.status !== 0)
		return {
			ok: false,
			line: `start-lander.js ended ${r.status ?? r.signal}: ${(r.stderr || r.error?.message || "").trim()}`,
		};
	const line = r.stdout.trim();
	fs.appendFileSync(landerLog(root), `${line}\n`);
	return { ok: true, line };
}

// guess, #5613
const SCOPE_CONFIRM_MS = MANAGER_TIMEOUT_MS;
// measured: a scope execs its command in ~30 ms, #5613
const SCOPE_POLL_MS = 10;
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
const STAT_EXIT_CODE = 52 - 3;

/** @param {number} waitStatus */
const describeEnd = (waitStatus) =>
	waitStatus & 0x7f
		? `it ended on signal ${waitStatus & 0x7f}`
		: `it ended ${waitStatus >> 8}`;

/**
 * @param {number} pid
 * @param {string} node
 * @param {(ms: number) => void} pause
 * @returns {{ up: true } | { up: false, why: string }}
 */
function confirmExec(pid, node, pause) {
	for (let waited = 0; ; waited += SCOPE_POLL_MS) {
		const stat = orFallback(
			() => fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
			null,
		);
		if (stat === null) return { up: false, why: "it was gone" };
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z") {
			const status = Number(fields[STAT_EXIT_CODE]);
			return {
				up: false,
				why: Number.isInteger(status) ? describeEnd(status) : "it ended",
			};
		}
		if (orFallback(() => fs.readlinkSync(`/proc/${pid}/exe`), null) === node)
			return { up: true };
		if (waited >= SCOPE_CONFIRM_MS) {
			ignoreFailure(() => process.kill(pid, "SIGKILL"));
			return {
				up: false,
				why: `it had not started the lander in ${SCOPE_CONFIRM_MS} ms`,
			};
		}
		pause(SCOPE_POLL_MS);
	}
}

/**
 * @param {{root: string, script: string, tester?: string, log: string,
 *   wrap?: string[], spawn?: typeof spawnOutliving,
 *   pause?: (ms: number) => void}} o
 * @returns {number}
 */
function spawnDetachedRun({
	root,
	script,
	tester,
	log,
	wrap = probeUserScope(),
	spawn = spawnOutliving,
	pause = sleepSync,
}) {
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const fd = fs.openSync(log, "a");
	const note = (/** @type {string} */ line) =>
		fs.writeSync(fd, `${new Date().toISOString()} ${line}\n`);
	const run = [
		script,
		"run",
		...(tester === undefined ? [] : ["--tester", tester]),
	];
	/** @param {string[]} wrapWith */
	const start = (wrapWith) => {
		if (wrapWith.length === 0)
			note("no user scope: the lander shares its starter's cgroup (#2956)");
		const child = spawn(process.execPath, run, {
			cwd: root,
			env: { ...buildCheckoutEnv(root), WFC_NOW: undefined },
			stdio: ["ignore", fd, fd],
			owner: null,
			wrap: wrapWith,
		});
		if (child.pid === undefined) throw new Error(`could not start ${script}`);
		child.unref();
		return child.pid;
	};
	try {
		const pid = start(wrap);
		const [binary] = wrap;
		if (binary === undefined) return pid;
		const scoped = confirmExec(pid, fs.realpathSync(process.execPath), pause);
		if (scoped.up) return pid;
		note(
			`the user scope was refused: ${path.basename(binary)} ${scoped.why} (#5613)`,
		);
		return start([]);
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = {
	startLander,
	buildStartedLine,
	readCodeRef,
	parseStartedCode,
	launcherName,
	spawnDetachedRun,
	landerLog,
	runStartLander,
};
