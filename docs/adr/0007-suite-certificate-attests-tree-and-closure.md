# ADR-0007 — A suite certificate attests a tree and a read closure, not a commit sha

**Status:** accepted · 19 September 2026 · settled at #150 (should a suite certificate attest the commit sha, or the content it actually tested), on map #148 · built by #189

## Context

A certificate keyed only to the commit sha HEAD held when it finished is voided by the session's own commit, by its push and by a neighbour's push, even when the content it tested is byte-identical to what now needs attesting. #148 traced its two largest mechanical drivers of unnecessary full-suite runs — the empty-diff trap and the moved sha — to that key.

Measured on 19 September 2026 over the certificate store: 292 of 353 tree-stamped runs ended on a dirty shared tree; only 101 of 353 end-trees equal any commit's tree. Whole-tree identity alone therefore reaches the full runs and almost none of the narrowed majority, because a neighbour's half-saved file is in the tree the run read.

## Decisions

### 1. A certificate attests a tree plus the read closure of what it ran

A marker records `treeAtEnd`, the tracked tree's identity as the run finished; `closure`, the paths its verdict depends on; and `changedPaths`, the diff paths its selection was computed from. A full run's closure is every tracked path.

### 2. A certificate holds at a sha whose tree leaves its closure untouched

A marker holds at sha S when it names S, or when the diff between `treeAtEnd` and S's tree touches nothing in its closure. With a whole-tree closure that is tree equality. With the `landing` module on, only a change to a path in the push's range counts (ADR-0009). A marker without a closure holds at its own sha only. Whether S's range was selected for is asked of the whole set of holding certificates (ADR-0009).

### 3. The closure is import graph plus manifest, and inherits the manifest's lexical gap

Selected test files, their transitive imports from vitest's module graph (reachable from a reporter through public Vite types, as vitest's own `BlobReporter` does), the documents `docs/test-read-edges.json` maps to them, and the dependency-graph roots the launcher escalates on. A document read through an imported helper is outside the closure — the gap narrowing already carries, accepted here rather than closed.

### 4. A narrowed run over a dirty shared tree may attest a commit

Whenever the paths differing between the end-tree and the commit's tree lie outside the closure. A neighbour's dirty file inside the closure voids it by the rule itself.

### 5. Both gates call one predicate, and the push gate stays warn-only

`scripts/lib/test-pass-marker.js` answers for the push gate, of the pushed tip, and for the `result:` gate, of the session's last commit. mantahostels#908's warn-only ruling stands.

## Consequences

- A session that commits after a narrowed run's certificate over its own edits, with a neighbour's dirt outside its closure, is attested without a second run.
- A change to a dependency-graph root voids every narrowed certificate, as it escalates every narrowed run.
- The lexical gap stays: a test reading a changed document through an imported helper is attested against a document it never saw change. #157's directory-class extractor narrows it; nothing here closes it.
