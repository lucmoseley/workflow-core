/*
 * suite-ceiling.js — the hard wall-clock ceiling on every suite run (workflow-core#2680,
 * ruled at workflow-core#2667: no run may hold the machine past 15 minutes, whatever its
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
 * there for bg-run's backstop (workflow-core#2704) to reach that case.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");

/* 14 minutes, so bg-run's backstop at the deadline plus 60 s still lands
 * inside workflow-core#2667's 15. */
const CEILING_MS = 840_000;
/* The margin a green whole suite is held to (workflow-core#2729): 80% of the
 * ceiling, UNTRACED (workflow-core#2729 §Values). It buys warning, not safety: the suite
 * grew 23% in the week workflow-core#2729 measured, more than this margin.
 * `check-suite-margin.js` reports a run over it and refuses nothing. */
const TARGET_FRACTION = 0.8;
const TARGET_MS = CEILING_MS * TARGET_FRACTION;
const CEILING_ENV = "WFC_SUITE_CEILING_MS";
/* Where a run writes `<deadline s> <pgid>`, one line, for bg-run's
 * `read -r` to take. The deadline is on CLOCK_MONOTONIC, the clock this
 * process's own timer counts on, so a host suspend that steps the wall clock
 * on resume moves neither (workflow-core#2886). */
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
	return `${CEILING_LINE} — killed ${seconds(elapsed)} after ${what} spawned, at the ${seconds(ceiling)} ceiling (workflow-core#2667)`;
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
	SETTLE_MS,
	TARGET_FRACTION,
	TARGET_MS,
	armCeiling,
	ceilingHeadline,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killGroup,
	monotonicMs,
};
