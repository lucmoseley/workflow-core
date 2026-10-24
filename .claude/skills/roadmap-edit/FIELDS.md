# The `ITEMS` schema — field rules

Reference for [`roadmap-edit`](SKILL.md). Each card in `const ITEMS = [...]` is
an object. [SKILL.md](SKILL.md) §What a card holds says what may sit on a card
at all; this file says which field it lands in.

**Where two fields carry the same sentence, the field this file assigns that
subject keeps it and the other cuts** (mantahostels#3187, sourcing mantahostels#3017's fourth
finding). Paraphrase counts, not just a verbatim repetition.

- `id` — short kebab-case, unique, stable. Other cards reference it in `needs`
  and in body text as `<i>card-id</i>`; renaming an id means updating every
  reference in the same edit.
- `p` — phase 0–4 (integer).
- `a` — array of area keys; every key must exist in `AREAS`.
- `kind` — `"action"` | `"decision"` | `"reference"` | `"watchout"`.
- `state` — `"active"` | `"open"` | `"parked"` | `"done"`.
- `t` — title.
- `m` — model/effort exception. **Sole authority: `docs/effort-guide.md`** —
  never restate the rule here, only the field mechanics. The standing default
  is Opus 5.5 · medium, and it needs no card marker at all: most cards carry no
  `m`. Set it only where a card departs:
  - `"max"` — a genuinely one-way call, where a mistake cannot be walked back.
  - `"—"` — no Claude session works this card at all (the exact equivalent of
    `takes:human` on that card's own issue). A decision/reference/admin card
    that Claude *does* do work on carries no `m`; it does not carry `"—"`.
  - Leg-scoped: `m:[["<step>","max"]]` — only the departing legs are named; a
    leg with no entry runs the default.
  Never write a retired tier spelling (`"S/H"`, `"O/H"`, `"O/M"`) — `validate.js`
  warns on an unrecognised `m` code.
- `mn` — one-line model-note. **Its subject is the `m` choice and the execution
  surface, and nothing else.** A **builder guardrail is not that subject however
  execution-flavoured it reads** — "pull the vendor's current API reference
  before building" is a move the builder makes, so it belongs to `b`'s second
  limb. Lead with "Research run" when the card is executed via the Research tool
  (multi-source synthesis — competitor teardown, scheme benchmarking,
  regulatory/payment-rail landscape). Step 6's validator warns where an edit
  touches an `mn` over 30 words.

  **Re-read `mn` whenever `state` or `log` changes.**
- `b` — body HTML: the action and its guardrails. **What may be in it at all
  is [SKILL.md](SKILL.md) §What a card holds.**
  **Every sentence is load-bearing or it goes.** A superseded framing belongs
  in git, in `docs/doc-map.md` §B if a figure depends on it, or on the issue;
  never in the body.
- `c` — optional callout object `{type, k, x}` where `type` is
  `"rec"` | `"flag"` | `"q"`, `k` is the label, `x` is the text.

  **HARD RULE: `k` is ≤20 characters including spaces.** It renders as a small
  mono uppercase tag. Write a terse tag ("Cheap now", "Doc, not a skill"); the
  reasoning goes in `x`.

  Treat `type`, `k` and `x` as one unit describing a single situation, not three
  independent fields — `type` carries meaning of its own (`flag` reads as an open
  caution, `rec` as settled advice, `q` as an open question). Re-check all three
  whenever a callout's content changes, or a resolved risk keeps a `k` and `type`
  contradicting its own rewritten `x`.

  `x` never carries the argument for the card's existence, which is barred from
  the record entirely. Step 6's validator warns where an edit touches an `x` over
  80 words.
- `log` — REQUIRED on `done` cards. One to two sentences, action-guide voice — the
  outcome plus what it means for what to do next. Keep the cause when the cause
  changes the next action ("declined — no-traffic, not a quality signal → don't
  re-polish"). Point to the card id that owns any follow-up rather than forking
  the instructions into the log. Cut anything visible elsewhere. Step 6's
  validator warns where an edit touches a `log` over 80 words.
- `needs` — optional array of prerequisite ids. Every id must exist, and must
  sit in an **equal-or-earlier phase**; a same-phase prerequisite must appear
  **earlier in array order**. See SKILL.md step 3 for the ordering rule they
  impose.
- `span` — optional bool, full-width card layout.
- `focus` — optional bool, visual emphasis for a single flagship card. Scarce by
  design — currently only `anchor-hostel`.
- `why` — optional; one or two sentences of direction-under-consideration plus
  what the card unlocks. Renders above the body. **Optional on an existing
  card, required whenever a session takes that card** (mantahostels#3186) — this is a
  discipline the loop asks of you, not a check `validate.js` runs; nothing
  detects an untouched card missing one. **Hard cap ~40 words, enforced as a
  validator ERROR** the moment `why` is present at all — the roadmap's first
  body-prose check at ERROR severity, every other prose check being a WARN,
  and unconditional on touch: there is no baseline a first-time `why` can be
  judged against.
- `dw` — the done-when (or start-when, on a `parked` card) completion
  condition (mantahostels#3190). **Required on
  every non-done card — a validator ERROR on absence.** Carries no label of
  its own: the render synthesises `<b>Start when:</b>` on a `parked` card,
  `<b>Done when:</b>` on every other state, from `state` alone — never from
  who wrote the card. Step 6's validator warns where an edit touches a `dw`
  over 60 words, in `FIELD_WORD_CEILINGS`' shape. The digest does not carry it,
  matching its existing "strips body/done-when/callouts" contract — no edit
  needed there.
- `capOk` — an exemption record (mantahostels#3189), never card content: `{field:
  issueNumber}` keyed by exactly the four ceilinged labels `validate.js`
  enforces — `b`, `mn`, `c.x`, `log` (never `dw`: mantahostels#3498 ruled an over-ceiling
  `dw` is always cut, its surplus relocated into `b`) — value the issue that
  ruled the exemption, e.g.
  `capOk: { b: 3189 }`. **No render** — a record the founder reads via
  `validate.js`'s output, not on the card itself. `STALE EXEMPTION` warns where
  the named field is now at or under its own ceiling; `MALFORMED EXEMPTION`
  warns on a key outside the four labels or a non-positive-integer value.
  `CARD SHAPE` is silent on a touch of an exempted field that does not grow
  it, and still fires on one that does (mantahostels#3335); the census still reports the
  row. **Void on touch**: a session editing an exempted field re-judges it on
  the spot — either cut it under the ceiling and drop the `capOk` key, or
  re-record it citing its own ruling issue. No expiry, no clock, and nothing checks that the re-judgement
  happened — a re-judged field and an untouched one are indistinguishable to a
  script.

## Extraction internals — only for scripting something custom

`validate.js` already handles extraction. To parse `ITEMS` yourself, slice the
literal and evaluate only that — running the whole page in Node calls the DOM and
throws:

```js
const start = html.indexOf("const ITEMS = [");
const end   = html.indexOf("\n];", start);
const block = html.slice(start, end + 3);
const ITEMS = new Function(block + "\nreturn ITEMS;")();
```
