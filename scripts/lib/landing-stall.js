/*
 * landing-stall.js — what the session-start stall check and the refill loop's
 * supervision read off the landing queue, and the one read both take (#2406, spec #2261, #2692): a
 * stalled queue, a dead lander, or a held one. The read also keeps the record
 * of when `landing` went ahead.
 *
 * STALLED: `landing` holds commits `main` lacks, and has for STALL_MS without
 * `main` moving. `main` last moved at the later of the time the lander's
 * heartbeat records for its last move and `main`'s tip's committer time, which
 * no move to that tip can predate: the second covers a `main` no lander has
 * moved yet, or one pushed by hand. Counting from `main`, not from a queued
 * commit, tells a slow red batch, which moves `main` as it lands parents, from
 * a stuck queue. The clock starts no earlier than the first reading that found
 * `landing` ahead of the present `main`, so a push onto a `main` idle for
 * hours is not a stall the moment it lands (#3303), and no earlier than the
 * guest's last boot or resume, as nothing can land while it is down or frozen
 * (#4055). Residual: a queue stuck before one goes unreported for up to 2 h
 * more, and a machine down or frozen within every 2 h never reports one.
 * WFC_UPTIME_S replaces the guest's uptime, for tests.
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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const {
	HEARTBEAT_MS,
	landerFiles,
	readHeartbeat,
	remoteGit,
	short,
} = require("./lander.js");

/* About 3.6 median whole-suite runs of 1987 s (#2672, from #2666's
 * measurement); not measured against red batches. scripts/main-lag-alarm.js,
 * the off-machine check, reads it too. */
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
 * @property {number|null} aheadSince when a reading first found `landing`
 *   ahead of, or diverged from, the present `main`, in ms; null where unknown
 * @property {number} wokeAt when the guest last booted or resumed, in ms
 * @property {import("./lander.js").Heartbeat|null} heartbeat
 * @property {(pid: number) => boolean} alive
 */

/**
 * @param {QueueReading} r
 * @returns {StallFinding[]}
 */
function stallFindings({
	now,
	landing,
	relation,
	mainAt,
	aheadSince,
	wokeAt,
	heartbeat,
	alive,
}) {
	/** @type {StallFinding[]} */
	const found = [];
	const moved = mainMovedAt(mainAt, heartbeat);
	if (
		landing !== null &&
		queued(relation) &&
		moved !== null &&
		now - Math.max(moved, aheadSince ?? moved, wokeAt) > STALL_MS
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
 * A span as `<h> h <m> min`, rounded down.
 * @param {number} ms
 */
function formatHoursMin(ms) {
	const min = Math.floor(ms / 60_000);
	return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** @param {import("./lander.js").Relation} relation */
const queued = (relation) => relation === "ahead" || relation === "diverged";

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
 * What the refill loop does about a reading (#2692, ruled at #2672): file
 * the stall ticket where `main` has not moved with `landing` ahead of it and
 * a lander running or dead, since one that fails on every start is restarted
 * each tick and never seen running. Not for a held queue, which has its
 * held-queue issue, nor for a lander between runs on a fresh beat.
 * @param {QueueReading} r
 * @returns {{ticket: {landing: string, movedAt: number}|null}}
 */
function supervision(r) {
	const found = stallFindings(r);
	const dead = found.some((f) => f.tag === "LANDER-DEAD");
	const running = r.heartbeat !== null && r.alive(r.heartbeat.pid);
	const stalled = found.find((f) => "movedAt" in f);
	return {
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
	const now = Date.now();
	return {
		now,
		...refs,
		mainAt: refs.main === null ? null : git.committedAt(refs.main),
		aheadSince: recordAhead(path.join(markersDir(root), AHEAD), {
			main: queued(refs.relation) ? refs.main : null,
			now,
		}),
		wokeAt: recordWake(path.join(markersDir(root), WAKE), {
			startedAt: now - Number(process.env.WFC_UPTIME_S ?? os.uptime()) * 1000,
			now,
		}),
		heartbeat: readHeartbeat(landerFiles(root).heartbeat),
		alive: pidAlive,
	};
}

/* When `landing` was first read ahead of `main`. */
const AHEAD = ".landing-ahead.json";

/**
 * When `file` records `main` was first read behind `landing`, recording `now`
 * where it names another `main` or none, and clearing it where `main` is null
 * (`landing` not ahead). Null where the record cannot be written, so the
 * clock falls back to `main`'s last move rather than never starting (#3303).
 * @param {string} file
 * @param {{main: string|null, now: number}} at
 */
function recordAhead(file, { main, now }) {
	try {
		if (main === null) {
			fs.rmSync(file, { force: true });
			return null;
		}
		let rec = null;
		try {
			rec = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			/* Absent, or torn by a hand edit: timed afresh (#3303). */
		}
		const since = rec?.main === main ? Date.parse(rec.since) : Number.NaN;
		if (Number.isFinite(since)) return since;
		writeFileAtomic(
			file,
			`${JSON.stringify({ main, since: new Date(now).toISOString() })}\n`,
			{ mkdir: true },
		);
		return now;
	} catch {
		/* An unwritable markers directory must not stop a dead lander's restart. */
		return null;
	}
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
	formatHoursMin,
	mainMovedAt,
	readQueue,
	stallFindings,
	supervision,
};
