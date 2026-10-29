/*
 * suite-queue.js — the suite queue's wait, shared by `run-vitest.js --queue`
 * (mantahostels#2024) and `queue-run.js` (#1776): its
 * marker per waiter, the turn order and the gate poll. The walk over
 * `wfc-suite-queue-*.json` markers and the `(pid, start)` staleness rule for
 * one are shared with check-stale-suite-queue.js, which only reports a stale
 * marker where `queueTurn` sweeps it (mantahostels#2034).
 *
 * ONE DEFINITION, OF BOTH: the walk and the staleness rule, never restated by
 * a caller (mantahostels#2034).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { caught } = require("./caught.js");
const { WHOLE_SUITE_MAX } = require("./suite-ladder.js");
const { pidAlive } = require("./arbiter-proc.js");
const {
	FIELD,
	readAncestorsOf,
	readParentOf,
	readStatFields,
} = require("./proc-stat.js");
const { shellWord } = require("./dirty-tree.js");
const { scriptPath } = require("./script-path.js");
const { weighCarried } = require("./suite-bounded.js");
const { TSC_PEAK_MB, TSC_QUEUE_NAME } = require("./tsc-slot.js");

/**
 * Which limb of the suite gate denied: its count cap, or its memory rung, with
 * the reading and the rung where the guard gave them, and what the other
 * queue's launches have yet to draw where the gate charged it (#3416).
 * @typedef {{ limb: "count" } | { limb: "memory", mb?: number, rungMb?: number, climbMb?: number }} GateDenial
 */
/** @typedef {Exclude<import("./queue-exit-log.js").QueueExitReason, "killed">} WaitExitReason */
/** @typedef {"run"|"left"|"refused"} WaitOutcome */
/** @typedef {import("./queue-exit-log.js").HeldLimb} HeldLimb */
/** @typedef {{ queueFs?: typeof fs, alive?: (pid: number) => boolean, treePssKb?: (pid: number) => number, onUnread?: (dir: string, error: unknown) => void }} ClimbOptions */
/** @typedef {{ pid: number, at: number, start?: number, role?: string, chargeMb?: number, part?: boolean, admitted?: boolean, spawned?: boolean, memoryHeld?: boolean }} QueueRecord */
/**
 * How a waiter's admission came out: `admitted`, or yielded to another launch
 * admitted on the same poll, which joined `behind` or `ahead` of it (#2622).
 * @typedef {"admitted"|"behind"|"ahead"} Admission
 */
/**
 * A queued launcher's options: `waitForGate`'s own, less the `admit` it wires
 * to its marker itself, and the queue's (#2742).
 * @typedef {Omit<Parameters<typeof waitForGate>[0], "admit"> & Parameters<typeof queueJoin>[0] & Parameters<typeof queueTurn>[0]} QueuedLaunchOptions
 */

const QUEUE_PREFIX = "wfc-suite-queue-";
const QUEUE_NAME = "wfc-suite-queue";

/**
 * The queue's own directory under the temp root, which every default reads.
 * Never the root itself: a shared `/tmp` grows too large to list on every
 * admission and poll (#2889). Read at call time, so a caller's `TMPDIR`
 * redirects it.
 * @returns {string}
 */
function defaultQueueDir() {
	return path.join(os.tmpdir(), QUEUE_NAME);
}

/*
 * The queues admitting against one MemAvailable reading, the suite queue and
 * the type-check slot's (#3203), each with the peak a launch in it is charged
 * on the other's rung while it climbs (#3416). A whole suite's is off one
 * `--full --shared` run's process tree, its RSS summed each second, 28 Oct
 * 2026: 2,248 MB. One run, on a loaded machine; MOVE IT
 * ONLY WITH A RE-MEASUREMENT. A part-suite is charged the same, its peak never
 * above a whole one's.
 */
/** @type {Record<string, number>} */
const PEAK_MB = { [QUEUE_NAME]: 2248, [TSC_QUEUE_NAME]: TSC_PEAK_MB };
const ADMITTING_QUEUES = Object.keys(PEAK_MB);

/**
 * The other queues admitting against the reading `queueDir`'s does: its
 * siblings among ADMITTING_QUEUES, or none where `queueDir` is not one of
 * them.
 *
 * @param {string} queueDir
 * @returns {string[]}
 */
function peerQueueDirs(queueDir) {
	const name = path.basename(queueDir);
	if (!ADMITTING_QUEUES.includes(name)) return [];
	return ADMITTING_QUEUES.filter((n) => n !== name).map((n) =>
		path.join(path.dirname(queueDir), n),
	);
}

/**
 * Whether a marker is stamped `admitted` and not yet `spawned`: a launch about
 * to start that no `ps` count or MemAvailable reading sees yet.
 *
 * @param {QueueRecord} record
 */
function isUnspawnedAdmission(record) {
	return record.admitted === true && record.spawned !== true;
}

/**
 * The live unspawned admissions in `queueDir`'s peer queues (#3203). Sweeps
 * nothing, a peer queue's stale markers being its own `queueTurn`'s to remove.
 *
 * A PEER DIRECTORY THAT WILL NOT READ CONTRIBUTES NONE, failing open as an
 * unreadable own queue does: the peer's gate still reads
 * MemAvailable live, so what is lost is the same-poll yield, never the rung.
 *
 * @param {string} queueDir
 * @param {{ queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {QueueRecord[]}
 */
function readPeerAdmissions(queueDir, { queueFs = fs, alive = pidAlive } = {}) {
	return peerQueueDirs(queueDir).flatMap((dir) =>
		readMarkers(dir, queueFs)
			.markers.map((m) => m.record)
			.filter((r) => isUnspawnedAdmission(r) && !isMarkerStale(r, { alive })),
	);
}

/**
 * What the launches in `queueDirs` have yet to draw, in MB (#3416): each live
 * marker stamped `spawned` is charged its queue's peak less its process
 * tree's PSS, never below 0. MemAvailable counts a launch only as far
 * as it has climbed, so a gate reading it live charges the rest itself. A
 * launch admitted and unspawned closes the turn instead (`readTurn`).
 *
 * CHARGED FOR AS LONG AS ITS MARKER LIVES, not for a climb window: a `tsc`
 * peaks at its end, a marker may hold several in series, and a suite's draw
 * swings back to near its peak late in its run. A tree's PSS reads at most
 * its RSS, against peaks measured as RSS, so the charge errs high. A
 * directory that will not read charges none, handed to `onUnread`.
 *
 * @param {string[]} queueDirs
 * @param {ClimbOptions} [options]
 * @returns {number}
 */
function readClimbMb(
	queueDirs,
	{
		queueFs = fs,
		alive = pidAlive,
		/* Required at the call: admission.js costs a hook ~65 ms to load. */
		treePssKb = (pid) => require("./admission.js").readTreePssKb(pid),
		onUnread = () => undefined,
	} = {},
) {
	let mb = 0;
	for (const dir of queueDirs) {
		const peakMb = PEAK_MB[path.basename(dir)] ?? 0;
		const { markers, error } = readMarkers(dir, queueFs);
		if (error) onUnread(dir, error);
		for (const { record } of markers) {
			if (record.spawned !== true || isMarkerStale(record, { alive })) continue;
			mb += Math.max(0, peakMb - Math.floor(treePssKb(record.pid) / 1024));
		}
	}
	return mb;
}

/**
 * What `queueDir`'s peer queues' launches have yet to draw, in MB: the charge
 * a queued gate takes, its own queue's launches being its turn's to order.
 * @param {string} queueDir
 * @param {ClimbOptions} [options]
 */
const readPeerClimbMb = (queueDir, options) =>
	readClimbMb(peerQueueDirs(queueDir), options);

/**
 * What every admitting queue's launches have yet to draw, in MB (#3488): the
 * charge a launch the guard judges unqueued takes, being in neither queue.
 * Read at call time, so a caller's `TMPDIR` redirects it.
 * @param {ClimbOptions} [options]
 */
const readQueuesClimbMb = (options) =>
	readClimbMb(
		[defaultQueueDir(), ...peerQueueDirs(defaultQueueDir())],
		options,
	);

/**
 * A process's start time, in clock ticks since boot, from `/proc/<pid>/stat`.
 *
 * Returns 0 where it cannot be read — a kernel without procfs, another
 * namespace — and the caller then falls back to the pid alone rather than
 * treating every marker as stale.
 *
 * @param {number} pid
 * @returns {number}
 */
function readStartTimeOf(pid) {
	const ticks = Number(readStatFields(pid)?.[FIELD.start]);
	return Number.isFinite(ticks) ? ticks : 0;
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
	{ alive = pidAlive, startTime = readStartTimeOf } = {},
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
 * silently skipped rather than reported (mantahostels#2034): such a marker is
 * most likely one caught mid-write by `queueJoin`'s bare `writeFileSync` (no
 * temp-and-rename).
 *
 * A directory that will not read returns `error` rather than an empty list,
 * so a caller can tell "nothing is queued" from "the read failed" — one `[]`
 * for both would read as an all-clear on a directory this process could not
 * see into at all. A directory that does not exist is the empty queue
 * (#2889): `queueJoin` makes it, so none has joined since the temp root was
 * cleared.
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
		if (caught(error).code === "ENOENT") return { markers: [], error: null };
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
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number, role?: string, chargeMb?: number, weight?: import("./suite-handoff.js").CarriedWeight }} [options]
 *   `role` marks a waiter session admission reads: the lander (#2416),
 *   `chargeMb` what admission holds back for it (#3323);
 *   `weight` the admission weight the launch carries (#2931), a waiter with
 *   none, such as `queue-run.js`'s, joining whole. One resolving below the
 *   whole-slot bound joins `part`, a part-suite (#2558).
 */
function queueJoin({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	clock = Date.now,
	role,
	chargeMb,
	weight,
} = {}) {
	const part = weight ? weighCarried(weight).part : false;
	const file = path.join(queueDir, `${QUEUE_PREFIX}${pid}.json`);
	try {
		queueFs.mkdirSync(queueDir, { recursive: true });
		queueFs.writeFileSync(
			file,
			JSON.stringify({
				pid,
				at: clock(),
				start: readStartTimeOf(pid),
				...(role ? { role } : {}),
				...(chargeMb === undefined ? {} : { chargeMb }),
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
 * Merge `fields` into this waiter's marker, or with `admitted: false` or
 * `memoryHeld: false` drop that stamp. Fails silent, like `queueJoin`.
 *
 * @param {string} file
 * @param {{ admitted?: boolean, spawned?: true, memoryHeld?: boolean }} fields
 */
function stampMarker(file, fields, { queueFs = fs } = {}) {
	if (!file) return;
	try {
		const record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
		const { admitted, memoryHeld, ...rest } = { ...record, ...fields };
		queueFs.writeFileSync(
			file,
			JSON.stringify({
				...rest,
				...(admitted ? { admitted } : {}),
				...(memoryHeld ? { memoryHeld } : {}),
			}),
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
 * (#2578). Then re-read the markers: two waiters whose turns came true on one
 * poll each read the gate before either stamped (#2622). Whichever re-reads
 * second sees the other's stamp, so a waiter that finds another live marker
 * admitted and unspawned drops its stamp and yields — `behind` where that
 * marker joined ahead of it, to wait a poll, `ahead` where every such marker
 * joined behind it, to re-read at once and launch once they yield in turn.
 *
 * THE RE-READ COVERS EVERY QUEUE ON THE SAME READING (#3203): its peer queues,
 * the type-check slot's queue for a suite and the suite queue for a `tsc`, so a
 * whole suite and a `tsc` admitted on one poll never both launch. The pid
 * order holds across queues.
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
		queueDir = defaultQueueDir(),
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
	const rivals = records
		.filter(
			(r) =>
				r.pid !== pid &&
				isUnspawnedAdmission(r) &&
				!isMarkerStale(r, { alive }),
		)
		.concat(readPeerAdmissions(queueDir, { queueFs, alive }));
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
 * What a queued waiter's `waitForGate` reads and writes through its queue,
 * spread into its options as one, so no queued caller wires one without the
 * others: `admit` (`queueAdmit`), `onMemoryHeld`, the `memoryHeld` stamp
 * (#3058), and `climbMb`, what its peer queues' launches have yet to draw
 * (#3416).
 *
 * @param {string} file
 * @param {Parameters<typeof queueAdmit>[1] & Parameters<typeof readPeerClimbMb>[1]} [options]
 * @returns {{ admit: () => Admission, onMemoryHeld: (memoryHeld: boolean) => void, climbMb: () => number }}
 */
function queueStamps(file, options = {}) {
	return {
		admit: () => queueAdmit(file, options),
		onMemoryHeld: (memoryHeld) => stampMarker(file, { memoryHeld }, options),
		climbMb: () =>
			readPeerClimbMb(options.queueDir ?? defaultQueueDir(), options),
	};
}

/**
 * The live markers `role` names, waiting or running. Sweeps nothing: a stale
 * marker is `queueTurn`'s to remove.
 *
 * @param {string} role
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {QueueRecord[]}
 */
function readLiveRoleMarkers(
	role,
	{ queueDir = defaultQueueDir(), queueFs = fs, alive = pidAlive } = {},
) {
	return readMarkers(queueDir, queueFs)
		.markers.map((m) => m.record)
		.filter((r) => r.role === role && !isMarkerStale(r, { alive }));
}

/* The environment variable a seat hands its driver: the seat's marker path
 * (#2918). */
const SEAT_ENV = "WFC_SUITE_SEAT";
/**
 * The marker `envName` names where this process runs inside its holder: a
 * live marker whose pid is an ancestor of `pid`. Null otherwise. Unstamped
 * `spawned` counts: the holder spawns its command only once admitted, and the
 * stamp may land after a fast command reads it (#3404).
 *
 * THE ANCESTRY IS THE CHECK, not the variable: an environment leaks into any
 * process its holder starts, so a variable alone would let a run outside the
 * holder's process tree skip the queue.
 *
 * @param {string} envName
 * @param {{ env?: NodeJS.ProcessEnv, queueFs?: typeof fs, pid?: number, alive?: (pid: number) => boolean, startTime?: (pid: number) => number, parentOf?: (pid: number) => number }} [options]
 * @returns {{ file: string, record: QueueRecord } | null}
 */
function heldMarker(
	envName,
	{
		env = process.env,
		queueFs = fs,
		pid = process.pid,
		alive = pidAlive,
		startTime = readStartTimeOf,
		parentOf = readParentOf,
	} = {},
) {
	const file = env[envName];
	if (!file) return null;
	/** @type {QueueRecord} */
	let record;
	try {
		record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
	if (!record || isMarkerStale(record, { alive, startTime })) return null;
	return readAncestorsOf(pid, { parentOf }).includes(record.pid)
		? { file, record }
		: null;
}

/**
 * The part-suite seat this process runs inside (#2918): the marker `SEAT_ENV`
 * names, where `heldMarker` holds it and it is a part marker, spawned. Null otherwise,
 * and the run then queues as any other.
 *
 * Residual: the seat is priced as one part-suite, but nothing counts the runs
 * inside it, so a driver running its mutants in parallel passes the count cap
 * with only the memory rung to hold it.
 *
 * @param {Parameters<typeof heldMarker>[1]} [options]
 * @returns {string | null}
 */
function heldSeat(options = {}) {
	const held = heldMarker(SEAT_ENV, options);
	return held?.record.part === true && held.record.spawned === true
		? held.file
		: null;
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
 * `slots` IS WHOLE_SUITE_MAX: one whole suite at a time (#2680). A running
 * queued run holds its marker, so it keeps the slot until it finishes. An
 * unqueued or stood-down run holds no marker: the gate holds it instead, the
 * guard counting it off `ps` at the same cap, and `waitForGate` needs both.
 * ONE UNSPAWNED LAUNCH AT A TIME (#601): the gate counts `ps`, so waiters
 * admitted on one tick before any of them is visible would each read the same
 * free slots and overshoot the cap. No waiter's turn comes while another's marker is
 * `admitted` and unspawned, and a whole suite's turn also waits on every
 * waiter ahead having spawned.
 *
 * ACROSS QUEUES TOO (#3203): no turn comes while a peer queue's marker is
 * `admitted` and unspawned (`queueAdmit`'s peer queues). Every suite-queue marker
 * counts, a part-suite's and the lander's install included. Once spawned, a
 * launch is charged on the other queue's rung while it climbs
 * (`readPeerClimbMb`). Residual: nothing orders the queues against each
 * other, so suites admitted between a `tsc`'s polls can hold its turn shut to
 * its wait bound.
 *
 * A PART-SUITE TAKES NO SLOT (#2558): a marker joined `part`, a run whose
 * carried weight resolves below the whole-slot bound (#2931), which the guard
 * never holds at its count cap. IT BACKFILLS PAST WHOLE SUITES (#2578): its turn waits on the
 * part-suites ahead alone, so a whole suite running or waiting never holds
 * it. A whole suite is delayed only by part-suites ahead of it or already
 * admitted, each charged on the rung once spawned, and an admitted one holds
 * every turn through run-vitest.js's prep. Two waiters whose turns come true
 * on one poll are settled by `queueAdmit`'s re-read (#2622).
 *
 * A PART-SUITE ALSO BACKFILLS PAST AN OLDER PART-SUITE THE MEMORY RUNG HOLDS
 * (#3058): one stamped `memoryHeld` and younger than PART_PASS_AGE_MS. Its own
 * rung is the gate's to judge, so a pass never admits a run the rung refuses;
 * a part-suite held only on its turn is never passed.
 *
 * Residual: the stamp is a poll old, so a part-suite may pass one whose
 * memory freed since; and a drop that will not write leaves the stamp, letting
 * younger ones pass until the age bound.
 *
 * FAILS OPEN, like every other part of this wait: a queue directory that cannot
 * be read yields `true` rather than blocking the suite forever.
 *
 * @param {Parameters<typeof readTurn>[0]} [options]
 */
function queueTurn(options = {}) {
	return readTurn(options).open;
}

/**
 * `queueTurn`'s reading, with how many older part-suites an open part-suite
 * turn passed (#3115): 0 where it passed none, absent on a whole suite's turn
 * or a closed one.
 *
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: typeof pidAlive, slots?: number, clock?: () => number }} [options]
 * @returns {{ open: boolean, passed?: number }}
 */
function readTurn({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	alive = pidAlive,
	slots = WHOLE_SUITE_MAX,
	clock = Date.now,
} = {}) {
	const { markers, error } = readMarkers(queueDir, queueFs);
	if (error) return { open: true };
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
	if (live.some((r) => r.pid !== pid && isUnspawnedAdmission(r)))
		return { open: false };
	if (readPeerAdmissions(queueDir, { queueFs, alive }).length > 0)
		return { open: false };
	const isPassable = (/** @type {QueueRecord} */ r) =>
		r.memoryHeld === true && clock() - r.at < PART_PASS_AGE_MS;
	if (mine?.part === true) {
		const waiting = ahead.filter((r) => r.part === true && !spawned(r));
		return waiting.every(isPassable)
			? { open: true, passed: waiting.length }
			: { open: false };
	}
	return {
		open:
			ahead.filter((r) => r.part !== true).length < slots &&
			ahead.every(spawned),
	};
}

/**
 * A queued waiter's turn, and the extra fields for its exit line: `passed`,
 * from the turn read that opened it (#3115), on an `opened` exit alone. Every
 * other exit may follow polls the gate denied before reading the turn, so the
 * last count read there could be stale.
 *
 * @param {Parameters<typeof readTurn>[0]} [options]
 * @returns {{ turn: () => boolean, exitFields: (reason: WaitExitReason, heldBy?: { limb: HeldLimb }) => object }}
 */
function passingTurn(options = {}) {
	/** @type {number | undefined} */
	let passed;
	return {
		turn: () => {
			const reading = readTurn(options);
			passed = reading.passed;
			return reading.open;
		},
		exitFields: (reason, heldBy) => ({
			...heldBy,
			...(reason === "opened" && passed !== undefined ? { passed } : {}),
		}),
	};
}

/* The age past which no part-suite passes an older one the memory rung holds
 * (#3058), so passing never starves it: the p90 of opened part-suite waits the
 * memory rung held, rounded up to the minute, from the replay's memory-held
 * line over the window after #3246's WSL change. p90 is a chosen rate, not a
 * measured safe pass time. Its figure and window are on #3361. */
const PART_PASS_AGE_MS = 7 * 60 * 1000;

/* The signals a waiter drops its marker on, each with the shell's exit code
 * for it, 128 + its number (mantahostels#2034). */
const QUEUE_SIGNALS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };

/* Both guesses, set when the queue was built (mantahostels#2024) and never
 * measured: a 10 s poll asks the guard a few times a minute, and the wait is
 * bounded at 40 minutes. */
const QUEUE_POLL_MS = 10_000;
const QUEUE_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * Whether the suite gate would refuse a run right now, and on which limb:
 * its count cap or its memory rung (mantahostels#2024, #155, #2305). Null where
 * it would not.
 *
 * `words` is the launch's own run-vitest.js argv, and `weight` the admission
 * weight its launch record carries (#2931), which the guard prices in place of
 * the files the words name. Neither asks about a whole suite.
 *
 * IT ASKS THE GUARD'S OWN CORE, NEVER `ps`: a caller that matches processes
 * itself drifts from the gate (mantahostels#2024).
 *
 * FAILS OPEN, so an unreadable gate never strands the suite: a launch that
 * cannot be judged proceeds (mantahostels#2024).
 * @param {string[]} [words]
 * @param {(command: string, weight: import("./suite-handoff.js").CarriedWeight | null, climbMb: number) => GateDenial | null} [read]
 *   the gate's reading of a command
 * @param {import("./suite-handoff.js").CarriedWeight | null} [weight]
 * @param {number} [climbMb]
 * @returns {GateDenial | null}
 */
function gateDenies(
	words = [],
	read = (command, carried, climb) =>
		require("./suite-concurrency-host.js").readGate(
			command,
			undefined,
			carried,
			climb,
		),
	weight = null,
	climbMb = 0,
) {
	const command = ["npm run test", ...(words.length > 0 ? ["--"] : [])]
		.concat(words.map(shellWord))
		.join(" ");
	try {
		return read(command, weight, climbMb);
	} catch (err) {
		try {
			require("./arbiter-core.js").logError(
				"suite-queue.js",
				err,
				"gate unreadable — the run proceeds",
			);
		} catch {
			/* A log that cannot be written must not strand the suite. */
		}
		return null;
	}
}

/**
 * What held a wait the gate's memory rung did not: the count cap where the
 * gate denied, else the queue's turn.
 *
 * @param {GateDenial | null} denial
 * @returns {Exclude<HeldLimb, "memory">}
 */
function heldLimb(denial) {
	return denial ? "count" : "turn";
}

const HELD_LINE = {
	count: "gate still denies on its count cap",
	turn: "turn still closed",
};

/**
 * The line a wait the memory rung still holds at its timeout ends on (#2421):
 * the reading, the other queue's climb charged on it (#3416) and the rung
 * where the guard gave them, and the reap.
 *
 * @param {string} label
 * @param {number} secs
 * @param {{ mb?: number, rungMb?: number, climbMb?: number }} denial
 * @returns {string}
 */
function memoryRefusal(label, secs, { mb, rungMb, climbMb }) {
	const rung = rungMb === undefined ? "" : ` against the ~${rungMb} MB rung`;
	const climb = climbMb
		? `, less ${climbMb} MB the other queue's launches have yet to draw${rung ? "," : ""}`
		: "";
	const reading =
		mb === undefined ? "" : ` (MemAvailable ${mb} MB${climb}${rung})`;
	return `${label}: gate still denies on memory after ${secs}s${reading} — refused, not run. Reap finished sessions (\`node ${scriptPath("reap-finished-sessions.js")}\`) and run it again (#2421).\n`;
}

/**
 * Block until the gate would allow a suite and it is this run's turn, or until
 * `leave` answers a base the run's selection has emptied against (#1158), then
 * return `run`, or `left` for the leave.
 *
 * On timeout the LAST poll decides. A whole suite still held — on the count
 * cap, the memory rung or a closed turn — returns `refused`, naming the bound
 * (#2714). A `part` suite takes no whole-suite slot, so only its memory rung
 * refuses it, a suite launched short of its rung risking an earlyoom freeze
 * (docs/environment.md §6, #2421); held on the count cap or the turn it runs
 * ANYWAY.
 *
 * Residual: a turn ahead that never spawns — a leaked marker, an open
 * watcher — gets every whole-suite waiter behind it refused at the bound
 * rather than run.
 *
 * `label` opens each line it prints: the waiter's own name, `--queue` or
 * `queue-run.js` (#1776). `waiting` is the line a held wait opens with, and
 * `cap` the one-at-a-time rule a count-cap refusal cites: a suite's by default, a
 * type-check's under `queue-run.js --tsc` (#3163).
 *
 * `hold` is a load hold run once the wait would end in a launch, whether the
 * gate and turn opened or the ceiling came. Both are then read again before
 * anything is admitted (#2622); a hold that refuses returns `refused`. `admit` stamps the launch (`queueAdmit`), and a yield goes back
 * to waiting: at once where an open turn yielded `ahead`, else after a poll.
 * `admit` is REQUIRED, and refused at entry when missing, so no launch goes
 * unstamped (#2742); a caller with no queue passes its stub on purpose.
 *
 * `onMemoryHeld` hears whether the memory rung holds the wait, each time that
 * changes: a queued caller stamps its marker with it (`queueStamps`, #3058).
 *
 * `climbMb` is read each poll and handed to `gate` to charge on its memory
 * rung (#3416).
 *
 * @param {{ pollMs?: number, timeoutMs?: number, gate?: (climbMb: number) => GateDenial | null, climbMb?: () => number, gateRead?: Parameters<typeof gateDenies>[1], gateWords?: string[], gateWeight?: import("./suite-handoff.js").CarriedWeight | null, turn?: () => boolean, leave?: () => string|null, hold?: () => Promise<boolean>, admit: () => Admission, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown }, label?: string, waiting?: string, cap?: string, part?: boolean, onMemoryHeld?: (held: boolean) => void, onExit?: (reason: WaitExitReason, waitMs: number, heldBy?: { limb: HeldLimb }) => void, clock?: () => number }} options
 * @returns {Promise<WaitOutcome>}
 */
function waitForGate({
	pollMs = QUEUE_POLL_MS,
	timeoutMs = QUEUE_TIMEOUT_MS,
	gateRead,
	gateWords = [],
	gateWeight = null,
	gate = (charged) => gateDenies(gateWords, gateRead, gateWeight, charged),
	climbMb = () => 0,
	turn = () => true,
	leave = () => null,
	hold,
	admit,
	sleepFn = (/** @type {number} */ ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	out = process.stderr,
	label = "--queue",
	waiting = "a suite is already running; waiting for it",
	cap = "one whole suite runs at a time (#2714)",
	part = false,
	onMemoryHeld = () => {
		/* no marker to stamp */
	},
	onExit = () => {
		/* no caller listening */
	},
	clock = Date.now,
}) {
	if (typeof admit !== "function")
		throw new TypeError("waitForGate: `admit` is required (#2742)");
	const started = clock();
	const secs = () => Math.round((clock() - started) / 1000);
	let announced = false;
	/* Whether `hold` has run since the last sleep: a reading taken after it
	 * is still fresh. */
	let held = false;
	let memoryHeld = false;
	/** @param {WaitExitReason} reason @param {WaitOutcome} outcome @param {HeldLimb} [limb] */
	const exit = (reason, outcome, limb) => {
		onExit(reason, clock() - started, ...(limb ? [{ limb }] : []));
		return Promise.resolve(outcome);
	};
	/** @returns {Promise<WaitOutcome>} */
	const wait = () => {
		if (!announced) {
			announced = true;
			out.write(`${label}: ${waiting}\n`);
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
			`${label}: another launch was admitted on the same poll — yielding to it (#2622)\n`,
		);
		return admission === "ahead" && atOnce ? step() : wait();
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const refuse = (denial) => {
		if (denial?.limb === "memory") {
			out.write(memoryRefusal(label, secs(), denial));
			return exit("refused", "refused", "memory");
		}
		const limb = heldLimb(denial);
		out.write(
			`${label}: ${HELD_LINE[limb]} after ${secs()}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: ${cap}.\n`,
		);
		return exit("refused", "refused", limb);
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const runAnyway = (denial) =>
		/* Not at once: the bound ignores the turn, so an immediate re-read
		 * would yield again on the same stamp. */
		admitOrYield(() => {
			out.write(
				`${label}: gate still closed after ${secs()}s — running anyway\n`,
			);
			return exit("timeout", "run", heldLimb(denial));
		}, false);
	/**
	 * @param {GateDenial | null} denial
	 * @param {boolean} open
	 * @returns {Promise<WaitOutcome>}
	 */
	const proceed = (denial, open) => {
		if (hold && !held) {
			held = true;
			return hold().then((go) => (go ? step() : exit("refused", "refused")));
		}
		if (!open)
			return denial?.limb === "memory" ? refuse(denial) : runAnyway(denial);
		return admitOrYield(() => {
			if (announced) out.write(`${label}: gate opened after ${secs()}s\n`);
			return exit("opened", "run");
		}, true);
	};
	/** @returns {Promise<WaitOutcome>} */
	const step = () => {
		/* BOTH conditions, not either. The gate answers "is the machine free",
		 * the queue answers "is it my turn" — and a waiter that checks only the
		 * gate joins a stampede the moment the machine frees up. */
		const denial = gate(climbMb());
		if ((denial?.limb === "memory") !== memoryHeld) {
			memoryHeld = !memoryHeld;
			onMemoryHeld(memoryHeld);
		}
		const open = !denial && turn();
		if (!open && clock() - started >= timeoutMs)
			return part ? proceed(denial, false) : refuse(denial);
		if (open) return proceed(denial, true);
		const emptied = leave();
		if (emptied !== null) {
			out.write(
				`${label}: after ${secs()}s ${emptied} reaches no test file, so this run leaves the queue (#1158).\n`,
			);
			return exit("left", "left");
		}
		return wait();
	};
	return step();
}

module.exports = {
	PART_PASS_AGE_MS,
	QUEUE_SIGNALS,
	SEAT_ENV,
	heldMarker,
	heldSeat,
	defaultQueueDir,
	readStartTimeOf,
	isMarkerStale,
	readMarkers,
	queueJoin,
	queueAdmit,
	queueSpawned,
	queueStamps,
	queueLeave,
	queueTurn,
	passingTurn,
	readLiveRoleMarkers,
	readQueuesClimbMb,
	gateDenies,
	waitForGate,
};
