const fs = require("node:fs");
const { gitTopLevel } = require("./host-root.js");
const { deref } = require("./deref.js");
const { monotonicMs } = require("./clock.js");
const { QUEUE_POLL_MS } = require("./queue-poll.js");
const {
	QUEUE_TIMEOUT_MS,
	armSeatSignals,
	isMarkerStale,
	readMarkers,
	readStartTimeOf,
} = require("./suite-queue.js");
const {
	hasLiveJoiner,
	openCapture,
	readCaptured,
	readResult,
	removeRunFiles,
	writeJoinMarker,
} = require("./tsc-join-files.js");

/**
 * @typedef {import("./tsc-join-files.js").TscHolder} TscHolder
 * @typedef {import("./tsc-join-files.js").RunId} RunId
 * @typedef {import("./tsc-join-files.js").RunResult} RunResult
 * @typedef {Omit<TscHolder, "session">} JoinKey
 * @typedef {{ write: (s: string) => unknown }} Out
 * @typedef {{ file: string, record: import("./suite-queue.js").QueueRecord }} Marker
 */

/**
 * @param {string[]} words
 * @param {{ toplevel: string, cwd: string }} [worktree]
 * @returns {JoinKey | null}
 */
function readJoinKey(words, worktree) {
	if (worktree) return { ...worktree, command: words };
	try {
		const cwd = process.cwd();
		return { toplevel: gitTopLevel(cwd), cwd: deref(cwd), command: words };
	} catch {
		return null;
	}
}

/**
 * @param {object} record
 * @param {JoinKey} key
 */
function isSameKey(record, key) {
	const r = /** @type {Partial<Record<keyof JoinKey, unknown>>} */ (record);
	return (
		r.toplevel === key.toplevel &&
		r.cwd === key.cwd &&
		Array.isArray(r.command) &&
		r.command.length === key.command.length &&
		r.command.every((word, i) => word === key.command[i])
	);
}

/**
 * @typedef {{
 *   queueDir: string,
 *   queueFs?: typeof fs,
 *   alive?: (pid: number) => boolean,
 *   pid: number,
 *   session: string | null,
 *   key: JoinKey,
 *   asked: { wall: number, mono: number },
 *   monoClock?: () => number,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   sleepFn?: (ms: number) => Promise<unknown>,
 *   logExit: (reason: import("./queue-exit-log.js").QueueExitReason, waitMs: number, extra?: object) => void,
 *   out: Out,
 *   stdout: Out,
 *   err: Out,
 *   label: string,
 *   exitStatus: (code: number | null, signal: NodeJS.Signals | null) => number,
 *   signals: Parameters<typeof armSeatSignals>[0],
 * }} Joining
 */

/** @param {((pid: number) => boolean) | undefined} alive */
const staleWith =
	(alive) => (/** @type {{ pid: number, start?: number }} */ r) =>
		isMarkerStale(r, alive ? { alive } : {});

/** @param {Joining} j */
const staleOf = (j) => staleWith(j.alive);

/**
 * @param {Joining} j
 * @returns {Marker | null}
 */
function findJoinable(j) {
	const mine = { pid: j.pid, at: j.asked.wall };
	const stale = staleOf(j);
	const { markers } = readMarkers(j.queueDir, j.queueFs);
	return (
		markers
			.filter(
				({ record: r }) =>
					r.pid !== j.pid &&
					!hasStarted(r) &&
					isSameKey(r, j.key) &&
					askedBefore(r, mine) &&
					!stale(r),
			)
			.sort((a, b) => (askedBefore(a.record, b.record) ? -1 : 1))[0] ?? null
	);
}

/**
 * @param {{ pid: number, at: number }} a
 * @param {{ pid: number, at: number }} b
 */
const askedBefore = (a, b) => a.at < b.at || (a.at === b.at && a.pid < b.pid);

/** @param {import("./suite-queue.js").QueueRecord} r */
const hasStarted = (r) => r.spawned === true || r.admitted === true;

/**
 * @param {Marker} target
 * @param {Joining} j
 * @returns {import("./suite-queue.js").QueueRecord | null | "torn"}
 */
function readRun(target, j) {
	let text;
	try {
		text = String((j.queueFs ?? fs).readFileSync(target.file, "utf8"));
	} catch {
		return null;
	}
	let record;
	try {
		record = JSON.parse(text);
	} catch {
		return "torn";
	}
	return record?.pid === target.record.pid &&
		record?.start === target.record.start &&
		!staleOf(j)(record)
		? record
		: null;
}

/**
 * @param {Marker} target
 * @returns {RunId}
 */
const runOf = (target) => ({
	pid: target.record.pid,
	start: target.record.start ?? 0,
});

/**
 * @param {Marker} target
 * @param {Joining} j
 * @returns {"unconfirmed" | "unwritten" | (() => void)}
 */
function enterJoin(target, j) {
	const marker = writeJoinMarker(
		j.queueDir,
		{
			pid: j.pid,
			start: readStartTimeOf(j.pid),
			at: j.asked.wall,
			session: j.session,
			run: runOf(target),
		},
		j.queueFs,
	);
	if (!marker) return "unwritten";
	const dropMarker = () => (j.queueFs ?? fs).rmSync(marker, { force: true });
	const confirmed = readRun(target, j);
	if (confirmed && confirmed !== "torn" && !hasStarted(confirmed))
		return dropMarker;
	dropMarker();
	return "unconfirmed";
}

/**
 * @param {Marker} target
 * @param {Joining} j
 * @param {() => void} dropMarker
 * @returns {Promise<{ code: number } | { lost: true }>}
 */
async function follow(target, j, dropMarker) {
	const run = runOf(target);
	const clock = j.monoClock ?? monotonicMs;
	const joined = { pid: run.pid, session: target.record.session ?? null };
	/** @type {number | null} */
	let spawnedMono = null;
	/** @type {number | null} */
	let spawnedWall = null;
	let following = true;
	const host = armSeatSignals(j.signals);
	/** @type {import("./suite-queue.js").SignalSeat} */
	const entry = {
		waiting: () => following,
		logKilled: (signal) => {
			if (!following) return;
			following = false;
			j.logExit("killed", (spawnedMono ?? clock()) - j.asked.mono, {
				...(spawnedWall === null
					? {}
					: { at: new Date(spawnedWall).toISOString() }),
				signal,
				joined,
			});
		},
		leave: dropMarker,
	};
	host.seats.add(entry);
	const end = () => {
		following = false;
		host.seats.delete(entry);
		dropMarker();
	};
	const sleep =
		j.sleepFn ??
		((/** @type {number} */ ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)));
	/** @returns {{ code: number } | { lost: true } | null} */
	const step = () => {
		const live = readRun(target, j);
		if (live === "torn") return null;
		const result = readResult(j.queueDir, run, j.queueFs);
		if (result) return { code: take(result, target, j, end) };
		if (!live) {
			end();
			return { lost: true };
		}
		if (live.spawned === true) {
			spawnedMono ??= clock();
			spawnedWall ??= Date.now();
		} else if (clock() - j.asked.mono >= (j.timeoutMs ?? QUEUE_TIMEOUT_MS)) {
			following = false;
			refuseJoin(j, run, clock() - j.asked.mono, joined);
			end();
			return { code: 1 };
		}
		return null;
	};
	try {
		for (;;) {
			const outcome = step();
			if (outcome) return outcome;
			await sleep(j.pollMs ?? QUEUE_POLL_MS);
			if (!following) {
				host.seats.delete(entry);
				return { code: 1 };
			}
		}
	} catch (error) {
		end();
		throw error;
	}
}

/**
 * @param {Joining} j
 * @param {RunId} run
 * @param {number} waitMs
 * @param {{ pid: number, session: string | null }} joined
 */
function refuseJoin(j, run, waitMs, joined) {
	const timeoutMs = j.timeoutMs ?? QUEUE_TIMEOUT_MS;
	j.out.write(
		`${j.label}: the type-check pid ${run.pid} this request joined had not started after ${Math.round(waitMs / 1000)}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: one \`tsc\` runs at a time (#3163).\n`,
	);
	j.logExit("timeout", waitMs, { joined });
}

/**
 * @param {RunResult} result
 * @param {Marker} target
 * @param {Joining} j
 * @param {() => void} end
 * @returns {number}
 */
function take(result, target, j, end) {
	const run = runOf(target);
	const { stdout, stderr } = readCaptured(j.queueDir, run, j.queueFs);
	const session = target.record.session ?? null;
	j.err.write(
		`queue-run: joined the type-check pid ${run.pid} (session ${session ?? "unknown"}) queued at ${new Date(target.record.at).toISOString()}; its output and exit code follow\n`,
	);
	j.stdout.write(stdout);
	j.err.write(stderr);
	j.logExit("opened", result.spawnedAt - j.asked.wall, {
		at: new Date(result.spawnedAt).toISOString(),
		joined: { pid: run.pid, session },
	});
	end();
	const isStale = staleOf(j);
	if (
		!readRun(target, j) &&
		!hasLiveJoiner(j.queueDir, run, { queueFs: j.queueFs, isStale })
	)
		removeRunFiles(j.queueDir, run, j.queueFs);
	return j.exitStatus(result.code, result.signal);
}

/**
 * @param {Joining} j
 * @param {() => void} leaveSeat
 * @returns {Promise<number | { lost: true } | null>}
 */
async function tryJoin(j, leaveSeat) {
	for (;;) {
		const target = findJoinable(j);
		if (!target) return null;
		const entered = enterJoin(target, j);
		if (entered === "unwritten") return null;
		if (entered === "unconfirmed") continue;
		leaveSeat();
		const outcome = await follow(target, j, entered);
		return "code" in outcome ? outcome.code : outcome;
	}
}

/**
 * @template {{ leave: () => void }} S
 * @param {Joining} j
 * @param {S} seat
 * @param {(waitedMs: number) => S} reseat
 * @returns {Promise<{ code: number } | { seat: S }>}
 */
async function joinOrSeat(j, seat, reseat) {
	let current = seat;
	for (;;) {
		const joined = await tryJoin(j, current.leave);
		if (joined === null) return { seat: current };
		if (typeof joined === "number") return { code: joined };
		current = reseat((j.monoClock ?? monotonicMs)() - j.asked.mono);
	}
}

/**
 * @param {{ queueDir: string, queueFs?: typeof fs, pid: number, alive?: (pid: number) => boolean }} where
 */
function captureRun({ queueDir, queueFs, pid, alive }) {
	const run = { pid, start: readStartTimeOf(pid) };
	const capture = openCapture(queueDir, run, queueFs);
	return {
		...capture,
		release: () => {
			const isStale = staleWith(alive);
			if (!hasLiveJoiner(queueDir, run, { queueFs, isStale }))
				removeRunFiles(queueDir, run, queueFs);
		},
	};
}

module.exports = { captureRun, joinOrSeat, readJoinKey };
