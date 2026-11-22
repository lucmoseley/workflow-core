/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ListedLock} ListedLock */
/** @typedef {import("./arbiter-records.js").BreakRecord} BreakRecord */
/** @typedef {import("./arbiter-records.js").ContentState} ContentState */
/** @typedef {import("./arbiter-records.js").ContentPin} ContentPin */
/** @typedef {import("./arbiter-records.js").ObservationRecord} ObservationRecord */
/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").SessionEntry} SessionEntry */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */
/** @typedef {import("./arbiter-records.js").ClaimResult} ClaimResult */

const breaks = require("./arbiter-breaks.js");
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const issues = require("./arbiter-issue-claims.js");
const ledger = require("./arbiter-ledger.js");
const locksMod = require("./arbiter-locks.js");
const observations = require("./arbiter-observations.js");
const snapshots = require("./arbiter-snapshots.js");
const sweep = require("./arbiter-sweep.js");
const wants = require("./arbiter-wants.js");

module.exports = {
	acquire: locksMod.acquire,
	buildBreakNotice: breaks.buildBreakNotice,
	claimVersions: contentMod.claimVersions,
	claimIssue: issues.claimIssue,
	configDirs: core.sessionDirs,
	contentState: contentMod.contentState,
	dropWant: wants.dropWant,
	errorLog: core.errorLog,
	rootlessErrorLog: core.paths.rootlessErrorLog,
	gitDirty: core.gitDirty,
	subjectDirty: core.subjectDirty,
	readHeldBy: locksMod.readHeldBy,
	readLocksHeldBy: locksMod.readLocksHeldBy,
	subjectDirtyWhereHeld: locksMod.subjectDirtyWhereHeld,
	readHeldClean: locksMod.readHeldClean,
	heldIssues: issues.heldIssues,
	identify: core.identify,
	isWarned: core.isWarned,
	isWatched: core.isWatched,
	isReleasable: core.isReleasable,
	listIssueClaims: issues.listIssueClaims,
	readClaimedIssues: issues.readClaimedIssues,
	listLocks: locksMod.listLocks,
	listLocksJudged: locksMod.listLocksJudged,
	liveClaimElsewhereOnFile: locksMod.liveClaimElsewhereOnFile,
	logError: core.logError,
	observationState: observations.observationState,
	readObservedBy: observations.readObservedBy,
	readObservedEntriesBy: observations.readObservedEntriesBy,
	observedVersions: observations.observedVersions,
	readActsBy: ledger.readActsBy,
	readLastActAt: ledger.readLastActAt,
	readBilledPathsBy: ledger.readBilledPathsBy,
	readCommitsBy: ledger.readCommitsBy,
	paths: core.paths,
	pruneAll: sweep.pruneAll,
	readLocks: locksMod.readLocks,
	readWants: wants.readWants,
	recordAct: ledger.recordAct,
	recordCommit: ledger.recordCommit,
	recordContent: contentMod.recordContent,
	recordObservation: observations.recordObservation,
	recordSelect: ledger.recordSelect,
	recordWrite: ledger.recordWrite,
	recordWant: wants.recordWant,
	claimKey: core.claimKey,
	treeRoot: core.treeRoot,
	recordTree: core.recordTree,
	release: locksMod.release,
	releaseIssue: issues.releaseIssue,
	registryLookup: core.registryLookup,
	registryNames: core.registryNames,
	resumedHolderTest: core.resumedHolderTest,
	scanChanged: snapshots.scanChanged,
	splitSubject: core.splitSubject,
	stateDir: core.stateDir,
	subjectFor: core.subjectFor,
	subjectPath: core.subjectPath,
	subjectsOverlap: core.subjectsOverlap,
	readSelectsBy: ledger.readSelectsBy,
	readLandedBy: ledger.readLandedBy,
	readWritesBy: ledger.readWritesBy,
	readWriteEntriesBy: ledger.readWriteEntriesBy,
	whoHolds: locksMod.whoHolds,
	withGitTimeout: core.withGitTimeout,
	readLastWriterOf: ledger.readLastWriterOf,
};
