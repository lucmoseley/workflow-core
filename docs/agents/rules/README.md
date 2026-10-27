# The rule-text store

Each rule this repo relocated out of `CLAUDE.md` and into the guards that reach
a session lives here, once, as its operative text. Guards print it; nothing else
stores it. A rule a guard can print at the moment it applies costs nothing on
every other branch (mantahostels#1641, the spec relocating the guard-backed §Conventions
rules into the guards that print them).

**Two moments, not one**, and one fragment serves both. Prefer the pre-emptive
shape where the rule tells a session what to do, and the deny where it only
tells it what it just did wrong (mantahostels#1762).

## The id convention

A rule id is lowercase kebab-case — `^[a-z0-9]+(-[a-z0-9]+)*$` — and names the
trap, not the guard: `commit-pathspec`, `file-claim`, `branch-shared-tree`. Two
guards printing one rule share the id; one guard printing two rules has two.
Ids are permanent, because guard-registry trigger lines cite them.

**Both accessors also take the `rule:<id>` spelling** — the one the trigger
indexes and `docs/agents/guard-registry.md` §Gotchas quote — stripping one leading prefix before the
grammar runs, so `rule:../outside` and `rule:rule:x` are still refused. The store
is keyed on the bare id, which is what `--ids` enumerates and what every heading
and error message names (mantahostels#2707).

The fragment is `<id>.txt` in this directory. Plain UTF-8, no front matter, no
Markdown contract — a guard splices it into a refusal a human reads in a
terminal. Trailing newlines are trimmed by both accessors, so end the file
however you like.

**A GENERATED fragment is the exception, and Markdown is allowed there** (mantahostels#2528).
One rendered from an anchored region
of a source document — `manifest.json` names which — carries whatever that
document's own reader needs, tables included: `takes-value-vocabulary.txt` is
`docs/agents/triage-labels.md`'s seven-row `takes:` table, and de-tabling the
region would damage the document to satisfy a convention the fragment does not
need. The convention was written for the terminal, and a generated fragment
lands as `additionalContext` instead, read by a model. No path puts one on
stderr at all. **What it still costs is assertion robustness** — the column
padding is the source region's, not the fragment's, so a test asserting on a
generated fragment collapses whitespace first, as
`scripts/guard-tracker-rules.test.ts` does.

**Plain text, not JSON.** The guards are half bash and half Node, so a fragment
must be `cat`-able from one and `fs.readFileSync`-able from the other with no
parser. `jq` is the dependency `scripts/inject-tracker-docs.sh` fails open on,
and a rule that fails open is a rule that reaches nobody.

## Reading a fragment

```bash
# shellcheck source=scripts/lib/rule-text.sh
source "$here/lib/rule-text.sh"        # a guard: rule_text <id> returns 1 on an unknown id
scripts/lib/rule-text.sh <id> [<id>…]  # a session: exits 1 on any unknown id, one call for many
```

```js
const { readRuleText } = require("./lib/rule-text"); // throws on an unknown id
```

Pre-emptively, from a `PreToolUse` guard's core
(mantahostels#1804). This resolves each id, drops the ones this session has already been
given, and emits the rest as `additionalContext` — it never sets a
`permissionDecision`:

```js
return { injectRules: ["<id>", "<id>"] }; // ids in priority order, highest first
```

`scripts/lib/guard-entry.js` refuses the tool call on a store fault. Over its byte ceiling it emits the
ids that fit whole and defers the rest to the next trigger. Its header carries
the rest.

Never `cat` a fragment path directly. `scripts/check-guard-registry.js` reads
the accessor call to decide which guard prints which rule, so a hand-rolled read
makes the fragment look orphaned. An `injectRules` id counts only as a quoted
literal in the array; one built at run time is invisible to the gate.

## What the gate demands

`scripts/check-guard-registry.js` fails when either half of the pair breaks:

- a `` `rule:<id>` `` token in a guard-registry region names an id no fragment
  answers to;
- a fragment here is empty, or is printed by no **wired** guard — one reachable from
  `self-plugin/hooks/hooks.json`, a `package.json` script, a `.husky` hook or a
  workflow.

Nothing asserts that a fragment also keeps a trigger line (mantahostels#2006).

## Adding one

1. Decide the route before writing anything. A rule whose authored home is
   already `docs/agents/issue-tracker.md` or `docs/agents/triage-labels.md` is
   **generated**: write it into a new anchored region there — each anchor
   comment alone on its own line, `<!-- rule:<id>:begin -->` … `<!-- rule:<id>:end -->` —
   add its `TRIGGERS` row in `scripts/generate-rule-fragments.js`, render the
   `.txt` with `npm run gen:rule-fragments`, and register it `generated-only`
   with `node scripts/register-doc.js` and `npm run gen:doc-map-section-a`
   (`CLAUDE.md` §Ground truth) — never type the `.txt` by hand. Every other
   rule is **hand-written**: write `docs/agents/rules/<id>.txt` directly — the
   operative instruction only, in the voice a refusal should carry.

   To tell which route an *existing* id already took, check
   `docs/agents/rules/manifest.json`: an id listed there is generated (its
   `source` field names the anchoring document), and a hand edit to its `.txt`
   is overwritten silently at the next render unless `--check` catches the
   drift first at commit time. An id absent from the manifest is hand-written
   and safe to edit directly.

   No generated fragment carries a first-line "generated — edit `<source>`
   instead" marker: the marker would cost bytes in every session an `injectRules`
   or `rule-text` call reaches, repeated across every generated id, to guard
   against a mistake `--check` already refuses at commit time.
2. Call the accessor from the guard and splice the text into its message — or
   name the id in a core's `injectRules`, to hand it over before the mistake instead.
3. Leave one trigger line in `CLAUDE.md` naming the trap and the id, never
   restating the rule — **only where the guard does not already hand the rule
   over before the mistake.** A rule fully on that route needs no pointer.
4. Where the host keeps a shed register
   (`docs/research/always-loaded-shed-candidates.md`), record the fragment's
   bytes in its Register II **only where the fragment is RELOCATED text** —
   bytes leaving `CLAUDE.md` or another always-loaded file. That register is
   shed accounting, and a fragment written new has no shed to account for. New text records nothing there, and the twenty generated
   tracker fragments (mantahostels#2493, mantahostels#2497) rightly record
   nothing.

   **Measurement is not what that row buys** (mantahostels#2528). Every fragment, relocated or new, is
   rationed mechanically by `scripts/check-context-budget.js`: it resolves each
   one, prices the reachable union per `PreToolUse` tool against
   `SESSION_CAP_BYTES` and the union across all tools against the shared
   ratchet, and `.husky/pre-commit` refuses a commit that raises an over-cap
   total. So **run `npm run check:context` after adding a fragment**. An
   addition either fits the headroom or raises a cap — deliberately, which is
   the whole ration. A raise is TWO edits: the constant that gates
   (`SESSION_CAP_BYTES` or `RATCHET_CAP_BYTES` in
   `scripts/check-context-budget.js`) and the figure that derives it
   (`docs/doc-map.md` §Capture and placement §3, which states both in prose).
   Nothing pins the two together, so an edit to one alone leaves the other
   stale.

**In an adopter, only the hand-written, printed route exists** (#925). Write
`docs/agents/rules/<id>.txt` in the adopter's own store and print it —
`rule_text` or `readRuleText` — from a guard of its own under `scripts/`
or `.claude/`, wired from its own `.claude/settings.json`, a `package.json`
script, a `.husky` hook or a workflow. The session-fetched class is core-only:
`generate-rule-fragments.js`'s sources and triggers and the gate's command index
are the core's, so an adopter rule with no Bash moment to print at belongs in
the core or in a pointer line, not the store. **A spec criterion that registers
`rule:<id>` names the emitter or index that reaches it**.
