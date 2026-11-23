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

/**
 * @typedef {object} WantRecord
 * @property {string} sessionId
 * @property {string} wants
 * @property {number|null} pid
 * @property {string|number|null} procStart
 * @property {string} [bootId]
 * @property {string} since
 */

/**
 * @typedef {object} MutexRecord
 * @property {number} pid
 * @property {string|number|null} procStart
 * @property {string} [bootId]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecordObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
const isStringOrNull = (value) => value === null || typeof value === "string";

/** @param {unknown} value */
const isPidOrNull = (value) => value === null || typeof value === "number";

/** @param {unknown} value */
const isProcStartOrNull = (value) =>
	value === null || typeof value === "string" || typeof value === "number";

/** @param {unknown} value */
const isOptionalString = (value) =>
	value === undefined || typeof value === "string";

/**
 * @param {unknown} value
 * @returns {value is {sha: string, at: string|null}}
 */
function isPriorBlob(value) {
	return (
		isRecordObject(value) &&
		typeof value.sha === "string" &&
		isStringOrNull(value.at)
	);
}

/**
 * @param {unknown} record
 * @returns {record is LockRecord}
 */
function isLockRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.path === "string" &&
		isStringOrNull(record.sessionId) &&
		isPidOrNull(record.pid) &&
		isProcStartOrNull(record.procStart) &&
		typeof record.claimedAt === "string" &&
		typeof record.claimId === "string" &&
		isStringOrNull(record.bootId) &&
		isStringOrNull(record.blob) &&
		Array.isArray(record.priorBlobs) &&
		record.priorBlobs.every(isPriorBlob) &&
		isStringOrNull(record.preBlob) &&
		isOptionalString(record.tree)
	);
}

/**
 * @param {unknown} record
 * @returns {record is BreakRecord}
 */
function isBreakRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.path === "string" &&
		isStringOrNull(record.lostBy) &&
		isStringOrNull(record.lostClaimId) &&
		isStringOrNull(record.blob) &&
		isStringOrNull(record.brokenBy) &&
		typeof record.at === "string" &&
		isStringOrNull(record.reportedAt)
	);
}

/**
 * @param {unknown} record
 * @returns {record is ObservationRecord}
 */
function isObservationRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.path === "string" &&
		isStringOrNull(record.sessionId) &&
		typeof record.obsId === "string" &&
		isStringOrNull(record.blob) &&
		typeof record.at === "string" &&
		isOptionalString(record.tree)
	);
}

/**
 * @param {unknown} record
 * @returns {record is IssueClaimRecord}
 */
function isIssueClaimRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.issue === "number" &&
		Number.isInteger(record.issue) &&
		record.issue > 0 &&
		isStringOrNull(record.sessionId) &&
		typeof record.claimedAt === "string"
	);
}

/**
 * @param {unknown} record
 * @returns {record is WantRecord}
 */
function isWantRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.sessionId === "string" &&
		record.sessionId !== "" &&
		typeof record.wants === "string" &&
		record.wants !== "" &&
		isPidOrNull(record.pid) &&
		isProcStartOrNull(record.procStart) &&
		isOptionalString(record.bootId) &&
		typeof record.since === "string"
	);
}

/**
 * @param {unknown} record
 * @returns {record is MutexRecord}
 */
function isMutexRecord(record) {
	return (
		isRecordObject(record) &&
		typeof record.pid === "number" &&
		isProcStartOrNull(record.procStart) &&
		isOptionalString(record.bootId)
	);
}

module.exports = {
	isBreakRecord,
	isIssueClaimRecord,
	isLockRecord,
	isMutexRecord,
	isObservationRecord,
	isRecordObject,
	isWantRecord,
};
