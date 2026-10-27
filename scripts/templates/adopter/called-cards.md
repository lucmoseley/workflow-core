# Called cards

Which roadmap cards {{founder}} has opened for work.

**Any session writes this file; calling a card is {{founder}}'s decision.** A session adds a row only for a card called in that session — never to unblock itself, never because a card looks obviously next.

## What reads it

The `guard-issue-phase-scope` core of `guard-dispatch.js`, a `PreToolUse` Bash hook. A `gh issue create` whose title begins `<card-id> — ` is **denied** when that card's phase in `docs/reference-roadmap.html` is not 0 and the card has no row below.

Phase-0 cards need no row, so this register only ever names Phase-1-and-later cards.

## The rule

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **No issue is opened for a roadmap card outside Phase 0 unless the founder has called that card here.** A question you must not lose is written onto the card itself through the `roadmap-edit` skill, as a parked question to re-file when the card is taken. **Enforced**: `scripts/guard-dispatch.js` (its `guard-issue-phase-scope` core), above. Residual: an issue filed by a script, from the web UI, or through a GraphQL mutation escapes.
- **Dropping the `<card-id> — ` prefix to get past that deny is forbidden.** The prefix is the only thing the hook reads, so re-titling files the issue unchallenged. **Unenforceable**: no hook can distinguish a title that never had a card from one that just lost it.
<!-- guard-registry:end -->

## Cards called

<!-- One row per called card: `- <card-id> — <date> — <why it was called>` -->

None yet.
