const fs = require("node:fs");
const os = require("node:os");
const { readMachineSetting } = require("./machine-setting.js");
const { REAL_PROC } = require("./proc-root.js");

const FIELDS = [
	"user",
	"nice",
	"system",
	"idle",
	"iowait",
	"irq",
	"softirq",
	"steal",
];

const NOT_BUSY = new Set(["idle", "iowait"]);

/**
 * @typedef {{jiffies: Record<string, number>, total: number, load1: number|null}} CpuSample
 */

/** @returns {number|null} */
function readLoad1() {
	try {
		const n = Number.parseFloat(
			fs
				.readFileSync(process.env.WFC_LOADAVG || `${REAL_PROC}/loadavg`, "utf8")
				.trim(),
		);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/** @returns {CpuSample|null} */
function sample() {
	let line;
	try {
		line = fs
			.readFileSync(`${REAL_PROC}/stat`, "utf8")
			.split("\n")
			.find((l) => l.startsWith("cpu "));
	} catch {
		return null;
	}
	if (!line) return null;

	const values = line.trim().split(/\s+/).slice(1);

	/** @type {Record<string, number>} */
	const jiffies = {};
	let total = 0;
	for (const [i, field] of FIELDS.entries()) {
		const value = values[i];
		if (value === undefined) return null;
		const n = Number.parseInt(value, 10);
		if (!Number.isFinite(n)) return null;
		jiffies[field] = n;
		total += n;
	}
	return { jiffies, total, load1: readLoad1() };
}

/**
 * @param {CpuSample|null} before
 * @param {CpuSample|null} after
 * @param {number} [cores]
 * @returns {{ceilingPct: number, busyPct: number, systemPct: number, nicePct: number, userPct: number, iowaitPct: number, load1: number|null, load1AtStart: number|null}|null}
 */
function delta(before, after, cores = os.cpus()?.length || 0) {
	if (!before || !after || !cores) return null;
	const span = after.total - before.total;
	if (!(span > 0)) return null;

	const ceiling = 100 * cores;
	/** @param {string} name */
	const moved = (name) => {
		const a = after.jiffies[name];
		const b = before.jiffies[name];
		if (a === undefined || b === undefined)
			throw new Error(`a CPU sample carries no ${name} count`);
		return a - b;
	};
	/** @param {string} name */
	const pct = (name) => Math.round(((ceiling * moved(name)) / span) * 10) / 10;

	let busy = 0;
	for (const f of FIELDS) if (!NOT_BUSY.has(f)) busy += moved(f);

	return {
		ceilingPct: ceiling,
		busyPct: Math.round(((ceiling * busy) / span) * 10) / 10,
		systemPct: pct("system"),
		nicePct: pct("nice"),
		userPct: pct("user"),
		iowaitPct: pct("iowait"),
		load1: after.load1,
		load1AtStart: before.load1,
	};
}

// guess, #830
const LOAD_PER_CORE_CEILING = 3;

/**
 * @param {number} [cores]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null}
 */
function loadCeiling(cores = os.cpus()?.length || 0, env = process.env) {
	return ceilingOf(
		readLoadCeilingOverride(env).text,
		LOAD_PER_CORE_CEILING,
		cores,
	);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{text?: string, problem?: string}}
 */
function readLoadCeilingOverride(env) {
	const { text, source, problem } = readMachineSetting(
		"load-ceiling",
		"WFC_LOAD_CEILING",
		env,
	);
	if (text === undefined) return problem ? { problem } : {};
	if (Number.isFinite(Number.parseFloat(text))) return { text };
	return {
		problem: `${source} holds ${JSON.stringify(text.trim())}, not a number`,
	};
}

// guess, #2141
const SESSIONS_PER_CORE_CEILING = 1.5;

/**
 * @param {number} [cores]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null}
 */
function sessionCeiling(cores = os.cpus()?.length || 0, env = process.env) {
	const ceiling = ceilingOf(
		env.WFC_SESSION_CEILING,
		SESSIONS_PER_CORE_CEILING,
		cores,
	);
	if (ceiling === null) return null;
	if (ceiling < 1) return sessionCeiling(cores, {});
	return Math.floor(ceiling);
}

/**
 * @param {string | undefined} raw
 * @param {number} perCore
 * @param {number} cores
 * @returns {number|null}
 */
function ceilingOf(raw, perCore, cores) {
	if (raw !== undefined && raw.trim() !== "") {
		const n = Number.parseFloat(raw);
		if (n === 0) return null;
		if (Number.isFinite(n) && n > 0) return n;
	}
	return cores ? perCore * cores : null;
}

/**
 * @typedef {{overloaded: boolean, load1: number|null, ceiling: number|null, problem?: string}} LoadReading
 */

/**
 * @param {{load1?: number|null, cores?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {LoadReading}
 */
function overloadReading({
	load1 = readLoad1(),
	cores = os.cpus()?.length || 0,
	env = process.env,
} = {}) {
	const override = readLoadCeilingOverride(env);
	const ceiling = ceilingOf(override.text, LOAD_PER_CORE_CEILING, cores);
	const reading = {
		overloaded: load1 !== null && ceiling !== null && load1 >= ceiling,
		load1,
		ceiling,
	};
	return override.problem ? { ...reading, problem: override.problem } : reading;
}

/** @param {LoadReading} load */
const buildOverloadText = (load) =>
	`load1 ${load.load1} is at or above the ${load.ceiling} ceiling (#830)${load.problem ? `; ${load.problem}` : ""}`;

// guess, #830
const LOAD_POLL_MS = 15_000;
const LOAD_HOLD_MS = 5 * 60 * 1000;

/**
 * @param {{ pollMs?: number, timeoutMs?: number, read?: () => LoadReading, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown } }} [options]
 * @returns {Promise<boolean>}
 */
function holdForLoad({
	pollMs = LOAD_POLL_MS,
	timeoutMs = LOAD_HOLD_MS,
	read = () => overloadReading(),
	sleepFn = (/** @type {number} */ ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	out = process.stderr,
} = {}) {
	const started = Date.now();
	let announced = false;
	const secs = () => Math.round((Date.now() - started) / 1000);
	/** @returns {Promise<boolean>} */
	const step = () => {
		const r = read();
		if (!r.overloaded) {
			if (announced)
				out.write(
					`run-vitest: load1 fell to ${r.load1} after ${secs()}s; starting\n`,
				);
			return Promise.resolve(true);
		}
		if (Date.now() - started >= timeoutMs) {
			out.write(
				`run-vitest: REFUSED — load1 still ${r.load1}, at or above the ${r.ceiling} ceiling (#830), after ${secs()}s. ` +
					"Re-run the same command later; it holds on load by itself (rule:load-wait).\n",
			);
			return Promise.resolve(false);
		}
		if (!announced) {
			announced = true;
			out.write(
				`run-vitest: ${buildOverloadText(r)}; ` +
					`holding up to ${Math.round(timeoutMs / 1000)}s for it to fall\n`,
			);
		}
		return sleepFn(pollMs).then(step);
	};
	return step();
}

module.exports = {
	sample,
	delta,
	FIELDS,
	overloadReading,
	buildOverloadText,
	loadCeiling,
	sessionCeiling,
	holdForLoad,
};
