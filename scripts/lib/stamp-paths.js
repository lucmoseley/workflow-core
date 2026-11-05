/*
 * stamp-paths.js — the stamp allowlist: files written once at the end of a
 * ticket to record its result, so issues sharing one run together. A file
 * earns a place only by a ruling that they do (docs/doc-map.md, mantahostels#422;
 * CLAUDE.md, mantahostels#1281), never by how many candidates name it.
 *
 * Callers: lib/conflict-graph.js, lib/refill-decide.js
 */

const STAMP_PATHS = ["docs/doc-map.md", "CLAUDE.md"];

module.exports = { STAMP_PATHS };
