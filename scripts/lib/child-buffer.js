/*
 * child-buffer.js — the one cap on a child process's output that the scripts
 * pass as `maxBuffer`, alone in a module so a hook can hold it without loading
 * lib/check.js and its exit handlers (workflow-core#1440).
 *
 * Headroom, not a need. Node's 1 MiB default kills a call past it with
 * ENOBUFS, and the widest stream read through it, a whole-history
 * `git log --numstat`, measured 1.2 MB over 6,874 commits on 14 Oct 2026
 * (workflow-core#1440).
 * One figure for every stream, because paging is more code to buy capacity
 * already held. A read sized on its own measurement keeps its own figure:
 * lib/gh.js's full-tracker query, every script blob at once in
 * generate-test-read-edges.js, doc-map.js's patch-text read and others.
 */
const CHILD_MAX_BUFFER = 64e6;

module.exports = { CHILD_MAX_BUFFER };
