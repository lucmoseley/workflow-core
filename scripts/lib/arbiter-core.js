const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { configDir } = require("./config-dir.js");
const { gitAnswer } = require("./git.js");
const regions = require("./doc-map-regions.js");
const { holderAlive, readProcStartOf } = require("./arbiter-proc.js");
const { projectSlug, UNRESOLVED_ROOT_SLUG } = require("./project-slug.js");
const { realKey } = require("./deref.js");
const { SCRATCH_DIR } = require("./scratch-dir.js");
const { hostRoot, worktreeRoot } = require("./host-root.js");
const { caught, ignoreFailure, orFallback } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");

/** @typedef {import("./arbiter-records.js").LockRecord} LockRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").SessionEntry} SessionEntry */
/** @typedef {import("./arbiter-records.js").UnreadableRecord} UnreadableRecord */

/** @type {readonly [string, string, string]} */
const DEFAULT_CONFIG_DIR_NAMES = [".claude", ".claude2", ".claude3"];

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

/** @returns {[string, string, string]} */
function seatCandidates() {
	const parent = path.dirname(configDir());
	const [a, b, c] = DEFAULT_CONFIG_DIR_NAMES;
	return [
		process.env.WFC_CLAUDE_CONFIG_A || path.join(parent, a),
		process.env.WFC_CLAUDE_CONFIG_B || path.join(parent, b),
		process.env.WFC_CLAUDE_CONFIG_C || path.join(parent, c),
	];
}

function storeConfigDir() {
	const dir = configDir();
	return isSeat(dir) ? seatCandidates()[0] : dir;
}

function repoRoot() {
	if (gitBound.ms === undefined) return hostRoot();
	gitBound.root ??= hostRoot(process.cwd(), {
		timeoutMs: gitBound.ms,
		onTimeout: markOverrun,
	});
	return gitBound.root;
}

// #5529
function stateDir() {
	return stateDirFor(repoRoot());
}

/** @param {string} root */
const stateDirFor = (root) =>
	path.join(storeConfigDir(), "projects", projectSlug(root));

/** @param {string} [root] */
const stateDirOf = (root) => (root ? stateDirFor(root) : stateDir());

/** @param {string} dir */
const isSeat = (dir) =>
	seatCandidates().some((s) => realKey(s) === realKey(dir));

/** @param {string} rel */
function keyFor(rel) {
	return crypto.createHash("sha256").update(rel).digest("hex").slice(0, 16);
}

/** @param {string} id */
const idSlug = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * @param {string} rel
 * @param {string} id
 */
function pairFile(rel, id) {
	return `${keyFor(rel)}-${idSlug(id)}.json`;
}

/** @param {string} id */
const pairSuffix = (id) => `-${idSlug(id)}.json`;

const paths = {
	repoRoot,
	stateDir,
	sessionsDir: () => path.join(configDir(), "sessions"),
	sessionDirs: () => sessionDirs().map((d) => path.join(d, "sessions")),

	locksDir: () => path.join(stateDir(), "locks"),

	breaksDir: () => path.join(stateDir(), "breaks"),

	observationsDir: () => path.join(stateDir(), "observations"),

	wantsDir: () => path.join(stateDir(), "wants"),

	/** @param {string} [root] */
	writesDir: (root) => path.join(stateDirOf(root), "writes"),

	selectsDir: () => path.join(stateDir(), "selects"),

	landedDir: () => path.join(stateDir(), "landed"),

	/** @param {string} [root] */
	commitsDir: (root) => path.join(stateDirOf(root), "commits"),

	/** @param {string} [root] */
	actsDir: (root) => path.join(stateDirOf(root), "acts"),

	/** @param {string} rel */
	lock: (rel) => path.join(paths.locksDir(), `${keyFor(rel)}.json`),

	/** @param {string} sessionId */
	want: (sessionId) =>
		path.join(
			paths.wantsDir(),
			`${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "")}.json`,
		),

	/**
	 * @param {string} rel
	 * @param {string} sessionId
	 */
	observation: (rel, sessionId) =>
		path.join(paths.observationsDir(), pairFile(rel, sessionId)),

	snapshotsDir: () => path.join(stateDir(), "snapshots"),
	/** @param {string} sessionId */
	snapshot: (sessionId) =>
		path.join(paths.snapshotsDir(), `${idSlug(sessionId)}.txt`),

	/**
	 * @param {string} rel
	 * @param {string} claimId
	 */
	break: (rel, claimId) => path.join(paths.breaksDir(), pairFile(rel, claimId)),

	/** @param {string} [root] */
	issueClaimsDir: (root) => path.join(stateDirOf(root), "issue-claims"),
	/**
	 * @param {number|string} issue
	 * @param {string} sessionId
	 */
	issueClaim: (issue, sessionId) =>
		path.join(paths.issueClaimsDir(), `${issue}${pairSuffix(sessionId)}`),

	/** @param {string} sessionId */
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

	/** @param {string} [root] */
	errorLog: (root) => path.join(stateDirOf(root), "guard-errors.log"),
	rootlessErrorLog: () =>
		path.join(
			storeConfigDir(),
			"projects",
			UNRESOLVED_ROOT_SLUG,
			"guard-errors.log",
		),
	commitPathsLog: () => path.join(stateDir(), "commit-paths.log"),
	keptClaimsLog: () => path.join(stateDir(), "kept-claims.jsonl"),
};

/** @param {string} file */
function readRecord(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	try {
		const record = JSON.parse(text);
		return record && typeof record === "object" ? record : null;
	} catch {
		return null;
	}
}

/** @param {string} file */
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
 * @param {string} file
 * @param {string} where
 * @param {() => void} pause
 * @returns {{record: any, unreadable?: false}|UnreadableRecord}
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
		if (!settled) return null;
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
 * @param {string} file
 * @param {object} body
 * @param {import("node:fs").WriteFileOptions} [options]
 */
function writeRecord(file, body, options = {}) {
	fs.writeFileSync(file, buildRecordText(body), options);
}

/**
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
		ignoreFailure(() => fs.unlinkSync(tmp));
	}
}

function errorLog() {
	return paths.errorLog();
}

/** @param {unknown} value */
function flat(value) {
	return String(value).replace(/[\t\r\n]+/g, " ");
}

/**
 * @param {string} where
 * @param {unknown} err
 * @param {string} [detail]
 * @param {string} [root]
 */
function logError(where, err, detail, root) {
	ignoreFailure(() => {
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
	});
}

/**
 * @param {string|null} sessionId
 * @param {string} where
 * @param {string} message
 */
function sayOnce(sessionId, where, message) {
	if (!firstSay(sessionId, message)) return;
	logError(where, message);
}

/**
 * @param {string|null} sessionId
 * @param {string} message
 */
function firstSay(sessionId, message) {
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
		if (
			caught(e).code === "EEXIST" &&
			e instanceof Error &&
			"syscall" in e &&
			e.syscall === "open"
		)
			return false;
	}
	return true;
}

const WARNED = ["docs/", ".claude/", "CLAUDE.md", "AGENTS.md"];
const DETECT_ONLY = ["scripts/"];

const EXEMPT = [SCRATCH_DIR];

let treeMemo = { cwd: "", host: "", tree: "" };

let treeOverride = /** @type {string|null} */ (null);

function treeRoot() {
	if (treeOverride !== null) return treeOverride;
	const cwd = process.cwd();
	const host = repoRoot();
	if (treeMemo.cwd === cwd && treeMemo.host === host) return treeMemo.tree;
	if (gitBound.overran) return host;
	const tree = worktreeRoot(cwd, {
		host,
		timeoutMs: gitBound.ms,
		onTimeout: markOverrun,
	});
	if (!gitBound.overran) treeMemo = { cwd, host, tree };
	return tree;
}

function writerTree() {
	const tree = treeRoot();
	return tree === repoRoot() ? undefined : tree;
}

/**
 * @param {{tree?: string}} record
 * @param {string} [host]
 */
function recordTree(record, host = repoRoot()) {
	return record.tree ?? host;
}

/**
 * @template T
 * @param {string} tree
 * @param {() => T} fn
 * @returns {T}
 */
function inTree(tree, fn) {
	const prior = treeOverride;
	treeOverride = tree;
	try {
		return fn();
	} finally {
		treeOverride = prior;
	}
}

/**
 * @template T
 * @param {{tree?: string}} record
 * @param {() => T} fn
 * @returns {T}
 */
function inRecordTree(record, fn) {
	return inTree(recordTree(record), fn);
}

/** @param {string} filePath */
function claimKey(filePath) {
	const tree = treeRoot();
	const rel = relativeUnder(tree, path.resolve(tree, filePath));
	return rel === null ? null : rel.split(path.sep).join("/");
}

/** @param {string} subject */
function splitSubject(subject) {
	const whole = String(subject ?? "");
	const at = whole.indexOf("#");
	if (at === -1 || !regions.isRegioned(whole.slice(0, at)))
		return { rel: whole, region: null };
	return { rel: whole.slice(0, at), region: whole.slice(at + 1) || null };
}

/** @param {string} subject */
function subjectPath(subject) {
	return splitSubject(subject).rel;
}

/**
 * @param {string} rel
 * @param {string|null} region
 */
function subjectFor(rel, region) {
	return region ? `${rel}#${region}` : rel;
}

/**
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

/** @param {string} rel */
function isWarned(rel) {
	const p = subjectPath(rel);
	return under(WARNED, p) && !under(EXEMPT, p);
}

/** @param {string} rel */
function isWatched(rel) {
	const p = subjectPath(rel);
	if (under(EXEMPT, p)) return false;
	return under(WARNED, p) || under(DETECT_ONLY, p);
}

/** @param {string} rel */
function isReleasable(rel) {
	const p = subjectPath(rel);
	return isWatched(p) || under(EXEMPT, p);
}

let gitBound = {
	/** @type {number | undefined} */ ms: undefined,
	/** @type {string | undefined} */ root: undefined,
	overran: false,
};

function markOverrun() {
	gitBound.overran = true;
}

/**
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
 * @param {string[]} args
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding">} [opts]
 * @returns {string | null}
 */
function boundedGit(args, opts = {}) {
	if (gitBound.overran) return null;
	const cwd = opts.cwd ?? treeRoot();
	if (gitBound.overran) return null;
	const { out, timedOut } = gitAnswer(args, {
		...opts,
		cwd,
		timeout: gitBound.ms,
	});
	if (timedOut) markOverrun();
	return out;
}

/**
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 */
function git(args, opts = {}) {
	return boundedGit(args, opts)?.trim() ?? null;
}

/**
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

/** @param {string[]} args */
function gitRaw(args) {
	return boundedGit(args);
}

/** @param {string} rel */
function gitDirty(rel) {
	const out = git(["status", "--porcelain", "--", subjectPath(rel)]);
	return out === null ? null : out !== "";
}

// lucmoseley/mantahostels#1434
/** @param {string} subject */
function subjectDirty(subject) {
	const { rel, region } = splitSubject(subject);
	if (!region) return gitDirty(rel);
	const head = gitRaw(["show", `HEAD:${rel}`]);
	const staged = gitRaw(["show", `:${rel}`]);
	if (head === null || staged === null) return gitDirty(rel);
	let worktree;
	try {
		worktree = fs.readFileSync(path.join(treeRoot(), rel), "utf8");
	} catch {
		return gitDirty(rel);
	}
	const committed = regions.parseRegionText(head, region, rel);
	for (const revision of [worktree, staged]) {
		const mine = regions.parseRegionText(revision, region, rel);
		if (mine === null && committed === null) continue;
		if (mine === null || committed === null) return true;
		if (mine !== committed) return true;
	}
	return false;
}

function readSessionEntries(mode = "all") {
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
 * @param {string} dir
 * @param {string[]} names
 * @param {RegistryEntry[]} out
 */
function pushDirEntries(dir, names, out) {
	for (const file of names) {
		if (!file.endsWith(".json")) continue;
		let entry;
		try {
			entry = readRecord(path.join(dir, file));
		} catch {
			continue;
		}
		if (entry) out.push({ file: path.join(dir, file), entry });
	}
}

// lucmoseley/mantahostels#321
function readLiveSessionIds() {
	const entries = readSessionEntries();
	if (entries === null) return null;
	const live = new Set();
	for (const { entry } of entries) {
		if (!entry.sessionId || !entry.pid) continue;
		if (
			!entry.procStart ||
			readProcStartOf(entry.pid) === String(entry.procStart)
		)
			live.add(entry.sessionId);
	}
	return live;
}

/**
 * @param {string|null} sessionId
 * @param {Identity} me
 */
function readLiveEntryFor(sessionId, me) {
	if (!sessionId) return null;
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
 * @param {SessionEntry[]} entries
 * @param {string|null} sessionId
 */
function liveEntryIn(entries, sessionId) {
	if (!sessionId) return null;
	for (const { entry } of entries) {
		if (entry.sessionId !== sessionId || !entry.pid || !entry.procStart)
			continue;
		const pid = Number(entry.pid);
		const { procStart } = entry;
		if (typeof procStart !== "string" && typeof procStart !== "number")
			continue;
		if (readProcStartOf(pid) === String(procStart)) return { pid, procStart };
	}
	return null;
}

/**
 * @param {string} where
 * @param {string} dark
 */
function resumedHolderTest(where, dark) {
	/** @type {SessionEntry[]|null|undefined} */
	let entries;
	const test = (/** @type {string|null} */ sessionId) => {
		if (entries === undefined) {
			entries = readSessionEntries("best-effort");
			if (entries === null) logError(where, dark);
		}
		return liveEntryIn(entries ?? [], sessionId) !== null;
	};
	test.registryUnreadable = () => entries === null;
	return test;
}

/**
 * @param {{sessionId?: string|null, pid?: number, procStart?: string|number}} lock
 * @param {(sessionId: string|null) => boolean} wasResumed
 */
function liveOrResumed(lock, wasResumed) {
	return holderAlive(lock) || wasResumed(lock.sessionId ?? null);
}

/** @param {string} sessionId */
function scanOwnEntries(sessionId) {
	let pid = null;
	let procStart = null;
	let unproveable = null;
	for (const { file, entry } of readSessionEntries("own") ?? []) {
		if (entry.sessionId !== sessionId || !entry.pid) continue;
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
		if (pid === null) {
			pid = entry.pid;
			procStart = start;
		}
	}
	return { live: null, pid, procStart, unproveable };
}

/** @param {string|null} sessionId */
function identify(sessionId) {
	const scan = sessionId
		? scanOwnEntries(sessionId)
		: { live: null, pid: null, procStart: null, unproveable: null };
	if (scan.live) return scan.live;
	const { pid, procStart, unproveable } = scan;

	sayOnce(
		sessionId,
		"identify",
		unproveable
			? `session entry ${unproveable} has no procStart — liveness unproveable, so this session takes no claims and its files are unprotected`
			: `no live session entry for ${sessionId || "(no session id)"} — this session takes no claims and its files are unprotected`,
	);

	return { sessionId, pid, procStart, durable: false };
}

/**
 * @param {string} dir
 * @param {number} ageMs
 * @param {(file: string) => boolean} spared
 */
function sweepAged(dir, ageMs, spared) {
	ignoreFailure(() => {
		const now = Date.now();
		for (const f of fs.readdirSync(dir)) {
			if (spared(f)) continue;
			const full = path.join(dir, f);
			ignoreFailure(() => {
				if (now - fs.statSync(full).mtimeMs > ageMs) fs.unlinkSync(full);
			});
		}
	});
}

/**
 * @param {string} dir
 * @param {number} ageMs
 * @param {(file: string) => boolean} spared
 */
function agedUnspared(dir, ageMs, spared) {
	return orFallback(() => {
		const now = Date.now();
		for (const f of fs.readdirSync(dir)) {
			if (spared(f)) continue;
			const mtime = orFallback(
				() => fs.statSync(path.join(dir, f)).mtimeMs,
				undefined,
			);
			if (mtime !== undefined && now - mtime > ageMs) return true;
		}
		return false;
	}, false);
}

/**
 * @param {string} name
 * @returns {Set<string>|null}
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
 * @param {string} name
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

/** @returns {(sessionId: string|null) => string} */
function registryNames() {
	const find = registryLookup();
	return (sessionId) => {
		if (!sessionId) return "an unidentified session";
		return find(sessionId)?.name || sessionId;
	};
}

/** @returns {(key: string) => {sessionId: string, name: string|null}|undefined} */
function registryLookup() {
	/** @type {ReturnType<typeof readSessionEntries>|undefined} */
	let entries;
	return (key) => {
		entries ??= readSessionEntries("best-effort");
		const wanted = key.toLowerCase();
		/** @type {{sessionId: string, name: string|null}|undefined} */
		let found;
		for (const { entry } of entries ?? []) {
			const id = String(entry.sessionId ?? "").toLowerCase();
			if (!id || (id !== wanted && !id.startsWith(`${wanted}-`))) continue;
			if (entry.name) return { sessionId: id, name: String(entry.name) };
			found ??= { sessionId: id, name: null };
		}
		return found;
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
	isWarned,
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
	WARNED,
	registryLookup,
	registryNames,
	claimKey,
	repoRoot,
	treeRoot,
	writerTree,
	recordTree,
	inTree,
	inRecordTree,
	liveOrResumed,
	resumedHolderTest,
	sayOnce,
	sessionDirs,
	readSessionEntries,
	splitSubject,
	stateDir,
	stateDirFor,
	storeConfigDir,
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
