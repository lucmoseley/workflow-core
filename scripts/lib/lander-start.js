/*
 * lander-start.js — whether to start the queue lander, and the detached start
 * (#2405, spec #2261; #4458).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { reportOwner } = require("./session-id.js");
const { sleepSync } = require("./sleep-sync.js");
const { probeUserScope, spawnOutliving } = require("./user-scope.js");

/**
 * @typedef {object} StartDeps
 * @property {() => number|null} holder the live lander's pid, or null
 * @property {() => string[]} waiting the queue refs waiting on the remote
 * @property {() => string[]} owed the dropped refs whose drop is owed a
 *   decision: open, with no fix ticket
 * @property {() => number} spawnRun starts a detached queue lander,
 *   returning its pid
 */

/**
 * Starts a queue lander only where none runs and a queue ref waits or a drop
 * is owed a decision (#4950). Residual: two starts inside one lander's
 * startup both spawn, and the second exits on the lock; and while an owed
 * drop's owning session works, each start runs a lander that reads that and
 * ends.
 * @param {StartDeps} deps
 * @returns {{started: number, waiting: string[], owed: string[]}
 *   | {skipped: string}}
 */
function startLander({ holder, waiting, owed, spawnRun }) {
	const pid = holder();
	if (pid !== null)
		return { skipped: `a lander is already running (pid ${pid})` };
	const refs = waiting();
	const drops = owed();
	if (refs.length === 0 && drops.length === 0)
		return { skipped: "no queue ref waits and no drop is owed a decision" };
	return { started: spawnRun(), waiting: refs, owed: drops };
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
 * A session start's outliving launch strips the session id, so the starter is
 * read as the report owner (#4706).
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
 * `node <script> run [--tester <command>]` in `root`, through the outliving
 * launch with no report owner (#4706), appending its output to `log`, behind
 * `wrap`'s words — by default `probeUserScope`'s, which set no ceiling. It
 * runs as no session: under the starting one's id and root, admission counts
 * that session as itself, the fix tickets it files are claimed for it, and its
 * suite read the main checkout (#2410).
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
	try {
		const run = [
			script,
			"run",
			...(tester === undefined ? [] : ["--tester", tester]),
		];
		if (wrap.length === 0)
			fs.writeSync(
				fd,
				`${new Date().toISOString()} no user scope: the lander shares its starter's cgroup (#2956)\n`,
			);
		const child = spawnOutliving(process.execPath, run, {
			cwd: root,
			env: buildCheckoutEnv(root),
			stdio: ["ignore", fd, fd],
			owner: null,
			wrap,
		});
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
	runStartLander,
};
