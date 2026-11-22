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
 * @property {string} [tree]
 */

/** @typedef {(LockRecord & { unreadable?: false, alive: boolean }) | { file: string, unreadable: true, reason?: "refused" | "unparseable" }} ListedLock */

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

/** @typedef {{state: "unknown"|"same"|"changed", was: string|null}} ContentState */

/** @typedef {ContentState & {by: string|null}} ContentPin */

/**
 * @typedef {object} ObservationRecord
 * @property {string} path
 * @property {string|null} sessionId
 * @property {string} obsId
 * @property {string|null} blob
 * @property {string} at
 * @property {string} [tree]
 */

/**
 * @typedef {object} IssueClaimRecord
 * @property {number} issue
 * @property {string|null} sessionId
 * @property {string} claimedAt
 */

/**
 * @typedef {object} Identity
 * @property {string|null} sessionId
 * @property {number|null} pid
 * @property {string|number|null} procStart
 * @property {boolean} durable
 */

/** @typedef {{file: string, entry: Record<string, unknown>}} SessionEntry */

/**
 * @typedef {{unreadable: true, reason: "refused"|"unparseable", file: string}} UnreadableRecord
 * @typedef {{sha: string, at: string|null, gone: boolean}} PinnedVersion
 * @typedef {{lock: LockRecord, versions: PinnedVersion[], unreadable?: false}|UnreadableRecord|null} ClaimVersions
 * @typedef {{versions: PinnedVersion[], unreadable?: false}|UnreadableRecord|null} ObservedVersions
 */

/** @typedef {() => {ids?: Set<string>|null, terminal?: Set<string>|null, why?: string|null}} LivenessOracle */

/**
 * @typedef {object} ClaimResult
 * @property {string} verdict
 * @property {LockRecord|null} lock
 * @property {ContentPin} [content]
 * @property {ContentState|null} [observed]
 * @property {BreakRecord|null} [record]
 * @property {string|null} [why]
 * @property {OwnHunks} [own]
 */

/** @typedef {"landed"|"pending"|"unproven"} OwnHunks */

module.exports = {};
