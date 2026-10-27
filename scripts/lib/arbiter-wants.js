/*
 * arbiter-wants.js — the waiter register — who is blocked on which claim (mantahostels#1195).
 *
 * A want is dropped the moment its wait ends by any route; the age sweep is for
 * the case none of that reaches. It is what `list` reads to print DEADLOCK.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const core = require("./arbiter-core.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */

// ---------------------------------------------------------------------------
// The waiter register (mantahostels#1195)
// ---------------------------------------------------------------------------

/**
 * A want outlives nothing: it is dropped the moment its wait ends by any route,
 * and readWants() deletes one whose session is gone. The age sweep is for the
 * case none of that reaches — a session killed mid-wait on a machine that then
 * reboots, where the pid check cannot even be attempted.
 */
// UNMEASURED, a first guess: long enough that no real wait is reaped mid-session
// on this machine's session lengths, short enough that a record cannot outlive a
// working day. Nothing depends on the exact figure — a want reaped early costs
// one line of diagnosis, never a claim.
const WANT_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Record that this session is blocked on `rel`.
 *
 * Written on the deny paths and nowhere else, so a session that never waits
 * never appears here. Without this record a stranded claim and a deadlock are
 * indistinguishable (mantahostels#1195).
 *
 * FAILS SILENT BY DESIGN. A want that cannot be written costs a diagnosis, never
 * a claim, so nothing on the claim path may throw on it.
 * @param {string} rel
 * @param {Identity} me
 * @param {LockRecord|null} [blocker]
 */
function recordWant(rel, me, blocker = null) {
	// An unidentifiable session takes no claims either, so it can neither enter a
	// cycle nor be named in one.
	if (!me?.sessionId) return;
	try {
		fs.mkdirSync(core.paths.wantsDir(), { recursive: true });
		core.writeRecord(core.paths.want(me.sessionId), {
			sessionId: me.sessionId,
			wants: rel,
			// The subject actually held, which is not always the one asked for
			// (mantahostels#970): a whole-file lock blocks a claim on one region of it. The cycle
			// walk re-derives this from the locks rather than trusting it; it is
			// recorded for the report to quote.
			heldSubject: blocker?.path || null,
			blockedBy: blocker?.sessionId || null,
			pid: me.pid ?? null,
			procStart: me.procStart ?? null,
			bootId: readCurrentBootId() || undefined,
			since: new Date().toISOString(),
		});
	} catch (e) {
		core.logError(`want record ${rel}`, e);
	}
}

/**
 * The wait ended — by a claim taken, or by the waiter giving up.
 * @param {string|null} sessionId
 */
function dropWant(sessionId) {
	if (!sessionId) return;
	try {
		fs.unlinkSync(core.paths.want(sessionId));
	} catch (e) {
		if (caught(e).code !== "ENOENT") core.logError(`want drop ${sessionId}`, e);
	}
}

/**
 * Every LIVE want. A dead waiter is not waiting, and unlike a dead lock nothing
 * is wedged by its record, so it is deleted here rather than reported — the
 * opposite of listLocks(), which must show a stale lock precisely because it
 * still blocks somebody.
 *
 * Returns null where the register itself could not be read, [] where it is
 * genuinely empty. The caller must not print the first as the second: a
 * diagnosis that goes quiet on a fault reads as "nobody is blocked" (mantahostels#174).
 */
function readWants() {
	let files = [];
	try {
		files = fs
			.readdirSync(core.paths.wantsDir())
			.filter((f) => f.endsWith(".json"));
	} catch (e) {
		// ENOENT is a real empty: nothing has ever waited. Anything else is UNKNOWN,
		// and the caller says so rather than printing the silence as "nobody is
		// blocked" (mantahostels#174).
		if (caught(e).code === "ENOENT") return [];
		core.logError("want list", e);
		return null;
	}
	const out = [];
	for (const f of files) {
		const file = path.join(core.paths.wantsDir(), f);
		let record = null;
		try {
			record = core.readRecord(file);
		} catch {
			continue;
		}
		if (!record?.sessionId || !record.wants) continue;
		// SKIPPED, never deleted. holderAlive reads a RESUMED session — same id,
		// fresh host process — as dead (listLocks says so of the lock half), and
		// unlinking on that reading would permanently drop a live waiter's record,
		// costing a real ring one member and turning a DEADLOCK into a WAITING. The
		// age sweep is what reaps these, on a clock rather than on a guess.
		if (!holderAlive(record)) continue;
		out.push(record);
	}
	return out;
}

module.exports = {
	dropWant,
	readWants,
	recordWant,
	WANT_AGE_MS,
};
