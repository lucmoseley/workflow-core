const fs = require("node:fs");
const { caught } = require("./caught.js");
const { pidLock } = require("./pid-lock.js");

/**
 * @param {string} file
 * @returns {number | null}
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
 * @template T
 * @param {{ stamp: string, lock: string, script: string, nowMs: number,
 *   everyMs: number }} gate
 * @param {() => T} read
 * @returns {{ ran: true, value: T }
 *   | { ran: false, why: "recent", last: number }
 *   | { ran: false, why: "locked" | "just-read" }}
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
 * @param {{ why: "recent", last: number } | { why: "locked" | "just-read" }} skipped
 * @param {string} every
 */
function buildSkipLine(skipped, every) {
	if (skipped.why === "recent")
		return `Read at ${new Date(skipped.last).toISOString().slice(0, 16).replace("T", " ")} UTC, under ${every} ago; nothing read.`;
	return skipped.why === "locked"
		? "Another run is reading; nothing read."
		: "Another run read just now; nothing read.";
}

module.exports = { periodicReading, buildSkipLine };
