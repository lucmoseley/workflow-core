/*
 * tsc-slot.js — the machine-wide type-check slot (#3163): one `tsc` at a
 * time, admitted against a memory rung of its own. One definition for
 * scripts/queue-run.js `--tsc`, which waits on it, and lib/suite-concurrency.js,
 * which refuses a bare `tsc` launch it would hold.
 *
 * A TYPE-CHECK IS NO SUITE: it waits in a queue directory of its own, so it
 * never queues behind a whole suite, and the suite ladder never counts it.
 * Both read MemAvailable live, so each sees what the other draws.
 */

const os = require("node:os");
const path = require("node:path");
const { DRAW_MARGIN_MB, EARLYOOM_FLOOR_MB } = require("./suite-ladder.js");

/* The peak single `tsc` RSS in `~/memwatch-archive.log`, 23–27 Oct 2026
 * (#3163), off its `^ *PID RSS node .*\/tsc` lines. MOVE IT ONLY WITH A
 * RE-MEASUREMENT. */
const TSC_PEAK_MB = 1638;

/* The rung priced as a suite's is (lib/suite-ladder.js): earlyoom's floor,
 * the draw and the gate's margin, rounded up to the next 50 MB. */
const TSC_RUNG_MB =
	Math.ceil((EARLYOOM_FLOOR_MB + TSC_PEAK_MB + DRAW_MARGIN_MB) / 50) * 50;

/* How many `tsc` run at once, machine-wide (#3163): one, as docs/environment.md
 * §6 keeps every unmeasured concurrent workload; only one `tsc` at a time has
 * been measured. */
const TSC_MAX = 1;

/** @returns {string} */
function defaultTscQueueDir() {
	return path.join(os.tmpdir(), "wfc-tsc-queue");
}

/*
 * The runner's line, one per `tsc`: node running `…/.bin/tsc`, or
 * `…/typescript/bin/tsc` where typecheck-mods.js resolves it. Anchored on
 * node's script argument, so npm's `sh -c tsc …`, a wrapper's line and a
 * `queue-run.js --tsc -- …/.bin/tsc` waiter, which name the path further on,
 * never count: a waiter counted as running holds the slot it waits on (#3276).
 */
const TSC_RUNNER = /^ *(\S*\/)?node +\S*([.]bin|typescript\/bin)\/tsc( |$)/;

/**
 * @param {import("./suite-ladder.js").PsRow[]} rows
 * @returns {number}
 */
function runningTsc(rows) {
	return rows.filter(({ args }) => TSC_RUNNER.test(args)).length;
}

/**
 * Whether the slot would refuse a `tsc` now, and on which limb. Null where it
 * would not, and on an unread `ps` or MemAvailable that limb fails open
 * (mantahostels#103 §6).
 *
 * @param {import("./suite-ladder.js").PsRow[] | null} rows
 * @param {number | null} mb
 * @returns {import("./suite-queue.js").GateDenial | null}
 */
function tscDenial(rows, mb) {
	if (rows !== null && runningTsc(rows) >= TSC_MAX) return { limb: "count" };
	if (mb !== null && mb < TSC_RUNG_MB)
		return { limb: "memory", mb, rungMb: TSC_RUNG_MB };
	return null;
}

/**
 * Whether unwrapped words launch `tsc` itself: `tsc`, a path ending `/tsc`,
 * `npx tsc`, `npm exec tsc` or `node <path>/typescript/bin/tsc`.
 *
 * @param {string[]} words
 */
function isTscLaunch(words) {
	const [w0 = "", w1 = "", w2 = ""] = words;
	const isTsc = (/** @type {string} */ w) => w === "tsc" || w.endsWith("/tsc");
	if (isTsc(w0)) return true;
	if (w0 === "npx") return w1 === "tsc";
	if (w0 === "npm") return w1 === "exec" && w2 === "tsc";
	return w0 === "node" && w1.endsWith("typescript/bin/tsc");
}

module.exports = {
	TSC_RUNG_MB,
	defaultTscQueueDir,
	tscDenial,
	isTscLaunch,
};
