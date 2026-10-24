/*
 * arbiter-sweep.js — the session-start sweep, as one call (mantahostels#1796).
 *
 * The one place that knows every family has an age sweep. It is the root of the
 * require graph — nothing here is required by a family, so a family added to
 * `SWEPT_FAMILIES` costs no cycle.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const { spawnSync } = require("node:child_process");
const { gitBinary } = require("./git-binary.js");
const fs = require("node:fs");
const path = require("node:path");
const bases = require("./arbiter-bases.js");
const breaks = require("./arbiter-breaks.js");
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const issues = require("./arbiter-issue-claims.js");
const locksMod = require("./arbiter-locks.js");
const markers = require("./arbiter-markers.js");
const observations = require("./arbiter-observations.js");
const requests = require("./arbiter-requests.js");
const snapshots = require("./arbiter-snapshots.js");
const wants = require("./arbiter-wants.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */

/**
 * Delete the pins of claims that no longer exist.
 *
 * A pin is overwritten in place on every refresh, so the live set is bounded by
 * the number of claims — it is the pins of ENDED sessions that would otherwise
 * accumulate, one per file ever claimed. Run from the SessionStart sweep, beside
 * pruneMarkers, rather than per write: it costs a `for-each-ref` and a readLocks.
 *
 * An unreadable lock store deletes nothing: a live pin and an orphan are
 * indistinguishable without it, and dropping a live one destroys exactly the
 * content this exists to keep recoverable (mantahostels#174).
 */
function pruneBlobRefs() {
	const listed = core.git([
		"for-each-ref",
		"--format=%(refname)",
		contentMod.BLOB_REF_PREFIX,
	]);
	if (!listed) return; // no git, or no pins
	// Keyed by claimId, so holder liveness is beside the point and unwanted.
	const locks = locksMod.readLocks();
	if (locks === null) {
		core.logError("pruneBlobRefs", new Error("lock store unreadable"));
		return;
	}
	// A broken claim's pin has no lock by construction, so the locks alone would
	// collect exactly the content mantahostels#349 keeps (mantahostels#174: unreadable deletes nothing).
	const broken = breaks.brokenClaimIds();
	if (broken === null) {
		core.logError("pruneBlobRefs", new Error("break records unreadable"));
		return;
	}
	const claimed = new Set(locks.map((l) => l.claimId).filter(Boolean));
	// A second writer holds no lock either, so without this the sweep collects the
	// only copy of what it last wrote (mantahostels#363).
	const observed = observations.observedIds();
	if (observed === null) {
		core.logError("pruneBlobRefs", new Error("observations unreadable"));
		return;
	}
	/*
	 * Collected in ONE `update-ref --stdin`, never one spawn per ref (mantahostels#1899). A
	 * session-start sweep meeting a backlog was otherwise paying a process per
	 * orphan, which is what put this hook past its 10s budget; the batch costs
	 * one spawn whatever the count. `--stdin` is atomic — a malformed line
	 * rejects the whole transaction — so nothing is half-collected, and a
	 * refusal leaves every pin standing, which is the safe direction (mantahostels#174).
	 *
	 * ATOMIC ALSO MEANS ONE LOCKED REF FAILS THE LOT, so a ref still locked is
	 * left out of the batch rather than allowed to sink it (workflow-core#1193).
	 */
	const locked = clearStaleRefLocks();
	const orphans = listed
		.split("\n")
		.filter((ref) => {
			const claimId = ref.slice(contentMod.BLOB_REF_PREFIX.length);
			return (
				!claimed.has(claimId) &&
				!broken.has(claimId) &&
				!observed.has(claimId) &&
				!locked.has(claimId)
			);
		})
		.map((ref) => `delete ${ref}\n`);
	if (orphans.length === 0) return;
	// Not core.gitIn, which discards stderr — the one line naming the ref that
	// sank the batch.
	const res = spawnSync(gitBinary(), ["update-ref", "--stdin"], {
		cwd: core.repoRoot(),
		encoding: "utf8",
		input: orphans.join(""),
		stdio: ["pipe", "ignore", "pipe"],
	});
	if (res.status !== 0)
		core.logError(
			"pruneBlobRefs",
			new Error(
				`update-ref --stdin refused ${orphans.length} orphan pin(s); every pin stands: ${
					res.error?.message ?? res.stderr.trim()
				}`,
			),
		);
}

/**
 * Past this age a `refs/arbiter/<id>.lock` belongs to a git that was killed
 * mid-write — earlyoom, a VM shutdown, a hook timeout — and never to one still
 * running. A ref lock lives only between an update-ref taking it and committing:
 * the largest batch on record, 10,000 deletes, ran in 0.57s here (workflow-core#1193), and
 * the longest hook timeout in self-plugin/hooks/hooks.json is 400s. Ten minutes clears
 * both with margin.
 */
const STALE_REF_LOCK_MS = 10 * 60 * 1000;

/**
 * Remove every aged-out lock in the arbiter's ref namespace, and answer the
 * claim ids whose ref is STILL locked, which the batch must leave out.
 *
 * Only this namespace: the arbiter is its sole writer, so an aged lock here has
 * no owner left to wait for. A lock anywhere else in .git may be a live git in
 * the founder's terminal, and is check-stale-git-locks.js's to report, never
 * this sweep's to remove.
 *
 * Residual: two sweeps judging one aged lock at once could have the second
 * unlink a fresh lock taken in between; the namespace is quiet enough that a
 * lost pin refresh is the worst it costs.
 * @returns {Set<string>}
 */
function clearStaleRefLocks() {
	/** @type {Set<string>} */
	const locked = new Set();
	const common = core.git([
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!common) return locked;
	const dir = path.join(common, contentMod.BLOB_REF_PREFIX);
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".lock"));
	} catch (err) {
		// Absent is no loose pins at all; anything else is worth a log line.
		if (caught(err).code !== "ENOENT") core.logError("pruneBlobRefs", err);
		return locked;
	}
	for (const name of names) {
		const claimId = name.slice(0, -".lock".length);
		try {
			const file = path.join(dir, name);
			if (Date.now() - fs.statSync(file).mtimeMs > STALE_REF_LOCK_MS)
				fs.unlinkSync(file);
			else locked.add(claimId);
		} catch (err) {
			// Gone already is the outcome wanted; anything else keeps the ref out.
			if (caught(err).code !== "ENOENT") {
				locked.add(claimId);
				core.logError("pruneBlobRefs", err);
			}
		}
	}
	return locked;
}

// ---------------------------------------------------------------------------
// The session-start sweep (mantahostels#1796)
// ---------------------------------------------------------------------------

/**
 * Every record family the sweep clears with one directory and one age.
 *
 * ROW ORDER IS INERT: the whole table runs inside one loop, and it is that
 * loop's position ahead of pruneBlobRefs — not any row's — that keeps a
 * pin-holding family ahead of the collector.
 *
 * `nameFor` maps a live session to the file it owns, and a family without one
 * is keyed to no session at all, and reads no registry.
 *
 * A family that varies beyond this keeps its own function and is named in
 * pruneAll's body instead — markers sweeps two ages over the repo root, breaks
 * ages from a field rather than mtime, blobRefs is keyed by claim rather than
 * session, and issueClaims spares on a second oracle.
 * @type {{name: string, dir: () => string, ageMs: number, nameFor?: (id: string) => string}[]}
 */
const SWEPT_FAMILIES = [
	/*
	 * mtime, not `at`: the record is rewritten on every write, so the two agree —
	 * and mtime still ages out a record that will not parse, which has no `at` and
	 * would otherwise pin a blob for ever (mantahostels#363).
	 */
	{
		name: "pruneObservations",
		dir: core.paths.observationsDir,
		ageMs: observations.OBSERVATION_AGE_MS,
	},
	/*
	 * A want is dropped the moment its wait ends by any route, and readWants
	 * deletes one whose session is gone. The backstop is for the case none of that
	 * reaches — a session killed mid-wait on a machine that then reboots, where
	 * the pid check cannot even be attempted (mantahostels#1195).
	 */
	{ name: "pruneWants", dir: core.paths.wantsDir, ageMs: wants.WANT_AGE_MS },
	// A request pins nothing and frees nothing when it goes, so age alone is safe
	// by construction (mantahostels#1702; mantahostels#318 does not govern).
	{
		name: "pruneRequests",
		dir: core.paths.requestsDir,
		ageMs: requests.REQUEST_AGE_MS,
	},
	// pruneBases is in pruneAll's body: one session owns many per-path bases (workflow-core#110).
	{
		name: "pruneSessionBases",
		dir: core.paths.sessionBasesDir,
		ageMs: bases.BASE_AGE_MS,
		nameFor: (id) => path.basename(core.paths.sessionBase(id)),
	},
	// An `accept-head` log outlives its bases by nothing: a week from its last accept.
	{
		name: "pruneAcceptedHeads",
		dir: core.paths.acceptedHeadsDir,
		ageMs: bases.BASE_AGE_MS,
		nameFor: (id) => path.basename(core.paths.acceptedHeads(id)),
	},
	/*
	 * Never swept under a live session whatever its age: mtime is that session's
	 * last Bash call, and sweeping would make its next call read the whole tier as
	 * unknown and lose every baseline it had (mantahostels#104).
	 */
	{
		name: "pruneSnapshots",
		dir: core.paths.snapshotsDir,
		ageMs: snapshots.SNAPSHOT_AGE_MS,
		nameFor: (id) => path.basename(core.paths.snapshot(id)),
	},
];

/**
 * Clear every aged-out record family, in the one order that is safe.
 *
 * ORDER IS LOAD-BEARING WHERE A RECORD HOLDS A PIN OPEN: a break record (mantahostels#349)
 * and an observation (mantahostels#363) each keep a blob alive, so both go before
 * pruneBlobRefs collects the pins — otherwise the blob survives another session.
 *
 * REQUIRED, not defaulted, for pruneIssueClaims' own reason: an issue claim
 * is housekeeping alone (mantahostels#645), but the sweep deletes the record the selection
 * exclusion reads, so it spares on the same oracle that exclusion uses (mantahostels#704).
 * Throwing is not caught here — session-arbiter.js's `prune-markers` case
 * carries the top-level catch that keeps a session start from breaking on
 * housekeeping.
 * @param {LivenessOracle} liveness
 */
function pruneAll(liveness) {
	markers.pruneMarkers();
	breaks.pruneBreaks();
	for (const family of SWEPT_FAMILIES) {
		if (family.nameFor)
			core.sweepSparingLive(
				family.name,
				family.dir(),
				family.ageMs,
				family.nameFor,
			);
		else core.sweepAged(family.dir(), family.ageMs, () => false);
	}
	pruneBases();
	pruneBlobRefs();
	issues.pruneIssueClaims(liveness);
}

/**
 * Age out per-path bases (workflow-core#110), sparing every one a live session owns — by
 * filename suffix, as observedBy finds its own. An unreadable registry sweeps
 * nothing: a live session's base must not go on doubt.
 */
function pruneBases() {
	const live = core.liveOrLog("pruneBases");
	if (live === null) return;
	const suffixes = [...live].map((id) => core.pairSuffix(id));
	core.sweepAged(core.paths.basesDir(), bases.BASE_AGE_MS, (f) =>
		suffixes.some((suffix) => f.endsWith(suffix)),
	);
}

module.exports = {
	pruneAll,
};
