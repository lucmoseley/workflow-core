/*
 * scratch-dir.js — the repo's one sanctioned scratch directory, `.claude/tmp/`
 * (mantahostels#2089, `docs/environment.md` §12), for every core that names
 * it. A path is tested by its spelling in the session's tree: in a linked
 * worktree, the worktree's own `.claude/tmp/` (#4275). The claim store keys a
 * worktree's file by its path from the host root, `.claude/worktrees/<n>/…`,
 * so a core must test the session-tree spelling before the store sees it.
 */

const SCRATCH_DIR = ".claude/tmp/";

/** @param {string} rel a repo-relative path */
const isScratch = (rel) => rel.startsWith(SCRATCH_DIR);

module.exports = { SCRATCH_DIR, isScratch };
