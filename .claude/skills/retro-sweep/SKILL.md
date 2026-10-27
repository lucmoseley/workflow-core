---
name: retro-sweep
---

# retro-sweep

One run reviews a week's sessions from every repo that runs the plugin for
**environment faults** — what in the hooks, guards, scripts, skills or
steering let a session go wrong — and files only the ones no tracker, file or
later commit already covers. Spec: workflow-core#948.

**Run it from the workflow-core checkout**, on plain Opus
(`${CLAUDE_PLUGIN_ROOT}/docs/effort-guide.md`). The run files issues and commits one record line;
it never edits `CLAUDE.md`, the always-loaded pool or any finding's target.
Dates and weeks are UTC throughout.

## 0. Mode and inputs

- **`weekly <due-issue>`** (the default, from a "Weekly retro due" issue):
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workflow-core-config.js retro-count` prints N. Exit 1 is
  its SKIP line — `retro.weeklyCount` is unset because calibration has not
  set it: **stop**, run nothing, and comment that line on the due issue,
  leaving it open; the route out is the open calibration ticket
  (`gh issue list --search "retro calibration in:title"`). Exit 2 is a
  malformed key: stop and comment the BROKEN line the same way.
- **`calibrate <week-start-date> <ticket>`** (the calibration ticket): 12
  sessions — the top 8 by signal plus 4 random controls — from the week
  starting that date. Where the ticket names no week, take the latest
  **finished** one: its start at least 7 days before now (`date -u`). The
  seed is
  `<ticket>-<week-start-date>`.

Scratch: `R="$PWD/.claude/tmp/retro-sweep/<UTC date>-<mode>"`, then
`mkdir -p "$R/snapshot"`. Everything the run writes before step 7 goes under
it. Pin `H=$(git rev-parse --short HEAD)` now: the briefs and the record
carry this one value.

## 1. Pick

- weekly: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pick-retro-sessions.js --top <N> > "$R/picks.json"`
- calibrate: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pick-retro-sessions.js --calibrate --week <date> --seed <seed> > "$R/picks.json"`

The picks are `.sessions[]`. Calibrate picks carry `pick`, `"rank"` or
`"control"` (weekly picks are all `"rank"`), and a control's `rank` is its
place in the whole pool. Zero picks: skip to step 7 with an empty `picks`,
then step 8.

## 2. Tracker snapshot — once, before any coverage check

The trackers are the union of `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workflow-core-config.js corpus`
and each picked repo's own, read as
`CLAUDE_PROJECT_DIR=<repoRoot> node -p "require('$PWD/scripts/lib/workflow-core-config.js').resolveKey('tracker')"`.
For each:

```
gh issue list --repo <owner/name> --state all --limit 10000 \
  --json number,title,body,state,closedAt,labels > "$R/snapshot/<owner>-<name>.json"
gh api --paginate "repos/<owner/name>/issues/comments?per_page=100" \
  --jq '.[] | {issue: (.issue_url|split("/")|last|tonumber), created_at, body}' \
  > "$R/snapshot/<owner>-<name>.comments.jsonl"
```

Re-run an empty or failed call once; a tracker
still failing is named on the close's `**Bound:**` line, and its candidates
take the live search instead. Every coverage search after this reads these
files (`jq` over `title` and `body`) — a candidate's, and §6's for every
other issue the run files; a live `gh search issues` is a second look only
(`brief.md` §3).

## 3. Reduce

For each pick: `node ${CLAUDE_PLUGIN_ROOT}/scripts/retro-transcript.js <transcript> --out "$R/<sessionId>.txt"`.
Subagent logs fold in on their own. A non-zero exit drops that pick from
the run; record why in step 7.

## 4. Dispatch one subagent per pick, in parallel

Fill `brief.md` once per pick — every `{{…}}` replaced — and send all the
`Agent` calls in one message: `subagent_type: "general-purpose"`,
`model: "sonnet"`. Fill-ins, every path absolute:

- `{{ARTEFACT}}` `$R/<sessionId>.md` · `{{TRANSCRIPT}}` `$R/<sessionId>.txt` ·
  `{{SNAPSHOT}}` `$R/snapshot`
- `{{WFC}}` this checkout · `{{WFC_HEAD}}` `$H`
- `{{RAW_LOG}}`, `{{SUBAGENT_DIR}}`, `{{SESSION_ID}}`, `{{FIRST_TIMESTAMP}}`,
  `{{REPO_ROOT}}`: the pick's `transcript`, `subagentDir`, `sessionId`,
  `firstTimestamp`, `repoRoot`
- `{{RELEASE}}`: the pick's `release`, glossed — `self` is workflow-core's own
  checkout; `null` is the plugin enabled with no pinned release
- `{{POOL}}`: `CLAUDE_PROJECT_DIR=<repoRoot> node ${CLAUDE_PLUGIN_ROOT}/scripts/check-context-budget.js 2>&1 | grep -m1 '^ALWAYS-LOADED POOL'`
  — the session repo's own pool, not this one's

Note each dispatch's `agentId`: the agent's own log is `$A/agent-<agentId>.jsonl`,
where `A=$(echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$CLAUDE_CODE_SESSION_ID"/subagents)`
— check `[ -d "$A" ]`: an unmatched glob or two matches leaves no one
directory, and every log read below then fails.
Then, per artefact, one backgrounded `node ${CLAUDE_PLUGIN_ROOT}/scripts/watch-artefact.js "$R/<sessionId>.md" 120`,
and end the turn.

## 5. Stalls, cost and model

A watcher's `STALLED` for an agent that has **not** reported is confirmed
against its log first. Where the log's age in seconds,
`$(( $(date +%s) - $(stat -c %Y "$A/agent-<agentId>.jsonl") ))`, is under
the watcher's interval, the agent is working without appending: re-arm the
watcher once, on the log in place of the artefact. That log watcher's
`STALLED` is confirmed. An unconfirmable `STALLED` — an older log, or none —
is too.

A confirmed `STALLED`, or a `MISSING`: abandon that agent (`TaskStop`) and
finish its work yourself from its artefact — every candidate it lists
without a class gets one, by the same checks and class rules as `brief.md`
§3; a `MISSING` artefact means the session's retro is redone here or
dropped, said in step 7. `CEILING` is a working agent: re-arm the watcher
once. When an agent's completion notification arrives, `TaskStop` its
watcher first.

**Cost per session** is the agent's **final context** — its last turn's
size, not its spend summed over turns (workflow-core#1052). For a reported agent,
take the `subagent_tokens` figure in its completion notification's
`<usage>`. For an abandoned one, its log's last real assistant turn, short of
`subagent_tokens` by that turn's unlogged output:
`jq -s '[.[]|select(.type=="assistant" and .message.model!="<synthetic>")][-1].message.usage|.input_tokens+.output_tokens+.cache_creation_input_tokens+.cache_read_input_tokens' "$A/agent-<agentId>.jsonl"`.

**Model per session** is read from the same log (workflow-core#1036). It prints a JSON
value for the record —
the one model id, or a sorted array of ids where the log shows more than
one:
`jq -cs '[.[]|select(.type=="assistant" and .message.model!="<synthetic>").message.model]|unique|if length==1 then .[0] else . end' "$A/agent-<agentId>.jsonl"`.
Only where no log exists, or it prints `[]`, is it the dispatch's requested
alias.

## 6. Merge, judge, file

1. **Merge** the NEW candidates across sessions: one fault seen in several
   sessions becomes one finding citing each session and its lines.
2. **Judge** each merged NEW finding **ticket-worthy** or **low-value**.
   Ticket-worthy: a concrete environment change that would have saved the
   session real turns, tokens or a founder ask, or would have stopped a wrong
   result — and is plausibly hit again. Low-value: cosmetic, one-off, or a
   change costing more than the fault. Low-value ones go to the record only
   (workflow-core#883 Q3 (A)). A brief's **Waived** mark — a remediation the founder
   waived in that session — binds that session alone: a merged finding is
   judged on its other sessions, and is low-value at most only where every
   session it cites is Waived (workflow-core#1073).
3. **Route** each ticket-worthy finding by who owns the thing to change.
   - Shipped with the plugin — hooks, guards, `scripts/`, skills, the
     `code-reviewer` agent, rule fragments, the core-owned
     `.claude/workflow-core.md` — or anything in workflow-core's own repo:
     file in workflow-core, whichever repo's session showed it.
   - Adopter-owned — its `CLAUDE.md`, `AGENTS.md`, output style, standards
     file, lint or CI: file in that adopter's tracker, by prefixing
     `CLAUDE_PROJECT_DIR=<repoRoot>` to the command below, whose `<spec>` is
     then `lucmoseley/workflow-core-tracker#948`: a bare `#948` resolves in the
     adopter's own tracker. One line shared verbatim by two repos is
     one finding per tracker.
4. **Search before every filing** — not only the candidates': a founder act,
   a side finding, any issue the run writes outside a candidate takes the
   same snapshot search (§2) (workflow-core#1073). A match is not filed; add to it
   instead.
5. **File** each, unassigned:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/file-issue.js --title "<the change, and the fault it stops>" \
     --label takes:triage --standalone "retro-sweep finding (<spec>)" --body-file <f>
   ```

   `<spec>` is `#948` in workflow-core. Exit 1 is a `gh` call that did not
   land: re-run once, reading its message first, since a create that landed
   before the failure files a duplicate. Exit 2 listing similar titles:
   read each listed issue, and only where none is this finding re-run with
   the `--distinct-from` it names.

   That `Standalone:` line is what bundles the finding: `/pick-next` launches
   the open findings as `/triage` sessions of at most 8, one decision each
   (workflow-core#1105). Keep the flag's wording, write no `Standalone:` line into the
   body yourself, and launch nothing from this run.

   The body carries, each under its own bold lead: the session id(s) and
   transcript path(s); the reduced-transcript line evidence — `L<n>` is the
   raw log's line, `[<agentId>] L<n>` the line of
   `<subagentDir>/agent-<agentId>.jsonl`; the retro category; the proposed
   environment change; the searches that came back empty; the plugin release
   each session ran on against workflow-core at `$H`. Any founder line it
   quotes, it quotes whole; a body written outside a candidate files no
   remediation the founder waived in that session (`brief.md` §4).

## 7. Run record

Build one compact JSON line (`jq -c`) in `$R/record.json`:

```
{"date","mode","week":{"start","end"},"seed","wfcHead",
 "picks":[{"sessionId","repo","release","pick":"rank"|"control","rank","score",
   "signals":{…},"classes":{"NEW","OPEN","FIXED-SINCE","COVERED-THEN","DECLINED","WRONG"},
   "ticketWorthy","tokens","model","stalled","dropped"}],
 "filed":["<owner/name>#<n>"],"lowValue":["<one line each>"],
 "tokenMeasure":"final-context","medianTokens"}
```

- `week` is the picker's `window`; `seed` is `null` in weekly mode; `wfcHead`
  is `$H`.
- `tokens` and `model` are §5's, `null` for a dropped pick. `tokenMeasure`
  names §5's measure; a line written before the field existed lacks it and is the same one (workflow-core#1052).
- `classes` count the pick's candidates before merging; `ticketWorthy` counts
  the merged ticket-worthy findings that pick showed — a finding seen at two
  ranks counts at both.
- `dropped` is the reason a pick produced no retro, else `null`;
  `medianTokens` is over the picks that were not dropped.

Then append, commit and push:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js claim docs/data/retro-runs.jsonl
jq -c . "$R/record.json" >> docs/data/retro-runs.jsonl
node ${CLAUDE_PLUGIN_ROOT}/scripts/commit-paths.js -m "<what changed>" -m "<why, then the tally>" -- docs/data/retro-runs.jsonl
```

Push by the repo's push rule.

## 8. Close

Close the issue the run came from with
`node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-ticket.js <issue> --comment-file <f>`. Every close
comment carries each session's cost, the median, and the ceiling line, which
names the model or models the picks ran on: where `medianTokens` exceeds
250,000, say the run passed the ceiling (target 150k per session, workflow-core#948
§Ceiling). It names the record commit, so it carries a
`**Door:**` line — two-way: revert the record commit and close the issues it
filed — a `**Bound:**` line naming which picks had a full retro and
which were read selectively, finished from an artefact or dropped, a
`**Values:**` line naming each house or untraced value it relies on, or
`none`, a `**Practice:**` line, and an `**Outstanding:**` line naming the filed issues, or none, each
with the snapshot search that came back empty for it.
`resolve-ticket.js` refuses an issue with an unticked criterion: tick each
the run met with `node ${CLAUDE_PLUGIN_ROOT}/scripts/issue-body.js tick <issue> --match "<criterion>"`
first.

**weekly** adds each pick's class tally, the filed issues and the low-value
count.

**Flip check:** where the line just appended is the **fourth** `weekly` line
in `docs/data/retro-runs.jsonl`, file a `takes:wayfinder` issue,
`--standalone "retro-sweep flip check (#948)"`: the share of NEW candidates
over those four runs (sum of NEW over sum of all classes), against workflow-core#883's
flip condition — under about 20% NEW means drop the practice to on-demand
(workflow-core#883 Q1 (B)).

**calibrate** adds:

- NEW ticket-worthy findings at each rank 1–8, and for the 4 controls, a
  finding counted at every rank that showed it, plus the merged total;
- each repo's NEW findings per session — every repo picked and every corpus
  repo, one with no pick saying so;
- **a proposed N with its reasoning**: the rank where NEW ticket-worthy
  findings fall below about one per session, capped by the tickets triage
  can absorb a week (state the cap you assumed, for the founder to correct) —
  or, where picks 7–8 yield as much as picks 1–2, a larger batch instead of
  N.

The founder confirms N on its own ticket; this run never writes
`retro.weeklyCount`.
