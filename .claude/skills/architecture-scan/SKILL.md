---
name: architecture-scan
---

# architecture-scan

Wraps the vendored `improve-codebase-architecture` skill
(`${CLAUDE_PLUGIN_ROOT}/.claude/skills/improve-codebase-architecture/SKILL.md`) so it runs with no
one there: it follows the vendored explore step as written and replaces every
step that needs a live human or breaks unattended. Spec: workflow-core#1348 Part 2. The
vendored file is never edited.

**Run it from the scanned repo's checkout.** Every issue it files goes to that
repo's own tracker. Dates are UTC.

## The vendored steps

Read the vendored file first. Its step headings:

- `### 1. Explore` — **followed as written**, with the hot files as the named
  direction (its "the user named a direction" branch). Its own sub-agent is
  allowed.
- `### 2. Present candidates as an HTML report` — **replaced** by §5–§7 below:
  no HTML file, no temp file, no browser, no question. Kept from it: each
  candidate's Files, Problem, Solution, Benefits and strength, and its
  ADR-conflict rule. Dropped: the diagrams and the top recommendation.
- `### 3. Grilling loop` — **replaced**: it never runs in the scan.

## Modes

- **`scan <due-issue>`**, from an *Architecture scan due* issue: §0–§9.
- **`close <map>`**, from a scan map relabelled `takes:implement`: §Close.

## 0. Scratch

```
R="$PWD/.claude/tmp/architecture-scan/$(date -u +%F)-scan"
mkdir -p "$R"
```

Append to `$R/search.md` and `$R/candidates.md` as each search and judgement
lands, never held for the end.

## 1. Read the current count

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/report-arch-scan-due.js --dry-run > "$R/count.txt"
```

A non-zero exit prints a `BROKEN:` line on stderr: stop, comment it on the due
issue, and leave the issue open. Otherwise `count.txt` pins the run: the
window's `since` and its 40-hex head, the ten hot files, the growth, and the
threshold with its source. These hot files, not the due issue's, steer the
run. A count under the threshold still runs, saying so in §9.

## 2. Search before filing — required

Write each search and what it found to `$R/search.md`.

- **Earlier scan maps:**
  `gh issue list --state all --label wayfinder:map --search '"Architecture scan" in:title' --limit 100 --json number,title,state,body`.
  For each map, its Notes' "already deep" modules, and its children:
  `gh api --paginate repos/{owner}/{repo}/issues/<map>/sub_issues --jq '.[] | {number, title, state, state_reason, body}'`.
  A candidate closed `not_planned` is a decline; one closed `completed` was
  accepted and built.
- **Earlier defects:**
  `gh issue list --state all --search '"Architecture scan finding" in:body' --limit 200 --json number,title,state`.
- **Open issues on each hot file and each suspect module**, retro-sweep findings
  included: `gh issue list --state open --search '<file name> in:title,body' --limit 100 --json number,title`.
- **ADRs:** every file in this repo's `docs/adr/`.
- **In workflow-core and mantahostels only**, the two hand-run maps
  `lucmoseley/mantahostels#145` and `lucmoseley/mantahostels#1792` and their
  children (`gh issue view <n> --repo lucmoseley/mantahostels --comments`, and
  the sub-issues call above with `lucmoseley/mantahostels`).
  `lucmoseley/mantahostels#1802` is their only recorded decline.

Run each `gh` call in the foreground and re-run an empty result once before
believing it.

## 3. Explore

Follow the vendored `### 1. Explore` with the hot files in `count.txt` as the
direction. Next after each hot file: its strongest change-coupling partner,
the code file most often in the same commits over the window:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/report-arch-scan-due.js --partners "$R/count.txt" > "$R/partners.json"
```

It prints each hot file with its top three partners, the first the strongest,
over `count.txt`'s own window and through the counter's code filter, so a test,
vendored, generated or `archScan.exclude` path is never named. A non-zero exit
is handled as §1's.

## 4. Judge

Apply the deletion test to each suspect. Each candidate gets a strength:
`Strong`, `Worth exploring` or `Speculative`. Write each to
`$R/candidates.md` as it is judged. Then, against `search.md`:

- A candidate matching an earlier decline, an "already deep" note or an ADR is
  **dropped** — unless the run can say what has changed since. Then it is
  filed with an **Earlier ruling** note naming the ruling and the change.
- A finding matching an **open** issue becomes a comment on that issue, and is
  not filed again.
- A breach of a standards-base rule is neither a candidate nor a defect: on a
  new diff it is `/code-review`'s, and an existing one is the clean-up of the
  spec that adds the rule.
- A **defect** — a guard that fails open, a gate with no tests — is not a
  candidate; it goes to §7.

## 5. File the map

One issue, filed with `node ${CLAUDE_PLUGIN_ROOT}/scripts/file-issue.js`:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-issue.js \
  --title "Architecture scan, <UTC date>: <one-line summary>" \
  --label wayfinder:map --label takes:wayfinder \
  --standalone "Architecture scan (spec lucmoseley/workflow-core-tracker#1348)" \
  --body-file "$R/map.md"
```

Exit 1 is a `gh` call that did not land: read its message before re-running,
since a create that landed files a duplicate. Exit 2 listing similar titles:
read each, and re-run with the `--distinct-from` it names only where none is
this map.

`$R/map.md`:

```markdown
## Destination

Deepen the modules this scan's accepted candidates name.

## Notes

- Window: <since> to <head>. Growth <n> lines over the hot files, against a threshold of <t> (<source>).
- Hot files: <path (commits, net)>, one per line.
- Already deep: <each module the scan judged deep enough, with one clause why>.
- Each child labelled `wayfinder:grilling` is one deepening candidate. Grill it with the vendored improve-codebase-architecture skill's grilling loop and `domain-modeling`. Accepted: close it as completed and file its build as a `takes:implement`, `kind:ticket`, `wayfinder:task` sub-issue of this map naming the candidate (the type is what `file-issue.js` demands of a map's child, #1489) — accepted candidates are built inside this map, overriding wayfinder's plan-don't-do default. Declined: close it as not planned, offering an ADR where the reason is lasting.
- Close: the session that resolves this map's last open candidate relabels the map from `takes:wayfinder` to `takes:implement`. The session that then takes it runs the architecture-scan skill's `close <map>` mode, and nothing else.

## Decisions so far

## Not yet specified

## Out of scope

- A breach of a code-standards base rule: `/code-review`'s on a new diff.
- Defects: filed outside the map, each listed here as §7 files it.
```

## 6. File one ticket per candidate

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-issue.js --title "<the deepening, and the friction it removes>" \
  --label wayfinder:grilling --label takes:wayfinder --parent <map> \
  --body-file "$R/candidate-<k>.md"
```

Each body opens with the line `Architecture scan candidate (<owner/name>#<map>)`,
which §Close counts by, then:

```markdown
## Question

Deepen <module> as below — accept or decline?

## Files

## Problem

## Solution

## Benefits

<in terms of locality, leverage and how tests improve>

## Strength

<Strong | Worth exploring | Speculative>

## Earlier ruling

<only where §4 kept one: the ruling, and what has changed since>
```

Propose no interfaces.

## 7. File each defect outside the map

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/file-issue.js --title "<the fix, and the fault it stops>" \
  --label <takes:implement | takes:triage> \
  --standalone "Architecture scan finding (<owner/name>#<map>)" \
  --body-file "$R/defect-<k>.md"
```

`takes:implement` where the fix is fully specified, `takes:triage` where it is
not. The standalone line is what the next run's §2 searches for. Then list
each defect under the map's Out of scope:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/issue-body.js append-section <map> --heading "Out of scope" --text "- <owner/name>#<n>: <title>"`.

## 8. Append the scan line

Build one compact line in `$R/record.json`:

```
{"date","mode":"scan","head","since","growth","threshold","thresholdSource",
 "hotFiles":[{"path","commits","net"}],"map","candidates","defects":[],"release"}
```

- `head`, `since`, `growth`, `threshold` and `thresholdSource` (`default`,
  `log` or `override`) are `count.txt`'s. `hotFiles`:
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/report-arch-scan-due.js --hot-files "$R/count.txt"`
- `map` and each `defects` entry are `<owner/name>#<n>`; `candidates` is the
  count filed in §6.
- `release`: `self` in workflow-core; elsewhere the `ref` this repo pins the
  plugin to:
  `jq -r '.enabledPlugins as $e | .extraKnownMarketplaces | to_entries[] | select($e["workflow-core@" + .key] == true) | .value.source.ref' .claude/settings.json`.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js claim docs/data/arch-scan-runs.jsonl
jq -c . "$R/record.json" >> docs/data/arch-scan-runs.jsonl
node ${CLAUDE_PLUGIN_ROOT}/scripts/commit-paths.js -m "<what changed>" -m "<why, then the tally>" -- docs/data/arch-scan-runs.jsonl
```

Push by this repo's push rule.

## 9. Close the due issue

Tick any criterion the run met:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/issue-body.js tick <due-issue> --match "<criterion>"`. Then
`node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-ticket.js <due-issue> --comment-file "$R/close.md"`.

The comment names the map, the candidate and defect counts, the issues §4
commented on instead of filing, and the record commit, then:

- `**Door:**` two-way: revert the record commit and close the issues it
  filed.
- `**Bound:**` which hot files and partners were read in full and which only
  sampled, and any §2 search that failed twice.
- `**Values:**` each value the comment relies on that is house or untraced,
  or `none`.
- `**Practice:**` the Leading practice call: `ran`, `covered`, `skipped` or
  `none-fits`.
- `**Outstanding:**` the map.

## Close

`close <map>`, when every candidate is resolved and every build is done.

1. **Refuse while any child is open**, builds included: where
   `gh api --paginate repos/{owner}/{repo}/issues/<map>/sub_issues --jq '.[] | select(.state == "open") | .number'`
   prints anything, comment the open children on the map and stop.
2. **Count.** Y is the candidates closed as completed; the declined, those
   closed as not planned:

   ```
   gh api --paginate repos/{owner}/{repo}/issues/<map>/sub_issues |
     jq -s '[.[][] | select(.body // "" | startswith("Architecture scan candidate"))]
       | {yield: map(select(.state_reason == "completed")) | length,
          declined: map(select(.state_reason == "not_planned")) | length}'
   ```

3. **Next threshold:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/report-arch-scan-due.js --next-threshold <Y>`.
   Its stdout is the close line's `{"threshold","nextThreshold"}`.
4. **Append the close line** —
   `{"date","mode":"close","map","yield","declined","threshold","nextThreshold"}`
   — claimed, committed and released as in §8, then push by the repo's rule.
5. **Close the map** with `node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-ticket.js <map> --comment-file <f>`:
   Y, the declined, the threshold change and the record commit, with a
   `**Door:**` line (two-way: revert the record commit and reopen the map), a
   `**Bound:**` line, a `**Values:**` line (each house or untraced value it
   relies on, or `none`), a `**Practice:**` line
   and an `**Outstanding:**` line (none, or what the builds left open
   elsewhere).
