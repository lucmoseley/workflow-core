/*
 * arbiter-store.js — everything the session arbiter keeps on disk, as one name.
 *
 * session-arbiter.js is a CLI that exports nothing (mantahostels#158); this module owns the
 * whole STATE DIRECTORY under CLAUDE_CONFIG_DIR — `locks/`, `debts/`,
 * `writes/` and `guard-errors.log` — plus the sessions registry it reads to tell
 * a live session from a finished one, and the path derivation all of them share.
 *
 * THIS FILE IS A FACADE (mantahostels#1795): one file per record family, re-exported here.
 * A caller wanting ONE family requires that family instead, and learns its
 * handful of names rather than this file's sixty-four:
 *
 *   arbiter-core.js           paths, the one reader and writer, the error log,
 *                             the git shims, the subject vocabulary, the
 *                             sessions registry, the age sweeps
 *   arbiter-records.js        the record shapes, as types only
 *   arbiter-locks.js          the claim registry, and parking an edit
 *   arbiter-content.js        content pins, prior versions, clobber reporting
 *   arbiter-observations.js   the second writer's baseline on detect-only paths
 *   arbiter-snapshots.js      the tier scan, for writes no hook sees
 *   arbiter-bases.js          HEAD at a session's first write to a path, and
 *                             at its start (#110); accept-head and its log (#112)
 *   arbiter-breaks.js         break records, which outlive the lock they broke
 *   arbiter-ledger.js         which paths a session has written, which
 *                             commits it made (#766), which paths its
 *                             inline programs quoted (#1220), and which
 *                             released claims left only others' dirt (#2539)
 *   arbiter-markers.js        the session-suffixed marker files (the repo
 *                             root, except the breadcrumbs — mantahostels#3382)
 *   arbiter-debts.js          the edit a denial abandoned, and who owes it
 *   arbiter-issue-claims.js   which session is working which GitHub issue
 *   arbiter-wants.js          who is blocked on which claim
 *   arbiter-requests.js       asking a live holder for a file
 *   arbiter-sweep.js          the session-start sweep across every family, and
 *                             the blob-pin GC that reads four of them
 *
 * NOTHING UNDER THIS FACADE MAY LOAD lib/check.js (mantahostels#2512). Its module body
 * installs uncaughtException and unhandledRejection handlers ending in
 * `process.exit`, and the arbiter runs inside hooks. So lib/gh.js is off limits
 * here, and lib/gh-limits.js exists to carry the one constant out of it.
 * arbiter-modules.test.ts pins it.
 *
 * THE SPLIT RULE, ONCE. Three families cite each other both ways — a release
 * drops the content pin, and the content recorder reads the lock — so
 * arbiter-locks.js, arbiter-content.js and arbiter-observations.js require each
 * other CYCLICALLY, and two disciplines keep that safe. A sibling family is
 * required as a NAMESPACE and never destructured (`content.contentState(...)`,
 * never `const { contentState } = require(...)`), because a cycle hands back a
 * half-filled exports object; and those three fill that object IN PLACE, one
 * `exports.<name> = <name>` per name, rather than replacing it. The namespace
 * takes the family's own name, suffixed `Mod` only where a local of that name
 * already exists in the requiring file. arbiter-proc.js, project-slug.js,
 * hook-record.js and priced-options-limbs.js are exempt and ARE destructured:
 * each is a leaf outside this set and no cycle can reach any of them.
 * hook-record.js joined at mantahostels#3382, which moved the breadcrumbs off
 * the repo root — arbiter-markers.js asks it where they are rather than keeping
 * a second copy of the path; priced-options-limbs.js at #1474, for the same
 * reason about guard-priced-options.js's prefixes.
 *
 * THE OTHER TWELVE FAMILIES WRITE `module.exports = {...}`, which is what
 * check-code-standards.js's §N7 unconsumed-export scan matches — the
 * `exports.<name> =` form is invisible to it, so the three cyclic files pay
 * that scan's coverage and nothing else does.
 *
 * arbiter-core.js is the one leaf — it requires no family — and arbiter-sweep.js
 * is the one root. Both hold, so a family may be read knowing only core.
 *
 * THE STATE DIRECTORY IS ASKED FOR BY NAME — `stateDir()`, never
 * `path.dirname(errorLog())` (mantahostels#205). That holds for anything filed beside the
 * log, not just the log itself.
 *
 * THE OPERATIONS ARE INTENT-LEVEL, NOT PATH-LEVEL (mantahostels#158 §3). Every temp file,
 * `link(2)`, rename-aside, `utimes` and `wx` flag lives inside these files; no
 * production caller sees one. Not a thin readLock/writeLock store, for
 * exactly that reason — it centralises the `fs` calls without sealing anything.
 *
 * THIS IS PRODUCTION'S INTERFACE (mantahostels#1967, deciding mantahostels#1959 option B; mantahostels#1994, which
 * cut the last five). An operation no production caller reaches THROUGH THIS
 * FILE — `renameAside`, `readRecord` and twenty-seven others, three of them
 * driven inside the families themselves — is reached at the family that defines
 * it, through the namespace arbiter-testkit.ts hands out. mantahostels#159's ask for tests
 * through the module's own interface is met there.
 *
 * NO VERSION FIELD, AND NO STANDING LEGACY READ (#2162). A reader reads the
 * current record shape only. When a shape changes, scan this machine's state
 * files: where no old-shape record exists, the change ships alone; otherwise
 * migrate those files once, then ship it with no fallback for the old shape.
 * A field that is not observed is written as its not-observed value (see
 * holderAlive in arbiter-proc.js), never left for a reader to guess.
 *
 * FAILS OPEN (mantahostels#103 §6), house style: any internal error allows the write and
 * appends to the error log, which check-guard-errors.js reports.
 */

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").ListedLock} ListedLock */
/** @typedef {import("./arbiter-records.js").DebtRecord} DebtRecord */
/** @typedef {import("./arbiter-records.js").BreakRecord} BreakRecord */
/** @typedef {import("./arbiter-records.js").ContentState} ContentState */
/** @typedef {import("./arbiter-records.js").ContentPin} ContentPin */
/** @typedef {import("./arbiter-records.js").ObservationRecord} ObservationRecord */
/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */
/** @typedef {import("./arbiter-records.js").RequestRecord} RequestRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").SessionEntry} SessionEntry */
/** @typedef {import("./arbiter-records.js").DebtEntry} DebtEntry */
/** @typedef {import("./arbiter-records.js").DebtEntries} DebtEntries */
/** @typedef {import("./arbiter-records.js").UnreadableDebt} UnreadableDebt */
/** @typedef {import("./arbiter-records.js").ListedDebt} ListedDebt */
/** @typedef {import("./arbiter-records.js").FailedDebt} FailedDebt */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */
/** @typedef {import("./arbiter-records.js").ClaimResult} ClaimResult */

const bases = require("./arbiter-bases.js");
const breaks = require("./arbiter-breaks.js");
const contentMod = require("./arbiter-content.js");
const core = require("./arbiter-core.js");
const debts = require("./arbiter-debts.js");
const issues = require("./arbiter-issue-claims.js");
const ledger = require("./arbiter-ledger.js");
const locksMod = require("./arbiter-locks.js");
const observations = require("./arbiter-observations.js");
const requests = require("./arbiter-requests.js");
const snapshots = require("./arbiter-snapshots.js");
const sweep = require("./arbiter-sweep.js");
const wants = require("./arbiter-wants.js");

module.exports = {
	acceptHead: bases.acceptHead,
	advanceBases: bases.advanceBases,
	acquire: locksMod.acquire,
	breakNotice: breaks.breakNotice,
	claimVersions: contentMod.claimVersions,
	claimIssue: issues.claimIssue,
	clearDebt: debts.clearDebt,
	// Every config dir on this machine, for a reader of a SIBLING store under
	// them — check-ghost-jobs.js reads `jobs/`, which is not the arbiter's but
	// faces the same multi-plan problem sessionDirs() already solves, and a second
	// copy of that rule would sandbox differently under the proving harness.
	configDirs: core.sessionDirs,
	contentState: contentMod.contentState,
	debtNotice: debts.debtNotice,
	debtsOwnedBy: debts.debtsOwnedBy,
	declineRequest: requests.declineRequest,
	dropRequests: requests.dropRequests,
	dropWant: wants.dropWant,
	dropIfUnchanged: locksMod.dropIfUnchanged,
	errorLog: core.errorLog,
	rootlessErrorLog: core.paths.rootlessErrorLog,
	forceRelease: locksMod.forceRelease,
	gitDirty: core.gitDirty,
	subjectDirty: core.subjectDirty,
	heldBy: locksMod.heldBy,
	heldIssues: issues.heldIssues,
	identify: core.identify,
	isGuarded: core.isGuarded,
	isWatched: core.isWatched,
	isReleasable: core.isReleasable,
	judgeStaged: bases.judgeStaged,
	judgeStagedAll: bases.judgeStagedAll,
	listDebts: debts.listDebts,
	listIssueClaims: issues.listIssueClaims,
	listLocks: locksMod.listLocks,
	listLocksJudged: locksMod.listLocksJudged,
	liveClaimElsewhereOnFile: locksMod.liveClaimElsewhereOnFile,
	logError: core.logError,
	mintSessionBase: bases.mintSessionBase,
	observationState: observations.observationState,
	observedBy: observations.observedBy,
	observedVersions: observations.observedVersions,
	ownDebt: debts.ownDebt,
	park: locksMod.park,
	actsBy: ledger.actsBy,
	commitsBy: ledger.commitsBy,
	committedPathsBy: ledger.committedPathsBy,
	paths: core.paths,
	pruneAll: sweep.pruneAll,
	readDebts: debts.readDebts,
	// Unjudged locks, for a reader that brings its own liveness oracle —
	// check-stranded-file-claims.js asks `claude agents --json` (mantahostels#318).
	readLocks: locksMod.readLocks,
	readRequests: requests.readRequests,
	readWants: wants.readWants,
	recordAct: ledger.recordAct,
	recordCommit: ledger.recordCommit,
	recordContent: contentMod.recordContent,
	recordObservation: observations.recordObservation,
	recordRequest: requests.recordRequest,
	recordSelect: ledger.recordSelect,
	recordWrite: ledger.recordWrite,
	recordWant: wants.recordWant,
	registerDenial: debts.registerDenial,
	relativeToRepo: core.relativeToRepo,
	release: locksMod.release,
	releaseIssue: issues.releaseIssue,
	registryNames: core.registryNames,
	resumedHolderTest: core.resumedHolderTest,
	requestNotice: requests.requestNotice,
	scanChanged: snapshots.scanChanged,
	splitSubject: core.splitSubject,
	stagedModifications: bases.stagedModifications,
	stateDir: core.stateDir,
	subjectFor: core.subjectFor,
	subjectPath: core.subjectPath,
	subjectsOverlap: core.subjectsOverlap,
	sweepRisk: locksMod.sweepRisk,
	sweepDebts: debts.sweepDebts,
	selectsBy: ledger.selectsBy,
	landedBy: ledger.landedBy,
	writesBy: ledger.writesBy,
	whoHolds: locksMod.whoHolds,
	lastWriterOf: ledger.lastWriterOf,
};
