const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const regions = require("./doc-map-regions.js");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const { buildArbiterCommand } = require("./build-arbiter-command.js");
const breaks = require("./arbiter-breaks.js");
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const ledger = require("./arbiter-ledger.js");
const lockFiles = require("./arbiter-lock-files.js");
const observations = require("./arbiter-observations.js");
const { isLockRecord, isReadableLock } = require("./arbiter-records.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ListedLock} ListedLock */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */
/** @typedef {import("./arbiter-records.js").ClaimResult} ClaimResult */
/** @typedef {import("./arbiter-records.js").OwnHunks} OwnHunks */

/**
 * @param {{path: string} & Partial<LockRecord>} spec
 * @returns {LockRecord}
 */
function newLock({
	path: rel,
	sessionId = null,
	pid = null,
	procStart = null,
	claimedAt = new Date().toISOString(),
	claimId = crypto.randomUUID(),
	bootId = readCurrentBootId(),
	blob = null,
	priorBlobs = [],
	preBlob = null,
	tree,
}) {
	return {
		path: rel,
		...(tree ? { tree } : {}),
		sessionId,
		pid,
		procStart,
		claimedAt,
		claimId,
		bootId,
		blob,
		priorBlobs,
		preBlob,
	};
}

function sweepDebris() {
	ignoreFailure(() => {
		const now = Date.now();
		const wasResumed = core.resumedHolderTest(
			"sweep",
			"the sessions registry could not be read, so an aside held by a resumed " +
				"session cannot be told from debris — an aged one is swept, which can " +
				"take a file from a live session",
		);
		const dir = core.paths.locksDir();
		for (const f of fs.readdirSync(dir))
			sweepDebrisEntry(dir, f, now, wasResumed);
	});
}

/**
 * @param {string} dir
 * @param {string} f
 * @param {number} now
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function sweepDebrisEntry(dir, f, now, wasResumed) {
	if (
		!f.startsWith(".tmp-") &&
		!f.startsWith(".said-") &&
		!f.includes(".json.stale-")
	)
		return;
	const full = path.join(dir, f);
	if (f.includes(".json.stale-") && keepLiveAside(full, wasResumed)) return;
	ignoreFailure(() => {
		if (now - fs.statSync(full).mtimeMs > lockFiles.DEBRIS_AGE_MS)
			fs.unlinkSync(full);
	});
}

/**
 * @param {string} full
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function keepLiveAside(full, wasResumed) {
	let moved;
	try {
		moved = core.readRecordAs(full, isLockRecord);
	} catch (e) {
		core.logError("sweep", e);
		return true;
	}
	if (!(moved && core.liveOrResumed(moved, wasResumed))) return false;
	const lockPath = full.slice(0, full.lastIndexOf(".stale-"));
	if (lockFiles.restoreAside(full, lockPath)) {
		core.logError(
			"sweep",
			`found ${moved.path}'s live lock (session ${moved.sessionId}, pid ${moved.pid}) stranded aside and restored it — a breaker died between moving it and putting it back`,
		);
	}
	return true;
}

/**
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {{pid: number|null, procStart: string|number|null}} resumed
 */
function repointLock(rel, existing, resumed) {
	const { outcome, lock } = lockFiles.updateIfUnchanged(
		rel,
		(m) => m.claimId === existing.claimId,
		(m) => ({
			...m,
			pid: resumed.pid,
			procStart: resumed.procStart,
			bootId: readCurrentBootId() || m.bootId,
		}),
	);
	return outcome === "updated" ? lock : (lock ?? existing);
}

/**
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {Identity|null} [me]
 */
function breakStale(rel, existing, me = null) {
	const { outcome, moved, restored } = lockFiles.dropIfUnchanged(
		rel,
		(m) => m.claimId === existing.claimId || !holderAlive(m),
	);
	if (outcome === "dropped") {
		if (!me?.sessionId || moved?.sessionId !== me.sessionId)
			breaks.recordBreak(rel, moved, me);
		return "freed";
	}

	if (moved !== null && restored === false) {
		core.logError(
			"claim",
			`broke a live lock on ${rel} and could not restore it — session ` +
				`${moved.sessionId} (pid ${moved.pid}) lost its claim to a third claimant`,
		);
	}
	return "retry";
}

/**
 * @param {string} rel
 * @param {Identity|null} [me]
 */
function breakCorrupt(rel, me = null) {
	const lockPath = core.paths.lock(rel);
	const aside = lockFiles.renameAside(lockPath);
	if (aside === null) return "retry";

	let probe;
	try {
		probe = core.probeRecord(aside, isLockRecord);
	} catch (e) {
		core.logError(`break ${rel}`, e);
		lockFiles.restoreAside(aside, lockPath);
		return "retry";
	}
	if (probe.state === "absent") return "retry";
	if (probe.state === "ok") {
		if (!lockFiles.restoreAside(aside, lockPath))
			core.logError(
				"claim",
				`broke a live lock on ${rel} and could not restore it — session ` +
					`${probe.record.sessionId} (pid ${probe.record.pid}) lost its claim to a third claimant`,
			);
		return "retry";
	}

	ignoreFailure(() => fs.unlinkSync(aside));
	breaks.recordBreak(rel, null, me);
	core.logError(
		"claim",
		`broke an unparseable lock record on ${rel} — a permanently corrupt record ` +
			"would otherwise leave the path unclaimable and every write to it unprotected",
	);
	return "freed";
}

// guess, workflow-core#5529
/**
 * @param {string} rel
 * @param {Identity} me
 * @param {number} [attempts]
 */
function acquire(rel, me, attempts = 3) {
	try {
		return takeLock(rel, me, attempts);
	} catch (e) {
		const { code, message } = caught(e);
		core.sayOnce(
			me.sessionId,
			"claim",
			`could not use the lock store for ${rel} (${code || message}) — ` +
				"this write is allowed unchecked and no claim was taken, so the " +
				"file-claim guard is inert for every session until it is fixed",
		);
		return { verdict: "unknown", lock: null };
	}
}

/**
 * @param {string} subject
 * @param {Identity} me
 */
function conflictingLock(subject, me) {
	const { rel, region } = core.splitSubject(subject);
	if (!regions.isRegioned(rel)) return null;
	const all = lockFiles.readLocks();
	if (all === null) return null;
	const others = all
		.filter(isReadableLock)
		.filter((l) => core.splitSubject(l.path).region !== region);
	const resumed = core.resumedHolderTest(
		"claim",
		"the sessions registry could not be read, so a whole-file claim held by a " +
			"resumed session cannot be told from a dead one — this region claim goes " +
			"ahead, which can take the file from a live session",
	);
	return whoHolds(subject, me.sessionId, resumed, others);
}

/**
 * @param {string} rel
 * @param {Identity} me
 * @param {number} attempts
 */
function takeLock(rel, me, attempts) {
	const taken = takeSubjectLock(rel, me, attempts);
	if (taken.verdict !== "claimed" && taken.verdict !== "reentrant")
		return taken;
	const clash = conflictingLock(rel, me);
	if (!clash) return taken;
	const takenLock = taken.lock;
	if (taken.verdict === "claimed" && takenLock)
		lockFiles.dropIfUnchanged(rel, (m) => m.claimId === takenLock.claimId);
	return { verdict: "held", lock: clash };
}

/**
 * @param {string} lockPath
 * @param {Identity} me
 */
function judgeUndurable(lockPath, me) {
	const existing = core.readRecordAs(lockPath, isLockRecord);
	if (!existing) return { verdict: "claimed", lock: null };
	const mine = Boolean(me.sessionId && existing.sessionId === me.sessionId);
	if (
		!holderAlive(existing) &&
		(mine || !core.readLiveEntryFor(existing.sessionId, me))
	)
		return { verdict: "claimed", lock: null };
	return mine
		? { verdict: "reentrant", lock: existing }
		: { verdict: "held", lock: existing };
}

/**
 * @param {string} rel
 * @param {string} lockPath
 * @param {Identity} me
 * @param {string} state
 */
function breakIfCorrupt(rel, lockPath, me, state) {
	if (state === "absent") return;
	lockFiles.settle();
	if (core.probeRecord(lockPath, isLockRecord).state !== "unparseable") return;
	breakCorrupt(rel, me);
}

/**
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {Identity} me
 */
function judgeExisting(rel, existing, me) {
	if (!holderAlive(existing)) {
		const resumed =
			existing.sessionId === me.sessionId
				? null
				: core.readLiveEntryFor(existing.sessionId, me);
		if (resumed)
			return { verdict: "held", lock: repointLock(rel, existing, resumed) };
		breakStale(rel, existing, me);
		return null;
	}
	if (me.sessionId && existing.sessionId === me.sessionId) {
		return { verdict: "reentrant", lock: existing };
	}
	return { verdict: "held", lock: existing };
}

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function preBlobOf(rel, sessionId) {
	if (core.splitSubject(rel).region !== null) return null;
	if (!fs.existsSync(path.join(core.treeRoot(), rel))) return null;
	const sha = core.git(["hash-object", "-w", "--", rel]);
	if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
	const touched =
		ledger.readWritesBy(sessionId ?? "")?.includes(rel) !== false ||
		observations.readObservedBy(sessionId ?? "")?.includes(rel) !== false;
	if (!touched) return sha;
	return core.git(["rev-parse", "--verify", "-q", `HEAD:${rel}`]) === sha
		? sha
		: null;
}

/**
 * @param {string} rel
 * @param {LockRecord} lock
 * @returns {OwnHunks}
 */
function ownHunksState(rel, lock) {
	const pre = lock.preBlob;
	if (!pre) return "unproven";
	const head = core.git(["rev-parse", "--verify", "-q", `HEAD:${rel}`]);
	const index = core.git(["rev-parse", "--verify", "-q", `:${rel}`]);
	const disk = core.git(["hash-object", "-w", "--", rel]);
	if (!head || !index || !disk) return "unproven";
	/** @type {OwnHunks} */
	let answer = "landed";
	for (const side of new Set([lock.blob, index, disk])) {
		if (!side || side === head) continue;
		const merged = core.git(["merge-file", "--object-id", head, pre, side]);
		if (merged !== null) {
			if (merged !== head) return "pending";
			continue;
		}
		const outside = core.git([
			"merge-file",
			"--ours",
			"--object-id",
			head,
			pre,
			side,
		]);
		if (outside !== null && outside !== head) return "pending";
		answer = "unproven";
	}
	return answer;
}

/**
 * @param {string} rel
 * @param {Identity} me
 * @param {number} attempts
 */
function takeSubjectLock(rel, me, attempts) {
	fs.mkdirSync(core.paths.locksDir(), { recursive: true });
	sweepDebris();
	const lockPath = core.paths.lock(rel);

	if (!me.durable) return judgeUndurable(lockPath, me);

	const claimIfFree = () => {
		if (fs.existsSync(lockPath)) return null;
		const body = newLock({
			path: rel,
			sessionId: me.sessionId,
			pid: me.pid,
			procStart: me.procStart,
			preBlob: preBlobOf(rel, me.sessionId),
			tree: core.writerTree(),
		});
		return core.createOnce(lockPath, body)
			? { verdict: "claimed", lock: body }
			: null;
	};

	for (let attempt = 0; attempt < attempts; attempt++) {
		const took = claimIfFree();
		if (took) return took;

		const probe = core.probeRecord(lockPath, isLockRecord);
		const existing = probe.record;
		if (!existing) {
			breakIfCorrupt(rel, lockPath, me, probe.state);
			continue;
		}
		const judged = judgeExisting(rel, existing, me);
		if (judged) return judged;
	}

	// lucmoseley/mantahostels#1701
	const took = claimIfFree();
	if (took) return took;

	const final = core.readRecordAs(lockPath, isLockRecord);
	if (final && holderAlive(final)) return { verdict: "held", lock: final };
	core.logError(
		"claim",
		`gave up claiming ${rel} after ${attempts} attempts — no lock written`,
	);
	return { verdict: "claimed", lock: null };
}

/**
 * @param {string} rel
 * @param {Identity} me
 * @param {{generator?: boolean, notMine?: boolean}} [opts]
 * @returns {ClaimResult}
 */
function release(rel, me, { generator = false, notMine = false } = {}) {
	let existing;
	try {
		existing = core.readRecordAs(core.paths.lock(rel), isLockRecord);
	} catch (e) {
		core.logError(`release ${rel}`, e);
		return { verdict: "unreadable", lock: null };
	}
	if (!existing)
		return {
			verdict: "not-held",
			lock: null,
			observed: observations.dropObservation(rel, me.sessionId),
		};

	if (!me.sessionId || existing.sessionId !== me.sessionId) {
		return {
			verdict: "held-by-other",
			lock: existing,
			observed: observations.dropObservation(rel, me.sessionId),
		};
	}

	const dropped = dropClean(rel, existing, generator, {
		ownHunks: true,
		notMine,
	});
	if (dropped.verdict !== "dropped") return dropped;
	contentMod.dropContentRef(existing.claimId);
	if (dropped.own)
		try {
			ledger.recordLanded(rel, me.sessionId);
		} catch (e) {
			core.logError(`record landed ${rel}`, e);
		}
	return {
		verdict: "released",
		lock: existing,
		content: dropped.content,
		own: dropped.own,
	};
}

/**
 * @param {string} subject
 * @param {LockRecord} existing
 * @param {boolean} [generator]
 * @param {{ownHunks?: boolean, notMine?: boolean}} [landing]
 */
function dropClean(subject, existing, generator = false, landing = {}) {
	return core.inRecordTree(existing, () =>
		dropCleanInTree(subject, existing, generator, landing),
	);
}

/**
 * @param {string} subject
 * @param {LockRecord} existing
 * @param {boolean} generator
 * @param {{ownHunks?: boolean, notMine?: boolean}} landing
 */
function dropCleanInTree(
	subject,
	existing,
	generator,
	{ ownHunks = false, notMine = false },
) {
	const content = {
		...contentMod.contentState(subject, existing),
		by: existing.sessionId,
	};

	const { rel, region } = core.splitSubject(subject);
	const waived =
		generator && region !== null && regions.isGeneratorOnlyRegion(rel, region);

	const dirty = core.subjectDirty(subject);
	const own =
		dirty === true && ownHunks && region === null
			? ownHunksState(rel, existing)
			: undefined;
	const othersOnly =
		own === "landed" || (own === "unproven" && notMine === true);
	if (dirty === true && !waived && !othersOnly)
		return { verdict: "dirty", lock: existing, content, own };
	if (dirty === null)
		return { verdict: "uncheckable", lock: existing, content };

	const { outcome, moved } = lockFiles.dropIfUnchanged(
		subject,
		(m) => m.claimId === existing.claimId,
	);
	return outcome === "dropped"
		? { verdict: "dropped", lock: existing, content, own }
		: { verdict: "contended", lock: moved || existing, content };
}

/** @returns {ListedLock[] | null} */
function listLocks() {
	return listLocksJudged().locks;
}

/** @returns {{locks: ListedLock[] | null, registryUnreadable: boolean}} */
function listLocksJudged() {
	const locks = lockFiles.readLocks();
	if (locks === null) return { locks: null, registryUnreadable: false };
	const wasResumed = core.resumedHolderTest(
		"list",
		"the sessions registry could not be read, so a claim held by a resumed " +
			"session is judged STALE and may in fact be live — `list` hides it by " +
			`default, so run: ${buildArbiterCommand`list --all`}`,
	);
	const judged = locks.map((lock) => {
		if (lock.unreadable) return lock;
		return { ...lock, alive: core.liveOrResumed(lock, wasResumed) };
	});
	return { locks: judged, registryUnreadable: wasResumed.registryUnreadable() };
}

/**
 * @param {string|null} sessionId
 * @returns {string[]|null}
 */
function readHeldClean(sessionId) {
	const held = lockFiles.readLocksHeldBy(sessionId);
	if (held === null) return null;
	return held
		.filter(
			(lock) =>
				core.splitSubject(lock.path).region === null &&
				subjectDirtyWhereHeld(lock) === false,
		)
		.map((lock) => lock.path)
		.sort();
}

/** @param {LockRecord} lock */
function subjectDirtyWhereHeld(lock) {
	return core.inRecordTree(lock, () => core.subjectDirty(lock.path));
}

/**
 * @param {string} subject
 * @param {string|null} sessionId
 * @param {ReturnType<typeof core.resumedHolderTest>} resumed
 * @param {LockRecord[]} locks
 */
function whoHolds(subject, sessionId, resumed, locks) {
	for (const lock of locks) {
		if (!core.subjectsOverlap(lock.path, subject)) continue;
		if (sessionId && lock.sessionId === sessionId) continue;
		if (isLockAlive(lock, resumed)) return lock;
	}
	return null;
}

/**
 * @param {LockRecord} lock
 * @param {ReturnType<typeof core.resumedHolderTest>} resumed
 * @returns {boolean}
 */
function isLockAlive(lock, resumed) {
	return lock.sessionId ? core.liveOrResumed(lock, resumed) : holderAlive(lock);
}

/**
 * @param {string} rel
 * @param {string|null|undefined} exceptClaimId
 */
function liveClaimElsewhereOnFile(rel, exceptClaimId) {
	const file = core.subjectPath(rel);
	const all = listLocks();
	if (all === null) return false;
	return all.some(
		(l) =>
			l &&
			!l.unreadable &&
			l.alive &&
			l.claimId !== exceptClaimId &&
			core.subjectPath(l.path) === file &&
			core.recordTree(l) === core.treeRoot(),
	);
}

module.exports = {
	acquire,
	listLocks,
	listLocksJudged,
	liveClaimElsewhereOnFile,
	readHeldClean,
	release,
	subjectDirtyWhereHeld,
	takeSubjectLock,
};
