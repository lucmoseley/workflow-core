/*
 * arbiter-proc.js — is the process that took this claim still running?
 *
 * The leaf of the arbiter (mantahostels#158): it reads /proc and nothing else, so
 * arbiter-store.js may depend on it and it may depend on no module but the
 * leaves caught.js and proc-stat.js.
 * check-guard-errors.js consumes readProcStartOf, so it stays exported.
 *
 * LIVENESS (mantahostels#104). A lock records the holder's `pid` and `procStart` — the
 * kernel's start-time token, /proc/<pid>/stat field 22. The holder is alive only
 * while that pair still matches a live /proc entry. procStart is load-bearing,
 * not decoration: pid 909 was found recycled onto an unrelated process in mantahostels#104's
 * live sample, and a bare "does /proc/<pid> exist" test would have read the dead
 * holder as alive. No timeout, at any duration — the jobs heartbeat updates on
 * tool-call boundaries rather than on a timer (measured lag 47s mid-tool-call),
 * so a threshold short enough to be useful breaks live sessions and one long
 * enough to be safe blocks work for exactly the span the recovery exists to
 * remove.
 */

const fs = require("node:fs");
const { caught } = require("./caught.js");
const { FIELD, readStatFields } = require("./proc-stat.js");

/**
 * The start-time token from one /proc/<pid>/stat line's fields, or null when
 * they describe no live process. A zombie (state Z) keeps its stat entry, with its
 * start time intact, until its parent reaps it — which can be never — and a
 * zombie writes nothing, so counting it alive holds files for a session that no
 * longer exists.
 * @param {string[] | null} after
 */
function liveProcStart(after) {
	if (!after) return null;
	const state = after[FIELD.state];
	if (state === "Z" || state === "X") return null;
	return after[FIELD.start] || null;
}

/** @param {number|string} pid */
function readProcStartOf(pid) {
	return liveProcStart(readStatFields(pid));
}

/**
 * This boot's id. pid and procStart are both boot-relative, and locks in
 * ~/.claude outlive the boot, so after a reboot the recorded pair can in
 * principle recur on an unrelated process — a wedge lasting as long as the
 * stranger runs. Null (non-Linux, /proc unreadable) skips the comparison.
 */
/** @type {string | null | undefined} */
let bootIdCache;
function readCurrentBootId() {
	if (bootIdCache === undefined) {
		try {
			bootIdCache = fs
				.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
				.trim();
		} catch {
			bootIdCache = null;
		}
	}
	return bootIdCache;
}

/**
 * Is the session that wrote this lock still running?
 *
 * The recorded pid/procStart pair matching a live /proc entry is the whole test.
 * A jobs state file was also consulted here, and is not: `CLAUDE_JOB_DIR` is
 * temporary and gets cleaned under a session that is still running, so its
 * absence released a live holder and left two sessions each believing they held
 * the file. It could never prove life either — an earlyoom kill leaves the file
 * at its last written value, which is why mantahostels#104 rejected reading state at all.
 *
 * A lock with NO recorded pid counts as DEAD, which narrows mantahostels#104 rule 4's
 * "unknown = holding". That rule holds wherever the pid check can still clear the
 * lock later; here nothing can ever clear it, so "holding" would mean holding for
 * good. Between an unbreakable lock and an over-eager break, the break is
 * recoverable and the wedge is not.
 * @param {{ pid?: number|string|null, procStart?: number|string|null, bootId?: string|null }} lock
 */
function holderAlive(lock) {
	if (!lock.pid || !lock.procStart) return false;
	// A lock minted on another boot is dead whatever /proc says now: the pair it
	// recorded can only be a coincidence on this one.
	if (lock.bootId && readCurrentBootId() && lock.bootId !== readCurrentBootId())
		return false;
	return readProcStartOf(lock.pid) === String(lock.procStart);
}

/**
 * Whether a pid is still running. EPERM means alive but owned by someone else.
 *
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

module.exports = { readCurrentBootId, holderAlive, pidAlive, readProcStartOf };
