/*
 * suite-ladder.js — docs/environment.md §6's suite-concurrency ladder and the
 * reading of the suites `ps` shows running: one copy, for lib/admission.js and
 * lib/suite-concurrency.js, the guard. Kept apart from admission.js, which
 * costs a hook ~65 ms to load.
 */

const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { requiredGroup } = require("./regex-group.js");
const {
	WHOLE_SUITE_WORKERS,
	isVitestWatchLine,
	vitestLineWeigh,
} = require("./suite-bounded.js");

/* Above earlyoom's kill line, ruled at #2221: the suite gate's margin, fitted,
 * not measured (mantahostels#463). */
const DRAW_MARGIN_MB = 300;

/*
 * earlyoom's kill line: 8% free of the 10 GB cap, ≈ 794 MiB (docs/environment.md
 * §3). Admission keeps it, and DRAW_MARGIN_MB above it, free (#337, #2221).
 */
const EARLYOOM_FLOOR_MB = 794;

/*
 * Concurrent test suites, owned by `docs/environment.md` §6. THE LADDER IS THE
 * WHOLE RULE — there is no flat allowance above it.
 *
 * A rung is rungMb of the dip that many vitest workers make. SUITE_DIP_MB is
 * §6's dip at 0-3 suites of LADDER_SUITE_WORKERS workers each, the count #1603
 * measured them at; w workers sit w/LADDER_SUITE_WORKERS of the way to the
 * next suite's dip. SUITE_MAX is the most suites measured (mantahostels#462,
 * mantahostels#954); past it each worker adds the one-suite dip's share of one
 * worker — EXTRAPOLATED.
 */
const SUITE_MAX = 3;
/*
 * How many whole suites run at once, machine-wide: one (#2680). The queue's
 * turn and the guard's count cap both stop at it; SUITE_MAX stays the ladder's
 * top, pricing memory rungs and session admission.
 */
const WHOLE_SUITE_MAX = 1;
const LADDER_SUITE_WORKERS = 3;
const SUITE_DIP_MB = [0, 1046, 2124, 2546];

/**
 * The memory rung for a workload that draws `chargeMb`: EARLYOOM_FLOOR_MB +
 * the draw + DRAW_MARGIN_MB, rounded up to the next 50 MB (#2558).
 * @param {number} chargeMb
 */
const rungMb = (chargeMb) =>
	Math.ceil((EARLYOOM_FLOOR_MB + chargeMb + DRAW_MARGIN_MB) / 50) * 50;

/**
 * MB of available that must be resting before `workers` concurrent vitest
 * workers run.
 * @param {number} workers
 */
function suiteRungMb(workers) {
	const dipAt = (/** @type {number} */ suites) => {
		const mb = SUITE_DIP_MB[suites];
		if (mb === undefined)
			throw new RangeError(`no measured dip at ${suites} suites`);
		return mb;
	};
	const n = Math.floor(workers / LADDER_SUITE_WORKERS);
	const dip =
		n >= SUITE_MAX
			? dipAt(SUITE_MAX) +
				Math.ceil(
					((workers - SUITE_MAX * LADDER_SUITE_WORKERS) * dipAt(1)) /
						LADDER_SUITE_WORKERS,
				)
			: dipAt(n) +
				Math.ceil(
					((workers % LADDER_SUITE_WORKERS) * (dipAt(n + 1) - dipAt(n))) /
						LADDER_SUITE_WORKERS,
				);
	return rungMb(dip);
}

const SUITE_RESTING_MB = {
	1: suiteRungMb(LADDER_SUITE_WORKERS),
	2: suiteRungMb(2 * LADDER_SUITE_WORKERS),
	3: suiteRungMb(3 * LADDER_SUITE_WORKERS),
};
const SUITE_GATE_MB = SUITE_RESTING_MB[SUITE_MAX];

/*
 * The suite the ladder above was measured on — its fourth invalidating
 * variable, beside vitest's `maxWorkers`, the 2048 MB heap and the core count
 * (mantahostels#954).
 *
 * `scripts/check-suite-size-drift.js` reads it and warns when the live suite has
 * drifted. MOVE IT ONLY WITH A RE-MEASUREMENT.
 */
const SUITE_LADDER_MEASURED_AT = {
	files: 485,
	tests: 19_646,
	issue: "workflow-core#1603",
	date: "16 Oct 2026",
};

/* A `vitest list` is no suite (#1180): it is run-vitest.js's selection probe
 * and runs no tests. Only `list` first after the binary: a later one may be a
 * `-t list` filter on a real run. */
const VITEST_LIST = /[.]bin\/vitest list( |$)/;

/*
 * A line whose argv[0] is a shell or one of shell-words.js's `unwrap`
 * wrappers (#1127): the Bash tool's own `bash -c …` line and a `timeout 300
 * node_modules/.bin/vitest run` line both carry `.bin/vitest`, so one run
 * would read as three. That costs no under-count: an exec'ing wrapper
 * (`nohup`, `env`) leaves no line of its own, and a forking one (`timeout`,
 * `sudo`) leaves the runner's. A shell or wrapper off the list (`fish`,
 * `flock`, `taskset`) still adds a line.
 */
const WRAPPER_ARGV0 =
	/^ *-?([^ ]*\/)?(bash|sh|dash|zsh|nohup|setsid|env|timeout|time|command|stdbuf|nice|ionice|xargs|sudo)( |$)/;

/*
 * MATCHES THE RUNNER PATH, NOT THE WORDS. One suite puts THREE kinds of line in
 * `ps -eo args`, and only the middle one is one-per-suite:
 *
 *   sh -c NODE_OPTIONS=... vitest run          the npm wrapper — same suite again
 *   node .../node_modules/.bin/vitest run      the runner, one per suite
 *   node .../vitest/dist/workers/forks.js      one per worker, so maxWorkers of them
 *
 * THE `run` IS NOT PART OF THE ANCHOR (mantahostels#1927): `test:watch` is
 * `vitest` with no subcommand, so an open watcher's runner line ENDS at the
 * binary.
 *
 * Any command line that merely NAMES the binary — `less .../.bin/vitest` — is
 * counted as a suite as well. Tightening the anchor to the runner alone would
 * buy an UNDER-count in exchange, the direction §6's asymmetry says costs an
 * earlyoom kill rather than a false warning.
 */
const VITEST_RUNNER = /[.]bin\/vitest( |$)/;

/**
 * @typedef {object} Running
 * @property {number} total the runs going
 * @property {number} watchers how many of them are vitest watchers
 * @property {number} whole how many are whole suites
 * @property {number} workers the vitest workers they can occupy between them
 */

/**
 * One `ps -eo pid=,args=` line: its pid, null on a line that opens with none,
 * and its args.
 * @typedef {{ pid: number | null, args: string }} PsRow
 */

/**
 * The test runs a `ps` listing shows (mantahostels#1906, #2560). A vitest run
 * weighs what `carriedOf` reads for its pid, the weight its launch record
 * carries (#2931), else the workers its runner line names, as a launch does
 * (#2559); a watcher, which holds a rung for as long as it is open
 * (mantahostels#1927), weighs a whole suite. Only a whole run counts toward
 * WHOLE_SUITE_MAX; a part-suite adds to the memory rung alone. Residual: `ps`
 * drops the quoting, so an unrecorded run's `-t "a b"` value's second word
 * reads as a filter and the run as whole.
 *
 * `isOther` counts a line as a whole one-shot of a non-vitest runner
 * (#330); admission's reap counts vitest alone, the under-count only ever
 * pointing it at a lower rung (#627).
 *
 * An EMPTY listing counts as zero: `readPs` rejects an empty or failed read.
 * @param {PsRow[]} rows
 * @param {(words: string[]) => boolean} [isOther]
 * @param {(pid: number | null) => import("./suite-handoff.js").CarriedWeight | null} [carriedOf]
 * @returns {Running}
 */
function runningSuites(rows, isOther, carriedOf = () => null) {
	const running = { total: 0, watchers: 0, whole: 0, workers: 0 };
	for (const { pid, args: line } of rows) {
		if (
			VITEST_RUNNER.test(line) &&
			!WRAPPER_ARGV0.test(line) &&
			!VITEST_LIST.test(line)
		) {
			running.total++;
			if (isVitestWatchLine(line)) running.watchers++;
			const run = vitestLineWeigh(line, carriedOf(pid));
			running.workers += run.workers;
			if (!run.part) running.whole++;
		}
		const words = line.trim().split(/\s+/).filter(Boolean);
		if (isOther && words.length > 0 && isOther(words)) {
			running.total++;
			running.whole++;
			running.workers += WHOLE_SUITE_WORKERS;
		}
	}
	return running;
}

/**
 * The weight process `pid`'s launch record carries, off WFC_PROC's
 * `<pid>/environ` (#2931).
 * @param {number | null} pid
 */
const readCarriedWeightOf = (pid) =>
	require("./suite-handoff.js").readCarriedWeight(
		pid,
		process.env.WFC_PROC || "/proc",
	);

const PS_PID_LINE = /^\s*(\d+)\s(.*)$/;

/**
 * @param {string} text a `ps -eo pid=,args=` listing
 * @returns {PsRow[]}
 */
function parsePsRows(text) {
	return text.split("\n").map((line) => {
		const m = PS_PID_LINE.exec(line);
		return m
			? {
					pid: Number(requiredGroup(m, 1, PS_PID_LINE)),
					args: requiredGroup(m, 2, PS_PID_LINE),
				}
			: { pid: null, args: line };
	});
}

/* A hung `ps` would otherwise hold the suite it runs ahead of. Its 5 s is a
 * guess, never measured. */
const PS_TIMEOUT_MS = 5000;
const PS_BIN = () => process.env.WFC_PS || "ps";

/**
 * `ps -eo pid=,args=` at WFC_PS, the one read admission and the suite guard
 * count by. A listing of no process at all, itself included, is broken, not
 * idle.
 * @returns {{ ok: true, rows: PsRow[] } | { ok: false, error: string }}
 */
function readPs() {
	const r = spawnSync(PS_BIN(), ["-eo", "pid=,args="], {
		encoding: "utf8",
		timeout: PS_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error) return { ok: false, error: r.error.message };
	if (r.status !== 0)
		return {
			ok: false,
			error:
				r.stderr.trim().split("\n").pop() ||
				(r.signal ? `ps killed by ${r.signal}` : `ps exited ${r.status}`),
		};
	if (!r.stdout.trim()) return { ok: false, error: "ps listed nothing" };
	return { ok: true, rows: parsePsRows(r.stdout) };
}

module.exports = {
	PS_BIN,
	DRAW_MARGIN_MB,
	EARLYOOM_FLOOR_MB,
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	LADDER_SUITE_WORKERS,
	SUITE_DIP_MB,
	rungMb,
	suiteRungMb,
	SUITE_RESTING_MB,
	SUITE_GATE_MB,
	SUITE_LADDER_MEASURED_AT,
	WRAPPER_ARGV0,
	runningSuites,
	readCarriedWeightOf,
	readPs,
};
