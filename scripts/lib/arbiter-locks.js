const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const regions = require("./doc-map-regions.js");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const { buildArbiterCommand } = require("./build-arbiter-command.js");
const breaks = require("./arbiter-breaks.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const ledger = require("./arbiter-ledger.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const observations = require("./arbiter-observations.js");
const { sleepSync } = require("./sleep-sync.js");
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

// guess, #5529
const DEBRIS_AGE_MS = 60 * 60 * 1000;

/** @param {string} lockPath */
function renameAside(lockPath) {
	const aside = `${lockPath}.stale-${crypto.randomBytes(6).toString("hex")}`;
	try {
		fs.renameSync(lockPath, aside);
	} catch {
		return null;
	}
	ignoreFailure(() => {
		const now = new Date();
		fs.utimesSync(aside, now, now);
	});
	return aside;
}

/**
 * @param {string} aside
 * @param {string} lockPath
 */
function restoreAside(aside, lockPath) {
	try {
		fs.linkSync(aside, lockPath);
	} catch {
		return false;
	}
	ignoreFailure(() => fs.unlinkSync(aside));
	return true;
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
		if (now - fs.statSync(full).mtimeMs > DEBRIS_AGE_MS) fs.unlinkSync(full);
	});
}

/**
 * @param {string} full
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function keepLiveAside(full, wasResumed) {
	let moved;
	try {
		moved = core.readRecord(full);
	} catch (e) {
		core.logError("sweep", e);
		return true;
	}
	if (!(moved && core.liveOrResumed(moved, wasResumed))) return false;
	const lockPath = full.slice(0, full.lastIndexOf(".stale-"));
	if (restoreAside(full, lockPath)) {
		core.logError(
			"sweep",
			`found ${moved.path}'s live lock (session ${moved.sessionId}, pid ${moved.pid}) stranded aside and restored it — a breaker died between moving it and putting it back`,
		);
	}
	return true;
}

/**
 * @param {string} rel
 * @param {(lock: LockRecord) => boolean} isDroppable
 */
function dropIfUnchanged(rel, isDroppable) {
	const aside = renameAside(core.paths.lock(rel));
	if (aside === null) return { outcome: "contended", moved: null };

	const moved = core.readRecordOrLog(aside, `drop ${rel}`);
	if (moved !== null && isDroppable(moved)) {
		ignoreFailure(() => fs.unlinkSync(aside));
		return { outcome: "dropped", moved };
	}
	return {
		outcome: "kept",
		moved,
		restored: restoreAside(aside, core.paths.lock(rel)),
	};
}

/**
 * @param {string} rel
 * @param {(lock: LockRecord) => boolean} isOurs
 * @param {(lock: LockRecord) => LockRecord} mutate
 */
function updateIfUnchanged(rel, isOurs, mutate) {
	const lockPath = core.paths.lock(rel);
	const aside = renameAside(lockPath);
	if (aside === null) return { outcome: "contended", lock: null };

	const moved = core.readRecordOrLog(aside, `update ${rel}`);
	if (moved !== null && isOurs(moved)) {
		const updated = mutate({ ...moved });
		if (core.createOnce(lockPath, updated)) {
			ignoreFailure(() => fs.unlinkSync(aside));
			return { outcome: "updated", lock: updated };
		}
	}
	return {
		outcome: "kept",
		lock: moved,
		restored: restoreAside(aside, lockPath),
	};
}

/**
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {{pid: number|null, procStart: string|number|null}} resumed
 */
function repointLock(rel, existing, resumed) {
	const { outcome, lock } = updateIfUnchanged(
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
	const { outcome, moved, restored } = dropIfUnchanged(
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

// guess, lucmoseley/mantahostels#1691
const TORN_SETTLE_MS = 50;

function settle(ms = TORN_SETTLE_MS) {
	sleepSync(ms);
}

/**
 * @param {string} rel
 * @param {Identity|null} [me]
 */
function breakCorrupt(rel, me = null) {
	const lockPath = core.paths.lock(rel);
	const aside = renameAside(lockPath);
	if (aside === null) return "retry";

	let probe;
	try {
		probe = core.probeRecord(aside);
	} catch (e) {
		core.logError(`break ${rel}`, e);
		restoreAside(aside, lockPath);
		return "retry";
	}
	if (probe.state === "absent") return "retry";
	if (probe.state === "ok") {
		if (!restoreAside(aside, lockPath))
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

// guess, #5529
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
	const all = readLocks();
	if (all === null) return null;
	const others = all.filter(
		(l) => l.unreadable || core.splitSubject(l.path).region !== region,
	);
	const resumed = core.resumedHolderTest(
		"claim",
		"the sessions registry could not be read, so a whole-file claim held by a " +
			"resumed session cannot be told from a dead one — this region claim goes " +
			"ahead, which can take the file from a live session",
	);
	return whoHolds(subject, me.sessionId, resumed, others)?.holder ?? null;
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
	if (taken.verdict === "claimed" && taken.lock)
		dropIfUnchanged(rel, (m) => m.claimId === taken.lock.claimId);
	return { verdict: "held", lock: clash };
}

/**
 * @param {string} lockPath
 * @param {Identity} me
 */
function judgeUndurable(lockPath, me) {
	const existing = core.readRecord(lockPath);
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
	settle();
	if (core.probeRecord(lockPath).state !== "unparseable") return;
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

		const probe = core.probeRecord(lockPath);
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

	const final = core.readRecord(lockPath);
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
		existing = core.readRecord(core.paths.lock(rel));
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

	const { outcome, moved } = dropIfUnchanged(
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
	const locks = readLocks();
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

/** @param {() => void} [pause] */
function readLocks(pause = settle) {
	const dir = core.paths.locksDir();
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		core.logError("list", e);
		return null;
	}
	/** @param {string} full */
	const aged = (full) => {
		try {
			return Date.now() - fs.statSync(full).mtimeMs > DEBRIS_AGE_MS;
		} catch {
			return false;
		}
	};
	/**
	 * @param {string} f
	 * @param {boolean} settled
	 */
	const judge = (f, settled) => {
		const full = path.join(dir, f);
		let probe;
		try {
			probe = core.probeRecord(full);
		} catch (e) {
			core.logError("list", e);
			return { file: f, unreadable: true, reason: "refused" };
		}
		if (probe.state === "absent") return null;
		if (probe.state !== "unparseable") return probe.record;
		if (!settled && !aged(full)) return { file: f, torn: true };
		return { file: f, unreadable: true, reason: "unparseable" };
	};

	const first = files.map((f) => ({ f, l: judge(f, false) }));
	if (!first.some(({ l }) => l?.torn))
		return first.map(({ l }) => l).filter(Boolean);
	pause();
	return first
		.map(({ f, l }) => (l?.torn ? judge(f, true) : l))
		.filter(Boolean);
}

/** @param {string|null} sessionId */
function readHeldBy(sessionId) {
	return readLocksHeldBy(sessionId)?.map((l) => l.path) ?? null;
}

/**
 * @param {string|null} sessionId
 * @returns {string[]|null}
 */
function readHeldClean(sessionId) {
	const held = readLocksHeldBy(sessionId);
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

/**
 * @param {string|null} sessionId
 * @returns {LockRecord[]|null}
 */
function readLocksHeldBy(sessionId) {
	if (!sessionId) return null;
	const locks = readLocks();
	if (locks === null) return null;
	return /** @type {LockRecord[]} */ (
		locks.filter((l) => !l.unreadable && l.sessionId === sessionId)
	);
}

/** @param {LockRecord} lock */
function subjectDirtyWhereHeld(lock) {
	return core.inRecordTree(lock, () => core.subjectDirty(lock.path));
}

/**
 * @param {string} subject
 * @param {string|null} sessionId
 * @param {ReturnType<typeof core.resumedHolderTest>} resumed
 * @param {ReturnType<typeof readLocks>} [locks]
 */
function whoHolds(subject, sessionId, resumed, locks = readLocks()) {
	if (locks === null) return null;
	/** @type {LockRecord|null} */
	let holder = null;
	/** @type {LockRecord|null} */
	let own = null;
	/** @type {LockRecord[]} */
	const dead = [];
	const overlapping = locks.filter(
		(lock) => !lock.unreadable && core.subjectsOverlap(lock.path, subject),
	);
	for (const lock of overlapping) {
		if (sessionId && lock.sessionId === sessionId) own ??= lock;
		else if (holder === null) {
			if (isLockAlive(lock, resumed)) holder = lock;
			else dead.push(lock);
		}
	}
	if (holder) return { holder, own, dead: [], unknown: false };
	const unknown =
		resumed.registryUnreadable() && dead.some((lock) => lock.sessionId);
	return { holder, own, dead, unknown };
}

/**
 * @param {NonNullable<ReturnType<typeof readLocks>>[number]} lock
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

/**
 * @param {string} rel
 * @param {string|null} sessionId
 */
function readOwnLockOnFile(rel, sessionId) {
	const file = core.subjectPath(rel);
	const direct = core.readRecordOrLog(core.paths.lock(file), `observe ${file}`);
	if (direct?.sessionId === sessionId) return direct;
	if (regions.isRegioned(file)) {
		const all = readLocks() || [];
		const mine = all.find(
			(l) =>
				l &&
				!l.unreadable &&
				core.splitSubject(l.path).rel === file &&
				l.sessionId === sessionId,
		);
		if (mine) return mine;
		if (direct) return direct;
		return (
			all.find(
				(l) => l && !l.unreadable && core.splitSubject(l.path).rel === file,
			) || null
		);
	}
	return direct;
}

exports.acquire = acquire;
exports.breakStale = breakStale;
exports.dropIfUnchanged = dropIfUnchanged;
exports.readHeldBy = readHeldBy;
exports.readLocksHeldBy = readLocksHeldBy;
exports.subjectDirtyWhereHeld = subjectDirtyWhereHeld;
exports.readHeldClean = readHeldClean;
exports.listLocks = listLocks;
exports.listLocksJudged = listLocksJudged;
exports.liveClaimElsewhereOnFile = liveClaimElsewhereOnFile;
exports.newLock = newLock;
exports.readOwnLockOnFile = readOwnLockOnFile;
exports.readLocks = readLocks;
exports.release = release;
exports.repointLock = repointLock;
exports.settle = settle;
exports.sweepDebris = sweepDebris;
exports.takeLock = takeLock;
exports.takeSubjectLock = takeSubjectLock;
exports.updateIfUnchanged = updateIfUnchanged;
exports.whoHolds = whoHolds;
