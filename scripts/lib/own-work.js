/*
 * own-work.js — which of the unpushed range is this session's own work
 * (#1156): the one reading every own-work narrowing takes, so no two of them
 * disagree on what "own" means.
 *
 * #1154'S RULE: a commit is a neighbour's where another session's commit
 * ledger names it and the launcher's does not. Every other commit is the
 * launcher's to test, one in no ledger included, so each known miss
 * over-selects. A review marker's newer base= narrows it by patch (#3108):
 * see readOwnPaths' `byPatch`.
 */

const arbiterLedger = require("./arbiter-ledger.js");
const { gitRead } = require("./dirty-tree.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/**
 * @typedef {{ ledgerRoot: () => string|null,
 *   readCommitsBy: (id: string, root?: string) => string[]|null,
 *   readOwnersOf: (commits: string[], root?: string) => Map<string, string>|null }} CommitLedger
 */

/**
 * The commits among `commits` that another session's ledger names and
 * `sessionId`'s does not, each mapped to that session — or null where that
 * cannot be told: no session id, no main worktree git will name, or a ledger
 * that will not read.
 *
 * @param {string[]} commits full shas
 * @param {string|null|undefined} sessionId
 * @param {{ ledger?: CommitLedger }} [options]
 * @returns {Map<string, string>|null}
 */
function readNeighbourCommits(
	commits,
	sessionId,
	{ ledger = arbiterLedger } = {},
) {
	const own = readOwnLedger(sessionId, ledger);
	return own && readOwnersBesides(commits, own, ledger);
}

/**
 * `sessionId`'s ledgered commits and the main worktree whose store holds
 * them — or null where either will not read.
 *
 * @param {string|null|undefined} sessionId
 * @param {CommitLedger} ledger
 * @returns {{ root: string, mine: string[] }|null}
 */
function readOwnLedger(sessionId, ledger) {
	if (!sessionId) return null;
	try {
		const root = ledger.ledgerRoot();
		if (!root) return null;
		const mine = ledger.readCommitsBy(sessionId, root);
		return mine && { root, mine };
	} catch {
		/* A store that throws is a ledger that will not read: no narrowing,
		 * which over-selects. */
		return null;
	}
}

/**
 * readNeighbourCommits' answer, given the launcher's ledger already read.
 *
 * @param {string[]} commits
 * @param {{ root: string, mine: string[] }} own
 * @param {CommitLedger} ledger
 * @returns {Map<string, string>|null}
 */
function readOwnersBesides(commits, { root, mine }, ledger) {
	const ownSet = new Set(mine);
	try {
		return ledger.readOwnersOf(
			commits.filter((c) => !ownSet.has(c)),
			root,
		);
	} catch {
		/* As readOwnLedger's. */
		return null;
	}
}

/** @param {string} out */
const lines = (out) =>
	out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

/**
 * The paths of the tree at `root`'s diff against `base` that this session's
 * own work touches — its own commits in `base..HEAD`, plus its tree's
 * uncommitted tracked files — the neighbours' commits left out, and its own
 * commits kept. Null where the range, the diff or the ledger will not read.
 *
 * EVERY PATH IS ONE THE WHOLE DIFF CARRIES, so a path whose net change since
 * `base` is nil stays out, as it would without narrowing. A merge commit counts
 * against each parent, which over-selects.
 *
 * WHICH UNCOMMITTED FILES ARE THE SESSION'S is the tree's answer, not this
 * one's: an overlay worktree carries only its own (#812), the shared tree
 * everyone's. `tip` reads that commit in HEAD's place and no uncommitted
 * file at all: the re-run guard passes one carrying exactly what the overlay
 * would, so it reads the run's set from the shared tree (#1218).
 *
 * `byPatch` narrows #1154's rule for a caller to whom over-billing is the
 * costly error (#3108): a commit no ledger names is the session's own only
 * where its `git patch-id --stable` matches one of the session's ledgered
 * commits, as a rebase leaves it, and is nobody's otherwise — a pruned ledger's, a pull's, a human's. Test
 * selection keeps the unnarrowed rule, since a missed test is the costlier
 * error there.
 *
 * @param {string} root
 * @param {string} base
 * @param {{ sessionId?: string|null, execFn?: ExecFn, ledger?: CommitLedger,
 *   tip?: string, byPatch?: boolean }} [options]
 * @returns {{ dropped: string[], kept: string[], paths: string[] }|null}
 */
function readOwnPaths(
	root,
	base,
	{ sessionId, execFn, ledger = arbiterLedger, tip, byPatch = false } = {},
) {
	if (!sessionId) return null;
	const log = gitRead(
		[
			"log",
			"--format=%x00%H",
			"--name-only",
			"--no-renames",
			"-m",
			`${base}..${tip ?? "HEAD"}`,
		],
		root,
		execFn,
	);
	if (log === null) return null;
	const touched = pathsByCommit(log);
	const own = readOwnLedger(sessionId, ledger);
	if (!own) return null;
	const neighbours = readOwnersBesides([...touched.keys()], own, ledger);
	if (!neighbours) return null;
	const nobodys = byPatch
		? readUnmatchedUnledgered(
				[...touched.keys()].filter((sha) => !neighbours.has(sha)),
				own.mine,
				root,
				execFn,
			)
		: [];
	if (!nobodys) return null;
	const notOwn = new Set([...neighbours.keys(), ...nobodys]);
	const net = gitRead(
		["diff", "--name-only", "--no-renames", base, ...(tip ? [tip] : [])],
		root,
		execFn,
	);
	const dirty = tip
		? ""
		: gitRead(["diff", "--name-only", "--no-renames", "HEAD"], root, execFn);
	if (net === null || dirty === null) return null;
	const owed = ownedPaths(dirty, touched, notOwn);
	return {
		dropped: [...touched.keys()].filter((sha) => notOwn.has(sha)),
		kept: [...touched.keys()].filter((sha) => !notOwn.has(sha)),
		paths: lines(net).filter((p) => owed.has(p)),
	};
}

/**
 * The commits among `commits` that no ledger names and whose patch matches
 * none of `mine` (#3108) — or null where git will not read. A commit with no
 * patch, a merge's included, matches nothing.
 *
 * Residual: a ledgered commit git has since collected has no patch to match,
 * and a rebase that resolved a conflict in it changes its patch, so either
 * copy reads as nobody's.
 *
 * @param {string[]} commits full shas no other session's ledger names
 * @param {string[]} mine the launcher's ledgered commits
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null}
 */
function readUnmatchedUnledgered(commits, mine, root, execFn) {
	const own = new Set(mine);
	const unledgered = commits.filter((sha) => !own.has(sha));
	if (unledgered.length === 0) return [];
	const theirs = readPatchIds(unledgered, root, execFn);
	const ours = readPatchIds(mine, root, execFn);
	if (!theirs || !ours) return null;
	const matched = new Set(ours.values());
	return unledgered.filter((sha) => !matched.has(theirs.get(sha) ?? ""));
}

/**
 * Each of `commits`' `git patch-id --stable`, by sha, a commit with no patch
 * or that git no longer has left out — or null where git will not answer.
 *
 * @param {string[]} commits
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {Map<string, string>|null}
 */
function readPatchIds(commits, root, execFn) {
	/** @type {Map<string, string>} */
	const ids = new Map();
	if (commits.length === 0) return ids;
	const patches = gitRead(
		// No context lines: a neighbour's edit beside the commit's own, which
		// a rebase carries under it, would otherwise change its patch-id.
		["diff-tree", "--stdin", "--root", "-p", "-U0", "--no-renames"],
		root,
		execFn,
		`${commits.join("\n")}\n`,
	);
	if (patches === null) return null;
	const out = gitRead(["patch-id", "--stable"], root, execFn, patches);
	if (out === null) return null;
	for (const line of lines(out)) {
		const [id, sha] = line.split(" ");
		if (id && sha) ids.set(sha, id);
	}
	return ids;
}

/**
 * Each commit's touched paths, out of a `git log --format=%x00%H --name-only`.
 * @param {string} log
 * @returns {Map<string, Set<string>>}
 */
function pathsByCommit(log) {
	/** @type {Map<string, Set<string>>} */
	const touched = new Map();
	for (const chunk of log.split("\0")) {
		const [sha, ...paths] = lines(chunk);
		if (!sha) continue;
		const set = touched.get(sha) ?? new Set();
		for (const p of paths) set.add(p);
		touched.set(sha, set);
	}
	return touched;
}

/**
 * The uncommitted paths, plus every path a commit not in `notOwn` touched.
 * @param {string} dirty `git diff --name-only` output, or empty
 * @param {Map<string, Set<string>>} touched
 * @param {Set<string>} notOwn the commits that are not the launcher's
 * @returns {Set<string>}
 */
function ownedPaths(dirty, touched, notOwn) {
	const owed = new Set(lines(dirty));
	for (const [sha, paths] of touched)
		if (!notOwn.has(sha)) for (const p of paths) owed.add(p);
	return owed;
}

/**
 * `readOwnPaths` where it leaves a neighbour's commit out, the only set that
 * narrows a diff; else null (#1216).
 *
 * @param {string} root
 * @param {string} base
 * @param {Parameters<typeof readOwnPaths>[2]} [options]
 */
function readOwnWork(root, base, options) {
	const resolved = readOwnPaths(root, base, options);
	return resolved && resolved.dropped.length > 0 ? resolved : null;
}

module.exports = { readNeighbourCommits, readOwnPaths, readOwnWork };
