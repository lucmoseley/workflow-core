/*
 * arbiter-breaks.js — broken claims — the clobber the content record could not otherwise reach.
 *
 * A stale break deletes the lock, and the lock is the only thing naming the blob
 * its holder last wrote. A break record outlives the lock so the losing session is
 * still told when it comes back to the file (mantahostels#322, mantahostels#349).
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./arbiter-core.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").BreakRecord} BreakRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */

// ---------------------------------------------------------------------------
// Broken claims — the clobber the content record could not otherwise reach
// ---------------------------------------------------------------------------

/**
 * A break record — what a stale break destroyed (mantahostels#349). Every field one has is
 * named here and nowhere else.
 *
 * `blob` is the pin the broken lock carried, and the only route back to the
 * version its holder last wrote: the break deletes the lock, so nothing else
 * names it. `reportedAt` is stamped when its loser has been told.
 *
 * @param {{path: string} & Partial<BreakRecord>} spec
 * @returns {BreakRecord}
 */
function newBreak({
	path: rel,
	lostBy = null,
	lostClaimId = null,
	blob = null,
	brokenBy = null,
	at = new Date().toISOString(),
	reportedAt = null,
}) {
	return { path: rel, lostBy, lostClaimId, blob, brokenBy, at, reportedAt };
}
//
// mantahostels#322 measured the hole mantahostels#295's recorder leaves. A stale break deletes the lock,
// and the lock is the only thing naming the blob its holder last wrote: with it
// gone, contentState has nothing to compare against, pruneBlobRefs collects the
// pin, and the holder's next write re-records the POST-clobber bytes as its new
// baseline. So a session resumed onto a live process — or one whose registry
// entry was pruned — loses its version with nothing said and nothing left to
// recover from. mantahostels#348 prevents the common case; this records the rest.
//
// IT REPORTS, AND NEVER REFUSES OR RESTORES. A claim held across a slow decision
// looks identical from the outside to an abandoned one, so the break still
// happens.

/**
 * How long a break record — and with it the pin holding the lost version — is
 * kept.
 *
 * A week, the write ledger's own (mantahostels#137): long enough for the losing session to
 * come back to the file. Bound the retention; never exempt a broken claim's pin
 * from pruneBlobRefs.
 */
const BREAK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Write down what a break destroyed. Returns the record, or null where nothing
 * could be written.
 *
 * FAIL OPEN, BUT NEVER SILENTLY (mantahostels#174). The path is already free by the time
 * this runs, and refusing to carry on because the record would not write would
 * wedge it — the permanent wedge mantahostels#104 forbids.
 * @param {string} rel
 * @param {LockRecord|null} lost
 * @param {Identity|null} breaker
 */
function recordBreak(rel, lost, breaker) {
	const record = newBreak({
		path: rel,
		lostBy: lost?.sessionId ?? null,
		lostClaimId: lost?.claimId ?? null,
		blob: lost?.blob ?? null,
		brokenBy: breaker?.sessionId ?? null,
	});
	try {
		fs.mkdirSync(core.paths.breaksDir(), { recursive: true });
		// A lock record that would not parse leaves no claimId, and keying every
		// one of those to the same name would let the second break on a path erase
		// the first.
		core.writeRecord(
			core.paths.break(
				rel,
				record.lostClaimId ?? `unkeyed-${crypto.randomUUID()}`,
			),
			record,
		);
	} catch (e) {
		core.logError(`break ${rel}`, e);
		return null;
	}
	return record;
}

/**
 * Every break record on disk as {file, record}, or null where the directory
 * itself could not be read. `record` is null for one file that would not read.
 */
function breakEntries() {
	let files;
	try {
		files = fs.readdirSync(core.paths.breaksDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return []; // nothing has ever been broken
		return null;
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(core.paths.breaksDir(), f))
		.map((file) => ({
			file,
			record: core.readRecordOrLog(file, "break read"),
		}));
}

/**
 * Every break recorded against `rel`, oldest first, as {file, record}.
 * @param {string} rel
 */
function readBreaks(rel) {
	const prefix = `${core.keyFor(rel)}-`;
	return (breakEntries() ?? [])
		.filter((e) => path.basename(e.file).startsWith(prefix) && e.record)
		.sort((a, b) => String(a.record.at).localeCompare(String(b.record.at)));
}

/**
 * The claims whose pins a break is still holding open, or null where that
 * cannot be said.
 *
 * ONE UNREADABLE RECORD MAKES THE WHOLE ANSWER null, not a smaller set (mantahostels#174):
 * the pin it was keeping is indistinguishable from an orphan, and dropping it
 * destroys exactly the content this exists to keep. Its own file still ages out
 * below, so a record that never parses cannot pin anything for ever.
 */
function brokenClaimIds() {
	const entries = breakEntries();
	if (entries === null) return null;
	const ids = new Set();
	for (const { record } of entries) {
		if (record === null) return null;
		// An unparseable lock carried no claimId, so it pinned nothing to hold open.
		if (record.lostClaimId) ids.add(record.lostClaimId);
	}
	return ids;
}

/**
 * What a session is told, once, about a claim of its own that was broken —
 * or null where it lost nothing on this path.
 *
 * Said once and not on every write for the retention week: the record is
 * stamped as it is read. A stamp that will not write is logged and the notice
 * given anyway.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function breakNotice(rel, sessionId) {
	if (!sessionId) return null;
	const mine = readBreaks(rel).filter(
		(e) => e.record.lostBy === sessionId && !e.record.reportedAt,
	);
	if (mine.length === 0) return null;

	const at = new Date().toISOString();
	for (const e of mine) {
		try {
			core.writeRecord(e.file, { ...e.record, reportedAt: at });
		} catch (err) {
			core.logError(`break report ${rel}`, err);
		}
	}
	return mine.map((e) => breakText(rel, e.record)).join("\n\n");
}

/**
 * @param {string} rel
 * @param {BreakRecord} record
 */
function breakText(rel, record) {
	return (
		`This session's claim on ${rel} was broken at ${record.at} by ${record.brokenBy || "an unidentified session"}, which read this session as finished.\n\n` +
		"Anything written to the file since then replaced your version, and nothing said so at the time.\n\n" +
		(record.blob
			? `The version you last wrote is recoverable:\n  git cat-file -p ${record.blob} > /tmp/recovered\n\nDo it now: the pin is dropped a week after the break.`
			: "What the file held was never recorded against that claim, so this version is not recoverable here — look for a committed copy.")
	);
}

/**
 * Drop the break records that have run out their week, and with them the hold
 * on the pins they were keeping — pruneBlobRefs collects those on the same
 * sweep, which is why this runs first.
 *
 * AGED FROM `at`, NOT FROM mtime. The record is rewritten when its loser is
 * told, so an mtime sweep would hand a break reported on day six another week
 * for having been read. mtime is the fallback for a record that will not parse, which
 * has no readable `at` and must still age out or it pins a blob for ever.
 */
function pruneBreaks() {
	const entries = breakEntries();
	if (entries === null) return; // unreadable: delete nothing (mantahostels#174)
	const cutoff = Date.now() - BREAK_AGE_MS;
	for (const { file, record } of entries) {
		const at = Date.parse(record?.at ?? "");
		let when = at;
		if (Number.isNaN(when)) {
			try {
				when = fs.statSync(file).mtimeMs;
			} catch {
				continue; // swept already
			}
		}
		if (when < cutoff) {
			try {
				fs.unlinkSync(file);
			} catch {
				/* swept already */
			}
		}
	}
}

module.exports = {
	breakNotice,
	brokenClaimIds,
	pruneBreaks,
	recordBreak,
};
