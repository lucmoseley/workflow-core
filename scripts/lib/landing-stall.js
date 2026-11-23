const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { holderAlive } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { orFallback } = require("./caught.js");
const {
	HEARTBEAT_MS,
	queueLanderFiles,
	readHeartbeat,
} = require("./lander-files.js");
const { GH_TIMEOUT_MS } = require("./gh-binary.js");
const {
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	PUSH_TIMEOUT_MS,
	readGit,
	short,
} = require("./lander-git.js");
const { INSTALL_TIMEOUT_MS } = require("./npm-ci-staging.js");
const { queueBranch } = require("./landing-refs.js");
const { readOwedDrops } = require("./lander-records.js");
const { markersDir } = require("./marker-root.js");
const { queueGit } = require("./queue-lander-adapters.js");
const { oldestWaiting, queueGaugeOf } = require("./queue-gauge.js");
const { queueLogFile, readQueueRows } = require("./queue-log.js");
const { STALL_MS } = require("./queue-tickets.js");
const { landerLog } = require("./lander-start.js");
const { HELD, LOCK_HELD } = require("./queue-lander.js");
const { parseErrorText } = require("./caught.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { parseLanderLog, readLogSince } = require("./time-to-land.js");

// guess, #2406
const STALE_MS = 5 * HEARTBEAT_MS;
// guess, #5436
const HELD_WINDOW_MS = DAY_MS;
const LONGEST_CALL_MS = Math.max(
	PUSH_TIMEOUT_MS,
	INSTALL_TIMEOUT_MS,
	GATED_COMMIT_TIMEOUT_MS,
	GH_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
);
const HUNG_MS = LONGEST_CALL_MS + HEARTBEAT_MS;

/**
 * @typedef {{tag: "LANDING-STALLED", line: string, movedAt: number}
 *   | {tag: "LANDER-DEAD", line: string}
 *   | {tag: "LANDER-HUNG", line: string}
 *   | {tag: "LANDER-HELD", line: string}
 *   | {tag: "LANDER-LOG-UNREAD", line: string}} StallFinding
 * @typedef {{kind: "held", at: number, reason: string}
 *   | {kind: "none"} | {kind: "unread", fault: string}} HeldRead
 * @typedef {object} QueueReading
 * @property {number} now
 * @property {string|null} main
 * @property {number|null} movedAt
 * @property {import("./queue-gauge.js").QueueGauge} gauge
 * @property {number} wokeAt
 * @property {import("./lander-files.js").Heartbeat|null} heartbeat
 * @property {(beat: import("./lander-files.js").Heartbeat) => boolean} alive
 * @property {number} owed
 * @property {HeldRead} held
 */

/** @param {QueueReading} r */
const running = (r) => r.heartbeat !== null && r.alive(r.heartbeat);

/**
 * @param {QueueReading} r
 * @returns {StallFinding[]}
 */
function stallFindings(r) {
	const { now, movedAt, gauge, wokeAt, heartbeat } = r;
	const oldest = oldestWaiting(gauge.waiting);
	if (oldest === null) return [];
	/** @type {StallFinding[]} */
	const found = [];
	const at = `${queueBranch(oldest.name)} ${short(oldest.sha)}`;
	if (
		movedAt !== null &&
		now - Math.max(movedAt, oldest.since, wokeAt) > STALL_MS
	)
		found.push({
			tag: "LANDING-STALLED",
			movedAt,
			line: `main has not moved since ${new Date(movedAt).toISOString()}, over ${STALL_MS / 60_000} min, with ${at} waiting since ${new Date(oldest.since).toISOString()}`,
		});
	if (r.held.kind === "held")
		found.push({ tag: "LANDER-HELD", line: buildHeldLine(r.held) });
	if (r.held.kind === "unread")
		found.push({ tag: "LANDER-LOG-UNREAD", line: buildUnreadLine(r.held) });
	if (heartbeat && running(r)) {
		const age = now - Date.parse(heartbeat.at);
		if (age > HUNG_MS)
			found.push({
				tag: "LANDER-HUNG",
				line: `${at} waits and the queue lander, pid ${heartbeat.pid}, still runs but last beat ${Math.round(age / 60_000)} min ago, past the ${HUNG_MS / 60_000} min its longest step between beats can take`,
			});
		return found;
	}
	if (!(heartbeat && now - Date.parse(heartbeat.at) <= STALE_MS))
		found.push({
			tag: "LANDER-DEAD",
			line: `${at} waits and no queue lander is running, its heartbeat ${heartbeat ? `last written ${heartbeat.at}` : "absent"}`,
		});
	return found;
}

/** @param {Extract<HeldRead, {kind: "held"}>} h */
const buildHeldLine = (h) =>
	`the queue lander's last run, at ${new Date(h.at).toISOString()}, ended held: ${h.reason}`;

/** @param {Extract<HeldRead, {kind: "unread"}>} h */
const buildUnreadLine = (h) =>
	`the queue lander's log would not read, so a held run end goes unseen: ${h.fault}`;

/**
 * @param {readonly import("./time-to-land.js").LanderEvent[]} events
 * @param {number} since
 * @returns {HeldRead}
 */
function heldExitOf(events, since) {
	const end = events.findLast(
		(e) => e.t >= since && e.kind === "exit" && e.rest !== LOCK_HELD,
	);
	return end?.rest.startsWith(HELD)
		? { kind: "held", at: end.t, reason: end.rest.slice(HELD.length) }
		: { kind: "none" };
}

/**
 * @param {string} root
 * @param {number} now
 * @returns {HeldRead}
 */
function readHeldExit(root, now) {
	const since = now - HELD_WINDOW_MS;
	try {
		return heldExitOf(
			parseLanderLog(readLogSince(landerLog(root), since)),
			since,
		);
	} catch (err) {
		return { kind: "unread", fault: parseErrorText(err) };
	}
}

/**
 * @param {QueueReading} r
 * @returns {{start: boolean, ticket: {waiting: string, movedAt: number}|null}}
 */
function supervision(r) {
	const found = stallFindings(r);
	const oldest = oldestWaiting(r.gauge.waiting);
	const live = running(r);
	const dead = found.some((f) => f.tag === "LANDER-DEAD");
	const stalled = found.find((f) => "movedAt" in f);
	return {
		start: (oldest !== null || r.owed > 0) && !live,
		ticket:
			stalled && "movedAt" in stalled && oldest !== null && (dead || live)
				? {
						waiting: `${queueBranch(oldest.name)} at ${oldest.sha}`,
						movedAt: stalled.movedAt,
					}
				: null,
	};
}

/**
 * @param {number} mainAt
 * @param {import("./queue-log.js").LoggedRow[]} rows
 */
const mainMovedAt = (mainAt, rows) =>
	rows.reduce(
		(t, row) => (row.event === "land" ? Math.max(t, row.at) : t),
		mainAt,
	);

/**
 * @param {string} root
 * @param {number} now
 * @returns {QueueReading}
 */
function readQueue(root, now) {
	const { main, queue } = queueGit(root).refs();
	const rows = readQueueRows(queueLogFile(root));
	return {
		now,
		main,
		movedAt: main === null ? null : mainMovedAt(committedAt(root, main), rows),
		gauge: queueGaugeOf(queue, rows, now),
		wokeAt: recordWake(path.join(markersDir(root), WAKE), {
			startedAt: now - Number(process.env.WFC_UPTIME_S ?? os.uptime()) * 1000,
			now,
		}),
		heartbeat: readHeartbeat(queueLanderFiles(root).heartbeat),
		alive: holderAlive,
		owed: readOwedDrops(queueLanderFiles(root).drops).length,
		held: readHeldExit(root, now),
	};
}

/**
 * @param {string} root
 * @param {string} sha
 * @returns {number}
 */
function committedAt(root, sha) {
	const at =
		Number(readGit(root, ["log", "-1", "--format=%ct", sha]).trim()) * 1000;
	if (!Number.isFinite(at) || at === 0)
		throw new Error(`git log printed no committer time for ${sha}`);
	return at;
}

const WAKE = ".machine-wake.json";
// guess, #4055
const WAKE_SLACK_MS = 5 * 60 * 1000;

/**
 * @param {string} file
 * @param {{startedAt: number, now: number}} at
 */
function recordWake(file, { startedAt, now }) {
	/** @type {{startedAt?: number, wokeAt?: number}|null} */
	const rec = orFallback(() => JSON.parse(fs.readFileSync(file, "utf8")), null);
	if (
		typeof rec?.startedAt === "number" &&
		typeof rec.wokeAt === "number" &&
		startedAt - rec.startedAt <= WAKE_SLACK_MS
	)
		return rec.wokeAt;
	const wokeAt = rec === null ? startedAt : now;
	try {
		writeFileAtomic(file, `${JSON.stringify({ startedAt, wokeAt })}\n`, {
			mkdir: true,
		});
	} catch {
		return startedAt;
	}
	return wokeAt;
}

module.exports = {
	HUNG_MS,
	buildHeldLine,
	buildUnreadLine,
	readHeldExit,
	readQueue,
	stallFindings,
	supervision,
};
