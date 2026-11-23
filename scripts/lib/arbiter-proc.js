const fs = require("node:fs");
const { caught } = require("./caught.js");
const { REAL_PROC } = require("./proc-root.js");
const { FIELD, readStatFields } = require("./proc-stat.js");

/** @param {string[] | null} after */
function liveProcStart(after) {
	if (!after) return null;
	const state = after[FIELD.state];
	if (state === "Z" || state === "X") return null;
	return after[FIELD.start] || null;
}

/**
 * @param {number|string} pid
 * @param {string} [proc]
 */
function readProcStartOf(pid, proc) {
	return liveProcStart(readStatFields(pid, proc));
}

/** @type {string | null | undefined} */
let bootIdCache;
function readCurrentBootId() {
	if (bootIdCache === undefined) {
		try {
			bootIdCache = fs
				.readFileSync(`${REAL_PROC}/sys/kernel/random/boot_id`, "utf8")
				.trim();
		} catch {
			bootIdCache = null;
		}
	}
	return bootIdCache;
}

/** @param {{ pid?: number|string|null, procStart?: number|string|null, bootId?: string|null }} lock */
function holderAlive(lock) {
	if (!lock.pid || !lock.procStart) return false;
	if (lock.bootId && readCurrentBootId() && lock.bootId !== readCurrentBootId())
		return false;
	return readProcStartOf(lock.pid) === String(lock.procStart);
}

/** @returns {{ pid: number, procStart: string | null, bootId: string | null }} */
function ownIdentity() {
	return {
		pid: process.pid,
		procStart: readProcStartOf(process.pid, REAL_PROC),
		bootId: readCurrentBootId(),
	};
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return caught(error).code === "EPERM";
	}
}

module.exports = {
	readCurrentBootId,
	holderAlive,
	ownIdentity,
	pidAlive,
	readProcStartOf,
};
