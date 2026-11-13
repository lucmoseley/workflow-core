/*
 * run-memory.js — what one test run's processes drew (#5183): the wrapper's
 * pid, vitest's main pid and every worker pid it forked, the peak resident
 * memory of each role and of the three summed, and the test file the largest
 * worker ran at its peak.
 *
 * THE RUN FILE is one JSON file a run, under the refill loop's directory
 * (lib/refill-dir.js), so the memory-kill filer reads every repo's runs from
 * one place. The wrapper writes it at spawn, before any process can be
 * killed, and rewrites it whenever a pid appears or a peak rises; a run whose
 * wrapper was killed leaves it at its last reading, with no `endedAt`.
 * lib/earlyoom-kills.js matches a killed pid against these files; the marker
 * a finished run writes carries `memoryOf`'s block into `.test-runs.jsonl`
 * (lib/run-ledger.js).
 *
 * A WORKER is a direct child of vitest's main process. RSS is
 * `/proc/<pid>/status`'s VmRSS, the figure earlyoom prints. The sum is
 * wrapper, main and every worker, read in one sample. A sample a second
 * misses a spike shorter than that: untraced, and cheap at ~200 stat reads.
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
const { procRoot } = require("./proc-root.js");
const { FIELD, parseStatFields } = require("./proc-stat.js");
const { refillPath } = require("./refill-dir.js");

/** The run file's path, set on vitest's environment. */
const MEMORY_ENV = "WFC_RUN_MEMORY";
const STORE_DIR = ".test-run-memory";
/* Untraced, see the header. */
const SAMPLE_MS = 1000;
/* Covers lib/incident-tickets.js's 72 h lookback and the incident gap. */
const RETAIN_MS = 4 * 24 * 60 * 60 * 1000;
/* What a run file names of its selection; the count says the rest. */
const FILES_KEPT = 10;

/**
 * @typedef {{ wrapper: number, main: number|null, workers: number[] }} RunPids
 * @typedef {{ wrapper: number, main: number, worker: number, sum: number }} PeaksMiB
 * @typedef {{ pids: RunPids, peaksMiB: PeaksMiB, workerFile: string|null }} RunMemory
 * @typedef {{ session: string|null, kind: string, argv: string[],
 *   files: string[], fileCount: number, repo: string }} RunLaunch
 * @typedef {RunLaunch & RunMemory & { at: string, bootId: string|null,
 *   endedAt?: string }} RunFile
 */

const storeDir = () => refillPath(STORE_DIR);

/** @param {string} file */
const claimsDir = (file) => `${file}.files`;

/** @param {number} kb */
const toMiB = (kb) => Math.round(kb / 1024);

/**
 * VmRSS in kB, or null where the process is gone or the line is missing.
 * @param {string} proc @param {number} pid
 */
function readRssKb(proc, pid) {
	try {
		const m = fs
			.readFileSync(path.join(proc, String(pid), "status"), "utf8")
			.match(/^VmRSS:\s+(\d+) kB$/m);
		return m ? Number(m[1]) : null;
	} catch {
		return null;
	}
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
	return names.flatMap((name) => {
		if (!/^\d+$/.test(name)) return [];
		try {
			const fields = parseStatFields(
				fs.readFileSync(path.join(proc, name, "stat"), "utf8"),
			);
			return Number(fields?.[FIELD.ppid]) === parent ? [Number(name)] : [];
		} catch {
			return [];
		}
	});
}

/**
 * One sample of the run's processes.
 * @param {string} proc @param {number} wrapper @param {number|null} main
 * @returns {{ wrapperKb: number, mainKb: number, workers: Map<number, number> }}
 */
function sampleRun(proc, wrapper, main) {
	/** @type {Map<number, number>} */
	const workers = new Map();
	if (main !== null)
		for (const pid of readChildren(proc, main)) {
			const kb = readRssKb(proc, pid);
			if (kb !== null) workers.set(pid, kb);
		}
	return {
		wrapperKb: readRssKb(proc, wrapper) ?? 0,
		mainKb: main === null ? 0 : (readRssKb(proc, main) ?? 0),
		workers,
	};
}

/**
 * @param {string} file the run file
 * @param {number} pid
 */
function readClaim(file, pid) {
	try {
		return (
			fs.readFileSync(path.join(claimsDir(file), String(pid)), "utf8").trim() ||
			null
		);
	} catch {
		return null;
	}
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
		/* a lost reading costs the reading, never the run */
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
			if (now - fs.statSync(full).mtimeMs > RETAIN_MS)
				fs.rmSync(full, { recursive: true, force: true });
		} catch {
			/* a neighbour's sweep took it first */
		}
	}
}

/**
 * Starts sampling one run, writing its file at once.
 * @param {RunLaunch & { main: number|null }} launch
 * @param {{ wrapper?: number, proc?: string, dir?: string, intervalMs?: number,
 *   now?: () => number, bootId?: string|null }} [options]
 * @returns {{ file: string, sample: () => void, setMain: (pid: number|null) => void,
 *   current: () => RunMemory, stop: () => RunMemory }}
 */
function startSampler(
	{ main: launchedMain, ...launch },
	{
		wrapper = process.pid,
		proc = procRoot(),
		dir = storeDir(),
		intervalMs = SAMPLE_MS,
		now = Date.now,
		bootId = readCurrentBootId(),
	} = {},
) {
	let main = launchedMain;
	const startedAt = now();
	sweep(dir, startedAt);
	const file = path.join(dir, `${wrapper}-${startedAt}.json`);
	/** @type {RunFile} */
	const run = {
		at: new Date(startedAt).toISOString(),
		bootId,
		...launch,
		files: launch.files.slice(0, FILES_KEPT),
		pids: { wrapper, main, workers: [] },
		peaksMiB: { wrapper: 0, main: 0, worker: 0, sum: 0 },
		workerFile: null,
	};
	writeRun(file, run);
	/** @type {number|null} */
	let peakWorker = null;
	const sample = () => {
		const before = JSON.stringify(run);
		const s = sampleRun(proc, wrapper, main);
		const peaks = run.peaksMiB;
		for (const pid of s.workers.keys())
			if (!run.pids.workers.includes(pid)) run.pids.workers.push(pid);
		peaks.wrapper = Math.max(peaks.wrapper, toMiB(s.wrapperKb));
		peaks.main = Math.max(peaks.main, toMiB(s.mainKb));
		const [largest] = [...s.workers].sort((a, b) => b[1] - a[1]);
		if (largest && toMiB(largest[1]) > peaks.worker) {
			peaks.worker = toMiB(largest[1]);
			peakWorker = largest[0];
			run.workerFile = null;
		}
		/* A worker claims its file once loaded, which can follow its first
		 * sample. */
		if (peakWorker !== null && run.workerFile === null)
			run.workerFile = readClaim(file, peakWorker);
		const sumKb =
			s.wrapperKb +
			s.mainKb +
			[...s.workers.values()].reduce((a, b) => a + b, 0);
		peaks.sum = Math.max(peaks.sum, toMiB(sumKb));
		if (JSON.stringify(run) !== before) writeRun(file, run);
	};
	sample();
	const timer = setInterval(sample, intervalMs);
	timer.unref?.();
	return {
		file,
		sample,
		/* vitest's pid, known only once the run file's path is in its env. */
		setMain: (pid) => {
			main = pid;
			run.pids.main = pid;
			writeRun(file, run);
		},
		current: () => memoryOf(run),
		stop: () => {
			clearInterval(timer);
			sample();
			run.endedAt = new Date(now()).toISOString();
			writeRun(file, run);
			try {
				fs.rmSync(claimsDir(file), { recursive: true, force: true });
			} catch {
				/* the sweep takes it */
			}
			return memoryOf(run);
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
 * Every run file in the store; one that will not parse is skipped.
 * @param {string} [dir]
 * @returns {RunFile[]}
 */
function readRunFiles(dir = storeDir()) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		if (!name.endsWith(".json")) return [];
		try {
			return [JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))];
		} catch {
			return [];
		}
	});
}

module.exports = {
	MEMORY_ENV,
	RETAIN_MS,
	claimFile,
	readRunFiles,
	readRunMemory,
	startSampler,
};
