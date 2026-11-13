/*
 * scratch-dir.js — the repo's one sanctioned scratch directory, `.claude/tmp/`
 * (mantahostels#2089, `docs/environment.md` §12), for every core that names
 * it. A path is tested by its spelling in the session's tree: in a linked
 * worktree, the worktree's own `.claude/tmp/` (workflow-core#4275).
 */

const SCRATCH_DIR = ".claude/tmp/";

/** @param {string} rel a repo-relative path */
const isScratch = (rel) => rel.startsWith(SCRATCH_DIR);

module.exports = { SCRATCH_DIR, isScratch };
