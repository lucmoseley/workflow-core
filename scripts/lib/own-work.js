/*
 * own-work.js — which of the unpushed range is this session's own work
 * (#1156): the one reading every own-work narrowing takes, so no two of them
 * disagree on what "own" means.
 *
 * #1154'S RULE: a commit is a neighbour's where another session's commit
 * ledger names it and the launcher's does not. Every other commit is the
 * launcher's to test, one in no ledger included, so each known miss
 * over-selects.
 */

const arbiterLedger = require("./arbiter-ledger.js");
const { gitRead } = require("./dirty-tree.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/**
 * @typedef {{ ledgerRoot: () => string|null,
 *   commitsBy: (id: string, root?: string) => string[]|null,
 *   ownersOf: (commits: string[], root?: string) => Map<string, string>|null }} CommitLedger
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
function neighbourCommits(commits, sessionId, { ledger = arbiterLedger } = {}) {
	if (!sessionId) return null;
	try {
		const root = ledger.ledgerRoot();
		if (!root) return null;
		const mine = ledger.commitsBy(sessionId, root);
		if (!mine) return null;
		const own = new Set(mine);
		return ledger.ownersOf(
			commits.filter((c) => !own.has(c)),
			root,
		);
	} catch {
		/* A store that throws is a ledger that will not read: no narrowing,
		 * which over-selects. */
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
 * @param {string} root
 * @param {string} base
 * @param {{ sessionId?: string|null, execFn?: ExecFn, ledger?: CommitLedger,
 *   tip?: string }} [options]
 * @returns {{ dropped: string[], kept: string[], paths: string[] }|null}
 */
function ownPaths(root, base, { sessionId, execFn, ledger, tip } = {}) {
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
	const neighbours = neighbourCommits([...touched.keys()], sessionId, {
		ledger,
	});
	if (!neighbours) return null;
	const net = gitRead(
		["diff", "--name-only", "--no-renames", base, ...(tip ? [tip] : [])],
		root,
		execFn,
	);
	const dirty = tip
		? ""
		: gitRead(["diff", "--name-only", "--no-renames", "HEAD"], root, execFn);
	if (net === null || dirty === null) return null;
	const owed = ownedPaths(dirty, touched, neighbours);
	return {
		dropped: [...touched.keys()].filter((sha) => neighbours.has(sha)),
		kept: [...touched.keys()].filter((sha) => !neighbours.has(sha)),
		paths: lines(net).filter((p) => owed.has(p)),
	};
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
 * The uncommitted paths, plus every path a commit not a neighbour's touched.
 * @param {string} dirty `git diff --name-only` output, or empty
 * @param {Map<string, Set<string>>} touched
 * @param {Map<string, string>} neighbours the neighbours' commits, by sha
 * @returns {Set<string>}
 */
function ownedPaths(dirty, touched, neighbours) {
	const owed = new Set(lines(dirty));
	for (const [sha, paths] of touched)
		if (!neighbours.has(sha)) for (const p of paths) owed.add(p);
	return owed;
}

module.exports = { neighbourCommits, ownPaths };
