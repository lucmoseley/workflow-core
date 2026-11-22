const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { requiredGroup } = require("./regex-group.js");
const { hasNamedTestFiles } = require("./suite-launch.js");
const {
	WHOLE_SUITE_WORKERS,
	isVitestWatchLine,
	vitestLineWeigh,
} = require("./suite-bounded.js");

// #2221 guess
const DRAW_MARGIN_MB = 300;

// #2221
const EARLYOOM_FLOOR_MB = 794;

// #2862
const SUITE_MAX = 3;
// #2680
const WHOLE_SUITE_MAX = 1;
const LADDER_SUITE_WORKERS = 3;
// lucmoseley/mantahostels#462 measured lower bounds at 0-3 suites of LADDER_SUITE_WORKERS workers
const SUITE_DIP_MB = [0, 1582, 2550, 3576];

/** @param {number} chargeMb */
const rungMb = (chargeMb) =>
	Math.ceil((EARLYOOM_FLOOR_MB + chargeMb + DRAW_MARGIN_MB) / 50) * 50;

/**
 * @typedef {{ rungMb: number, ladderMb?: number }} Reach
 * @param {number} rung
 * @param {number | null} totalMb
 * @returns {Reach}
 */
function reachableRung(rung, totalMb) {
	if (totalMb === null) return { rungMb: rung };
	const ceiling = totalMb - EARLYOOM_FLOOR_MB;
	return rung > ceiling
		? { rungMb: ceiling, ladderMb: rung }
		: { rungMb: rung };
}

/** @param {number | undefined} ladderMb */
const clampedClause = (ladderMb) =>
	ladderMb === undefined
		? ""
		: ` (clamped from ~${ladderMb} MB, out of the machine's reach: past MemTotal less earlyoom's line)`;

/** @param {number} workers */
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

const SUITE_LADDER_MEASURED_AT = {
	files: 818,
	lowerBound: {
		ceilingS: 840,
		reachedMin: 77,
		reachedMax: 101,
	},
	issue: "workflow-core#2862",
	date: "3 Nov 2026",
};

const VITEST_LIST = /[.]bin\/vitest list( |$)/;

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

/** @param {string} line */
const isVitestRunnerLine = (line) =>
	VITEST_RUNNER.test(line) &&
	!WRAPPER_ARGV0.test(line) &&
	!VITEST_LIST.test(line);

/** @param {"build" | "dev"} sub @param {string} line */
function isNextRunnerLine(sub, line) {
	const title = sub === "build" ? "^ *next-build \\(v|" : "";
	return (
		new RegExp(`${title}([.]bin|/dist/bin)/next ${sub}( |$)`).test(line) &&
		!WRAPPER_ARGV0.test(line)
	);
}

/**
 * @typedef {object} Running
 * @property {number} total
 * @property {number} watchers
 * @property {number} whole
 * @property {number} workers
 */

/** @typedef {{ pid: number | null, args: string }} PsRow */

/**
 * @typedef {{ count: number, part: number, under: (pid: number | null) => boolean, unread: string | null }} GateSeats
 */
/** @type {GateSeats} */
const NO_SEATS = { count: 0, part: 0, under: () => false, unread: null };

/**
 * @param {PsRow[]} rows
 * @param {(words: string[]) => boolean} [isOther]
 * @param {(pid: number | null) => import("./suite-handoff.js").CarriedWeight | null} [carriedOf]
 * @param {GateSeats} [seats]
 * @returns {Running}
 */
function runningSuites(
	rows,
	isOther,
	carriedOf = () => null,
	seats = NO_SEATS,
) {
	const running = {
		total: seats.count + seats.part,
		watchers: 0,
		whole: seats.count,
		workers: seats.count * WHOLE_SUITE_WORKERS,
	};
	for (const { pid, args: line } of rows) {
		if (seats.count + seats.part > 0 && seats.under(pid)) continue;
		const run = rowWeigh(line, pid, isOther, carriedOf);
		if (run === null) continue;
		running.total++;
		if (run.watcher) running.watchers++;
		running.workers += run.workers;
		if (!run.part) running.whole++;
	}
	return running;
}

/**
 * @param {string} line
 * @param {number | null} pid
 * @param {((words: string[]) => boolean) | undefined} isOther
 * @param {(pid: number | null) => import("./suite-handoff.js").CarriedWeight | null} carriedOf
 * @returns {{ workers: number, part: boolean, watcher: boolean } | null}
 */
function rowWeigh(line, pid, isOther, carriedOf) {
	if (isVitestRunnerLine(line)) {
		const run = vitestLineWeigh(line, carriedOf(pid));
		return { ...run, watcher: isVitestWatchLine(line) };
	}
	const words = line.trim().split(/\s+/).filter(Boolean);
	if (!isOther || words.length === 0 || !isOther(words)) return null;
	return {
		workers: WHOLE_SUITE_WORKERS,
		part: hasNamedTestFiles(words),
		watcher: false,
	};
}

/** @param {number | null} pid */
const readCarriedWeightOf = (pid) =>
	require("./suite-handoff.js").readCarriedWeight(pid);

const PS_PID_LINE = /^\s*(\d+)\s(.*)$/;

/** @param {string} text @returns {PsRow[]} */
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

const PS_TIMEOUT_MS = 5000;
const PS_BIN = () => process.env.WFC_PS || "ps";

/** @returns {{ ok: true, rows: PsRow[] } | { ok: false, error: string }} */
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
	reachableRung,
	clampedClause,
	suiteRungMb,
	SUITE_RESTING_MB,
	SUITE_GATE_MB,
	SUITE_LADDER_MEASURED_AT,
	isNextRunnerLine,
	isVitestRunnerLine,
	runningSuites,
	readCarriedWeightOf,
	readPs,
};
