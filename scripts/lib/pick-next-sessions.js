/*
 * pick-next-sessions.js — what scripts/pick-next.js decides off the session
 * listing and the claim store: who holds a claim, for a reader; whether the
 * store it read claims from is the tree they were filed under (mantahostels#703);
 * and which finished sessions are still resident (mantahostels#421).
 *
 * Out of pick-next.js so each decision is tested by calling it (#4329). The
 * reads stay there: the oracle listing, the arbiter store, the env. What
 * comes in is what they returned; the tree comparison runs git and realpath
 * on the two directories it is handed, which is all it reads.
 */

const fs = require("node:fs");
const nodePath = require("node:path");
const { gitDirs } = require("./git.js");
const { holderName } = require("./parent-claims.js");

/** @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions */

/**
 * Who holds a claim, for a reader. The assignee is what a person recognises; the
 * claim's own session is all there is where a session recorded without assigning
 * itself, and that claim is in flight all the same.
 *
 * NAMED, NOT NUMBERED. `names` is the oracle's id -> display name map, so the
 * row reads `session Implement 708` rather than a bare uuid. It falls back to a
 * short id where the oracle named nothing.
 *
 * A DEGRADED READ NEVER ASSERTS LIVENESS (mantahostels#708).
 * @param {string[]|null|undefined} assignees
 * @param {string|null|undefined} session
 * @param {boolean|undefined} kept
 * @param {Map<string, string>|null|undefined} names
 * @returns {string}
 */
function claimHolder(assignees, session, kept, names) {
	const who =
		assignees && assignees.length > 0
			? assignees.join(", ")
			: `session ${holderName(names, session)}`;
	return kept ? `${who}, liveness unread` : who;
}

/**
 * The same directory named two ways, or `null` where either cannot be resolved.
 * Symlinks are followed: a worktree and its canonical checkout are genuinely
 * different trees, but `/home/x` and a symlink to it are one.
 * @param {string} dir
 * @returns {string|null}
 */
function readRealOrNull(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

/**
 * The canonical checkout of the tree at `dir`, or null where git cannot say.
 *
 * `--git-common-dir` is the same `.git` from inside a linked worktree as from
 * inside the checkout that owns it, so its parent is the canonical tree —
 * which `--show-toplevel` is not, and cannot be made to be.
 *
 * BUT ONLY WHERE THE TWO GIT DIRS DIFFER, which is what makes a tree a linked
 * worktree. Taking the parent unconditionally misreads a submodule, whose
 * common dir is `<super>/.git/modules/<name>` — a real directory that is no
 * checkout, so the run would announce a "worktree of" a tree nobody has.
 * @param {string} dir
 * @returns {string|null}
 */
function readCanonicalCheckoutOf(dir) {
	const dirs = gitDirs(dir);
	if (!dirs) return null;
	const { gitDir, common } = dirs;
	return gitDir === common
		? readRealOrNull(dir)
		: readRealOrNull(nodePath.dirname(common));
}

/*
 * WHICH TREE THE CLAIMS CAME FROM (mantahostels#703).
 *
 * pick-next.js pins its repo with WFC_REPO_ROOT; the arbiter store derives its
 * own state directory from CLAUDE_PROJECT_DIR, falling back to `git rev-parse`
 * of the working directory.
 *
 * THE INVARIANT IS NOT THAT THE TWO ROOTS AGREE. It is that the store's tree is
 * the tree the claims were filed under. Neither variable is set in this
 * project's own environment, so a run from a throwaway worktree has both sides
 * resolving independently to that worktree; they agree, and the store is still
 * the wrong one, because every claim was filed under the slug of the canonical
 * checkout.
 *
 * The failure that matters is silence: a store resolving cleanly to the wrong
 * empty directory reads exactly like a genuinely unclaimed frontier, so the
 * fail-open mantahostels#633 chose happens without the announcement mantahostels#645 built for it.
 */

/**
 * Where the claim store keyed on `storeRoot` is not the tree a run pinned to
 * `repoRoot` files its claims under: `{why, use}`, the sentence and the tree
 * whose store holds the claims the run should have read. Null where they are
 * one tree, or where either cannot be resolved.
 * @param {string} repoRoot the tree the run pins
 * @param {string} storeRoot the tree the arbiter store resolved to
 * @returns {{why: string, use: string}|null}
 */
function storeElsewhere(repoRoot, storeRoot) {
	const mine = readRealOrNull(repoRoot);
	const theirs = readRealOrNull(storeRoot);
	if (!mine || !theirs) return null;
	/*
	 * ONE COMPARISON, NOT TWO. `want` is the tree this run's claims are filed
	 * under — the canonical checkout of the repo it pins, since a session
	 * claiming from a worktree files under that.
	 */
	const want = readCanonicalCheckoutOf(mine) || mine;
	if (want === theirs) return null;
	const canonical = readCanonicalCheckoutOf(theirs);
	return {
		why:
			canonical && canonical !== theirs
				? `the claim store is keyed on ${theirs}, a linked worktree of ${canonical} — claims are filed under the canonical checkout`
				: `the claim store resolves to ${theirs}, not the tree this run's claims are filed under (${want})`,
		use: want,
	};
}

/**
 * The claims read, told where the store they came from is not this tree's
 * (`storeElsewhere`). The claims themselves are kept: they are claims on the
 * same tracker, so excluding on them is still safer than calling an issue free.
 *
 * NEVER OVERWRITES `claims.why`: a corrupt record (mantahostels#1186) can set it
 * alongside `elsewhere`, and losing it here silently under-reports again. The
 * divergence leads, since whatever the oracle said, it said about another
 * tree's claims.
 * @template {{why: string|null}} C
 * @param {C} claims
 * @param {{why: string, use: string}|null} elsewhere
 * @returns {C & {claimsTree?: string|null}}
 */
function claimsFromStore(claims, elsewhere) {
	return elsewhere
		? {
				...claims,
				why: claims.why
					? `${elsewhere.why}; also, ${claims.why}`
					: elsewhere.why,
				claimsTree: elsewhere.use,
			}
		: claims;
}

/**
 * How much of the memory the admission arithmetic just called spent belongs to
 * sessions that have FINISHED and not exited (mantahostels#421).
 *
 * REPORT ONLY — pick-next reaps nothing (mantahostels#1029). The reaper keeps its single
 * `SessionStart` trigger. The standing reason is the oracle spawn this would
 * pay against the very figure it is measuring (mantahostels#653). The second reason is now
 * MOOT, not weakened: `GRACE_MS` is 0 (mantahostels#1290), so a session that finishes
 * DURING the run is credited at the very next admission read and reaped by
 * the burst's own session starts — there is no pool left for a reap here to
 * decline. mantahostels#1029 stands on the spawn cost alone.
 * @param {ListedSessions} listed
 * @param {string|null} me this run's session id, null where it is unset
 * @returns {{ok: false, error: string}|{ok: true, count: number, ids: string[]}}
 */
function reclaimableFrom(listed, me) {
	/* Tested on `finished` rather than on `why`: the two are the same condition
	 * — the reader answers with every set or with `why` alone — and `finished`
	 * is the field actually read below (mantahostels#1460). */
	if (!listed.finished) return { ok: false, error: listed.why };
	/*
	 * Without an id the run cannot tell itself apart from the pool, and a count
	 * that may include this very session promises headroom stopping it could
	 * never return. The reaper refuses on the same unset variable.
	 */
	if (!me)
		return {
			ok: false,
			error:
				"CLAUDE_CODE_SESSION_ID is unset, so this run cannot be told apart from the finished sessions it would count",
		};
	const finished = [...listed.finished].filter((id) => id !== me);
	return { ok: true, count: finished.length, ids: finished };
}

module.exports = {
	claimHolder,
	claimsFromStore,
	reclaimableFrom,
	storeElsewhere,
};
