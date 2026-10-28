/*
 * arbiter-core.js — the record-file primitives every family is built on.
 *
 * Where the state directory lives (`paths`), the one reader and the one writer
 * (`readRecord`, `writeRecord`, `probeRecord`), the fail-open error log, the git
 * shims, the subject vocabulary the guards speak (`splitSubject`, `isGuarded`,
 * `isWatched`), the sessions registry that tells a live session from a finished
 * one, and the age sweeps the families share.
 *
 * CORE REQUIRES NO FAMILY. It is the one leaf of the graph, so a family may be
 * read knowing only this file.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { configDir } = require("./config-dir.js");
const { gitAnswer } = require("./git.js");
const regions = require("./doc-map-regions.js");
const { holderAlive, readProcStartOf } = require("./arbiter-proc.js");
const { projectSlug, UNRESOLVED_ROOT_SLUG } = require("./project-slug.js");
const { realKey } = require("./deref.js");
const { hostRoot } = require("./host-root.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").SessionEntry} SessionEntry */
/** @typedef {import("./arbiter-records.js").UnreadableRecord} UnreadableRecord */

// ---------------------------------------------------------------------------
// Where everything lives
// ---------------------------------------------------------------------------

/**
 * What WFC_CLAUDE_CONFIG_A, _B and _C fall back to, in that order.
 *
 * Not a Claude Code convention: `.claude2` and `.claude3` are THIS machine's
 * second and third Claude plans.
 * @type {readonly [string, string, string]}
 */
const DEFAULT_CONFIG_DIR_NAMES = [".claude", ".claude2", ".claude3"];

/**
 * EVERY config dir whose sessions registry counts as this machine's — this
 * session's own first, then the others, deduped by realpath (mantahostels#1309).
 *
 * `CLAUDE_CONFIG_DIR` scopes the sessions registry, and this machine runs three
 * Claude plans under three of them. A sweep reading only its own would read
 * every session registered under another as FINISHED. The state directory is
 * NOT per seat: every seat's sessions keep it under the first seat
 * (`storeConfigDir()`, #383), so a claim taken on one is seen on all.
 *
 * WFC_CLAUDE_CONFIG_A / _B / _C name the set, EACH FALLING BACK ON ITS OWN,
 * with no fallback to the pre-rename MANTA_CLAUDE_CONFIG_* (#277). The agents
 * oracle reads this same set (lib/agent-liveness.js, #3512).
 *
 * DERIVED FROM configDir(), NOT FROM HOME: siblings of the config dir land
 * inside the test sandbox and siblings of the real home do not (configDir()
 * above). On the real machine the two agree — CLAUDE_CONFIG_DIR is a direct
 * child of HOME.
 *
 * RESIDUAL: a fourth config dir, named by no env var and not a sibling called
 * `.claude`, `.claude2` or `.claude3`, is still invisible — its sessions read as
 * finished exactly as before.
 */
function sessionDirs() {
	const out = [];
	const seen = new Set();
	for (const dir of [configDir(), ...seatCandidates()]) {
		const key = realKey(dir);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(dir);
	}
	return out;
}

/**
 * The three seats, first seat first, before any dedupe.
 * @returns {[string, string, string]}
 */
function seatCandidates() {
	const parent = path.dirname(configDir());
	const [a, b, c] = DEFAULT_CONFIG_DIR_NAMES;
	return [
		process.env.WFC_CLAUDE_CONFIG_A || path.join(parent, a),
		process.env.WFC_CLAUDE_CONFIG_B || path.join(parent, b),
		process.env.WFC_CLAUDE_CONFIG_C || path.join(parent, c),
	];
}

/**
 * The config dir the arbiter's state lives under: the FIRST seat, for a session
 * on any seat (#378, built at #383), so all three share one store and one lock
 * directory.
 *
 * A CONFIG DIR THAT IS NO SEAT KEEPS ITS OWN. A test pointing CLAUDE_CONFIG_DIR
 * at a mkdtemp dir would otherwise write into that dir's `.claude` sibling —
 * shared `/tmp/.claude`, outside every sandbox, and one store for every
 * parallel suite.
 *
 * RESIDUAL: nothing exports WFC_CLAUDE_CONFIG_A today. A scratch dir that
 * happens to be named `.claude2` or `.claude3`, under an exported _A, would
 * write into _A.
 */
function storeConfigDir() {
	return isSeat(configDir()) ? seatCandidates()[0] : configDir();
}

/*
 * THE HOST REPO, through the one seam (#1). `lib/host-root.js` holds the
 * contract — CLAUDE_PROJECT_DIR, else the git top level of the working
 * directory, symlinks dereferenced, memoised per cwd, failing open to the cwd —
 * and `lib/guard-root.sh`'s gr_root is its bash twin. The trailing-slash strip
 * and the dereference live in the seam because stateDir() turns this into a
 * directory NAME: `/repo/` slugs to `-repo-` and `/repo` to `-repo`, two state
 * directories for one tree, and a fail-open filed under the wrong one is a
 * fail-open check-guard-errors.js never looks at.
 *
 * NOT `__dirname`-derived: in a plugin install this file sits in the plugin
 * cache, so a script-relative root files claims in a tree the report that reads
 * them never looks in.
 */
function repoRoot() {
	if (gitBound.ms === undefined) return hostRoot();
	gitBound.root ??= hostRoot(process.cwd(), {
		timeoutMs: gitBound.ms,
		onTimeout: markOverrun,
	});
	return gitBound.root;
}

/**
 * NOT the repo, which is what `CLAUDE_PROJECT_DIR` names — hence `stateDir` and
 * not `projectDir`. Its path is Claude Code's own project-directory spelling of
 * the repo root, which `project-slug.js` owns (mantahostels#1982).
 *
 * DELIBERATELY NOT MEMOISED, though mantahostels#1775 asked for it: a memo here prevents no
 * fork, because it must call repoRoot() to build its own key before it could
 * consult a cache.
 */
function stateDir() {
	return stateDirFor(repoRoot());
}

/** @param {string} root */
const stateDirFor = (root) =>
	path.join(storeConfigDir(), "projects", projectSlug(root));

/** @param {string} [root] the host root where the caller already holds it */
const stateDirOf = (root) => (root ? stateDirFor(root) : stateDir());

/** @param {string} dir */
const isSeat = (dir) =>
	seatCandidates().some((s) => realKey(s) === realKey(dir));

/**
 * A record's filename, for locks and debts alike.
 * @param {string} rel
 */
function keyFor(rel) {
	return crypto.createHash("sha256").update(rel).digest("hex").slice(0, 16);
}

/**
 * An id spelled safely as part of a filename. Sanitised because it arrives from
 * a tool payload or an old record, and it is indexing a filename.
 * @param {string} id
 */
const idSlug = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * A filename for a record keyed by a path AND something else — a broken claim, a
 * session.
 *
 * The id goes LAST, so every record belonging to one session shares a filename
 * suffix and a reader can find its own without opening any of the others
 * (readObservedBy, mantahostels#419).
 * @param {string} rel
 * @param {string} id
 */
function pairFile(rel, id) {
	return `${keyFor(rel)}-${idSlug(id)}.json`;
}

/**
 * The suffix every record `id` owns ends in. Pairs with pairFile.
 * @param {string} id
 */
const pairSuffix = (id) => `-${idSlug(id)}.json`;

const paths = {
	repoRoot,
	stateDir,
	sessionsDir: () => path.join(configDir(), "sessions"),
	/** Every registry readSessionEntries walks — this session's own, and its neighbours'. */
	sessionDirs: () => sessionDirs().map((d) => path.join(d, "sessions")),

	// Outside the working tree deliberately (mantahostels#103): an in-repo registry would
	// itself appear in `git status --porcelain` and so manufacture the
	// dirty-and-unclaimed readings the mechanism consumes.
	locksDir: () => path.join(stateDir(), "locks"),
	debtsDir: () => path.join(stateDir(), "debts"),

	/**
	 * What a broken claim left behind (mantahostels#349). Not in `locks/`: a lock is a live
	 * hold and sweepDebris matches on that directory's names, while a break record
	 * outlives every lock it describes.
	 */
	breaksDir: () => path.join(stateDir(), "breaks"),

	/**
	 * What a session that is NOT a path's claimant last wrote to it (mantahostels#363). Not in
	 * `locks/`: an observation confers no hold, and one path carries as many of
	 * them as there are sessions writing it.
	 */
	observationsDir: () => path.join(stateDir(), "observations"),

	/**
	 * What each session is BLOCKED ON, written at denial time (mantahostels#1195).
	 *
	 * One file per SESSION, not per path: a session sits on one refusal at a
	 * time, and the newest is the one it is actually waiting behind. Keyed the
	 * other way round a waiter would accumulate a record per path it ever tried,
	 * and a cycle walk could not tell which one it is stuck on now.
	 */
	wantsDir: () => path.join(stateDir(), "wants"),

	/**
	 * Courtesy release requests (mantahostels#1702, built at mantahostels#1782): *session X wants
	 * `<path>`, which you hold*. Keyed by (path, requester) via pairFile, like
	 * observations/ — one path carries a request from every session asking.
	 */
	requestsDir: () => path.join(stateDir(), "requests"),
	/**
	 * The FILE keys the record even for a region subject — the caller normalises
	 * through subjectPath — so a whole-file release finds a region request and a
	 * region release finds a whole-file one.
	 * @param {string} rel
	 * @param {string} requester
	 */
	request: (rel, requester) =>
		path.join(paths.requestsDir(), pairFile(rel, requester)),

	/**
	 * Unfinished edits set aside by `release --park` (mantahostels#1405). Outside the working
	 * tree, like everything else here: a parked copy inside the repo would show up
	 * in `git status` as exactly the dirty file it was parked to remove.
	 */
	parkedDir: () => path.join(stateDir(), "parked"),

	/**
	 * The write ledger: which paths THIS session actually wrote (mantahostels#114).
	 *
	 * Separate from the lock registry, deliberately, on two counts that make the
	 * locks unusable as an attribution source:
	 *
	 *   SCOPE. A lock is only ever taken on a WATCHED path; the ledger has to
	 *   attribute a write to any file at all (mantahostels#96).
	 *
	 *   LIFETIME. A claim ends at its holder's release or clean commit (#2058),
	 *   or at the latest when its process does. The backstop reads at Stop,
	 *   asking a question about the whole session, so it needs a record that
	 *   survives a broken lock.
	 */
	writesDir: () => path.join(stateDir(), "writes"),

	/**
	 * The selection ledger (#1220): paths an inline `python`/`node` program
	 * QUOTED, which test selection credits to the session and nothing else
	 * reads. Separate from `writes/` because a quoted path may only have been
	 * read, and mantahostels#114 bars billing one.
	 */
	selectsDir: () => path.join(stateDir(), "selects"),

	/**
	 * The landed ledger (#2539): each claim this session released with only
	 * other sessions' dirt left in the file, and each write it made there since,
	 * which test selection reads to stop carrying that dirt as its own.
	 */
	landedDir: () => path.join(stateDir(), "landed"),

	/**
	 * The commit ledger: which commits THIS session made (#766), for
	 * guard-unpushed-commits.js. `root` names the repo whose store to read, where
	 * it is not this one's.
	 * @param {string} [root]
	 */
	commitsDir: (root) => path.join(stateDirOf(root), "commits"),

	/**
	 * The acts ledger: what else THIS session did — closed, filed, asked,
	 * relabelled, blocked (#2308, #2464). Read beside the commit ledger, and pruned with it.
	 * @param {string} [root]
	 */
	actsDir: (root) => path.join(stateDirOf(root), "acts"),

	/** @param {string} rel */
	lock: (rel) => path.join(paths.locksDir(), `${keyFor(rel)}.json`),

	/**
	 * A session id is a uuid, so it is already a safe filename — but it arrives
	 * from argv and from hook JSON, so it is filtered rather than trusted: an id
	 * carrying a slash would otherwise name a file outside the register.
	 * @param {string} sessionId
	 */
	want: (sessionId) =>
		path.join(
			paths.wantsDir(),
			`${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "")}.json`,
		),

	/**
	 * A debt is keyed by (path, issue), not by path (mantahostels#327): two sessions denied on
	 * the same file own two different edits, and one entry per path meant the
	 * second `debt own` silently replaced the first.
	 *
	 * `issue` null is the stub a denial writes, of which one per path is enough.
	 * @param {string} rel
	 * @param {number|string|null} [issue]
	 */
	debt: (rel, issue = null) =>
		path.join(
			paths.debtsDir(),
			`${keyFor(rel)}-${issue === null ? "unowned" : issue}.json`,
		),

	/**
	 * Keyed by (path, session): the pair a second writer's baseline belongs to.
	 * @param {string} rel
	 * @param {string} sessionId
	 */
	observation: (rel, sessionId) =>
		path.join(paths.observationsDir(), pairFile(rel, sessionId)),

	/**
	 * What the watched tiers held at this session's last Bash call (mantahostels#419) — the
	 * only thing a scan can diff against to say a Bash-route write happened.
	 */
	snapshotsDir: () => path.join(stateDir(), "snapshots"),
	/** @param {string} sessionId */
	snapshot: (sessionId) =>
		path.join(paths.snapshotsDir(), `${idSlug(sessionId)}.txt`),

	/**
	 * What HEAD held for a path at this session's first write to it (#110) — the
	 * base #100's stale-write-back gate judges a commit against.
	 */
	basesDir: () => path.join(stateDir(), "bases"),
	/**
	 * @param {string} rel
	 * @param {string} sessionId
	 */
	base: (rel, sessionId) =>
		path.join(paths.basesDir(), pairFile(rel, sessionId)),
	/** Each session's `accept-head` log (#112): the reverts it declared intentional. */
	acceptedHeadsDir: () => path.join(stateDir(), "accepted-heads"),
	/** @param {string} sessionId */
	acceptedHeads: (sessionId) =>
		path.join(paths.acceptedHeadsDir(), `${idSlug(sessionId)}.jsonl`),
	/** HEAD at each session's start: the base for a path with none of its own. */
	sessionBasesDir: () => path.join(stateDir(), "session-bases"),
	/** @param {string} sessionId */
	sessionBase: (sessionId) =>
		path.join(paths.sessionBasesDir(), `${idSlug(sessionId)}.json`),

	/**
	 * Keyed by (path, broken claim), so a path broken twice keeps both records —
	 * and both pins, which are what each break's recovery sha lives on.
	 * @param {string} rel
	 * @param {string} claimId
	 */
	break: (rel, claimId) => path.join(paths.breaksDir(), pairFile(rel, claimId)),

	/**
	 * Which session is working which GitHub issue (mantahostels#645). Keyed by (issue,
	 * session), and by the issue NUMBER rather than a hash of it, so one issue's
	 * records are found by a filename prefix without opening any other.
	 * `root` reads another checkout's store, for a parent issue there (#2310).
	 * @param {string} [root]
	 */
	issueClaimsDir: (root) => path.join(stateDirOf(root), "issue-claims"),
	/**
	 * @param {number|string} issue
	 * @param {string} sessionId
	 */
	issueClaim: (issue, sessionId) =>
		path.join(paths.issueClaimsDir(), `${issue}${pairSuffix(sessionId)}`),

	/**
	 * Session ids are uuids, but they arrive from a tool payload and index a filename.
	 * @param {string} sessionId
	 */
	ledger: (sessionId) =>
		path.join(paths.writesDir(), `${idSlug(sessionId)}.txt`),
	/** @param {string} sessionId */
	selectLedger: (sessionId) =>
		path.join(paths.selectsDir(), `${idSlug(sessionId)}.txt`),
	/** @param {string} sessionId */
	landedLedger: (sessionId) =>
		path.join(paths.landedDir(), `${idSlug(sessionId)}.txt`),
	/**
	 * @param {string} sessionId
	 * @param {string} [root]
	 */
	commitLedger: (sessionId, root) =>
		path.join(paths.commitsDir(root), `${idSlug(sessionId)}.txt`),
	/**
	 * @param {string} sessionId
	 * @param {string} [root]
	 */
	actLedger: (sessionId, root) =>
		path.join(paths.actsDir(root), `${idSlug(sessionId)}.txt`),

	/** @param {string} [root] the host root where the caller already holds it */
	errorLog: (root) => path.join(stateDirOf(root), "guard-errors.log"),
	/**
	 * Where lib/guard-log.sh files a record when it can resolve NO REPO ROOT at
	 * all (mantahostels#2438). Named here rather than derived from errorLog() by two
	 * `path.dirname` calls, which arbiter-store.js's header forbids (mantahostels#205): a
	 * level added to stateDir() would silently send that reader one directory too
	 * high.
	 */
	rootlessErrorLog: () =>
		path.join(
			storeConfigDir(),
			"projects",
			UNRESOLVED_ROOT_SLUG,
			"guard-errors.log",
		),
	droppedLog: () => path.join(stateDir(), "dropped-debts.log"),
	/**
	 * One line per commit-paths.js run: its outcome and the seconds it waited on
	 * the index lock, for a census of whether the 180 s ceiling is right (#585).
	 * Not guard-errors.log, which check-guard-errors.js reads as fail-opens.
	 * Unrotated: one ~40-byte line a commit, so it has not earned log-rotate.js.
	 */
	commitPathsLog: () => path.join(stateDir(), "commit-paths.log"),
};

// ---------------------------------------------------------------------------
// The one reader and the one writer
// ---------------------------------------------------------------------------

/**
 * A stored record, or null — ABSENT and TORN only.
 *
 * A read the filesystem REFUSED (EACCES on the store directory, EIO) throws:
 * unreadable must not look like empty (mantahostels#174, and mantahostels#135's ruling on the write
 * ledger before it).
 *
 * Torn stays null deliberately. A half-written record is what a concurrent
 * claimant looks like mid-write, and acquire() retries on it rather than
 * declaring the store broken.
 * @param {string} file
 */
function readRecord(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null; // never written, or swept already
		throw e;
	}
	try {
		const record = JSON.parse(text);
		return record && typeof record === "object" ? record : null;
	} catch {
		return null; // torn: another writer is mid-record
	}
}

/**
 * readRecord's answer with its two nulls told apart: {state, record}, state
 * being "ok", "absent" (never written, or swept) or "unparseable".
 *
 * For the callers that act on the difference (mantahostels#1691). Throws on a refused read,
 * exactly as readRecord does.
 * @param {string} file
 */
function probeRecord(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return { state: "absent", record: null };
		throw e;
	}
	try {
		const record = JSON.parse(text);
		return record && typeof record === "object"
			? { state: "ok", record }
			: { state: "unparseable", record: null };
	} catch {
		return { state: "unparseable", record: null };
	}
}

/**
 * readRecord for the callers that must survive one bad file — a sweep, a
 * listing, the sessions registry. The refusal is LOGGED rather than swallowed.
 * @param {string} file
 * @param {string} where
 */
function readRecordOrLog(file, where) {
	try {
		return readRecord(file);
	} catch (e) {
		logError(where, e);
		return null;
	}
}

/**
 * readRecordOrLog for a PULL-MODE reader that has to tell "nothing here" from
 * "would not read" — `{record}` where the file read, `record` being null where
 * it was never written, and `{unreadable: true, reason, file}` where the
 * filesystem refused it (`reason: "refused"`) or its bytes will not parse
 * (`"unparseable"`). Why a second shape rather than widening readRecordOrLog:
 * mantahostels#2382.
 *
 * TORN IS RE-PROBED, on readLocks's discriminator. Without the pause a record a
 * neighbour is mid-write on reads as a fault.
 *
 * `pause` is a parameter rather than a default because `settle` lives in
 * arbiter-locks.js, which requires THIS file: core cannot reach back for it.
 * @param {string} file
 * @param {string} where
 * @param {() => void} pause
 * @returns {{record: any, unreadable?: false}|UnreadableRecord} `record` is
 * `any` because JSON.parse is: the types bind the writers, never a record read
 * back off disk (arbiter-records.js's header).
 */
function readRecordOrFlag(file, where, pause) {
	/** @param {boolean} settled */
	const probe = (settled) => {
		let p;
		try {
			p = probeRecord(file);
		} catch (e) {
			logError(where, e);
			return {
				unreadable: /** @type {const} */ (true),
				reason: /** @type {const} */ ("refused"),
				file,
			};
		}
		if (p.state !== "unparseable") return { record: p.record };
		if (!settled) return null; // torn, or corrupt — the pause tells them apart
		// Logged only once settled, so a writer caught mid-record never files a
		// fault against a store that is fine.
		logError(where, new Error(`record will not parse: ${file}`));
		return {
			unreadable: /** @type {const} */ (true),
			reason: /** @type {const} */ ("unparseable"),
			file,
		};
	};
	const first = probe(false);
	if (first) return first;
	pause();
	return /** @type {{record: any}|UnreadableRecord} */ (probe(true));
}

/** @param {object} body */
const buildRecordText = (body) => `${JSON.stringify(body)}\n`;

/**
 * `flag: "wx"` refuses an existing file; every other caller overwrites.
 * @param {string} file
 * @param {object} body
 * @param {import("node:fs").WriteFileOptions} [options]
 */
function writeRecord(file, body, options = {}) {
	fs.writeFileSync(file, buildRecordText(body), options);
}

/**
 * Create `file` holding `body`, failing when one already exists: true where
 * this call created it, false where a record already stood.
 *
 * link(2) is the primitive: it is atomic and refuses an existing target, so of
 * any number of simultaneous creators exactly one wins. writeFile with 'wx'
 * would do on a local filesystem but not over the network mounts WSL2 exposes.
 * @param {string} file
 * @param {object} body
 */
function createOnce(file, body) {
	const tmp = path.join(
		path.dirname(file),
		`.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
	);
	writeRecord(tmp, body);
	try {
		fs.linkSync(tmp, file);
		return true;
	} catch (e) {
		if (caught(e).code === "EEXIST") return false;
		throw e;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the link succeeded or the write never landed */
		}
	}
}

// ---------------------------------------------------------------------------
// The error log — the only thing that breaks fail-open's silence
// ---------------------------------------------------------------------------

function errorLog() {
	return paths.errorLog();
}

/**
 * One log line, whatever is in the value.
 *
 * The log is TSV and the reader splits on tab and newline, so a file path
 * carrying either would split into fields the reader drops for having no
 * parseable timestamp — the record of a fault erased by the name of the file it
 * happened to. Paths arrive from the tool payload, so they are not ours to trust.
 * @param {unknown} value
 */
function flat(value) {
	return String(value).replace(/[\t\r\n]+/g, " ");
}

/**
 * @param {string} where
 * @param {unknown} err
 * @param {string} [detail] the record's fourth field (#320), flattened as the
 *   third is
 * @param {string} [root] the host root, where the caller already resolved it:
 *   a hook whose own bounded root read timed out would otherwise re-run it
 *   unbounded here (#3038)
 */
function logError(where, err, detail, root) {
	try {
		/* A thrown value is whatever was thrown, so the stack is read off the
		 * shape rather than assumed: a STRING `stack` on an object, and nothing
		 * else. The `typeof` limb is what keeps a `{stack: null}` — what a JSON
		 * round-trip of an Error leaves behind, and this store reads its own JSON
		 * — from logging the literal "null" where `err?.stack` logged the value.
		 * Anything else with a non-string `stack` now falls back to the value
		 * too, where `err?.stack` either read it or threw (mantahostels#1460).
		 *
		 * INSIDE the try, because `stack` is an accessor on a V8 Error and a
		 * `prepareStackTrace` that throws would otherwise escape into the caller
		 * — and the whole point of this function is that logging a failure never
		 * becomes one.
		 */
		const stack =
			typeof err === "object" &&
			err !== null &&
			"stack" in err &&
			typeof err.stack === "string"
				? err.stack
				: "";
		const file = paths.errorLog(root);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(
			file,
			`${new Date().toISOString()}\t${flat(where)}\t${flat(stack ? stack.split("\n")[0] : String(err))}${detail ? `\t${flat(detail)}` : ""}\n`,
		);
	} catch {
		// Nothing to do: logging this failure has the same failure mode.
	}
}

/**
 * Log a fault that recurs on every guarded write, at most once per session.
 *
 * Whether a session can be identified does not change while it runs, so logging
 * it per write appends thousands of identical lines to the file whose whole job
 * is to be short enough that someone reads it — and check-guard-errors.js injects
 * what it reads into every session's start-up context.
 *
 * The marker lives in `locks/` even though a marker is not a lock: sweepDebris
 * already matches `.said-` alongside `.tmp-` and `.json.stale-`, so the
 * placement buys the hourly clean-up for free (mantahostels#158 §3).
 * @param {string|null} sessionId
 * @param {string} where
 * @param {string} message
 */
function sayOnce(sessionId, where, message) {
	if (!firstSay(sessionId, message)) return;
	logError(where, message);
}

/**
 * sayOnce's dedup, without its logging: true the first time this session is
 * told `message`, false every time after.
 * @param {string|null} sessionId
 * @param {string} message
 */
function firstSay(sessionId, message) {
	// "no-session", never process.pid: a fresh process runs per guarded write, so
	// a pid key would mint a new marker every write — per-write logging restored
	// for exactly the sessionless case this exists to bound.
	const key = crypto
		.createHash("sha256")
		.update(`${sessionId || "no-session"}\0${message}`)
		.digest("hex")
		.slice(0, 16);
	try {
		fs.mkdirSync(paths.locksDir(), { recursive: true });
		fs.writeFileSync(path.join(paths.locksDir(), `.said-${key}`), "", {
			flag: "wx",
		});
	} catch (e) {
		// The marker's own EEXIST, never mkdir's: that one is a locks path that
		// is not a directory, which has said nothing (#855).
		if (
			caught(e).code === "EEXIST" &&
			e instanceof Error &&
			"syscall" in e &&
			e.syscall === "open"
		)
			return false; // already said
		// Any other failure: say it anyway. A repeated line beats a lost one.
	}
	return true;
}

// ---------------------------------------------------------------------------
// The repo the claims are about
// ---------------------------------------------------------------------------

/**
 * Paths the arbiter covers, in two tiers (mantahostels#287). mantahostels#103 ruled a prefix rule, not
 * a hand-listed hot set. The measurement behind the split is mantahostels#287.
 *
 *   REFUSING. A write to a file another live session holds is denied. Files
 *   that coordinate work, where git's merge machinery has nothing to merge.
 *
 *   DETECT_ONLY. Nothing is ever refused; a claim only records what the file
 *   held, so a clobber is caught after the fact (the recorder is mantahostels#295).
 *   scripts/ is here because that is where the measured risk lives, while the
 *   cost of refusing there is unmeasured.
 *
 * EXEMPT names the paths inside either tier that are outside the arbiter
 * entirely.
 */
const REFUSING = ["docs/", ".claude/", "CLAUDE.md", "AGENTS.md"];
const DETECT_ONLY = ["scripts/"];

/**
 * Paths inside a tier that the arbiter does not cover at all: neither refused
 * nor watched, no claim taken, no content record, no debt reported.
 *
 * `.claude/tmp/` is the repo's one sanctioned scratch directory (mantahostels#2089,
 * `docs/environment.md` §12), and it falls under `.claude/`, so every scratch
 * write took a claim nobody released (mantahostels#2053).
 *
 * The test for membership is that the directory's contents are sanctioned
 * throwaway. A file destined for `docs/research/` is not throwaway and keeps
 * its own lifecycle (`docs/agents/issue-tracker.md` §Research artefacts).
 */
const EXEMPT = [".claude/tmp/"];

/**
 * Repo-relative, or null when the path is outside the repo entirely.
 * @param {string} filePath
 */
function relativeToRepo(filePath) {
	const root = repoRoot();
	const rel = path.relative(root, path.resolve(root, filePath));
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

/*
 * A CLAIM SUBJECT is a repo-relative path, optionally with a `#<region>` tail:
 * `docs/doc-map.md#B42`. mantahostels#848 ruled the claim gets finer than the file, and
 * mantahostels#970 built it — the subject is how that finer claim is spelled everywhere the
 * store already spoke of a path.
 *
 * The tail rides INSIDE the string rather than as a parameter threaded through
 * thirty functions, so a lock, a debt, an observation and every message that
 * names one are region-aware for free: keyFor() hashes the whole subject, so
 * two regions of one file take two lock files, and `list` and `debt list` print
 * the region because the record's own `path` carries it.
 *
 * The price is that every function reaching the FILESYSTEM must strip it first
 * — git cannot stat `docs/doc-map.md#B42`. Each strips at its own head, through
 * `subjectPath`.
 */

/** @param {string} subject */
function splitSubject(subject) {
	const whole = String(subject ?? "");
	const at = whole.indexOf("#");
	// `#` is a legal character in a filename, so it is a separator ONLY where the
	// part before it is a path that takes region claims at all. Without this test
	// a real `docs/plan#1.md` is read as region `1.md` of a file `docs/plan`,
	// and every filesystem call below then runs against a path that does not
	// exist.
	if (at === -1 || !regions.isRegioned(whole.slice(0, at)))
		return { rel: whole, region: null };
	return { rel: whole.slice(0, at), region: whole.slice(at + 1) || null };
}

/**
 * The file a subject names, region tail discarded.
 * @param {string} subject
 */
function subjectPath(subject) {
	return splitSubject(subject).rel;
}

/**
 * A subject spelled from its parts — the inverse of splitSubject.
 * @param {string} rel
 * @param {string|null} region
 */
function subjectFor(rel, region) {
	return region ? `${rel}#${region}` : rel;
}

/**
 * Whether two subjects can contend at all — the one conflict rule (mantahostels#970),
 * spelled once: same file, and regions tile, so two DIFFERENT named regions
 * never touch while a whole-file subject touches every region. arbiter-locks'
 * whoHolds applies it for acquire and every arbiter report; the request
 * register scopes its drops and declines with it (mantahostels#1782).
 * @param {string} a
 * @param {string} b
 */
function subjectsOverlap(a, b) {
	const x = splitSubject(a);
	const y = splitSubject(b);
	if (x.rel !== y.rel) return false;
	return x.region === y.region || x.region === null || y.region === null;
}

/**
 * @param {string[]} prefixes
 * @param {string} rel
 */
const under = (prefixes, rel) =>
	prefixes.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));

/**
 * The refusing tier: the only paths a write is ever denied on.
 * @param {string} rel
 */
function isGuarded(rel) {
	const p = subjectPath(rel);
	return under(REFUSING, p) && !under(EXEMPT, p);
}

/**
 * Either tier — what a claim is recorded against, refused or not.
 * @param {string} rel
 */
function isWatched(rel) {
	const p = subjectPath(rel);
	if (under(EXEMPT, p)) return false;
	return under(REFUSING, p) || under(DETECT_ONLY, p);
}

/**
 * Whether a claim on this path can be given back — the watched union, PLUS the
 * exempt paths, which take no new claim but may still carry one minted before
 * the exemption landed (mantahostels#2053).
 *
 * Release gates on this rather than on isWatched() because a path dropped out
 * of both tiers would otherwise have its standing claim frozen: `release` and
 * `release --force` would both return 0 having done nothing, and the
 * stranded-claim report would name it for ever.
 * @param {string} rel
 */
function isReleasable(rel) {
	const p = subjectPath(rel);
	// isWatched strips again, harmlessly: subjectPath is idempotent.
	return isWatched(p) || under(EXEMPT, p);
}

/* The ceiling on each git call through git, gitIn and gitRaw, and on
 * repoRoot's, none outside withGitTimeout; the root read once under it; and
 * whether a call has overrun, after which the rest answer null at once, so a
 * hung git costs one ceiling and not one per claim (#2891). */
let gitBound = {
	/** @type {number | undefined} */ ms: undefined,
	/** @type {string | undefined} */ root: undefined,
	overran: false,
};

function markOverrun() {
	gitBound.overran = true;
}

/**
 * `fn`'s answer with the store's git calls under it bounded at `ms`, and
 * whether one overran — the caller then holds an answer built on unknowns
 * and says so. For a hook, whose own limit a hung git would otherwise reach.
 * @template T
 * @param {number} ms
 * @param {() => T} fn
 * @returns {{ value: T, overran: boolean }}
 */
function withGitTimeout(ms, fn) {
	const prior = gitBound;
	gitBound = { ms, root: undefined, overran: false };
	try {
		const value = fn();
		return { value, overran: gitBound.overran };
	} finally {
		gitBound = prior;
	}
}

/**
 * git's stdout in the repo, or null where it could not answer: gitOrNull's
 * nulls, and every call once one has overrun gitBound.
 * @param {string[]} args
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding">} [opts]
 * @returns {string | null}
 */
function boundedGit(args, opts = {}) {
	if (gitBound.overran) return null;
	const cwd = repoRoot();
	if (gitBound.overran) return null;
	const { out, timedOut } = gitAnswer(args, {
		cwd,
		...opts,
		timeout: gitBound.ms,
	});
	if (timedOut) markOverrun();
	return out;
}

/**
 * Run git in the repo, or null where it could not answer — no git, not a repo,
 * a non-zero exit. Every caller here treats null as "unknown", never as an answer.
 * @param {string[]} args
 */
function git(args) {
	return boundedGit(args)?.trim() ?? null;
}

/**
 * git, fed `input` on stdin — how a REGION's bytes reach the object store, which
 * has no path to hash them from. Same null-is-unknown contract as git().
 * @param {string[]} args
 * @param {string} input
 */
function gitIn(args, input) {
	return (
		boundedGit(args, {
			input,
			stdio: ["pipe", "pipe", "ignore"],
		})?.trim() ?? null
	);
}

/**
 * git, verbatim — the same null-is-unknown contract as git(), minus the trim.
 *
 * git() trims, which strips the newline the file ends on, so the last region of
 * HEAD's copy would never equal the last region of the working tree's and every
 * release of it would refuse (mantahostels#1434).
 *
 * Each caller reads a whole file at a revision, so an ENOBUFS past git.js's cap
 * returns null silently, which subjectDirty reads as "not clean" and debtSubject
 * as "keep the exact key".
 * @param {string[]} args
 */
function gitRaw(args) {
	return boundedGit(args);
}

/**
 * Uncommitted changes on `rel`: true, false, or null when git could not say.
 *
 * The dirty-and-unclaimed warning treats it as "not dirty" — it is advisory, and a
 * git failure must not manufacture a warning about work nobody can see.
 * subjectDirty, which release goes through, treats it as "not clean" and refuses,
 * because a release it cannot justify costs only today's behaviour, while one it
 * should not have made hands the claim over with the holder's edit still in it.
 * @param {string} rel
 */
function gitDirty(rel) {
	// WHOLE-FILE even for a region subject: `git status` answers per file. Anything
	// judging a CLAIM rather than a file asks subjectDirty() instead (mantahostels#1434).
	const out = git(["status", "--porcelain", "--", subjectPath(rel)]);
	return out === null ? null : out !== "";
}

/**
 * Uncommitted changes on the thing a SUBJECT names — the claimed region's own
 * bytes where it names one, the whole file where it does not. True, false, or
 * null when the question could not be answered.
 *
 * WHY NOT gitDirty (mantahostels#1434). mantahostels#63's rule
 * (an incident in its closing comment — its title names other work) — releasing
 * a dirty claim hands the next holder your unfinished edit to commit under their
 * own message — is region-scoped too: it is YOUR region being dirty that
 * endangers the next holder of YOUR region, and a file-level test on a document
 * this contended pins every region on a neighbour's edit forever.
 *
 * BY CONTENT, NOT BY LINE RANGE. A neighbour's insert above your region shifts
 * its line numbers without touching a byte of it, so the comparison is between
 * the region parseRegionText() locates by heading in a revision and the region it
 * locates by the same heading in HEAD.
 *
 * THREE REVISIONS, NOT TWO: HEAD, the working tree AND the index. The index is
 * repo-global here (docs/agents/guard-registry.md §Conventions), so a region staged and then
 * reverted in the working tree reads byte-identical to HEAD on disk while the
 * index still holds the change — and the next holder's commit sweeps it in under
 * their own message, which is exactly the mantahostels#63 harm.
 *
 * Every way of not knowing falls back to the whole-file test rather than to a
 * pass: no HEAD, no index entry, an unreadable file, a git that would not run.
 * @param {string} subject
 */
function subjectDirty(subject) {
	const { rel, region } = splitSubject(subject);
	if (!region) return gitDirty(rel);
	const head = gitRaw(["show", `HEAD:${rel}`]);
	const staged = gitRaw(["show", `:${rel}`]);
	if (head === null || staged === null) return gitDirty(rel);
	let worktree;
	try {
		worktree = fs.readFileSync(path.join(repoRoot(), rel), "utf8");
	} catch {
		return gitDirty(rel);
	}
	const committed = regions.parseRegionText(head, region, rel);
	for (const revision of [worktree, staged]) {
		const mine = regions.parseRegionText(revision, region, rel);
		// In NEITHER revision: the subject names a region this document does not
		// have. CLEAN, not unknown — it has no bytes to hand the next holder, so
		// mantahostels#63's harm cannot happen, and refusing would wedge the claim permanently.
		// Reached whenever a §A row's path is renamed and committed, so not dead.
		if (mine === null && committed === null) continue;
		if (mine === null || committed === null) return true;
		if (mine !== committed) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// The sessions registry — who is running, and on what process
// ---------------------------------------------------------------------------

/**
 * Every parsed entry in EVERY sessions registry this machine has (sessionDirs),
 * as `{ file, entry }`, or `null` where one of them could not be read.
 *
 * Shared by identify() and liveSessionIds(), which agree on how to walk the
 * registry and differ only on what they conclude from an entry — so the shape of
 * the registry is read in one place, not two that must be changed together.
 *
 * An absent registry is no entries, not `null`: nothing was ever registered
 * there, which is an answer, and it is the ordinary reading of a machine running
 * one plan rather than two. A single file that will not parse is skipped rather
 * than fatal, or one truncated entry would hide every other session on the
 * machine.
 *
 * `mode` PICKS THE FAILURE DIRECTION, because `null` does not mean one thing to
 * every caller. A sweep reads it as delete-nothing and holds off; the lock-break
 * path reads it as no-evidence-of-life and goes AHEAD, breaking the lock (mantahostels#104,
 * which ruled an unbreakable lock the worse failure). So a single rule would
 * make a neighbour registry's permissions cost a live session its claim.
 *
 * - `"all"` (the default, for liveSessionIds and its four sweeps) needs the union
 *   COMPLETE: one unreadable registry makes the whole read `null`, and the sweep
 *   deletes nothing (mantahostels#1309 priced a partial union against a documented single
 *   read).
 * - `"own"` (identify) reads this session's own config dir alone. A session's
 *   entry is always written under its own CLAUDE_CONFIG_DIR, so the neighbours
 *   cannot tell it anything about itself, and identify() is the one caller on the
 *   per-write hot path. It is lenient about a neighbour that will not read, so
 *   widening the dirs would spend the walk, not disarm identify().
 * - `"best-effort"` (the lock-break path) takes every registry that reads and
 *   drops the rest, so a neighbour's failure can only ever ADD evidence of life,
 *   never withdraw it. The own registry keeps the old contract — unreadable is
 *   `null` — so the break path fails open exactly as it did before mantahostels#1309.
 */
function readSessionEntries(mode = "all") {
	// sessionDirs puts this session's own dir first, which is what lets the
	// best-effort walk hold the own registry to the stricter rule.
	const dirs = mode === "own" ? [paths.sessionsDir()] : paths.sessionDirs();
	/** @type {RegistryEntry[]} */
	const out = [];
	for (const [i, dir] of dirs.entries()) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (caught(e).code === "ENOENT") continue;
			if (mode === "all" || i === 0) return null;
			continue;
		}
		pushDirEntries(dir, names, out);
	}
	return out;
}

/** @typedef {{ file: string, entry: NonNullable<ReturnType<typeof readRecord>> }} RegistryEntry */

/**
 * Appends to `out` each readable `.json` registry entry among `names` in `dir`,
 * in listing order, as `readSessionEntries` returns them.
 * @param {string} dir
 * @param {string[]} names
 * @param {RegistryEntry[]} out accumulator: each readable entry is pushed here
 */
function pushDirEntries(dir, names, out) {
	for (const file of names) {
		if (!file.endsWith(".json")) continue;
		// Silent on a single refused entry, unlike the lock store (mantahostels#174): this runs
		// from identify() on every guarded write, so one permanently unreadable
		// entry file would append a line per write to the error log. The case is
		// already surfaced once per session by identify()'s sayOnce below.
		let entry;
		try {
			entry = readRecord(path.join(dir, file));
		} catch {
			continue;
		}
		// The full path, not the basename: registry files are named <pid>.json and
		// both plans share one pid namespace, so a bare name does not say which
		// file identify()'s diagnostic is complaining about.
		if (entry) out.push({ file: path.join(dir, file), entry });
	}
}

/**
 * The session ids the machine can still prove are running.
 *
 * Read once per sweep rather than calling identify() per ledger: identify()
 * logs whenever it cannot place a session, so a loop over aged ledgers would
 * write a guard-errors line per file and drown the faults that log exists for.
 *
 * `null` where the registry could not be read: nothing can be called dead, so
 * the caller must delete nothing.
 *
 * Not the oracle a lock uses, and deliberately so (mantahostels#321). A lock freezes pid and
 * procStart into the lock record at claim time; this re-resolves the session id
 * against the registry on every sweep, and counts the session live if ANY of its
 * entries is. So a resume — which re-keys a session onto a fresh host, leaving
 * the old entry behind — cannot make a live session read dead here, though it
 * does exactly that to a lock (mantahostels#322). Do not unify the two.
 */
function readLiveSessionIds() {
	const entries = readSessionEntries();
	if (entries === null) return null;
	const live = new Set();
	for (const { entry } of entries) {
		if (!entry.sessionId || !entry.pid) continue;
		// No procStart means liveness is unproveable either way. identify() treats
		// that as not-alive, because a lock minted on it would wedge a file for
		// good; deletion is the worse error here, so it counts as live.
		if (
			!entry.procStart ||
			readProcStartOf(entry.pid) === String(entry.procStart)
		)
			live.add(entry.sessionId);
	}
	return live;
}

/**
 * The live registry entry for `sessionId` — `{pid, procStart}` — or null where
 * nothing can prove that session is running.
 *
 * A lock freezes pid and procStart at claim time, so a resume — which keeps the
 * session id but hands it a fresh host process — leaves a lock naming a pid that
 * is genuinely gone while its holder is genuinely alive (mantahostels#322). Re-resolving the
 * id against the registry is what tells the two apart. It runs where a lock has
 * already read dead — the break path, and the non-durable branch of takeLock
 * (mantahostels#359) — never on every write.
 *
 * Not identify() with the holder's id, which walks the same entries: identify()
 * says so in the log when it finds none, and that sentence — "this session
 * takes no claims and its files are unprotected" — is false and alarming about
 * a NEIGHBOUR's dead session, which is the ordinary case here.
 *
 * A registry that cannot be read is not evidence either way, and the caller goes
 * ahead: an unbreakable lock is the one failure mantahostels#104 ruled worse than an
 * over-eager break, since nothing later can clear it — logged when it happens.
 * @param {string|null} sessionId
 * @param {Identity} me
 */
function readLiveEntryFor(sessionId, me) {
	if (!sessionId) return null;
	// Best-effort: this null would break the lock, not hold off (mantahostels#1309).
	const entries = readSessionEntries("best-effort");
	if (entries === null) {
		sayOnce(
			me.sessionId,
			"claim",
			"the sessions registry could not be read, so a stale lock cannot be " +
				"tested for a holder that was resumed onto a new process — this write " +
				"goes ahead as before, which can take a file from a live session",
		);
		return null;
	}
	return liveEntryIn(entries, sessionId);
}

/**
 * The same lookup over registry entries already in hand, without the log — for
 * readers that walk many locks at once, or that are not deciding a write.
 *
 * `entry.procStart` ONLY, never a fresh /proc read as a fallback; identify()
 * carries the reasoning for that rule.
 * @param {SessionEntry[]} entries
 * @param {string|null} sessionId
 */
function liveEntryIn(entries, sessionId) {
	if (!sessionId) return null;
	for (const { entry } of entries) {
		if (entry.sessionId !== sessionId || !entry.pid || !entry.procStart)
			continue;
		/* The last place either field can be tested before `repointLock` writes
		 * both into a lock, so a pid that was a string is stored as the number
		 * `LockRecord` promises. */
		const pid = Number(entry.pid);
		const { procStart } = entry;
		if (typeof procStart !== "string" && typeof procStart !== "number")
			continue;
		if (readProcStartOf(pid) === String(procStart)) return { pid, procStart };
	}
	return null;
}

/**
 * A test for "was this lock's holder resumed onto a process other than the one
 * it recorded?", for a reader judging a whole directory of locks at once.
 *
 * holderAlive() reads a RESUMED session — same id, fresh host process — as dead,
 * because the lock froze pid and procStart at claim time (mantahostels#322). The registry is
 * what tells that apart from a holder that really ended.
 *
 * The walk is not free (mantahostels#322 priced it), so the returned test reads the registry
 * at most ONCE however many locks it judges, and not until it is first called.
 * Ask it only after holderAlive() has said no.
 *
 * A registry that cannot be read is no evidence of life: false, never a wedge.
 * It says so once (mantahostels#174 — fail open, never silently), in `dark`'s words.
 *
 * That `false` is right for a WRITE, which must not wedge every file on an
 * unreadable registry, and wrong for a REPORT, where "unknown" costs the caller
 * nothing (#271). So the test carries a `registryUnreadable()` reader: true
 * once the registry has been asked for and would not open, false before it has
 * been asked at all.
 *
 * NOT the `dark` parameter above, which is the warning's WORDS.
 * @param {string} where
 * @param {string} dark
 */
function resumedHolderTest(where, dark) {
	/** @type {SessionEntry[]|null|undefined} */
	let entries;
	const test = (/** @type {string|null} */ sessionId) => {
		if (entries === undefined) {
			// Best-effort for readLiveEntryFor's reason: this test's `false` breaks a lock.
			entries = readSessionEntries("best-effort");
			if (entries === null) logError(where, dark);
		}
		return liveEntryIn(entries ?? [], sessionId) !== null;
	};
	test.registryUnreadable = () => entries === null;
	return test;
}

/**
 * Is this lock's holder still running — resumed onto a fresh host included?
 *
 * THE ONE SPELLING OF THAT QUESTION (#259). Five readers ask it; each spelling
 * it for itself is how they came to disagree, so a sixth uses this rather than
 * pairing the two tests again.
 *
 * EXCEPT `forceRelease` (#262), which asks a different question — "has the
 * session ended though its host runs on" — that this cannot answer, the
 * stranded case it must break being a running process.
 *
 * `wasResumed` is a resumedHolderTest() the caller built for its whole walk, so
 * the registry is read once however many locks it judges — and not at all where
 * holderAlive() already said yes.
 * @param {{sessionId?: string|null, pid?: number, procStart?: string|number}} lock
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function liveOrResumed(lock, wasResumed) {
	return holderAlive(lock) || wasResumed(lock.sessionId ?? null);
}

/**
 * identify()'s walk of this session's own registry entries: `live`, the
 * durable identity of the first entry /proc proves running, else null with the
 * first dead candidate's `pid` and `procStart` and the last entry found with
 * no procStart as `unproveable`.
 * @param {string} sessionId
 */
function scanOwnEntries(sessionId) {
	let pid = null;
	let procStart = null;
	let unproveable = null;
	// Own registry alone: a session's entry is written under its own
	// CLAUDE_CONFIG_DIR, so a neighbour's could only cost this session its
	// identity — and with it every claim it would have taken (mantahostels#1309).
	for (const { file, entry } of readSessionEntries("own") ?? []) {
		if (entry.sessionId !== sessionId || !entry.pid) continue;
		// entry.procStart ONLY — never a fresh read of /proc as a fallback.
		// Falling back compares that read against itself, so it matches
		// whatever process holds the pid now: a recycled pid then reads
		// "durable", and the lock minted on it outlives the session that
		// asked for it, wedging the file for as long as the stranger runs.
		// An entry without procStart means liveness is unproveable: say so
		// rather than trusting it.
		const start = entry.procStart;
		if (!start) {
			unproveable = file;
			continue;
		}
		if (readProcStartOf(entry.pid) === String(start)) {
			const live = {
				sessionId,
				pid: entry.pid,
				procStart: start,
				durable: true,
			};
			return { live, pid, procStart, unproveable };
		}
		// Keep the first dead candidate only so the shape of the answer is
		// unchanged when every entry is dead; it will not be durable.
		if (pid === null) {
			pid = entry.pid;
			procStart = start;
		}
	}
	return { live: null, pid, procStart, unproveable };
}

/**
 * Who is running this hook: session id, and the process whose death releases its
 * claims.
 *
 * mantahostels#104 ruled sessions/<pid>.json the single registry — 0 of 6 interactive
 * sessions have a job directory, and a live background session lacked one too,
 * so the jobs registry is incomplete even for its own case. It is read here to
 * resolve the session's OWN pid, which a short-lived hook subprocess cannot
 * otherwise know.
 *
 * A session id can match SEVERAL entries — they are named by pid, and a resumed
 * or reconnected session leaves the old one behind. Taking the first match would
 * hand back a dead pid, and
 * a lock minted on a dead pid is stale the instant it is written: the next
 * session breaks it and edits the file its live holder is working on, with
 * nothing logged. So every match is scored against /proc and a live one wins.
 * @param {string|null} sessionId
 */
function identify(sessionId) {
	const scan = sessionId
		? scanOwnEntries(sessionId)
		: { live: null, pid: null, procStart: null, unproveable: null };
	if (scan.live) return scan.live;
	const { pid, procStart, unproveable } = scan;

	// Every path below leaves this session unable to take a claim, so its own
	// files are unprotected for as long as it runs.
	sayOnce(
		sessionId,
		"identify",
		unproveable
			? `session entry ${unproveable} has no procStart — liveness unproveable, so this session takes no claims and its files are unprotected`
			: `no live session entry for ${sessionId || "(no session id)"} — this session takes no claims and its files are unprotected`,
	);

	// NO ppid FALLBACK. This process's parent is the bash guard that spawned it,
	// which exits milliseconds later, so the lock would record a pid that is dead
	// before the next session ever reads it — every claim instantly "stale" and
	// free for the taking.
	//
	// A session we cannot durably identify therefore takes no claim at all
	// (see acquire()). It is still refused a file someone else holds; it simply
	// leaves no lock of its own. Enforcing on an identity we cannot prove alive
	// would wedge the file forever.
	return { sessionId, pid, procStart, durable: false };
}

/**
 * Delete everything in `dir` older than `ageMs` that `spared` does not claim.
 *
 * `spared` takes the filename, not the full path.
 *
 * Silent and best-effort, like sweepDebris: housekeeping must not fail a caller.
 * @param {string} dir
 * @param {number} ageMs
 * @param {(file: string) => boolean} spared
 */
function sweepAged(dir, ageMs, spared) {
	try {
		const now = Date.now();
		for (const f of fs.readdirSync(dir)) {
			if (spared(f)) continue;
			const full = path.join(dir, f);
			try {
				if (now - fs.statSync(full).mtimeMs > ageMs) fs.unlinkSync(full);
			} catch {
				/* swept already */
			}
		}
	} catch {
		/* no such directory yet */
	}
}

/**
 * Whether sweepAged would delete anything — the cheap test a caller runs before
 * paying for an expensive second opinion on what to spare.
 * @param {string} dir
 * @param {number} ageMs
 * @param {(file: string) => boolean} spared
 */
function agedUnspared(dir, ageMs, spared) {
	try {
		const now = Date.now();
		for (const f of fs.readdirSync(dir)) {
			if (spared(f)) continue;
			try {
				if (now - fs.statSync(path.join(dir, f)).mtimeMs > ageMs) return true;
			} catch {
				/* gone already */
			}
		}
	} catch {
		/* no such directory yet */
	}
	return false;
}

/**
 * The registry read every session-keyed sweep opens with, and the fail-safe it
 * encodes: an unreadable registry deletes nothing (mantahostels#174). Live cannot be told
 * from finished on that answer, and a sweep that guessed would delete a running
 * session's own state out from under it.
 *
 * Logged rather than silent: this disables the sweep for as long as the registry
 * stays unreadable, which is the failing-open-quietly state check-guard-errors
 * exists to surface.
 *
 * ASSERTED HERE, ONCE (mantahostels#1796).
 * @param {string} name the calling sweep, for the error log
 * @returns {Set<string>|null} null where the registry could not be read
 */
function readLiveOrLog(name) {
	const live = readLiveSessionIds();
	if (live === null) {
		logError(name, new Error("sessions registry unreadable"));
		return null;
	}
	return live;
}

/**
 * Sweep `dir` of everything aged past `ageMs`, sparing the file each live
 * session owns.
 *
 * `nameFor` maps a session id to its filename in `dir`. Filenames, not ids: the
 * paths.* helpers sanitise an id into a name, and reversing that is lossy.
 * @param {string} name the family, for the error log
 * @param {string} dir
 * @param {number} ageMs
 * @param {(id: string) => string} nameFor
 */
function sweepSparingLive(name, dir, ageMs, nameFor) {
	const live = readLiveOrLog(name);
	if (live === null) return;
	const spared = new Set([...live].map(nameFor));
	sweepAged(dir, ageMs, (f) => spared.has(f));
}

/**
 * A session-name resolver reading the REGISTRY, never the `claude agents --json`
 * oracle: that costs ~465 ms, which mantahostels#411 bars from the PreToolUse hook path, and
 * cmdCheck is exactly that path. Falls back to the id.
 *
 * A FACTORY, not a memoised function. The cache has to die with the call that
 * made it: a caller naming several sessions should read the registry once, but
 * a long-lived process — a test, or anything driving the store in-process —
 * must see a session that has since been renamed or registered.
 * @returns {(sessionId: string|null) => string}
 */
function registryNames() {
	/** @type {ReturnType<typeof readSessionEntries>|undefined} */
	let entries;
	return (sessionId) => {
		if (!sessionId) return "an unidentified session";
		entries ??= readSessionEntries("best-effort");
		for (const { entry } of entries ?? [])
			if (entry.sessionId === sessionId && entry.name)
				return String(entry.name);
		return sessionId;
	};
}

module.exports = {
	agedUnspared,
	DETECT_ONLY,
	errorLog,
	firstSay,
	flat,
	git,
	gitDirty,
	gitIn,
	gitRaw,
	identify,
	isGuarded,
	isWatched,
	isReleasable,
	keyFor,
	readLiveEntryFor,
	readLiveOrLog,
	readLiveSessionIds,
	logError,
	createOnce,
	pairSuffix,
	paths,
	probeRecord,
	readRecord,
	readRecordOrFlag,
	readRecordOrLog,
	buildRecordText,
	REFUSING,
	registryNames,
	relativeToRepo,
	repoRoot,
	liveOrResumed,
	resumedHolderTest,
	sayOnce,
	sessionDirs,
	readSessionEntries,
	splitSubject,
	stateDir,
	stateDirFor,
	subjectDirty,
	subjectFor,
	subjectPath,
	subjectsOverlap,
	sweepAged,
	sweepSparingLive,
	under,
	withGitTimeout,
	writeRecord,
};
