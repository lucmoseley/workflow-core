---
name: heresy-sweep
---

# heresy-sweep

The method a session follows on a *Heresy sweep due* issue: find the
heresies (`GLOSSARY.md`) no check, table row or ticket names yet, file each
under the due issue, and close it with the count. Spec: #3365.

**Run it from the swept repo's checkout.** Every issue it files goes to that
repo's own tracker. In an adopter, `scripts/` and `docs/code-standards-base.md`
are the plugin root's. Dates are UTC.

## 0. Scratch

```
R="$PWD/.claude/tmp/heresy-sweep/$(date -u +%F)"
mkdir -p "$R"
```

Append to `$R/known.md` and `$R/candidates.md` as each search and judgement
lands, never held for the end.

## 1. Read the primitives tables — before any search

Read both `## Primitives` tables in full: the base one in
`docs/code-standards-base.md` and the local one in `docs/code-standards.md`.
Then run `node scripts/check-primitives.js` and keep its output in
`$R/known.md`. A FAIL there is a table fault: comment it on the due issue and
carry on.

**A breach of a row whose Enforcing check names a program is never filed.**

**A spread breach of a `Standards axis criterion` row is a sweep finding**
(#3365 story 13). File it as §5 does, its Primitive section naming the
row.

## 2. List what is already named — required

Write each search and what it found to `$R/known.md`. A pattern this step
names is **known**, and §4 drops it.

- **The heresies left on the record** (#2204, the ruling that adopted the
  sweep): hand-rolled git repos per test (lucmoseley/mantahostels#2048),
  `readonly` missing from library types in mantahostels `app/`
  (lucmoseley/mantahostels#3842), and deny prose in guard heredocs outside the
  rule store (lucmoseley/mantahostels#1644).
- **What a check refuses.** For each candidate's distinctive token, run
  `rg -l '<token>' scripts/check-*.js scripts/guard-* .husky/ eslint.config.mjs biome.json`.
  A check whose message names the candidate's primitive refuses it.
- **Every row whose Enforcing check names a program** (§1).
- **The spec's tickets.** #3365's children:
  `gh api --paginate repos/lucmoseley/workflow-core-tracker/issues/3365/sub_issues --jq '.[] | {number, title, state, state_reason}'`.
  In any other repo, also the tickets that spec handed it:
  `gh issue list --state all --search '"workflow-core-tracker#3365" in:body' --limit 50 --json number,title,state`.
  Each one is known, open or closed.
- **Earlier sweeps' children**, the declined ones included:
  `gh issue list --state closed --search '"Heresy sweep due" in:title' --limit 50 --json number`,
  then each one's sub-issues, with the call above. A child
  closed `not_planned` is a decline.
- **Open issues on the pattern:**
  `gh issue list --state all --search '<primitive or token> in:title,body' --limit 50 --json number,title,state`.

Run each `gh` call in the foreground, and re-run an empty result once before
believing it.

## 3. Inventory code and prose

Run a pass of the shape #2201 (the primitives-and-heresies inventory) ran, on
both code and prose.

- **Per recurring job**: find its primitive, its exemplar, and every file
  doing the same job some other way. Walk every one of these: each program
  family (`guard-*`, `check-*`, `report-*`, tests, and any other prefix the
  repo's programs share), each I/O kind (files, stdin, `gh`, git, the clock,
  child processes, the network), output and exit codes, and parsing. Done is
  every one of them named in the close's Bound line, walked or sampled.
- **Prose**: comments and docs that state a wrong belief about the design,
  such as a retired var, script or route named as current.
- **Count by text match.** Every count comes from one `rg` or shell command.
  Record the command verbatim beside the count.
  Tests count separately from programs. Before counting, read the matches and
  drop the sites doing a different job that happens to share the token.

## 4. Judge

For each candidate, in `$R/candidates.md`:

- **Drop it if it is known (§2)**, a decline included. Where it matches an
  open ticket and the count has grown, comment the new count on that ticket
  instead.
- **Drop a single deviation.** A heresy is a copy: it needs at least two
  sites outside the primitive itself. A one-off goes to the due issue's
  close comment, under Seen.
- **Drop a defect.** A guard that fails open is a bug, not a copied
  pattern. File it standalone (§5's command with `--standalone "Heresy sweep finding (<owner/name>#<due>)"`
  in place of `--parent`), never as a child of the due issue.
- **Rank what is left** by spread × chance of further copies × cost of a
  wrong copy. Spread is the file count. Chance is higher where the
  family's newest files carry the pattern. Cost is what a wrong copy breaks.

## 5. File one ticket per heresy, under the due issue

Worst first:

```
node scripts/file-issue.js --title "<the primitive to move onto, and the heresy it stops>" \
  --label takes:triage --parent <due-issue> --body-file "$R/heresy-<k>.md"
```

Exit 1 is a `gh` call that did not land. Read its message before re-running:
a create that landed would file a duplicate. Exit 2 is a refusal: read its
message. Where it lists similar titles, read each one; where one is this
heresy, it is known (§4).

**The due issue's sub-issues are its heresies and nothing else.** The table
checker's new-heresies count is the number of sub-issues of the last closed
due issue (`scripts/check-primitives.js`).

`$R/heresy-<k>.md`:

```markdown
Heresy sweep finding (<owner/name>#<due-issue>)

## Primitive

<the job, the primitive and its exemplar file; the table row or § that states it, or "unnamed: no row or § states it yet">

## Heresy

<the pattern, in one sentence>

## Count

<n> files (<k> tests), by `<the command>`

## Exemplars

<path:line> for up to five copies, the newest first

## Rank

<spread, chance of further copies, cost of a wrong copy, one clause each>
```

## 6. Close the due issue

Read the count back first:

```
gh api --paginate repos/{owner}/{repo}/issues/<due-issue>/sub_issues --jq '.[].number'
```

Where it differs from what §5 filed, find out why before you close. Then run
`node scripts/resolve-ticket.js <due-issue> --comment-file "$R/close.md"`.
`$R/close.md`:

```markdown
**Filed:** <N> heresies, the due issue's sub-issues: <#a (gloss), #b (gloss), …, or none>

**Commented:** <each known ticket given a new count, or none>

**Seen:** <each table-row breach with its count, each one-off deviation, and each defect filed standalone, or none>

**Bound:** <the jobs and the prose walked in full, those only sampled, and any §2 search that failed twice>

**Values:** <each house or untraced value the comment relies on, or none>

**Practice:** <covered — docs/practice/code-refactoring-and-architecture.md, its Researched date; ran where that date is over 6 months old>
```

`N` is the read-back count.
