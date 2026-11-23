const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./arbiter-core.js");
const { isBreakRecord } = require("./arbiter-records.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").BreakRecord} BreakRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */

/**
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

// guess, lucmoseley/mantahostels#137
const BREAK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
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

/** @returns {{file: string, record: BreakRecord|null}[]|null} */
function readBreakEntries() {
	let files;
	try {
		files = fs.readdirSync(core.paths.breaksDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		return null;
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(core.paths.breaksDir(), f))
		.map((file) => {
			const record = core.readRecordOrLog(file, "break read");
			return { file, record: isBreakRecord(record) ? record : null };
		});
}

/** @param {string} rel */
function readBreaks(rel) {
	const prefix = `${core.keyFor(rel)}-`;
	return (readBreakEntries() ?? [])
		.filter(
			/** @returns {e is {file: string, record: BreakRecord}} */
			(e) => path.basename(e.file).startsWith(prefix) && e.record !== null,
		)
		.sort((a, b) => a.record.at.localeCompare(b.record.at));
}

function readBrokenClaimIds() {
	const entries = readBreakEntries();
	if (entries === null) return null;
	const ids = new Set();
	for (const { record } of entries) {
		if (record === null) return null;
		if (record.lostClaimId) ids.add(record.lostClaimId);
	}
	return ids;
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function buildBreakNotice(rel, sessionId) {
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
	return mine.map((e) => buildBreakText(rel, e.record)).join("\n\n");
}

/**
 * @param {string} rel
 * @param {BreakRecord} record
 */
function buildBreakText(rel, record) {
	return (
		`This session's claim on ${rel} was broken at ${record.at} by ${record.brokenBy || "an unidentified session"}, which read this session as finished.\n\n` +
		"Anything written to the file since then replaced your version, and nothing said so at the time.\n\n" +
		(record.blob
			? `The version you last wrote is recoverable:\n  git cat-file -p ${record.blob} > /tmp/recovered\n\nDo it now: the pin is dropped a week after the break.`
			: "What the file held was never recorded against that claim, so this version is not recoverable here — look for a committed copy.")
	);
}

function pruneBreaks() {
	const entries = readBreakEntries();
	if (entries === null) return;
	const cutoff = Date.now() - BREAK_AGE_MS;
	for (const { file, record } of entries) {
		const at = Date.parse(record?.at ?? "");
		let when = at;
		if (Number.isNaN(when)) {
			try {
				when = fs.statSync(file).mtimeMs;
			} catch {
				continue;
			}
		}
		if (when < cutoff) ignoreFailure(() => fs.unlinkSync(file));
	}
}

module.exports = {
	buildBreakNotice,
	readBrokenClaimIds,
	pruneBreaks,
	recordBreak,
};
