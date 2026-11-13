# Domain Docs

This is a **single-context** repo: one `GLOSSARY.md` at the root, one `docs/adr/`.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

A whole-file `concision-pass` or `writing-for-agents` pass over `GLOSSARY.md`
runs under the auditing session's own authority and needs no `/domain-modeling`
session: that skill governs *admitting meaning* — settling or adding a term —
never wording, so a pass that changes no term's meaning sits outside it
(mantahostels#896).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly.

Strategy and business reasoning are not domain docs — they live in `docs/operating-manual.md`, under its own authority rules (see `docs/doc-map.md`).
