/*
 * arbiter-locks.js — the claim registry — who holds a file, and the two exits from a claim.
 *
 * Taking a claim (`acquire`, `takeSubjectLock`), leaving one (`release`,
 * `forceRelease`, `park`), breaking a stale or corrupt one, and the debris a
 * process killed mid-break leaves behind.
 *
 * This file is in the require cycle, so it fills `module.exports` in place and
 * never destructures a sibling family — arbiter-store.js's header, THE SPLIT
 * RULE (mantahostels#1795).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { gitBinary } = require("./git-binary.js");
const regions = require("./doc-map-regions.js");
const { isListedLive } = require("./agent-liveness.js");
const { currentBootId, holderAlive } = require("./arbiter-proc.js");
const { scriptPath } = require("./script-path.js");
const bases = require("./arbiter-bases.js");
const breaks = require("./arbiter-breaks.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const ledger = require("./arbiter-ledger.js");
// biome-ignore lint/suspicious/noImportCycles: cyclic by design — arbiter-store.js's THE SPLIT RULE (mantahostels#1795).
const observations = require("./arbiter-observations.js");
const { sleepSync } = require("./sleep-sync.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ListedLock} ListedLock */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */
/** @typedef {import("./arbiter-records.js").ClaimResult} ClaimResult */
/** @typedef {import("./arbiter-records.js").OwnHunks} OwnHunks */
/**
 * Which of the answers park needs could not be got, when it hands back
 * `writers-unknown` (mantahostels#2417). Five are registers; `region` is not — it is a hash
 * of one region that git would not produce, or a region gone from the tree
 * (mantahostels#2429).
 * @typedef {"observations"|"registry"|"locks"|"head"|"worktree"|"region"} WritersUnknown
 */

// ---------------------------------------------------------------------------
// Locks — the claim registry
// ---------------------------------------------------------------------------

/**
 * A lock record. Every field a lock has is named here and nowhere else.
 *
 * The defaults are the not-observed values: a lock with no pid is breakable
 * rather than permanent.
 *
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
	bootId = currentBootId(),
	// null is the not-observed value, and reads as "unknown" rather than
	// "changed" — see contentState.
	blob = null,
	// The versions `blob` replaced, newest first, capped at PRIOR_BLOBS_MAX (mantahostels#438).
	priorBlobs = [],
	// What the file held when this claim was taken — the bytes the holder's own
	// hunks are measured from (workflow-core#2148). Null on a region subject and a file that
	// did not exist yet.
	preBlob = null,
}) {
	return {
		path: rel,
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

/** Debris older than this is certainly abandoned; both writers finish in ms. */
const DEBRIS_AGE_MS = 60 * 60 * 1000;

/**
 * Move a lock judged stale out of the way, returning the path it now sits at, or
 * null if another claimant moved it first.
 *
 * The utimes is what keeps sweepDebris() off it: rename does not touch mtime, so
 * without this the aside file arrives already older than DEBRIS_AGE_MS whenever
 * its lock was claimed over an hour ago — and the caller still has to read it
 * back and may have to put it back.
 * @param {string} lockPath
 */
function renameAside(lockPath) {
	const aside = `${lockPath}.stale-${crypto.randomBytes(6).toString("hex")}`;
	try {
		fs.renameSync(lockPath, aside);
	} catch {
		return null;
	}
	try {
		const now = new Date();
		fs.utimesSync(aside, now, now);
	} catch {
		// Unstamped, so a concurrent sweep may delete it before the caller can read
		// it back. An aside that cannot be read is treated as inconclusive.
	}
	return aside;
}

/**
 * Put a lock back at its own path, and report whether it landed.
 *
 * link(2), never rename(2): rename REPLACES an existing destination silently, so
 * restoring over a path a third session has meanwhile claimed would delete that
 * session's live lock and leave two sessions holding the same file.
 * @param {string} aside
 * @param {string} lockPath
 */
function restoreAside(aside, lockPath) {
	try {
		fs.linkSync(aside, lockPath);
	} catch {
		return false; // the path is occupied again; the occupant's claim stands
	}
	try {
		fs.unlinkSync(aside);
	} catch {
		/* swept already; the restored link is what matters */
	}
	return true;
}

/**
 * Delete abandoned `.tmp-*`, `.said-*` and `.stale-*` files.
 *
 * All three are meant to be transient — `.tmp-` is unlinked in core.createOnce's
 * finally, `.stale-` in the break path — but a process killed between the two
 * steps (earlyoom, at the WSL memory cap, kills mid-syscall) leaves one behind for
 * good. None is ever read after its own operation returns, so age is the whole
 * test.
 *
 * AGE MEANS AGE OF THE DEBRIS, NOT OF THE LOCK IT CAME FROM. rename(2) leaves
 * mtime alone, so a `.stale-` file inherits the moment its lock was claimed. A
 * session running longer than an hour would therefore produce debris already past
 * this threshold the instant it was created, and another session's sweep could
 * delete it inside the break path's re-judge window — dropping a lock that turned
 * out to be live and handing two sessions the same file. renameAside() restamps
 * for exactly that reason; do not remove it.
 *
 * Silent and best-effort: this is housekeeping, and a claim must not fail over it.
 */
function sweepDebris() {
	try {
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
	} catch {
		/* no locks directory yet */
	}
}

/**
 * sweepDebris's judgement of one locks-directory entry.
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
	try {
		if (now - fs.statSync(full).mtimeMs > DEBRIS_AGE_MS) fs.unlinkSync(full);
	} catch {
		/* another sweeper got there first, or it is gone already */
	}
}

/**
 * Whether the sweep must leave the aside at `full` alone: true where it cannot
 * be read, or where its holder is live.
 *
 * An aside whose holder is still ALIVE is not debris — it is a live claim
 * a breaker moved and then died before re-judging (the hook's own
 * `timeout 5`, earlyoom). The lock's path reads free while its holder
 * works on, so put it back before anything judges that path. Restore
 * refused means the path is occupied again; the aside stays for a later
 * sweep, and dies with its holder.
 * @param {string} full
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function keepLiveAside(full, wasResumed) {
	let moved;
	try {
		moved = core.readRecord(full);
	} catch (e) {
		// Refused, so whether this aside is a live claim cannot be judged —
		// and the age test would delete it, dropping a lock whose
		// holder is still working. Leave it and say so (mantahostels#174).
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
 * Delete `rel`'s lock, but only if `isDroppable` accepts what was actually
 * sitting there.
 *
 * Drop by RENAMING aside, never by unlinking in place. rename(2) is what makes it
 * single-winner: of several sessions acting on this lock at once, exactly one
 * moves the path and the rest get ENOENT. A read-then-unlink cannot do that
 * however tightly it re-reads — between the recheck and the unlink another session
 * can take the file, and the unlink then deletes ITS live claim, leaving two
 * sessions both believing they hold the file.
 *
 * Returns {outcome, moved, restored}. "dropped" — gone. "kept" — not what we
 * judged, so it went back, `restored` saying whether it landed. "contended" —
 * somebody else moved it first; nothing was touched.
 * @param {string} rel
 * @param {(lock: LockRecord) => boolean} isDroppable
 */
function dropIfUnchanged(rel, isDroppable) {
	const aside = renameAside(core.paths.lock(rel));
	if (aside === null) return { outcome: "contended", moved: null };

	// An aside we cannot read must never become licence to take the file: unreadable
	// or already gone, we cannot tell whether we moved the lock we judged or a
	// replacement, so it goes back unread. A REFUSED read lands here too, via the
	// logging reader (mantahostels#174).
	const moved = core.readRecordOrLog(aside, `drop ${rel}`);
	if (moved !== null && isDroppable(moved)) {
		try {
			fs.unlinkSync(aside);
		} catch {
			/* already gone */
		}
		return { outcome: "dropped", moved };
	}
	return {
		outcome: "kept",
		moved,
		restored: restoreAside(aside, core.paths.lock(rel)),
	};
}

/**
 * Rewrite `rel`'s lock in place, but only if `isOurs` accepts what was actually
 * sitting there. Returns {outcome, lock} — "updated", "kept", "contended".
 *
 * Through the same rename-aside dance as dropIfUnchanged, and for the same reason.
 *
 * A failed re-link leaves the aside behind for sweepDebris, which restores a
 * live one — the same residual breakStale carries.
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
			try {
				fs.unlinkSync(aside);
			} catch {
				/* already gone */
			}
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
 * Point a lock at the live process its holder was resumed onto, so the next
 * reader gets the right answer from holderAlive alone and repeats no registry
 * walk. Returns the record now describing the path — which on a rewrite that did
 * not land is whatever was actually there, so a denial names a live holder
 * rather than the dead pid this one recorded.
 *
 * claimId is carried through, not reminted: the content pin recording what the
 * file held is keyed by it (mantahostels#295), and a new one would strand that blob. Nor is
 * a readable bootId dropped where this machine will not say what boot it is on:
 * an unscoped lock is one a reboot can hand to a stranger holding the same pid.
 *
 * The caller is refused either way, on evidence it read itself, and the next
 * writer repeats the walk, so a rewrite that does not land is not reported.
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
			bootId: currentBootId() || m.bootId,
		}),
	);
	return outcome === "updated" ? lock : (lock ?? existing);
}

/**
 * Break a lock already judged stale, leaving the path free for the next attempt.
 *
 * Separate from acquire() because acquire() cannot be driven through these
 * branches from a test: they need the lock to change between acquire()'s read and
 * its rename, which no in-process test can arrange. Reached directly instead;
 * the stale-holder acquire() tests pin the call site.
 *
 * Returns "freed" | "retry" — advisory; the caller re-reads the path either way.
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {Identity|null} [me]
 */
function breakStale(rel, existing, me = null) {
	// A lock that changed under us is still droppable if its new holder is dead —
	// it is debris either way. Only a LIVE replacement goes back.
	const { outcome, moved, restored } = dropIfUnchanged(
		rel,
		(m) => m.claimId === existing.claimId || !holderAlive(m),
	);
	if (outcome === "dropped") {
		// `moved`, not `existing`: the lock actually broken may be a second dead
		// claim that replaced the one the caller judged.
		//
		// A session's own stale lock is retaken here rather than broken (see
		// takeLock), so nobody lost anything and there is nothing to report.
		if (!me?.sessionId || moved?.sessionId !== me.sessionId)
			breaks.recordBreak(rel, moved, me);
		return "freed";
	}

	// Failing to put a live lock back is the one case where this guard has actively
	// destroyed a claim rather than merely failed to make one, so it goes in the log.
	// It happens when a THIRD session claimed the path in the moment it stood empty:
	// link then refuses, correctly — overwriting would leave that third session and
	// `moved`'s holder both holding the file. It self-heals, because the guard re-claims
	// on every write and the loser is refused on its next one; the window is one
	// in-flight write.
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
 * How long a torn write is given to finish before its record is called corrupt.
 *
 * A lock path is only ever created by core.createOnce, which links a fully-written
 * temp file into place, so THIS store cannot tear one; the writer a pause
 * defends against is an external one (mantahostels#1691).
 *
 * A ZERO-BYTE RECORD IS A FILESYSTEM CRASH, NOT A STORE FAULT, and needs no
 * investigating (mantahostels#1693). link(2) publishes the name while the freshly-written
 * inode's data pages are still dirty, so a WSL2 VM going down zeroes whatever
 * had not been written back — session transcripts and token files alike, not
 * just locks. Hardening the write with fsync was declined there: it costs a
 * disk flush on every guarded write, and the sessions holding those claims died
 * in the same instant.
 */
const TORN_SETTLE_MS = 50;

/** A synchronous pause: the store's callers are hooks with no loop to yield to. */
function settle(ms = TORN_SETTLE_MS) {
	sleepSync(ms);
}

/**
 * Break a lock whose bytes will not parse, leaving the path free for the next
 * attempt. Returns "freed" | "retry" — advisory; the caller re-reads either way.
 *
 * Through the same rename-aside dance as dropIfUnchanged, and for the same
 * reason, but with the predicate INVERTED: what is dropped here is the record
 * that would not read, and a READABLE one goes back — between the caller's
 * judgement and this rename another session may have broken the same corrupt
 * lock and taken the path with a good lock of its own.
 *
 * A refused read goes back unread too (mantahostels#174): unreadable is not corrupt.
 * @param {string} rel
 * @param {Identity|null} [me]
 */
function breakCorrupt(rel, me = null) {
	const lockPath = core.paths.lock(rel);
	const aside = renameAside(lockPath);
	if (aside === null) return "retry"; // somebody else moved it first

	let probe;
	try {
		probe = core.probeRecord(aside);
	} catch (e) {
		core.logError(`break ${rel}`, e);
		restoreAside(aside, lockPath);
		return "retry";
	}
	if (probe.state === "absent") return "retry"; // swept from under us
	if (probe.state === "ok") {
		// A failed restore has DESTROYED a claim rather than failed to make one —
		// breakStale's own comment has the window and why it self-heals.
		if (!restoreAside(aside, lockPath))
			core.logError(
				"claim",
				`broke a live lock on ${rel} and could not restore it — session ` +
					`${probe.record.sessionId} (pid ${probe.record.pid}) lost its claim to a third claimant`,
			);
		return "retry";
	}

	try {
		fs.unlinkSync(aside);
	} catch {
		/* already gone */
	}
	// Filed unkeyed, because unparseable means the holder is unknown — so
	// breakNotice, which matches a break to a session on lostBy, will never
	// surface it and the log line below is the whole of the visibility.
	breaks.recordBreak(rel, null, me);
	core.logError(
		"claim",
		`broke an unparseable lock record on ${rel} — a permanently corrupt record ` +
			"would otherwise leave the path unclaimable and every write to it unprotected",
	);
	return "freed";
}

/**
 * Take `rel` for `me`, or report who holds it.
 *
 * Returns {verdict: "claimed"|"held"|"reentrant"|"unknown", lock}. "held" is the
 * only refusal; re-entrancy is explicit because a session must be able to write
 * the same file twice (mantahostels#103 §5); "unknown" means the store could not be read or
 * written at all, so nothing can be said about who holds the file.
 *
 * FAIL OPEN, BUT NEVER SILENTLY (mantahostels#174). A store fault must not halt every
 * session, so the caller still allows the write — but it is told "unknown", not
 * "claimed".
 * @param {string} rel
 * @param {Identity} me
 * @param {number} [attempts] tries at a contended path; 3 is a guess, never
 *   measured
 */
function acquire(rel, me, attempts = 3) {
	try {
		return takeLock(rel, me, attempts);
	} catch (e) {
		const { code, message } = caught(e);
		// sayOnce's marker lives in locks/, so against THIS fault it cannot dedupe
		// and every guarded write records a line. check-guard-errors.js groups
		// identical faults (mantahostels#147), so the display stays readable.
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
 * A LIVE claim that rules this subject out, or null.
 *
 * Region claims tile a file, so two named regions never conflict (mantahostels#848). What
 * still does is the UMBRELLA: a whole-file claim covers every region, and a
 * region claim blocks the whole file.
 *
 * A RESUMED holder counts, exactly as it does on the subject lock takeSubjectLock
 * judges (mantahostels#359, workflow-core#259).
 * @param {string} subject
 * @param {Identity} me
 */
function conflictingLock(subject, me) {
	const { rel, region } = core.splitSubject(subject);
	if (!regions.isRegioned(rel)) return null;
	const all = readLocks();
	if (all === null) return null; // unreadable store — acquire's own fail-open (mantahostels#174), which `unknown` follows below
	// The subject's own lock is takeSubjectLock's to judge, so what overlaps
	// once it is set aside is the whole file against a region of it.
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
 * acquire()'s body, which throws on a store it cannot use. Separate so that its
 * writes, not only its reads, are covered by acquire()'s one honest answer.
 *
 * `attempts` exists so a test can reach what happens after contention is lost
 * every time — a state no in-process test can otherwise produce, because it needs
 * a second session to win each round. Callers leave it alone.
 * @param {string} rel
 * @param {Identity} me
 * @param {number} attempts
 */
function takeLock(rel, me, attempts) {
	const taken = takeSubjectLock(rel, me, attempts);
	if (taken.verdict !== "claimed" && taken.verdict !== "reentrant")
		return taken;
	const clash = conflictingLock(rel, me);
	if (!clash) {
		// A fresh claim is this session's first write to the file (workflow-core#110).
		if (taken.verdict === "claimed") bases.mintBase(rel, me.sessionId);
		return taken;
	}
	// Our lock landed first and now has to go back: keeping it would block the
	// clash's holder in turn and neither claim would ever be released. A
	// REENTRANT one is left alone — it is a claim this session already had, and
	// dropping it would silently free a region mid-edit.
	if (taken.verdict === "claimed" && taken.lock)
		dropIfUnchanged(rel, (m) => m.claimId === taken.lock.claimId);
	// Known residual: two sessions arriving together — one on the file, one on a
	// region of it — can each take their lock, each see the other, and both back
	// off, so both are denied and neither holds. Denying both is the safe way to
	// lose that race.
	return { verdict: "held", lock: clash };
}

/**
 * takeSubjectLock's answer for a session that cannot be durably identified.
 * @param {string} lockPath
 * @param {Identity} me
 */
function judgeUndurable(lockPath, me) {
	const existing = core.readRecord(lockPath);
	if (!existing) return { verdict: "claimed", lock: null };
	const mine = Boolean(me.sessionId && existing.sessionId === me.sessionId);
	// A holder reading dead may have been resumed onto a fresh host, in which
	// case the file has a live editor and this write lands under it (mantahostels#359).
	//
	// So a session that can take no claim of its own is still DENIED one —
	// mantahostels#104 rule 4, unknown counts as holding. What is unknown here is the
	// HOLDER's liveness, not this session's, and the registry resolves it.
	//
	// Nothing is written back, so the lock keeps its dead pid until a durable
	// claimant re-points it. Our OWN id needs no walk: non-durable means
	// precisely that no live entry carries it.
	if (
		!holderAlive(existing) &&
		(mine || !core.liveEntryFor(existing.sessionId, me))
	)
		return { verdict: "claimed", lock: null };
	return mine
		? { verdict: "reentrant", lock: existing }
		: { verdict: "held", lock: existing };
}

/**
 * takeSubjectLock's move on a lock path that read no record.
 * @param {string} rel
 * @param {string} lockPath
 * @param {Identity} me
 * @param {string} state the probe's state
 */
function breakIfCorrupt(rel, lockPath, me, state) {
	// Gone between our link and this read; the next round's core.createOnce takes it.
	if (state === "absent") return;
	// Unparseable, which is TORN or CORRUPT and they are not the same fault.
	// Torn is another claimant mid-write, and retrying rather than stealing is
	// right — a partial read must not become a licence to take a live lock.
	// Corrupt never settles, and retrying it leaves the path unclaimable for
	// good while every write to it goes unprotected (mantahostels#1691). A pause tells
	// them apart.
	settle();
	if (core.probeRecord(lockPath).state !== "unparseable") return;
	breakCorrupt(rel, me);
}

/**
 * takeSubjectLock's verdict on a lock it read, or null where it broke a stale
 * one and the next round must try again.
 *
 * Liveness is judged BEFORE the session id, both here and in judgeUndurable. A
 * session outlives its process, keeping its id under a fresh pid when it is
 * resumed (mantahostels#348). Matching on the id first returns "reentrant" on a lock
 * recording the dead pid and leaves it there — so every other session reads
 * that lock as stale and takes the file, while its live holder is never told.
 * @param {string} rel
 * @param {LockRecord} existing
 * @param {Identity} me
 */
function judgeExisting(rel, existing, me) {
	if (!holderAlive(existing)) {
		// Our OWN stale lock is left to the break path below, which retakes it with
		// our live pid — breaking a lock we hold endangers nobody.
		const resumed =
			existing.sessionId === me.sessionId
				? null
				: core.liveEntryFor(existing.sessionId, me);
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
 * The blob `rel` holds on disk as a claim on it is taken, written to the object
 * store so release can merge against it (workflow-core#2148) — or null on a region subject,
 * a file not yet on disk, or a git that would not answer.
 *
 * NULL, TOO, WHERE THE BYTES MAY HOLD THIS SESSION'S OWN EARLIER EDIT: a file
 * it has written before — by a tool (the write ledger) or from Bash (its
 * observation, mantahostels#419) — that no longer matches HEAD. Taken as the
 * base, that edit would read as a neighbour's and be handed over (mantahostels#63).
 * The write ledger is keyed by session, so a resumed process's retake of its own
 * stale lock lands here too.
 *
 * UNPINNED, unlike `blob`: a loose object outlives git's two-week prune grace,
 * which no claim does, and a blob `gc --prune=now` took makes the merge fail,
 * which ownHunksState reads as unproven.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function preBlobOf(rel, sessionId) {
	if (core.splitSubject(rel).region !== null) return null;
	if (!fs.existsSync(path.join(core.repoRoot(), rel))) return null;
	const sha = core.git(["hash-object", "-w", "--", rel]);
	if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
	const touched =
		ledger.writesBy(sessionId ?? "")?.includes(rel) !== false ||
		observations.observedBy(sessionId ?? "")?.includes(rel) !== false;
	if (!touched) return sha;
	return core.git(["rev-parse", "--verify", "-q", `HEAD:${rel}`]) === sha
		? sha
		: null;
}

/**
 * Whether every hunk the holder of `lock` wrote in `rel` has landed in HEAD,
 * however much other dirt the file still carries (workflow-core#2148).
 *
 * THE HOLDER'S HUNKS are what separates `preBlob`, the bytes the file held when
 * the claim was taken, from what the holder wrote since. A neighbour's
 * uncommitted hunk was already in `preBlob`, so it is no change on that side.
 * Each place a change of the holder's can sit — its last recorded write
 * (`blob`), the disk, and the index, which a commit by the next holder would
 * sweep in — is merged three ways against HEAD with `preBlob` as the base. A
 * merge that comes back as HEAD itself means HEAD already has every change
 * that carrier made.
 *
 * THE DISK COUNTS AS THE HOLDER'S. A write no hook re-pinned is most often the
 * holder's own from Bash, so a change there HEAD lacks reads "pending" — a
 * neighbour's Bash write after the holder's is kept too, the safe direction.
 *
 * "pending": a carrier holds a change HEAD lacks, proven. "unproven": no answer
 * — a lock with no `preBlob`, no HEAD or index entry, a git that would not
 * answer, or a merge conflict. A conflict is what a hunk the holder committed
 * and then rewrote produces, and what a hunk of its own abutting a neighbour's
 * produces too; it is retried preferring HEAD's side, so a clean change
 * elsewhere still reads pending, but the conflicting hunk itself stays unproven.
 * The caller refuses on unproven.
 *
 * Residual: `--object-id` is git 2.43's. On an older git every merge fails,
 * so every dirty file reads unproven and only `--not-mine` releases one.
 * @param {string} rel a whole-file subject
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
		// A conflict exits non-zero, which core.git answers null.
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
 * takeLock's body, before the umbrella check — one subject, one lock file.
 * @param {string} rel
 * @param {Identity} me
 * @param {number} attempts
 */
function takeSubjectLock(rel, me, attempts) {
	fs.mkdirSync(core.paths.locksDir(), { recursive: true });
	sweepDebris();
	const lockPath = core.paths.lock(rel);

	// An unidentifiable session reads the registry but does not write to it.
	if (!me.durable) return judgeUndurable(lockPath, me);

	/** Take the path if it is standing free, or null. Each call is one attempt. */
	const claimIfFree = () => {
		// A standing lock refuses createOnce anyway, and a re-entrant write is the
		// common case: it must not pay preBlobOf's git spawn.
		if (fs.existsSync(lockPath)) return null;
		const body = newLock({
			path: rel,
			sessionId: me.sessionId,
			pid: me.pid,
			procStart: me.procStart,
			preBlob: preBlobOf(rel, me.sessionId),
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

	// breakStale and breakCorrupt each `continue`, so a break landing on the last
	// attempt fell through to the give-up below and the write went unprotected
	// against a path standing open (mantahostels#1701). One more attempt, here rather than as
	// a refunded round, because it cannot loop: it runs exactly once whatever the
	// budget did. Not conditional on a break having happened — a path standing
	// free is a path to take however it came to be free, and an exhausted budget
	// that ended any other way leaves the file there for this to fail against.
	const took = claimIfFree();
	if (took) return took;

	// Alive only. A dead lock left by three lost races must not refuse the write:
	// nothing would ever clear it, which is the permanent wedge mantahostels#104 forbids.
	const final = core.readRecord(lockPath);
	if (final && holderAlive(final)) return { verdict: "held", lock: final };
	// Every round lost and the path still not takeable: the write proceeds
	// unprotected, so say so rather than reporting a claim nobody can see. The
	// count is the budget; the attempt above is one extra it does not name.
	core.logError(
		"claim",
		`gave up claiming ${rel} after ${attempts} attempts — no lock written`,
	);
	return { verdict: "claimed", lock: null };
}

/**
 * Drop `rel`'s claim, if `me` is the session holding it and what it names is
 * clean — the claimed REGION's own bytes on a region subject, the whole file
 * otherwise (subjectDirty, mantahostels#1434).
 *
 * OR WHERE THE DIRT IS NOBODY'S BUT A NEIGHBOUR'S (workflow-core#2148). A whole file whose
 * holder's own hunks have all landed releases with other sessions' uncommitted
 * hunks still in it: mantahostels#63 forbids handing over the HOLDER's
 * unfinished edit. ownHunksState proves it; `notMine` takes the holder's word
 * where the proof came back unproven, and never against a pending hunk it found.
 *
 * Returns {verdict, lock, content}: "released", "not-held" (no claim at all — a release is
 * idempotent, so this is not a fault), "held-by-other" (someone else's claim,
 * named), "dirty", "uncheckable" (git could not answer, so cleanliness is
 * unproven), "unreadable" (the store refused the read), "contended" (the lock
 * changed underneath us; nothing was dropped).
 *
 * Drops through dropIfUnchanged, so a lock that changed underneath goes back
 * untouched rather than being deleted.
 *
 * `content` rides EVERY verdict dropClean computes one for — "released",
 * "dirty", "uncheckable" and "contended": contentState's answer, read BEFORE the
 * drop takes the pin with it (mantahostels#332), since the caller's report needs the recorded
 * blob id and dropContentRef fires the instant the lock goes.
 *
 * It is read before the cleanliness check rather than after it (mantahostels#337), so the
 * `dirty` refusal cannot bury a clobber behind its own commit-or-discard advice
 * (mantahostels#288).
 *
 * AN ANSWER THIS HAS COMPUTED IS ALWAYS HANDED BACK (mantahostels#420). Whether to PRINT it
 * stays the caller's. "held-by-other" and "not-held" compute no `content`,
 * returning before dropClean — but each answers for the caller's own observation
 * instead, as `observed` (mantahostels#363).
 *
 * `generator: true` waives the dirty refusal, and only on a subject
 * `isGeneratorOnlyRegion` calls generator-only.
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
		// Refuses, exactly as the `uncheckable` git case below does, and for the
		// same reason: a release it cannot justify costs only today's behaviour —
		// the claim stands and the next write re-takes it (mantahostels#174).
		core.logError(`release ${rel}`, e);
		return { verdict: "unreadable", lock: null };
	}
	if (!existing)
		return {
			verdict: "not-held",
			lock: null,
			observed: observations.dropObservation(rel, me.sessionId),
		};

	// Identity, not liveness. A dead lock carrying someone else's session id is
	// still not ours to drop — breaking it is acquire()'s job, on a session that
	// actually wants the file.
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
	// The claim is gone, so its pinned content protects nobody.
	contentMod.dropContentRef(existing.claimId);
	// `own` rides a release only where the dirt left is others' alone. The
	// release stands if this cannot write: the overlay then carries the file.
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
 * What both exits from a claim do once the caller has been judged fit to drop
 * it: read the content, refuse a file that is not provably clean, then drop this
 * exact lock. Returns one of release()'s refusals, or "dropped" for the caller
 * to finish.
 *
 * ONE COPY: a caller that rewrites this tail loses the contentState read, and
 * with it mantahostels#337's clobber warning.
 *
 * The drop is stricter than the break path: only the exact lock read. A
 * replacement is somebody else's claim whether or not its holder still lives.
 *
 * `generator` WAIVES THE DIRTY REFUSAL, on §A of the map and nothing else
 * (mantahostels#2428). The §A generator's own write is what makes §A dirty, so without the
 * waiver its release refuses on every successful run and the claim stands until
 * somebody commits. §A's register rows are rendered whole from the sidecar, so
 * nobody's work is in them to lose.
 *
 * THE RESIDUAL: §A's own PROSE is hand-written and shares this region id
 * (doc-map-regions.js's `isGeneratorOnlyRegion`). A prose edit made by the Bash
 * route mints no claim of its own, so a generator run over it releases with that
 * edit still uncommitted — mantahostels#63's harm on bytes no generator can reproduce. It
 * needs the two to interleave on one region within one run.
 *
 * `ownHunks` is release()'s alone, and lets a dirty whole file through where
 * the holder's own hunks have landed — release's header. forceRelease leaves it
 * off: a forcing session is not the holder, and has no hunks of its own here.
 * @param {string} subject
 * @param {LockRecord} existing
 * @param {boolean} [generator]
 * @param {{ownHunks?: boolean, notMine?: boolean}} [landing]
 */
function dropClean(
	subject,
	existing,
	generator = false,
	{ ownHunks = false, notMine = false } = {},
) {
	// Before the check, per release's header. `by` is the claim the pin was taken
	// against, which is not always the lock handed back: `contended` returns the
	// REPLACEMENT lock, whose holder never wrote these bytes, and a caller with no
	// way to tell them apart credits the recoverable version to the wrong session
	// (mantahostels#420).
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
	// `uncheckable` is NOT waived with it: a null answer means git would not run
	// at all, which says the repo is broken rather than that these bytes are
	// derived.
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

/**
 * Drop `rel`'s claim on behalf of a session that is not its holder, and only
 * where an oracle says the holder is not live (mantahostels#411, ruled at mantahostels#319).
 *
 * THE ESCAPE FOR A STRANDED CLAIM. A pooled host outlives its job, so the
 * holder's process is alive and `release` — identity-gated — refuses every
 * caller for ever (mantahostels#254).
 *
 * `liveness` is called at most once and only where it decides something, and is
 * injected rather than called here so the store keeps making no subprocess
 * calls of its own.
 *
 * AN UNREADABLE ORACLE REFUSES, never warning and never falling back to
 * releasing (mantahostels#319): a stranded claim costs time, a broken lock
 * costs work.
 *
 * NEVER THE SESSIONS REGISTRY, AND NEVER `core.liveOrResumed` — workflow-core#259's one
 * spelling of holder liveness, which this deliberately does not read (workflow-core#262).
 * That spelling answers "may I write this file", where a running host means
 * hands off; this asks "has the session ended though its host runs on". All the
 * registry proves is that the recorded process is running, which is TRUE of the
 * stranded case above. Unifying them was built and measured at workflow-core#262: the escape
 * refused the case it exists for.
 *
 * THE RESIDUAL IS A LIVE CLAIM BROKEN. Resting on `claude agents --json` alone
 * means a session it lists late, or not at all, has no second reader to save
 * it — the registry would have known, and is not asked. workflow-core#268 widened it: a
 * finished session stays resumable (docs/environment.md §5), so a holder broken
 * on `terminal` can come back to a file it no longer holds.
 *
 * Verdicts: "forced" (with `record`, the break written), plus every refusal
 * `release` makes — "unreadable", "not-held", "dirty", "uncheckable",
 * "contended" — and three of its own: "holder-live", "oracle-unreadable" (with
 * `why`) and "holder-unnamed". Our OWN claim is delegated to release()
 * unchanged, oracle uncalled.
 *
 * The pin is NOT dropped. recordBreak holds it open for a week on mantahostels#349's terms,
 * so the version the holder last wrote stays recoverable.
 * `generator` is release's own flag, passed straight through to the same waiver
 * on both branches (mantahostels#2428).
 * @param {string} rel
 * @param {Identity} me
 * @param {LivenessOracle} liveness
 * @param {{generator?: boolean}} [opts]
 * @returns {ClaimResult}
 */
function forceRelease(rel, me, liveness, { generator = false } = {}) {
	let existing;
	try {
		existing = core.readRecord(core.paths.lock(rel));
	} catch (e) {
		core.logError(`force-release ${rel}`, e);
		return { verdict: "unreadable", lock: null };
	}
	if (!existing) return { verdict: "not-held", lock: null };
	if (me.sessionId && existing.sessionId === me.sessionId)
		return release(rel, me, { generator });

	// A lock naming no holder cannot be asked about, and calling it dead because
	// the oracle does not list `undefined` is exactly the false-dead mantahostels#322 forbids.
	if (!existing.sessionId) return { verdict: "holder-unnamed", lock: existing };

	const { ids, terminal, why } = liveness();
	if (!ids) return { verdict: "oracle-unreadable", lock: existing, why };
	// LISTED IS NOT LIVE (workflow-core#268). A background session that has finished stays in
	// `ids` until the reaper takes it. An oracle offering no `terminal` set
	// refuses as before.
	if (isListedLive(existing.sessionId, ids, terminal))
		return { verdict: "holder-live", lock: existing };

	// The bytes dropClean compares are the HOLDER's, and here the reader is not the
	// holder.
	const dropped = dropClean(rel, existing, generator);
	if (dropped.verdict !== "dropped") return dropped;

	// After the drop, as breakStale records: the path is free either way, and a
	// record that will not write must not wedge it (mantahostels#174).
	return {
		verdict: "forced",
		lock: existing,
		content: dropped.content,
		// The forcing session is by definition not the holder, so it may hold an
		// observation of its own — and the claim it was keyed against has just gone.
		observed: observations.dropObservation(rel, me.sessionId),
		record: breaks.recordBreak(rel, existing, me),
	};
}

/**
 * Every held path, each annotated with whether its holder is still running — or
 * `null` where the store could not be read at all.
 *
 * The null matters because this is what a person runs to see what is held, and
 * an unreadable store printed as "No files are claimed." says the coast is clear
 * (mantahostels#174). A single unreadable lock file is reported in place, as
 * `{file, unreadable: true}`, rather than dropped from the list.
 * @returns {ListedLock[] | null}
 */
function listLocks() {
	return listLocksJudged().locks;
}

/**
 * The same listing, plus whether the walk met a sessions registry that would
 * not open — in which case a STALE row may be a live holder resumed onto a
 * fresh process, and `list` says so above its rows (workflow-core#273).
 *
 * SEPARATE from listLocks, not a widened return, because the flag has one
 * consumer and `ListedLock[] | null` is read directly by some forty others.
 * `registryUnreadable` is false where the registry was never consulted — every
 * holder alive by its own pid.
 * @returns {{locks: ListedLock[] | null, registryUnreadable: boolean}}
 */
function listLocksJudged() {
	const locks = readLocks();
	if (locks === null) return { locks: null, registryUnreadable: false };
	// A lock freezes pid and procStart at claim time, so holderAlive() calls a
	// RESUMED holder — same session id, fresh host process — dead, and a person
	// reading STALE writes the file its holder is editing (mantahostels#359).
	const wasResumed = core.resumedHolderTest(
		"list",
		// Since mantahostels#1814 `list` hides a STALE row by default, so a reader
		// sent to look for one finds nothing at all.
		"the sessions registry could not be read, so a claim held by a resumed " +
			"session is judged STALE and may in fact be live — `list` hides it by " +
			"default, so run: node " +
			scriptPath("session-arbiter.js") +
			" list --all",
	);
	const judged = locks.map((lock) => {
		if (lock.unreadable) return lock;
		return { ...lock, alive: core.liveOrResumed(lock, wasResumed) };
	});
	// AFTER the walk, not during it: the test reads the registry lazily, so the
	// answer is only settled once every lock that needed it has asked.
	return { locks: judged, registryUnreadable: wasResumed.registryUnreadable() };
}

/**
 * Every lock on disk, unjudged — `null` where the store could not be read at
 * all, `{file, unreadable: true, reason}` for a single lock file that would not
 * open (`reason: "refused"`) or whose bytes will not parse
 * (`reason: "unparseable"`). Those two spellings are the whole vocabulary; a
 * consumer branching on `reason` handles both or neither.
 *
 * A RECORD IS NEVER DROPPED FOR BEING UNPARSEABLE (mantahostels#1692) — a reader skips it
 * by name and judges the rest. Only an ABSENT one is dropped: swept between the
 * readdir and the read, so there is nothing to report about it.
 *
 * TORN IS NOT CORRUPT, AND ONLY CORRUPT IS REPORTED. An unparseable read is
 * equally a writer caught mid-record, which settles by itself and is no fault at
 * all; the claim path tells them apart with a pause and a re-probe (mantahostels#1691, and
 * breakCorrupt's own comment). Same discriminator here, but the pause is spent
 * ONCE for the whole listing, never per file — a store holding four bad records
 * must not cost four pauses on every Bash call. And it is not spent at all where
 * every unparseable record is older than DEBRIS_AGE_MS by mtime: those are
 * corrupt on the first probe, because a crash-zeroed record (mantahostels#1693)
 * never settles and would otherwise charge every listing the pause until a human
 * deletes it (workflow-core#846, workflow-core#852). The claim path keeps its pause unconditionally — there a
 * misjudgement breaks a live lock, here it mislabels one line of a report.
 *
 * Separate from listLocks() because liveness is what costs a registry walk, and
 * heldBy() — which runs after every Bash call in every session — wants only the
 * paths (mantahostels#359).
 *
 * `pause` IS THE SEAM THE DISCRIMINATOR IS TESTED THROUGH (mantahostels#1711), and no
 * production caller passes it. Torn and corrupt differ only in what the SECOND
 * probe reads, so driving the difference means changing the file between the two
 * probes — through the real pause, a second process racing a 50 ms window. A
 * callback standing in for the pause finishes the record instead.
 * @param {() => void} [pause]
 */
function readLocks(pause = settle) {
	// Once per call, never per record: locksDir() walks the seat candidates (workflow-core#841).
	const dir = core.paths.locksDir();
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return []; // nothing has ever been claimed
		core.logError("list", e);
		return null;
	}
	/**
	 * Any writer finishes a record in milliseconds, so one untouched for
	 * DEBRIS_AGE_MS is not mid-write. A stat that fails proves nothing, so it
	 * reads as young and the pause is paid.
	 * @param {string} full
	 */
	const aged = (full) => {
		try {
			return Date.now() - fs.statSync(full).mtimeMs > DEBRIS_AGE_MS;
		} catch {
			return false;
		}
	};
	/**
	 * One file's answer, or null for an absent record.
	 * @param {string} f
	 * @param {boolean} settled Re-probe after the pause, so torn reads as corrupt.
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

/**
 * The paths `sessionId` currently holds, or `null` where the answer is
 * unavailable rather than empty — so a caller iterating them cannot mistake a
 * dark store for "this session holds nothing" (mantahostels#174).
 *
 * A session that cannot be named is `null` too, not `[]`, matching writesBy.
 * @param {string|null} sessionId
 */
function heldBy(sessionId) {
	if (!sessionId) return null;
	const locks = readLocks();
	if (locks === null) return null;
	return locks.filter((l) => l.sessionId === sessionId).map((l) => l.path);
}

/**
 * Who holds `subject`, as `sessionId` asks — the one answer acquire's conflict
 * check and every arbiter report read (workflow-core#1492). `null` where the store could not
 * be read.
 *
 * - `holder`: the first LIVE overlapping lock of anyone else's, a resumed holder
 *   included (workflow-core#259), and a lock naming no session included.
 * - `own`: this session's first overlapping lock — live by construction, so
 *   never judged.
 * - `dead`: the other overlapping locks judged dead, and `unknown`: whether one
 *   of them was judged against a sessions registry that would not open, so a
 *   RESUMED holder of it would have read alive had it opened (workflow-core#271). Both speak
 *   only where `holder` is null.
 *
 * Own session and overlap BEFORE liveness: judging first would read the
 * registry, and log its dark warning, over a lock the next test discards — so a
 * walk meeting no overlapping lock never reads it, and the doubt is always about
 * THIS subject, never one met over an unrelated path.
 *
 * `resumed` is the caller's, built once for its whole walk.
 * @param {string} subject
 * @param {string|null} sessionId
 * @param {ReturnType<typeof core.resumedHolderTest>} resumed
 * @param {ReturnType<typeof readLocks>} [locks] one snapshot, where the caller
 *   judges several subjects against it
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
	// Judging a dead lock that names a session read the registry, so whether it
	// opened is settled by now.
	const unknown =
		resumed.registryUnreadable() && dead.some((lock) => lock.sessionId);
	return { holder, own, dead, unknown };
}

/**
 * A lock naming no session has no registry entry to be resumed onto, so its
 * own pid decides, and the registry is neither read nor doubted.
 * @param {NonNullable<ReturnType<typeof readLocks>>[number]} lock
 * @param {ReturnType<typeof core.resumedHolderTest>} resumed
 * @returns {boolean}
 */
function isLockAlive(lock, resumed) {
	return lock.sessionId ? core.liveOrResumed(lock, resumed) : holderAlive(lock);
}

/**
 * Whether any LIVE claim other than `exceptClaimId` covers `rel`'s file.
 *
 * The dirty-and-unclaimed warning (mantahostels#99's signal 2) was defined when a claim and
 * a file were one to one, so it reads "nobody holds this" off the absence of one
 * lock. Under region claims that is false: a neighbour holding one `### B<n>`
 * entry, or this session holding another, is a live claimant the single-lock
 * test never sees — and the warning then tells a session its own uncommitted
 * edit is somebody's abandoned work.
 *
 * Costs a liveness walk, so it is asked only where the warning would otherwise
 * fire: a fresh claim on a guarded path that is dirty.
 * @param {string} rel
 * @param {string} exceptClaimId
 */
function liveClaimElsewhereOnFile(rel, exceptClaimId) {
	const file = core.subjectPath(rel);
	const all = listLocks();
	if (all === null) return false; // unreadable — the warning's own fail-open
	return all.some(
		(l) =>
			l &&
			!l.unreadable &&
			l.alive &&
			l.claimId !== exceptClaimId &&
			core.subjectPath(l.path) === file,
	);
}

/**
 * A subject's bytes as a git blob id, at `rev` or in the working tree — null
 * wherever the question could not be answered, which every caller reads as
 * "unknown" and never as "empty".
 *
 * The REGION arm has to build one: `regionBytes` reads the working tree only, so a HEAD-side region is
 * hashed here instead, through gitRaw — untrimmed, because git()'s trim strips
 * the newline the file ends on and the last region of HEAD would then never
 * equal the last region of the tree (mantahostels#1434).
 * @param {string} subject
 * @param {string|null} rev `null` for the working tree
 */
function subjectBlobAt(subject, rev) {
	const { rel, region } = core.splitSubject(subject);
	if (!region)
		return rev
			? core.git(["rev-parse", `${rev}:${rel}`])
			: core.git(["hash-object", "--", rel]);
	let text;
	if (rev) text = core.gitRaw(["show", `${rev}:${rel}`]);
	else {
		try {
			text = fs.readFileSync(path.join(core.repoRoot(), rel), "utf8");
		} catch {
			text = null;
		}
	}
	if (text === null || text === undefined) return null;
	const body = regions.regionText(text, region, rel);
	return body === null ? null : core.gitIn(["hash-object", "--stdin"], body);
}

/**
 * The subjects inside `rels` that another LIVE session has uncommitted work in
 * — what a pathspec commit naming those paths would sweep in under its own
 * message (mantahostels#1539, the incident; mantahostels#1558, which chose this test).
 *
 * THE TEST, per subject a foreign live claim holds: its pinned blob differs
 * from that same subject's blob at HEAD, AND the pinned bytes are still what
 * the working tree holds.
 *
 * A pin that differs from HEAD but is NOT what the tree holds is a STALE pin —
 * somebody has moved on from it — and says nothing about a sweep.
 *
 * SILENT WHERE THE NEIGHBOUR PINNED NOTHING (mantahostels#1558). A pin is minted only when
 * a claim's holder writes through Write or Edit, so a neighbour who reached the
 * file from Bash alone has pinned nothing and is invisible here. It does not
 * fall back to "a live claim exists on this path": under region claims that
 * is the ordinary state of docs/doc-map.md, and mantahostels#103 §6 warns on an inference
 * only where the guard has nothing better.
 *
 * Region subjects are compared region by region, so the answer names
 * `docs/doc-map.md#B229` rather than the file — but the SWEEP is whole-file
 * either way, which is why mantahostels#1560 declined to narrow the test to the regions a
 * commit's diff touches.
 *
 * FAILS OPEN, house style (mantahostels#103 §6): an unreadable store returns no findings
 * rather than a warning nobody can act on.
 * @param {string[]} rels repo-relative paths the pathspec names
 * @param {string|null} exceptSessionId the committing session, never reported
 * @returns {{subject: string, rel: string, region: string|null, holder: string}[]}
 */
function sweepRisk(rels, exceptSessionId) {
	const wanted = new Set(rels);
	if (wanted.size === 0) return [];
	// `git commit -m "…" -- docs/` sweeps every file under it, so a directory in
	// the pathspec covers the claims beneath it too. A pathspec word that is
	// neither a file nor a directory — a glob, a `:(exclude)` magic pathspec —
	// simply matches nothing, which is the fail-open reading.
	//
	// The repo root is the empty string, not "." — `relativeToRepo` returns "",
	// which is why the map below leaves "" alone instead of making it "/". Left
	// unguarded, `-- .` — the broadest pathspec there is, and the one that
	// sweeps the most — prefixes every claim with "/" and matches none.
	const dirs = rels
		.filter((r) => {
			try {
				return fs.statSync(path.join(core.repoRoot(), r)).isDirectory();
			} catch {
				return false;
			}
		})
		.map((r) => (r === "" || r.endsWith("/") ? r : `${r}/`));
	const covers = (/** @type {string} */ rel) =>
		wanted.has(rel) || dirs.some((d) => rel.startsWith(d));

	const locks = listLocks();
	if (locks === null) return [];

	const nameOf = core.registryNames();

	const out = [];
	for (const lock of locks) {
		const found = sweepFinding(lock, exceptSessionId, covers, nameOf);
		if (found) out.push(found);
	}
	return out;
}

/**
 * sweepRisk's test of one listed lock: a foreign live claim on a covered path
 * whose pin differs from HEAD and is still what the tree holds, as a finding —
 * else null.
 * @param {ListedLock} lock
 * @param {string|null} exceptSessionId
 * @param {(rel: string) => boolean} covers
 * @param {ReturnType<typeof core.registryNames>} nameOf
 * @returns {{subject: string, rel: string, region: string|null, holder: string}|null}
 */
function sweepFinding(lock, exceptSessionId, covers, nameOf) {
	if (!lock || lock.unreadable || !lock.alive) return null;
	if (!lock.sessionId || lock.sessionId === exceptSessionId) return null;
	// A fast path, not a guarantee of its own: the two blob comparisons below
	// already exclude an unpinned claim, and this spares them two git calls
	// per claim on a file — docs/doc-map.md — that carries many at once.
	if (!lock.blob) return null;
	const { rel, region } = core.splitSubject(lock.path);
	if (!covers(rel)) return null;
	if (subjectBlobAt(lock.path, "HEAD") === lock.blob) return null;
	if (subjectBlobAt(lock.path, null) !== lock.blob) return null;
	return {
		subject: lock.path,
		rel,
		region,
		holder: nameOf(lock.sessionId),
	};
}

/**
 * The lock that covers `rel`'s FILE, this session's own preferred — or null
 * where nothing holds it at all.
 *
 * Two questions ride on it and they are different: "is this write already
 * covered by a claim of mine" and "is this file claimed by anybody". On an
 * unregioned path one lock file answers both. On a regioned one the file may be
 * held by several claims at once, so this session's is looked for first.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function ownLockOnFile(rel, sessionId) {
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
		// This session's own claim wins the tie.
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

// ---------------------------------------------------------------------------
// Parking an unfinished edit (mantahostels#1405)
// ---------------------------------------------------------------------------

/**
 * `HEAD:<rel>`, or `{ found: false }` where HEAD does not have the path — and
 * null where git could not answer at all, which is never read as "not in HEAD".
 * @param {string} rel
 * @returns {{found: true, content: Buffer, mode: number|null}|{found: false}|null}
 */
function headBlob(rel) {
	try {
		const content = execFileSync(
			gitBinary(),
			["cat-file", "-p", `HEAD:${rel}`],
			{
				cwd: core.repoRoot(),
				maxBuffer: CHILD_MAX_BUFFER,
			},
		);
		return { found: true, content, mode: headMode(rel) };
	} catch (e) {
		const { status } = caught(e);
		// git ran and said no: the path is untracked, or HEAD does not have it yet.
		// Anything else — no repo, git missing, a broken object store — is unknown.
		if (status === 128 || status === 1) return { found: false };
		core.logError(`head blob ${rel}`, e);
		return null;
	}
}

/**
 * The permission bits git records for `rel` at HEAD — 0o755 for a `100755`
 * entry, 0o644 for anything else — or null where the tree entry could not be
 * read, which restores the bytes at the default rather than guessing a mode.
 * @param {string} rel
 */
function headMode(rel) {
	try {
		const line = String(
			execFileSync(gitBinary(), ["ls-tree", "HEAD", "--", rel], {
				cwd: core.repoRoot(),
			}),
		);
		if (/^100755\s/.test(line)) return 0o755;
		if (/^\d{6}\s/.test(line)) return 0o644;
		return null;
	} catch (e) {
		core.logError(`head mode ${rel}`, e);
		return null;
	}
}

/**
 * The live FOREIGN locks on any subject of `rel` — the file's own, or any
 * region of it. Null where the store would not be read, never an empty list.
 *
 * Live INCLUDES resumed (workflow-core#259).
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {LockRecord[]|null}
 */
function claimHoldersOn(rel, sessionId) {
	const locks = readLocks();
	if (locks === null) return null;
	const wasResumed = core.resumedHolderTest(
		"park",
		"the sessions registry could not be read, so a claim held by a resumed " +
			"session reads as dead — park may overwrite a live session's bytes",
	);
	const out = [];
	for (const lock of locks) {
		if (!lock || lock.unreadable || !lock.sessionId) continue;
		if (lock.sessionId === sessionId) continue;
		if (core.subjectPath(lock.path) !== rel) continue;
		if (!core.liveOrResumed(lock, wasResumed)) continue;
		out.push(lock);
	}
	return out;
}

/**
 * Whether the working tree is EXACTLY HEAD outside the regions of `rel` this
 * session claims — the test that lets a park clear a live claim holder (mantahostels#2400).
 * Null where the question could not be answered, which the caller refuses on.
 *
 * WHOLE-TEXT, NOT REGION BY REGION. Comparing each region id's bytes to HEAD's
 * looked equivalent and is not: the sidecar's bytes between two keys belong to
 * no region and a scalar-valued key mints none at all, two `### B<n>` entries
 * can be SWAPPED with every region still byte-identical, and `section-a`'s
 * fragments hide bytes moved between them. The splice below admits none of the
 * three, at the same cost.
 *
 * Strict on two cases it need not be, and left so: a region this session holds
 * in HEAD and has DELETED from the tree, and one it has MOVED. Both refuse.
 *
 * False for a path claims are not taken per region on. That arm is a COST guard,
 * not a correctness one.
 *
 * A whole-file claim of this session's own excludes nothing — a foreign holder
 * alongside it is an anomalous store, and vacuously clearing them would restore
 * HEAD over their bytes.
 *
 * RESIDUAL, a REGRESSION on the strict limb, accepted knowingly and narrowed at
 * mantahostels#2421: bytes a neighbour wrote INSIDE a region this session claims are
 * excluded here, a Bash-route write to a claimed file is refused by nothing
 * (docs/agents/guard-registry.md §Conventions; mantahostels#1772 reads nine spellings, plus mantahostels#2854's quoted candidates), and a claim holder
 * mints no observation either (arbiter-observations.js). ownRegionsOffPin
 * catches part of it.
 *
 * COST on `docs/doc-map.md` (790 KB, 480 regions): one `git show` and an
 * in-process comparison, ~18-23 ms. Never a `git hash-object` pair per region,
 * at ~100x that for the same answer (costed on mantahostels#2400).
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {boolean|WritersUnknown} a `WritersUnknown` naming which answer could
 *   not be got, rather than a bare null the caller cannot attribute (mantahostels#2417).
 *   BARE, where otherWritersOn wraps the same alphabet in `{unknown: …}`: this
 *   has one caller, which discriminates on `typeof === "string"` and forwards
 *   the code untouched, so a wrapper would be allocated only to be unwrapped
 *   one line later.
 */
function outsideOwnRegionsMatchHead(rel, sessionId) {
	if (!regions.isRegioned(rel)) return false;
	const locks = readLocks();
	if (locks === null) return "locks";
	const mine = new Set();
	for (const lock of locks) {
		const region = ownRegionOf(lock, rel, sessionId);
		if (region) mine.add(region);
	}
	// gitRaw, not git(): the trimmed form drops the newline the file ends on, and
	// the last region of HEAD would then never equal the last region of the tree
	// (mantahostels#1434, which found that on subjectBlobAt).
	const headText = core.gitRaw(["show", `HEAD:${rel}`]);
	if (headText === null) return "head";
	let treeText;
	try {
		treeText = fs.readFileSync(path.join(core.repoRoot(), rel), "utf8");
	} catch (e) {
		core.logError(`park regions ${rel}`, e);
		return "worktree";
	}
	// parseRegions returns its ranges in file order and they never overlap, so one
	// forward walk splices. An id claimed here takes HEAD's whole text for it at
	// its FIRST range and nothing at the rest, matching regionText, which reads a
	// multi-fragment id — `head`, `section-a` — as one body.
	let spliced = "";
	let cursor = 0;
	const done = new Set();
	for (const r of regions.parseRegions(treeText, rel)) {
		if (!mine.has(r.id)) continue;
		spliced += treeText.slice(cursor, r.start);
		if (!done.has(r.id)) {
			done.add(r.id);
			spliced += regions.regionText(headText, r.id, rel) ?? "";
		}
		cursor = r.end;
	}
	spliced += treeText.slice(cursor);
	return spliced === headText;
}

/**
 * The region of `rel` that `lock` is this session's own claim on, or null.
 * @param {NonNullable<ReturnType<typeof readLocks>>[number]} lock
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {string|null}
 */
function ownRegionOf(lock, rel, sessionId) {
	if (!lock || lock.unreadable || !lock.sessionId) return null;
	if (lock.sessionId !== sessionId) return null;
	const { rel: on, region } = core.splitSubject(lock.path);
	return on === rel && region ? region : null;
}

/**
 * Which regions of `rel` this session holds no longer carry exactly the bytes
 * their own pin records — the backstop under outsideOwnRegionsMatchHead's
 * excluded regions (mantahostels#2421).
 *
 * AN UNANSWERABLE REGION IS NOT A DRIFTED ONE (mantahostels#2429). subjectBlobAt is
 * null on three unlike things — a region gone from the tree, a file that could
 * not be read, and a `hash-object` git would not run. `own-region-drifted`
 * hands over a route PAST the refusal and asks the session to assert the bytes
 * are its own, so an apparatus failure dressed as a claim about bytes buys a
 * destructive act.
 *
 * A region this session holds is excluded from that test by construction, so a
 * NEIGHBOUR who Bash-writes into one lands in the blind spot: nothing refuses
 * that write (mantahostels#1772 reads nine spellings, plus mantahostels#2854's quoted candidates) and a claim holder mints no
 * observation, so both of park's limbs miss it.
 *
 * MOSTLY NOT A FALSE POSITIVE ON THIS SESSION'S OWN EDIT. Both write routes re-pin before park is reached: the tool
 * route mints through cmdRecord on the PostToolUse write hook, and the Bash
 * route at that same Bash call's PostToolUse refresh
 * (`scripts/refresh-claims.sh` -> cmdRefresh -> recordContent, which fans a
 * regioned path out over every region this session holds). park is a LATER Bash
 * call, so it reads a pin already carrying this session's bytes.
 *
 * TWO OWN-WRITE ROUTES SURVIVE THAT and are refused here, both ordinary agent
 * behaviour: a write and the park in ONE compound Bash call, whose refresh runs
 * after both, and a write from a backgrounded job, whose PostToolUse fires at
 * launch rather than at exit. ACCEPTED AND NOT FIXED (mantahostels#2429). Bytes cannot say
 * who wrote them, so nothing here can tell that own edit from the neighbour
 * this test exists to catch; auto-refreshing before the test would absorb the
 * neighbour's bytes too and retire the backstop outright. The refusal hands the
 * session the deliberate re-pin instead — `session-arbiter.js refresh` in a Bash
 * call of its own, then park again — and says that taking it asserts the bytes
 * are its own.
 *
 * AN UNPINNED REGION IS NO INFORMATION AND NEVER BLOCKS. `acquire` mints no
 * blob, so a region claimed and not yet written has none — and this walks EVERY
 * region of the file this session holds, not just the parked subject, so
 * refusing on one would refuse an unrelated park outright. It would also refuse
 * for ever on a machine where the minting hooks fail open (no `jq`, no node, a
 * `timeout 5` expiry).
 *
 * WHAT IT DOES NOT CATCH, and it is most of the window: that same refresh
 * absorbs the neighbour's bytes too. Any Bash call this session makes after
 * their write re-pins the region to what they left, and the backstop goes
 * blind. It catches the neighbour whose write lands between this session's last
 * Bash call and the park.
 *
 * COST: a second `readLocks()` on the one park call that reaches here, and one
 * `git hash-object` per region this session holds — three or four on
 * `docs/doc-map.md` in practice.
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {string[]|WritersUnknown} the drifted region ids in lock order, or
 *   `"region"` where one of them could not be hashed at all
 */
function ownRegionsOffPin(rel, sessionId) {
	const locks = readLocks();
	// Unreachable from park, whose claimHoldersOn has already refused on an
	// unreadable store. Reached anyway, it is no information — and the caller
	// reads an empty array as "nothing drifted".
	if (locks === null) return [];
	const off = [];
	for (const lock of locks) {
		const region = ownRegionOf(lock, rel, sessionId);
		if (!region || !lock.blob) continue;
		const now = subjectBlobAt(lock.path, null);
		if (now === null) return "region";
		if (now !== lock.blob) off.push(region);
	}
	return off;
}

/**
 * Live sessions OTHER than this one whose write to `rel` could still be lost,
 * read off the observation register (mantahostels#363). Null where the register could not
 * be read — never an empty list, which park() must not act on.
 *
 * KNOWN BLIND SPOT, and it is not covered elsewhere: a Bash-route write by a
 * session holding no claim mints an observation only via the post-Bash scan, so
 * a neighbour whose write and whose next Bash call straddle this call does not
 * appear here, and park() has no second answer to fall back on — it would
 * overwrite those bytes. The live claims are consulted as well for that reason,
 * which catches the neighbour who took one (mantahostels#364, mantahostels#392) — and off the refusing
 * tier that is the ordinary tool write, cmdCheck claiming on the watched union.
 * The tool write that took NO claim is covered since mantahostels#2333, which mints on the
 * write itself; on the refusing tier it stays uncovered, the observation route
 * returning null there.
 * BOTH LIMBS CLEAR A COMMITTED NEIGHBOUR, ON DIFFERENT TESTS — the observation
 * limb per record since mantahostels#2352, the lock limb per REGION since mantahostels#2400, and the
 * lock limb clears every holder at once or none. `claimants` is the subset
 * still blocking that holds a claim, which is who `request` can be addressed
 * to.
 *
 * `ownDrift` is the regions ownRegionsOffPin named, and is non-empty ONLY where
 * the lock limb would otherwise have cleared and the observation loop added
 * NOBODY the lock limb had not already named (mantahostels#2429).
 * @param {string} rel
 * @param {string|null} sessionId
 * @returns {{all: string[], claimants: string[], ownDrift: string[]}|{unknown: WritersUnknown}}
 */
function otherWritersOn(rel, sessionId) {
	const entries = observations.observationEntries();
	if (entries === null) return { unknown: "observations" };
	// An observation carries no pid — newObservation names every field it has, and
	// liveness is not one — so the registry is the only oracle here. Unreadable is
	// unknown, never empty: park must not read a dark registry as "nobody else".
	const liveIds = core.liveSessionIds();
	if (liveIds === null) return { unknown: "registry" };
	// The LOCK register too, not observations alone. park() writes the whole file,
	// so a live neighbour holding a sibling region of it is about to lose bytes
	// this session never wrote — and a claimant mints no observation of its own,
	// so the loop below cannot see them.
	const held = claimHoldersOn(rel, sessionId);
	if (held === null) return { unknown: "locks" };
	// THE LOCK LIMB CLEARS ON THE FILE, NOT ON THE HOLDER (mantahostels#2400). No test on a
	// holder's own pin can stand here: a pin is per SUBJECT and park rewrites the
	// whole FILE, so a neighbour whose claimed `### B<n>` entry is committed can
	// still hold uncommitted bytes in a sibling region (mantahostels#2362). Nothing backstops
	// it either: recordObservation returns null for any
	// session holding a lock on the file (arbiter-observations.js), so the loop
	// below never sees a claimant at all.
	//
	// What IS sound is a property of the file, and outsideOwnRegionsMatchHead is
	// it. Anything short of a true there, an unanswerable question included,
	// leaves every holder blocking — as does ownRegionsOffPin, which backstops the
	// regions that test excludes (mantahostels#2421).
	const heldIds = new Set(
		held.flatMap((lock) => (lock.sessionId ? [lock.sessionId] : [])),
	);
	const limb = lockLimb(rel, sessionId, heldIds);
	if (limb.unknown !== null) return { unknown: limb.unknown };
	const { blocking } = limb;
	let { ownDrift } = limb;
	const out = new Set(blocking);
	// A COMMITTED NEIGHBOUR IS NOT AT RISK (mantahostels#2352). An observation is rewritten on
	// every write its session makes to the path and dropped only on a release the
	// session never calls. Where the neighbour's pin is exactly what HEAD holds,
	// their last write is committed: restoring HEAD puts back their own bytes.
	//
	// `committed` is null for a path absent from HEAD and for a git that would not
	// answer, and an unminted record's `blob` is null too — so without the
	// truthiness guard, null === null would clear a live writer on exactly the
	// file nothing can account for.
	//
	// THE COST. The pin is that session's LAST MINT, not what is on disk now, so a
	// neighbour who committed and then wrote through one of the unminted windows
	// listed above is cleared here and their new bytes restored over.
	addObservedWriters(out, entries, { rel, sessionId, liveIds });
	// EVERY holder that is still blocking, cleared above or not. A holder the
	// lock limb cleared can be put straight back by the loop just above, on an
	// observation their own `acquire` never dropped — and the refusal reads
	// `claimants` to decide whether there is anybody to ASK.
	//
	// AND IT YIELDS TO AN OBSERVED WRITER. Where the loop above added somebody the
	// lock limb never named, a neighbour's uncommitted bytes really are in the way
	// and `shared` is the right refusal — the drifted pins are then the lesser of
	// two answers and must not displace it (mantahostels#2429).
	if (ownDrift.length > 0 && [...out].some((id) => !blocking.has(id)))
		ownDrift = [];
	return {
		all: [...out],
		claimants: [...heldIds].filter((id) => out.has(id)),
		ownDrift,
	};
}

/**
 * otherWritersOn's lock limb: the holders still `blocking` once the file
 * outside this session's regions is judged against HEAD, and `ownDrift`, the
 * own regions off their pins — or `unknown` naming the answer not got.
 * @param {string} rel
 * @param {string|null} sessionId
 * @param {Set<string>} heldIds
 * @returns {{unknown: WritersUnknown}|{unknown: null, blocking: Set<string>, ownDrift: string[]}}
 */
function lockLimb(rel, sessionId, heldIds) {
	let blocking = new Set(heldIds);
	// ownDrift stays empty where outsideOwnRegionsMatchHead already refused: the
	// holders are then blocking on bytes outside this session's regions, which is
	// the ordinary `shared` case and nothing to do with the pins.
	let ownDrift = /** @type {string[]} */ ([]);
	if (blocking.size > 0) {
		const settled = outsideOwnRegionsMatchHead(rel, sessionId);
		if (typeof settled === "string") return { unknown: settled };
		if (settled) {
			const off = ownRegionsOffPin(rel, sessionId);
			if (typeof off === "string") return { unknown: off };
			ownDrift = off;
			if (ownDrift.length === 0) blocking = new Set();
		}
	}
	return { unknown: null, blocking, ownDrift };
}

/**
 * otherWritersOn's observation limb: adds to `out` every other live session
 * whose observed write to `rel` is not what HEAD already holds, in register
 * order.
 * @param {Set<string>} out accumulator: each such session's id is added here
 * @param {NonNullable<ReturnType<typeof observations.observationEntries>>} entries
 * @param {{rel: string, sessionId: string|null, liveIds: NonNullable<ReturnType<typeof core.liveSessionIds>>}} on
 */
function addObservedWriters(out, entries, { rel, sessionId, liveIds }) {
	const committed = subjectBlobAt(rel, "HEAD");
	for (const { record } of entries) {
		if (!record || record.path !== rel) continue;
		if (!record.sessionId || record.sessionId === sessionId) continue;
		if (!liveIds.has(record.sessionId)) continue;
		if (committed && record.blob === committed) continue;
		out.add(record.sessionId);
	}
}

/**
 * park's restore of HEAD's bytes over the working tree, at HEAD's mode. A
 * write that fails throws to park.
 *
 * The mode comes from GIT, not from disk: the case that needs it is
 * parking a DELETION, where there is no file to stat and writeFileSync
 * would create at 0666 & ~umask — silently dropping the executable bit off
 * a tracked scripts/*.sh. `git checkout --` restores the index's mode, and
 * this is the equivalent.
 * @param {string} abs
 * @param {string} rel
 * @param {{content: Buffer, mode: number|null}} head
 */
function restoreHeadBytes(abs, rel, head) {
	fs.writeFileSync(abs, head.content);
	if (head.mode === null) return;
	try {
		fs.chmodSync(abs, head.mode);
	} catch (e) {
		// The bytes are right and the claim can still be released; a mode
		// that would not set is worth a log, not a refusal.
		core.logError(`park chmod ${rel}`, e);
	}
}

/**
 * Set this session's unfinished edit aside so the file is clean, and hand back
 * where it went.
 *
 * WHY THIS EXISTS. release() refuses a dirty file, on mantahostels#63: handing the next
 * session an unfinished edit lets them commit it under their own message. That
 * is right, and it leaves a session with no way out of a wait it cannot end —
 * committing is the only thing that cleans the file, and the whole reason a
 * session is stuck may be a gate that refuses the commit (mantahostels#1405, the deadlock
 * with no claim cycle in it). Parking ends the wait without handing anybody
 * anything: the bytes leave the working tree entirely.
 *
 * REFUSES ON DOUBT, every time. A park it cannot justify costs one session a
 * detour; a park that guesses wrong destroys work that was never committed.
 *
 * `writers-unknown` carries an `unknown` field naming which of the registers
 * below could not be read (mantahostels#2417); every other verdict leaves it absent.
 * @param {string} rel
 * @param {Identity} me
 */
function park(rel, me) {
	const writers = otherWritersOn(rel, me?.sessionId);
	if ("unknown" in writers)
		return { verdict: "writers-unknown", unknown: writers.unknown };
	// `claimants` is which of the blockers can be ASKED — the refusal offers the
	// `request` route on it, and says there is nobody to ask when it is empty.
	// TWO REFUSALS OUT OF ONE BLOCK, and which one turns on WHY the holders are
	// still blocking (mantahostels#2429). `ownDrift` non-empty means everything outside this
	// session's own regions is what HEAD holds and no observed writer the lock
	// limb had not already named blocks — the only thing in the way is that a
	// region it claims no longer matches its own pin. Leading on a neighbour
	// would send it to somebody who, on the likelier of the two causes, wrote
	// nothing.
	if (writers.all.length > 0) {
		if (writers.ownDrift.length > 0)
			return {
				verdict: "own-region-drifted",
				regions: writers.ownDrift,
				others: writers.all,
				claimants: writers.claimants,
			};
		return {
			verdict: "shared",
			others: writers.all,
			claimants: writers.claimants,
		};
	}

	const head = headBlob(rel);
	if (head === null) return { verdict: "uncheckable" };

	const abs = path.join(core.repoRoot(), rel);
	let bytes = null;
	try {
		bytes = fs.readFileSync(abs);
	} catch (e) {
		if (caught(e).code !== "ENOENT")
			return { verdict: "unreadable-file", error: e };
	}
	// Nothing on disk and nothing in HEAD is not a dirty file at all.
	if (bytes === null && !head.found) return { verdict: "nothing-to-park" };

	let file = null;
	try {
		fs.mkdirSync(core.paths.parkedDir(), { recursive: true });
		if (bytes !== null) {
			const at = new Date().toISOString().replace(/[:.]/g, "-");
			file = path.join(core.paths.parkedDir(), `${core.keyFor(rel)}-${at}`);
			// The copy lands BEFORE the working tree is touched, so an interruption
			// leaves the edit in two places rather than none.
			fs.writeFileSync(file, bytes);
		}
		if (head.found) restoreHeadBytes(abs, rel, head);
		else if (bytes !== null) fs.unlinkSync(abs);
	} catch (e) {
		core.logError(`park ${rel}`, e);
		return { verdict: "park-failed", error: e, file };
	}
	return { verdict: "parked", file, restored: head.found ? "HEAD" : "removed" };
}

exports.acquire = acquire;
exports.breakCorrupt = breakCorrupt;
exports.breakStale = breakStale;
exports.conflictingLock = conflictingLock;
exports.DEBRIS_AGE_MS = DEBRIS_AGE_MS;
exports.dropClean = dropClean;
exports.dropIfUnchanged = dropIfUnchanged;
exports.forceRelease = forceRelease;
exports.headBlob = headBlob;
exports.headMode = headMode;
exports.heldBy = heldBy;
exports.listLocks = listLocks;
exports.listLocksJudged = listLocksJudged;
exports.liveClaimElsewhereOnFile = liveClaimElsewhereOnFile;
exports.newLock = newLock;
exports.ownLockOnFile = ownLockOnFile;
exports.park = park;
exports.readLocks = readLocks;
exports.release = release;
exports.renameAside = renameAside;
exports.repointLock = repointLock;
exports.restoreAside = restoreAside;
exports.settle = settle;
exports.subjectBlobAt = subjectBlobAt;
exports.sweepDebris = sweepDebris;
exports.sweepRisk = sweepRisk;
exports.takeLock = takeLock;
exports.takeSubjectLock = takeSubjectLock;
exports.TORN_SETTLE_MS = TORN_SETTLE_MS;
exports.updateIfUnchanged = updateIfUnchanged;
exports.whoHolds = whoHolds;
