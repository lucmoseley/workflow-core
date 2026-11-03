/*
 * periodic-reading.js — the at-most-every-so-often gate a session-start
 * reporter reads behind: a STAMP holding the last reading's time, and a LOCK
 * held as a pidfile so two session starts never both read and both file
 * (#1219, #1378).
 *
 * The stamp is written before the reading, so a reading that throws is
 * retried at the next interval, never at the next session start.
 *
 * The lock is stale only once its holder has gone (#4016). Residual: a reading
 * that hangs keeps it until the caller's own ceiling ends the run, or, where
 * the caller has none, until the process is killed; only that reporter stops
 * reading meanwhile.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { pidLock } = require("./pid-lock.js");

/**
 * When the stamp says the last reading was, or null where there is none yet.
 *
 * @param {string} file
 * @returns {number | null}
 * @throws where the stamp exists and will not read, so the caller fails open,
 *   recorded, rather than reading on every session start unseen
 */
function readStampedAt(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	const t = Date.parse(text.trim());
	return Number.isNaN(t) ? null : t;
}

/**
 * Run `read` unless a reading landed within `everyMs` of `nowMs` or another
 * run holds the lock.
 *
 * @template T
 * @param {{ stamp: string, lock: string, script: string, nowMs: number,
 *   everyMs: number }} gate `script` is the basename of the program running
 *   the gate, which a live holder's command line must carry
 * @param {() => T} read
 * @returns {{ ran: true, value: T }
 *   | { ran: false, why: "recent", last: number }
 *   | { ran: false, why: "locked" | "just-read" }}
 *   `just-read`: the lock was free, but a run that released it a moment ago
 *   had just read.
 */
function periodicReading(gate, read) {
	const recent = () => {
		const last = readStampedAt(gate.stamp);
		return last !== null && gate.nowMs - last < gate.everyMs ? last : null;
	};
	const last = recent();
	if (last !== null) return { ran: false, why: "recent", last };
	const lock = pidLock(gate.lock, gate.script);
	if (!lock.acquire()) return { ran: false, why: "locked" };
	try {
		if (recent() !== null) return { ran: false, why: "just-read" };
		fs.writeFileSync(gate.stamp, new Date(gate.nowMs).toISOString());
		return { ran: true, value: read() };
	} finally {
		lock.release();
	}
}

/**
 * The line a run prints where the gate read nothing.
 *
 * @param {{ why: "recent", last: number } | { why: "locked" | "just-read" }} skipped
 * @param {string} every the interval in words, "an hour"
 */
function buildSkipLine(skipped, every) {
	if (skipped.why === "recent")
		return `Read at ${new Date(skipped.last).toISOString().slice(0, 16).replace("T", " ")} UTC, under ${every} ago; nothing read.`;
	return skipped.why === "locked"
		? "Another run is reading; nothing read."
		: "Another run read just now; nothing read.";
}

module.exports = { periodicReading, buildSkipLine };
