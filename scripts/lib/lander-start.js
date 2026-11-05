/*
 * lander-start.js — whether to start the queue lander, and the detached start
 * (#2405, spec #2261; #4458).
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const { QUEUE_PREFIX, REMOTE } = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { forgetSession, fromEnv } = require("./session-id.js");
const { sleepSync } = require("./sleep-sync.js");
const { probeUserScope } = require("./user-scope.js");

/**
 * @typedef {object} StartDeps
 * @property {() => number|null} holder the live lander's pid, or null
 * @property {() => string[]} waiting the queue refs waiting on the remote
 * @property {() => number} spawnRun starts a detached queue lander,
 *   returning its pid
 */

/**
 * Starts a queue lander only where none runs and a queue ref waits.
 * Residual: two starts inside one lander's startup both spawn, and the
 * second exits on the lock.
 * @param {StartDeps} deps
 * @returns {{started: number, waiting: string[]} | {skipped: string}}
 */
function startLander({ holder, waiting, spawnRun }) {
	const pid = holder();
	if (pid !== null)
		return { skipped: `a lander is already running (pid ${pid})` };
	const refs = waiting();
	if (refs.length === 0) return { skipped: "no queue ref waits" };
	return { started: spawnRun(), waiting: refs };
}

/**
 * The queue refs the remote of `root` holds, by branch, as `queue/<name>`.
 * @param {string} root
 * @returns {string[]}
 */
function readWaitingQueueRefs(root) {
	const heads = `refs/heads/${QUEUE_PREFIX}`;
	return execGit(["ls-remote", REMOTE, `${heads}*`], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	})
		.split("\n")
		.flatMap((line) => {
			const ref = line.split("\t")[1] ?? "";
			return ref.startsWith(heads) ? [ref.slice("refs/heads/".length)] : [];
		});
}

/* A guess: a session-start launch can read the oracle before its session is
 * listed, so an unlisted id is asked again this many times, this far apart. */
const NAME_TRIES = 5;
const NAME_PAUSE_MS = 2000;

/**
 * The session that launched this start, by its `claude agents` name (#2478);
 * where the oracle still names none after NAME_TRIES reads, the short id
 * `claude agents` itself prints (the first 8 characters), with the oracle's
 * last refusal where it could not be read; "no session" where none launched it.
 * @param {() => import("./agent-liveness.js").Listing} listAgents
 * @param {string|null} [sessionId]
 * @param {(ms: number) => void} [pause]
 * @returns {string}
 */
function launcherName(listAgents, sessionId = fromEnv(), pause = sleepSync) {
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

/** @param {string} root the canonical checkout's root */
const landerLog = (root) => path.join(markersDir(root), ".lander.log");

/* Untraced: start-lander.js names its launcher in up to NAME_TRIES reads
 * NAME_PAUSE_MS apart, then reads the remote once. */
const START_TIMEOUT_MS = 60_000;

/**
 * start-lander.js run to its end in `root`, its line appended to the lander's
 * log as a hook's detached start appends it: for a caller that reports the
 * line.
 * @param {string} root the canonical checkout
 * @param {{ script?: string, args?: string[] }} [o] `script` the start-lander.js
 *   to run; `args` its flags
 * @returns {{ ok: boolean, line: string }} `ok` false where it exited non-zero
 *   or did not run, `line` then saying why
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

/**
 * `node <script> run [--tester <command>]` in `root`, in a session of its own
 * so no hook's process-group kill reaches it, appending its output to `log`,
 * behind `wrap`'s words. It runs as no session: under the starting one's id and
 * root, admission counts that session as itself, the fix tickets it files are
 * claimed for it, and its suite read the main checkout (#2410).
 * Residual: a scope the probe allowed can still fail to start, and then
 * systemd-run's refusal lands in the log and the returned pid exits at once.
 * @param {{root: string, script: string, tester?: string, log: string,
 *   wrap?: string[]}} o
 * @returns {number} the child's pid
 */
function spawnDetachedRun({
	root,
	script,
	tester,
	log,
	wrap = probeUserScope(),
}) {
	fs.mkdirSync(path.dirname(log), { recursive: true });
	const fd = fs.openSync(log, "a");
	const env = buildCheckoutEnv(root);
	forgetSession(env);
	try {
		const run = [
			script,
			"run",
			...(tester === undefined ? [] : ["--tester", tester]),
		];
		/** @type {import("node:child_process").SpawnOptions} */
		const options = {
			cwd: root,
			env,
			detached: true,
			stdio: ["ignore", fd, fd],
		};
		const [cmd, ...pre] = wrap;
		if (cmd === undefined)
			fs.writeSync(
				fd,
				`${new Date().toISOString()} no user scope: the lander shares its starter's cgroup (#2956)\n`,
			);
		const child =
			cmd === undefined
				? spawn(process.execPath, run, options)
				: spawn(cmd, [...pre, process.execPath, ...run], options);
		if (child.pid === undefined) throw new Error(`could not start ${script}`);
		child.unref();
		return child.pid;
	} finally {
		fs.closeSync(fd);
	}
}

module.exports = {
	readWaitingQueueRefs,
	startLander,
	launcherName,
	spawnDetachedRun,
	landerLog,
	runStartLander,
};
