/*
 * suite-queue.js — the suite queue's wait, shared by `run-vitest.js --queue`
 * (mantahostels#2024) and `queue-run.js` (workflow-core#1776): its
 * marker per waiter, the turn order and the gate poll. The walk over
 * `wfc-suite-queue-*.json` markers and the `(pid, start)` staleness rule for
 * one are shared with check-stale-suite-queue.js, which only reports a stale
 * marker where `queueTurn` sweeps it (mantahostels#2034).
 *
 * ONE DEFINITION, OF BOTH: the walk and the staleness rule, never restated by
 * a caller (mantahostels#2034).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SUITE_MAX } = require("./admission.js");
const { pidAlive } = require("./arbiter-proc.js");
const { shellWord } = require("./dirty-tree.js");
const { scriptPath } = require("./script-path.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/**
 * Which limb of the suite gate denied: its count cap, or its memory rung, with
 * the reading and the rung where the guard gave them.
 * @typedef {{ limb: "count" } | { limb: "memory", mb?: number, rungMb?: number }} GateDenial
 */
/** @typedef {Exclude<import("./queue-exit-log.js").QueueExitReason, "killed">} WaitExitReason */
/** @typedef {"run"|"left"|"refused"} WaitOutcome */
/** @typedef {{ pid: number, at: number, start?: number, role?: string, part?: boolean, admitted?: boolean, spawned?: boolean }} QueueRecord */
/**
 * How a waiter's admission came out: `admitted`, or yielded to another launch
 * admitted on the same poll, which joined `behind` or `ahead` of it (workflow-core#2622).
 * @typedef {"admitted"|"behind"|"ahead"} Admission
 */

const QUEUE_PREFIX = "wfc-suite-queue-";

/**
 * A process's start time, in clock ticks since boot, from `/proc/<pid>/stat`.
 *
 * `comm` is unquoted and may contain spaces and brackets, so fields are
 * counted from after the LAST `)` rather than by splitting the whole line.
 * Start time is field 22, the first field after that bracket being field 3.
 *
 * Returns 0 where it cannot be read — a kernel without procfs, another
 * namespace — and the caller then falls back to the pid alone rather than
 * treating every marker as stale.
 *
 * @param {number} pid
 * @returns {number}
 */
function startTimeOf(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[19]);
		return Number.isFinite(ticks) ? ticks : 0;
	} catch {
		return 0;
	}
}

/**
 * Whether a queue marker is stale — the process is gone, or the pid has been
 * REUSED by an unrelated process, which a leaked marker makes likely rather
 * than exotic.
 *
 * Where `start` is absent, or 0 because procfs could not be read, the check
 * falls back to liveness alone rather than sweeping something it cannot judge.
 *
 * @param {{ pid: number, start?: number }} record
 * @param {{ alive?: (pid: number) => boolean, startTime?: (pid: number) => number }} [options]
 * @returns {boolean}
 */
function isMarkerStale(
	record,
	{ alive = pidAlive, startTime = startTimeOf } = {},
) {
	const reused =
		typeof record.start === "number" &&
		record.start > 0 &&
		startTime(record.pid) !== record.start;
	return !alive(record.pid) || reused;
}

/**
 * Every `wfc-suite-queue-*.json` marker in `dir`, parsed where it will
 * parse.
 *
 * A marker that will not parse, or that names no numeric `pid`/`at`, is
 * silently skipped rather than reported: such a marker is most likely one
 * caught mid-write by `queueJoin`'s bare `writeFileSync` (no
 * temp-and-rename), a fact about timing, not about a leak.
 *
 * A directory that will not read returns `error` rather than an empty list,
 * so a caller can tell "nothing is queued" from "the read failed" — one `[]`
 * for both would read as an all-clear on a directory this process could not
 * see into at all.
 *
 * @param {string} dir
 * @param {typeof fs} [fsImpl]
 * @returns {{ markers: { file: string, record: QueueRecord }[], error: unknown }}
 */
function readMarkers(dir, fsImpl = fs) {
	let names;
	try {
		names = fsImpl.readdirSync(dir);
	} catch (error) {
		return { markers: [], error };
	}
	/** @type {{ file: string, record: QueueRecord }[]} */
	const markers = [];
	for (const name of names) {
		if (!String(name).startsWith(QUEUE_PREFIX)) continue;
		const file = path.join(dir, String(name));
		let record;
		try {
			record = JSON.parse(fsImpl.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (typeof record?.pid !== "number" || typeof record?.at !== "number")
			continue;
		markers.push({ file, record });
	}
	return { markers, error: null };
}

/**
 * Announce this waiter, so the others can order themselves against it (mantahostels#2024).
 *
 * A MARKER PER PROCESS, NOT A LOCK, and liveness alone is not self-healing: a
 * killed waiter must drop its marker on the signal that killed it, not only on
 * resolution — each waiter's signal handler does that — and the marker must carry `(pid, start)` rather than `pid` alone
 * since pids recycle (mantahostels#2034). Between them there is still no lease and no
 * expiry.
 *
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number, role?: string, part?: boolean }} [options]
 *   `role` marks a waiter session admission reads: the lander (workflow-core#2416); `part`
 *   a part-suite (workflow-core#2558)
 */
function queueJoin({
	queueDir = os.tmpdir(),
	queueFs = fs,
	pid = process.pid,
	clock = Date.now,
	role,
	part = false,
} = {}) {
	const file = path.join(queueDir, `${QUEUE_PREFIX}${pid}.json`);
	try {
		queueFs.writeFileSync(
			file,
			JSON.stringify({
				pid,
				at: clock(),
				start: startTimeOf(pid),
				...(role ? { role } : {}),
				...(part ? { part } : {}),
			}),
		);
		return file;
	} catch {
		// Unwritable queue costs the ordering, never the run.
		return "";
	}
}

/**
 * Merge `fields` into this waiter's marker, or with `admitted: false` drop
 * that stamp. Fails silent, like `queueJoin`.
 *
 * @param {string} file
 * @param {{ admitted?: boolean, spawned?: true }} fields
 */
function stampMarker(file, fields, { queueFs = fs } = {}) {
	if (!file) return;
	try {
		const record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
		const { admitted, ...rest } = { ...record, ...fields };
		queueFs.writeFileSync(
			file,
			JSON.stringify(admitted ? { ...rest, admitted } : rest),
		);
	} catch {
		/* the ordering degrades to the gate alone */
	}
}

/**
 * Whether marker `a` joined ahead of `b`. Ties break on pid so that two
 * waiters reading the same millisecond still agree on their order.
 *
 * @param {{ pid: number, at: number }} a
 * @param {{ pid: number, at: number }} b
 */
function joinedBefore(a, b) {
	return a.at < b.at || (a.at === b.at && a.pid < b.pid);
}

/**
 * Stamp this waiter's marker `admitted`, the moment its wait ends in a run and
 * before anything launches, so no other waiter's turn comes until it spawns
 * (workflow-core#2578). Then re-read the markers: two waiters whose turns came true on one
 * poll each read the gate before either stamped (workflow-core#2622). Whichever re-reads
 * second sees the other's stamp, so a waiter that finds another live marker
 * admitted and unspawned drops its stamp and yields — `behind` where that
 * marker joined ahead of it, to wait a poll, `ahead` where every such marker
 * joined behind it, to re-read at once and launch once they yield in turn.
 *
 * FAILS OPEN, silently like `queueTurn`, where there is nothing to contest
 * with: no marker of its own (an unwritable queue, `queueJoin`'s "") or a
 * queue directory that will not read. Residual: a dropped stamp that will not
 * write leaves this waiter `admitted`, holding every turn until it launches.
 *
 * @param {string} file
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: (pid: number) => boolean }} [options]
 * @returns {Admission}
 */
function queueAdmit(
	file,
	{
		queueDir = os.tmpdir(),
		queueFs = fs,
		pid = process.pid,
		alive = pidAlive,
	} = {},
) {
	stampMarker(file, { admitted: true }, { queueFs });
	if (!file) return "admitted";
	const { markers, error } = readMarkers(queueDir, queueFs);
	if (error) return "admitted";
	const records = markers.map((m) => m.record);
	const mine = records.find((r) => r.pid === pid);
	const rivals = records.filter(
		(r) =>
			r.pid !== pid &&
			r.admitted === true &&
			r.spawned !== true &&
			!isMarkerStale(r, { alive }),
	);
	if (!mine || rivals.length === 0) return "admitted";
	stampMarker(file, { admitted: false }, { queueFs });
	return rivals.some((r) => joinedBefore(r, mine)) ? "behind" : "ahead";
}

/**
 * Stamp this waiter's marker `spawned`, once vitest is up and the guard can
 * count it.
 *
 * @param {string} file
 */
function queueSpawned(file, options = {}) {
	stampMarker(file, { spawned: true }, options);
}

/**
 * The pids of the live markers `role` names, waiting or running. Sweeps
 * nothing: a stale marker is `queueTurn`'s to remove.
 *
 * @param {string} role
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {number[]}
 */
function liveRolePids(
	role,
	{ queueDir = os.tmpdir(), queueFs = fs, alive = pidAlive } = {},
) {
	return readMarkers(queueDir, queueFs)
		.markers.map((m) => m.record)
		.filter((r) => r.role === role && !isMarkerStale(r, { alive }))
		.map((r) => r.pid);
}

/** @param {string} file */
function queueLeave(file, { queueFs = fs } = {}) {
	if (!file) return;
	try {
		queueFs.unlinkSync(file);
	} catch {
		/* already gone */
	}
}

/**
 * Whether this waiter is among the `slots` oldest still alive, and so may run.
 *
 * `slots` IS SUITE_MAX, NOT 1: the guard's cap (workflow-core#159). A running run holds
 * its marker, so it keeps one of the slots until it finishes. ONE UNSPAWNED
 * LAUNCH AT A TIME (workflow-core#601): the gate counts `ps`, so waiters admitted on one
 * tick before any of them is visible would each read the same free slots and
 * overshoot the cap. No waiter's turn comes while another's marker is
 * `admitted` and unspawned, and a whole suite's turn also waits on every
 * waiter ahead having spawned.
 *
 * A PART-SUITE TAKES NO SLOT (workflow-core#2558): a marker joined `part`, a run naming
 * fewer test files than vitest has workers, which the guard never holds at its
 * count cap. IT BACKFILLS PAST WHOLE SUITES (workflow-core#2578): its turn waits on the
 * part-suites ahead alone, so a whole suite the gate still holds never holds
 * it. A whole suite is delayed only by part-suites ahead of it or already
 * admitted, each charged on the rung once spawned, and an admitted one holds
 * every turn through run-vitest.js's prep. Two waiters whose turns come true
 * on one poll are settled by `queueAdmit`'s re-read (workflow-core#2622).
 *
 * FAILS OPEN, like every other part of this wait: a queue directory that cannot
 * be read yields `true` rather than blocking the suite forever.
 */
function queueTurn({
	queueDir = os.tmpdir(),
	queueFs = fs,
	pid = process.pid,
	alive = pidAlive,
	slots = SUITE_MAX,
} = {}) {
	const { markers, error } = readMarkers(queueDir, queueFs);
	if (error) return true;
	/** @type {QueueRecord[]} */
	const live = [];
	for (const { file: full, record } of markers) {
		/* Never liveness-check THIS waiter. `alive` is a probe that can be wrong —
		 * a pid in another namespace, a hardened kernel — and a waiter that
		 * mistakenly sweeps its own marker silently gives up its place and can
		 * then be overtaken indefinitely. */
		if (record.pid !== pid && isMarkerStale(record, { alive })) {
			try {
				queueFs.unlinkSync(full);
			} catch {
				/* a neighbour swept it first */
			}
			continue;
		}
		live.push(record);
	}
	const mine = live.find((r) => r.pid === pid) ?? {
		pid,
		at: Number.POSITIVE_INFINITY,
	};
	const ahead = live.filter((r) => joinedBefore(r, mine));
	const spawned = (/** @type {{ spawned?: boolean }} */ r) =>
		r.spawned === true;
	if (live.some((r) => r.pid !== pid && r.admitted === true && !spawned(r)))
		return false;
	if (mine?.part === true)
		return ahead.filter((r) => r.part === true).every(spawned);
	return (
		ahead.filter((r) => r.part !== true).length < slots && ahead.every(spawned)
	);
}

/**
 * Whether run-vitest.js `words` make a part-suite, read by
 * lib/suite-bounded.sh, the guard's own reading (workflow-core#2558). Reads a whole suite where bash
 * will not answer, the side that costs a wait, never a kill.
 *
 * @param {string[]} words
 * @param {ExecFn} [execFn]
 * @returns {boolean}
 */
function isPartSuite(words, execFn = execFileSync) {
	try {
		execFn(
			"bash",
			[
				"-c",
				'source "$1"; shift; n=$(runner_test_file_count node run-vitest.js "$@") && ((n < SUITE_WORKERS))',
				"_",
				path.join(__dirname, "suite-bounded.sh"),
				...words,
			],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

/* The signals a waiter drops its marker on, each with the shell's exit code
 * for it, 128 + its number, so a killed waiter still reports as killed
 * (mantahostels#2034). */
const QUEUE_SIGNALS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };

/* Both guesses, set when the queue was built (mantahostels#2024) and never
 * measured: a 10 s poll asks the guard a few times a minute, and past the
 * 40-minute ceiling a wait the count cap still holds runs anyway, a refusal
 * then having spent the wait and delivered nothing. One the memory rung still
 * holds is refused (workflow-core#2421). */
const QUEUE_POLL_MS = 10_000;
const QUEUE_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * Whether the suite gate would refuse a run right now, and on which limb:
 * its count cap or its memory rung (mantahostels#2024, workflow-core#155, workflow-core#2305). Null where
 * it would not.
 *
 * `words` is the launch's own run-vitest.js argv, which the guard prices by the
 * workers its named test files can occupy (workflow-core#2558). None asks about a whole suite.
 *
 * @param {string} [scriptsDir]
 * @param {ExecFn} [execFn]
 * @param {string[]} [words]
 * @returns {GateDenial | null}
 *
 * IT ASKS THE GUARD, NEVER `ps`: a caller that matches processes itself
 * drifts from the gate (mantahostels#2024).
 *
 * FAILS OPEN. A guard that will not run must not strand the suite forever: a
 * launch that cannot be judged proceeds. A deny naming no memory limb reads as
 * the count cap's, whose timeout runs anyway (workflow-core#2421).
 */
function gateDenies(
	scriptsDir = path.join(__dirname, ".."),
	execFn = execFileSync,
	words = [],
) {
	const command = ["npm run test", ...(words.length > 0 ? ["--"] : [])]
		.concat(words.map(shellWord))
		.join(" ");
	try {
		const out = execFn(
			"bash",
			[path.join(scriptsDir, "guard-suite-concurrency.sh")],
			{
				input: JSON.stringify({
					// A session id of its own, so polling neither consumes nor
					// depends on the founder's session rule-handout latch.
					session_id: "run-vitest-queue",
					tool_name: "Bash",
					tool_input: { command },
				}),
				encoding: "utf8",
				// Cleared, not inherited: the escape read from an exporting shell
				// would stand the gate down and make every poll answer "open".
				env: {
					...process.env,
					WFC_SUITE_CONCURRENT: "",
					WFC_SUITE_GATE_LIMB: "1",
				},
			},
		);
		const text = String(out ?? "");
		if (!/"permissionDecision"\s*:\s*"deny"/.test(text)) return null;
		let mark;
		try {
			mark = JSON.parse(text).suiteGate;
		} catch {
			mark = null;
		}
		if (mark?.limb !== "memory") return { limb: "count" };
		return {
			limb: "memory",
			...(typeof mark.mb === "number" ? { mb: mark.mb } : {}),
			...(typeof mark.rungMb === "number" ? { rungMb: mark.rungMb } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * The line a wait the memory rung still holds at its timeout ends on (workflow-core#2421):
 * the reading and the rung where the guard gave them, and the reap.
 *
 * @param {string} label
 * @param {number} secs
 * @param {{ mb?: number, rungMb?: number }} denial
 * @returns {string}
 */
function memoryRefusal(label, secs, { mb, rungMb }) {
	const rung = rungMb === undefined ? "" : ` against the ~${rungMb} MB rung`;
	const reading = mb === undefined ? "" : ` (MemAvailable ${mb} MB${rung})`;
	return `${label}: gate still denies on memory after ${secs}s${reading} — refused, not run. Reap finished sessions (\`node ${scriptPath("reap-finished-sessions.js")}\`) and run it again (workflow-core#2421).\n`;
}

/**
 * Block until the gate would allow a suite and it is this run's turn, or until
 * `leave` answers a base the run's selection has emptied against (workflow-core#1158), then
 * return `run`, or `left` for the leave.
 *
 * On timeout the LAST poll's limb decides (workflow-core#2421). The count cap's runs the
 * suite ANYWAY, loudly: refusing after a long wait spends the wait and delivers
 * nothing, which is worse than one suite past a cap no measurement set. The
 * memory rung's returns `refused`, naming the reading and the reap: a suite
 * launched short of its rung risks an earlyoom freeze (docs/environment.md §6).
 * `refuseAtCeiling` refuses on the count cap too, for a waiter with a retry of
 * its own (the lander, workflow-core#2542). Its exit reason stays `timeout`, which
 * queue-exit-log.js records as ran anyway, so a waiter setting this must not
 * log there.
 *
 * `label` opens each line it prints: the waiter's own name, `--queue` or
 * `queue-run.js` (workflow-core#1776).
 *
 * `hold` is a load hold run once the wait would end in a launch, whether the
 * gate and turn opened or the ceiling came. Both are then read again before
 * anything is admitted (workflow-core#2622); a hold that refuses returns `refused`. `admit` stamps the launch (`queueAdmit`), and a yield goes back
 * to waiting: at once where an open turn yielded `ahead`, else after a poll.
 *
 * @param {{ pollMs?: number, timeoutMs?: number, gate?: () => GateDenial | null, gateExec?: ExecFn, gateWords?: string[], turn?: () => boolean, leave?: () => string|null, hold?: () => Promise<boolean>, admit?: () => Admission, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown }, label?: string, refuseAtCeiling?: boolean, onExit?: (reason: WaitExitReason, waitMs: number) => void, clock?: () => number }} [options]
 * @returns {Promise<WaitOutcome>}
 */
function waitForGate({
	pollMs = QUEUE_POLL_MS,
	timeoutMs = QUEUE_TIMEOUT_MS,
	// gateDenies' own default locates guard-suite-concurrency.sh beside the
	// core's scripts (workflow-core#1) — never a directory threaded through from the caller's host tree.
	gateExec = execFileSync,
	gateWords = [],
	gate = () => gateDenies(undefined, gateExec, gateWords),
	turn = () => true,
	leave = () => null,
	hold,
	admit = () => "admitted",
	sleepFn = (/** @type {number} */ ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	out = process.stderr,
	label = "--queue",
	refuseAtCeiling = false,
	onExit = () => {
		/* no caller listening */
	},
	clock = Date.now,
} = {}) {
	const started = clock();
	const secs = () => Math.round((clock() - started) / 1000);
	let announced = false;
	/* Whether `hold` has run since the last sleep: a reading taken after it
	 * is still fresh. */
	let held = false;
	/** @param {WaitExitReason} reason @param {WaitOutcome} outcome */
	const exit = (reason, outcome) => {
		onExit(reason, clock() - started);
		return Promise.resolve(outcome);
	};
	/** @returns {Promise<WaitOutcome>} */
	const wait = () => {
		if (!announced) {
			announced = true;
			out.write(`${label}: a suite is already running; waiting for it\n`);
		}
		held = false;
		return sleepFn(pollMs).then(step);
	};
	/**
	 * @param {() => Promise<WaitOutcome>} launch
	 * @param {boolean} atOnce
	 * @returns {Promise<WaitOutcome>}
	 */
	const admitOrYield = (launch, atOnce) => {
		const admission = admit();
		if (admission === "admitted") return launch();
		out.write(
			`${label}: another launch was admitted on the same poll — yielding to it (workflow-core#2622)\n`,
		);
		return admission === "ahead" && atOnce ? step() : wait();
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const atCeiling = (denial) => {
		if (denial?.limb === "memory") {
			out.write(memoryRefusal(label, secs(), denial));
			return exit("refused", "refused");
		}
		if (refuseAtCeiling) {
			out.write(
				`${label}: gate still denies on its count cap after ${secs()}s — refused, not run (workflow-core#2542).\n`,
			);
			return exit("timeout", "refused");
		}
		/* Not at once: a ceiling ignores the turn, so an immediate re-read
		 * would yield again on the same stamp. */
		return admitOrYield(() => {
			out.write(
				`${label}: gate still closed after ${secs()}s — running anyway\n`,
			);
			return exit("timeout", "run");
		}, false);
	};
	/** @returns {Promise<WaitOutcome>} */
	const step = () => {
		/* BOTH conditions, not either. The gate answers "is the machine free",
		 * the queue answers "is it my turn" — and a waiter that checks only the
		 * gate joins a stampede the moment the machine frees up. */
		const denial = gate();
		const open = !denial && turn();
		if (open || clock() - started >= timeoutMs) {
			if (hold && !held) {
				held = true;
				return hold().then((go) =>
					go ? step() : exit(open ? "opened" : "timeout", "refused"),
				);
			}
			if (!open) return atCeiling(denial);
			return admitOrYield(() => {
				if (announced) out.write(`${label}: gate opened after ${secs()}s\n`);
				return exit("opened", "run");
			}, true);
		}
		const emptied = leave();
		if (emptied !== null) {
			out.write(
				`${label}: after ${secs()}s ${emptied} reaches no test file, so this run leaves the queue (workflow-core#1158).\n`,
			);
			return exit("left", "left");
		}
		return wait();
	};
	return step();
}

module.exports = {
	QUEUE_SIGNALS,
	startTimeOf,
	isMarkerStale,
	readMarkers,
	queueJoin,
	queueAdmit,
	queueSpawned,
	queueLeave,
	queueTurn,
	liveRolePids,
	gateDenies,
	isPartSuite,
	waitForGate,
};
