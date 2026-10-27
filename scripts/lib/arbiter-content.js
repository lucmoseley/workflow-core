/*
 * arbiter-content.js — content identity — what a file held when its claimant last touched it (mantahostels#295).
 *
 * The git-blob pins, the prior-version ring a holder can recover from, and the
 * comparison that reports a clobber. REPORT-ONLY, NEVER A DENY (mantahostels#288).
 *
 * This file is in the require cycle, so it fills `module.exports` in place and
 * never destructures a sibling family — arbiter-store.js's header, THE SPLIT
 * RULE (mantahostels#1795).
 */

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

// ---------------------------------------------------------------------------
// Content identity — what the file held when its claimant last touched it (mantahostels#295)
//
// A claim says who holds a file. It could not say what the file CONTAINED, so a
// write arriving by a route no hook watches — `cp`, `git restore`, a heredoc, a
// script — overwrote the holder's work and nothing ever said so (map mantahostels#250).
//
// REPORT-ONLY, NEVER A DENY (mantahostels#288). The comparison produces a warning naming the
// recovery command; nothing is refused on it, on either tier.
//
// TWO REPORTING SITES: the claimant's next guarded write, and `release` (mantahostels#332)
// — the last chance, since the pin goes with the claim.
//
// THE RECORD IS REFRESHED AFTER EVERY WRITE THIS SESSION MAKES, tool or Bash. A
// neighbour's write happens in a session holding no claim, so it refreshes
// nothing and stays visible.
//
// A destructive command run by the HOLDER — `cp` from a backup, `git restore` —
// is trusted by that refresh, which re-pins the clobbered bytes. It is NOT
// reported: a HEAD test does separate it from the holder's own `sed -i`, which
// moves the file away from committed content where a restore moves it towards,
// but a mutation-cycle backup is itself HEAD-content, so the detector fires on
// the legitimate cycles (mantahostels#329).
//
// The answer is recovery instead: the claim keeps the shas it has held, and
// `versions` lists them (mantahostels#438).
// ---------------------------------------------------------------------------

const BLOB_REF_PREFIX = "refs/arbiter/";

/**
 * A claim id spelled as a git ref, or null where it cannot be.
 *
 * claimId is a randomUUID, which is always safe — but a hand-written lock's is
 * not ours to trust, and it is being handed to git as a ref name.
 * @param {string} claimId
 */
function blobRef(claimId) {
	return typeof claimId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(claimId)
		? BLOB_REF_PREFIX + claimId
		: null;
}

/**
 * Run `hash` over the REGION a subject names, or answer undefined where the
 * subject names no region and the whole-file path is the right one.
 *
 * Undefined rather than null, because null is what the hash itself returns when
 * git could not answer, and the two callers below must not confuse "this is a
 * whole-file subject" with "git failed".
 *
 * NULL IS ONE ANSWER FOR THREE THINGS — an unreadable file, a region that has
 * vanished, and a git that would not run — and nothing here separates them. Both
 * callers therefore treat null as "the question was not answered": no pin, and
 * `unknown` rather than `changed`, per mantahostels#158's rule that an unasked question
 * never reads as a clobber.
 * @param {string} subject
 * @param {(text: string) => string|null} hash
 */
function readRegionHash(subject, hash) {
	const { rel, region } = core.splitSubject(subject);
	if (!region) return;
	let text;
	try {
		text = fs.readFileSync(path.join(core.repoRoot(), rel), "utf8");
	} catch {
		return null;
	}
	const body = regions.parseRegionText(text, region, rel);
	return body === null ? null : hash(body);
}

/**
 * Write `rel`'s current bytes into git's object store and pin them under the
 * claim, returning the blob id — or null where nothing could be stored.
 *
 * The pin is what makes the content RECOVERABLE rather than merely detectable: a
 * loose object nothing references is `git gc --prune=now`'s to drop.
 * @param {string} rel
 * @param {string} claimId
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
	// A pin that did not land would leave the blob prunable, so the id is worth
	// nothing as a recovery instruction: report no record at all.
	if (core.git(["update-ref", ref, sha]) === null) return null;
	return sha;
}

/**
 * How many superseded versions a claim keeps. The cap exists because a session
 * refreshing one file forty times would otherwise grow its lock without limit;
 * ten is enough to reach back past a mutation cycle and its reversal.
 */
const PRIOR_BLOBS_MAX = 10;

/**
 * `lock`'s prior versions with its current blob pushed on the front — newest
 * first, capped.
 *
 * A refresh that found no change re-records the same sha, and the post-Bash
 * refresh fires on every Bash call, so an unchanged sha is dropped: otherwise
 * ten identical entries evict the version somebody actually wants back.
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
 * Record what `rel` holds right now against this session's claim on it. Returns
 * the blob id stored, or null where nothing was recorded.
 *
 * Identity, not liveness: a lock carrying another session's id is not ours to
 * write to, whatever the state of its holder.
 * @param {string} rel
 * @param {Identity} me
 */
function recordContent(rel, me) {
	// A regioned path reached WITHOUT a region — which is how the PostToolUse
	// write hook reaches it, knowing only the file — is fanned out over every
	// region of it this session holds. Otherwise the lookup below finds the
	// whole-file lock, which a region-claiming session does not have, and the
	// pin never refreshes.
	const { region } = core.splitSubject(rel);
	if (region === null && regions.isRegioned(rel)) {
		const held = locksMod.readHeldBy(me.sessionId);
		if (held === null) return null;
		// REGIONS only. A whole-file claim on this same path is `rel` itself, and
		// recursing into it would call this function with the argument it was just
		// called with, forever.
		const mine = held.filter((s) => {
			const part = core.splitSubject(s);
			return part.rel === rel && part.region !== null;
		});
		// EVERY region AND the file itself, not the first that answers. A session
		// can hold both at once — a whole-file Write, then an Edit that resolves to
		// one entry — and refreshing only the regions leaves the whole-file claim's
		// pin frozen at the moment the first region was taken, so the bytes it
		// offers to recover go stale without anything saying so.
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
 * recordContent's body: one subject, whole file or single region.
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
	// The claim changed underneath us, so the pin now belongs to nobody;
	// pruneBlobRefs collects it.
	return outcome === "updated" ? sha : null;
}

/**
 * What `rel` holds now against what its claim last recorded.
 *
 * UNKNOWN IS NOT CHANGED. A claim never recorded, a repo git cannot read, an
 * absent git — all mean the question was never asked (mantahostels#295).
 * @param {string} rel
 * @param {LockRecord} lock
 * @returns {ContentState}
 */
function contentState(rel, lock) {
	const was = lock?.blob;
	if (!was) return { state: "unknown", was: null };
	// Deletion is a clobber like any other, and hash-object cannot report it: a
	// missing file makes git exit non-zero, which reads as "could not answer".

	if (!fs.existsSync(path.join(core.repoRoot(), core.subjectPath(rel))))
		return { state: "changed", was };
	// A REGION is compared against its own bytes, never the file's (mantahostels#970). On the
	// whole file, a neighbour editing a different region of docs/doc-map.md would
	// register as a clobber on every interleaved write — and the recovery it
	// advises would destroy that neighbour's work, which is the opposite of what
	// this detector is for.
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

/**
 * Whether git still has `sha` as a blob.
 * @param {string} sha
 */
function blobExists(sha) {
	return (
		typeof sha === "string" &&
		/^[0-9a-f]{40,64}$/.test(sha) &&
		core.git(["cat-file", "-e", `${sha}^{blob}`]) !== null
	);
}

/**
 * The versions `rel` has held during the claim standing on it now, newest first
 * — `{lock, versions}`, or null where nothing holds it. The first entry is what
 * the claim last recorded; the rest are what it replaced.
 *
 * A LOCK THAT WILL NOT READ IS NOT NOTHING (mantahostels#2382): it comes back as
 * readRecordOrFlag's `{unreadable: true, reason, file}`, so the caller can say
 * the record is there and would not open rather than that no claim exists.
 *
 * `gone` is the reason this cannot just print shas: only the current version is
 * pinned, so a prior lives on git's two-week default and then stops being a
 * recovery instruction. A cap can also evict one while git still has it, which
 * is why a version dropped from the chain is simply absent here rather than
 * reported.
 *
 * PULL-MODE, and that is a ruling (mantahostels#288, mantahostels#329): nothing here is called from a
 * hook, so no report, warning or refusal is added to normal operation.
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

/**
 * Drop the pin a claim held. Best-effort; a leftover is pruneBlobRefs's.
 * @param {string} claimId
 */
function dropContentRef(claimId) {
	const ref = blobRef(claimId);
	if (ref) core.git(["update-ref", "-d", ref]);
}

exports.BLOB_REF_PREFIX = BLOB_REF_PREFIX;
exports.blobExists = blobExists;
exports.blobRef = blobRef;
exports.claimVersions = claimVersions;
exports.contentState = contentState;
exports.dropContentRef = dropContentRef;
exports.pinContent = pinContent;
exports.PRIOR_BLOBS_MAX = PRIOR_BLOBS_MAX;
exports.recordContent = recordContent;
exports.readRegionHash = readRegionHash;
