/*
 * arbiter-ledger.js — the write ledger — which paths a session has written —
 * the commit ledger, which commits it made (#766), the acts ledger, what else
 * it did on the tracker (#2308), the selection ledger, which paths its
 * inline programs quoted (#1220), and the landed ledger, which released claims
 * left only other sessions' dirt behind (#2539).
 *
 * A ledger outlives its session; the four `prune*Ledgers` are the only
 * things that delete one (mantahostels#137), and age alone is not the test.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./arbiter-core.js");
const { caught } = require("./caught.js");
const { mainCheckout } = require("./main-checkout.js");

// ---------------------------------------------------------------------------
// The write ledger
// ---------------------------------------------------------------------------

// A guess at mantahostels#114. Shortening it re-opens mantahostels#321, which put it at ~14x the p90 time a
// host outlives its finished session (August 2026 sample); raising it closes no gap (mantahostels#137) and only grows the store.
const LEDGER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete the ledgers of sessions that are both finished and old.
 *
 * A live session's ledger is never swept, whatever its age (mantahostels#137). Age alone
 * cannot stand in for finished: mtime is the session's LAST write, and a resumed
 * session keeps its id across a quiet week, so a live session's ledger goes
 * stale while it is still the only record of what that session wrote.
 *
 * RESIDUAL: a live session with no readable entry in ANY sessions registry
 * sessionDirs walks is indistinguishable from a finished one here, so a quiet
 * week still sweeps it. Two populations, not one — a session that has started
 * but not yet registered, and a session registered under a config dir outside
 * sessionDirs (mantahostels#1309). That session takes no claims (see identify)
 * — but it does keep a working ledger, because recordWrite takes its session id
 * from the hook environment and never calls identify().
 *
 * The cost is a MISATTRIBUTION (mantahostels#135), not mantahostels#117's honest index-wide warn.
 * readWritesBy reads the missing file as [] via its ENOENT branch, and an empty
 * ledger matches nothing, so the guard-commit-form core takes its attributed branch and
 * names the session's own files as paths it "never wrote". Accepted anyway
 * (mantahostels#321): the warn is advisory.
 */
function pruneLedgers() {
	core.sweepSparingLive(
		"pruneLedgers",
		core.paths.writesDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.ledger(id)),
	);
}

/**
 * Note that `sessionId` wrote `filePath`.
 * @param {string} filePath
 * @param {string} sessionId
 */
function recordWrite(filePath, sessionId) {
	if (!sessionId) return null;
	// The ledger names FILES, because the guard-commit-form core compares it against
	// staged paths and git stages no region: an unstripped `docs/doc-map.md#B42`
	// matches nothing there, so the session is warned off its own commit.
	const subject = core.relativeToRepo(filePath);
	if (subject === null) return null; // outside the repo; no diff can name it
	// Stripped AFTER the path is made repo-relative, and after the null test: `#`
	// is only a separator on a path the region set names, and that set is written
	// repo-relative, so stripping first would split an absolute subject at
	// neither end — and splitSubject answers "" for a null, which would slip past
	// the test above.
	const rel = core.subjectPath(subject);
	fs.mkdirSync(core.paths.writesDir(), { recursive: true });
	const ledger = core.paths.ledger(sessionId);
	// Sweep only when minting this session's ledger, not on every write: this runs
	// from a PostToolUse hook on every edit in every session, and the directory it
	// sweeps gains one ledger a session.
	if (!fs.existsSync(ledger)) pruneLedgers();
	// Append, never read-modify-write: several tool calls can land at once and an
	// append of one short line is atomic enough for a ledger read as a set.
	fs.appendFileSync(ledger, `${rel}\n`);
	noteLandedRewrite(rel, sessionId);
	return rel;
}

/**
 * Every path this session wrote, deduplicated — or `null` where the answer is
 * unavailable rather than empty (mantahostels#135).
 *
 * An empty list tells a caller "this session wrote nothing", which
 * the guard-commit-form core reads as *every staged path is someone else's* — so
 * returning it when the ledger could not be read names the session's own files
 * back at it.
 * @param {string} sessionId
 */
function readWritesBy(sessionId) {
	if (!sessionId) return null;
	// ENOENT is read as the empty answer: recordWrite mints the ledger on the
	// session's first write, so a session that has written nothing has no file
	// — and that is most sessions, so failing here would put them all on the
	// index-wide warn and restore mantahostels#117's undifferentiated one.
	//
	// That equivalence holds only because pruneLedgers() spares a session it
	// can prove is still running (mantahostels#137).
	return readLedger(core.paths.ledger(sessionId), `writes ${sessionId}`);
}

// ---------------------------------------------------------------------------
// The selection ledger (#1220)
// ---------------------------------------------------------------------------

function pruneSelectLedgers() {
	core.sweepSparingLive(
		"pruneSelectLedgers",
		core.paths.selectsDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.selectLedger(id)),
	);
}

/**
 * Note that an inline `python`/`node` program `sessionId` ran quoted `rel`, at
 * `at` ms. NOT a write record: the program may only have read it, so nothing
 * that bills a session reads this ledger — test selection alone does.
 *
 * STAMPED, unlike the write ledger, so the reader can drop a quote older than
 * the path's last commit: a path this session only read is otherwise its own
 * for good, and a neighbour's later unclaimed edit to it would ride into this
 * session's overlay.
 * @param {string} rel repo-relative
 * @param {string} sessionId
 * @param {number} [at]
 */
function recordSelect(rel, sessionId, at = Date.now()) {
	if (!sessionId || !rel) return null;
	fs.mkdirSync(core.paths.selectsDir(), { recursive: true });
	const ledger = core.paths.selectLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneSelectLedgers();
	fs.appendFileSync(ledger, `${rel}\t${String(at)}\n`);
	return rel;
}

/**
 * Every path `recordSelect` noted for this session, each with its NEWEST
 * stamp — or null where the ledger would not read. A line with no stamp reads
 * as 0, older than any commit.
 * @param {string} sessionId
 * @returns {{ path: string, at: number }[]|null}
 */
function readSelectsBy(sessionId) {
	if (!sessionId) return null;
	const lines = readLedger(
		core.paths.selectLedger(sessionId),
		`selects ${sessionId}`,
	);
	if (lines === null) return null;
	/** @type {Map<string, number>} */
	const newest = new Map();
	for (const line of lines) {
		const tab = line.lastIndexOf("\t");
		const rel = tab < 0 ? line : line.slice(0, tab);
		const at = tab < 0 ? 0 : Number(line.slice(tab + 1)) || 0;
		newest.set(rel, Math.max(newest.get(rel) ?? 0, at));
	}
	return [...newest].map(([rel, at]) => ({ path: rel, at }));
}

// ---------------------------------------------------------------------------
// The landed ledger (#2539)
// ---------------------------------------------------------------------------

function pruneLandedLedgers() {
	core.sweepSparingLive(
		"pruneLandedLedgers",
		core.paths.landedDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.landedLedger(id)),
	);
}

/**
 * Note that `sessionId` released its claim on `rel` with none of its own hunks
 * left in the file — ownHunksState's proof, or its `--not-mine` word — and
 * other sessions' dirt still there.
 * @param {string} rel
 * @param {string} sessionId
 */
function recordLanded(rel, sessionId) {
	if (!sessionId || !rel) return null;
	fs.mkdirSync(core.paths.landedDir(), { recursive: true });
	const ledger = core.paths.landedLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneLandedLedgers();
	fs.appendFileSync(ledger, `released\t${rel}\n`);
	return rel;
}

/**
 * recordWrite's note that `rel` holds the session's work again, where its
 * landed ledger exists — the one route every tool write and credited Bash
 * write takes, so no other record need be asked whether it wrote since.
 * @param {string} rel
 * @param {string} sessionId
 */
function noteLandedRewrite(rel, sessionId) {
	const ledger = core.paths.landedLedger(sessionId);
	if (fs.existsSync(ledger)) fs.appendFileSync(ledger, `wrote\t${rel}\n`);
}

/**
 * The paths this session released with only other sessions' dirt left, and
 * has not written since — each path's LAST line is its release. Null where the
 * ledger would not read.
 * @param {string} sessionId
 * @returns {Set<string>|null}
 */
function readLandedBy(sessionId) {
	if (!sessionId) return null;
	const lines = readLines(
		core.paths.landedLedger(sessionId),
		`landed ${sessionId}`,
	);
	if (lines === null) return null;
	/** @type {Map<string, string>} */
	const last = new Map();
	for (const line of lines) {
		const tab = line.indexOf("\t");
		last.set(line.slice(tab + 1), line.slice(0, tab));
	}
	return new Set([...last].filter(([, e]) => e === "released").map(([p]) => p));
}

/**
 * A ledger's lines, deduplicated; [] where the file does not exist, and null
 * — logged — where it would not read.
 * @param {string} file
 * @param {string} what the log line's label
 * @returns {string[]|null}
 */
function readLedger(file, what) {
	const lines = readLines(file, what);
	return lines && [...new Set(lines)];
}

/**
 * readLedger, every line kept.
 * @param {string} file
 * @param {string} what
 * @returns {string[]|null}
 */
function readLines(file, what) {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		core.logError(what, e);
		return null;
	}
}

/**
 * The session whose write ledger names `rel` and was written last, live or
 * finished, as `{sessionId, at}` — or null where no surviving ledger names it.
 * `sessionId` is the ledger's filename stem, which is the id for every id the
 * harness mints today. A ledger that will not read is passed over: this answers
 * "who last touched it", for a report, never an ownership test (#813).
 * @param {string} rel
 * @returns {{sessionId: string, at: number}|null}
 */
function readLastWriterOf(rel) {
	let entries;
	try {
		entries = fs.readdirSync(core.paths.writesDir());
	} catch {
		return null;
	}
	/** @type {{sessionId: string, at: number}|null} */
	let best = null;
	for (const name of entries) {
		if (!name.endsWith(".txt")) continue;
		const file = path.join(core.paths.writesDir(), name);
		const lines = readLedger(file, `writes ${name}`);
		if (!lines?.includes(rel)) continue;
		let at;
		try {
			at = fs.statSync(file).mtimeMs;
		} catch {
			continue; // swept between the read and the stat
		}
		if (!best || at > best.at) best = { sessionId: name.slice(0, -4), at };
	}
	return best;
}

// ---------------------------------------------------------------------------
// The commit ledger (#766)
// ---------------------------------------------------------------------------

/**
 * Note that `sessionId` made `commit`.
 * @param {string} commit a full sha
 * @param {string} sessionId
 * @returns {boolean} whether it was recorded
 */
function recordCommit(commit, sessionId) {
	if (!sessionId || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
	fs.mkdirSync(core.paths.commitsDir(), { recursive: true });
	const ledger = core.paths.commitLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneCommitAndActLedgers();
	fs.appendFileSync(ledger, `${commit}\n`);
	return true;
}

/**
 * pruneLedgers, for the commit and acts ledgers together — and on its test,
 * for its reason. One sweep, so a session's acts never outlive its commits or
 * the other way round (#2308).
 * @param {string} [root] the repo whose store to sweep; this one's by default
 */
function pruneCommitAndActLedgers(root) {
	core.sweepSparingLive(
		"pruneCommitAndActLedgers",
		core.paths.commitsDir(root),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.commitLedger(id, root)),
	);
	core.sweepSparingLive(
		"pruneActLedgers",
		core.paths.actsDir(root),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.actLedger(id, root)),
	);
}

/**
 * Every commit this session made, oldest first — or `null` where the ledger
 * would not read, which a caller must not take for "made none".
 * @param {string} sessionId
 * @param {string} [root] the repo whose store to read; this one's by default
 * @returns {string[]|null}
 */
function readCommitsBy(sessionId, root) {
	if (!sessionId) return null;
	// ENOENT reads as "made none" for readWritesBy's reason, and holds only while
	// pruneCommitAndActLedgers spares a live session.
	return readLedger(
		core.paths.commitLedger(sessionId, root),
		`commits ${sessionId}`,
	);
}

/**
 * Every path a commit in this session's commit ledger touched, deduplicated —
 * or `null` where the ledger or git would not read. A session that edits only
 * through an inline interpreter writes no write-ledger line, so its commits are
 * the one record that bills it its review (#2390). A ledgered commit git no
 * longer has is passed over, as diff-tree --stdin does. A merge lists only
 * the paths it differs from every parent on (`--cc`), its own conflict
 * resolutions: against either parent alone it carries the other side's work,
 * a neighbour's included, and over-billing is the unsafe direction.
 * @param {string} sessionId
 * @returns {string[]|null}
 */
function readCommittedPathsBy(sessionId) {
	const commits = readCommitsBy(sessionId, ledgerRoot() ?? undefined);
	if (commits === null) return null;
	if (commits.length === 0) return [];
	const out = core.gitIn(
		[
			"-c",
			"core.quotePath=false",
			"diff-tree",
			"--stdin",
			"--root",
			"-r",
			"--cc",
			"--name-only",
			"--no-commit-id",
		],
		`${commits.join("\n")}\n`,
	);
	if (out === null) return null;
	return [...new Set(out.split("\n").filter(Boolean))];
}

/**
 * Every path this session wrote or its own commits touched: what a review is
 * billed against (#2390), read alike by session-arbiter.js's `writes
 * --committed` for the bash review nags and by lib/review-tier-host.js for the
 * tier (#2971). `null` where the write ledger will not read; where the commits
 * will not, it logs the fault under the caller's label and answers the writes
 * alone, under-billing being the safe direction.
 * @param {string} sessionId
 * @param {string} what the log line's label
 * @returns {string[]|null}
 */
function readBilledPathsBy(sessionId, what) {
	const written = readWritesBy(sessionId);
	if (written === null) return null;
	const fromCommits = readCommittedPathsBy(sessionId);
	if (fromCommits === null)
		core.logError(
			what,
			new Error(`commit ledger or git unreadable for ${sessionId}`),
		);
	return [...new Set([...written, ...(fromCommits ?? [])])];
}

// ---------------------------------------------------------------------------
// The acts ledger (#2308)
// ---------------------------------------------------------------------------

/* What a session did beside committing, as `<kind> <owner/name>#<n>`, a
 * relabel adding ` takes:<x>`; a block is a blocked-by edge added (#2464). A commit is no line here: the commit ledger
 * already holds it. */
const ACT_LINE =
	/^(?:block|close|file|round) [\w.-]+\/[\w.-]+#\d+$|^relabel [\w.-]+\/[\w.-]+#\d+ takes:\S+$/;

/**
 * Note that `sessionId` did `act`, one line per act, never deduplicated: two
 * rounds posted on one issue are two acts. Kept under the main worktree's
 * store, as post-commit keeps the commit ledger.
 * @param {string} act e.g. `close lucmoseley/workflow-core-tracker#12`
 * @param {string} sessionId
 * @param {string} [root] the repo whose store to write; the main worktree's by default
 * @returns {boolean} whether it was recorded
 */
function recordAct(act, sessionId, root = ledgerRoot() ?? undefined) {
	if (!sessionId || !ACT_LINE.test(act)) return false;
	fs.mkdirSync(core.paths.actsDir(root), { recursive: true });
	const ledger = core.paths.actLedger(sessionId, root);
	if (!fs.existsSync(ledger)) pruneCommitAndActLedgers(root);
	fs.appendFileSync(ledger, `${act}\n`);
	return true;
}

/**
 * Every act `sessionId` made across `roots`' stores, its commits read as
 * `commit <sha>` — and the roots whose acts or commit ledger would not read,
 * which a caller must not take for "did nothing there". A missing ledger is
 * an empty one, for readWritesBy's reason.
 * @param {string} sessionId
 * @param {string[]} roots each a repo's main worktree
 * @returns {{acts: string[], unreadable: string[]}}
 */
function readActsBy(sessionId, roots) {
	if (!sessionId) return { acts: [], unreadable: [...roots] };
	/** @type {string[]} */
	const acts = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const root of roots) {
		const done = readLines(
			core.paths.actLedger(sessionId, root),
			`acts ${sessionId}`,
		);
		const commits = readCommitsBy(sessionId, root);
		if (done === null || commits === null) unreadable.push(root);
		acts.push(...(done ?? []), ...(commits ?? []).map((c) => `commit ${c}`));
	}
	return { acts, unreadable };
}

/**
 * The main worktree, under whose state directory `.husky/post-commit` keeps the
 * commit ledgers — or null where git will not say, or where the common dir
 * names no checkout.
 * @returns {string|null}
 */
function ledgerRoot() {
	return mainCheckout(core.repoRoot());
}

/**
 * The session whose commit ledger names each of `commits` (#1154's rule), as a
 * map holding only the commits some surviving ledger names — or `null` where
 * the ledger directory would not read. A ledger that will not read is passed
 * over, so its commits read as unledgered.
 * @param {string[]} commits full shas
 * @param {string} [root] the repo whose store to read; this one's by default
 * @returns {Map<string, string>|null}
 */
function readOwnersOf(commits, root) {
	const dir = core.paths.commitsDir(root);
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch (e) {
		if (caught(e).code === "ENOENT") return new Map();
		core.logError("readOwnersOf", e);
		return null;
	}
	const wanted = new Set(commits);
	/** @type {Map<string, string>} */
	const owners = new Map();
	for (const name of entries) {
		if (!name.endsWith(".txt")) continue;
		const shas = readLedger(path.join(dir, name), `commits ${name}`);
		for (const sha of shas ?? [])
			if (wanted.has(sha) && !owners.has(sha))
				owners.set(sha, name.slice(0, -4));
	}
	return owners;
}

module.exports = {
	readActsBy,
	readBilledPathsBy,
	readCommitsBy,
	readLandedBy,
	ledgerRoot,
	readOwnersOf,
	readLastWriterOf,
	recordAct,
	recordCommit,
	recordLanded,
	recordSelect,
	recordWrite,
	readSelectsBy,
	readWritesBy,
};
