# {{project}} document map

v1.0 · {{date}}

> **Section A** says what each document is and who may edit it, rendered from `docs/doc-map-classes.json` by the generator §Section A — document register names. **Section B** is the figure registry: a number or claim restated in more than one place, with its owner. **Section C** routes a question to the document that answers it. The pre-commit doc-map gate checks all three, and refuses a `docs/doc-map.md §<name>` reference that names no section here, outside binary assets and tests. **§The propagation pass** carries a settled fact to every copy of it.

---

## Authority classes

| Class | Meaning | Update route |
|---|---|---|
| `source-of-truth` | Owns facts nothing else may contradict | Direct, or via the named skill |
| `derived` | Regenerated from a source; hand-editing breaks CI | Regenerate only |
| `generated-only` | Re-synthesised wholesale by a skill | That skill only |
| `free-edit` | Working material with no authority | Direct |
| `binary-asset` | A non-text file | Replace wholesale |

## Section A — document register

**The tables below are generated. Never edit a row by hand** — register the document with `register-doc.js <path> --class <token> --section <name>`, which writes one key to `docs/doc-map-classes.json`, then re-render §A with the generator; each doc-map gate refusal that needs one prints its command at the plugin root. `--class` takes one of the five tokens in §Authority classes. `--section` must spell a heading below exactly, and `--new-section` mints a new one. `role`, `route` and `consumes` override a generated default, written only where the row must carry what the default cannot; `reader` (`agent`, `human` or `both`) is required on every `.md` and `.html` key. The prose around the tables, this included, is hand-written, and the generator keeps it byte for byte.

**Registering a document owes an orphan check**, unless its subsection is in `register-doc.js`'s `ORPHAN_CHECK_EXEMPT`. Read the file for a commitment — work, a decision or a constraint carrying a completion condition — that names no card and no issue, and give a hit its owner in the same session: a card, or an issue. A ruling not yet made goes to the founder priced first.

**A `consumes` gloss scopes to the reference it hangs on.** Where it also covers the reference immediately before it, open it `with <other-ref>: `, spelling that reference as §A prints it — the gate FAILs a prefix naming anything else.

### Repo-root contracts

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|

## Section B — load-bearing figure registry

Every entry: **Owner** (the one document allowed to change it) · **Inputs** (what it is derived from — change one and the figure is re-derived) · **Restated in** (every file carrying it) · **Supersedes** (the value it replaced, so a stale copy is recognisable on sight) · **Settled at** (the ticket that decided it — `**Settled at #<n>**`, or `**Settled at:** none — <why>`). **An entry is a map, not a record**: the live value, what a reader does with it, and what invalidates it. Derivation and measurement narrative go to the settling ticket.

- **What earns an entry: a load-bearing fact about the project's world** — product, business, the law binding it. **A ruling about the repo's own machinery earns none**; it goes to its owner document or its ticket. **Ties default to no**: unable to tell which subject a fact is, write no entry and record it on the issue you are working.
- **The write is not unilateral.** Record the fact on the issue you are working; it enters §B when the founder confirms it belongs. **Post the confirmation on the settling issue before the entry is written** — his words verbatim, or the bare option letter he answered — and add a row to `docs/doc-map-admissions.json` naming the issue, his answer and that comment's permalink, or the gate FAILs the commit.
- **The writer verifies.** An entry is written only by a session that has re-derived the value against the files and searched **closed** issues for prior rulings on it.

**An entry carries at most 300 words of prose**, its skeleton bullets aside; a new entry over cap is refused. **The cap binds on touch:** a session editing an over-cap entry brings it under 300 in that edit, cutting surplus wording and never a claim. One that cannot reach 300 without dropping a claim stays over and says so in a top-level bullet of exactly this shape, the ruling ticket in the parentheses:

```
- **Over cap by ruling (#<n>):** every claim here is load-bearing — never cut one to reach 300; read the count from `overCapEntries()`.
```

A marked entry may not grow, and an entry carrying no marker asserts nothing about whether its claims are cuttable.

**A new id sits above `highWaterMark` in `docs/doc-map-high-water.json`, and an id is never renumbered**; take one with `session-arbiter.js alloc-entry docs/doc-map.md`. A commit removing an entry raises the mark to its id where the mark is lower. **The machine-parsed lists live in data files keyed by `B<n>`** — `docs/doc-map-restatements.json`, `docs/doc-map-retired-vocabulary.json`, `docs/doc-map-superseded.json` — and the entry keeps one of three pointer bullets:

```
- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.
- **Restated in:** none — <one clause saying why>.
- **Supersedes:** see `docs/doc-map-superseded.json`.
```

A locator pins a sentence by its `§` section or a verbatim `"quoted phrase"`, never a line number. A claim entry carries no number, so it carries a retired vocabulary — the phrases a stale copy will use — with its legitimate hits and a `Replacement:` line.

None registered.

## Section C — question routes

None registered.

## The propagation pass

Run this whenever a settled, load-bearing fact has to reach the corpus.

**0. Is the fact pinned?** Value final, basis checked against the files, every prior ruling found → run the pass. Not pinned → settle it first. Too large for one session → split it into tickets by blast radius. Finding the input wrong mid-pass, stop and hand back, unless the fix is mechanical recomputation with no choice in it — then post the working on the settling ticket.

**1. Walk §B to fixpoint.** For each entry the fact touches — including those whose **inputs** it changes — walk **owner → inputs → restated-in**, owner first: a consumer edited before its owner is a fork. Read the whole owner document, not just the cited section. **Re-derive dependent figures rather than substituting strings**, and record the supersession in the entry. Repeat over the entries that round changed until a round adds none.

**2. Search as well.** Grep the figure and every value it supersedes — for a claim, its retired vocabulary's stems — checking each hit against the entry's legitimate-hits list. Then read for the claim as stated, not as worded. A round searches only what the previous round newly pulled in.

**3. Dismiss §A group-wise, by subsection and class**, each group with a touch/no-touch verdict and a stated reason. `derived` → edit its generator and regenerate; `generated-only` → only through its skill; `free-edit` / `source-of-truth` → direct edit; `binary-asset` → never a target.

**4. Write back into §B** every restatement the search found that §B did not list, in the same commit.

**5. One adversarial subagent**, which never edits and accuses in both directions — un-made edits *and* edits that reached past the fact. It may reopen the loop once; a second reopen hands the work back, the input never having been pinned.

**6. Audit trail**: a coverage table (one row per §B entry and per §A group, with verdict and reason, plus the write-back list) and the adversary's accusations in full, including those rejected and why.
