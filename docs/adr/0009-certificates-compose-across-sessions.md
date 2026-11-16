# ADR-0009 — Certificates from different sessions combine to attest a commit

**Status:** accepted · 1 October 2026 · settled at #789 (what a push must prove about commits another session made), on map #786

## Context

In the shared tree a neighbour's commit can land between your run and your commit, so the commit's range holds paths your run did not select for. Each such commit usually has its author's own certificate. A neighbour commit made before your run is already inside your `changedPaths`.

#788 found the range rule identical in every adopter, so one change in core reaches all of them by release and pin.

## Decision

A commit is attested when a set of certificates attests it. Each must hold at the commit by ADR-0007's closure rule, and every path in the commit's range must lie in some member's `changedPaths`; a full-run member attests every path. A single certificate is the one-member case. Every reader shares this one predicate (`attestationOf`, `scripts/lib/test-pass-marker.js`).

A neighbour change that reaches your closure still fails your certificate's closure rule, so you re-run. A commit no certificate selected for, such as a hand commit, is unattested. Only a change to a path in the commit's range counts against a closure: a change already on `main`, such as a clean reconcile merge brings in, is the lander's full run's to test with yours (#2517).

A range answers for every commit in it, not only its author's; a neighbour's path outside your closure needs a certificate of its own.

## Consequences

- **Composition adds one class of miss.** No run executes the combined tree, so two commits that interact through a read no closure records (mantahostels#2131's indirect reads) are seen by nobody locally. The queue lander's full run is the backstop.
