const { gitCommonDir, spawnGitSync } = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const breaks = require("./arbiter-breaks.js");
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const issues = require("./arbiter-issue-claims.js");
const lockFiles = require("./arbiter-lock-files.js");
const markers = require("./arbiter-markers.js");
const observations = require("./arbiter-observations.js");
const snapshots = require("./arbiter-snapshots.js");
const wants = require("./arbiter-wants.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */

function pruneBlobRefs() {
	const listed = core.git([
		"for-each-ref",
		"--format=%(refname)",
		contentMod.BLOB_REF_PREFIX,
	]);
	if (!listed) return;
	const locks = lockFiles.readLocks();
	if (locks === null) {
		core.logError("pruneBlobRefs", new Error("lock store unreadable"));
		return;
	}
	const broken = breaks.readBrokenClaimIds();
	if (broken === null) {
		core.logError("pruneBlobRefs", new Error("break records unreadable"));
		return;
	}
	const claimed = new Set(locks.map((l) => l.claimId).filter(Boolean));
	const observed = observations.readObservedIds();
	if (observed === null) {
		core.logError("pruneBlobRefs", new Error("observations unreadable"));
		return;
	}
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
	const res = spawnGitSync(["update-ref", "--stdin"], {
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

// 0.57 s measured, #1193
const STALE_REF_LOCK_MS = 10 * 60 * 1000;

/** @returns {Set<string>} */
function clearStaleRefLocks() {
	/** @type {Set<string>} */
	const locked = new Set();
	const common = gitCommonDir(core.repoRoot());
	if (!common) return locked;
	const dir = path.join(common, contentMod.BLOB_REF_PREFIX);
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".lock"));
	} catch (err) {
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
			if (caught(err).code !== "ENOENT") {
				locked.add(claimId);
				core.logError("pruneBlobRefs", err);
			}
		}
	}
	return locked;
}

/** @type {{name: string, dir: () => string, ageMs: number, nameFor?: (id: string) => string}[]} */
const SWEPT_FAMILIES = [
	{
		name: "pruneObservations",
		dir: core.paths.observationsDir,
		ageMs: observations.OBSERVATION_AGE_MS,
	},
	{ name: "pruneWants", dir: core.paths.wantsDir, ageMs: wants.WANT_AGE_MS },
	{
		name: "pruneSnapshots",
		dir: core.paths.snapshotsDir,
		ageMs: snapshots.SNAPSHOT_AGE_MS,
		nameFor: (id) => path.basename(core.paths.snapshot(id)),
	},
];

/** @param {LivenessOracle} liveness */
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
	// lucmoseley/mantahostels#349 lucmoseley/mantahostels#363
	pruneBlobRefs();
	issues.pruneIssueClaims(liveness);
}

module.exports = {
	pruneAll,
};
