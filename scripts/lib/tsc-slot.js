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
const { chargeMb } = require("./launch-charge.js");
const { requiredGroup } = require("./regex-group.js");
const { rungMb } = require("./suite-ladder.js");
const { windowsShortfall } = require("./windows-memory.js");

/**
 * The peak a `tsc` of TypeScript `major` is charged.
 * @param {number | null} major
 */
const tscPeakMb = (major) => chargeMb({ kind: "tsc", major });

/* What a `tsc` whose compiler is unread is charged: the highest. */
const TSC_PEAK_MB = chargeMb({ kind: "tsc" });

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
 * - the launcher: node running a package's `bin/tsc` or `bin/tsc6`, `…/.bin/tsc` or the
 *   path typecheck-mods.js resolves (`typescript/bin/tsc` on 5.x,
 *   `@typescript/native/bin/tsc` on 7.0);
 * - 7.0's native compiler, `…/@typescript/typescript-<os>-<arch>/lib/tsc`,
 *   which the launcher becomes under the same PID where node has
 *   `process.execve`, and spawns as its child where it has not.
 *
 * Each is anchored on its first word or node's script argument, so npm's
 * `sh -c tsc …`, a wrapper's line and a `queue-run.js --tsc -- …/.bin/tsc`
 * waiter, which name the path further on, never count: a waiter counted as
 * running holds the slot it waits on (#3276).
 */
const TSC_LAUNCHER = /^ *(?:\S*\/)?node +(\S*bin\/tsc6?)((?: .*)?)$/;
const TSC_NATIVE =
	/^ *(\S*\/node_modules\/)@typescript\/typescript-[a-z0-9]+-[a-z0-9]+\/lib\/tsc((?: .*)?)$/;

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
 * A launcher's script path as the process sees it: a relative one, as a
 * `.bin` shebang leaves it, against the process's own working directory;
 * null where that cannot be read.
 * @param {import("./suite-ladder.js").PsRow} row
 * @param {string} script
 */
const scriptOf = ({ pid }, script) => {
	if (path.isAbsolute(script)) return script;
	return pid === null ? null : path.join(`/proc/${pid}/cwd`, script);
};

/**
 * A path with its links dereferenced, itself where it will not resolve.
 * @param {string} file
 */
const realOr = (file) => {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
};

/**
 * The `tsc` runners on `ps`, each by its PID, null where `ps` gave none. A
 * native compiler is left out where a launcher resolving into the same
 * `node_modules` with the same arguments is running: its parent, on a node
 * with no `process.execve`. Residual: two same-argument `tsc` from one tree,
 * one launched before the other's launcher handed over, count as one.
 *
 * @param {import("./suite-ladder.js").PsRow[]} rows
 * @returns {(number | null)[]}
 */
function runningTsc(rows) {
	const launchers = new Set();
	for (const row of rows) {
		const m = TSC_LAUNCHER.exec(row.args);
		if (m === null) continue;
		const script = scriptOf(row, requiredGroup(m, 1, TSC_LAUNCHER));
		if (script !== null)
			launchers.add(
				`${modulesRootOf(realOr(script))}\0${requiredGroup(m, 2, TSC_LAUNCHER)}`,
			);
	}
	return rows
		.filter(({ args }) => {
			if (TSC_LAUNCHER.test(args)) return true;
			const m = TSC_NATIVE.exec(args);
			if (m === null) return false;
			const root = realOr(requiredGroup(m, 1, TSC_NATIVE));
			return !launchers.has(
				`${root.endsWith("/") ? root : `${root}/`}\0${requiredGroup(m, 2, TSC_NATIVE)}`,
			);
		})
		.map(({ pid }) => pid);
}

/**
 * The TypeScript major version of the package a `bin/tsc` belongs to; null
 * where it will not read.
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
 * The peak a running `tsc`'s line is charged.
 * @param {import("./suite-ladder.js").PsRow} row
 * @param {(binTsc: string) => number | null} [readMajor]
 */
function runnerPeakMb(row, readMajor = readTscMajor) {
	if (TSC_NATIVE.test(row.args)) return tscPeakMb(7);
	const m = TSC_LAUNCHER.exec(row.args);
	const script =
		m === null ? null : scriptOf(row, requiredGroup(m, 1, TSC_LAUNCHER));
	return tscPeakMb(script === null ? null : readMajor(script));
}

/**
 * The peak a `tsc` launched from `dir` is charged: the compiler of the first
 * `node_modules/.bin/<bin>` from `dir` up.
 * @param {string} dir
 * @param {{ bin?: string, readMajor?: (binTsc: string) => number | null }} [launch]
 */
function launchPeakMb(
	dir,
	{ bin: name = "tsc", readMajor = readTscMajor } = {},
) {
	for (let at = path.resolve(dir); ; at = path.dirname(at)) {
		const bin = path.join(at, "node_modules", ".bin", name);
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
 * rung it is held on.
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
	const rung = rungMb(peakMb);
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

/** `tsc` or `tsc6`, bare or as a path's last segment. */
const TSC_WORD = /(?:^|\/)(tsc6?)$/;

/**
 * The `tsc` binary unwrapped words launch: `tsc`, `tsc6` or a path ending in
 * either, through `npx`, `npm exec` or node, 5.x's `typescript/bin/tsc` and
 * 7.0's `@typescript/native/bin/tsc` among them; null where they launch none.
 *
 * @param {string[]} words
 * @returns {string | null}
 */
function tscLaunchBin(words) {
	const [w0 = "", w1 = "", w2 = ""] = words;
	const named = (/** @type {string} */ w) => {
		const m = TSC_WORD.exec(w);
		return m === null ? null : requiredGroup(m, 1, TSC_WORD);
	};
	if (w0 === "npx") return w1 === "tsc" || w1 === "tsc6" ? w1 : null;
	if (w0 === "npm")
		return w1 === "exec" && (w2 === "tsc" || w2 === "tsc6") ? w2 : null;
	if (w0 === "node") return named(w1);
	return named(w0);
}

module.exports = {
	TSC_BUSY_EXIT,
	TSC_NO_WAIT_ENV,
	TSC_QUEUE_NAME,
	TSC_MAX,
	TSC_SLOT_ENV,
	defaultTscQueueDir,
	isTscRunner,
	launchPeakMb,
	runnerPeakMb,
	tscDenial,
	tscLaunchBin,
};
