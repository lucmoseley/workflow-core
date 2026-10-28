/*
 * suite-ceiling.js — the hard wall-clock ceiling on every suite run (#2680,
 * ruled at #2667: no run may hold the machine past 15 minutes, whatever its
 * load or output).
 *
 * THE CLOCK STARTS AT SPAWN. A run's queue wait, load hold and worktree setup
 * hold no worker, so they are not charged.
 *
 * LOWER ONLY. The environment may shorten the ceiling, for tests and short
 * runs. A value above it, zero or not a number leaves it in force.
 *
 * THE WHOLE GROUP. The run's process leads a group of its own, and the kill
 * signals the group, so every worker it forked dies with it. A group still
 * live when this process exits is killed with it. RESIDUAL: a SIGKILL to this
 * process cannot be caught and leaves the group running; the deadline file is
 * there for bg-run's backstop (#2704) to reach that case.
 *
 * AND EVERY PROCESS CARRYING THE RUN'S MARK (#3494). A worker that left the
 * group, its parent dead, is reparented to init where no group kill reaches
 * it.
 *
 * AND, FROM OUTSIDE, EVERY PROCESS OF A RUN WHOSE WRAPPER IS GONE (#3528). A
 * SIGKILLed wrapper runs no handler, so each run's processes carry its pid
 * too, and `sweepOrphanedRuns` kills those whose owner no longer exists.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readEnvironVar } = require("./proc-environ.js");
const { procRoot } = require("./proc-root.js");

/* 14 minutes, so bg-run's backstop at the deadline plus 60 s still lands
 * inside #2667's 15. */
const CEILING_MS = 840_000;
/* The target a green lone whole suite is held to (#2729): under 180 s, the
 * founder's ruling of 24 and 27 Oct 2026. The ceiling is the backstop, this is
 * the aim. `check-suite-margin.js` reports a run at or over it and refuses
 * nothing. RESIDUAL: a sharded whole suite (`fullTestShards`) is judged shard
 * by shard against this same figure, so shards each under it do not show the
 * lone whole suite is. */
const TARGET_MS = 180_000;
const CEILING_ENV = "WFC_SUITE_CEILING_MS";
/* Where a run writes `<deadline s> <pgid>`, one line, for bg-run's
 * `read -r` to take. The deadline is on CLOCK_MONOTONIC, the clock this
 * process's own timer counts on, so a host suspend that steps the wall clock
 * on resume moves neither (#2886). */
const DEADLINE_ENV = "WFC_SUITE_DEADLINE_FILE";
/* The first word of a ceiling kill's report, which the lander's tester and
 * the lost-verdict hand-back quote. */
const CEILING_LINE = "SUITE CEILING";
/* How long a killed run waits for `close` before settling without it: a
 * leader stuck in uninterruptible sleep, or a group the kill could not reach,
 * never sends one. Ten seconds is a guess, never measured: well past a kill's
 * own cost, short of leaving a session waiting on a run that will never
 * report. */
const SETTLE_MS = 10_000;

/** @param {number} ms */
function seconds(ms) {
	return ms < 10_000
		? `${(ms / 1000).toFixed(1)}s`
		: `${String(Math.round(ms / 1000))}s`;
}

/**
 * The kill report's first line, with no closing stop, so a wrapper may add
 * its own reading after it.
 * @param {string} what the process the clock started on, e.g. "pytest"
 * @param {{ elapsed: number, ceiling: number }} run
 */
function ceilingHeadline(what, { elapsed, ceiling }) {
	return `${CEILING_LINE} — killed ${seconds(elapsed)} after ${what} spawned, at the ${seconds(ceiling)} ceiling (#2667)`;
}

const CEILING_CLOSE = [
	"Neither load nor output lifts the ceiling, and no setting raises it. No",
	"partial result counts: the run fails.",
];

/** @param {string} error why `armCeiling` wrote no deadline file */
const deadlineUnwritten = (error) =>
	`suite deadline not written (${error}) — a wrapper watching for it cannot back the ceiling up\n`;

/** @param {string} what @param {string} reason why `killGroup` failed */
const groupUnkilled = (what, reason) =>
	`${what}'s process group could not be killed (${reason}); a worker may outlive this report.\n`;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function ceilingMs(env = process.env) {
	const n = Number(env[CEILING_ENV]);
	return Number.isFinite(n) && n > 0 && n < CEILING_MS ? n : CEILING_MS;
}

/** @type {Set<number>} */
const live = new Set();
/* Registered on the first group held, so a reader of CEILING_LINE alone adds
 * no exit listener. */
let exitArmed = false;
/** @param {number} pgid */
function hold(pgid) {
	live.add(pgid);
	if (exitArmed) return;
	exitArmed = true;
	process.on("exit", () => {
		for (const held of live) killGroup(held);
	});
}

/** CLOCK_MONOTONIC in ms, as `process.hrtime` reads it on Linux. */
const monotonicMs = () => Math.floor(Number(process.hrtime.bigint()) / 1e6);

/**
 * A group already gone is no failure.
 * @param {number} pgid
 * @param {NodeJS.Signals} [signal]
 * @returns {string|null} why the group may still be running, else null
 */
function killGroup(pgid, signal = "SIGKILL") {
	try {
		process.kill(-pgid, signal);
		return null;
	} catch (e) {
		return caught(e).code === "ESRCH" ? null : caught(e).message;
	}
}

/**
 * SIGKILLs every process but `self` whose environment sets `key` to a value
 * `doomed` accepts. An environ that will not read is no carrier, and one
 * already gone is no failure.
 * @param {string} key
 * @param {(value: string) => boolean} doomed
 * @param {{ proc: string, self: number,
 *   kill: (pid: number, signal: NodeJS.Signals) => unknown }} options
 * @returns {{ killed: { pid: number, value: string }[], unkilled: string|null }}
 *   `unkilled` is why a process may still be running, else null
 */
function killWhere(key, doomed, { proc, self, kill }) {
	let names;
	try {
		names = fs.readdirSync(proc);
	} catch (e) {
		return {
			killed: [],
			unkilled: `${proc} will not list: ${caught(e).message}`,
		};
	}
	/** @type {{ pid: number, value: string }[]} */
	const killed = [];
	let unkilled = null;
	for (const name of names) {
		const pid = Number(name);
		if (!/^\d+$/.test(name) || pid === self) continue;
		const read = readEnvironVar(pid, key, proc);
		if (!read.ok || read.value === null || !doomed(read.value)) continue;
		try {
			kill(pid, "SIGKILL");
			killed.push({ pid, value: read.value });
		} catch (e) {
			if (caught(e).code !== "ESRCH") unkilled ??= caught(e).message;
		}
	}
	return { killed, unkilled };
}

/** @param {string} reason why a carrier kill failed */
const carrierUnkilled = (reason) =>
	`a process of this run could not be killed (${reason}); it may outlive this report.\n`;

/**
 * SIGKILLs every process whose environment sets `key` to `value`, but `self`,
 * which may carry it too.
 * @param {string} key
 * @param {string} value
 * @param {{ proc?: string, self?: number,
 *   kill?: (pid: number, signal: NodeJS.Signals) => unknown }} [options]
 * @returns {string|null} why a process may still be running, else null
 */
function killCarrying(
	key,
	value,
	{
		proc = procRoot(),
		self = process.pid,
		kill = (pid, signal) => process.kill(pid, signal),
	} = {},
) {
	return killWhere(key, (v) => v === value, { proc, self, kill }).unkilled;
}

/* Names the wrapper pid whose run a process belongs to. */
const OWNER_ENV = "WFC_INFLIGHT_OWNER";

/** @param {number} pid @returns {boolean} whether `pid` still exists */
function exists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return caught(e).code !== "ESRCH";
	}
}

/**
 * SIGKILLs every process but `self` whose OWNER_ENV names a pid that no
 * longer exists. The owner is asked by signal, never by `proc`'s listing, so
 * a fixture root that leaves a live owner out kills nothing of its.
 * RESIDUAL: an owner pid already recycled, or a zombie, reads as live, so its
 * run's processes wait for a sweep after that pid ends.
 * @param {{ proc?: string, self?: number, alive?: (pid: number) => boolean,
 *   kill?: (pid: number, signal: NodeJS.Signals) => unknown }} [options]
 * @returns {{ killed: { pid: number, owner: number }[], unkilled: string|null }}
 *   `unkilled` is why a process may still be running, else null
 */
function sweepOrphanedRuns({
	proc = procRoot(),
	self = process.pid,
	alive = exists,
	kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
	const { killed, unkilled } = killWhere(
		OWNER_ENV,
		(owner) => /^\d+$/.test(owner) && !alive(Number(owner)),
		{ proc, self, kill },
	);
	return {
		killed: killed.map(({ pid, value }) => ({ pid, owner: Number(value) })),
		unkilled,
	};
}

/**
 * A run whose wrapper was SIGKILLed ran no handler, so its workers wait for
 * the next run's start, or the next session's (#3528).
 * @param {{ err?: { write: (s: string) => unknown } } & Parameters<typeof sweepOrphanedRuns>[0]} [options]
 */
function sweepAtStart({ err = process.stderr, ...options } = {}) {
	/* Its kills are real, so never from an inherited fixture root. */
	const { killed, unkilled } = sweepOrphanedRuns({ proc: "/proc", ...options });
	if (killed.length > 0)
		err.write(
			`killed ${String(killed.length)} process(es) left by a killed run (wrapper pid ${[...new Set(killed.map((k) => k.owner))].join(", ")}).\n`,
		);
	if (unkilled)
		err.write(
			`a killed run's process could not be killed (${unkilled}); it may still hold memory.\n`,
		);
}

/**
 * Start the ceiling on `pgid`, the leader of a group spawned with
 * `detached: true`: write the deadline where the environment names a file,
 * hold the group for the exit-time kill, and call `onCeiling` once the
 * ceiling passes. The timer never by itself keeps this process alive.
 *
 * `release` stops the timer, drops the deadline file and the group's hold;
 * call it once the run has closed.
 *
 * @param {{ pgid: number|undefined, ms: number, onCeiling: () => void,
 *   env?: NodeJS.ProcessEnv, now?: number }} options `now` is CLOCK_MONOTONIC ms
 * @returns {{ release: () => void, error: string|null }}
 *   `error` is why the deadline file was not written, else null
 */
function armCeiling({
	pgid,
	ms,
	onCeiling,
	env = process.env,
	now = monotonicMs(),
}) {
	const deadline = now + ms;
	const file = env[DEADLINE_ENV] || null;
	let error = null;
	if (pgid) {
		hold(pgid);
		if (file)
			try {
				writeFileAtomic(
					file,
					`${String(Math.ceil(deadline / 1000))} ${String(pgid)}\n`,
				);
			} catch (e) {
				error = caught(e).message;
			}
	}
	const timer = setTimeout(onCeiling, ms);
	timer.unref?.();
	return {
		error,
		release: () => {
			clearTimeout(timer);
			if (!pgid) return;
			live.delete(pgid);
			if (file)
				try {
					fs.rmSync(file, { force: true });
				} catch {
					/* A stale deadline names a dead group, which bg-run's kill
					 * finds already gone. */
				}
		},
	};
}

module.exports = {
	CEILING_CLOSE,
	CEILING_ENV,
	CEILING_LINE,
	CEILING_MS,
	DEADLINE_ENV,
	OWNER_ENV,
	SETTLE_MS,
	TARGET_MS,
	armCeiling,
	ceilingHeadline,
	carrierUnkilled,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killCarrying,
	killGroup,
	monotonicMs,
	sweepAtStart,
	sweepOrphanedRuns,
};
