/*
 * tree-drift.js — did the working tree change while something else was running?
 *
 * The shared worktree is repo-global, so a session running the suite is reading
 * files its neighbours are still writing. On 12 August 2026 that produced mantahostels#273:
 * three sessions editing at once, and one session's `npm run test` importing
 * another's half-written `check-superseded-values.js` and a shell lib.
 * The suite went red with a different set of failures each run and green on the
 * re-run.
 *
 * `drift` returns what moved; the caller says what that means. Nothing here
 * fails a run — a tree that changes mid-run is normal here, and a gate on it
 * would block the parallel work it describes.
 *
 * UNTRACKED PATHS RIDE BESIDE `files`, NOT IN IT, and only `neighbourDirty`
 * reads them (mantahostels#392, which also holds the figures). Not in `files` because
 * `drift` reads that map, and a new scratch file appearing mid-run is not drift
 * worth naming. The suite's own root markers are no argument for dropping them
 * altogether: every one is gitignored, so `git status` never listed them.
 *
 * `drift` SEES A WINDOW, NOT A STATE. Comparing two snapshots catches a file
 * written *during* the run and nothing else — a neighbour who saved a
 * half-finished file before the run began and then sat still breaks the suite
 * just as thoroughly and leaves no drift to find.
 *
 * `neighbourDirty` covers that from the other side (mantahostels#291): who holds a file is
 * what the arbiter's claims say, and they reach `scripts/` as well as the docs
 * tree — a detect-only tier (mantahostels#287, mantahostels#295), so they cover where the culprits
 * above lived.
 *
 * Three things still get past it: a file dirty under NO CLAIM at all — product
 * code outside those tiers, and any Bash-route write, which mints no claim
 * (mantahostels#364); a dead holder's claim older than DEAD_CLAIM_MAX_AGE_MS, dropped
 * deliberately below; and a lock too corrupt to name its path.
 */

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execGit } = require("./git.js");

/**
 * A tree as one moment saw it, and the claim rows `neighbourDirty` reads.
 *
 * @typedef {{head: string, files: Record<string, string>,
 *   untracked?: string[]}} Snapshot
 *   `untracked` is optional: only `neighbourDirty` reads it, and it already
 *   tolerates a snapshot taken before the field existed.
 * @typedef {{path?: string, sessionId?: string|null, pid?: number|null,
 *   alive?: boolean, unreadable?: boolean, claimedAt?: string}} Lock
 * @typedef {{path: string, sessionId: string, pid: number|null,
 *   dead: boolean}} HeldEntry
 */

/* stderr is dropped: the one call that fails is a tree git will not answer for,
 * and its "not a git repository" would print into the middle of a test run. */
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

/**
 * A tracked path git reports as dirty. `??` (untracked) is dropped — see above.
 * @param {string} porcelain
 */
function dirtyPaths(porcelain) {
	/** @type {string[]} */
	const out = [];
	for (const line of porcelain.split("\n")) {
		if (line.length < 4 || line.startsWith("??")) continue;
		// `XY <path>`, and `XY <old> -> <new>` for a rename: the new name is what
		// a later run will find on disk.
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		out.push(arrow === -1 ? rest : rest.slice(arrow + 4));
	}
	return out;
}

/**
 * The `??` paths — a file git has never been told about, which is what a
 * half-written NEW module looks like (mantahostels#392).
 *
 * A rename has no `??` form, so there is no arrow to split here.
 *
 * @param {string} porcelain
 */
function untrackedPaths(porcelain) {
	/** @type {string[]} */
	const out = [];
	for (const line of porcelain.split("\n"))
		if (line.length >= 4 && line.startsWith("??")) out.push(line.slice(3));
	return out;
}

/**
 * Content hash, or a fixed sentinel where the file could not be read at all —
 * a path that vanished mid-run, or one the reader has no permission for. Never
 * throws: a file being rewritten as we hash it is the condition under study.
 *
 * THE SENTINEL IS STABLE ON PURPOSE. A clock in it would make two unreadable
 * reads of an unchanged file compare unequal, so every run with one unreadable
 * path would cry drift. The cost is the reverse case — a file unreadable at both
 * ends and changed in between reads as unchanged.
 */
const UNREADABLE = "unreadable";

/* How many paths a warning names before it counts the rest: a guess, never
 * measured against what a reader takes in. */
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
 * The tree as it stands: HEAD, plus a hash per dirty tracked file. Hashing only
 * the dirty set keeps this cheap — a clean file that a neighbour edits mid-run
 * becomes dirty, so it shows up in the later snapshot and is caught as an add.
 *
 * Returns null where git cannot answer at all, which the caller reads as "no
 * comparison available" rather than "nothing changed".
 *
 * `untracked` carries names only, no hashes: its one reader tests set membership
 * and never compares content.
 *
 * @param {string} root
 * @param {{fs?: typeof nodeFs}} [opts]
 * @returns {Snapshot|null}
 */
function readTreeSnapshot(root, { fs = nodeFs } = {}) {
	let head;
	let porcelain;
	try {
		head = git(root, ["rev-parse", "HEAD"]).trim();
		// `-uall` because the default collapses a wholly-new directory to one
		// `?? dir/` line, and a claim names a file — so a new module in a new
		// directory, exactly mantahostels#291's case, would match nothing. Gitignored paths
		// stay out either way, which is what keeps the listing small here.
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
 * What moved between two snapshots. `changed` names a file whose content
 * differs, `appeared` one that became dirty during the window, `settled` one
 * that stopped being dirty — a neighbour committing or reverting mid-run.
 *
 * `headMoved` is reported even with no file movement: a neighbour's
 * `git pull --ff-only` rewrites tracked files that were clean and stay clean, so
 * they enter neither snapshot's dirty set.
 *
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

/**
 * The warning a session reads, or null where there is nothing to say.
 *
 * @param {ReturnType<typeof drift>} drifted
 * @param {number} [limit]
 */
function format(drifted, limit = NAMED_PATHS) {
	if (!drifted) return null;
	const lines = [
		"",
		"⚠  THE WORKING TREE CHANGED WHILE THIS SUITE RAN.",
		"   Any failure above may be a parallel session's half-written file rather",
		"   than your own breakage — that is mantahostels#273. Re-run once the tree is still.",
	];
	if (drifted.headMoved)
		lines.push("   HEAD moved: a neighbour committed or pulled mid-run.");
	for (const entry of drifted.moved.slice(0, limit))
		lines.push(`   ${entry.kind.padEnd(8)} ${entry.path}`);
	if (drifted.moved.length > limit)
		lines.push(`   … and ${drifted.moved.length - limit} more`);
	lines.push("");
	return lines.join("\n");
}

/**
 * How long after its holder died a claim still explains a broken run (mantahostels#392).
 *
 * A lock has no age-prune of its own — it sits until the next claimant of that
 * path breaks it — so without a bound an abandoned dirty file would nag for ever.
 *
 * 24 HOURS IS A FIRST GUESS, NOT A MEASUREMENT. Re-derive it against sampled
 * data as soon as there is any; mantahostels#392 holds what it was set from.
 *
 * IT AGES THE CLAIM, NOT THE EDIT. `claimedAt` is when the path was taken, so a
 * session that claimed a file a day before dying but dirtied it minutes earlier
 * ages out wrongly. Accepted: the store records no per-write timestamp, and the
 * file's own mtime is not the holder's either.
 */
const DEAD_CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Of the files already dirty when the window opened, those another session holds
 * a claim on.
 *
 * Neither input works alone: the dirty set is mostly the session's own work in
 * progress, and most claimed files are untouched. Their intersection is a file a
 * neighbour holds *and* has left uncommitted.
 *
 * UNTRACKED PATHS COUNT (mantahostels#392). A half-written NEW module is exactly the case
 * mantahostels#291 describes, and it is `??` rather than dirty until its first commit.
 *
 * A DEAD HOLDER STILL COUNTS, up to DEAD_CLAIM_MAX_AGE_MS. The session being
 * gone does not make the file whole — it breaks your run just the same, and it
 * is still not your breakage. What changes is the advice, so the entry carries
 * `dead` for the formatter to act on: there is nobody left to wait for.
 *
 * A dead claim carrying no readable `claimedAt` is REPORTED, not skipped: an
 * absent field means not-observed, never false (`arbiter-store.js`'s header).
 *
 * `locks` is `arbiter-store.listLocks()`: every held path carrying an `alive`
 * flag, or null where the store could not be read.
 *
 * SILENT WHERE THE SESSION CANNOT NAME ITSELF. Without an id its own claims read
 * exactly like a neighbour's, so it would report every file it is editing.
 *
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
 * Whether `lock` names a path in `dirty` that a session other than this one
 * holds.
 * @param {Lock|null|undefined} lock
 * @param {string} selfSessionId
 * @param {Set<string>} dirty
 * @returns {lock is Lock & {path: string, sessionId: string}}
 */
function isNeighbourHold(lock, selfSessionId, dirty) {
	if (!lock || lock.unreadable || !lock.path) return false; // names no path
	if (!lock.sessionId || lock.sessionId === selfSessionId) return false;
	return dirty.has(lock.path);
}

/**
 * Has a dead holder's claim aged past the point of explaining anything?
 *
 * @param {Lock} lock
 * @param {number} now
 */
function staleBeyondUse(lock, now) {
	const claimedAt = Date.parse(lock.claimedAt ?? "");
	if (Number.isNaN(claimedAt)) return false; // not observed, so not aged out
	return now - claimedAt > DEAD_CLAIM_MAX_AGE_MS;
}

/**
 * As `format`, for the state that was already there when the run began.
 *
 * `nameFor` resolves a session id to the name a reader can act on — a raw
 * UUID names nothing a session can message or ask ListAgents about. Defaults
 * to the identity function so a caller that reads straight from the claim
 * store without the registry still gets a value, never a throw.
 *
 * @param {HeldEntry[]|null} held
 * @param {number} [limit]
 * @param {(sessionId: string) => string} [nameFor]
 */
function formatNeighbourDirty(held, limit = NAMED_PATHS, nameFor = (id) => id) {
	if (!held) return null;
	const anyDead = held.some((e) => e.dead);
	const lines = [
		"",
		"⚠  UNCOMMITTED WORK THAT IS NOT YOURS WAS ALREADY IN THE TREE AT START.",
		"   These files were dirty before this run began and are claimed by another",
		"   session, so a failure above may be their half-written code rather than",
		"   your own breakage — that is mantahostels#291.",
	];
	if (held.some((e) => !e.dead))
		lines.push("   Re-run once a live holder releases.");
	if (anyDead)
		lines.push(
			"   A holder marked GONE will never release: commit or revert the file.",
		);
	for (const entry of held.slice(0, limit))
		lines.push(
			`   ${entry.path}  held by ${nameFor(entry.sessionId)}${entry.pid ? ` (pid ${entry.pid})` : ""}${entry.dead ? " — GONE" : ""}`,
		);
	if (held.length > limit) lines.push(`   … and ${held.length - limit} more`);
	lines.push("");
	return lines.join("\n");
}

/**
 * `neighbourDirty` against the live claim store, for a runner that has just
 * snapshotted the tree.
 *
 * Read at the START of a run, not the end: a neighbour who releases mid-run
 * still handed this run the half-written file it imported, so their claim at the
 * start is the state that explains a failure.
 *
 * The catch is what keeps a broken store from costing a run anything, and it
 * guards the LOAD as much as the call: `listLocks` swallows its own read errors
 * and returns null, so an unreadable store never throws. What throws is the
 * module failing to resolve or blowing up on evaluation, which is why the load
 * sits inside the try rather than in a default argument.
 *
 * `loadStore` is injectable so the catch is reachable without mocking the module
 * registry, an unreachable branch not being countable as covered (AGENTS.md).
 *
 * @param {Snapshot|null} snap
 * @param {() => {listLocks: () => import("./arbiter-store.js").ListedLock[]|null}} [loadStore]
 */
function fromArbiter(snap, loadStore = () => require("./arbiter-store.js")) {
	try {
		const store = loadStore();
		return neighbourDirty(
			snap,
			store.listLocks(),
			process.env.CLAUDE_CODE_SESSION_ID || "",
		);
	} catch {
		return null;
	}
}

/**
 * The tracked tree's identity as a run FINISHES (mantahostels#2187) — HEAD's own tree
 * where nothing tracked is dirty, or the tree a `git stash create` would
 * commit where something is. Taken in the RUN'S OWN worktree: for an
 * `--isolated` run that is the frozen checkout, for a shared-tree run the
 * canonical one.
 *
 * The dirty tree is built on a PRIVATE COPY of the index, never `.git/index`
 * itself (workflow-core#2104): `stash create` takes `index.lock`, so in the shared checkout
 * any neighbour's git holding it at teardown left the marker with no tree.
 * `add -u` then `write-tree` on the copy gives the tree `stash create` would —
 * both stage every tracked path's working-tree content over the index.
 * `--no-optional-locks` keeps `status` from refreshing the shared index too.
 * Under a neighbour's lock the copy is the index before their write, which
 * `add -u` restages from the working tree anyway.
 *
 * It carries only TRACKED changes, which is what a tree's identity is a hash
 * of; a dirty-but-untracked-only tree reads as HEAD's tree.
 *
 * An unmerged path reads as null, as `stash create` refused it, where `add -u`
 * would quietly stage the conflict markers as a resolution. An intent-to-add
 * path, which `stash create` also refused, reads as a tree holding it.
 *
 * Null where git will not answer at all — an unreadable tree, same as
 * `readTreeSnapshot`'s null — which every reader of the marker's `treeAtEnd` treats as
 * unknown, never as "matched".
 *
 * @param {string} root
 * @returns {string|null}
 */
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
		return privateIndexTree(root);
	} catch {
		return null;
	}
}

/**
 * @param {string} root
 * @returns {string}
 */
function privateIndexTree(root) {
	const shared = path.resolve(
		root,
		git(root, ["rev-parse", "--git-path", "index"]).trim(),
	);
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "tree-at-end-"));
	try {
		const copy = path.join(dir, "index");
		nodeFs.copyFileSync(shared, copy);
		// git trusts an entry's cached stat only where the file is older than
		// the index itself; a copy stamped now would trust a same-size edit
		// made just before the shared index was written, and miss it.
		const { atime, mtime } = nodeFs.statSync(shared);
		nodeFs.utimesSync(copy, atime, mtime);
		const copyIndex = { GIT_INDEX_FILE: copy };
		git(root, ["add", "-u"], copyIndex);
		return git(root, ["write-tree"], copyIndex).trim();
	} finally {
		nodeFs.rmSync(dir, { recursive: true, force: true });
	}
}

module.exports = {
	readTreeSnapshot,
	drift,
	format,
	neighbourDirty,
	formatNeighbourDirty,
	fromArbiter,
	endOfRunTreeIdentity,
};
