/*
 * suite-queue.js — the suite queue's wait, shared by `run-vitest.js --queue`
 * (mantahostels#2024) and `queue-run.js` (#1776): its
 * marker per waiter, the turn order and the gate poll. The walk over
 * `wfc-suite-queue-*.json` markers and the `(pid, start)` staleness rule for
 * one are shared with check-stale-suite-queue.js, which only reports a stale
 * marker where `readTurn` sweeps it (mantahostels#2034).
 *
 * ONE DEFINITION, OF BOTH: the walk and the staleness rule, never restated by
 * a caller (mantahostels#2034).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { caught } = require("./caught.js");
const {
	WHOLE_SUITE_MAX,
	isNextRunnerLine,
	isVitestRunnerLine,
	readCarriedWeightOf,
	readPs,
} = require("./suite-ladder.js");
const { pidAlive } = require("./arbiter-proc.js");
const {
	FIELD,
	readAncestorsOf,
	readParentOf,
	readStatFields,
} = require("./proc-stat.js");
const { shellQuote } = require("./sh-quote.js");
const { isOtherRunner } = require("./suite-launch.js");
const { scriptPath } = require("./script-path.js");
const { vitestLineSize, weighCarried } = require("./suite-bounded.js");
const { TSC_PEAK_MB, TSC_QUEUE_NAME, isTscRunner } = require("./tsc-slot.js");

/**
 * Which limb of the suite gate denied: its count cap, with the PIDs holding it
 * where the gate read them (#4359), or its memory rung, with the reading and
 * the rung where the guard gave them, and what the other queue's launches have
 * yet to draw where the gate charged it (#3416).
 * A count denial carries the memory reading where the rung fails too (#4359).
 * @typedef {{ mb?: number, rungMb?: number, climbMb?: number }} MemoryReading
 * @typedef {{ limb: "windows", mb: number, needMb: number }} WindowsHold
 * @typedef {{ limb: "count", pids?: (number | null)[], memory?: MemoryReading } | ({ limb: "memory" } & MemoryReading) | WindowsHold} GateDenial
 */
/**
 * Why a turn is closed, by whom (#4359): `fifo`, the waiters joined ahead,
 * by PID; `admitted`, the launches admitted and not yet up, by PID and queue;
 * `peer`, the other queue's older waiters the climb charge holds (#4760).
 * @typedef {{ limb: "fifo", pids: number[] } | { limb: "admitted" | "peer", holders: { pid: number, queue: string }[] }} TurnHold
 */
/** @typedef {Exclude<import("./queue-exit-log.js").QueueExitReason, "killed">} WaitExitReason */
/** @typedef {"run"|"left"|"refused"} WaitOutcome */
/** @typedef {import("./queue-exit-log.js").HeldLimb} HeldLimb */
/**
 * What a wait's exit line records of what held it: `limb` at the queue's bound,
 * and `climbMb`, the highest charge a poll was held on (`heldOnClimbMb`).
 * @typedef {{ limb?: HeldLimb, climbMb?: number }} WaitHold
 */
/** @typedef {{ queueFs?: typeof fs, alive?: (pid: number) => boolean, treePssKb?: (pid: number) => number, onUnread?: (dir: string, error: unknown) => void, ps?: typeof readPs, parentOf?: (pid: number) => number, carriedOf?: typeof readCarriedWeightOf, rungQueue?: string | null }} ClimbOptions */
/**
 * Which climb a launch the guard judges unqueued pays (#4111): `"all"`, both
 * queues' climb, or `"off-rung"`, what its suite rung does not count already.
 * @typedef {"all" | "off-rung"} ClimbScope
 */
/** @typedef {{ pid: number, at: number, start?: number, role?: string, chargeMb?: number, part?: boolean, files?: number, admitted?: boolean, spawned?: boolean, memoryHeld?: boolean, windowsHeld?: boolean, climbHeld?: boolean, yielding?: boolean }} QueueRecord */
/**
 * How a waiter's admission came out: `admitted`, or yielded to another launch
 * admitted on the same poll, which joined `behind` or `ahead` of it (#2622).
 * @typedef {"admitted"|"behind"|"ahead"} Admission
 */
/**
 * A queued launcher's options: `waitForGate`'s own, less the `admit` it wires
 * to its marker itself, and the queue's (#2742).
 * @typedef {Omit<Parameters<typeof waitForGate>[0], "admit"> & Parameters<typeof queueJoin>[0] & Parameters<typeof readTurn>[0]} QueuedLaunchOptions
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
 * on the other's rung while it climbs (#3416). A whole suite's is the highest
 * of six `npm run test -- --full=<cause> --shared --shard=k/2` runs, three of
 * each shard, 9 Nov 2026 on a loaded machine, each run's process tree PSS
 * sampled each second from its spawn: 1,208-1,929 MB (#4592), the highest
 * from a run the 840 s suite ceiling killed, 921 s after its `npm` spawned
 * and 422 s after its peak. Shards, since an unsharded run meets the ceiling
 * about halfway. The lander record's whole runs, 28 Oct - 5 Nov, peaked at
 * most 1,820 MB on any day but 4 Nov; that day's 2,087-2,627 MB was its tree,
 * which reproduced at 2,632-2,743 MB, the file that drove it unnamed. No
 * margin, the rung holding DRAW_MARGIN_MB. MOVE IT ONLY WITH A RE-MEASUREMENT.
 * Residual: an unsharded run, charged this, is unmeasured; a tree regressing
 * as 4 Nov's did is charged ~800 MB short; a spike between samples, short.
 */
/** @type {Record<string, number>} */
const PEAK_MB = { [QUEUE_NAME]: 1929, [TSC_QUEUE_NAME]: TSC_PEAK_MB };
const ADMITTING_QUEUES = Object.keys(PEAK_MB);

/*
 * A part-suite's peak (#3806): the line over the highest process tree PSS of 33
 * recorded part-suites, sampled each second, 2 Nov 2026, the five largest test
 * files by bytes among them. By workers at 1-5: 543, 547, 738, 939, 1,204 MB up
 * to 36 files; 96 and 120 files at 5 workers reached 1,539 and 1,482 MB. Never
 * above the whole suite's, and with no margin, the rung holding DRAW_MARGIN_MB.
 * Residual: a part-suite peaking above this line is charged short by the
 * difference.
 */
const PART_BASE_MB = 380;
const PART_WORKER_MB = 175;
const PART_FILE_MB = 3;

/**
 * The peak a marker in queue `name` is charged against: one carrying its own
 * measured charge, a lander's (#3973), that; a part-suite's by the test files
 * it resolved to; any other's its queue's. A part marker with no file count, a
 * run not counted at admission, takes its queue's.
 *
 * @param {string} name
 * @param {Pick<QueueRecord, "part" | "files" | "chargeMb">} record
 * @returns {number}
 */
function peakMbOf(name, record) {
	if (Number.isFinite(record.chargeMb)) return Number(record.chargeMb);
	const queuePeak = PEAK_MB[name] ?? 0;
	const { part, files } = record;
	if (name !== QUEUE_NAME || part !== true || files === undefined)
		return queuePeak;
	const { workers } = weighCarried({ resolvedFiles: files, wholeSlot: false });
	return Math.min(
		queuePeak,
		PART_BASE_MB + PART_WORKER_MB * workers + PART_FILE_MB * files,
	);
}

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
 * The live markers in `queueDir`'s peer queues that `keep` accepts, each with
 * its queue's name. Sweeps nothing, a peer queue's stale markers being its own
 * `readTurn`'s to remove.
 *
 * A PEER DIRECTORY THAT WILL NOT READ CONTRIBUTES NONE, failing open as an
 * unreadable own queue does. What is lost is the ordering against that queue:
 * the same-poll yield (#3203) and the climb yield (#4760).
 *
 * @param {string} queueDir
 * @param {(record: QueueRecord) => boolean} keep
 * @param {{ queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {(QueueRecord & { queue: string })[]}
 */
function readPeerMarkers(
	queueDir,
	keep,
	{ queueFs = fs, alive = pidAlive } = {},
) {
	return peerQueueDirs(queueDir).flatMap((dir) =>
		readMarkers(dir, queueFs)
			.markers.map((m) => ({ ...m.record, queue: path.basename(dir) }))
			.filter((r) => keep(r) && !isMarkerStale(r, { alive })),
	);
}

/**
 * The live launches admitted and unspawned besides `pid`'s: those in
 * `records`, `queueDir`'s own markers, then its peer queues', each with its
 * queue's name.
 *
 * @param {QueueRecord[]} records
 * @param {string} queueDir
 * @param {{ pid: number, queueFs: typeof fs, alive: (pid: number) => boolean }} options
 * @returns {(QueueRecord & { queue: string })[]}
 */
function openAdmissions(records, queueDir, { pid, queueFs, alive }) {
	const queue = path.basename(queueDir);
	return records
		.filter(
			(r) =>
				r.pid !== pid &&
				isUnspawnedAdmission(r) &&
				!isMarkerStale(r, { alive }),
		)
		.map((r) => ({ ...r, queue }))
		.concat(
			readPeerMarkers(queueDir, isUnspawnedAdmission, { queueFs, alive }),
		);
}

/**
 * The live waiters in `queueDir`'s peer queues that joined before `mine` and
 * that the climb charge holds (#4760): stamped `climbHeld`, neither admitted
 * nor spawned (`readPeerMarkers`).
 *
 * @param {string} queueDir
 * @param {Pick<QueueRecord, "pid" | "at">} mine
 * @param {{ queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {{ pid: number, queue: string }[]}
 */
function readPeerClimbHeld(queueDir, mine, options = {}) {
	return readPeerMarkers(
		queueDir,
		(r) =>
			r.climbHeld === true &&
			r.admitted !== true &&
			r.spawned !== true &&
			joinedBefore(r, mine),
		options,
	).map(({ pid, queue }) => ({ pid, queue }));
}

/**
 * What the launches in `queueDirs` have yet to draw, in MB (#3416): each live
 * marker stamped `spawned` is charged its peak (`peakMbOf`) less its process
 * tree's PSS, never below 0. MemAvailable counts a launch only as far
 * as it has climbed, so a gate reading it live charges the rest itself. A
 * launch admitted and unspawned closes the turn instead (`readTurn`).
 *
 * CHARGED FOR AS LONG AS ITS MARKER LIVES, not for a climb window: a `tsc`
 * peaks at its end, a marker may hold several in series, and a suite's draw
 * swings back to near its peak late in its run. Save a held seat stamped
 * `yielding` (#4766): its next run waits on a peer the climb holds, nothing
 * of its tree climbs, and its charge would hold that peer in turn. A tree's PSS reads at most
 * its RSS, against peaks measured as RSS, so the charge errs high. A
 * directory that will not read charges none, handed to `onUnread`.
 *
 * A launch holding no marker is charged the same way, read off `ps`
 * (`readUnmarkedRunners`, #3615).
 *
 * `rungQueue` names the queue whose launches on `ps` the caller's rung counts
 * (#4111): its runners holding no marker are charged nothing, and its markers
 * only while no runner of theirs is on `ps` yet, the gap between a spawn and
 * its vitest's first `ps` row.
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
		onUnread = logClimbUnread,
		ps = readPs,
		parentOf = readParentOf,
		carriedOf = readCarriedWeightOf,
		rungQueue = null,
	} = {},
) {
	const { runners, unmarked } = readUnmarkedRunners(queueDirs, {
		queueFs,
		alive,
		onUnread,
		ps,
		parentOf,
	});
	const onRung = readRungPids(runners, rungQueue, parentOf);
	const charges = queueDirs.flatMap((dir) => {
		const name = path.basename(dir);
		const { markers, error } = readMarkers(dir, queueFs);
		if (error) onUnread(dir, error);
		return markers
			.map((m) => m.record)
			.filter(
				(r) =>
					r.spawned === true &&
					r.yielding !== true &&
					!isMarkerStale(r, { alive }) &&
					!(name === rungQueue && onRung.has(r.pid)),
			)
			.map((r) => ({ peakMb: peakMbOf(name, r), pid: r.pid }));
	});
	const names = queueDirs.map((dir) => path.basename(dir));
	const bare = unmarked.flatMap((row) => {
		const runner = runnerOf(row.args);
		const charged =
			runner !== undefined &&
			(runner.queue === null ||
				(runner.queue !== rungQueue && names.includes(runner.queue)));
		return charged
			? [{ peakMb: runner.peakMbOf(row, carriedOf), pid: row.pid }]
			: [];
	});
	return [...charges, ...bare].reduce(
		(mb, { peakMb, pid }) =>
			mb + Math.max(0, peakMb - Math.floor(treePssKb(pid) / 1024)),
		0,
	);
}

/**
 * The pids `rungQueue`'s runners on `ps` sit under, themselves included: a
 * marker holding one is a launch the caller's rung counts (#4111).
 * @param {{ pid: number, args: string }[]} runners
 * @param {string | null} rungQueue
 * @param {(pid: number) => number} parentOf
 * @returns {Set<number>}
 */
function readRungPids(runners, rungQueue, parentOf) {
	if (rungQueue === null) return new Set();
	return new Set(
		runners
			.filter((r) => runnerOf(r.args)?.queue === rungQueue)
			.flatMap(({ pid }) => [pid, ...readAncestorsOf(pid, { parentOf })]),
	);
}

/**
 * A climb read that came up short, on the guard-error log.
 * @param {string} what
 * @param {unknown} error
 */
function logClimbUnread(what, error) {
	require("./arbiter-core.js").logError(
		"suite-queue.js",
		error,
		`${what} unreadable — its launches' climb charged none`,
	);
}

/*
 * The peaks of the runners on no ladder or slot of the queues' own, each
 * measured as #3806 measured a part-suite (#4112): the process tree's PSS
 * sampled each second, 8 Nov 2026, on a loaded machine.
 *
 * pytest by xdist workers, 15 runs of two repos' suites: at 0 (`-n 0`), 1, 2,
 * 4 and 8 (`-n auto`) the highest read 144, 169, 256, 424 and 724 MB. The line
 * over them, no margin, as a part-suite's.
 *
 * `node --test`, one repo's 35-file suite: 363 and 381 MB at its default
 * concurrency, 323 MB at 1.
 *
 * `next build`, one site's: 972 and 979 MB cold, 624 MB warm.
 *
 * MOVE ONE ONLY WITH A RE-MEASUREMENT. Residual: a suite or site heavier than
 * the one measured is charged short by the difference; pytest's workers set in
 * its config's `addopts` are read as none; a `python3 -m unittest` or bare
 * Python test file, unmeasured, is charged pytest's line at no workers; an
 * `auto` run is charged a worker a CPU, never capped by `--maxprocesses`,
 * `PYTEST_XDIST_AUTO_NUM_WORKERS` or physical cores, so it errs high.
 */
const PYTEST_BASE_MB = 150;
const PYTEST_WORKER_MB = 75;
const NODE_TEST_PEAK_MB = 381;
const NEXT_BUILD_PEAK_MB = 979;

/**
 * The xdist workers a pytest line asks for: `-n`'s value, a CPU each for
 * `auto` or `logical`, none where it names none.
 * @param {string} args
 */
function pytestWorkersOf(args) {
	const value = /(?:^| )(?:-n[ =]?|--numprocesses[ =])(\S+)/.exec(args)?.[1];
	if (value === "auto" || value === "logical") return os.availableParallelism();
	const workers = Number(value);
	return Number.isInteger(workers) && workers > 0 ? workers : 0;
}

/** @param {string} args */
const isNodeLine = (args) => /^ *(\S*\/)?node(js)?( |$)/.test(args);

/** @param {string} args */
const isOtherSuiteLine = (args) =>
	isOtherRunner(args.trim().split(/\s+/), () => []);

/**
 * The runners `readClimbMb` charges holding no marker, each with the queue
 * whose gate counts it on its own rung or slot, or null for one no gate
 * counts, and its peak.
 * @type {{ queue: string | null, isRunner: (args: string) => boolean, peakMbOf: (row: { pid: number, args: string }, carriedOf: typeof readCarriedWeightOf) => number }[]}
 */
const RUNNERS = [
	{
		queue: QUEUE_NAME,
		isRunner: isVitestRunnerLine,
		peakMbOf: ({ pid, args }, carriedOf) =>
			peakMbOf(QUEUE_NAME, vitestLineSize(args, carriedOf(pid))),
	},
	{
		queue: QUEUE_NAME,
		isRunner: (args) => isOtherSuiteLine(args) && isNodeLine(args),
		peakMbOf: () => NODE_TEST_PEAK_MB,
	},
	{
		queue: QUEUE_NAME,
		isRunner: (args) => isOtherSuiteLine(args) && !isNodeLine(args),
		peakMbOf: ({ args }) =>
			PYTEST_BASE_MB + PYTEST_WORKER_MB * pytestWorkersOf(args),
	},
	{ queue: TSC_QUEUE_NAME, isRunner: isTscRunner, peakMbOf: () => TSC_PEAK_MB },
	{
		queue: null,
		isRunner: (args) => isNextRunnerLine("build", args),
		peakMbOf: () => NEXT_BUILD_PEAK_MB,
	},
];

/** @param {string} args */
const runnerOf = (args) => RUNNERS.find((r) => r.isRunner(args));

/**
 * The running launches of a `RUNNERS` class in no queue (#3615, #4112): a bare
 * launch the guard admitted, or one it never judged, such as a `sh -c "…"`. A
 * hook outlives no launch, so none can leave a marker, and `ps` is what shows
 * them. `readClimbMb` charges each to the queue whose gate counts it, never
 * an unqueued suite at a suite's gate (`runningSuites`).
 *
 * A RUNNER UNDER A LIVE MARKER'S PID OR ANOTHER RUNNER IS LEFT OUT: the marker
 * is charged already, and an outer runner's charge covers its tree. Markers
 * are read from the temp root `queueDirs` sit in, so a launch queued under
 * another `TMPDIR` reads as unmarked.
 *
 * FAILS OPEN, handed to `onUnread`: a `ps` that will not run charges none, and
 * a queue directory that will not read leaves its launches' runners unmarked.
 *
 * Residual:
 * - a launch is unseen from the guard's exit until its runner is on `ps`;
 * - a `tsc` whose line `isTscRunner` misses, such as one with node flags before
 *   its path, is charged nothing;
 * - a `tsc` under an unqueued vitest is charged nothing at a queued suite's gate,
 *   which does not charge that vitest;
 * - an open watcher is charged a whole suite's rest for as long as it is open,
 *   as its rung is (mantahostels#1927);
 * - a host's declared runner is charged nothing, having no measured peak.
 *
 * @param {string[]} queueDirs
 * Returns every runner on `ps` too, which `readClimbMb` matches to markers.
 *
 * @param {Required<Pick<ClimbOptions, "queueFs" | "alive" | "onUnread" | "ps" | "parentOf">>} options
 * @returns {{ runners: { pid: number, args: string }[], unmarked: { pid: number, args: string }[] }}
 */
function readUnmarkedRunners(
	queueDirs,
	{ queueFs, alive, onUnread, ps, parentOf },
) {
	const none = { runners: [], unmarked: [] };
	const [firstDir] = queueDirs;
	if (firstDir === undefined) return none;
	const tempRoot = path.dirname(firstDir);
	const listing = ps();
	if (!listing.ok) {
		onUnread("ps", listing.error);
		return none;
	}
	const runners = listing.rows.flatMap(({ pid, args }) =>
		pid !== null && runnerOf(args) ? [{ pid, args }] : [],
	);
	if (runners.length === 0) return none;
	const runnerPids = new Set(runners.map((r) => r.pid));
	const markerPids = new Set(
		ADMITTING_QUEUES.flatMap((name) => {
			const dir = path.join(tempRoot, name);
			const { markers, error } = readMarkers(dir, queueFs);
			/* A directory in `queueDirs` is `readClimbMb`'s to report. */
			if (error && !queueDirs.includes(dir)) onUnread(dir, error);
			return markers
				.map((m) => m.record)
				.filter((r) => !isMarkerStale(r, { alive }))
				.map((r) => r.pid);
		}),
	);
	const unmarked = runners.filter(
		({ pid }) =>
			!markerPids.has(pid) &&
			!readAncestorsOf(pid, { parentOf }).some(
				(a) => markerPids.has(a) || runnerPids.has(a),
			),
	);
	return { runners, unmarked };
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
 * What the admitting queues' launches have yet to draw, in MB (#3488): the
 * charge a launch the guard judges unqueued takes, being in neither queue. A
 * bare `tsc` or a build pays `"all"`; a suite pays `"off-rung"` (#4111, #4112). Read at
 * call time, so a caller's `TMPDIR` redirects it.
 * @param {ClimbScope} scope
 * @param {ClimbOptions} [options]
 */
const readQueuesClimbMb = (scope, options) =>
	readClimbMb([defaultQueueDir(), ...peerQueueDirs(defaultQueueDir())], {
		...options,
		rungQueue: scope === "off-rung" ? QUEUE_NAME : null,
	});

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
 *   whole-slot bound joins `part`, a part-suite (#2558), with its resolved
 *   `files` (#3806).
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
	const files = part ? weight?.resolvedFiles : undefined;
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
				...(typeof files === "number" ? { files } : {}),
			}),
		);
		return file;
	} catch {
		// Unwritable queue costs the ordering, never the run.
		return "";
	}
}

/**
 * Merge `fields` into this waiter's marker, or with `admitted: false`,
 * `memoryHeld: false`, `windowsHeld: false`, `climbHeld: false` or
 * `yielding: false` drop that stamp. Fails silent, like `queueJoin`.
 *
 * @param {string} file
 * @param {{ admitted?: boolean, spawned?: true, memoryHeld?: boolean, windowsHeld?: boolean, climbHeld?: boolean, yielding?: boolean }} fields
 */
function stampMarker(file, fields, { queueFs = fs } = {}) {
	if (!file) return;
	try {
		const record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
		const { admitted, memoryHeld, windowsHeld, climbHeld, yielding, ...rest } =
			{
				...record,
				...fields,
			};
		queueFs.writeFileSync(
			file,
			JSON.stringify({
				...rest,
				...(admitted ? { admitted } : {}),
				...(memoryHeld ? { memoryHeld } : {}),
				...(windowsHeld ? { windowsHeld } : {}),
				...(climbHeld ? { climbHeld } : {}),
				...(yielding ? { yielding } : {}),
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
 * FAILS OPEN, silently like `readTurn`, where there is nothing to contest
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
	const rivals = openAdmissions(records, queueDir, { pid, queueFs, alive });
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
 * (#3058), `onWindowsHeld`, the `windowsHeld` stamp (#4782), `onClimbStamp`, the `climbHeld` stamp (#4760), and `climbMb`, what
 * its peer queues' launches have yet to draw (#3416). `onClimbHeld` keeps the highest charge that held the wait, for
 * `killedHold` to give a killed wait's exit line, which `waitForGate` never
 * reaches (#3806).
 *
 * @param {string} file
 * @param {Parameters<typeof queueAdmit>[1] & Parameters<typeof readPeerClimbMb>[1]} [options]
 * @returns {{ admit: () => Admission, onMemoryHeld: (memoryHeld: boolean) => void, onWindowsHeld: (windowsHeld: boolean) => void, onClimbStamp: (climbHeld: boolean) => void, climbMb: () => number, onClimbHeld: (climbMb: number) => void, killedHold: () => WaitHold }}
 */
function queueStamps(file, options = {}) {
	let climbHeldMb = 0;
	return {
		onClimbHeld: (climbMb) => {
			climbHeldMb = climbMb;
		},
		killedHold: () => (climbHeldMb > 0 ? { climbMb: climbHeldMb } : {}),
		admit: () => queueAdmit(file, options),
		onMemoryHeld: (memoryHeld) => stampMarker(file, { memoryHeld }, options),
		onWindowsHeld: (windowsHeld) => stampMarker(file, { windowsHeld }, options),
		onClimbStamp: (climbHeld) => stampMarker(file, { climbHeld }, options),
		climbMb: () =>
			readPeerClimbMb(options.queueDir ?? defaultQueueDir(), options),
	};
}

/**
 * The live markers `role` names, waiting or running. Sweeps nothing: a stale
 * marker is `readTurn`'s to remove.
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
 * Whether this waiter's turn has come: it reads the queue's markers, sweeps
 * the stale ones and asks `turnOf`. `passed` is 0 where an open part-suite
 * turn passed none, absent on any other turn or a closed one.
 *
 * FAILS OPEN, like every other part of this wait: a queue directory that cannot
 * be read opens the turn.
 *
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: typeof pidAlive, slots?: number, clock?: () => number }} [options]
 * @returns {{ open: boolean, passed?: number, hold?: TurnHold }}
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
	const admissions = openAdmissions(live, queueDir, {
		pid,
		queueFs,
		alive,
	}).map(({ pid: holder, queue }) => ({ pid: holder, queue }));
	const peers = readPeerClimbHeld(queueDir, mine, { queueFs, alive });
	const { reasons, passed } = turnOf({
		waiter: mine.part === true ? "part" : "whole",
		ahead,
		admissionOpen: admissions.length > 0,
		peerClimbHeld: peers.length > 0,
		slots,
		now: clock(),
	});
	if (reasons.length === 0) return { open: true, passed };
	/* An open admission closes every turn, the waiters ahead's too, so it
	 * names the hold over them. */
	if (reasons.includes("admitted"))
		return { open: false, hold: { limb: "admitted", holders: admissions } };
	/* The waiters ahead in this queue are named over a peer (#4760).
	 * Residual: where the peer outlasts them, a trace names it only once
	 * they have cleared. */
	if (reasons.length === 1 && reasons[0] === "peer-climb")
		return { open: false, hold: { limb: "peer", holders: peers } };
	return { open: false, hold: { limb: "fifo", pids: ahead.map((r) => r.pid) } };
}

/**
 * A held seat's turn (#4766): closed while the other queue holds an older
 * waiter the climb charge holds (`readPeerClimbHeld`), and on nothing else, a
 * seat skipping its own queue's order (#2918). Fails open on a queue directory that cannot be read, as `readTurn` does.
 *
 * While closed it stamps the seat's marker `yielding`, which takes the seat's
 * charge off the climb (`readClimbMb`). `release` drops
 * the stamp, on every path out of the wait.
 *
 * @param {string} seat the held seat's marker file
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: typeof pidAlive }} [options]
 * @returns {{ turn: () => boolean, turnHold: () => TurnHold | undefined, release: () => void }}
 */
function peerClimbTurn(
	seat,
	{
		queueDir = defaultQueueDir(),
		queueFs = fs,
		pid = process.pid,
		alive = pidAlive,
	} = {},
) {
	/** @type {{ pid: number, queue: string }[]} */
	let holders = [];
	const read = () => {
		const { markers, error } = readMarkers(queueDir, queueFs);
		if (error) return [];
		const mine = markers.find(({ record }) => record.pid === pid)?.record ?? {
			pid,
			at: Number.POSITIVE_INFINITY,
		};
		return readPeerClimbHeld(queueDir, mine, { queueFs, alive });
	};
	return {
		turn: () => {
			holders = read();
			stampMarker(seat, { yielding: holders.length > 0 }, { queueFs });
			return holders.length === 0;
		},
		turnHold: () =>
			holders.length > 0 ? { limb: "peer", holders } : undefined,
		release: () => stampMarker(seat, { yielding: false }, { queueFs }),
	};
}

/**
 * Why a turn is closed: a whole suite or a part-suite
 * held behind the waiters ahead of it, a `tsc` behind its own queue's, or
 * another launch admitted and unspawned, or an older waiter in the other
 * queue the climb charge holds.
 * @typedef {"fifo-whole" | "fifo-part" | "tsc-fifo" | "admitted" | "peer-climb"} TurnReason
 */
/**
 * A turn's inputs, as a value: this waiter's class, the live waiters that
 * joined ahead of it, whether another launch in this queue or a peer is
 * admitted and unspawned, and whether the other queue holds an older waiter
 * the climb charge holds (#4760).
 * @typedef {{ waiter: "whole" | "part" | "tsc", ahead: Pick<QueueRecord, "at" | "part" | "spawned" | "memoryHeld" | "windowsHeld">[], admissionOpen: boolean, peerClimbHeld?: boolean, slots: number, now: number }} TurnSnapshot
 */

/**
 * Every reason `snapshot`'s turn is closed, in the gate's order, and on an open
 * part-suite turn how many older part-suites it passed (#3115). `readTurn` and the queue-wait replay both ask it, so a change
 * to the rule reaches both (#4260).
 *
 * `partPass` switches #3058's pass on: always in the gate, from its commit in
 * the replay.
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
 * (`readPeerClimbMb`).
 *
 * THE QUEUES ARE ORDERED AGAINST EACH OTHER WHERE THE CLIMB DECIDES (#4760):
 * no turn comes while the other queue holds an older waiter stamped
 * `climbHeld`, one whose wait the climb charge of launches already running
 * has held, and holds still on its rung or the Windows hold while they are
 * charged (`isClimbKept`, #4799). The oldest such waiter yields to nobody, and
 * what holds it is running and ends, so the yield cannot deadlock.
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
 * AND PAST ONE THE WINDOWS-MEMORY HOLD KEEPS OUT (#4782): one stamped
 * `windowsHeld`, at any age. Each waiter's Windows need is its own draw, so a
 * smaller one can fit the free memory a larger head cannot. The hold refuses
 * the head at its bound rather than running it, so holding younger waiters
 * back gains it nothing.
 *
 * Residual: the stamp is a poll old, so a part-suite may pass one whose
 * memory freed since; and a drop that will not write leaves the stamp, letting
 * younger ones pass until the age bound, or a `windowsHeld` one for as long
 * as its marker lives.
 *
 * @param {TurnSnapshot} snapshot
 * @param {{ partPass?: boolean }} [options]
 * @returns {{ reasons: TurnReason[], passed?: number }}
 */
function turnOf(
	{ waiter, ahead, admissionOpen, peerClimbHeld = false, slots, now },
	{ partPass = true } = {},
) {
	/** @type {TurnReason[]} */
	const reasons = [];
	/** @type {number | undefined} */
	let passed;
	if (waiter === "part") {
		const waiting = ahead.filter((r) => r.part === true && r.spawned !== true);
		const passable = (/** @type {TurnSnapshot["ahead"][number]} */ r) =>
			partPass &&
			(r.windowsHeld === true ||
				(r.memoryHeld === true && now - r.at < PART_PASS_AGE_MS));
		if (waiting.every(passable)) passed = waiting.length;
		else reasons.push("fifo-part");
	} else if (
		ahead.filter((r) => r.part !== true).length >= slots ||
		!ahead.every((r) => r.spawned === true)
	)
		reasons.push(waiter === "tsc" ? "tsc-fifo" : "fifo-whole");
	if (admissionOpen) reasons.push("admitted");
	if (peerClimbHeld) reasons.push("peer-climb");
	return reasons.length > 0 || passed === undefined
		? { reasons }
		: { reasons, passed };
}

/**
 * A queued waiter's turn, and the extra fields for its exit line: `passed`,
 * from the turn read that opened it (#3115), on an `opened` exit alone. Every
 * other exit may follow polls the gate denied before reading the turn, so the
 * last count read there could be stale.
 *
 * `turnHold` is who held the last turn read shut (#4359).
 *
 * @param {Parameters<typeof readTurn>[0]} [options]
 * @returns {{ turn: () => boolean, turnHold: () => TurnHold | undefined, exitFields: (reason: WaitExitReason, heldBy?: WaitHold) => object }}
 */
function passingTurn(options = {}) {
	/** @type {number | undefined} */
	let passed;
	/** @type {TurnHold | undefined} */
	let hold;
	return {
		turn: () => {
			const reading = readTurn(options);
			passed = reading.passed;
			hold = reading.hold;
			return reading.open;
		},
		turnHold: () => hold,
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
		.concat(words.map(shellQuote))
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
 * What held a wait neither memory limb did: the count cap where the
 * gate denied, else the queue's turn.
 *
 * @param {GateDenial | null} denial
 * @returns {Exclude<HeldLimb, "memory" | "windows">}
 */
function heldLimb(denial) {
	return denial ? "count" : "turn";
}

const HELD_LINE = {
	count: "gate still denies on its count cap",
	turn: "turn still closed",
};

/**
 * What holds a wait on one poll: a gate denial, who holds the turn shut, a
 * turn closed by a caller's own `turn` (`{ limb: "turn" }`), or a yield to a
 * launch admitted on the same poll.
 * @typedef {GateDenial | TurnHold | { limb: "turn" } | { limb: "yielded" }} WaitLimb
 */

const LIMB_NAMES = {
	count: "the count cap",
	memory: "the memory rung",
	windows: "the Windows-memory hold",
	fifo: "the waiters ahead",
	admitted: "a launch admitted and not yet up",
	peer: "an older waiter in the other queue the climb charge holds",
	turn: "the queue's turn",
	yielded: "yielding to a launch admitted on the same poll",
};

/** @param {(number | null)[]} pids */
const pidList = (pids) =>
	pids.length === 0 ? "" : `, PID ${pids.map((p) => p ?? "unread").join(", ")}`;

/**
 * A memory reading is no identity, so a moving MemAvailable never reads as a
 * new limb.
 *
 * @param {WaitLimb} hold
 */
function limbHolder(hold) {
	if (hold.limb === "count") return pidList(hold.pids ?? []);
	if (hold.limb === "fifo") return pidList(hold.pids);
	if (hold.limb === "admitted" || hold.limb === "peer")
		return `, ${hold.holders.map(({ pid, queue }) => `PID ${pid} in ${queue}`).join(", ")}`;
	return "";
}

/**
 * @param {WaitLimb} hold
 * @returns {string}
 */
function describeLimb(hold) {
	if (hold.limb === "windows")
		return `${LIMB_NAMES.windows}, Windows free ${hold.mb} MB against ~${hold.needMb} MB`;
	if (hold.limb !== "memory")
		return `${LIMB_NAMES[hold.limb]}${limbHolder(hold)}`;
	const { mb, rungMb, climbMb } = hold;
	if (mb === undefined) return LIMB_NAMES.memory;
	const climb = climbMb ? `, less ${climbMb} MB yet to draw` : "";
	const rung = rungMb === undefined ? "" : ` against ~${rungMb} MB`;
	return `${LIMB_NAMES.memory}, MemAvailable ${mb} MB${climb}${rung}`;
}

/**
 * @param {GateDenial | null} denial
 * @param {boolean} open
 * @param {() => TurnHold | undefined} turnHold
 * @returns {WaitLimb | null}
 */
function waitLimb(denial, open, turnHold) {
	if (denial) return denial;
	if (open) return null;
	return turnHold() ?? { limb: "turn" };
}

/**
 * Every limb besides `denial`'s that fails this poll too, the gate's order
 * hiding them (#4359): the memory rung under a count cap, and the turn.
 * Reading the turn here sweeps stale markers as `readTurn` does on any poll,
 * so a traced wait sweeps on denied polls too; nothing it sweeps is live.
 *
 * @param {GateDenial} denial
 * @param {() => boolean} turn
 * @param {() => TurnHold | undefined} turnHold
 * @returns {WaitLimb[]}
 */
function readAlsoHeld(denial, turn, turnHold) {
	/** @type {WaitLimb[]} */
	const also =
		denial.limb === "count" && denial.memory
			? [{ limb: "memory", ...denial.memory }]
			: [];
	if (!turn()) also.push(turnHold() ?? { limb: "turn" });
	return also;
}

/**
 * Whole seconds per limb, summing to `wholeSecs` (largest remainder).
 *
 * @param {[WaitLimb["limb"], number][]} parts  each limb's milliseconds
 * @param {number} wholeSecs
 * @returns {[WaitLimb["limb"], number][]}
 */
function roundedSecs(parts, wholeSecs) {
	const whole = parts.map(([, ms]) => Math.floor(ms / 1000));
	const short = wholeSecs - whole.reduce((sum, n) => sum + n, 0);
	const byRemainder = parts
		.map(([, ms], i) => ({ i, rest: ms % 1000 }))
		.sort((x, y) => y.rest - x.rest)
		.slice(0, Math.max(0, short));
	for (const { i } of byRemainder) whole[i] = (whole[i] ?? 0) + 1;
	return parts.map(([limb], i) => [limb, whole[i] ?? 0]);
}

/**
 * @param {WaitLimb[]} limbs
 * @param {number | undefined} lowest  the lowest MemAvailable read so far
 * @returns {number | undefined}
 */
function lowestReading(limbs, lowest) {
	let low = lowest;
	for (const limb of limbs)
		if (limb.limb === "memory" && limb.mb !== undefined)
			low = Math.min(low ?? limb.mb, limb.mb);
	return low;
}

/**
 * A wait's trace of what holds it (#4359): `see` takes each poll's limb, or
 * null where nothing held it, with the other limbs failing that poll, and
 * returns the line to print where any of them or their holders changed;
 * `breakdown` names the time on each limb from `started`, in the order each
 * first held it, the limb holding it now counted to now, then the lowest
 * MemAvailable any poll read. A yield's time is its own, and leaves the
 * printed limbs alone, so the limb after it prints no line again.
 *
 * @param {() => number} clock
 * @param {number} started
 */
function limbTrace(clock, started) {
	/** @type {Map<WaitLimb["limb"], number>} */
	const heldMs = new Map();
	/** @type {WaitLimb | null} */
	let current = null;
	let identity = "";
	let since = started;
	let first = true;
	/** @type {number | undefined} */
	let lowestMb;
	const accrue = () => {
		const now = clock();
		if (current)
			heldMs.set(current.limb, (heldMs.get(current.limb) ?? 0) + now - since);
		since = now;
	};
	return {
		/**
		 * @param {WaitLimb | null} hold
		 * @param {WaitLimb[]} [also]  the other limbs failing this poll
		 * @returns {string | null}
		 */
		see(hold, also = []) {
			if (first) {
				/* The wait's first stretch is its first limb's. */
				first = false;
				current = hold;
			}
			accrue();
			current = hold;
			/* A yield prints its own line (`admitOrYield`). */
			if (!hold || hold.limb === "yielded") {
				if (!hold) identity = "";
				return null;
			}
			const held = [hold, ...also];
			lowestMb = lowestReading(held, lowestMb);
			const next = held
				.map((limb) => `${limb.limb}${limbHolder(limb)}`)
				.join(";");
			if (next === identity) return null;
			identity = next;
			return held.map(describeLimb).join("; also on ");
		},
		/** @param {number} wholeSecs  the wait's length, as its lines print it */
		breakdown(wholeSecs) {
			accrue();
			const spent = roundedSecs([...heldMs], wholeSecs)
				.map(([limb, secs]) => `${secs}s on ${LIMB_NAMES[limb]}`)
				.join(", ");
			if (!spent || lowestMb === undefined) return spent;
			return `${spent}; MemAvailable at lowest ${lowestMb} MB`;
		},
	};
}

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
 * The line a wait the Windows-memory hold still holds at its timeout ends on
 * (#4557): refused, as a memory wait is, since running it is what pages
 * Windows.
 *
 * @param {string} label
 * @param {number} secs
 * @param {WindowsHold} denial
 * @returns {string}
 */
function windowsRefusal(label, secs, { mb, needMb }) {
	return `${label}: the Windows-memory hold still holds after ${secs}s (Windows free ${mb} MB against ~${needMb} MB) — refused, not run. Close what Windows runs beside the VM, or wait for it to free, and run it again (#4557).\n`;
}

/**
 * The charge a gate denial held a wait on, in MB: its climb where MemAvailable
 * alone clears the rung, so the charge decided it. 0 on any other denial.
 *
 * @param {GateDenial | null} denial
 * @returns {number}
 */
function heldOnClimbMb(denial) {
	if (denial?.limb !== "memory" || !denial.climbMb) return 0;
	const { mb, rungMb, climbMb } = denial;
	return mb !== undefined && rungMb !== undefined && mb >= rungMb ? climbMb : 0;
}

/**
 * Whether a wait the climb charge held keeps its `climbHeld` stamp on this
 * poll (#4799): its rung or the Windows hold still denies it, and launches
 * already running are still charged. Their draw moves from the charge into
 * MemAvailable as they climb, and into what Windows has free; dropping the
 * stamp there lets the other queue launch into the same memory.
 *
 * The queue-wait replay asks it too, so a change to the rule reaches both
 * (#4260).
 *
 * @param {string | undefined} limb the limb that denied this poll
 * @param {boolean} charged whether launches are charged this poll
 * @returns {boolean}
 */
function isClimbKept(limb, charged) {
	return charged && (limb === "memory" || limb === "windows");
}

/**
 * A setter that hands `listener` its flag only when the flag changes,
 * starting from false.
 *
 * @param {(held: boolean) => void} listener
 * @returns {(held: boolean) => void}
 */
function changesOnly(listener) {
	let last = false;
	return (held) => {
		if (held === last) return;
		last = held;
		listener(held);
	};
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
 * unstamped (#2742).
 *
 * `onMemoryHeld` hears whether the memory rung holds the wait, each time that
 * changes: a queued caller stamps its marker with it (`queueStamps`, #3058).
 * `onWindowsHeld` hears the same of the Windows-memory hold (#4782).
 * `onClimbStamp` hears the same of the climb charge alone (`heldOnClimbMb`),
 * which the other queue's waiters yield to (#4760), kept while `isClimbKept`
 * holds (#4799).
 *
 * `climbMb` is read each poll and handed to `gate` to charge on its memory
 * rung (#3416).
 *
 * `traceLimbs` prints the limb that holds the wait each time it or its holder
 * changes, and the time held on each limb as the wait ends (#4359).
 *
 * @param {{ pollMs?: number, timeoutMs?: number, gate?: (climbMb: number) => GateDenial | null, climbMb?: () => number, gateRead?: Parameters<typeof gateDenies>[1], gateWords?: string[], gateWeight?: import("./suite-handoff.js").CarriedWeight | null, turn?: () => boolean, leave?: () => string|null, hold?: () => Promise<boolean>, admit: () => Admission, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown }, label?: string, waiting?: string, cap?: string, part?: boolean, onMemoryHeld?: (held: boolean) => void, onWindowsHeld?: (held: boolean) => void, onClimbStamp?: (held: boolean) => void, onClimbHeld?: (climbMb: number) => void, onExit?: (reason: WaitExitReason, waitMs: number, heldBy?: WaitHold) => void, clock?: () => number, traceLimbs?: boolean, turnHold?: () => TurnHold | undefined }} options
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
	onWindowsHeld = () => {
		/* no marker to stamp */
	},
	onClimbStamp = () => {
		/* no marker to stamp */
	},
	onClimbHeld = () => {
		/* no killed line to give it to */
	},
	onExit = () => {
		/* no caller listening */
	},
	clock = Date.now,
	traceLimbs = false,
	turnHold = () => undefined,
}) {
	if (typeof admit !== "function")
		throw new TypeError("waitForGate: `admit` is required (#2742)");
	const started = clock();
	const secs = () => Math.round((clock() - started) / 1000);
	let announced = false;
	/* Whether `hold` has run since the last sleep: a reading taken after it
	 * is still fresh. */
	let held = false;
	const stampMemoryHeld = changesOnly(onMemoryHeld);
	const stampWindowsHeld = changesOnly(onWindowsHeld);
	const stampClimbHeld = changesOnly(onClimbStamp);
	let climbKept = false;
	let climbHeldMb = 0;
	const trace = limbTrace(clock, started);
	const breakdown = () => (traceLimbs ? trace.breakdown(secs()) : "");
	const sayBreakdown = () => {
		const spent = breakdown();
		if (spent) out.write(`${label}: held ${spent}\n`);
	};
	/** @param {WaitExitReason} reason @param {WaitOutcome} outcome @param {HeldLimb} [limb] */
	const exit = (reason, outcome, limb) => {
		const heldBy = {
			...(limb ? { limb } : {}),
			...(climbHeldMb > 0 ? { climbMb: climbHeldMb } : {}),
		};
		onExit(
			reason,
			clock() - started,
			...(Object.keys(heldBy).length > 0 ? [heldBy] : []),
		);
		return Promise.resolve(outcome);
	};
	const announce = () => {
		if (announced) return;
		announced = true;
		out.write(`${label}: ${waiting}\n`);
	};
	/** @returns {Promise<WaitOutcome>} */
	const wait = () => {
		announce();
		held = false;
		return sleepFn(pollMs).then(step);
	};
	/** @param {GateDenial | null} denial @param {boolean} open */
	const see = (denial, open) => {
		const also =
			traceLimbs && denial ? readAlsoHeld(denial, turn, turnHold) : [];
		const line = trace.see(waitLimb(denial, open, turnHold), also);
		if (!traceLimbs || !line) return;
		announce();
		out.write(`${label}: after ${secs()}s, held on ${line}\n`);
	};
	/**
	 * @param {() => Promise<WaitOutcome>} launch
	 * @param {boolean} atOnce
	 * @returns {Promise<WaitOutcome>}
	 */
	const admitOrYield = (launch, atOnce) => {
		const admission = admit();
		if (admission === "admitted") return launch();
		trace.see({ limb: "yielded" });
		out.write(
			`${label}: another launch was admitted on the same poll — yielding to it (#2622)\n`,
		);
		return admission === "ahead" && atOnce ? step() : wait();
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const refuse = (denial) => {
		sayBreakdown();
		if (denial?.limb === "memory") {
			out.write(memoryRefusal(label, secs(), denial));
			return exit("refused", "refused", "memory");
		}
		if (denial?.limb === "windows") {
			out.write(windowsRefusal(label, secs(), denial));
			return exit("refused", "refused", "windows");
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
			sayBreakdown();
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
			return denial?.limb === "memory" || denial?.limb === "windows"
				? refuse(denial)
				: runAnyway(denial);
		return admitOrYield(() => {
			const spent = breakdown();
			if (announced)
				out.write(
					`${label}: gate opened after ${secs()}s${spent ? ` — held ${spent}` : ""}\n`,
				);
			return exit("opened", "run");
		}, true);
	};
	/** @returns {Promise<WaitOutcome>} */
	const step = () => {
		/* BOTH conditions, not either. The gate answers "is the machine free",
		 * the queue answers "is it my turn" — and a waiter that checks only the
		 * gate joins a stampede the moment the machine frees up. */
		const charged = climbMb();
		const denial = gate(charged);
		const heldOn = heldOnClimbMb(denial);
		if (heldOn > climbHeldMb) {
			climbHeldMb = heldOn;
			onClimbHeld(heldOn);
		}
		stampMemoryHeld(denial?.limb === "memory");
		stampWindowsHeld(denial?.limb === "windows");
		climbKept =
			heldOn > 0 || (climbKept && isClimbKept(denial?.limb, charged > 0));
		stampClimbHeld(climbKept);
		const open = !denial && turn();
		see(denial, open);
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

/**
 * @typedef {{ on: (signal: NodeJS.Signals, listener: () => void) => unknown }} SignalEmitter
 * @typedef {{ waiting: () => boolean, logKilled: (signal: string) => void, leave: () => void, onSignal?: (signal: NodeJS.Signals, code: number) => boolean }} SignalSeat
 * @typedef {{ seats: Set<SignalSeat>, cleanups: Set<(signal: string) => void>, exit: (code: number) => void }} SignalHost
 */

/* Each emitter's armed handler state, which `releaseOnSignal` reads: a
 * handler takes no argument but its signal. */
/** @type {WeakMap<SignalEmitter, SignalHost>} */
const signalHosts = new WeakMap();

/**
 * Arm `emitter`'s QUEUE_SIGNALS handlers, ONCE PER EMITTER: a process that
 * runs many seats, as a test run calls `main` many times, would otherwise
 * exhaust the emitter's listener cap. On a signal a seat whose wait has ended
 * and whose `onSignal` answers true, as queue-run forwarding it to its
 * command, keeps the process alive and every marker held. Otherwise each
 * seat still waiting writes its `killed` line, each `cleanup` runs, then each
 * seat leaves and the process exits with the signal's code
 * (mantahostels#2034). The markers go last, so no waiter takes a slot whose
 * run a cleanup has yet to kill.
 *
 * SYNCHRONOUS BY NECESSITY: the handler exits at the end of its tick, and a
 * promise's `.finally()` never runs on a signal. One cleanup that throws must
 * not strand the rest.
 *
 * @param {{ emitter?: SignalEmitter, exit?: (code: number) => void, cleanup?: (signal: string) => void }} [options]
 * @returns {SignalHost}
 */
function armSeatSignals({
	emitter = process,
	exit = (code) => process.exit(code),
	cleanup,
} = {}) {
	let host = signalHosts.get(emitter);
	if (!host) {
		const armed = { seats: new Set(), cleanups: new Set(), exit };
		for (const [signal, code] of Object.entries(QUEUE_SIGNALS)) {
			const name = /** @type {NodeJS.Signals} */ (signal);
			emitter.on(name, () => releaseOnSignal(armed, name, code));
		}
		signalHosts.set(emitter, armed);
		host = armed;
	}
	if (cleanup) host.cleanups.add(cleanup);
	return host;
}

/**
 * @param {SignalHost} host
 * @param {NodeJS.Signals} signal
 * @param {number} code
 */
function releaseOnSignal(host, signal, code) {
	const seats = [...host.seats];
	const answered = seats.filter(
		(seat) => !seat.waiting() && seat.onSignal?.(signal, code),
	);
	if (answered.length > 0) return;
	for (const seat of seats) seat.logKilled(signal);
	for (const cleanup of host.cleanups) {
		try {
			cleanup(signal);
		} catch {
			/* Reported by the cleanup itself. */
		}
	}
	for (const seat of seats) seat.leave();
	host.exit(code);
}

/**
 * A queue seat, end to end (#4240): the marker joined, its stamps, the turn,
 * the wait, the exit line, the spawned stamp and the leave.
 *
 * `queue` is the queue's options every step reads; `join` adds what the marker alone carries (`role`, `chargeMb`,
 * `weight`), or is `false` for a caller already inside its slot, which takes
 * no marker and keeps the seat for its signal path alone (#3404). `turn`
 * replaces `passingTurn`'s, whose `passed` then never reaches the exit line.
 * `logExit` writes each exit line, a `queueExitLogger`; none writes no line.
 * `signals` opts the seat into `armSeatSignals`' handlers, with the emitter
 * and exit they arm and an `onSignal`, asked once the wait has ended, that
 * answers true where it handled the signal itself. A seat with one stays
 * registered past its leave, for the rest of its caller's life; one without
 * leaves the registry as it leaves the queue.
 *
 * THE LEAVE RUNS ON EVERY PATH and only once: `wait` leaves on a refusal, a
 * leave or a throw; `leave` is the caller's for an opened wait; a signal leaves
 * through the handler.
 *
 * The seat's stamps beat the caller's wait options, save an `admit` the
 * caller wraps round `stamps.admit` (queue-run's `--tsc` try); a `turn`
 * among them beats the seat's.
 *
 * @param {{ queue?: QueueOptions, join?: false | { role?: string, chargeMb?: number, weight?: import("./suite-handoff.js").CarriedWeight }, turn?: () => boolean, logExit?: (reason: import("./queue-exit-log.js").QueueExitReason, waitMs: number, extra?: object) => void, signals?: true | { emitter?: SignalEmitter, exit?: (code: number) => void, onSignal?: (signal: NodeJS.Signals, code: number) => boolean } }} [options]
 */
function queueSeat({ queue = {}, join = {}, turn, logExit, signals } = {}) {
	const ticket = join === false ? "" : queueJoin({ ...queue, ...join });
	const stamps = queueStamps(ticket, queue);
	const passing = turn ? null : passingTurn(queue);
	/** @type {(reason: WaitExitReason, heldBy?: WaitHold) => object} */
	const exitFields = passing
		? passing.exitFields
		: (_reason, heldBy) => ({ ...heldBy });
	const started = Date.now();
	let waiting = false;
	let held = true;
	/** @type {SignalHost | null} */
	let host = null;
	const onSignal = signals === true ? undefined : signals?.onSignal;
	const leave = () => {
		if (!onSignal) host?.seats.delete(entry);
		if (!held) return;
		held = false;
		queueLeave(ticket, queue);
	};
	/** @type {SignalSeat} */
	const entry = {
		waiting: () => waiting,
		logKilled: (signal) => {
			if (!waiting) return;
			waiting = false;
			logExit?.("killed", Date.now() - started, {
				signal,
				...stamps.killedHold(),
			});
		},
		leave,
		...(onSignal ? { onSignal } : {}),
	};
	if (signals) {
		host = armSeatSignals(signals === true ? {} : signals);
		host.seats.add(entry);
	}
	/**
	 * @param {Omit<Parameters<typeof waitForGate>[0], "admit" | "onExit"> & { admit?: () => Admission }} [options]
	 * @returns {Promise<WaitOutcome>}
	 */
	const wait = async (options = {}) => {
		waiting = true;
		try {
			const outcome = await waitForGate({
				turn: passing ? passing.turn : turn,
				...(passing ? { turnHold: passing.turnHold } : {}),
				...options,
				...stamps,
				admit: options.admit ?? stamps.admit,
				onExit: (reason, waitMs, heldBy) => {
					waiting = false;
					logExit?.(reason, waitMs, exitFields(reason, heldBy));
				},
			});
			if (outcome !== "run") leave();
			return outcome;
		} catch (error) {
			leave();
			throw error;
		} finally {
			waiting = false;
		}
	};
	return {
		ticket,
		stamps,
		wait,
		spawned: () => queueSpawned(ticket, queue),
		leave,
	};
}

/** @typedef {{ queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number, alive?: (pid: number) => boolean, slots?: number }} QueueOptions */
/** @typedef {ReturnType<typeof queueSeat>} QueueSeat */

module.exports = {
	PART_PASS_AGE_MS,
	turnOf,
	isClimbKept,
	SEAT_ENV,
	heldMarker,
	heldSeat,
	defaultQueueDir,
	readStartTimeOf,
	isMarkerStale,
	readMarkers,
	readLiveRoleMarkers,
	readQueuesClimbMb,
	gateDenies,
	waitForGate,
	peerClimbTurn,
	queueSeat,
	armSeatSignals,
};
