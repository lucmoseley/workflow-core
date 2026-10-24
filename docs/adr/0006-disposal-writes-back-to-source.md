# ADR-0006 — A disposal writes back to the source that declared the item

**Status:** accepted · 6 September 2026 · settled at mantahostels#3205 (what, if anything, writes back into the document that declared a finding once that finding is disposed of)

## Context

`mantahostels#3197` (the corpus sweep on map mantahostels#3182) measured the dominant cost of a roadmap-completeness sweep and found it was not finding candidates — it was re-deriving candidates already discharged. **The tracker held every disposal and no source document held any of them.** The four instances it found in that one pass are on mantahostels#3205.

## Decisions

### 1. The write-back is owed only where the source declares the item open in its own words

Not on every mention, and not on every file a sweep read. The trigger is a **declaration**: text in which the source itself asserts that something is outstanding and unowned — a numbered gap ledger, a `Disposition: worth a ticket` row, a "no card covers this" sentence, a "parked — revisit as a card" note.

A file that merely discusses an area, restates a figure, or was read while a sweep passed over it is owed nothing.

### 2. The route is the source's own authority class

- **`source-of-truth` and `free-edit`** — the declaring line is **edited in place** to name its owner, or deleted.
- **`derived` and `generated-only`** — the write-back goes to the generator's input or it goes nowhere. Never a hand edit, per §A.

### 3. Where the declaration is an aged sidecar marker, it is cleared there

A declaration living in the file's `docs/doc-map-classes.json` `role` whose text carries one of `scripts/check-doc-map-markers.js`'s `NEVER_PERMANENT` phrases is aged from the sidecar and from nowhere else. Clearing the sidecar marker *is* the write-back.

### 4. It is written by the session that disposes, in the same session

There is no queue (mantahostels#2748) and no backfill ticket. A disposal that lands its card change and leaves the source declaring an orphan has not finished.

### 5. What the write-back has to say

An edited line names the owning card slug or issue number, and that the item is discharged; a line saying only "this is handled" strands the reader who has to check. A deleted line names its owner in the commit message.

## Consequences

- `.claude/skills/card-close/SKILL.md`, `.claude/skills/roadmap-edit/SKILL.md` and `scripts/inject-tracker-docs.sh`'s `/wayfinder` clause carry the trigger, so the duty reaches a session at the moment of the act; `scripts/write-back-routes.test.ts` holds the three to the routes above.
- **Nothing enforces this.** mantahostels#3184 ruled that the expensive half of a sweep is ruling out restatements, which no script can do, and a lexical gate would fire on every already-disposed "no card covers" line as loudly as on a live one.
