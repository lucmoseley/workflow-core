/*
 * periodic-reading.js — the at-most-every-so-often gate a session-start
 * reporter reads behind: a STAMP holding the last reading's time, and a LOCK
 * taken with exclusive create so two session starts never both read and both
 * file (workflow-core#1219, workflow-core#1378).
 *
 * The stamp is written before the reading, so a reading that throws is
 * retried at the next interval, never at the next session start.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");

/* A guess, not a measurement: a reading takes seconds, so a lock this old
 * belongs to a run that died holding it. A caller whose reading can run longer
 * sets its own `lockStaleMs`, above its own ceiling (workflow-core#1548). */
const LOCK_STALE_MS = 10 * 60_000;

/**
 * Take `file` as the lock. False where another run holds a live one.
 *
 * @param {string} file
 * @param {number} staleMs
 * @returns {boolean}
 */
function lock(file, staleMs) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, String(process.pid), { flag: "wx" });
			return true;
		} catch (e) {
			if (caught(e).code !== "EEXIST") throw e;
		}
		let age;
		try {
			age = Date.now() - fs.statSync(file).mtimeMs;
		} catch (e) {
			if (caught(e).code === "ENOENT") continue;
			throw e;
		}
		if (age < staleMs) return false;
		fs.rmSync(file, { force: true });
	}
	return false;
}

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
 * @param {{ stamp: string, lock: string, nowMs: number, everyMs: number,
 *   lockStaleMs?: number }} gate
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
	if (!lock(gate.lock, gate.lockStaleMs ?? LOCK_STALE_MS))
		return { ran: false, why: "locked" };
	try {
		if (recent() !== null) return { ran: false, why: "just-read" };
		fs.writeFileSync(gate.stamp, new Date(gate.nowMs).toISOString());
		return { ran: true, value: read() };
	} finally {
		fs.rmSync(gate.lock, { force: true });
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
