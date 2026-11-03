/*
 * arbiter-observations.js — the second writer's own baseline on a detect-only path (mantahostels#363).
 *
 * The detect-only tier refuses nobody, so two sessions can write one scripts/
 * file at once — and the baseline lived on the CLAIM, so only the holder had one.
 * An observation is the non-holder's baseline.
 *
 * This file is in the require cycle, so it fills `module.exports` in place and
 * never destructures a sibling family — arbiter-store.js's header, THE SPLIT
 * RULE (mantahostels#1795).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bases = require("./arbiter-bases.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const locksMod = require("./arbiter-locks.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").ObservationRecord} ObservationRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").ObservedVersions} ObservedVersions */

// ---------------------------------------------------------------------------
// Observations — the second writer's own baseline on a detect-only path (mantahostels#363, mantahostels#330)
// ---------------------------------------------------------------------------
//
// Lifting the "held" skip in the guard was the obvious fix and is unsafe: the
// lock a second writer is handed is the HOLDER's, so it compares against the
// holder's blob and prints a recovery command naming the holder's bytes as the
// second writer's own last write.
//
// So the baseline becomes a property of the (session, path) pair. An observation
// carries its own pin under its own id, and is read by nobody but the session
// that wrote it.
//
// REPORT-ONLY (mantahostels#288), and by the TOOL route detect-only: a second writer reaching
// the refusing tier through Write/Edit is denied, so it takes no baseline there.
// The Bash route lands on both tiers and does take one — the tier scan below
// (mantahostels#419).

/**
 * How long an observation — and the pin holding the version it names — is kept
 * once nothing has written against it. A week, as break records and the write
 * ledger are.
 *
 * Its record is rewritten on every write the session makes to that path, so the
 * age is time since that session last touched the file, not since it started.
 */
const OBSERVATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An observation record. Every field one has is named here and nowhere else.
 *
 * `obsId` is what the pin is filed under, standing in for the claimId a second
 * writer does not have; it is minted once and reused, so the pin is overwritten
 * in place rather than accumulating one ref per write.
 *
 * @param {{path: string} & Partial<ObservationRecord>} spec
 * @returns {ObservationRecord}
 */
function newObservation({
	path: rel,
	sessionId = null,
	obsId = crypto.randomUUID(),
	blob = null,
	at = new Date().toISOString(),
}) {
	return { path: rel, sessionId, obsId, blob, at };
}

/**
 * This session's observation of `rel`, read on readRecordOrFlag's terms — so
 * ABSENT and UNREADABLE stay apart. Null where `sessionId` is null and there is
 * nothing to look up.
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {{record: any, unreadable?: false}|import("./arbiter-records.js").UnreadableRecord|null}
 */
function probeObservation(rel, sessionId) {
	rel = core.subjectPath(rel);
	if (!sessionId) return null;
	return core.readRecordOrFlag(
		core.paths.observation(rel, sessionId),
		`observation read ${rel}`,
		locksMod.settle,
	);
}

/**
 * This session's observation of `rel`, or null where it has none — probe's
 * answer with unreadable folded back into absent.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readObservation(rel, sessionId) {
	const read = probeObservation(rel, sessionId);
	return read?.unreadable ? null : (read?.record ?? null);
}

/**
 * Record what `rel` holds right now against `me`'s observation of it. Returns
 * the blob id stored, or null where nothing was recorded.
 *
 * Null covers every case the CLAIM's own record already answers — the caller
 * holds the lock, or the path is on the refusing tier — so a caller can run this
 * after recordContent and take the first non-null.
 *
 * A WRITE THAT TOOK NO CLAIM IS NOT ONE OF THEM (mantahostels#2333). Off the refusing tier
 * the write lands whether or not a claim was minted, and these are then the only
 * bytes recording who wrote it. cmdCheck claims on the WATCHED union, so the
 * ordinary tool write does mint a lock — the uncovered writes are the guard's
 * fail-opens (`scripts/lib/file-claim.js`: an arbiter timeout, a non-zero
 * exit), acquire()'s `unknown` on an unreadable store, and a lock swept
 * as stale under a session still running.
 *
 * `viaBash` is the post-Bash scan's route in (mantahostels#419). A session that reached the
 * file through `sed -i` attempted no claim, so the refusing-tier exit is wrong
 * for it: that tier refuses only the tool route, so a `git restore
 * docs/doc-map.md` lands there like a `cp` lands on a script. It still records a
 * BASELINE ONLY — never a lock, which a scan cannot support: it sees that bytes
 * changed, not who changed them.
 * @param {string} rel
 * @param {Identity} me
 * @param {{viaBash?: boolean}} [opts]
 */
function recordObservation(rel, me, { viaBash = false } = {}) {
	if (!me?.sessionId || !core.isWatched(rel)) return null;
	if (core.isGuarded(rel) && !viaBash) return null;

	// AN OBSERVATION IS WHOLE-FILE, on a regioned path as on any other. Both its
	// readers are whole-file — park() rewrites the whole file, and a Bash-route
	// write names a file and never a region — so keying it per region would file it
	// where no reader looks.
	rel = core.subjectPath(rel);

	// "Ours" means ANY lock this session holds on the file, not the whole-file
	// one: a session holding one `### B<n>` entry already has a pin recording its
	// own bytes, and minting an observation beside it would report its own writes
	// back to it as a neighbour's.
	const lock = locksMod.readOwnLockOnFile(rel, me.sessionId);
	if (lock && lock.sessionId === me.sessionId) return null;

	const existing = readObservation(rel, me.sessionId);
	const record = newObservation({
		path: rel,
		sessionId: me.sessionId,
		obsId: existing?.obsId,
	});
	const sha = contentMod.pinContent(rel, record.obsId);
	if (sha === null) return null;

	try {
		fs.mkdirSync(core.paths.observationsDir(), { recursive: true });
		// No compare-and-swap: the record is keyed by (path, session), so the only
		// writer racing here is this same session, writing the same bytes.
		core.writeRecord(core.paths.observation(rel, me.sessionId), {
			...record,
			blob: sha,
		});
	} catch (e) {
		core.logError(`observe ${rel}`, e);
		return null;
	}
	// The detect-only write's first-write base (workflow-core#110), and — through `viaBash` —
	// the tier scan's, under the scan's own per-tick cap.
	bases.mintBase(rel, me.sessionId);
	return sha;
}

/**
 * What `rel` holds now against what THIS session last wrote to it while another
 * session held the claim: `{state, was}`, on contentState's terms.
 *
 * A session with no observation reads "unknown".
 * @param {string} rel
 * @param {string|null} sessionId
 */
function observationState(rel, sessionId) {
	rel = core.subjectPath(rel);
	return contentMod.contentState(rel, readObservation(rel, sessionId));
}

/**
 * Drop this session's observation of `rel` and the pin under it, returning the
 * content answer computed before the drop — or null where it had none.
 *
 * The answer comes first because this is the observation's last reporting site:
 * the pin goes with the record.
 *
 * IT GOES EVEN WHERE THE CALL EXITS 1. mantahostels#337 keeps a refused claim's pin because
 * the CLAIM stands; an observation does not stand — the caller asked to be
 * finished with the path and got that, whatever the lock's answer was.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function dropObservation(rel, sessionId) {
	rel = core.subjectPath(rel);
	const record = readObservation(rel, sessionId);
	// The `!sessionId` limb is UNVERIFIED and unreachable: readObservation
	// already answers null without one, so no test can kill that mutation. It
	// is what lets the path builder below see a string rather than a maybe.
	if (!record || !sessionId) return null;
	const state = contentMod.contentState(rel, record);
	try {
		fs.unlinkSync(core.paths.observation(rel, sessionId));
	} catch {
		/* swept already */
	}
	contentMod.dropContentRef(record.obsId);
	return state;
}

/** Every observation record on disk as {file, record}, or null where the directory would not open. */
function readObservationEntries(
	/** @type {(file: string) => boolean} */ nameFilter = () => true,
) {
	let files;
	try {
		files = fs.readdirSync(core.paths.observationsDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return []; // nothing has ever been observed
		return null;
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.filter(nameFilter)
		.map((f) => path.join(core.paths.observationsDir(), f))
		.map((file) => ({
			file,
			record: core.readRecordOrLog(file, "observation read"),
		}));
}

/**
 * The paths `sessionId` is a second writer on, or null where the answer is
 * unavailable rather than empty (mantahostels#174) — the refresh must not read a dark store
 * as "this session observes nothing".
 * @param {string} sessionId
 */
function readObservedBy(sessionId) {
	if (!sessionId) return null;
	// By FILENAME first, so this opens its own records and nobody else's. The
	// directory is one flat store shared by every session, and mantahostels#419 made it grow
	// with every watched path any session Bash-touches; reading all of it on a
	// call that runs after every Bash call in every session is what would walk
	// the hook into its own `timeout 5`. The record's own sessionId is still
	// checked — the name is an index, never the authority.
	const suffix = core.pairSuffix(sessionId);
	const entries = readObservationEntries((f) => f.endsWith(suffix));
	if (entries === null) return null;
	return entries
		.filter((e) => e.record?.sessionId === sessionId)
		.map((e) => e.record.path);
}

/**
 * The ids whose pins an observation is holding open, or null where that cannot
 * be said — one unreadable record makes the whole answer null, on readBrokenClaimIds'
 * reasoning: the pin it was keeping is indistinguishable from an orphan.
 */
function readObservedIds() {
	const entries = readObservationEntries();
	if (entries === null) return null;
	const ids = new Set();
	for (const { record } of entries) {
		if (record === null) return null;
		if (record.obsId) ids.add(record.obsId);
	}
	return ids;
}

/**
 * The version `sessionId`'s own observation of `rel` pinned — `{versions}`, or
 * null where it has none, or readRecordOrFlag's `{unreadable: true, reason,
 * file}` where the record is on disk and will not read (mantahostels#2382).
 *
 * ONE VERSION, NEVER A CHAIN. An observation is re-minted under its own `obsId`
 * at every write, so the pin is overwritten in place: what it replaced is not
 * kept, and there is no `priorBlobs` to walk. A LIST all the same, so cmdVersions
 * prints both records through one loop (mantahostels#2374).
 *
 * PULL-MODE, on claimVersions' ruling (mantahostels#288, mantahostels#329): nothing here is called from
 * a hook.
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {ObservedVersions}
 */
function observedVersions(rel, sessionId) {
	const read = probeObservation(rel, sessionId);
	if (!read) return null;
	if (read.unreadable) return read;
	const record = read.record;
	if (!record?.blob) return null;
	return {
		versions: [
			{
				sha: record.blob,
				at: record.at ?? null,
				gone: !contentMod.blobExists(record.blob),
			},
		],
	};
}

exports.dropObservation = dropObservation;
exports.OBSERVATION_AGE_MS = OBSERVATION_AGE_MS;
exports.readObservationEntries = readObservationEntries;
exports.observationState = observationState;
exports.readObservedBy = readObservedBy;
exports.readObservedIds = readObservedIds;
exports.observedVersions = observedVersions;
exports.recordObservation = recordObservation;
