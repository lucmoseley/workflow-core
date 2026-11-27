const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chargeMb } = require("./launch-charge.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const { rungMb } = require("./suite-ladder.js");
const { windowsShortfall } = require("./windows-memory.js");

/** @param {number | null} major */
const tscPeakMb = (major) => chargeMb({ kind: "tsc", major });

const TSC_PEAK_MB = chargeMb({ kind: "tsc" });

// workflow-core#3163 guess
const TSC_MAX = 1;

const TSC_NO_WAIT_ENV = "WFC_TSC_NO_WAIT";
const EX_TEMPFAIL = 75;
const TSC_BUSY_EXIT = EX_TEMPFAIL;

const TSC_SLOT_ENV = "WFC_TSC_SLOT";

const TSC_QUEUE_NAME = "wfc-tsc-queue";

/** @returns {string} */
function defaultTscQueueDir() {
	return path.join(os.tmpdir(), TSC_QUEUE_NAME);
}

const TSC_LAUNCHER = /^ *(?:\S*\/)?node +(\S*bin\/tsc6?)((?: .*)?)$/;
const NATIVE_HEAD = "@typescript/typescript-";
const NATIVE_PLATFORM = "[a-z0-9]+-[a-z0-9]+";
const NATIVE_BIN = "/lib/tsc";
const TSC_NATIVE = new RegExp(
	`^ *(\\S*/node_modules/)${escapeRe(NATIVE_HEAD)}${NATIVE_PLATFORM}${escapeRe(NATIVE_BIN)}((?: .*)?)$`,
);

/** @param {string} args */
const isTscRunner = (args) => TSC_LAUNCHER.test(args) || TSC_NATIVE.test(args);

// workflow-core#5217 measured: the shortest cut memwatch recorded
const NATIVE_CUT_FLOOR = "@typescr";
const TSC_NATIVE_CUT = new RegExp(
	`^ */\\S*/node_modules/(${escapeRe(NATIVE_CUT_FLOOR)}\\S*)$`,
);
const NATIVE_REST = new RegExp(
	`^[a-z0-9]+(?:-[a-z0-9]*)?$|^${NATIVE_PLATFORM}(/.*)$`,
);

/** @param {string} args */
function isCutTscRunner(args) {
	if (isTscRunner(args)) return true;
	const m = TSC_NATIVE_CUT.exec(args);
	if (m === null) return false;
	const tail = requiredGroup(m, 1, TSC_NATIVE_CUT);
	if (tail.length <= NATIVE_HEAD.length) return NATIVE_HEAD.startsWith(tail);
	if (!tail.startsWith(NATIVE_HEAD)) return false;
	const rest = NATIVE_REST.exec(tail.slice(NATIVE_HEAD.length));
	return (
		rest !== null && (rest[1] === undefined || NATIVE_BIN.startsWith(rest[1]))
	);
}

/** @param {string} file */
const modulesRootOf = (file) => {
	const at = file.lastIndexOf("/node_modules/");
	return at < 0 ? file : file.slice(0, at + "/node_modules/".length);
};

/** @param {import("./suite-ladder.js").PsRow} row @param {string} script */
const scriptOf = ({ pid }, script) => {
	if (path.isAbsolute(script)) return script;
	return pid === null ? null : path.join(`/proc/${pid}/cwd`, script);
};

/** @param {string} file */
const realOr = (file) => {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
};

/** @param {string} modulesDir @param {string} args */
const pairKey = (modulesDir, args) => {
	const root = realOr(modulesDir);
	return `${root.endsWith("/") ? root : `${root}/`}\0${args}`;
};

/**
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
				pairKey(
					modulesRootOf(realOr(script)),
					requiredGroup(m, 2, TSC_LAUNCHER),
				),
			);
	}
	return rows
		.filter(({ args }) => {
			if (TSC_LAUNCHER.test(args)) return true;
			const m = TSC_NATIVE.exec(args);
			if (m === null) return false;
			return !launchers.has(
				pairKey(
					requiredGroup(m, 1, TSC_NATIVE),
					requiredGroup(m, 2, TSC_NATIVE),
				),
			);
		})
		.map(({ pid }) => pid);
}

/** @param {string} binTsc @returns {number | null} */
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

/** @param {string} dir @param {string} name */
function findBin(dir, name) {
	for (let at = path.resolve(dir); ; at = path.dirname(at)) {
		const bin = path.join(at, "node_modules", ".bin", name);
		if (fs.existsSync(bin)) return bin;
		if (path.dirname(at) === at) return null;
	}
}

/** @param {string} dir @param {{ bin?: string }} [launch] */
function launchPeakMb(dir, { bin: name = "tsc" } = {}) {
	const bin = findBin(dir, name);
	return tscPeakMb(bin === null ? null : readTscMajor(bin));
}

/** @param {string} dir */
function checkoutPeakMb(dir) {
	const bin = findBin(dir, "tsc");
	return bin === null ? 0 : tscPeakMb(readTscMajor(bin));
}

/**
 * @param {import("./suite-ladder.js").PsRow[] | null} rows
 * @param {number | null} mb
 * @param {number} [climbMb]
 * @param {{ windows?: import("./windows-memory.js").WindowsRead, peakMb?: number }} [limbs]
 * @returns {import("./gate-wait.js").GateDenial | null}
 */
function tscDenial(
	rows,
	mb,
	climbMb = 0,
	{ windows = { state: "absent" }, peakMb = TSC_PEAK_MB } = {},
) {
	const running = rows === null ? [] : runningTsc(rows);
	if (running.length >= TSC_MAX) {
		const memory = memoryShortfall(mb, climbMb, peakMb);
		return { limb: "count", pids: running, ...(memory ? { memory } : {}) };
	}
	return memoryDenial(mb, climbMb, { windows, peakMb });
}

/**
 * @param {number | null} mb
 * @param {number} climbMb
 * @param {{ windows?: import("./windows-memory.js").WindowsRead, peakMb: number }} limbs
 * @returns {import("./gate-wait.js").GateDenial | null}
 */
function memoryDenial(mb, climbMb, { windows = { state: "absent" }, peakMb }) {
	const memory = memoryShortfall(mb, climbMb, peakMb);
	if (memory) return { limb: "memory", ...memory };
	const short = windowsShortfall(windows);
	return short ? { limb: "windows", ...short } : null;
}

/**
 * @param {number | null} mb
 * @param {number} climbMb
 * @param {number} peakMb
 */
function memoryShortfall(mb, climbMb, peakMb) {
	const rung = rungMb(peakMb);
	return mb !== null && mb - climbMb < rung
		? { mb, rungMb: rung, ...(climbMb > 0 ? { climbMb } : {}) }
		: null;
}

const TSC_WORD = /(?:^|\/)(tsc6?)$/;

/** @param {string[]} words @returns {string | null} */
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
	isCutTscRunner,
	isTscRunner,
	launchPeakMb,
	checkoutPeakMb,
	runnerPeakMb,
	tscDenial,
	memoryDenial,
	tscLaunchBin,
};
