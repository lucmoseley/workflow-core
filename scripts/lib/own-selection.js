/*
 * own-selection.js — which of the tree's changes are THIS session's own work:
 * `--isolated`'s dirty-tree refusal (mantahostels#2169, mantahostels#2196), the
 * overlay a run reads (workflow-core#812, workflow-core#1220) and the own-work selection a bare run
 * narrows to (workflow-core#1216).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
/* Attribution for `--isolated`'s dirty-tree refusal — whose uncommitted work
 * a frozen worktree would leave out. */
const arbiterStore = require("./arbiter-store");
const { claimedElsewhere } = require("./neighbour-dirt.js");
const idSeam = require("./session-id.js");
const { ownPaths } = require("./own-work.js");
const {
	GIT_TIMEOUT_MS,
	gitRead,
	trackedStatus,
	untrackedFiles,
} = require("./dirty-tree.js");
const { defaultChangedBase, diffNames } = require("./changed-selection.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/** @typedef {{ path: string, at: number }} Quote a selection-ledger entry (workflow-core#1220) */
/**
 * @typedef {{ writesBy: (id: string) => string[]|null,
 *   selectsBy?: (id: string) => Quote[]|null,
 *   landedBy?: (id: string) => Set<string>|null }
 *   & import("./neighbour-dirt.js").LockSource} Ledger
 */

/**
 * Which of `dirty` this session made, and which belong to someone else.
 *
 * ATTRIBUTION IS THE WHOLE POINT (mantahostels#2169, which asked for a refusal on any
 * dirty tree). This tree is never clean, so a whole-tree check would refuse
 * every isolated run this machine will ever start. The ledger intersection
 * `scripts/guard-uncommitted-work.js` already uses separates the two: `mine`
 * refuses, `theirs` only warns, because escaping a neighbour's churn is what a
 * worktree at HEAD is for.
 *
 * `writesBy` answers "did this session ever write this path", never "is this
 * dirt this session made", so a live neighbour's claim is subtracted — the
 * mantahostels#63 shape, spelled out in `lib/neighbour-dirt.js`.
 *
 * A session that cannot be named, or a ledger that will not read, attributes
 * NOTHING: `mine` is empty and the whole dirty set warns. That keeps the flag
 * usable from a hook or CI, where no session id exists.
 *
 * A BASH WRITE COUNTS ONLY ON A CODE PATH (mantahostels#2778). The ledger is
 * filled by a `PostToolUse` hook on `Write`/`Edit`/`NotebookEdit`, so a file
 * this session wrote from Bash — a `>` redirect, a heredoc, `sed -i`, a
 * generator — mints no entry there (mantahostels#296). A CODE path —
 * concision-backstop.sh's globs, owned for this purpose by
 * `guard-claimed-bash-write.sh`'s `CODE_EXT`/`CODE_DIR`: a
 * `.js/.mjs/.cjs/.ts/.tsx/.jsx/.py/.sh` extension, or anything under `.husky/`
 * — that `guard-claimed-bash-write.sh` resolved LITERALLY at `PreToolUse`, and
 * on which no other live session holds a READABLE claim, IS credited: it lands
 * in `mine` and refuses under `--isolated`. The rest still lands in `theirs`,
 * warned about rather than silently run past: a non-code path, a target the
 * parser could not resolve, one a live neighbour holds readably, everything at
 * all where the WHOLE lock store will not read, and everything where the hook
 * payload carried no session id. `mine` inherits that credit's two over-bills:
 * an unparseable neighbour lock is not contention, and the credit is INTENT, so
 * an entry outlives a command that was denied or failed.
 *
 * QUOTES COUNT ONLY FOR AN OVERLAY (workflow-core#1220). Given `committedAt`, a path an
 * inline `python`/`node` program quoted — the selection ledger, which
 * guard-claimed-bash-write.sh writes — is `mine` too, where it was quoted after
 * its last commit. A quote may have been a read, so this over-selects, which a
 * test run can afford and `--isolated`'s refusal cannot: that caller passes no
 * `committedAt`, so `quoted` — the paths only a quote put in `mine` — is
 * always empty there. A selection ledger that will not read costs the quotes
 * alone, never the write ledger's attribution.
 *
 * A FILE WHOSE OWN HUNKS ALL LANDED IS NOT `mine` (workflow-core#2539). A `--patch` commit
 * out of a file a neighbour is also editing leaves it dirty and in the write
 * ledger, so the overlay would carry the neighbour's hunks without the rest of
 * their work. `landedBy` names each file the release judged so (workflow-core#2148) and
 * the session has not written since; a ledger that will not read subtracts
 * nothing.
 *
 * A STAGED RENAME IS ONE ACT (workflow-core#1791). `git mv` runs through Bash and mints no
 * write, so its source — gone from the shared tree — was nobody's. Where either
 * side is `mine`, the other is too; a deletion tied to nothing stays `theirs`.
 *
 * @param {string[]} dirty tracked paths with modifications
 * @param {{ sessionId?: string|null, ledger?: Ledger, untracked?: string[],
 *   renames?: { path: string, source: string }[],
 *   committedAt?: (p: string) => number }} [options] `committedAt` answers a
 *   path's last commit in ms, 0 where it has none; `renames` are the staged
 *   ones, as `trackedStatus` reads them
 * @returns {{ mine: string[], theirs: string[], quoted: string[] }}
 */
function attributeDirty(
	dirty,
	{
		sessionId = idSeam.fromEnv(),
		ledger = arbiterStore,
		untracked = [],
		renames = [],
		committedAt,
	} = {},
) {
	/* THE WHOLE ARBITER READ IS GUARDED. A store this cannot read costs the
	 * store and never the suite; unguarded, a throw out of a foreign module
	 * surfaces as `run-vitest.js crashed:` and exit 1, which reads to a session
	 * exactly like a red suite (mantahostels#2169). */
	/** @type {string[]|null} */
	let written = null;
	/** @type {string[]} */
	let quoted = [];
	/** @type {Set<string>} */
	let held = new Set();
	try {
		if (sessionId) written = ledger.writesBy(sessionId);
	} catch {
		written = null;
	}
	try {
		if (sessionId && committedAt && written) {
			const wrote = new Set(written);
			quoted = freshQuotes(
				ledger.selectsBy?.(sessionId) ?? [],
				new Set([...dirty, ...untracked].filter((p) => !wrote.has(p))),
				committedAt,
			);
		}
	} catch {
		quoted = [];
	}
	try {
		if (sessionId && ((written && written.length > 0) || quoted.length > 0))
			held = claimedElsewhere(sessionId, ledger);
	} catch {
		written = null;
	}
	written = withoutLanded(sessionId, written, ledger);
	if (written && quoted.length > 0) written = [...written, ...quoted];
	if (!written || written.length === 0)
		return { mine: [], theirs: [...dirty].sort(), quoted: [] };
	/* An untracked path enters `mine` or nothing at all — see `untrackedFiles`. */
	const own = ownOf([...dirty, ...untracked], written, held, renames);
	return {
		mine: [...own].sort(),
		theirs: dirty.filter((p) => !own.has(p)).sort(),
		quoted: quoted.filter((p) => own.has(p)).sort(),
	};
}

/**
 * `written` less each path whose own hunks have all landed (workflow-core#2539).
 *
 * @param {string|null|undefined} sessionId
 * @param {string[]|null} written
 * @param {Ledger} ledger
 * @returns {string[]|null}
 */
function withoutLanded(sessionId, written, ledger) {
	if (!sessionId || !written || written.length === 0 || !ledger.landedBy)
		return written;
	try {
		const landed = ledger.landedBy(sessionId);
		return landed ? written.filter((p) => !landed.has(p)) : written;
	} catch {
		/* guarded as the arbiter read above is (mantahostels#2169) */
		return written;
	}
}

/**
 * `attributeDirty`'s `mine`, as a set: each of `paths` this session wrote and
 * no live neighbour holds, plus the other side of each rename one side of
 * which is among them (workflow-core#1791).
 *
 * @param {string[]} paths
 * @param {string[]} written
 * @param {Set<string>} held
 * @param {{ path: string, source: string }[]} renames
 * @returns {Set<string>}
 */
function ownOf(paths, written, held, renames) {
	const own = new Set(paths.filter((p) => written.includes(p) && !held.has(p)));
	for (const { path: to, source } of renames) {
		if (own.has(to) && !held.has(source)) own.add(source);
		else if (own.has(source) && !held.has(to)) own.add(to);
	}
	return own;
}

/**
 * The quoted paths among `candidates` whose newest quote is later than their
 * last commit. Asked of the candidates alone, one `committedAt` each.
 *
 * @param {Quote[]} entries
 * @param {Set<string>} candidates
 * @param {(p: string) => number} committedAt
 * @returns {string[]}
 */
function freshQuotes(entries, candidates, committedAt) {
	return entries
		.filter((e) => candidates.has(e.path) && e.at > committedAt(e.path))
		.map((e) => e.path);
}

/**
 * When `rel` was last committed, in ms — 0 where it never was, or git would
 * not say, which reads every quote of it as fresh (workflow-core#1220).
 *
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {(rel: string) => number}
 */
const lastCommitAt = (root, execFn) => (rel) =>
	Number(gitRead(["log", "-1", "--format=%ct", "--", rel], root, execFn)) *
		1000 || 0;

/**
 * A commit carrying HEAD plus `mine` as the shared tree has them — the tree the
 * run's overlay reads — or `head` itself where `mine` is empty. Written under a
 * throwaway index and referenced by nothing, as `git stash create` does, so gc
 * takes it. Null where git refuses.
 *
 * @param {string} root
 * @param {string} head
 * @param {string[]} mine
 * @param {ExecFn} [execFn]
 * @returns {string|null}
 */
function overlayCommit(root, head, mine, execFn = execFileSync) {
	if (mine.length === 0) return head;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-commit-"));
	const env = {
		...process.env,
		GIT_INDEX_FILE: path.join(dir, "index"),
		GIT_AUTHOR_NAME: "overlay-commit",
		GIT_AUTHOR_EMAIL: "overlay-commit@localhost",
		GIT_COMMITTER_NAME: "overlay-commit",
		GIT_COMMITTER_EMAIL: "overlay-commit@localhost",
	};
	/** @param {string[]} args */
	const run = (args) =>
		String(
			execFn("git", args, {
				cwd: root,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}) ?? "",
		).trim();
	try {
		run(["read-tree", head]);
		run(["add", "-A", "--", ...mine]);
		return run([
			"commit-tree",
			run(["write-tree"]),
			"-p",
			head,
			"-m",
			"overlay",
		]);
	} catch {
		return null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * What a run with the session's id would test, read from the tree at `root`
 * without building the overlay — the one reading the re-run guard (workflow-core#1218) and
 * the queue's probes (workflow-core#1221) take: `base`, the bare run's; `tip`, the overlay's
 * commit; `mine`, the uncommitted files it carries; `uncommitted`, the paths
 * `tip` changes against HEAD, which `npm run test:changed` selects from;
 * `net`, those it changes against `base`; and `scoped`, the range's own paths
 * and the neighbour commits left out — null where none is left out, or where
 * the commits could not be read, which `unread` then says. `uncommitted` and
 * `net` are null where git will not diff. Null where git will not say what is
 * uncommitted or will not write the overlay.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {{ ledger?: Ledger, execFn?: ExecFn,
 *   commitLedger?: import("./own-work.js").CommitLedger }} [seams]
 * @returns {{ base: string, tip: string, mine: string[],
 *   uncommitted: string[]|null, net: string[]|null,
 *   scoped: { paths: string[], dropped: string[] }|null, unread: string|null }|null}
 */
function ownSelection(
	root,
	sessionId,
	{ ledger, commitLedger, execFn = execFileSync } = {},
) {
	const status = trackedStatus(root, execFn);
	const head = gitRead(["rev-parse", "HEAD"], root, execFn)?.trim();
	if (status === null || !head) return null;
	/* `?? []` as `sweepAndAttribute` reads it. */
	const untracked = untrackedFiles(root, execFn) ?? [];
	/* `committedAt` as the overlay passes it, so a file an inline program
	 * quoted is own work here too (workflow-core#1220). */
	const { mine } = attributeDirty(status.dirty, {
		sessionId,
		untracked,
		renames: status.renames,
		ledger,
		committedAt: lastCommitAt(root, execFn),
	});
	const tip = overlayCommit(root, head, mine, execFn);
	if (tip === null) return null;
	const base = defaultChangedBase(root, execFn);
	const resolved = ownPaths(root, base, {
		sessionId,
		tip,
		execFn,
		ledger: commitLedger,
	});
	return {
		base,
		tip,
		mine,
		uncommitted: mine.length > 0 ? diffNames(root, "HEAD", tip, execFn) : [],
		net: diffNames(root, base, tip, execFn),
		scoped:
			resolved && resolved.dropped.length > 0
				? { paths: resolved.paths, dropped: resolved.dropped }
				: null,
		unread: resolved
			? null
			: "this session's own commits could not be told from a neighbour's (commit ledger or git unreadable), so cover was judged on the whole range",
	};
}

module.exports = {
	attributeDirty,
	lastCommitAt,
	ownSelection,
};
