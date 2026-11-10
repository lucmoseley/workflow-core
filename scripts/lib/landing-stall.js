/*
 * landing-stall.js — what the session-start stall check and the refill loop's
 * supervision read off the landing queue, and the one read both take (workflow-core#2406,
 * workflow-core#2692, workflow-core#4458): a stalled queue or a dead queue lander.
 *
 * STALLED: a queue ref waits, and has for STALL_MS without `main` moving.
 * `main` last moved at the later of the queue log's newest land row and
 * `main`'s tip's committer time, which no move to that tip can predate: the
 * second covers a `main` pushed by hand. Counting from `main`, not from a
 * queued commit, tells a slow red batch, which moves `main` as it lands
 * passers, from a stuck queue. The clock starts no earlier than the oldest
 * waiting ref's wait (lib/queue-gauge.js), so a push onto a `main` idle for
 * hours is not a stall the moment it lands (workflow-core#3303), and no earlier than the
 * guest's last boot or resume, as nothing can land while it is down or
 * frozen (workflow-core#4055). Residual: a machine down or frozen within every 2 h never
 * reports one. WFC_UPTIME_S replaces the guest's uptime, for tests.
 *
 * DEAD: a queue ref waits, the pid the queue lander's heartbeat names is not
 * running, and the heartbeat is absent or older than STALE_MS. A live pid
 * with a stale beat is a lander inside one call, which beats only between
 * them; residual: a hung lander, or a reused pid, reads alive and is caught
 * by the stall alone.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { execGit } = require("./git.js");
const {
	HEARTBEAT_MS,
	queueLanderFiles,
	readHeartbeat,
} = require("./lander-files.js");
const { LANDER_GIT_TIMEOUT_MS, short } = require("./lander-git.js");
const { markersDir } = require("./marker-root.js");
const { queueGit } = require("./queue-lander-adapters.js");
const { oldestWaiting, queueGaugeOf } = require("./queue-gauge.js");
const { queueLogFile, readQueueRows } = require("./queue-log.js");

/* About 3.6 median whole-suite runs of 1987 s (workflow-core#2672, from workflow-core#2666's
 * measurement); not measured against red batches. */
const STALL_MS = 2 * 60 * 60 * 1000;
/* Untraced: five missed beats, so one slow tester tick is never read as a
 * death. */
const STALE_MS = 5 * HEARTBEAT_MS;

/**
 * @typedef {{tag: "LANDING-STALLED", line: string, movedAt: number}
 *   | {tag: "LANDER-DEAD", line: string}} StallFinding
 * @typedef {object} QueueReading
 * @property {number} now
 * @property {string|null} main `main`'s sha, null where the remote has none
 * @property {number|null} movedAt when `main` last moved, in ms; null where
 *   the remote has no `main`
 * @property {import("./queue-gauge.js").QueueGauge} gauge
 * @property {number} wokeAt when the guest last booted or resumed, in ms
 * @property {import("./lander-files.js").Heartbeat|null} heartbeat the queue
 *   lander's
 * @property {(pid: number) => boolean} alive
 */

/** @param {QueueReading} r */
const running = (r) => r.heartbeat !== null && r.alive(r.heartbeat.pid);

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
	const at = `queue/${oldest.name} ${short(oldest.sha)}`;
	if (
		movedAt !== null &&
		now - Math.max(movedAt, oldest.since, wokeAt) > STALL_MS
	)
		found.push({
			tag: "LANDING-STALLED",
			movedAt,
			line: `main has not moved since ${new Date(movedAt).toISOString()}, over ${STALL_MS / 60_000} min, with ${at} waiting since ${new Date(oldest.since).toISOString()}`,
		});
	if (running(r)) return found;
	if (!(heartbeat && now - Date.parse(heartbeat.at) <= STALE_MS))
		found.push({
			tag: "LANDER-DEAD",
			line: `${at} waits and no queue lander is running, its heartbeat ${heartbeat ? `last written ${heartbeat.at}` : "absent"}`,
		});
	return found;
}

/**
 * What the refill loop does about a reading (workflow-core#2692, ruled at workflow-core#2672): start
 * the queue lander where a queue ref waits and none runs, and file the stall
 * ticket where `main` has not moved with a queue ref waiting and a lander
 * running or dead, since one that fails on every start is restarted each
 * tick and never seen running. No ticket for a lander between runs on a
 * fresh beat.
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
		start: oldest !== null && !live,
		ticket:
			stalled && "movedAt" in stalled && oldest !== null && (dead || live)
				? {
						waiting: `queue/${oldest.name} at ${oldest.sha}`,
						movedAt: stalled.movedAt,
					}
				: null,
	};
}

/**
 * When `main` last moved: the later of its tip's committer time and the
 * queue log's newest land row.
 * @param {number} mainAt
 * @param {import("./queue-log.js").LoggedRow[]} rows
 */
const mainMovedAt = (mainAt, rows) =>
	rows.reduce(
		(t, row) => (row.event === "land" ? Math.max(t, row.at) : t),
		mainAt,
	);

/**
 * The queue's reading in `root`. Throws where the remote or the queue log
 * cannot be read.
 * @param {string} root the canonical checkout's root
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
		alive: pidAlive,
	};
}

/**
 * @param {string} root
 * @param {string} sha
 * @returns {number} its committer time, in ms
 */
function committedAt(root, sha) {
	const at =
		Number(
			execGit(["log", "-1", "--format=%ct", sha], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: LANDER_GIT_TIMEOUT_MS,
			}).trim(),
		) * 1000;
	if (!Number.isFinite(at) || at === 0)
		throw new Error(`git log printed no committer time for ${sha}`);
	return at;
}

/* When the guest last booted or resumed. */
const WAKE = ".machine-wake.json";
/* Untraced: wide of clock slew, and a freeze this short barely moves a 2 h
 * clock. */
const WAKE_SLACK_MS = 5 * 60 * 1000;

/**
 * When the guest last booted or resumed. Uptime stops while a WSL2 guest is
 * frozen in the host's standby, so `startedAt`, the clock less the uptime,
 * rises by each boot's or freeze's length, and the reading that finds it risen
 * dates the wake. The first reading has only `startedAt`. Where the record
 * cannot be written the answer is `startedAt`, so an unwritable directory
 * never stops the clock.
 * @param {string} file
 * @param {{startedAt: number, now: number}} at
 */
function recordWake(file, { startedAt, now }) {
	/** @type {{startedAt?: number, wokeAt?: number}|null} */
	let rec = null;
	try {
		rec = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		/* Absent, or torn by a hand edit: dated from the uptime alone. */
	}
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
	STALL_MS,
	mainMovedAt,
	readQueue,
	stallFindings,
	supervision,
};
