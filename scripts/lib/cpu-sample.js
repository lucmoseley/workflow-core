/*
 * cpu-sample.js — what the machine's CPU was doing across a test run (mantahostels#1953).
 *
 * WHY A DELTA AND NOT AN INSTANT. `/proc/stat`'s cpu line is a monotone counter
 * of jiffies since boot, so a single read says nothing about now — the same trap
 * `docs/environment.md` §6 records for `SwapUsed`. Two reads bracketing the run
 * give the share of the 800% ceiling it actually ran under. `loadavg` IS an
 * instant, and is sampled at both ends for the same reason.
 *
 * WHY THE SPLIT AND NOT A TOTAL. Kernel `system` time — process-creation and
 * syscall overhead — points at a different remedy from work in `user`, so the
 * fields are kept apart (mantahostels#1953's figures: `docs/environment.md` §6).
 *
 * `nice` IS WHERE CLAUDE SESSIONS LAND, NOT `user`. They run at NI 5, so their
 * CPU is accounted to `nice` and a reader watching `user` alone sees 2-4% on a
 * saturated machine and concludes it is idle.
 *
 * IOWAIT IS EXCLUDED FROM BUSY AND REPORTED BESIDE IT: it is time no CPU was
 * running anything.
 *
 * FAILS TO null, NEVER TO A NUMBER. Every reader here is optional
 * instrumentation on a path whose real job is recording a test verdict. `/proc`
 * does not exist on macOS and its cpu line is absent on some CI runners, so
 * unreadable is the ordinary case, not the exceptional one — and the marker
 * records unknown as ABSENCE (see `markerFrom`), so a null here simply leaves
 * the block off. One exception (workflow-core#1344): `delta` throws on a sample
 * missing a count, which only a broken `sample()` could hand it.
 *
 * IT ALSO OWNS THE LOAD CEILING THAT HOLDS NEW WORK (workflow-core#830) — `overloadReading`,
 * and the suite wrapper's hold under it, `holdForLoad` — and the session
 * ceiling admission sizes CPU slots by (workflow-core#2141), `sessionCeiling`.
 */

const fs = require("node:fs");
const os = require("node:os");

/*
 * The eight fields of `/proc/stat`'s aggregate `cpu` line, in kernel order.
 * `guest` and `guest_nice` follow and are deliberately dropped: the kernel
 * already counts guest time inside `user` and `nice`, so adding them
 * double-counts. Never widen this to `v.length`.
 */
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

/* Everything that is not one of these is the CPU running something. */
const NOT_BUSY = new Set(["idle", "iowait"]);

/**
 * One reading of the aggregate cpu line plus the 1-minute load average.
 *
 * @typedef {{jiffies: Record<string, number>, total: number, load1: number|null}} CpuSample
 */

/**
 * Read `/proc/loadavg`'s first figure.
 *
 * Separate from the jiffie read so that a machine with one and not the other
 * still records what it has — they are different files and fail independently.
 * `WFC_LOADAVG` names a stand-in file, the seam `WFC_MEMINFO` gives admission's
 * tests, so a test of the overload ceiling never reads the live machine.
 *
 * @returns {number|null}
 */
function readLoad1() {
	try {
		/* parseFloat stops at the first whitespace, so it reads the first figure. */
		const n = Number.parseFloat(
			fs
				.readFileSync(process.env.WFC_LOADAVG || "/proc/loadavg", "utf8")
				.trim(),
		);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/**
 * Take one sample. `null` where `/proc/stat` has no readable aggregate cpu line.
 *
 * @returns {CpuSample|null}
 */
function sample() {
	let line;
	try {
		/*
		 * The aggregate line is the first and is prefixed `cpu ` with a space —
		 * `cpu0`, `cpu1` … follow it. Matching on the prefix without the space
		 * would take a per-core line on any kernel that reordered them.
		 */
		line = fs
			.readFileSync("/proc/stat", "utf8")
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
		/*
		 * A short line is refused rather than zero-filled: a kernel reporting six
		 * fields would otherwise read as one with zero `softirq` and zero `steal`,
		 * which is a measurement, not an absence.
		 */
		if (value === undefined) return null;
		const n = Number.parseInt(value, 10);
		if (!Number.isFinite(n)) return null;
		jiffies[field] = n;
		total += n;
	}
	return { jiffies, total, load1: readLoad1() };
}

/**
 * What the CPU did between two samples, as a percentage of the machine's whole
 * ceiling — 800% on 8 cores, matching how `docs/environment.md` §6 quotes every
 * CPU figure, so a reading here is comparable with the ones on record.
 *
 * @param {CpuSample|null} before
 * @param {CpuSample|null} after
 * @param {number} [cores]
 * @returns {{ceilingPct: number, busyPct: number, systemPct: number, nicePct: number, userPct: number, iowaitPct: number, load1: number|null}|null}
 */
function delta(before, after, cores = os.cpus()?.length || 0) {
	if (!before || !after || !cores) return null;
	const span = after.total - before.total;
	/*
	 * A NON-POSITIVE SPAN IS NOT ZERO LOAD. Two samples inside the same jiffie,
	 * or a counter that went backwards across a suspend, divide into nonsense —
	 * and a `busyPct: 0` written into a marker would read as a measured idle
	 * machine.
	 */
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
		/* Where a Claude session's CPU lands — see the header. */
		nicePct: pct("nice"),
		userPct: pct("user"),
		iowaitPct: pct("iowait"),
		/* The END sample's: it describes the window the run competed in, where the
		 * start reading describes the minute before it launched. */
		load1: after.load1,
	};
}

/*
 * THE OVERLOAD CEILING (workflow-core#830): load1 at 3 per core, 24 on this machine — why
 * 24, in `docs/environment.md` §6 *The load ceiling*. `WFC_LOAD_CEILING`
 * overrides it, and where it is unset `$HOME/.claude/load-ceiling` does, read
 * at every call so a change reaches sessions already running (workflow-core#3223); `0`
 * turns it off.
 */
const LOAD_PER_CORE_CEILING = 3;

/**
 * The load1 at or above which new work waits. `null` where the cores cannot be
 * counted or the override turns the check off.
 *
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
 * The ceiling override: `WFC_LOAD_CEILING` where set, else the host file's
 * text. An empty variable is no override and skips the file. No file is no override; a file that will not read, or holds no
 * number, keeps the default and `problem` says why (workflow-core#3223).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{text?: string, problem?: string}}
 */
function readLoadCeilingOverride(env) {
	if (env.WFC_LOAD_CEILING !== undefined) return { text: env.WFC_LOAD_CEILING };
	/* The live environment falls back to the account's home, as the session
	 * floor does; an injected one names its own or reads no file. */
	const home = env.HOME || (env === process.env ? os.homedir() : "");
	if (!home) return {};
	const file = `${home}/.claude/load-ceiling`;
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return {};
		return { problem: `${file}: ${/** @type {Error} */ (e).message}` };
	}
	if (Number.isFinite(Number.parseFloat(text))) return { text };
	return {
		problem: `${file} holds ${JSON.stringify(text.trim())}, not a number`,
	};
}

/*
 * THE SESSION CEILING (workflow-core#2141): 1.5 live sessions per core, 12 on this machine.
 * Work slows about 3.5% per point of load1 with no knee, and load1 runs about
 * 2.2 per session, a session being a `bg-pty-host` process, the unit admission
 * counts. So total progress peaks near 13 sessions and falls past it;
 * at 12 each session runs about 1.5x slower than on an idle machine. The
 * measurement is on workflow-core#2141. Where load1 lags a burst, this counts the burst.
 * `WFC_SESSION_CEILING` overrides it; `0` turns it off.
 */
const SESSIONS_PER_CORE_CEILING = 1.5;

/**
 * How many live sessions may run at once. `null` where the cores cannot be
 * counted or the override turns the check off.
 *
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
	/* An override under one would hold every slot, so it falls back to the
	 * default as an unparseable one does. */
	if (ceiling < 1) return sessionCeiling(cores, {});
	return Math.floor(ceiling);
}

/**
 * A per-core ceiling, or its override.
 * @param {string | undefined} raw the override's env value
 * @param {number} perCore
 * @param {number} cores
 * @returns {number|null}
 */
function ceilingOf(raw, perCore, cores) {
	if (raw !== undefined && raw.trim() !== "") {
		const n = Number.parseFloat(raw);
		/* An unparseable override falls back to the default rather than
		 * silently disarming the check; only a literal 0 turns it off. */
		if (n === 0) return null;
		if (Number.isFinite(n) && n > 0) return n;
	}
	return cores ? perCore * cores : null;
}

/**
 * @typedef {{overloaded: boolean, load1: number|null, ceiling: number|null, problem?: string}} LoadReading
 */

/**
 * Read load1 and judge it against the ceiling. FAILS OPEN (workflow-core#830): an
 * unreadable load or an absent ceiling is never overloaded, because the check
 * must never be why work cannot start on a machine without `/proc` — a caller
 * a human reads says so from `load1: null`.
 *
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

/**
 * The one wording of a hold, shared by every reader that prints one.
 * @param {LoadReading} load
 */
const buildOverloadText = (load) =>
	`load1 ${load.load1} is at or above the ${load.ceiling} ceiling (workflow-core#830)${load.problem ? `; ${load.problem}` : ""}`;

/* Chosen, not measured (workflow-core#830): 15 s polls a one-minute average often enough to
 * see it fall, and 5 minutes keeps a hold plus a suite inside the Bash tool's
 * 600 s foreground ceiling. Re-derive the hold if that ceiling moves. */
const LOAD_POLL_MS = 15_000;
const LOAD_HOLD_MS = 5 * 60 * 1000;

/**
 * Hold a `run-vitest.js` launch while load1 sits at or above the ceiling
 * above (workflow-core#830), resolving true to run and false to refuse.
 *
 * It REFUSES on expiry, as `waitForGate` does on the memory rung: running into an
 * overloaded machine risks a freeze (workflow-core#830), which costs every session, where a
 * refusal costs this one a retry.
 *
 * Called at run-vitest.js's ENTRY POINT, never in its `main()`: tests call
 * `main()` directly, and a live load read there would make them hang on a busy
 * machine. The entry point hands it to `main()` as `loadHold`, re-read each
 * time a `--queue` wait would end in a launch, before the gate's last read
 * (workflow-core#834, workflow-core#2622).
 *
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
				`run-vitest: REFUSED — load1 still ${r.load1}, at or above the ${r.ceiling} ceiling (workflow-core#830), after ${secs()}s. ` +
					"Retry once the load falls; `cat /proc/loadavg` reads it.\n",
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
