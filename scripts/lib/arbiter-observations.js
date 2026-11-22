const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const locksMod = require("./arbiter-locks.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").ObservationRecord} ObservationRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").ObservedVersions} ObservedVersions */

// guess, #5529
const OBSERVATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {{path: string} & Partial<ObservationRecord>} spec
 * @returns {ObservationRecord}
 */
function newObservation({
	path: rel,
	sessionId = null,
	obsId = crypto.randomUUID(),
	blob = null,
	at = new Date().toISOString(),
	tree,
}) {
	return { path: rel, ...(tree ? { tree } : {}), sessionId, obsId, blob, at };
}

/**
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
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readObservation(rel, sessionId) {
	const read = probeObservation(rel, sessionId);
	return read?.unreadable ? null : (read?.record ?? null);
}

/**
 * @param {string} rel
 * @param {Identity} me
 * @param {{viaBash?: boolean}} [opts]
 */
function recordObservation(rel, me, { viaBash = false } = {}) {
	if (!me?.sessionId || !core.isWatched(rel)) return null;
	if (core.isWarned(rel) && !viaBash) return null;

	rel = core.subjectPath(rel);

	const lock = locksMod.readOwnLockOnFile(rel, me.sessionId);
	if (lock && lock.sessionId === me.sessionId) return null;

	const existing = readObservation(rel, me.sessionId);
	const record = newObservation({
		path: rel,
		sessionId: me.sessionId,
		obsId: existing?.obsId,
		tree: core.writerTree(),
	});
	const sha = contentMod.pinContent(rel, record.obsId);
	if (sha === null) return null;

	try {
		fs.mkdirSync(core.paths.observationsDir(), { recursive: true });
		core.writeRecord(core.paths.observation(rel, me.sessionId), {
			...record,
			blob: sha,
		});
	} catch (e) {
		core.logError(`observe ${rel}`, e);
		return null;
	}
	return sha;
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function observationState(rel, sessionId) {
	rel = core.subjectPath(rel);
	return contentMod.contentState(rel, readObservation(rel, sessionId));
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function dropObservation(rel, sessionId) {
	rel = core.subjectPath(rel);
	const record = readObservation(rel, sessionId);
	if (!record || !sessionId) return null;
	const state = contentMod.contentState(rel, record);
	ignoreFailure(() => fs.unlinkSync(core.paths.observation(rel, sessionId)));
	contentMod.dropContentRef(record.obsId);
	return state;
}

function readObservationEntries(
	/** @type {(file: string) => boolean} */ nameFilter = () => true,
) {
	let files;
	try {
		files = fs.readdirSync(core.paths.observationsDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
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
 * @param {string} sessionId
 * @param {string} [tree]
 */
function readObservedBy(sessionId, tree = core.treeRoot()) {
	const entries = readObservedEntriesBy(sessionId);
	if (entries === null) return null;
	return entries.filter((e) => e.tree === tree).map((e) => e.path);
}

/**
 * @param {string} sessionId
 * @returns {{path: string, tree: string}[]|null}
 */
function readObservedEntriesBy(sessionId) {
	if (!sessionId) return null;
	const suffix = core.pairSuffix(sessionId);
	const entries = readObservationEntries((f) => f.endsWith(suffix));
	if (entries === null) return null;
	return entries
		.filter((e) => e.record?.sessionId === sessionId)
		.map((e) => ({ path: e.record.path, tree: core.recordTree(e.record) }));
}

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
exports.readObservedEntriesBy = readObservedEntriesBy;
exports.readObservedIds = readObservedIds;
exports.observedVersions = observedVersions;
exports.recordObservation = recordObservation;
