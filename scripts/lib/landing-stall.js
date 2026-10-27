/*
 * landing-stall.js — what the session-start stall check and the refill loop's
 * supervision read off the landing queue, and the one read both take (workflow-core#2406, spec workflow-core#2261, workflow-core#2692): a
 * stalled queue, a dead lander, or a held one.
 *
 * STALLED: `landing` holds commits `main` lacks, and `main` has not moved for
 * STALL_MS. It last moved at the later of the time the lander's heartbeat
 * records for its last move and `main`'s tip's committer time, which no move
 * to that tip can predate: the second covers a `main` no lander has moved yet,
 * or one pushed by hand. Counting from `main`, not from a queued commit, tells
 * a slow red batch, which moves `main` as it lands parents, from a stuck queue.
 *
 * Both below need `landing` ahead of `main` and the pid the heartbeat names
 * not running. A live pid with a stale beat is a lander inside one push,
 * which beats only between git calls; residual: a hung lander, or a reused
 * pid, reads alive and is caught by the stall alone.
 *
 * HELD: the last run held with `landing` at its present tip, which a run
 * leaves alone until a push moves it.
 *
 * DEAD: otherwise, where the heartbeat is absent or older than STALE_MS.
 */

const { pidAlive } = require("./arbiter-proc.js");
const {
	HEARTBEAT_MS,
	landerFiles,
	readHeartbeat,
	remoteGit,
	short,
} = require("./lander.js");

/* About 3.6 median whole-suite runs of 1987 s (workflow-core#2672, from workflow-core#2666's
 * measurement); not measured against red batches. */
const STALL_MS = 2 * 60 * 60 * 1000;
/* Untraced: five missed beats, so one slow tester tick is never read as a
 * death. */
const STALE_MS = 5 * HEARTBEAT_MS;

/**
 * @typedef {{tag: "LANDING-STALLED", line: string, movedAt: number}
 *   | {tag: "LANDER-DEAD" | "LANDING-HELD", line: string}} StallFinding
 * @typedef {object} QueueReading
 * @property {number} now
 * @property {string|null} landing `landing`'s sha
 * @property {import("./lander.js").Relation} relation
 * @property {number|null} mainAt `main`'s tip's committer time in ms, null
 *   where the remote has no `main`
 * @property {import("./lander.js").Heartbeat|null} heartbeat
 * @property {(pid: number) => boolean} alive
 */

/**
 * @param {QueueReading} r
 * @returns {StallFinding[]}
 */
function stallFindings({ now, landing, relation, mainAt, heartbeat, alive }) {
	/** @type {StallFinding[]} */
	const found = [];
	const moved = mainMovedAt(mainAt, heartbeat);
	if (
		landing !== null &&
		(relation === "ahead" || relation === "diverged") &&
		moved !== null &&
		now - moved > STALL_MS
	)
		found.push({
			tag: "LANDING-STALLED",
			movedAt: moved,
			line: `main has not moved since ${new Date(moved).toISOString()}, over ${STALL_MS / 60_000} min, with landing ${short(landing)} ${relation === "ahead" ? "ahead of it" : "diverged from it"}`,
		});
	if (relation !== "ahead" || landing === null) return found;
	if (heartbeat !== null && alive(heartbeat.pid)) return found;
	const hold = heartbeat?.hold;
	if (hold && hold.landing === landing)
		found.push({
			tag: "LANDING-HELD",
			line: `the lander holds landing at ${short(landing)}: ${hold.reason}. ${hold.filed}`,
		});
	else if (!(heartbeat && now - Date.parse(heartbeat.at) <= STALE_MS))
		found.push({
			tag: "LANDER-DEAD",
			line: `landing ${short(landing)} is ahead of main and no lander is running, its heartbeat ${heartbeat ? `last written ${heartbeat.at}` : "absent"}`,
		});
	return found;
}

/**
 * When `main` last moved: the later of the heartbeat's record and its tip's
 * committer time; null where neither is known.
 * @param {number|null} mainAt
 * @param {import("./lander.js").Heartbeat|null} heartbeat
 */
function mainMovedAt(mainAt, heartbeat) {
	const recorded = heartbeat?.movedAt
		? Date.parse(heartbeat.movedAt)
		: Number.NaN;
	const known = [mainAt, recorded].filter(
		(t) => t !== null && Number.isFinite(t),
	);
	return known.length > 0 ? Math.max(.../** @type {number[]} */ (known)) : null;
}

/**
 * What the refill loop does about a reading (workflow-core#2692, ruled at workflow-core#2672): start a
 * lander where it is dead, and file the stall ticket where `main` has not
 * moved with `landing` ahead of it and a lander running or dead, since one
 * that fails on every start is restarted each tick and never seen running.
 * Neither for a held queue, which has its held-queue issue, nor for a lander
 * between runs on a fresh beat.
 * @param {QueueReading} r
 * @returns {{start: boolean, ticket: {landing: string, movedAt: number}|null}}
 */
function supervision(r) {
	const found = stallFindings(r);
	const dead = found.some((f) => f.tag === "LANDER-DEAD");
	const running = r.heartbeat !== null && r.alive(r.heartbeat.pid);
	const stalled = found.find((f) => "movedAt" in f);
	return {
		start: dead,
		ticket:
			stalled &&
			"movedAt" in stalled &&
			r.relation === "ahead" &&
			r.landing !== null &&
			(dead || running)
				? { landing: r.landing, movedAt: stalled.movedAt }
				: null,
	};
}

/**
 * @param {string} root
 * @returns {QueueReading & {main: string|null}}
 */
function readQueue(root) {
	const git = remoteGit(root);
	const refs = git.refs();
	return {
		now: Date.now(),
		...refs,
		mainAt: refs.main === null ? null : git.committedAt(refs.main),
		heartbeat: readHeartbeat(landerFiles(root).heartbeat),
		alive: pidAlive,
	};
}

module.exports = { STALL_MS, readQueue, stallFindings, supervision };
