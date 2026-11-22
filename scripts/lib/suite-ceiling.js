const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught, ignoreFailure } = require("./caught.js");
const { monotonicMs } = require("./clock.js");
const { pidAlive } = require("./arbiter-proc.js");
const { readEnvironVar } = require("./proc-environ.js");
const { procRoot, REAL_PROC } = require("./proc-root.js");
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js");

// #2667
const CEILING_MS = 840_000;
// #2729
const TARGET_MS = 180_000;
// #4283
const FILE_LIMIT_MS = 60_000;
// #3290 measured 1,497 s of file and setup time summed over a 343 s run at 5 workers
const BENCH_WORKERS = 5;
const PACKING = 1497 / (343 * BENCH_WORKERS);
// #5137
const SUITE_BUDGET_MS = TARGET_MS * WHOLE_SUITE_WORKERS * PACKING;
const BUDGET_ARMED_BY = null;
const CEILING_ENV = "WFC_SUITE_CEILING_MS";
const DEADLINE_ENV = "WFC_SUITE_DEADLINE_FILE";
const CEILING_LINE = "SUITE CEILING";
// #2702 guess
const SETTLE_MS = 10_000;

/** @param {number} ms */
function seconds(ms) {
	return ms < 10_000
		? `${(ms / 1000).toFixed(1)}s`
		: `${String(Math.round(ms / 1000))}s`;
}

/**
 * @param {string} what
 * @param {{ elapsed: number, ceiling: number }} run
 */
function ceilingHeadline(what, { elapsed, ceiling }) {
	return `${CEILING_LINE} — killed ${seconds(elapsed)} after ${what} spawned, at the ${seconds(ceiling)} ceiling (#2667)`;
}

const CEILING_CLOSE = [
	"Neither load nor output lifts the ceiling, and no setting raises it. No",
	"partial result counts: the run fails.",
];

/** @param {string} error */
const deadlineUnwritten = (error) =>
	`suite deadline not written (${error}) — a wrapper watching for it cannot back the ceiling up\n`;

/** @param {string} what @param {string} reason */
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

/**
 * @param {number} pgid
 * @param {NodeJS.Signals} [signal]
 * @returns {string|null}
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
 * @param {string} key
 * @param {(value: string) => boolean} doomed
 * @param {{ proc: string, self: number,
 *   kill: (pid: number, signal: NodeJS.Signals) => unknown }} options
 * @returns {{ killed: { pid: number, value: string }[], unkilled: string|null }}
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

/** @param {string} reason @param {string} [run] */
const carrierUnkilled = (reason, run = "this run") =>
	`a process of ${run} could not be killed (${reason}); it may still hold memory.\n`;

/** @param {number} pid @param {NodeJS.Signals} signal */
const killPid = (pid, signal) => process.kill(pid, signal);

/**
 * @param {string} key
 * @param {string} value
 * @param {{ proc?: string, self?: number,
 *   kill?: (pid: number, signal: NodeJS.Signals) => unknown }} [options]
 * @returns {string|null}
 */
function killCarrying(
	key,
	value,
	{ proc = procRoot(), self = process.pid, kill = killPid } = {},
) {
	return killWhere(key, (v) => v === value, { proc, self, kill }).unkilled;
}

const OWNER_ENV = "WFC_INFLIGHT_OWNER";
const KILL_PID_MAX = 2 ** 31 - 1;

/**
 * @param {{ proc?: string, self?: number, alive?: (pid: number) => boolean,
 *   kill?: (pid: number, signal: NodeJS.Signals) => unknown }} [options]
 * @returns {{ killed: { pid: number, owner: number }[], unkilled: string|null }}
 */
function sweepOrphanedRuns({
	proc = procRoot(),
	self = process.pid,
	alive = pidAlive,
	kill = killPid,
} = {}) {
	const { killed, unkilled } = killWhere(
		OWNER_ENV,
		(owner) =>
			/^\d+$/.test(owner) &&
			Number(owner) <= KILL_PID_MAX &&
			!alive(Number(owner)),
		{ proc, self, kill },
	);
	return {
		killed: killed.map(({ pid, value }) => ({ pid, owner: Number(value) })),
		unkilled,
	};
}

/**
 * @param {{ err?: { write: (s: string) => unknown } } & Parameters<typeof sweepOrphanedRuns>[0]} [options]
 */
function sweepAtStart({ err = process.stderr, ...options } = {}) {
	const { killed, unkilled } = sweepOrphanedRuns({
		proc: REAL_PROC,
		...options,
	});
	if (killed.length > 0)
		err.write(
			`killed ${String(killed.length)} process(es) left by a killed run (wrapper pid ${[...new Set(killed.map((k) => k.owner))].join(", ")}).\n`,
		);
	if (unkilled) err.write(carrierUnkilled(unkilled, "a killed run"));
}

/** @param {() => void} fire @param {number} ms @returns {() => void} */
function afterMs(fire, ms) {
	const timer = setTimeout(fire, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

/**
 * @param {{ pgid: number|undefined, ms: number, onCeiling: () => void,
 *   env?: NodeJS.ProcessEnv, now?: number, schedule?: typeof afterMs }} options
 * @returns {{ release: () => void, error: string|null }}
 */
function armCeiling({
	pgid,
	ms,
	onCeiling,
	env = process.env,
	now = monotonicMs(),
	schedule = afterMs,
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
	const cancel = schedule(onCeiling, ms);
	return {
		error,
		release: () => {
			cancel();
			if (!pgid) return;
			live.delete(pgid);
			if (file) ignoreFailure(() => fs.rmSync(file, { force: true }));
		},
	};
}

module.exports = {
	BUDGET_ARMED_BY,
	CEILING_CLOSE,
	CEILING_ENV,
	CEILING_LINE,
	CEILING_MS,
	DEADLINE_ENV,
	FILE_LIMIT_MS,
	OWNER_ENV,
	SETTLE_MS,
	SUITE_BUDGET_MS,
	TARGET_MS,
	armCeiling,
	ceilingHeadline,
	carrierUnkilled,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killCarrying,
	killGroup,
	killPid,
	sweepAtStart,
	sweepOrphanedRuns,
};
