# ADR-0008 — An empty selection leaves a certificate

**Status:** accepted · 19 September 2026 · settled at #151 (what earns a certificate when the selection is empty, or HEAD moved under you), on map #148 · built by #189

## Context

ADR-0007 keys a certificate to a tree and a read closure. Two questions sit beside it: what a run that selects no test leaves behind, and whether a session re-certifies when a neighbour's push moves HEAD. Measured over the stores on 19 September 2026: 56 full runs, 3 of them on a docs-only commit whose diff reaches no test; the other 53 forced by the post-push empty diff, which ADR-0007's tree-and-closure rule turns into a lookup.

## Decisions

### 1. An empty selection is a narrowed run with zero files, and leaves an ordinary certificate

Its closure is the selection instruments alone — the read-edge manifest and the dependency-graph roots — and its `changedPaths` the diff at launch. Admissibility is unchanged. Its soundness is any narrowed run's: the base is trusted, and the diff's readers ran, vacuously.

### 2. The tree owes nothing beyond ADR-0007's closure rule

A neighbour's dirt outside the closure is ignored; dirt on a root or the manifest voids the certificate by the rule.

### 3. A moved HEAD asks for no re-certification

The `result:` gate asks about the session's own last commit and the push gate about the tip pushed; a neighbour's pushed content is CI's to prove. The launcher does not hint at a full run there.

## Consequences

- A docs-only commit is attested without any test running, on the same instruments narrowing already trusts. The read-edge manifest's completeness bears that weight directly; #157's directory-class edges are what makes it bearable.
- A narrowed run taken before the commit attests it.
