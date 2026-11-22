const fs = require("node:fs");
const path = require("node:path");
const regions = require("./doc-map-regions.js");
const core = require("./arbiter-core.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const locksMod = require("./arbiter-locks.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ContentState} ContentState */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").ClaimVersions} ClaimVersions */

const BLOB_REF_PREFIX = "refs/arbiter/";

/** @param {string|undefined} claimId */
function blobRef(claimId) {
	return typeof claimId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(claimId)
		? BLOB_REF_PREFIX + claimId
		: null;
}

/**
 * @param {string} subject
 * @param {(text: string) => string|null} hash
 */
function readRegionHash(subject, hash) {
	const { rel, region } = core.splitSubject(subject);
	if (!region) return;
	let text;
	try {
		text = fs.readFileSync(path.join(core.treeRoot(), rel), "utf8");
	} catch {
		return null;
	}
	const body = regions.parseRegionText(text, region, rel);
	return body === null ? null : hash(body);
}

/**
 * @param {string} rel
 * @param {string|undefined} claimId
 */
function pinContent(rel, claimId) {
	const ref = blobRef(claimId);
	if (!ref) return null;
	const region = readRegionHash(rel, (text) =>
		core.gitIn(["hash-object", "-w", "--stdin"], text),
	);
	const sha =
		region === undefined
			? core.git(["hash-object", "-w", "--", core.subjectPath(rel)])
			: region;
	if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
	if (core.git(["update-ref", ref, sha]) === null) return null;
	return sha;
}

// guess, #5529
const PRIOR_BLOBS_MAX = 10;

/**
 * @param {LockRecord} lock
 * @param {string|null} sha
 */
function shiftPrior(lock, sha) {
	if (!lock.blob || lock.blob === sha) return lock.priorBlobs;
	return [
		{ sha: lock.blob, at: new Date().toISOString() },
		...lock.priorBlobs,
	].slice(0, PRIOR_BLOBS_MAX);
}

/**
 * @param {string} rel
 * @param {Identity} me
 */
function recordContent(rel, me) {
	const { region } = core.splitSubject(rel);
	if (region === null && regions.isRegioned(rel)) {
		const held = locksMod.readHeldBy(me.sessionId);
		if (held === null) return null;
		const mine = held.filter((s) => {
			const part = core.splitSubject(s);
			return part.rel === rel && part.region !== null;
		});
		let first = null;
		for (const subject of [...mine, rel]) {
			const sha = recordSubjectContent(subject, me);
			if (first === null) first = sha;
		}
		return first;
	}

	return recordSubjectContent(rel, me);
}

/**
 * @param {string} rel
 * @param {Identity} me
 */
function recordSubjectContent(rel, me) {
	const existing = core.readRecordOrLog(
		core.paths.lock(rel),
		`record content ${rel}`,
	);
	if (!existing || !me.sessionId || existing.sessionId !== me.sessionId)
		return null;

	const sha = pinContent(rel, existing.claimId);
	if (sha === null) return null;

	const { outcome } = locksMod.updateIfUnchanged(
		rel,
		(m) => m.claimId === existing.claimId,
		(m) => ({ ...m, blob: sha, priorBlobs: shiftPrior(m, sha) }),
	);
	return outcome === "updated" ? sha : null;
}

/**
 * @param {string} rel
 * @param {{blob: string|null}|null} lock
 * @returns {ContentState}
 */
function contentState(rel, lock) {
	const was = lock?.blob;
	if (!was) return { state: "unknown", was: null };

	if (!fs.existsSync(path.join(core.treeRoot(), core.subjectPath(rel))))
		return { state: "changed", was };
	const region = readRegionHash(rel, (text) =>
		core.gitIn(["hash-object", "--stdin"], text),
	);
	const now =
		region === undefined
			? core.git(["hash-object", "--", core.subjectPath(rel)])
			: region;
	if (!now) return { state: "unknown", was };
	return { state: now === was ? "same" : "changed", was };
}

/** @param {string} sha */
function blobExists(sha) {
	return (
		typeof sha === "string" &&
		/^[0-9a-f]{40,64}$/.test(sha) &&
		core.git(["cat-file", "-e", `${sha}^{blob}`]) !== null
	);
}

/**
 * @param {string} rel
 * @returns {ClaimVersions}
 */
function claimVersions(rel) {
	const read = core.readRecordOrFlag(
		core.paths.lock(rel),
		`versions ${rel}`,
		locksMod.settle,
	);
	if (read.unreadable) return read;
	const lock = read.record;
	if (!lock) return null;
	const held = [
		...(lock.blob ? [{ sha: lock.blob, at: null }] : []),
		...lock.priorBlobs,
	];
	return {
		lock,
		versions: held.map((v) => ({ ...v, gone: !blobExists(v.sha) })),
	};
}

/** @param {string} claimId */
function dropContentRef(claimId) {
	const ref = blobRef(claimId);
	if (ref) core.git(["update-ref", "-d", ref]);
}

exports.BLOB_REF_PREFIX = BLOB_REF_PREFIX;
exports.blobExists = blobExists;
exports.claimVersions = claimVersions;
exports.contentState = contentState;
exports.dropContentRef = dropContentRef;
exports.pinContent = pinContent;
exports.PRIOR_BLOBS_MAX = PRIOR_BLOBS_MAX;
exports.recordContent = recordContent;
exports.readRegionHash = readRegionHash;
