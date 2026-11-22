/*
 * arbiter-records.js — the record shapes, once.
 *
 * Types only: this module exports nothing at runtime. Each shape mirrors the
 * factory that mints it — `newLock` in arbiter-locks.js, `newBreak` in
 * arbiter-breaks.js, `newObservation` in arbiter-observations.js,
 * `newIssueClaim` in arbiter-issue-claims.js — so a field added there is added here. `readRecord` hands back `JSON.parse`'s
 * `any`, so a record read off disk flows into any of these unchecked; the types
 * bind the writers.
 */

/**
 * @typedef {object} LockRecord
 * @property {string} path
 * @property {string|null} sessionId
 * @property {number|null} pid
 * @property {string|number|null} procStart
 * @property {string} claimedAt
 * @property {string} claimId
 * @property {string|null} bootId
 * @property {string|null} blob
 * @property {{sha: string, at: string|null}[]} priorBlobs
 * @property {string|null} preBlob
 * @property {string} [tree] the holder's tree where it is a linked worktree
 */

/**
 * `reason` rides the unreadable arm only. readLocks() always sets it, but it
 * stays optional so a caller can build that arm without one.
 * @typedef {(LockRecord & { unreadable?: false, alive: boolean }) | { file: string, unreadable: true, reason?: "refused" | "unparseable" }} ListedLock
 */

/**
 * @typedef {object} BreakRecord
 * @property {string} path
 * @property {string|null} lostBy
 * @property {string|null} lostClaimId
 * @property {string|null} blob
 * @property {string|null} brokenBy
 * @property {string} at
 * @property {string|null} reportedAt
 */

/**
 * What a path holds now against what its claim recorded.
 * @typedef {{state: "unknown"|"same"|"changed", was: string|null}} ContentState
 */

/**
 * A content state plus the claim the pin was taken against. `by` is not always
 * the lock handed back with it: a `contended` release returns the REPLACEMENT
 * lock, whose holder never wrote these bytes.
 * @typedef {ContentState & {by: string|null}} ContentPin
 */

/**
 * @typedef {object} ObservationRecord
 * @property {string} path
 * @property {string|null} sessionId
 * @property {string} obsId
 * @property {string|null} blob
 * @property {string} at
 * @property {string} [tree] the observer's tree where it is a linked worktree
 */

/**
 * @typedef {object} IssueClaimRecord
 * @property {number} issue
 * @property {string|null} sessionId
 * @property {string} claimedAt
 */

/**
 * Who is asking — identify()'s answer, and the `me` every write path takes.
 * @typedef {object} Identity
 * @property {string|null} sessionId
 * @property {number|null} pid
 * @property {string|number|null} procStart
 * @property {boolean} durable
 */

/**
 * One entry in the sessions registry. JSON someone else wrote, so every field
 * is untrusted and read defensively.
 * @typedef {{file: string, entry: Record<string, unknown>}} SessionEntry
 */

/**
 * A record on disk that would not open — so a pull-mode reader can say the
 * record is THERE and unreadable rather than that no record exists (mantahostels#2382).
 * `reason` is readLocks's own two-word vocabulary; `file` is the full path,
 * where readLocks's same-named field is a basename.
 * @typedef {{unreadable: true, reason: "refused"|"unparseable", file: string}} UnreadableRecord
 *
 * One version a pin still names, and the two halves `versions` prints: the
 * claim's chain, and the observation's single entry.
 * @typedef {{sha: string, at: string|null, gone: boolean}} PinnedVersion
 * @typedef {{lock: LockRecord, versions: PinnedVersion[], unreadable?: false}|UnreadableRecord|null} ClaimVersions
 * @typedef {{versions: PinnedVersion[], unreadable?: false}|UnreadableRecord|null} ObservedVersions
 */

/**
 * lib/agent-liveness.js's contract: asked at most once, and only where its
 * answer decides something.
 * `terminal` is the subset of `ids` the oracle has marked done, failed or
 * stopped. Optional: an oracle that omits it is read as claiming no ending.
 * @typedef {() => {ids?: Set<string>|null, terminal?: Set<string>|null, why?: string|null}} LivenessOracle
 */

/**
 * What every claim, release and force answers with. `verdict` is the whole
 * answer; the rest is evidence only the verdict that carries it reads.
 * @typedef {object} ClaimResult
 * @property {string} verdict
 * @property {LockRecord|null} lock
 * @property {ContentPin} [content]
 * @property {ContentState|null} [observed]
 * @property {BreakRecord|null} [record]
 * @property {string|null} [why]
 * @property {OwnHunks} [own] on a whole-file `dirty` or `released`
 */

/**
 * Whether a holder's own hunks of a dirty file have landed (workflow-core#2148):
 * arbiter-locks.js's ownHunksState.
 * @typedef {"landed"|"pending"|"unproven"} OwnHunks
 */

module.exports = {};
