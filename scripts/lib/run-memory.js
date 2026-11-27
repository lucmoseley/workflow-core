const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught, ignoreFailure } = require("./caught.js");
const { readText } = require("./file-read.js");
const { procRoot } = require("./proc-root.js");
const { readParentOf } = require("./proc-stat.js");
const { refillPath } = require("./refill-dir.js");

const MEMORY_ENV = "WFC_RUN_MEMORY";
const STORE_DIR = ".test-run-memory";
const GATE_FILE_PREFIX = "gate-";
// guess, workflow-core#5183
const SAMPLE_MS = 1000;
// guess, workflow-core#5269
const SLACK_SAMPLES = 2;
// guess, workflow-core#5183
const RETAIN_MS = 4 * 24 * 60 * 60 * 1000;
// guess, workflow-core#5183
const FILES_KEPT = 10;

/**
 * @typedef {{ wrapper: number, main: number|null, workers: number[] }} RunPids
 * @typedef {{ wrapper: number, main: number, worker: number, sum: number }} PeaksMiB
 * @typedef {{ pids: RunPids, peaksMiB: PeaksMiB, workerFile: string|null }} RunMemory
 * @typedef {{ session: string|null, kind: string, argv: string[],
 *   files: string[], fileCount: number, repo: string,
 *   mode?: "peak" | "ladder",
 *   admission?: import("./part-suite-peak.js").PartAdmission }} RunLaunch
 * @typedef {RunLaunch & RunMemory & { at: string, bootId: string|null,
 *   sampledAt: string, workersSeenAt: Record<string, string>,
 *   endedAt?: string }} RunFile
 * @typedef {"wrapper"|"main"|"worker"} Role
 */

const storeDir = () => refillPath(STORE_DIR);

/** @param {string} file */
const claimsDir = (file) => `${file}.files`;

/** @param {number} kb */
const toMiB = (kb) => Math.round(kb / 1024);

/** @param {string} proc @param {number} pid */
function readMemKb(proc, pid) {
	const status = readText(path.join(proc, String(pid), "status"));
	if (status.state !== "read") return null;
	const rss = Number(status.data.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]);
	if (!Number.isFinite(rss)) return null;
	const hwm = Number(status.data.match(/^VmHWM:\s+(\d+) kB$/m)?.[1]);
	return { rss, hwm: Number.isFinite(hwm) ? hwm : rss };
}

/** @param {string} proc @param {number} parent @returns {number[]} */
function readChildren(proc, parent) {
	let names;
	try {
		names = fs.readdirSync(proc);
	} catch {
		return [];
	}
	return names.flatMap((name) =>
		/^\d+$/.test(name) && readParentOf(name, proc) === parent
			? [Number(name)]
			: [],
	);
}

/** @param {string} file @returns {Map<number, string>} */
function readClaims(file) {
	let names;
	try {
		names = fs.readdirSync(claimsDir(file));
	} catch {
		return new Map();
	}
	return new Map(
		names.flatMap((name) => {
			const claim = readText(path.join(claimsDir(file), name));
			return claim.state === "read" && /^\d+$/.test(name)
				? [[Number(name), claim.data.trim()]]
				: [];
		}),
	);
}

/** @param {string} proc @param {number} wrapper @param {number|null} main */
function sampleOwn(proc, wrapper, main) {
	const w = readMemKb(proc, wrapper);
	const m = main === null ? null : readMemKb(proc, main);
	return {
		wrapperHwm: w?.hwm ?? 0,
		mainHwm: m?.hwm ?? 0,
		rss: (w?.rss ?? 0) + (m?.rss ?? 0),
	};
}

/**
 * @param {string} proc
 * @param {RunFile} run
 * @param {{ at: string, claims: Map<number, string>, workerHwm: Map<number, number> }} sampling
 */
function sampleWorkers(proc, run, { at, claims, workerHwm }) {
	const main = run.pids.main;
	const workers = new Set([
		...(main === null ? [] : readChildren(proc, main)),
		...claims.keys(),
	]);
	let rss = 0;
	for (const pid of workers) {
		if (!run.pids.workers.includes(pid)) run.pids.workers.push(pid);
		const mem = readMemKb(proc, pid);
		if (mem === null) {
			run.workersSeenAt[pid] ??= at;
			continue;
		}
		run.workersSeenAt[pid] = at;
		rss += mem.rss;
		workerHwm.set(pid, Math.max(workerHwm.get(pid) ?? 0, mem.hwm));
	}
	return rss;
}

/** @param {RunFile} run @returns {RunMemory} */
const memoryOf = ({ pids, peaksMiB, workerFile }) => ({
	pids,
	peaksMiB,
	workerFile,
});

/** @param {string} file @param {RunFile} run */
function writeRun(file, run) {
	ignoreFailure(() =>
		writeFileAtomic(file, `${JSON.stringify(run)}\n`, { mkdir: true }),
	);
}

/** @param {string} target */
function removeQuietly(target) {
	ignoreFailure(() => fs.rmSync(target, { recursive: true, force: true }));
}

/** @param {string} dir @param {number} now */
function sweep(dir, now) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		ignoreFailure(() => {
			if (now - fs.statSync(full).mtimeMs > RETAIN_MS) removeQuietly(full);
		});
	}
}

/**
 * @typedef {{ file: string, sample: () => void,
 *   setLaunch: (launch: RunLaunch) => void, setMain: (pid: number|null) => void,
 *   current: () => RunMemory, stop: () => RunMemory, discard: () => void }} Sampler
 */

/**
 * @param {RunLaunch} launch
 * @param {{ wrapper?: number, proc?: string, dir?: string, intervalMs?: number,
 *   now?: () => number, bootId?: string|null }} [options]
 * @returns {Sampler}
 */
function startSampler(
	launch,
	{
		wrapper = process.pid,
		proc = procRoot(),
		dir = storeDir(),
		intervalMs = SAMPLE_MS,
		now = Date.now,
		bootId = readCurrentBootId(),
	} = {},
) {
	const startedAt = now();
	sweep(dir, startedAt);
	const file = path.join(dir, `${wrapper}-${startedAt}.json`);
	const stamp = () => new Date(now()).toISOString();
	/** @type {RunFile} */
	const run = {
		at: new Date(startedAt).toISOString(),
		bootId,
		...launch,
		files: launch.files.slice(0, FILES_KEPT),
		pids: { wrapper, main: null, workers: [] },
		peaksMiB: { wrapper: 0, main: 0, worker: 0, sum: 0 },
		workerFile: null,
		sampledAt: stamp(),
		workersSeenAt: {},
	};
	/** @type {Map<number, number>} */
	const workerHwm = new Map();
	const sample = () => {
		const at = stamp();
		const peaks = run.peaksMiB;
		const claims = readClaims(file);
		const own = sampleOwn(proc, wrapper, run.pids.main);
		peaks.wrapper = Math.max(peaks.wrapper, toMiB(own.wrapperHwm));
		peaks.main = Math.max(peaks.main, toMiB(own.mainHwm));
		const workersRss = sampleWorkers(proc, run, { at, claims, workerHwm });
		const [largest] = [...workerHwm].sort((a, b) => b[1] - a[1]);
		if (largest) {
			peaks.worker = Math.max(peaks.worker, toMiB(largest[1]));
			run.workerFile = claims.get(largest[0]) ?? run.workerFile;
		}
		peaks.sum = Math.max(peaks.sum, toMiB(own.rss + workersRss));
		run.sampledAt = at;
		writeRun(file, run);
	};
	sample();
	const timer = setInterval(sample, intervalMs);
	timer.unref?.();
	const end = () => {
		clearInterval(timer);
		removeQuietly(claimsDir(file));
	};
	return {
		file,
		sample,
		setLaunch: (next) => {
			Object.assign(run, next, { files: next.files.slice(0, FILES_KEPT) });
			writeRun(file, run);
		},
		setMain: (pid) => {
			run.pids.main = pid;
			writeRun(file, run);
		},
		current: () => memoryOf(run),
		stop: () => {
			sample();
			end();
			run.endedAt = stamp();
			writeRun(file, run);
			return memoryOf(run);
		},
		discard: () => {
			end();
			removeQuietly(file);
		},
	};
}

/** @param {NodeJS.ProcessEnv} [env] @returns {RunMemory|null} */
function readRunMemory(env = process.env) {
	const file = env[MEMORY_ENV];
	if (!file) return null;
	try {
		return memoryOf(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./part-suite-peak.js").PartAdmission|null}
 */
function readRunAdmission(env = process.env) {
	const file = env[MEMORY_ENV];
	if (!file) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")).admission ?? null;
	} catch {
		return null;
	}
}

/**
 * @param {string} testPath
 * @param {{ env?: NodeJS.ProcessEnv, pid?: number, cwd?: string }} [options]
 */
function claimFile(
	testPath,
	{ env = process.env, pid = process.pid, cwd = process.cwd() } = {},
) {
	const file = env[MEMORY_ENV];
	if (!file) return;
	ignoreFailure(() => {
		fs.mkdirSync(claimsDir(file), { recursive: true });
		fs.writeFileSync(
			path.join(claimsDir(file), String(pid)),
			path.relative(cwd, testPath),
		);
	});
}

/**
 * @template T
 * @param {{ named: (name: string) => boolean,
 *   shaped: (parsed: unknown) => parsed is T, dir?: string }} read
 * @returns {{ items: T[], why: string|null }}
 */
function readStoreFiles({ named, shaped, dir = storeDir() }) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (error) {
		return caught(error).code === "ENOENT"
			? { items: [], why: null }
			: { items: [], why: `the test run store: ${caught(error).message}` };
	}
	/** @type {T[]} */
	const items = [];
	for (const name of names.filter((n) => n.endsWith(".json") && named(n)))
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
			if (shaped(parsed)) items.push(parsed);
		} catch (error) {
			if (caught(error).code === "ENOENT") continue;
			return {
				items: [],
				why: `the test run store: ${name}: ${caught(error).message}`,
			};
		}
	return { items, why: null };
}

/**
 * @template T
 * @param {unknown} parsed
 * @param {string} key
 * @returns {parsed is T}
 */
const holdsObject = (parsed, key) =>
	parsed instanceof Object &&
	key in parsed &&
	/** @type {Record<string, unknown>} */ (parsed)[key] instanceof Object;

/** @param {number} seen @param {number} lastSample @param {number} sampleMs */
const seenUntil = (seen, lastSample, sampleMs) =>
	Math.min(seen, lastSample) + SLACK_SAMPLES * sampleMs;

/** @param {string} [dir] @returns {{ runs: RunFile[], why: string|null }} */
function readRunFiles(dir = storeDir()) {
	const { items, why } = readStoreFiles({
		dir,
		named: (name) => !name.startsWith(GATE_FILE_PREFIX),
		shaped: (run) => holdsObject(run, "workersSeenAt"),
	});
	return { runs: items, why };
}

/**
 * @param {RunFile} run
 * @param {number} pid
 * @returns {{ role: Role, until: number }|null}
 */
function heldUntil(run, pid) {
	const lastSample = Date.parse(run.endedAt ?? run.sampledAt);
	/** @type {[Role, number]|null} */
	let held = null;
	if (run.pids.wrapper === pid) held = ["wrapper", lastSample];
	else if (run.pids.main === pid) held = ["main", lastSample];
	else if (run.workersSeenAt[pid])
		held = ["worker", Date.parse(run.workersSeenAt[pid])];
	return (
		held && { role: held[0], until: seenUntil(held[1], lastSample, SAMPLE_MS) }
	);
}

module.exports = {
	GATE_FILE_PREFIX,
	MEMORY_ENV,
	holdsObject,
	claimFile,
	heldUntil,
	readRunAdmission,
	readRunFiles,
	readRunMemory,
	readStoreFiles,
	seenUntil,
	startSampler,
	storeDir,
	sweep,
};
