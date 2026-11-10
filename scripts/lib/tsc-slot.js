/*
 * tsc-slot.js — the machine-wide type-check slot (#3163): one `tsc` at a
 * time, admitted against a memory rung of its own. One definition for
 * scripts/queue-run.js `--tsc`, which waits on it, and lib/suite-concurrency.js,
 * which refuses a bare `tsc` launch it would hold.
 *
 * A TYPE-CHECK IS NO SUITE: it waits in a queue directory of its own, so it
 * never queues behind a whole suite, and the suite ladder never counts it.
 * Both read MemAvailable live, less what the other queue's launches have yet
 * to draw as they climb (#3416); a launch admitted and not yet up is held by
 * lib/suite-queue.js, which reads both queues' admission stamps (#3203).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { rungMb } = require("./suite-ladder.js");
const { windowsShortfall } = require("./windows-memory.js");

/* The peak of `npm run typecheck`, by the TypeScript major version it runs
 * (#4892): the slot is machine-wide, and each adopting repo moves compiler on
 * its own pin, so a runner is charged its own compiler's. A fresh worktree's
 * cold first pass sets each, a warm one peaking well under it.
 *
 * - 5: measured at 5b1610b7e on 10 Nov 2026 (#4849), `tsc --noEmit` with no
 *   `tsconfig.tsbuildinfo`, the higher of two runs' cgroup `memory.peak`
 *   (2,045 MiB; three runs' RSS 2,000–2,029); warm near 1,284 MiB.
 * - 7: measured at d75d240b1 on 10 Nov 2026 (#4892), the whole command at
 *   `--checkers 2` with no build info, the higher of two runs' cgroup
 *   `memory.peak` (1,497 and 1,469 MiB).
 *
 * A compiler unread — a version that will not read, or a major not here —
 * is charged the highest, 5's. MOVE ONE ONLY WITH A RE-MEASUREMENT. */
const TSC_PEAKS_MB = Object.freeze({ 5: 2045, 7: 1497 });
const TSC_PEAK_MB = Math.max(...Object.values(TSC_PEAKS_MB));

/**
 * The peak a `tsc` of TypeScript `major` is charged; null, unread.
 * @param {number | null} major
 */
const tscPeakMb = (major) =>
	major === 5 || major === 7 ? TSC_PEAKS_MB[major] : TSC_PEAK_MB;

/** @param {number} peakMb */
const tscRungMb = (peakMb) => rungMb(peakMb);

/* How many `tsc` run at once, machine-wide (#3163): one, as docs/environment.md
 * §6 keeps every unmeasured concurrent workload; only one `tsc` at a time has
 * been measured. */
const TSC_MAX = 1;

/* Set to `1`, a `--tsc` launch tries the slot once rather than wait for it,
 * and exits TSC_BUSY_EXIT, running nothing, where it is held (#3278). The
 * pre-commit hook sets it. 75 is sysexits.h's EX_TEMPFAIL, an exit no `tsc`
 * gives. */
const TSC_NO_WAIT_ENV = "WFC_TSC_NO_WAIT";
const TSC_BUSY_EXIT = 75;

/* The environment variable a `--tsc` launch hands its command: its marker's
 * path, so a `--tsc` launch inside that command's process tree runs in the
 * slot it holds rather than queue behind it (#3404).
 * Residual: nothing counts the `tsc` runs inside the slot, so a command that
 * starts two in parallel passes TSC_MAX and the rung. */
const TSC_SLOT_ENV = "WFC_TSC_SLOT";

/* The slot's queue directory's name under the temp root, which
 * lib/suite-queue.js also reads to find this queue's admissions (#3203). */
const TSC_QUEUE_NAME = "wfc-tsc-queue";

/** @returns {string} */
function defaultTscQueueDir() {
	return path.join(os.tmpdir(), TSC_QUEUE_NAME);
}

/*
 * A runner's line, one per `tsc`, of two shapes (#4892):
 *
 * - the launcher: node running a package's `bin/tsc`, `…/.bin/tsc` or the
 *   path typecheck-mods.js resolves (`typescript/bin/tsc` on 5.x,
 *   `@typescript/native/bin/tsc` here on 7.0);
 * - 7.0's native compiler, `…/@typescript/typescript-<os>-<arch>/lib/tsc`,
 *   which the launcher becomes under the same PID where node has
 *   `process.execve` (22.15 on), and spawns as its child where it has not.
 *
 * Each is anchored on its first word or node's script argument, so npm's
 * `sh -c tsc …`, a wrapper's line and a `queue-run.js --tsc -- …/.bin/tsc`
 * waiter, which name the path further on, never count: a waiter counted as
 * running holds the slot it waits on (#3276).
 */
const TSC_LAUNCHER = /^ *(?:\S*\/)?node +(\S*bin\/tsc)(?: (.*))?$/;
const TSC_NATIVE =
	/^ *(\S*\/node_modules\/)@typescript\/typescript-[a-z0-9]+-[a-z0-9]+\/lib\/tsc(?: (.*))?$/;

/** @param {string} args  a process's command line */
const isTscRunner = (args) => TSC_LAUNCHER.test(args) || TSC_NATIVE.test(args);

/**
 * The `node_modules/` a path sits under, through its last one; the path itself
 * where it names none.
 * @param {string} file
 */
const modulesRootOf = (file) => {
	const at = file.lastIndexOf("/node_modules/");
	return at < 0 ? file : file.slice(0, at + "/node_modules/".length);
};

/**
 * The `tsc` runners on `ps`, each by its PID, null where `ps` gave none. A
 * native compiler is left out where a launcher from the same `node_modules`
 * with the same arguments is running: its parent, on a node with no
 * `process.execve`, which is the one runner already counted. Residual: two
 * same-argument `tsc` from one tree, one launched before the other's
 * launcher handed over, count as one.
 *
 * @param {import("./suite-ladder.js").PsRow[]} rows
 * @returns {(number | null)[]}
 */
function runningTsc(rows) {
	const launchers = new Set();
	for (const { args } of rows) {
		const m = TSC_LAUNCHER.exec(args);
		if (m) launchers.add(`${modulesRootOf(m[1] ?? "")}\0${m[2] ?? ""}`);
	}
	return rows
		.filter(({ args }) => {
			if (TSC_LAUNCHER.test(args)) return true;
			const m = TSC_NATIVE.exec(args);
			return m !== null && !launchers.has(`${m[1] ?? ""}\0${m[2] ?? ""}`);
		})
		.map(({ pid }) => pid);
}

/**
 * The TypeScript major version of the package a `bin/tsc` belongs to, links
 * dereferenced; null where it will not read.
 * @param {string} binTsc
 * @returns {number | null}
 */
function readTscMajor(binTsc) {
	try {
		const pkg = path.dirname(path.dirname(fs.realpathSync(binTsc)));
		const { version } = JSON.parse(
			fs.readFileSync(path.join(pkg, "package.json"), "utf8"),
		);
		const major = Number.parseInt(String(version), 10);
		return Number.isInteger(major) ? major : null;
	} catch {
		return null;
	}
}

/**
 * The peak a running `tsc`'s line is charged: a native compiler's 7's, a
 * launcher's by the package its script resolves into.
 * @param {string} args
 * @param {(binTsc: string) => number | null} [readMajor]
 */
function runnerPeakMb(args, readMajor = readTscMajor) {
	if (TSC_NATIVE.test(args)) return tscPeakMb(7);
	const script = TSC_LAUNCHER.exec(args)?.[1];
	return tscPeakMb(script === undefined ? null : readMajor(script));
}

/**
 * The peak a `tsc` launched from `dir` is charged: that of the compiler npm
 * would run there, the first `node_modules/.bin/tsc` from `dir` up.
 * @param {string} dir
 * @param {(binTsc: string) => number | null} [readMajor]
 */
function launchPeakMb(dir, readMajor = readTscMajor) {
	for (let at = path.resolve(dir); ; at = path.dirname(at)) {
		const bin = path.join(at, "node_modules", ".bin", "tsc");
		if (fs.existsSync(bin)) return tscPeakMb(readMajor(bin));
		if (path.dirname(at) === at) return tscPeakMb(null);
	}
}

/**
 * Whether the slot would refuse a `tsc` now, and on which limb: the count cap
 * with the running `tsc`s' PIDs, and the memory reading where the rung fails
 * too (#4359), the memory rung, or the Windows-memory hold (#4557). Null where
 * it would not, and on an unread `ps`, MemAvailable or Windows reading that
 * limb fails open (mantahostels#103 §6). `climbMb`, what the suite queue's
 * launches have yet to draw (#3416), comes off MemAvailable before the rung
 * reads it. `peakMb` is the launch's own compiler's (`launchPeakMb`), whose
 * rung it is held on; unread, the highest.
 *
 * @param {import("./suite-ladder.js").PsRow[] | null} rows
 * @param {number | null} mb
 * @param {number} [climbMb]
 * @param {{ windows?: import("./windows-memory.js").WindowsRead, peakMb?: number }} [limbs]
 * @returns {import("./suite-queue.js").GateDenial | null}
 */
function tscDenial(
	rows,
	mb,
	climbMb = 0,
	{ windows = { state: "absent" }, peakMb = TSC_PEAK_MB } = {},
) {
	const running = rows === null ? [] : runningTsc(rows);
	const rung = tscRungMb(peakMb);
	const memory =
		mb !== null && mb - climbMb < rung
			? { mb, rungMb: rung, ...(climbMb > 0 ? { climbMb } : {}) }
			: null;
	if (running.length >= TSC_MAX)
		return { limb: "count", pids: running, ...(memory ? { memory } : {}) };
	if (memory) return { limb: "memory", ...memory };
	const short = windowsShortfall(windows);
	return short ? { limb: "windows", ...short } : null;
}

/**
 * Whether unwrapped words launch `tsc` itself: `tsc`, a path ending `/tsc`,
 * `npx tsc`, `npm exec tsc` or node running a path ending `/tsc`, 5.x's
 * `typescript/bin/tsc` and 7.0's `@typescript/native/bin/tsc` among them.
 *
 * @param {string[]} words
 */
function isTscLaunch(words) {
	const [w0 = "", w1 = "", w2 = ""] = words;
	const isTsc = (/** @type {string} */ w) => w === "tsc" || w.endsWith("/tsc");
	if (isTsc(w0)) return true;
	if (w0 === "npx") return w1 === "tsc";
	if (w0 === "npm") return w1 === "exec" && w2 === "tsc";
	return w0 === "node" && isTsc(w1);
}

module.exports = {
	TSC_BUSY_EXIT,
	TSC_PEAK_MB,
	TSC_PEAKS_MB,
	TSC_NO_WAIT_ENV,
	TSC_QUEUE_NAME,
	TSC_MAX,
	TSC_SLOT_ENV,
	defaultTscQueueDir,
	isTscRunner,
	launchPeakMb,
	runnerPeakMb,
	tscDenial,
	tscPeakMb,
	tscRungMb,
	isTscLaunch,
};
