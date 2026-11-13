/*
 * run-memory.js — what one test run's processes drew (#5183): the wrapper's
 * pid, vitest's main pid and every worker pid it forked, the peak resident
 * memory of each role and of the three summed, and the test file the largest
 * worker ran.
 *
 * THE RUN FILE is one JSON file a run, under the refill loop's directory
 * (lib/refill-dir.js), so the memory-kill filer reads every repo's runs from
 * one place. The wrapper opens it as it starts, before its queue wait or its
 * selection, and rewrites it every sample with `sampledAt`; a run whose
 * wrapper was killed leaves it at its last sample, with no `endedAt`.
 *
 * A PID IS THE RUN'S ONLY WHILE SEEN: `heldUntil` gives the time a pid was
 * last seen in its role, the wrapper's and main's being the last sample, plus
 * SEEN_SLACK_MS, so lib/earlyoom-kills.js never names a run for a later
 * process reusing a pid.
 *
 * A WORKER is a direct child of vitest's main process, or a process that
 * claimed a file (below): one forked and gone between two samples still
 * claims. Each role's peak is the kernel's own high-water mark, VmHWM in
 * `/proc/<pid>/status`, which no sampling gap misses. The sum spans processes
 * no one cgroup holds — the wrapper runs outside vitest's scope, which may not
 * exist (lib/user-scope.js) — so it is VmRSS summed in one sample, and a spike
 * shorter than SAMPLE_MS escapes it.
 *
 * THE WORKER'S FILE: vitest names no worker per file, so each worker claims
 * the file it runs (`claimFile`, from vitest.setup.ts) as `<pid>` in the run
 * file's `.files` directory beside it.
 *
 * NEVER THROWS: an unreadable /proc or an unwritable file costs the reading,
 * never the run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { procRoot } = require("./proc-root.js");
const { readParentOf } = require("./proc-stat.js");
const { refillPath } = require("./refill-dir.js");

/** The run file's path, set on vitest's environment. */
const MEMORY_ENV = "WFC_RUN_MEMORY";
const STORE_DIR = ".test-run-memory";
/* Untraced: about 200 stat reads a sample. */
const SAMPLE_MS = 1000;
/* How long past its last sighting a pid stays its run's: two samples, so one
 * late tick on a loaded machine does not drop a live run. */
const SEEN_SLACK_MS = 2 * SAMPLE_MS;
/* Covers lib/incident-tickets.js's 72 h lookback and the incident gap. */
const RETAIN_MS = 4 * 24 * 60 * 60 * 1000;
/* A guess: room for a named run's files; a wider selection is named by its
 * count. */
const FILES_KEPT = 10;

/**
 * @typedef {{ wrapper: number, main: number|null, workers: number[] }} RunPids
 * @typedef {{ wrapper: number, main: number, worker: number, sum: number }} PeaksMiB
 * @typedef {{ pids: RunPids, peaksMiB: PeaksMiB, workerFile: string|null }} RunMemory
 * @typedef {{ session: string|null, kind: string, argv: string[],
 *   files: string[], fileCount: number, repo: string }} RunLaunch
 * @typedef {RunLaunch & RunMemory & { at: string, bootId: string|null,
 *   sampledAt: string, workersSeenAt: Record<string, string>,
 *   endedAt?: string }} RunFile
 * @typedef {"wrapper"|"vitest main"|"worker"} Role
 */

const storeDir = () => refillPath(STORE_DIR);

/** @param {string} file */
const claimsDir = (file) => `${file}.files`;

/** @param {number} kb */
const toMiB = (kb) => Math.round(kb / 1024);

/**
 * VmRSS and VmHWM in kB, or null where the process is gone.
 * @param {string} proc @param {number} pid
 */
function readMemKb(proc, pid) {
	const status = readText(path.join(proc, String(pid), "status"));
	if (status.state !== "read") return null;
	const rss = Number(status.data.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]);
	if (!Number.isFinite(rss)) return null;
	const hwm = Number(status.data.match(/^VmHWM:\s+(\d+) kB$/m)?.[1]);
	return { rss, hwm: Number.isFinite(hwm) ? hwm : rss };
}

/**
 * The live direct children of `parent`.
 * @param {string} proc @param {number} parent
 * @returns {number[]}
 */
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

/**
 * @param {string} file the run file
 * @returns {Map<number, string>}
 */
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

/**
 * The wrapper's and main's VmHWM, and their VmRSS summed, kB; 0 for one gone.
 * @param {string} proc @param {number} wrapper @param {number|null} main
 */
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
 * Lists and stamps the run's workers, folding each live one's VmHWM into
 * `workerHwm`; their VmRSS summed, kB.
 * @param {string} proc
 * @param {RunFile} run accumulator: its `pids.workers` and `workersSeenAt`
 *   gain this sample's workers
 * @param {{ at: string, claims: Map<number, string>, workerHwm: Map<number, number> }} sampling
 *   `workerHwm` an accumulator: each worker's highest VmHWM, kB
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
		/* A claim outlives its worker: one gone by its first sample is seen
		 * once, now. */
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
	try {
		writeFileAtomic(file, `${JSON.stringify(run)}\n`, { mkdir: true });
	} catch {
		/* NEVER THROWS */
	}
}

/** @param {string} target */
function removeQuietly(target) {
	try {
		fs.rmSync(target, { recursive: true, force: true });
	} catch {
		/* the sweep takes it */
	}
}

/**
 * Removes run files, and their claims, older than RETAIN_MS.
 * @param {string} dir @param {number} now
 */
function sweep(dir, now) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		try {
			if (now - fs.statSync(full).mtimeMs > RETAIN_MS) removeQuietly(full);
		} catch {
			/* a neighbour's sweep took it first */
		}
	}
}

/**
 * @typedef {{ file: string, sample: () => void,
 *   setLaunch: (launch: RunLaunch) => void, setMain: (pid: number|null) => void,
 *   current: () => RunMemory, stop: () => RunMemory, discard: () => void }} Sampler
 */

/**
 * Starts sampling one run, writing its file at once.
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
	/** @type {Map<number, number>} each worker's VmHWM, kB, at its last read */
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
		/* What the run selected, known once the wrapper has planned it. */
		setLaunch: (next) => {
			Object.assign(run, next, { files: next.files.slice(0, FILES_KEPT) });
			writeRun(file, run);
		},
		/* vitest's pid, known only once the run file's path is in its env. */
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
		/* A wrapper that spawned nothing leaves no run. */
		discard: () => {
			end();
			removeQuietly(file);
		},
	};
}

/**
 * The run block of the file `MEMORY_ENV` names, for the marker; null where
 * none is set or it will not read.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {RunMemory|null}
 */
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
 * Records, from inside a worker, the test file it now runs, relative to the
 * tree it runs in.
 * @param {string} testPath
 * @param {{ env?: NodeJS.ProcessEnv, pid?: number, cwd?: string }} [options]
 */
function claimFile(
	testPath,
	{ env = process.env, pid = process.pid, cwd = process.cwd() } = {},
) {
	const file = env[MEMORY_ENV];
	if (!file) return;
	try {
		fs.mkdirSync(claimsDir(file), { recursive: true });
		fs.writeFileSync(
			path.join(claimsDir(file), String(pid)),
			path.relative(cwd, testPath),
		);
	} catch {
		/* the run's file goes unnamed */
	}
}

/**
 * Every run file in the store, or why the store would not read: a directory
 * that will not list or a file that will not parse.
 * @param {string} [dir]
 * @returns {{ runs: RunFile[], why: string|null }}
 */
function readRunFiles(dir = storeDir()) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (error) {
		return caught(error).code === "ENOENT"
			? { runs: [], why: null }
			: { runs: [], why: `the test run store: ${caught(error).message}` };
	}
	/** @type {RunFile[]} */
	const runs = [];
	for (const name of names.filter((n) => n.endsWith(".json")))
		try {
			runs.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
		} catch (error) {
			/* A neighbour's sweep took it after the listing. */
			if (caught(error).code === "ENOENT") continue;
			return {
				runs: [],
				why: `the test run store: ${name}: ${caught(error).message}`,
			};
		}
	return { runs, why: null };
}

/**
 * The role `pid` held in `run` and the last time, ms, it can be taken for the
 * run's: its last sighting plus SEEN_SLACK_MS; null where it held none.
 * @param {RunFile} run
 * @param {number} pid
 * @returns {{ role: Role, until: number }|null}
 */
function heldUntil(run, pid) {
	const lastSample = Date.parse(run.endedAt ?? run.sampledAt);
	/** @type {[Role, number]|null} */
	let held = null;
	if (run.pids.wrapper === pid) held = ["wrapper", lastSample];
	else if (run.pids.main === pid) held = ["vitest main", lastSample];
	else if (run.workersSeenAt[pid])
		held = ["worker", Math.min(Date.parse(run.workersSeenAt[pid]), lastSample)];
	return held && { role: held[0], until: held[1] + SEEN_SLACK_MS };
}

module.exports = {
	MEMORY_ENV,
	claimFile,
	heldUntil,
	readRunFiles,
	readRunMemory,
	startSampler,
};
