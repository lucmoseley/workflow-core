const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { noop } = require("./noop.js");

const { caught, ignoreFailure } = require("./caught.js");
const { monotonicMs } = require("./clock.js");
const { GATE_ROLE, GATE_SEAT_DEFAULT_MB } = require("./gate-seat.js");
const {
	WHOLE_SUITE_MAX,
	clampedClause,
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
const {
	TEST_PY_WORKERS,
	isOtherRunner,
	suiteLaunchKind,
} = require("./suite-launch.js");
const { scriptPath } = require("./script-path.js");
const { vitestLineSize, weighCarried } = require("./suite-bounded.js");
const { chargeMb: launchChargeMb } = require("./launch-charge.js");
const { QUEUE_POLL_MS } = require("./queue-poll.js");
const { peakClause } = require("./part-suite-peak.js");
const { TSC_QUEUE_NAME, isTscRunner, runnerPeakMb } = require("./tsc-slot.js");
const { describeWindowsHold } = require("./windows-memory.js");
const { isLanderRun } = require("./session-id.js");

/**
 * @typedef {{ mb?: number, rungMb?: number, climbMb?: number, busy?: number, ladderMb?: number, peak?: import("./part-suite-peak.js").PeakCharge }} MemoryReading
 * @typedef {{ limb: "windows" } & import("./windows-memory.js").WindowsHold} WindowsHold
 * @typedef {{ limb: "count", pids?: (number | null)[], memory?: MemoryReading } | ({ limb: "memory" } & MemoryReading) | WindowsHold} GateDenial
 */
/**
 * @typedef {{ limb: "fifo" | "claim", pids: number[] } | { limb: "admitted" | "peer", holders: { pid: number, queue: string }[] }} TurnHold
 * @typedef {{ pid: number, kind: string, state: "running" | "admitted" | "waiting" }} SessionPlace
 * @typedef {{ limb: "session-cap", places: SessionPlace[] }} SessionCapHold
 */
/** @typedef {Exclude<import("./queue-exit-log.js").QueueExitReason, "killed">} WaitExitReason */
/** @typedef {"run"|"left"|"refused"} WaitOutcome */
/** @typedef {import("./queue-exit-log.js").HeldLimb} HeldLimb */
/**
 * @typedef {{ limb?: HeldLimb, climbMb?: number, peerS?: number, sessionCapS?: number, windowsReleased?: true, admission?: import("./part-suite-peak.js").PartAdmission }} WaitHold
 */
/** @typedef {{ queueFs?: typeof fs, alive?: (pid: number) => boolean, treePssKb?: (pid: number) => number, onUnread?: (dir: string, error: unknown) => void, ps?: typeof readPs, parentOf?: (pid: number) => number, carriedOf?: typeof readCarriedWeightOf, rungQueue?: string | null }} ClimbOptions */
/** @typedef {"all" | "off-rung"} ClimbScope */
const HOLD_STAMPS = /** @type {const} */ ({
	memoryHeld: "onMemoryHeld",
	restHeld: "onRestHeld",
	windowsHeld: "onWindowsHeld",
	climbHeld: "onClimbStamp",
});
/** @typedef {keyof typeof HOLD_STAMPS} HoldStamp */
/** @typedef {{ [K in HoldStamp as (typeof HOLD_STAMPS)[K]]?: (held: boolean) => void }} HoldListeners */
const OTHER_STAMPS = /** @type {const} */ (["admitted", "yielding"]);
/** @typedef {(typeof OTHER_STAMPS)[number] | HoldStamp} MarkerStamp */
/** @type {readonly MarkerStamp[]} */
const MARKER_STAMPS = [
	...OTHER_STAMPS,
	.../** @type {HoldStamp[]} */ (Object.keys(HOLD_STAMPS)),
];
/**
 * @typedef {{ repo: string | null, session: string | null, command: string }} SeatHolder
 * @typedef {import("./part-suite-peak.js").PartKind} PartKind
 * @typedef {{ chargeMb?: number }} SpawnCharge
 * @typedef {{ pid: number, at: number, start?: number, role?: string, chargeMb?: number, memoryRungMb?: number, part?: boolean, kind?: PartKind, files?: number, spawned?: boolean, enteredAt?: number } & Partial<SeatHolder> & { [K in MarkerStamp]?: boolean }} QueueRecord
 */
/** @typedef {"admitted"|"behind"|"ahead"} Admission */
/**
 * @typedef {Omit<Parameters<typeof waitForGate>[0], "admit"> & Parameters<typeof queueJoin>[0] & Parameters<typeof readTurn>[0]} QueuedLaunchOptions
 */

const QUEUE_PREFIX = "wfc-suite-queue-";
const QUEUE_NAME = "wfc-suite-queue";

/** @returns {string} */
function defaultQueueDir() {
	return path.join(os.tmpdir(), QUEUE_NAME);
}

/** @type {Record<string, number>} */
const PEAK_MB = {
	[QUEUE_NAME]: launchChargeMb({ kind: "suite" }),
	[TSC_QUEUE_NAME]: launchChargeMb({ kind: "tsc" }),
};
const ADMITTING_QUEUES = Object.keys(PEAK_MB);

/**
 * @param {string} name
 * @param {Pick<QueueRecord, "part" | "files" | "chargeMb">} record
 * @returns {number}
 */
function peakMbOf(name, record) {
	if (Number.isFinite(record.chargeMb)) return Number(record.chargeMb);
	const { part, files } = record;
	if (name !== QUEUE_NAME || part !== true || files === undefined)
		return PEAK_MB[name] ?? 0;
	const { workers } = weighCarried({ resolvedFiles: files, wholeSlot: false });
	return launchChargeMb({ kind: "part", files, workers });
}

/**
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

/** @param {QueueRecord} record */
function isUnspawnedAdmission(record) {
	return record.admitted === true && record.spawned !== true;
}

/**
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
	return peerQueueDirs(queueDir).flatMap((dir) => {
		const live = readMarkers(dir, queueFs)
			.markers.map((m) => m.record)
			.filter((r) => !isMarkerStale(r, { alive }));
		const capped = sessionCapped(live);
		return live
			.filter((r) => keep(r) && !capped.has(r.pid))
			.map((r) => ({ ...r, queue: path.basename(dir) }));
	});
}

/**
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
 * @param {string[]} queueDirs
 * @param {ClimbOptions} [options]
 * @returns {number}
 */
function readClimbMb(
	queueDirs,
	{
		queueFs = fs,
		alive = pidAlive,
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

/** @param {string} args */
function pytestWorkersOf(args) {
	const value = /(?:^| )(?:-n[ =]?|--numprocesses[ =])(\S+)/.exec(args)?.[1];
	if (value === "auto" || value === "logical") return os.availableParallelism();
	const workers = Number(value);
	return Number.isInteger(workers) && workers > 0 ? workers : 0;
}

/** @param {string} args */
const isNodeLine = (args) => /^ *(\S*\/)?node(js)?( |$)/.test(args);

const NO_HOST_PORTS = { runners: () => [], isWrapperScript: () => true };

/** @param {string} args */
const isOtherSuiteLine = (args) =>
	isOtherRunner(args.trim().split(/\s+/), NO_HOST_PORTS.runners);

/**
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
		peakMbOf: () => launchChargeMb({ kind: "node-test" }),
	},
	{
		queue: QUEUE_NAME,
		isRunner: (args) => isOtherSuiteLine(args) && !isNodeLine(args),
		peakMbOf: ({ args }) =>
			launchChargeMb({ kind: "pytest", workers: pytestWorkersOf(args) }),
	},
	{
		queue: TSC_QUEUE_NAME,
		isRunner: isTscRunner,
		peakMbOf: (row) => runnerPeakMb(row),
	},
	{
		queue: null,
		isRunner: (args) => isNextRunnerLine("build", args),
		peakMbOf: () => launchChargeMb({ kind: "next-build" }),
	},
];

/** @param {string} args */
const runnerOf = (args) => RUNNERS.find((r) => r.isRunner(args));

/**
 * @param {string[]} words
 * @returns {number | undefined}
 */
function queuedRunnerPeakMb(words) {
	const args = words.join(" ");
	if (suiteLaunchKind(words, NO_HOST_PORTS)?.kind === "npm-py")
		return launchChargeMb({
			kind: "pytest",
			workers: pytestWorkersOf(args) || TEST_PY_WORKERS,
		});
	const runner = runnerOf(args);
	if (runner?.queue !== QUEUE_NAME || runner.isRunner === isVitestRunnerLine)
		return;
	return runner.peakMbOf({ pid: 0, args }, readCarriedWeightOf);
}

/**
 * @param {string[]} queueDirs
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
 * @param {string} queueDir
 * @param {ClimbOptions} [options]
 */
const readPeerClimbMb = (queueDir, options) =>
	readClimbMb(peerQueueDirs(queueDir), options);

/**
 * @param {ClimbScope} scope
 * @param {ClimbOptions} [options]
 */
const readQueuesClimbMb = (scope, options) =>
	readClimbMb([defaultQueueDir(), ...peerQueueDirs(defaultQueueDir())], {
		...options,
		rungQueue: scope === "off-rung" ? QUEUE_NAME : null,
	});

/**
 * @param {number} pid
 * @returns {number}
 */
function readStartTimeOf(pid) {
	const ticks = Number(readStatFields(pid)?.[FIELD.start]);
	return Number.isFinite(ticks) ? ticks : 0;
}

/**
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
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number, role?: string, chargeMb?: number, weight?: import("./suite-handoff.js").CarriedWeight, kind?: PartKind, holder?: SeatHolder, session?: string | null, env?: NodeJS.ProcessEnv }} [options]
 */
function queueJoin({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	clock = Date.now,
	role,
	chargeMb,
	weight,
	kind,
	holder,
	session,
	env = process.env,
} = {}) {
	const part = weight ? weighCarried(weight).part : false;
	const placed = placeSessionOf({ session, holder, env });
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
				...(part && kind ? { kind } : {}),
				...(typeof files === "number" ? { files } : {}),
				...holder,
				session: placed || undefined,
			}),
		);
		return file;
	} catch {
		return "";
	}
}

/**
 * @param {string} file
 * @param {{ spawned?: true, memoryRungMb?: number, enteredAt?: number } & { [K in MarkerStamp]?: boolean }} fields
 */
function stampMarker(file, fields, { queueFs = fs } = {}) {
	if (!file) return;
	ignoreFailure(() => {
		const record = {
			...JSON.parse(String(queueFs.readFileSync(file, "utf8"))),
			...fields,
		};
		for (const stamp of MARKER_STAMPS) if (!record[stamp]) delete record[stamp];
		queueFs.writeFileSync(file, JSON.stringify(record));
	});
}

/** @typedef {{ pid: number, at: number, enteredAt?: number }} QueuePlace */

/** @param {QueuePlace} r */
const queuedAt = (r) => r.enteredAt ?? r.at;

/**
 * @param {QueuePlace} a
 * @param {QueuePlace} b
 */
function joinedBefore(a, b) {
	const x = queuedAt(a);
	const y = queuedAt(b);
	return x < y || (x === y && a.pid < b.pid);
}

// #5594 measured: in #5592's window no session outside the eight largest held more than 2 waits at once in either queue
const SESSION_PLACES = 2;

/**
 * @param {{ session?: string | null, holder?: SeatHolder, env?: NodeJS.ProcessEnv }} join
 * @returns {string | null}
 */
function placeSessionOf({ session, holder, env = process.env }) {
	if (isLanderRun(env)) return null;
	return session || holder?.session || null;
}

/** @param {QueueRecord} r */
const hasPlace = (r) => r.admitted === true || r.spawned === true;

/**
 * @template {{ pid: number }} T
 * @param {number} held
 * @param {T[]} waiting
 * @param {(w: T) => number} joinedAt
 * @returns {{ entered: T[], over: T[] }}
 */
function splitPlaces(held, waiting, joinedAt) {
	const ordered = [...waiting].sort(
		(a, b) => joinedAt(a) - joinedAt(b) || a.pid - b.pid,
	);
	const free = Math.max(0, SESSION_PLACES - held);
	return { entered: ordered.slice(0, free), over: ordered.slice(free) };
}

/**
 * @param {QueueRecord[]} live
 * @returns {Map<number, QueueRecord[]>}
 */
function sessionCapped(live) {
	/** @type {Map<string, QueueRecord[]>} */
	const bySession = new Map();
	for (const r of live)
		if (typeof r.session === "string" && r.session)
			bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
	/** @type {Map<number, QueueRecord[]>} */
	const capped = new Map();
	for (const group of bySession.values()) {
		const holding = group.filter(hasPlace);
		const { entered, over } = splitPlaces(
			holding.length,
			group.filter((r) => !hasPlace(r)),
			(r) => r.at,
		);
		const places = [...holding, ...entered];
		for (const r of over) capped.set(r.pid, places);
	}
	return capped;
}

/**
 * @param {QueueRecord} r
 * @param {string} queue
 * @returns {SessionPlace}
 */
function placeOf(r, queue) {
	return { pid: r.pid, kind: placeKindOf(r, queue), state: placeStateOf(r) };
}

/** @param {QueueRecord} r @param {string} queue */
function placeKindOf(r, queue) {
	if (queue === TSC_QUEUE_NAME) return "tsc";
	return r.role === GATE_ROLE ? "gate seat" : waiterOf(r);
}

/**
 * @param {QueueRecord} r
 * @returns {SessionPlace["state"]}
 */
function placeStateOf(r) {
	if (r.spawned) return "running";
	return r.admitted ? "admitted" : "waiting";
}

/**
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: (pid: number) => boolean }} [options]
 * @returns {SessionCapHold | null}
 */
function readSessionCap({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	alive = pidAlive,
} = {}) {
	const { markers, error } = readMarkers(queueDir, queueFs);
	if (error) return null;
	const live = markers
		.map((m) => m.record)
		.filter((r) => r.pid === pid || !isMarkerStale(r, { alive }));
	const places = sessionCapped(live).get(pid);
	if (!places) return null;
	const queue = path.basename(queueDir);
	return {
		limb: "session-cap",
		places: places.map((r) => placeOf(r, queue)),
	};
}

/**
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
 * @param {string} file
 * @param {QueueOptions} [options]
 * @param {SpawnCharge} [charge]
 */
function queueSpawned(file, options = {}, charge = {}) {
	stampMarker(file, { spawned: true, ...charge }, options);
}

/**
 * @param {(stamp: HoldStamp) => (held: boolean) => void} listen
 * @returns {Required<HoldListeners>}
 */
function buildHoldListeners(listen) {
	return /** @type {Required<HoldListeners>} */ (
		Object.fromEntries(
			Object.entries(HOLD_STAMPS).map(([stamp, option]) => [
				option,
				listen(/** @type {HoldStamp} */ (stamp)),
			]),
		)
	);
}

/**
 * @param {string} file
 * @param {Parameters<typeof queueAdmit>[1] & Parameters<typeof readPeerClimbMb>[1] & { clock?: () => number }} [options]
 * @param {boolean} [placed]
 * @returns {{ admit: () => Admission, climbMb: () => number, sessionCap: () => SessionCapHold | null, onClimbHeld: (climbMb: number) => void, onPeerHeld: (secs: number) => void, onSessionCapHeld: (secs: number) => void, onMemoryRung: (rungMb: number) => void, polledHold: () => WaitHold } & Required<HoldListeners>}
 */
function queueStamps(file, options = {}, placed = false) {
	let climbHeldMb = 0;
	let peerS = 0;
	let sessionCapS = 0;
	let capped = false;
	return {
		onClimbHeld: (climbMb) => {
			climbHeldMb = climbMb;
		},
		onPeerHeld: (secs) => {
			peerS = secs;
		},
		onSessionCapHeld: (secs) => {
			sessionCapS = secs;
		},
		sessionCap: () => {
			if (!file || !placed) return null;
			const hold = readSessionCap(options);
			if (hold) capped = true;
			else if (capped) {
				capped = false;
				stampMarker(
					file,
					{ enteredAt: (options.clock ?? Date.now)() },
					options,
				);
			}
			return hold;
		},
		onMemoryRung: (rungMb) =>
			stampMarker(file, { memoryRungMb: rungMb }, options),
		polledHold: () => ({
			...(climbHeldMb > 0 ? { climbMb: climbHeldMb } : {}),
			...(peerS > 0 ? { peerS } : {}),
			...(sessionCapS > 0 ? { sessionCapS } : {}),
		}),
		admit: () => queueAdmit(file, options),
		...buildHoldListeners(
			(stamp) => (held) => stampMarker(file, { [stamp]: held }, options),
		),
		climbMb: () =>
			readPeerClimbMb(options.queueDir ?? defaultQueueDir(), options),
	};
}

/**
 * @param {string} role
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {{ records: QueueRecord[], unread: string | null }}
 */
function readLiveRoleMarkers(
	role,
	{ queueDir = defaultQueueDir(), queueFs = fs, alive = pidAlive } = {},
) {
	const { markers, error } = readMarkers(queueDir, queueFs);
	return {
		records: markers
			.map((m) => m.record)
			.filter((r) => r.role === role && !isMarkerStale(r, { alive })),
		unread:
			error === null
				? null
				: `the suite queue ${queueDir} would not read (${caught(error).message})`,
	};
}

/**
 * #5555
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} options
 * @returns {{ name: string, record: QueueRecord }[]}
 */
function readLiveWaiters({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	alive = pidAlive,
}) {
	return [
		{ dir: queueDir, name: QUEUE_NAME },
		...peerQueueDirs(queueDir).map((dir) => ({
			dir,
			name: path.basename(dir),
		})),
	].flatMap(({ dir, name }) =>
		readMarkers(dir, queueFs)
			.markers.filter(({ record }) => !isMarkerStale(record, { alive }))
			.map(({ record }) => ({ name, record })),
	);
}

/**
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {number}
 */
function readTestsHeldOnWindows(options = {}) {
	return readLiveWaiters(options).filter(
		({ record }) => record.windowsHeld === true,
	).length;
}

/**
 * #5555
 * @param {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean }} [options]
 * @returns {import("./admission.js").HeldRuns}
 */
function readTestsHeldOnMemory(options = {}) {
	return readLiveWaiters(options)
		.filter(
			({ record: r }) =>
				r.memoryHeld === true &&
				r.role === undefined &&
				r.admitted !== true &&
				r.spawned !== true,
		)
		.map(({ name, record: r }) => ({
			pid: r.pid,
			chargeMb: peakMbOf(name, r),
			...(Number.isFinite(r.memoryRungMb)
				? { rungMb: Number(r.memoryRungMb) }
				: {}),
		}));
}

const SEAT_ENV = "WFC_SUITE_SEAT";
/**
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
	ignoreFailure(() => queueFs.unlinkSync(file));
}

/**
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
		if (record.pid !== pid && isMarkerStale(record, { alive })) {
			ignoreFailure(() => queueFs.unlinkSync(full));
			continue;
		}
		live.push(record);
	}
	const mine = live.find((r) => r.pid === pid) ?? {
		pid,
		at: Number.POSITIVE_INFINITY,
	};
	const capped = sessionCapped(live);
	const ahead = live.filter((r) => joinedBefore(r, mine) && !capped.has(r.pid));
	const admissions = openAdmissions(live, queueDir, {
		pid,
		queueFs,
		alive,
	}).map(({ pid: holder, queue }) => ({ pid: holder, queue }));
	const peers = readPeerClimbHeld(queueDir, mine, { queueFs, alive });
	const now = clock();
	const { reasons, passed } = turnOf({
		waiter: waiterOf(mine),
		ahead,
		admissionOpen: admissions.length > 0,
		peerClimbHeld: peers.length > 0,
		slots,
		now,
	});
	if (reasons.length === 0) return { open: true, passed };
	if (reasons.includes("admitted"))
		return { open: false, hold: { limb: "admitted", holders: admissions } };
	if (reasons.includes("touched-claim"))
		return {
			open: false,
			hold: {
				limb: "claim",
				pids: ahead.filter((r) => hasFirstClaim(r, now)).map((r) => r.pid),
			},
		};
	if (reasons.length === 1 && reasons[0] === "peer-climb")
		return { open: false, hold: { limb: "peer", holders: peers } };
	return { open: false, hold: { limb: "fifo", pids: ahead.map((r) => r.pid) } };
}

/**
 * @param {{ queueDir?: string, queueFs?: typeof fs, pid?: number, alive?: typeof pidAlive }} [options]
 * @returns {{ position: number, holder: QueueRecord | null } | { position: null, holder: null, unread: string }}
 */
function readSlotPlace({
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	alive = pidAlive,
} = {}) {
	const { markers, error } = readMarkers(queueDir, queueFs);
	if (error)
		return { position: null, holder: null, unread: caught(error).message };
	const live = markers
		.map((m) => m.record)
		.filter((r) => r.pid === pid || !isMarkerStale(r, { alive }));
	const capped = sessionCapped(live);
	const whole = live
		.filter((r) => r.part !== true && (r.pid === pid || !capped.has(r.pid)))
		.sort((a, b) => Number(joinedBefore(b, a)) - Number(joinedBefore(a, b)));
	const mine = whole.find((r) => r.pid === pid) ?? {
		pid,
		at: Number.POSITIVE_INFINITY,
	};
	const ahead = whole.filter((r) => r.pid !== pid && joinedBefore(r, mine));
	return {
		position: ahead.length + 1,
		holder: whole.find((r) => r.pid !== pid && r.spawned === true) ?? null,
	};
}

/**
 * @param {string} seat
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
 * @typedef {"fifo-whole" | "fifo-part" | "touched-claim" | "tsc-fifo" | "admitted" | "peer-climb"} TurnReason
 */
/**
 * @typedef {"whole" | "part" | "named" | "tsc"} TurnWaiter
 * @typedef {{ waiter: TurnWaiter, ahead: Pick<QueueRecord, "at" | "part" | "kind" | "spawned" | "memoryHeld" | "restHeld" | "windowsHeld">[], admissionOpen: boolean, peerClimbHeld?: boolean, slots: number, now: number }} TurnSnapshot
 */

/**
 * @param {PartKind | null | undefined} kind
 * @returns {PartKind}
 */
const partLaneOf = (kind) => (kind === "named" ? "named" : "touched");

/**
 * @param {Pick<QueueRecord, "part" | "kind">} record
 * @returns {TurnWaiter}
 */
function waiterOf(record) {
	if (record.part !== true) return "whole";
	return partLaneOf(record.kind) === "named" ? "named" : "part";
}

/**
 * @param {TurnSnapshot["ahead"][number]} r
 * @param {number} now
 */
const hasFirstClaim = (r, now) =>
	r.part === true &&
	partLaneOf(r.kind) === "touched" &&
	r.spawned !== true &&
	now - r.at >= PART_PASS_AGE_MS;

/**
 * @param {TurnSnapshot} snapshot
 * @param {{ partPass?: boolean, namedLane?: boolean }} [options]
 * @returns {{ reasons: TurnReason[], passed?: number }}
 */
function turnOf(
	{ waiter, ahead, admissionOpen, peerClimbHeld = false, slots, now },
	{ partPass = true, namedLane = true } = {},
) {
	/** @type {TurnReason[]} */
	const reasons = [];
	/** @type {number | undefined} */
	let passed;
	if (waiter === "part" || waiter === "named") {
		const part = partTurnOf(ahead, now, {
			named: waiter === "named" && namedLane,
			partPass,
		});
		if (part.reason) reasons.push(part.reason);
		else passed = part.passed;
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
 * @param {TurnSnapshot["ahead"]} ahead
 * @param {number} now
 * @param {{ named: boolean, partPass: boolean }} lane
 * @returns {{ reason: TurnReason, passed?: undefined } | { reason?: undefined, passed: number }}
 */
function partTurnOf(ahead, now, { named, partPass }) {
	const waiting = ahead.filter((r) => r.part === true && r.spawned !== true);
	if (named)
		return ahead.some((r) => hasFirstClaim(r, now))
			? { reason: "touched-claim" }
			: { passed: waiting.length };
	const passable = (/** @type {TurnSnapshot["ahead"][number]} */ r) =>
		partPass &&
		(r.windowsHeld === true ||
			(r.memoryHeld === true &&
				(r.restHeld === true || now - r.at < PART_PASS_AGE_MS)));
	return waiting.every(passable)
		? { passed: waiting.length }
		: { reason: "fifo-part" };
}

/**
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

// #3361 measured p90 370 s of 265 opened part-suite waits the memory rung held, rounded up to the minute
const PART_PASS_AGE_MS = 7 * 60 * 1000;

const QUEUE_SIGNALS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };

// #5252 measured p99 wait that ended in a run 20.5 min here, 33 min in design-vault
const QUEUE_TIMEOUT_MS = 40 * 60 * 1000;

// #4852 guess
const WINDOWS_MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * @param {string[]} [words]
 * @param {(command: string, weight: import("./suite-handoff.js").CarriedWeight | null, climbMb: number, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void) => GateDenial | null} [read]
 * @param {import("./suite-handoff.js").CarriedWeight | null} [weight]
 * @param {{ climbMb?: number, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void }} [charge]
 * @returns {GateDenial | null}
 */
function gateDenies(
	words = [],
	read = (command, carried, climb, hear) =>
		require("./suite-concurrency-host.js").readGate(command, undefined, {
			weight: carried,
			climbMb: climb,
			allClimbMb: () => readQueuesClimbMb("all"),
			gateSeats: () => readGateSeats(),
			...(hear ? { onAdmission: hear } : {}),
		}),
	weight = null,
	{ climbMb = 0, onAdmission } = {},
) {
	const command = ["npm run test", ...(words.length > 0 ? ["--"] : [])]
		.concat(words.map(shellQuote))
		.join(" ");
	try {
		return onAdmission
			? read(command, weight, climbMb, onAdmission)
			: read(command, weight, climbMb);
	} catch (err) {
		ignoreFailure(() =>
			require("./arbiter-core.js").logError(
				"suite-queue.js",
				err,
				"gate unreadable — the run proceeds",
			),
		);
		return null;
	}
}

/**
 * @param {GateDenial | null} denial
 * @param {TurnHold | undefined} turnHold
 * @returns {Exclude<HeldLimb, "memory" | "windows" | "session-cap">}
 */
function heldLimb(denial, turnHold) {
	if (denial) return "count";
	return turnHold?.limb === "peer" ? "peer" : "turn";
}

const LIMB_NAMES = {
	count: "the count cap",
	memory: "the memory rung",
	windows: "the Windows-memory hold",
	fifo: "the waiters ahead",
	admitted: "a launch admitted and not yet up",
	peer: "an older waiter in the other queue the climb charge holds",
	claim: "an older touched run's first claim on memory",
	turn: "the queue's turn",
	yielded: "yielding to a launch admitted on the same poll",
	"session-cap": "this session's own places in the queue",
};

const HELD_LINE = {
	count: "gate still denies on its count cap",
	turn: "turn still closed",
	peer: `turn still closed on ${LIMB_NAMES.peer}`,
};

/**
 * @typedef {GateDenial | TurnHold | SessionCapHold | { limb: "turn" } | { limb: "yielded" }} WaitLimb
 */

/** @param {(number | null)[]} pids */
const pidList = (pids) =>
	pids.length === 0 ? "" : `, PID ${pids.map((p) => p ?? "unread").join(", ")}`;

/** @param {WaitLimb} hold */
function limbHolder(hold) {
	if (hold.limb === "count") return pidList(hold.pids ?? []);
	if (hold.limb === "fifo" || hold.limb === "claim") return pidList(hold.pids);
	if (hold.limb === "admitted" || hold.limb === "peer")
		return `, ${hold.holders.map(({ pid, queue }) => `PID ${pid} in ${queue}`).join(", ")}`;
	if (hold.limb === "session-cap") return `, ${placeList(hold.places)}`;
	return "";
}

/** @param {SessionPlace[]} places */
const placeList = (places) =>
	places
		.map(({ pid, kind, state }) => `PID ${pid} (${kind}, ${state})`)
		.join(", ");

/**
 * @param {string} label
 * @param {number} secs
 * @param {number} timeoutMs
 * @param {SessionCapHold} hold
 * @returns {string}
 */
function sessionCapRefusal(label, secs, timeoutMs, { places }) {
	const n = places.length;
	return `${label}: still behind this session's own ${n} place${n === 1 ? "" : "s"} in the queue after ${secs}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: one session holds at most ${SESSION_PLACES} places in each queue, its subagents' runs among them (#5595). Its places: ${placeList(places)}. Run it again once one of them finishes.\n`;
}

/** @param {MemoryReading} hold */
const peakOf = ({ peak }) => (peak ? `, the rung of ${peakClause(peak)}` : "");

/**
 * @param {WaitLimb} hold
 * @returns {string}
 */
function describeLimb(hold) {
	if (hold.limb === "windows")
		return `${LIMB_NAMES.windows}, ${describeWindowsHold(hold)}`;
	if (hold.limb !== "memory")
		return `${LIMB_NAMES[hold.limb]}${limbHolder(hold)}`;
	const { mb, rungMb, climbMb, ladderMb } = hold;
	if (mb === undefined) return LIMB_NAMES.memory;
	const climb = climbMb ? `, less ${climbMb} MB yet to draw` : "";
	const rung = rungMb === undefined ? "" : ` against ~${rungMb} MB`;
	return `${LIMB_NAMES.memory}, MemAvailable ${mb} MB${climb}${rung}${clampedClause(ladderMb)}${peakOf(hold)}`;
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
 * @param {[WaitLimb["limb"], number][]} parts
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
 * @param {number | undefined} lowest
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
		 * @param {WaitLimb[]} [also]
		 * @returns {string | null}
		 */
		see(hold, also = []) {
			if (first) {
				first = false;
				current = hold;
			}
			accrue();
			current = hold;
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
		/**
		 * @param {WaitLimb["limb"]} limb
		 * @returns {number}
		 */
		heldMs(limb) {
			accrue();
			return heldMs.get(limb) ?? 0;
		},
		/** @param {number} wholeSecs */
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
 * @param {string} label
 * @param {number} secs
 * @param {MemoryReading} denial
 * @returns {string}
 */
function memoryRefusal(label, secs, { mb, rungMb, climbMb, ladderMb, peak }) {
	const rung =
		rungMb === undefined
			? ""
			: ` against the ~${rungMb} MB rung${clampedClause(ladderMb)}${peakOf({ peak })}`;
	const climb = climbMb
		? `, less ${climbMb} MB ${peak ? "the queues'" : "the other queue's"} launches have yet to draw${rung ? "," : ""}`
		: "";
	const reading =
		mb === undefined ? "" : ` (MemAvailable ${mb} MB${climb}${rung})`;
	return `${label}: gate still denies on memory after ${secs}s${reading} — refused, not run. Reap finished sessions (\`node ${scriptPath("reap-finished-sessions.js")}\`) and run it again (#2421).\n`;
}

/**
 * @param {string} label
 * @param {number} secs
 * @param {WindowsHold} denial
 * @returns {string}
 */
function windowsRefusal(label, secs, denial) {
	return `${label}: the Windows-memory hold still holds after ${secs}s (${describeWindowsHold(denial)}) — refused, not run. Close what Windows runs beside the VM, or wait for it to free, and run it again (#4557).\n`;
}

/**
 * @param {GateDenial | null} denial
 * @returns {number}
 */
function heldOnClimbMb(denial) {
	if (denial?.limb !== "memory" || !denial.climbMb) return 0;
	const { mb, rungMb, climbMb } = denial;
	return mb !== undefined && rungMb !== undefined && mb >= rungMb ? climbMb : 0;
}

/**
 * @param {string | undefined} limb
 * @param {boolean} charged
 * @returns {boolean}
 */
function isClimbKept(limb, charged) {
	return charged && (limb === "memory" || limb === "windows");
}

/**
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
 * @param {{ pollMs?: number, timeoutMs?: number, gate?: (climbMb: number, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void) => GateDenial | null, climbMb?: () => number, gateRead?: Parameters<typeof gateDenies>[1], gateWords?: string[], gateWeight?: import("./suite-handoff.js").CarriedWeight | null, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void, turn?: () => boolean, leave?: () => string|null, hold?: () => Promise<boolean>, admit: () => Admission, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown }, label?: string, waiting?: string, cap?: string, part?: boolean, onClimbHeld?: (climbMb: number) => void, onPeerHeld?: (secs: number) => void, sessionCap?: () => SessionCapHold | null, onSessionCapHeld?: (secs: number) => void, onMemoryRung?: (rungMb: number) => void, onExit?: (reason: WaitExitReason, waitMs: number, heldBy?: WaitHold) => void, monoClock?: () => number, traceLimbs?: boolean, turnHold?: () => TurnHold | undefined } & HoldListeners} options
 * @returns {Promise<WaitOutcome>}
 */
function waitForGate({
	pollMs = QUEUE_POLL_MS,
	timeoutMs = QUEUE_TIMEOUT_MS,
	gateRead,
	gateWords = [],
	gateWeight = null,
	onAdmission = noop,
	gate: givenGate,
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
	onClimbHeld = noop,
	onPeerHeld = noop,
	sessionCap = () => null,
	onSessionCapHeld = noop,
	onMemoryRung = noop,
	onExit = noop,
	monoClock: clock = monotonicMs,
	traceLimbs = false,
	turnHold = () => undefined,
	...holdOptions
}) {
	if (typeof admit !== "function")
		throw new TypeError("waitForGate: `admit` is required (#2742)");
	/** @type {import("./part-suite-peak.js").PartAdmission | undefined} */
	let heard;
	const hearAdmission = (
		/** @type {import("./part-suite-peak.js").PartAdmission} */ a,
	) => {
		heard = a;
		onAdmission(a);
	};
	const gate =
		givenGate ??
		((/** @type {number} */ charged) =>
			gateDenies(gateWords, gateRead, gateWeight, {
				climbMb: charged,
				onAdmission: hearAdmission,
			}));
	const started = clock();
	const secs = () => Math.round((clock() - started) / 1000);
	let announced = false;
	let held = false;
	const hear = buildHoldListeners((stamp) =>
		changesOnly(holdOptions[HOLD_STAMPS[stamp]] ?? noop),
	);
	let climbKept = false;
	let climbHeldMb = 0;
	/** @type {number | undefined} */
	let rungHeardMb;
	/** @param {number} rungMb */
	const hearRung = (rungMb) => {
		if (rungMb === rungHeardMb) return;
		rungHeardMb = rungMb;
		onMemoryRung(rungMb);
	};
	/** @type {number | undefined} */
	let windowsSince;
	let spellReleased = false;
	let windowsReleased = false;
	/** @param {GateDenial | null} denial */
	const releaseWindows = (denial) => {
		if (denial?.limb !== "windows") {
			windowsSince = undefined;
			spellReleased = false;
			return denial;
		}
		windowsSince ??= clock();
		if (clock() - windowsSince < WINDOWS_MAX_HOLD_MS) return denial;
		if (!spellReleased)
			out.write(
				`${label}: the Windows-memory hold released this wait after ${secs()}s, its ${WINDOWS_MAX_HOLD_MS / 60_000}-minute maximum (${describeWindowsHold(denial)}) (#4850)\n`,
			);
		spellReleased = true;
		windowsReleased = true;
		return null;
	};
	const trace = limbTrace(clock, started);
	const peerHeldS = () => Math.round(trace.heldMs("peer") / 1000);
	const capHeldS = () => Math.round(trace.heldMs("session-cap") / 1000);
	const breakdown = () => (traceLimbs ? trace.breakdown(secs()) : "");
	const sayBreakdown = () => {
		const spent = breakdown();
		if (spent) out.write(`${label}: held ${spent}\n`);
	};
	/** @param {WaitExitReason} reason @param {WaitOutcome} outcome @param {HeldLimb} [limb] */
	const exit = (reason, outcome, limb) => {
		const peerS = peerHeldS();
		const sessionCapS = capHeldS();
		const heldBy = {
			...(limb ? { limb } : {}),
			...(climbHeldMb > 0 ? { climbMb: climbHeldMb } : {}),
			...(peerS > 0 ? { peerS } : {}),
			...(sessionCapS > 0 ? { sessionCapS } : {}),
			...(windowsReleased
				? { windowsReleased: /** @type {const} */ (true) }
				: {}),
			...(heard ? { admission: heard } : {}),
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
	/** @param {WaitLimb | null} limb @param {WaitLimb[]} also */
	const report = (limb, also) => {
		const line = trace.see(limb, also);
		onPeerHeld(peerHeldS());
		onSessionCapHeld(capHeldS());
		if (!traceLimbs || !line) return;
		announce();
		out.write(`${label}: after ${secs()}s, held on ${line}\n`);
	};
	/** @param {GateDenial | null} denial @param {boolean} open */
	const see = (denial, open) => {
		const also =
			traceLimbs && denial ? readAlsoHeld(denial, turn, turnHold) : [];
		report(waitLimb(denial, open, turnHold), also);
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
		const limb = heldLimb(denial, turnHold());
		out.write(
			`${label}: ${HELD_LINE[limb]} after ${secs()}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: ${cap}.\n`,
		);
		return exit("refused", "refused", limb);
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const runAnyway = (denial) =>
		admitOrYield(() => {
			sayBreakdown();
			out.write(
				`${label}: gate still closed after ${secs()}s — running anyway\n`,
			);
			return exit("timeout", "run", heldLimb(denial, turnHold()));
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
	/**
	 * @param {GateDenial | null} denial
	 * @param {number} charged
	 */
	const stampDenial = (denial, charged) => {
		const heldOn = heldOnClimbMb(denial);
		if (heldOn > climbHeldMb) {
			climbHeldMb = heldOn;
			onClimbHeld(heldOn);
		}
		hear.onMemoryHeld(denial?.limb === "memory");
		if (denial?.limb === "memory" && denial.rungMb !== undefined)
			hearRung(denial.rungMb);
		hear.onRestHeld(
			denial?.limb === "memory" && denial.busy === 0 && !denial.climbMb,
		);
		hear.onWindowsHeld(denial?.limb === "windows");
		climbKept =
			heldOn > 0 || (climbKept && isClimbKept(denial?.limb, charged > 0));
		hear.onClimbStamp(climbKept);
	};
	/** @returns {Promise<WaitOutcome>} */
	const leaveOrWait = () => {
		const emptied = leave();
		if (emptied !== null) {
			out.write(
				`${label}: after ${secs()}s ${emptied} reaches no test file, so this run leaves the queue (#1158).\n`,
			);
			return exit("left", "left");
		}
		return wait();
	};
	/** @param {SessionCapHold} capHold @returns {Promise<WaitOutcome>} */
	const heldOnCap = (capHold) => {
		report(capHold, []);
		if (clock() - started < timeoutMs) return leaveOrWait();
		sayBreakdown();
		out.write(sessionCapRefusal(label, secs(), timeoutMs, capHold));
		return exit("refused", "refused", "session-cap");
	};
	/** @returns {Promise<WaitOutcome>} */
	const step = () => {
		const capHold = sessionCap();
		if (capHold) return heldOnCap(capHold);
		const charged = climbMb();
		const denial = releaseWindows(gate(charged, hearAdmission));
		stampDenial(denial, charged);
		const open = !denial && turn();
		see(denial, open);
		if (!open && clock() - started >= timeoutMs)
			return part ? proceed(denial, false) : refuse(denial);
		if (open) return proceed(denial, true);
		return leaveOrWait();
	};
	return step();
}

/**
 * @typedef {{ on: (signal: NodeJS.Signals, listener: () => void) => unknown }} SignalEmitter
 * @typedef {{ waiting: () => boolean, logKilled: (signal: string) => void, leave: () => void, onSignal?: (signal: NodeJS.Signals, code: number) => boolean }} SignalSeat
 * @typedef {{ seats: Set<SignalSeat>, cleanups: Set<(signal: string) => void>, exit: (code: number) => void }} SignalHost
 */

/** @type {WeakMap<SignalEmitter, SignalHost>} */
const signalHosts = new WeakMap();

/**
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
	for (const cleanup of host.cleanups) ignoreFailure(() => cleanup(signal));
	for (const seat of seats) seat.leave();
	host.exit(code);
}

/**
 * @param {{ queue?: QueueOptions, join?: false | { role?: string, chargeMb?: number, weight?: import("./suite-handoff.js").CarriedWeight, kind?: PartKind, holder?: SeatHolder, session?: string | null, env?: NodeJS.ProcessEnv }, turn?: () => boolean, logExit?: (reason: import("./queue-exit-log.js").QueueExitReason, waitMs: number, extra?: object) => void, signals?: true | { emitter?: SignalEmitter, exit?: (code: number) => void, onSignal?: (signal: NodeJS.Signals, code: number) => boolean } }} [options]
 */
function queueSeat({ queue = {}, join = {}, turn, logExit, signals } = {}) {
	const ticket = join === false ? "" : queueJoin({ ...queue, ...join });
	const stamps = queueStamps(
		ticket,
		queue,
		join !== false && placeSessionOf({ ...queue, ...join }) !== null,
	);
	const passing = turn ? null : passingTurn(queue);
	/** @type {(reason: WaitExitReason, heldBy?: WaitHold) => object} */
	const exitFields = passing
		? passing.exitFields
		: (_reason, heldBy) => ({ ...heldBy });
	const started = monotonicMs();
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
			logExit?.("killed", monotonicMs() - started, {
				signal,
				...stamps.polledHold(),
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
		spawned: (/** @type {SpawnCharge} */ charge = {}) =>
			queueSpawned(ticket, queue, charge),
		leave,
	};
}

/** @typedef {{ queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number, alive?: (pid: number) => boolean, slots?: number }} QueueOptions */
/** @typedef {ReturnType<typeof queueSeat>} QueueSeat */

/**
 * @param {string} role
 * @param {number} defaultMb
 * @param {string} [queueDir]
 * @returns {{ records: (QueueRecord & { chargeMb: number })[], unread: import("./admission.js").UnreadReserve | null }}
 */
function readLiveCharged(role, defaultMb, queueDir) {
	const { records, unread } = readLiveRoleMarkers(role, { queueDir });
	return {
		records: records.map((r) => ({
			...r,
			chargeMb: Number.isFinite(r.chargeMb) ? Number(r.chargeMb) : defaultMb,
		})),
		unread: unread === null ? null : { why: unread, chargeMb: defaultMb },
	};
}

/**
 * @param {{ queueDir?: string }} [options]
 * @returns {import("./admission.js").Gates}
 */
function readLiveGateSeats({ queueDir } = {}) {
	const { records, unread } = readLiveCharged(
		GATE_ROLE,
		GATE_SEAT_DEFAULT_MB,
		queueDir,
	);
	return {
		live: records.map((r) => ({
			pid: r.pid,
			chargeMb: r.chargeMb,
			spawned: r.spawned === true,
			part: r.part === true,
		})),
		unread,
	};
}

/**
 * @param {{ queueDir?: string, parentOf?: (pid: number) => number }} [options]
 * @returns {import("./suite-ladder.js").GateSeats}
 */
function readGateSeats({ queueDir, parentOf = readParentOf } = {}) {
	const { live, unread } = readLiveGateSeats({ queueDir });
	const spawned = live.filter((g) => g.spawned);
	const holders = spawned.map((g) => g.pid);
	const part = spawned.filter((g) => g.part).length;
	return {
		count: holders.length - part,
		part,
		unread: unread?.why ?? null,
		under: (pid) =>
			pid !== null &&
			holders.length > 0 &&
			[pid, ...readAncestorsOf(pid, { parentOf })].some((p) =>
				holders.includes(p),
			),
	};
}

module.exports = {
	readGateSeats,
	readLiveGateSeats,
	PART_PASS_AGE_MS,
	partLaneOf,
	WINDOWS_MAX_HOLD_MS,
	turnOf,
	waiterOf,
	isClimbKept,
	SEAT_ENV,
	SESSION_PLACES,
	splitPlaces,
	heldMarker,
	heldSeat,
	readSlotPlace,
	defaultQueueDir,
	readStartTimeOf,
	isMarkerStale,
	readMarkers,
	readLiveCharged,
	readLiveRoleMarkers,
	readTestsHeldOnWindows,
	readTestsHeldOnMemory,
	readQueuesClimbMb,
	queuedRunnerPeakMb,
	gateDenies,
	waitForGate,
	peerClimbTurn,
	queueSeat,
	armSeatSignals,
};
