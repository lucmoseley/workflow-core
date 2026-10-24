# Called cards

Which roadmap cards the founder has opened for work.

**Any session writes this file; calling a card is the founder's decision** (mantahostels#3483, reversing mantahostels#1613's founder-only authorship). A session adds a row only for a card the founder has called in that session — never to unblock itself, never because a card looks obviously next.

## What reads it

`scripts/guard-issue-phase-scope.sh`, a `PreToolUse` Bash hook. A `gh issue create` whose title begins `<card-id> — ` is **denied** when that card's phase in `docs/reference-roadmap.html` is not 0 and the card has no row below.

Phase-0 cards need no row. The guard reads the phase off the roadmap and allows them, so this register only ever names Phase-1-and-later cards.

## The rule

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **No issue is opened for a roadmap card outside Phase 0 unless the founder has called that card here.** A question you must not lose is written onto the card itself through the `roadmap-edit` skill, as a parked question to re-file when the card is taken. **Enforced** (mantahostels#1613): `scripts/guard-issue-phase-scope.sh`, a `PreToolUse` Bash hook, denies a `gh issue create` — and the `gh api … POST …/issues` spelling, and the `env`/`command`/`timeout` wrappers — whose title begins `<card-id> — ` for an uncalled non-Phase-0 card. **Do not move this rule into `CLAUDE.md`** — the always-loaded pool is full (mantahostels#1611), and the deny message carries the instruction anyway. Residual: an issue filed by a script, from the web UI, or through a GraphQL mutation escapes.
- **Dropping the `<card-id> — ` prefix to get past that deny is forbidden.** The prefix is the only thing the hook reads, so re-titling files the issue unchallenged: it is an honesty marker, not a syntax rule. Where you believe the work is repo machinery rather than a product, business or legal decision, say so to the founder and let him answer — do not decide it yourself on a ticket you have already resolved to file. **Unenforceable** (mantahostels#1613): no hook can distinguish a title that never had a card from one that just lost it, and a body scan would refuse machinery tickets that merely mention a card.
- **A row is added only for a card the founder has called** — any session may write it, but a session that calls its own card is under no constraint at all. **Unenforced** (mantahostels#3483, mantahostels#1613): nothing checks a row against the founder's instruction, and the guard reads this file from disk, so an uncommitted row counts.
<!-- guard-registry:end -->

## Removing a row

Any session takes the row out when the card is finished (`/card-close`) or set down again — no founder instruction needed. Nothing expires a row, and a stale row silently re-opens the card to new tickets.

## The register

One row per called card, newest last, in the form:

```
- `card-id` — called D Month YYYY
```

The guard reads the backticked id and ignores everything after it, so the date is for you. Rows outside the two markers are not read.

<!-- called-cards:begin -->
<!-- No card is called. Every Phase-1-and-later card refuses new issues. -->
<!-- called-cards:end -->
