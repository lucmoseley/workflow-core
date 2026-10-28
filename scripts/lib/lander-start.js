/*
 * lander-start.js — whether to start a lander, and the detached start
 * (#2405, spec #2261).
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { checkoutEnv } = require("./refill-repos.js");
const { forgetSession, fromEnv } = require("./session-id.js");
const { sleepSync } = require("./sleep-sync.js");
const { probeUserScope } = require("./user-scope.js");

const NOT_AHEAD = {
	equal: "landing equals main",
	behind: "landing is behind main",
	diverged: "landing and main have diverged",
};

/**
 * @typedef {object} StartDeps
 * @property {() => number|null} holder the live lander's pid, or null
 * @property {() => {landing: string|null,
 *   relation: import("./lander.js").Relation}} refs where the
 *   remote's `landing` stands against `main`
 * @property {() => number} spawnRun starts a detached lander, returning its pid
 */

/**
 * Starts a lander only where none runs and `landing` is ahead of `main`.
 * Residual: two starts inside one lander's startup both spawn, and the
 * second exits on the lock.
 * @param {StartDeps} deps
 * @returns {{started: number, landing: string} | {skipped: string}}
 */
function startLander({ holder, refs, spawnRun }) {
	const pid = holder();
	if (pid !== null)
		return { skipped: `a lander is already running (pid ${pid})` };
	const { landing, relation } = refs();
	if (landing === null) return { skipped: "the remote has no landing branch" };
	if (relation !== "ahead") return { skipped: NOT_AHEAD[relation] };
	return { started: spawnRun(), landing };
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

/**
 * `node <script> run [--tester <command>]` in `root`, in a session of its own
 * so no hook's process-group kill reaches it, appending its output to `log`,
 * behind `wrap`'s words; with none, the log says the lander shares its
 * starter's cgroup. It runs as no session: under the starting one's id and
 * root, admission counts that session as itself, the fix tickets it files are
 * claimed for it, and its suite read the shared tree (#2410).
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
	const env = checkoutEnv(root);
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
	startLander,
	launcherName,
	spawnDetachedRun,
	landerLog,
};
