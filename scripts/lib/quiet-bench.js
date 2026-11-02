/*
 * quiet-bench.js — the core of the refill loop's route to a quiet-gated
 * measurement (#3852): with the founder absent and the measurement due, the loop
 * pauses its launches, starts the bench outside every session once the fleet has
 * drained, keeps its rows and lifts the pause on every ending. No I/O here:
 * lib/quiet-bench-runs.js keeps the runs,
 * lib/quiet-bench-tick.js does a tick's reads and writes, and
 * scripts/quiet-bench-run.js is the runner.
 */

const path = require("node:path");
const { QUIET_BENCH_PAUSE } = require("./refill-decide.js");
const {
	SUITE_LADDER_MEASURED_AT,
	SUITE_RESTING_MB,
} = require("./suite-ladder.js");

/* #2862's acceptance: two rows per count, interleaved. */
const COUNTS = [1, 2, 3];
const ROWS_PER_COUNT = 2;
/* The bar the bench's `--require-quiet` refuses above. */
const QUIET_SESSIONS = 3;

const LADDER_BENCH = {
	issue: 2862,
	script: path.join("scripts", "bench_suite_concurrency.py"),
	args: [
		...Array.from({ length: ROWS_PER_COUNT }, () => COUNTS.map(String)).flat(),
		`--require-quiet=${QUIET_SESSIONS}`,
	],
	/* Its first row is one suite at its default three workers. */
	startMb: SUITE_RESTING_MB[1],
};

/* Which ladder a run measured: a run kept from before a restate satisfies no
 * later drift. */
const LADDER_STAMP = `${SUITE_LADDER_MEASURED_AT.files} files, ${SUITE_LADDER_MEASURED_AT.date}`;

const ATTEMPT_EVERY_MS = 24 * 60 * 60 * 1000;
/* #3852's brief: the two readings a start needs. A longer gap between readings,
 * as a stopped loop leaves, starts them over. */
const READINGS_APART_MS = 5 * 60 * 1000;
/* Untraced: a margin over the 160 min p90 of the loop's finished launches
 * (#3852). */
const DRAIN_LIMIT_MS = 4 * 60 * 60 * 1000;
/* Untraced: a margin over a warm-up and twelve suites one after another, each at
 * the 14-minute ceiling (docs/environment.md), about 3 h. Past it the runner is
 * stopped, as a wedged one reads alive for ever. */
const RUN_LIMIT_MS = 4 * 60 * 60 * 1000;
/* A guess: the due read costs about 3 s and a `gh` call, on a condition that
 * moves only with a re-measurement. */
const DUE_READ_EVERY_MS = 60 * 60 * 1000;
/* A guess: a tick soon after the start can precede the runner's pidfile. */
const RUNNER_START_GRACE_MS = 30 * 1000;

const HOLD_DRAINING = `#${LADDER_BENCH.issue}'s bench is due, so launches wait for ${QUIET_SESSIONS} or fewer sessions and ${LADDER_BENCH.startMb} MB available`;
const HOLD_RUNNING = `#${LADDER_BENCH.issue}'s bench is running outside every session`;

/**
 * @typedef {object} BenchState
 * @property {number|null} attemptAt ms, when the last hold was taken
 * @property {"drain"|"run"|null} phase
 * @property {number|null} since ms, when this phase began
 * @property {number|null} quietSince ms, the first of the unbroken quiet readings
 * @property {number|null} quietAt ms, the last of them
 * @property {{at: number, value: boolean}|null} due the last due read
 */

/** @type {BenchState} */
const IDLE_STATE = {
	attemptAt: null,
	phase: null,
	since: null,
	quietSince: null,
	quietAt: null,
	due: null,
};

/** @typedef {{sessions: number|null, availableMb: number|null}} QuietReading */

/**
 * @typedef {object} BenchTick
 * @property {number} now ms
 * @property {boolean} off the route's setting is off, or no served checkout
 *   holds the bench
 * @property {boolean} present the founder reads present, as away mode reads him
 * @property {import("./refill-decide.js").Pause} [paused]
 * @property {BenchState} state
 * @property {() => boolean} readDue
 * @property {() => QuietReading} readQuiet
 * @property {(since: number) => {alive: boolean, ended: string|null}} readRunner
 *   `ended`, how the run begun since `since` ended, null where it left no result
 */

/**
 * @typedef {{state: BenchState, hold?: "take"|"lift"|"running", start?: true,
 *   stop?: true, line?: string}} BenchStep `state` holds once the hold's change
 *   is written; `stop`, the runner is to be stopped
 */

/** @param {QuietReading} reading */
const isQuiet = ({ sessions, availableMb }) =>
	sessions !== null &&
	availableMb !== null &&
	sessions <= QUIET_SESSIONS &&
	availableMb >= LADDER_BENCH.startMb;

/**
 * @param {BenchState} state
 * @param {boolean} ours
 * @param {string} line
 * @returns {BenchStep}
 */
const buildEnded = (state, ours, line) => ({
	state: { ...IDLE_STATE, attemptAt: state.attemptAt, due: state.due },
	...(ours ? { hold: /** @type {const} */ ("lift") } : {}),
	line,
});

/**
 * Why the route may not hold launches now, null where it may.
 * @param {BenchTick} tick
 */
const buildLeaveWhy = ({ off, present }) => {
	if (off) return "the route is off";
	return present ? "the founder is back" : null;
};

/**
 * A running bench: its rows refuse by themselves once launches are back, so a
 * founder's return lifts the hold and leaves the runner.
 * @param {BenchTick} tick
 * @returns {BenchStep}
 */
function decideRunning(tick) {
	const { now, state, paused } = tick;
	const ours = paused?.by === QUIET_BENCH_PAUSE;
	const since = state.since ?? 0;
	const { alive, ended } = tick.readRunner(since);
	if (!alive && now - since >= RUNNER_START_GRACE_MS)
		return buildEnded(
			state,
			ours,
			`bench ended: ${ended ?? "its runner died with no result"}`,
		);
	if (now - since >= RUN_LIMIT_MS)
		return {
			state,
			stop: true,
			...(ours
				? {
						hold: /** @type {const} */ ("lift"),
						line: "hold lifted: the bench reached its limit, its runner stopped",
					}
				: {}),
		};
	const leave = buildLeaveWhy(tick);
	return ours && leave
		? { state, hold: "lift", line: `hold lifted: ${leave}; the bench runs on` }
		: { state };
}

/**
 * @param {BenchTick} tick
 * @returns {BenchStep}
 */
function decideDrain(tick) {
	const { now, state, paused } = tick;
	if (paused?.by !== QUIET_BENCH_PAUSE)
		return buildEnded(state, false, "drain ended: its pause was replaced");
	const leave = buildLeaveWhy(tick);
	if (leave) return buildEnded(state, true, `drain ended: ${leave}`);
	if (now - (state.since ?? now) >= DRAIN_LIMIT_MS)
		return buildEnded(state, true, "drain ended: it reached its limit");
	if (!isQuiet(tick.readQuiet()))
		return { state: { ...state, quietSince: null, quietAt: null } };
	const unbroken =
		state.quietAt !== null && now - state.quietAt <= READINGS_APART_MS;
	const quietSince = unbroken ? (state.quietSince ?? now) : now;
	return now - quietSince >= READINGS_APART_MS
		? {
				state: {
					...state,
					phase: "run",
					since: now,
					quietSince: null,
					quietAt: null,
				},
				hold: "running",
				start: true,
				line: "bench started",
			}
		: { state: { ...state, quietSince, quietAt: now } };
}

/**
 * The reads are ports, as each costs something and
 * most ticks reach none.
 * @param {BenchTick} tick
 * @returns {BenchStep}
 */
function decideQuietBench(tick) {
	const { now, state, paused } = tick;
	if (state.phase === "run") return decideRunning(tick);
	if (state.phase === "drain") return decideDrain(tick);
	if (paused?.by === QUIET_BENCH_PAUSE)
		return buildEnded(state, true, "its pause had no run behind it");
	if (paused || buildLeaveWhy(tick)) return { state };
	if (state.attemptAt !== null && now - state.attemptAt < ATTEMPT_EVERY_MS)
		return { state };
	const due =
		state.due && now - state.due.at < DUE_READ_EVERY_MS
			? state.due
			: { at: now, value: tick.readDue() };
	return due.value
		? {
				state: {
					...IDLE_STATE,
					attemptAt: now,
					phase: "drain",
					since: now,
					due,
				},
				hold: "take",
				line: "launches paused: the bench is due and the founder absent",
			}
		: { state: { ...state, due } };
}

/**
 * The state file's fields; anything unreadable reads as idle, whose next tick
 * lifts a pause left behind it.
 * @param {unknown} raw
 * @returns {BenchState}
 */
function parseBenchState(raw) {
	if (typeof raw !== "object" || raw === null) return IDLE_STATE;
	const r = /** @type {Record<string, unknown>} */ (raw);
	const numberOf = (/** @type {unknown} */ v) =>
		typeof v === "number" ? v : null;
	const due = /** @type {Record<string, unknown>|null} */ (r.due);
	return {
		attemptAt: numberOf(r.attemptAt),
		phase: r.phase === "drain" || r.phase === "run" ? r.phase : null,
		since: numberOf(r.since),
		quietSince: numberOf(r.quietSince),
		quietAt: numberOf(r.quietAt),
		due:
			typeof due?.at === "number" && typeof due.value === "boolean"
				? { at: due.at, value: due.value }
				: null,
	};
}

/* The runner, by the name its pidfile's holder runs (lib/pid-lock.js). */
const BENCH_RUNNER = "quiet-bench-run.js";

/**
 * @typedef {{suites?: number, skipped_below_floor?: boolean,
 *   skipped_not_quiet?: boolean, aborted_by_watchdog?: boolean,
 *   baseline_stationary?: boolean, wall_s?: number, sessions_live?: number,
 *   avail_rest_mb?: number, avail_min_mb?: number, avail_dip_mb?: number,
 *   dip_attributable_mb?: number, all_green?: boolean}} BenchRow
 *   the bench's `results.json` fields read here
 */

/**
 * @typedef {{id: string, dir: string, rows: BenchRow[], ladder: string|null}} KeptRun
 */

/**
 * @typedef {{label: string, availableMb: string|null, totalMb: string|null,
 *   swapUsedMb: string|null, load1: number|null}} MachineReading
 */

/**
 * A row #2862 may quote: run green to its end on a baseline that held still.
 * @param {BenchRow} row
 */
const isUsableRow = (row) =>
	!row.skipped_below_floor &&
	!row.skipped_not_quiet &&
	!row.aborted_by_watchdog &&
	row.baseline_stationary === true &&
	row.all_green === true;

/**
 * @param {BenchRow[]} rows
 * @returns {Map<number, number>}
 */
function countUsableRows(rows) {
	const counts = new Map(COUNTS.map((n) => [n, 0]));
	for (const row of rows)
		if (row.suites !== undefined && isUsableRow(row))
			counts.set(row.suites, (counts.get(row.suites) ?? 0) + 1);
	return counts;
}

/** @param {BenchRow[]} rows */
const isRunComplete = (rows) =>
	COUNTS.every((n) => (countUsableRows(rows).get(n) ?? 0) >= ROWS_PER_COUNT);

/**
 * Whether a kept run already answers the ladder as it stands.
 * @param {KeptRun} run
 */
const isRunAnswering = ({ ladder, rows }) =>
	ladder === LADDER_STAMP && isRunComplete(rows);

/**
 * The reading #2862's gate prints: each run of the ladder as it stands, with its
 * usable rows per count, so it changes only when a run keeps a new one.
 * @param {KeptRun[]} runs
 */
function buildRowsReading(runs) {
	const withRows = runs.filter(
		({ rows, ladder }) => ladder === LADDER_STAMP && rows.some(isUsableRow),
	);
	if (withRows.length === 0) return "no usable bench rows kept";
	return withRows
		.map(({ id, rows }) => {
			const counts = [...countUsableRows(rows)]
				.map(([n, have]) => `${n}:${have}`)
				.join(" ");
			return `${id}: usable rows per suite count ${counts}${isRunComplete(rows) ? ", complete" : ""}`;
		})
		.join("\n");
}

/**
 * `free -m`'s available, total and swap used.
 * @param {string} text
 */
function parseFree(text) {
	const mem = /^Mem:\s+(.*)$/m.exec(text)?.[1]?.split(/\s+/) ?? [];
	const swap = /^Swap:\s+(.*)$/m.exec(text)?.[1]?.split(/\s+/) ?? [];
	return {
		availableMb: mem.at(-1) ?? null,
		totalMb: mem[0] ?? null,
		swapUsedMb: swap[1] ?? null,
	};
}

/**
 * How a run ended, for its comment and the tick's log line.
 * @param {number|null} status
 * @param {string|null} signal
 * @param {string} tail the bench log's last line
 */
function buildEnding(status, signal, tail) {
	if (signal) return `killed by ${signal}`;
	return status === 0 ? "finished" : `exit ${status}: ${tail}`;
}

/** @param {BenchRow} row */
function buildWallText(row) {
	if (row.skipped_not_quiet) return "skipped: not quiet";
	if (row.skipped_below_floor) return "skipped: below the floor";
	return `${row.wall_s} s`;
}

/** @param {BenchRow[]} rows */
function buildRowsTable(rows) {
	if (rows.length === 0) return "No rows.";
	const lines = rows.map((r, i) =>
		[
			i + 1,
			r.suites,
			buildWallText(r),
			r.avail_rest_mb,
			r.avail_min_mb,
			r.avail_dip_mb,
			r.dip_attributable_mb,
			r.baseline_stationary,
			r.aborted_by_watchdog,
			r.all_green,
			r.sessions_live,
		].join(" | "),
	);
	return [
		"| Row | Suites | Wall | Rest MB | Min MB | Dip MB | Attributable MB | Stationary | Aborted | Green | Sessions |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...lines.map((l) => `| ${l} |`),
	].join("\n");
}

/**
 * @param {KeptRun & {ending: string, machine: MachineReading[]}} run
 */
const buildRunComment = ({ id, dir, ending, rows, machine }) =>
	[
		`**Quiet bench run ${id}** (the refill loop's route, #3852): ${ending}. Kept at \`${dir}\`.`,
		"",
		buildRowsTable(rows),
		"",
		"`free -m` and load1 beside them:",
		"",
		...machine.map(
			(m) =>
				`- ${m.label}: available ${m.availableMb} MB of ${m.totalMb}, swap used ${m.swapUsedMb} MB, load1 ${m.load1}`,
		),
	].join("\n");

module.exports = {
	BENCH_RUNNER,
	HOLD_DRAINING,
	HOLD_RUNNING,
	LADDER_BENCH,
	LADDER_STAMP,
	buildEnding,
	buildRowsReading,
	buildRunComment,
	decideQuietBench,
	isRunAnswering,
	parseBenchState,
	parseFree,
};
