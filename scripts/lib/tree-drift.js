const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");
const { execGit } = require("./git.js");
const { sleepSync } = require("./sleep-sync.js");

/**
 * @typedef {{head: string, files: Record<string, string>,
 *   untracked?: string[]}} Snapshot
 * @typedef {{path?: string, sessionId?: string|null, pid?: number|null,
 *   alive?: boolean, unreadable?: boolean, claimedAt?: string, tree?: string}} Lock
 * @typedef {{path: string, sessionId: string, pid: number|null,
 *   dead: boolean}} HeldEntry
 */

/**
 * @param {string} root
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
const git = (root, args, env) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		...(env ? { env: { ...process.env, ...env } } : {}),
	});

/** @param {string} porcelain */
function dirtyPaths(porcelain) {
	/** @type {string[]} */
	const out = [];
	for (const line of porcelain.split("\n")) {
		if (line.length < 4 || line.startsWith("??")) continue;
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		if (arrow === -1) out.push(rest);
		else out.push(rest.slice(0, arrow), rest.slice(arrow + 4));
	}
	return out;
}

/** @param {string} porcelain */
function untrackedPaths(porcelain) {
	/** @type {string[]} */
	const out = [];
	for (const line of porcelain.split("\n"))
		if (line.length >= 4 && line.startsWith("??")) out.push(line.slice(3));
	return out;
}

const UNREADABLE = "unreadable";

// workflow-core#1440 guess
const NAMED_PATHS = 12;

/**
 * @param {typeof nodeFs} fs
 * @param {string} file
 */
function readFileHash(fs, file) {
	try {
		return crypto
			.createHash("sha1")
			.update(fs.readFileSync(file))
			.digest("hex");
	} catch {
		return UNREADABLE;
	}
}

/**
 * @param {string} root
 * @param {{fs?: typeof nodeFs}} [opts]
 * @returns {Snapshot|null}
 */
function readTreeSnapshot(root, { fs = nodeFs } = {}) {
	let head;
	let porcelain;
	try {
		head = git(root, ["rev-parse", "HEAD"]).trim();
		porcelain = git(root, ["status", "--porcelain=v1", "-uall"]);
	} catch {
		return null;
	}
	/** @type {Record<string, string>} */
	const files = {};
	for (const p of dirtyPaths(porcelain))
		files[p] = readFileHash(fs, path.join(root, p));
	return { head, files, untracked: untrackedPaths(porcelain) };
}

/**
 * @param {Snapshot|null} before
 * @param {Snapshot|null} after
 * @returns {{headMoved: boolean, moved: {path: string, kind: string}[]}|null}
 */
function drift(before, after) {
	if (!before || !after) return null;
	/** @type {{path: string, kind: string}[]} */
	const moved = [];
	for (const [p, h] of Object.entries(after.files)) {
		if (!(p in before.files)) moved.push({ path: p, kind: "appeared" });
		else if (before.files[p] !== h) moved.push({ path: p, kind: "changed" });
	}
	for (const p of Object.keys(before.files))
		if (!(p in after.files)) moved.push({ path: p, kind: "settled" });
	moved.sort((a, b) => a.path.localeCompare(b.path));
	const headMoved = before.head !== after.head;
	return headMoved || moved.length > 0 ? { headMoved, moved } : null;
}

/** @param {ReturnType<typeof drift>} drifted @param {number} [limit] */
function format(drifted, limit = NAMED_PATHS) {
	if (!drifted) return null;
	const lines = [
		"",
		"⚠  THE WORKING TREE CHANGED WHILE THIS SUITE RAN.",
		"   Any failure above may be a file read half-written rather than a",
		"   breakage in the code — that is mantahostels#273. Re-run once the tree is still.",
	];
	if (drifted.headMoved)
		lines.push("   HEAD moved: a commit, merge or checkout landed mid-run.");
	for (const entry of drifted.moved.slice(0, limit))
		lines.push(`   ${entry.kind.padEnd(8)} ${entry.path}`);
	if (drifted.moved.length > limit)
		lines.push(`   … and ${drifted.moved.length - limit} more`);
	lines.push("");
	return lines.join("\n");
}

// lucmoseley/mantahostels#392 guess
const DEAD_CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Snapshot|null} before
 * @param {Lock[]|null} locks
 * @param {string} selfSessionId
 * @param {{now?: number}} [opts]
 * @returns {HeldEntry[]|null}
 */
function neighbourDirty(
	before,
	locks,
	selfSessionId,
	{ now = Date.now() } = {},
) {
	if (!before || !Array.isArray(locks) || !selfSessionId) return null;
	const dirty = new Set([
		...Object.keys(before.files),
		...(before.untracked ?? []),
	]);
	/** @type {HeldEntry[]} */
	const held = [];
	for (const lock of locks) {
		if (!isNeighbourHold(lock, selfSessionId, dirty)) continue;
		const dead = !lock.alive;
		if (dead && staleBeyondUse(lock, now)) continue;
		held.push({
			path: lock.path,
			sessionId: lock.sessionId,
			pid: lock.pid ?? null,
			dead,
		});
	}
	held.sort((a, b) => a.path.localeCompare(b.path));
	return held.length > 0 ? held : null;
}

/**
 * @param {Lock|null|undefined} lock
 * @param {string} selfSessionId
 * @param {Set<string>} dirty
 * @returns {lock is Lock & {path: string, sessionId: string}}
 */
function isNeighbourHold(lock, selfSessionId, dirty) {
	if (!lock || lock.unreadable || !lock.path) return false;
	if (!lock.sessionId || lock.sessionId === selfSessionId) return false;
	return dirty.has(lock.path);
}

/** @param {Lock} lock @param {number} now */
function staleBeyondUse(lock, now) {
	const claimedAt = Date.parse(lock.claimedAt ?? "");
	if (Number.isNaN(claimedAt)) return false;
	return now - claimedAt > DEAD_CLAIM_MAX_AGE_MS;
}

// workflow-core#2104
/** @param {string} root @returns {string|null} */
function endOfRunTreeIdentity(root) {
	try {
		const porcelain = git(root, [
			"--no-optional-locks",
			"status",
			"--porcelain=v1",
			"-uall",
		]);
		if (dirtyPaths(porcelain).length === 0)
			return git(root, ["rev-parse", "HEAD^{tree}"]).trim();
		if (git(root, ["ls-files", "--unmerged"]).trim()) return null;
		return privateIndexTree(root, (env) => git(root, ["add", "-u"], env));
	} catch {
		return null;
	}
}

/**
 * @param {string} root
 * @param {{ atHead?: string[] }} [opts]
 * @returns {string}
 */
function launchSnapshotTree(root, { atHead = [] } = {}) {
	if (git(root, ["ls-files", "--unmerged"]).trim())
		throw new Error("the index holds unmerged paths");
	return privateIndexTree(root, (env) => {
		git(root, ["add", "-A"], env);
		if (atHead.length > 0)
			git(root, ["reset", "-q", "HEAD", "--", ...atHead], env);
	});
}

/**
 * @param {string} root
 * @param {(env: { GIT_INDEX_FILE: string }) => void} stage
 * @returns {string}
 */
function privateIndexTree(root, stage) {
	const index = path.resolve(
		root,
		git(root, ["rev-parse", "--git-path", "index"]).trim(),
	);
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "tree-at-end-"));
	try {
		const copy = path.join(dir, "index");
		nodeFs.copyFileSync(index, copy);
		// git trusts a cached stat only where the file is older than the index: https://git-scm.com/docs/racy-git
		const { atime, mtime } = nodeFs.statSync(index);
		nodeFs.utimesSync(copy, atime, mtime);
		const copyIndex = { GIT_INDEX_FILE: copy };
		stage(copyIndex);
		return git(root, ["write-tree"], copyIndex).trim();
	} finally {
		nodeFs.rmSync(dir, { recursive: true, force: true });
	}
}

// workflow-core#5018 guess
const MARK_WAIT_MS = 2000;

const START_MARK_ENV = "WFC_RUN_START_MARK";

/**
 * @param {string} root
 * @param {{fs?: typeof nodeFs}} [opts]
 * @returns {bigint|null}
 */
function markStart(root, { fs = nodeFs } = {}) {
	let dir;
	try {
		dir = fs.mkdtempSync(path.join(root, ".run-start-"));
	} catch {
		return null;
	}
	try {
		const stamp = () => fs.statSync(dir, { bigint: true }).ctimeNs;
		const mark = stamp();
		const until = Date.now() + MARK_WAIT_MS;
		while (Date.now() < until) {
			fs.utimesSync(dir, new Date(), new Date());
			if (stamp() > mark) return mark;
			sleepSync(1);
		}
		return null;
	} catch {
		return null;
	} finally {
		ignoreFailure(() => fs.rmdirSync(dir));
	}
}

/** @param {NodeJS.ProcessEnv} [env] @returns {bigint|null} */
function readHandedMark(env = process.env) {
	const handed = env[START_MARK_ENV];
	return handed && /^\d+$/.test(handed) ? BigInt(handed) : null;
}

/**
 * @param {string} root
 * @param {string[]} paths
 * @param {bigint|null} mark
 * @param {{fs?: typeof nodeFs}} [opts]
 * @returns {Set<string>|null}
 */
function readChangedSince(root, paths, mark, { fs = nodeFs } = {}) {
	if (mark === null) return null;
	/** @type {Set<string>} */
	const changed = new Set();
	for (const p of paths) {
		try {
			if (fs.lstatSync(path.join(root, p), { bigint: true }).ctimeNs > mark)
				changed.add(p);
		} catch (e) {
			const { code } = caught(e);
			if (code !== "ENOENT" && code !== "ENOTDIR") changed.add(p);
		}
	}
	return changed;
}

module.exports = {
	markStart,
	readChangedSince,
	readHandedMark,
	START_MARK_ENV,
	readTreeSnapshot,
	drift,
	format,
	neighbourDirty,
	endOfRunTreeIdentity,
	launchSnapshotTree,
};
