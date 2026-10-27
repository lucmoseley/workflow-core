---
name: pick-next
---

# pick-next

`scripts/pick-next.js` produces the shortlist; **this skill carries the
judgement** (mantahostels#102). `--goal`
takes a set of issue numbers and nothing else — the script has no parser to
extend.

## Read-only

**This skill and its script only ever read the tracker.** Selection's role is
**display duty** — show which issues are urgent, applied by whom and when, or
through which map.

The script does write local state under the gitignored `.claude/tmp/markers/.pick-next/`.

Held by mantahostels#101 (what defines urgency), which barred auto-stripping
`urgent`, and mantahostels#111 (who may apply `urgent`), which bars this skill applying one.

**One write is yours: discharging a met condition gate** (§3's GATED, #2279)
— an evidence comment and the marker stripped, never a label.

## The loop

### 1. Resolve the goal, if there is one

The user's goal is free text. Turn it into a **set of issue numbers**, and
**print the set before ranking anything** — mantahostels#106 (how a stated goal reweights the
queue) made this a condition of accepting free text at all.

One call gets every open issue with its parentage; walk it in memory rather than
per-issue:

```bash
gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --paginate \
  --jq '.[] | select(.pull_request == null) | {n: .number, parent: .parent_issue_url, title, labels: [.labels[].name]}'
```

One JSON object per line, not an array.

- **"drain #X"** — #X's open descendants, transitively, via `parent_issue_url`.
  Never walk `/sub_issues`: one call per issue, and its `per_page=30` default
  silently truncates a long child list.
- **"unblock #X"** — #X alone. The script passes goal-set membership to every
  issue holding #X out, through blockers and parents and across repos, and
  marks each such row `via` in the GOAL column (#3222). A child holds its
  parent, so #X's open descendants take it too, as "drain #X" would.
- **"clear Phase 0"** and other roadmap-phase goals **resolve thin, and you
  should say so rather than look broken.** Only a handful of open issues carry a
  real `<card-id> — ` title prefix. Name the ones that matched and state that the
  rest of the phase has no open issue.

A word naming a sibling checkout (a home-directory folder carrying
`.claude/workflow-core.json`) is no goal text: set it aside for §8's `--repo`.

With no goal, skip this step and run the script bare.

### 2. Run the script

```bash
node scripts/pick-next.js [--goal 116,117] [--limit 15] \
  --dump-bodies "$PWD/.claude/tmp/pick-next-bodies/${CLAUDE_CODE_SESSION_ID:-$$}"
```

**Always pass `--dump-bodies`** (mantahostels#409) — it writes one `<n>.md` per open issue,
at no extra request, for §4 to read. The directory is per session, so two
concurrent runs never write into each other's, and it is never under the job
directory, where every band file a subagent appends would draw
`lib/job-dir-scratch.js`'s warn (#1140).

**Every run writes its full report to `.claude/tmp/markers/.pick-next/last-run.json`, whether or not
you asked for `--json`** — every block the text output printed, machine-readable,
named on that output's very last line. Read it rather than re-running: the text
output is far too long to tail (`references/measured-figures.md`, "How long the
text output runs"), and a reader who tails it and loses the ranking block pays
a second full run for a report already on disk. **`frontier` in that JSON
carries the whole frontier, not the `--limit` slice** (mantahostels#1289) —
`frontierCount` still agrees with `frontier.length`. `--limit` governs
only the printed table (`shown` in `--json`).

**Write §6's message from `summary`, in one read** (mantahostels#1001) — it carries the
frontier count, the `no command` count and its rotted containers by number
(§5's third accounting term), the warm / provisional / to-derive split, the proposed set with
each member's `takes:` value and write-set, the owed-work counts, and, where
each applies, the readiness-unknown count and the frontier issues whose
`takes:` is missing or doubled — the whole frontier, not the `--limit` slice
(mantahostels#3363, the run that read a labelled issue as unlabelled). The text output prints the same figures as
`RUN SUMMARY`, second-last block. **Its `admit`, `freeSlots` and `reclaimable`
are the run's own reading and go stale where it matters** — §5 sends you to
`node scripts/admission.js --launch` immediately before the dispatch lines (mantahostels#1144), and
that re-read is what §6 states.

**One file holds whatever ran last, so check `generatedAt` and `repo` before
trusting it.** A `--repo` run leaves another tracker's report there, a `--no-log`
tooling run leaves one that dispatched nothing, and a run that died before its
report leaves the previous one untouched.

`--json` prints that same report. The sort levels, in order:
open `bug` → `urgent` (#2664) → goal-set membership → a `waiting:external` stall past 7 days →
ticket type (`wayfinder:grilling`, `wayfinder:prototype` and untyped
`takes:wayfinder` first, #2001) → chain depth → transitive downstream reach →
collision estimate → issue number. The first three pass to an issue from
anything it holds out, so a blocker ranks with the urgent issue it holds
(#3222); DEPTH is the longest chain to that tier.

The **TAKES** column is which command opens that issue (the values:
`docs/agents/triage-labels.md` §`takes:`). It is no filter, and a sort input
only through the ticket-type level. `none`, or two values joined by `+`, is a
defect in the labelling, not a state to interpret.

**The script is not the slow part, so never wait on it in silence.** A full run
takes **~21 s over 105 open issues** (measured 18 August 2026, warm — runtime
tracks the open count at roughly **0.2–0.25 s per open issue**). Go and look
when nothing has printed after about **three times that per-issue rate times
today's open count** (≈0.6–0.75 s × issues, an approximate count sufficing) —
never at a fixed second count (mantahostels#561).

- **Never `sleep` to wait on a backgrounded run.** The harness notifies on exit.
- **Never re-run for `--json`.** The run you already made wrote it to
  `.claude/tmp/markers/.pick-next/last-run.json`. The one exception is the run telling you it could
  not write that file — it prints `FULL JSON NOT WRITTEN`, and then the re-run
  is the only copy.
- **Every run appends a line to `.claude/tmp/markers/.pick-next/warm-fraction.jsonl`**, which
  `npm run warm-fraction` pools into the measured warm fraction
  (`references/measured-figures.md`). **A run made to exercise the
  tooling rather than to pick work passes `--no-log`**, or it enters the sample
  as an observation of churn that never happened (mantahostels#628). `warm` on that line is
  band-read warmth alone; the run's own predictions are counted beside it as
  `provisional`, and `covered` is the two together — the share of the frontier
  no band read has to touch (mantahostels#1001). **The 85.3% band-read figure
  predates pre-warming and is not comparable with a `pooled` taken since** —
  both sides of the change are in `references/measured-figures.md` (mantahostels#1054).
- **Every run also WRITES to the store**, one provisional entry per miss
  (mantahostels#1001). `--no-prewarm` suppresses that, for a run diagnosing why a ticket
  keeps going cold; nothing else should pass it.
- **Issue the run's independent calls in one message**, not one per turn.

Step 4 takes minutes only where something is still cold or needs a size, so
check the split before promising a wait, and say once that the run is going and
how long the band read will take. Nothing else: §6 is the output contract.

### 3. Read the caveats — relay almost none of them

These change what *you* do. They reach the user only where they change what the
user does, which is rare — bar §6's `Not launched:` and `Memory:` blocks:

- **DEGRADED** — an issue's readiness could not be established after a retry, so
  it was held out of the shortlist rather than assumed takeable. §6 relays it.
- **POSSIBLE FILE COLLISIONS** — pairs of issues whose bodies name the same repo
  file. `possible collision` pairs two candidates; `in flight` pairs a candidate
  with a **claimed** issue a session may be writing now. Both are inputs to
  step 5's substrate test. Their two limits: a body may name a file it only
  refers to, and a body naming no file can still collide, so read the
  write-sets rather than trusting the pairs. The printed in-flight list is
  capped, and a pair sharing only ruled stamp paths (`docs/doc-map.md` and
  `CLAUDE.md`, mantahostels#1301) prints as a summary count (stamp-sharing, not a
  conflict, mantahostels#1312); `--json` carries every pair.
  **`claimed by <login>` means a live session, not a bare assignee** (mantahostels#645):
  the login is whoever assigned it, but the row appears only where the
  arbiter holds a claim and `claude agents --json` lists that session. A claim
  whose session never assigned itself prints `claimed by a live session`, and
  carries an empty `claimedBy` in `--json`. Held
  files remain `node scripts/session-arbiter.js list` (mantahostels#437).
- **A goal band is a boost, not a filter** (mantahostels#106), and **the ranking is a
  snapshot, not a queue.** Both govern how you rank, not what you report (§6).
- **PROSE SELF-GATES** — a `**Blocked on** #<n>` line in the body, this
  repo's resolved against the open-issue list the run already fetched, at no
  extra call (mantahostels#1289). One still open or unreadable prints in the
  issue's `blocked by` reason as `<ref> (prose only)`, unless a native edge
  also names it, which already holds it out of the frontier. `--json`'s `proseBlocked` carries every issue naming
  one, `named`/`open`/`closed`/`unreadable` split, plus `unparsed`.
  **A marker naming no issue number is reported, never resolved** (mantahostels#927): the
  same block prints it as `NAMES NO ISSUE NUMBER` with the sentence itself.
  Matched unanchored, so it is found mid-sentence where the `#<n>` form is not. It excludes nothing — it is the whole input to
  §5's disqualifier 2.
  A marker may name `owner/name#<n>`; in another repo the run reads that
  issue's state.
- **PULLED IN FROM OTHER REPOS** — open issues in another repo that hold an
  issue here out through the blocked-by chain, at any depth, and that nothing
  open holds themselves (#2427). Each shows the issues here it holds and its
  reach over them; `HELD OUTSIDE THE LOOP` means no checkout here tracks its
  repo. Report them; a session here
  cannot launch them from this repo, the refill loop launches them from their
  own checkout. `--json` carries `pulledIn` and `pulledInUnread`.
- **GATED — a condition gate is yours to judge** (#2279). For each
  `**Gated on:**` row carrying a `check:`, run
  `node scripts/check-gates.js --issue <n>` and read the reading against the
  condition. **Met:** comment the evidence on the issue, strip the marker line
  and its `**Gate basis:**` line, and re-run the script so the issue enters
  the batch. **A DEAD, NO-OUTPUT, OVER-BUDGET or NOT-A-COMMAND reading is
  never met or unmet** (mantahostels#1332): repair or delete the segment. No
  exit code is a verdict. A row with no `check:` stays §5's disqualifier 2
  unless you can show the condition has happened.

### 4. Break the tail with judgement

Below the top band the script's order is issue number, which carries no meaning.

**Read the adopter's ranking rules on every run** (#450), at the host-root path
`node scripts/lib/workflow-core-config.js pick-next-ranking` prints —
`pickNextRankingPath` in `.claude/workflow-core.json`, else
`.claude/pick-next-ranking.md` (#455) — never from memory, and open any file a rule
points you at. No such file means no rules. The adopter owns it; the core
ships none and never writes it. Its rules order the tie band ahead of this
section's own criteria, which then order whatever the rules leave tied. They order the tail only, never moving an issue
across the script's sort levels. An adopter adds a rule by writing it there as
prose, never by editing this skill.

**Read every issue in the tie band before ordering any of it.** The band is
large — the census is on mantahostels#105 (the repo-wide frontier query that measured it) —
so a partial read reorders a sample and calls it the tail.

**That ordering read and the band read are two different reads, and only the
second is narrowed** by the nomination list below. Ordering needs every tie-band
body; deriving a `sizeBand` needs only the nominated ones. Where a subagent is
holding the body open anyway, taking the size costs almost nothing — the
nomination list is what you *must* size, not a bar on sizing more.

**Read the bodies off disk, from §2's `--dump-bodies` directory — never
`gh issue view`.** One `<n>.md` per open issue; tell each subagent the directory
and that its issues are files in it. Where the run reported it could not dump,
fall back to `gh issue view` and say so.

**Where the run's nomination list and cold list are both empty, skip the band
read outright** (mantahostels#1485) — read the run's `bandReadRequired` (`--json`) or its
`BAND READ REQUIRED THIS RUN` / `NO BAND READ REQUIRED THIS RUN` text line,
never re-derive it yourself. **This is the whole stage, not a shortcut inside
it**: dispatch no subagent, run no `pick-next-cache.js put`. Accept every
candidate's provisional write-set as given, and go straight to §5 — the
tie-band ordering above still runs, off the ranking, the adopter's ranking
rules and each candidate's existing gist (title-only where provisional). **No *new*
merge becomes possible** — `graph.mergeable`'s existing pairs still merge in §5
unaffected, and nominated being empty is not "nothing to merge"
(`references/measured-figures.md`, "Why skipping the band read forecloses no
merge").
**Keyed on the nomination and cold lists, never on `covered`** — a `covered`
threshold would fire on essentially every run and permanently disable merging
(`references/measured-figures.md`, "Why the skip is not keyed on `covered`").

**Band-read the run's BAND-READ NOMINATIONS and the cold entries, and nothing
else** (mantahostels#1484, which measured how much of a run the band read costs). The list is
`conflictGraph.nominated` in `--json` and a block of the same name in the text
run: every candidate that has no size *and* shares a non-stamp path with another
candidate. That is the whole set whose size can still change an outcome — why,
in `references/measured-figures.md`, "Why nomination is the whole set". **The list is
derived without reading `sizeBand`**, so provisional entries appear in it, and
stamp-only overlaps (`docs/doc-map.md`, `CLAUDE.md`) nominate nobody, those
issues running together regardless of size. **Refuse and reorder nothing on it**
(mantahostels#588): it changes what the read costs, never what may be dispatched.

**`cold` entries are read whatever the nomination list says** — they carry no
gist, and this step's *Done when* demands one for every issue in the band. They
can be nominated as well: a cold entry falls back to the paths its body
backticks, and that counts as a write-set here. The only class that can never be
nominated is `conflictGraph.noWriteSet`, whose write-set is empty.

**The cut this buys is small** — `references/measured-figures.md`. Nomination
narrows *which* issues get read; it does not make the band read cheap.

**The run splits the frontier three ways, and you band-read at most two of
them** (mantahostels#611, mantahostels#1001). `--json` carries all three, and the text run prints the same
split under `WRITE-SET CACHE` with the lists capped, so take the full ones from
`--json`:

- `writeSetCache.warm` — a band read's write-set, size and gist. **Take all
  three as given** and read nothing, except where the entry carries
  `unrevalidated`: git could not list the tree, so a path renamed since reads as
  live.
- `writeSetCache.provisional` — the run's own grep over the body, stored the
  moment it found the issue cold. A write-set, **no size**, and a gist that is
  only the issue title. **Band-read one only where the nomination list above
  names it**, or where its size decides the tie-band order and nothing cheaper
  will — a judgement, not the default. Needing its write-set alone costs you
  nothing. **It also carries `predictedSize`** (mantahostels#1289), a coarse
  `small`/`medium`/`large` guess. **Do not skip a band read on it** (mantahostels#1484) —
  why, in `references/measured-figures.md`, "Why `predictedSize` is not a skip".
  **It is not
  `sizeBand` and must never stand in for it** — mantahostels#588 bars refusing or reordering a
  candidate on a prediction, and §5's merge test reads `sizeBand` alone; a
  `predictedSize` of `small` still means read the band before treating the
  issue as `small` there.
- `writeSetCache.cold` — usually empty. A miss no prediction could cover, with
  the reason on `writeSetCache.prewarmSkipped`: a `wayfinder:map` issue, whose
  substrate is its own body, or a tree git could not list. **Band-read every
  one.**

**Do not grep the bodies yourself** — `scripts/lib/write-set-predict.js` is that
grep. Its comments carry the matching rules mantahostels#587 set. `docs/roadmap-digest.md`
and `docs/reference-roadmap.html` are one symmetric pair-closure unit
(mantahostels#1107): naming either in a body predicts both.

**Trust a provisional write-set on `docs/doc-map.md`, and nowhere else**
(mantahostels#587, mantahostels#1107). It carries no substrate/stamp call and no
size, so it replaces no part of the band read — grep-*instead* was the option
mantahostels#587 rejected.

**Never refuse a candidate on a prediction — warm or provisional — and never
reorder the band around one** (mantahostels#588). The dispatcher's `guard-file-claim` core stays the
enforcement tier, so a hit changes what the band read costs, never what a
session may write. Why reordering buys no time either, and where a future
attempt at the cold-re-pick cost should aim instead:
`references/measured-figures.md`, "Why mantahostels#588 bars reordering".

**The DOC-MAP QUEUE the run prints is a stamp queue, not a blocked one** (§5).
Those bodies name a `§B` entry, so `docs/doc-map.md` is where they finish, not
where they work, and several run at once. Read down it to the admission figure,
not just its top. It is a prediction: nothing is refused on it, and
`references/measured-figures.md` carries how often it is right.

Order them on what the script cannot see: which unlocks a decision others are
waiting on, which is cheap enough to finish in one session, which the user has
context on right now, which has gone stale enough that its body no longer
matches the tracker.

**Split the band across parallel subagents in a single message**, each returning
write-set, size and gist per issue and no body text — **size for the nominated
issues and the cold ones, and for any other where the read is already paid for**
(mantahostels#1484). **Each subagent writes its
findings to its band's scratch file as it reads, issue by issue** — never only
in its return: a run interrupted mid-band otherwise repeats every call it paid
for, and the growth check below has nothing to watch.

**Name that scratch file on an `Artefact:` line of its own** in each prompt —
`Artefact: <dump dir>/band-<k>.md`, expanded absolute (mantahostels#766).

**The subagent stores its own results — the parent never does.** Tell each one
to run this the moment it finishes an issue, before moving to the next:

```bash
node scripts/pick-next-cache.js put <n> \
  --body-file "<dump dir>/<n>.md" \
  --write-set "a.js,b.ts" --size <s> --gist "<one line>"
```

**Expand `<dump dir>` to the absolute path before pasting it into the prompt** —
the directory the run's `BODIES DUMPED — <n> to <dir>` line names. The prompt is
text, not a shell, so a variable in it is never interpolated.

**Name `model: "sonnet"` on every band-read `Agent` call** — `docs/effort-guide.md` routes a band read (file reads and write-set derivation) to Sonnet.

This command is the only thing that writes a *band read* into the store, and a
`put` clears an issue's provisional flag by storing over it. Prefer
`--body-file` on the dump file,
which carries its own hash; `--body-hash <hex>` off that issue's
`writeSetCache.cold[].bodyHash` is the fallback. Any other file is hashed as it
stands, so a body reformatted in transit stores a key nothing will ever match,
and `put` reports success either way.

**Storing is the subagent's job because a parent that batches it loses it**
(mantahostels#1003).

**Then watch the scratch files until the notification lands** — this is one of
`docs/agents/guard-registry.md` §Subagent dispatch's mandatory sites. No `ListAgents` poll, no
foreground `sleep`, no keep-alive. Watch each file with one backgrounded
`node scripts/watch-artefact.js <file> 120` — the 120 s a judgement, not a
measurement. Its `STALLED` or `MISSING` is the stall
test — a file that has not grown between two consecutive checks is presumed
dead (mantahostels#560): abandon it, never wait out the 600 s stream watchdog
(mantahostels#564, the ticket that measured half a band read dying silently).
When a band's completion notification arrives, `TaskStop` its watcher first.

**The fallback for a dead band** is the provisional entries already in the
store: abandoning a band costs its sizes and gists, not its write-sets (mantahostels#587).
**A dead band still owes the closing wave** where one is open: nothing wakes a
session whose subagent died, so write the closing sum over what the store
already holds rather than leaving wave 1 standing as the whole set.

**While that watch runs, dispatch a first wave** (mantahostels#1486). The turn that dispatches the
subagents ends anyway — `docs/agents/guard-registry.md` §Conventions: end the turn while
something runs — so the work below costs a turn that was going to be spent
waiting.

**Wave 1 is the candidates whose dispatch no size can change.** A candidate goes
in wave 1 when all three hold:

- it is not in `conflictGraph.nominated`, and not in `writeSetCache.cold`;
- it shares no non-stamp path with any candidate that is — dispatching it
  otherwise forecloses a merge the band read was about to make possible;
- §5's other two disqualifiers clear it: no substrate shared with a running
  session, and no self-gate.

An already-`mergeable` pair — both sides sized `small` before this run — belongs
in wave 1 as one merged line: that merge needed no read either.

**Then run §5 for that subset, write §6's wave-1 lines, and launch them through
§7 before ending the turn.** The accounting line is the partial one §6 spells
out, and `scripts/guard-selection-sum.js` accepts it only in that shape.
Everything else waits for the band read and goes out in the closing wave.

**Where the band read is skipped outright** — the nomination and cold lists both
empty (mantahostels#1485) — there is no wave 1: nothing is pending, so the set goes out as a
single dispatch with the ordinary full sum.

The band read is also the **only** place an issue body is fetched. A body you
pull yourself before or after it — to check a state, a title, a gate — is a
round-trip the subagent was already paying for.

**Done when** every issue in the tie band carries a write-set, and the band is
ordered.

### 5. Re-pick: dispatch every issue that can start now

Answer one question: *given what is running, which issues can start right now?*
Target the **largest** set the constraints genuinely allow.

**Admit by default and remove only on a named disqualifier.** A candidate you
cannot name one for is dispatched. An instinct that the set is getting crowded
is not a disqualifier — held-back work costs a session that would have run, and
the user can always decline a line.

Fill idle capacity to the admission limit (`docs/environment.md` §5 *Session
admission* defines how many sessions may run and carries the measurement). The
set is recomputed on **every issue close** — not on session exit, which a merged
session makes a different, later event — never topped up once it has drained.

**A recompute costs O(issues created or body-edited since the last run), not
O(frontier)** (mantahostels#690) — a close with nothing filed in between dispatches **no
band-read subagent at all**, and the expensive recompute is a charting burst
that files a batch of issues, never a close.
**Do not skip a recompute on a guess that it is expensive** — check the run's
warm/cold split, which is what the cost tracks.

**Substrate and stamp.** A candidate's write-set splits in two, and only one half
disqualifies anything:

- Its **substrate** is where the work lives — the files it opens early and edits
  throughout. Two issues sharing a substrate cannot run together, and neither can
  run against a session already holding one.
- Its **stamp** is a file it writes once, at the end, to record a result — on
  this repo, canonically a `docs/doc-map.md` §B entry. **Issues sharing a stamp
  run together.** They queue at the stamp, and a denial there is the designed
  path rather than a failure — but **which** designed path varies by file. On
  `docs/doc-map.md`: abandon that one edit, register the debt, finish the ticket
  (`docs/agents/guard-registry.md` §Conventions); `references/measured-figures.md` carries how
  routine that already is. On a file written through a loop with a pre-flight
  dirty-tree stop — `docs/reference-roadmap.html` through `roadmap-edit` or
  `/card-close` — it is
  **wait and retry, capped**: the stop fires before any work is done, so waiting
  costs nothing and abandoning loses a card edit for a collision that usually
  clears in a minute. Those loops poll for 5 minutes and only then fall back to
  abandon-and-debt (mantahostels#1073).

Judge which half a file falls in by **when** the ticket writes it — never by how
many candidates name it. A file every candidate stamps is the ordinary shape of
this backlog, not a reason to dispatch one of them.

**The errors are asymmetric, which sets the default.** A stamp misjudged as a
substrate under-dispatches silently and nobody finds out; a substrate misjudged
as a stamp costs one denied edit and a debt entry. **So dispatch on a tie.**
The stamp-queue rules mantahostels#422 set, and its open trigger:
`references/measured-figures.md`, "What mantahostels#422 rules".

**A path enters the stamp list on a ruling that issues sharing it run together,
never because many candidates name it.** Two paths are ruled: `docs/doc-map.md`
(mantahostels#422) and `CLAUDE.md` (mantahostels#1281).

**`docs/reference-roadmap.html` is neither, as a property of the path — it is
classified per ticket, by a reader test** (mantahostels#1074). It is **not** in the stamp
list and must not be added.

> **Ask what the ticket produces.** If the card text is the deliverable, the
> roadmap is its **substrate**. If the deliverable lands in another file and the
> card is amended afterwards to match, the roadmap is its **stamp**.

The tell, off the body alone: stamp bodies say *record*, *propagate*, *amend*;
substrate bodies say *write*, *migrate*, *correct the card*, or carry a findings
list.

**A card-count proxy does not work and must not be built** — the two open
counter-examples are in `references/measured-figures.md`, "Why a card-count
proxy fails".

**The third bucket is the largest: writes it not at all.** A decision ticket
under a wayfinder map names the roadmap because it is its subject, and files its
landing edits as a separate `takes:implement` issue. A `wayfinder` ticket is a
**non-writer**, not a stamp; the stamp shape belongs to a card's own issue
closing through `/card-close`. How large that bucket measured:
`references/measured-figures.md`.

**The roadmap pair is one classification unit.** `docs/roadmap-digest.md` is
never classified on its own account — it takes whatever
`docs/reference-roadmap.html` takes for that ticket (mantahostels#1075).

**`CLAUDE.md` is a stamp as a property of the path** (mantahostels#1281) — not
reader-tested per ticket, and it needs no test: issues naming it are dispatched
together and queue at the file. A collision there costs the `docs/doc-map.md`
regime — abandon that one edit, register the debt, finish the ticket.

**Contention is not the test, and `docs/doc-map.md` is the counter-example** — a
hot file is the ordinary shape of this backlog, not a reason to un-stamp one.
The three measurements carrying the first ruling are in
`references/measured-figures.md`, "Why `CLAUDE.md` is a stamp"; the collision
rates behind the second sit in the entry after it.

**Where the sentence is the deliverable, merge rather than carve out.** A
`takes:implement` ticket whose whole output is one `CLAUDE.md` clause is the
only shape that genuinely collides, and it is **not** a substrate exception.
Two such tickets are `small` and target different
sentences, so the merge test above applies: one session, both clauses, no
collision.

**The verdict is path-level so that no test runs at selection time** — an
undecidable bucket exists, being a property of the answer rather than the
ticket, and a path-level ruling never has to decide it.

**The run derives this graph for you — it is an input to the test below, never
the test** (mantahostels#1002). Every run prints a `SUBSTRATE-CONFLICT GRAPH` block and
carries it in `--json` as `conflictGraph`: which candidates name one file and
which file, which a **running** session's held files rule out and which session
holds them, a proposed disjoint set, and the pairs passing the merge test's two
mechanical limbs below. It never calls a file a substrate, so a
pair it prints may be two tickets stamping one file. And its proposed set drops
the lower-ranked of every pair, which is right only where the shared file really
is a substrate. Nothing is refused on it.

**Merging: several issues, one line, one session.** A candidate merges onto an
existing dispatch-set member's line when three tests pass together — **same
file, disjoint edit targets** (the section, `mantahostels#411` versus `§B17`, not just the
file), **and every issue in the merge sized `small`** (mantahostels#503, the ruling that
keyed the rule on size and target; evidence in
`references/measured-figures.md`). The substrate/stamp split above is
**deliberately absent** from that test: stamps qualify by construction — a §B
entry is small and targets its own section — and a substrate pair qualifies only
where both are genuinely small, which is the case where merging is safe anyway
(`references/measured-figures.md`, "Why the merge rule ignores the
substrate/stamp split"). It narrows the substrate
disqualifier rather than replacing it: two substrate-sharing issues still may not run as two
**parallel sessions**; a small pair with disjoint targets may be **merged into
one session**. The
target comes from step 4's band read, held in context for this run only —
never persisted, never derived by the script (mantahostels#506). `small` is a judgement renewed at each band read, never made
numeric, and the bundle still carries **no cap on member count** (mantahostels#508). **It is capped on accumulated context
instead** (mantahostels#1094): before each member begins, run `node
scripts/session-context.js`, and **over 200,000 tokens of live standing context
the bundle stops**. Spend is `turns x standing context`
([docs/research/allowance-burn-measurement.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md)), and member count barely
predicts it. The reading is one turn stale, so it is a floor; and an unreadable
transcript exits 2 rather than reporting a small number. ⚠ **It governs taking
another member, not a session already inside one.** A session inside a
member finishes it, even if a compaction fires, and starts no new one
(`docs/effort-guide.md`, #1178). Its other ceiling is fitting one session, and
that is judged as the session runs, not at dispatch:

- **Members run strictly in sequence, each finished completely before the next
  begins** — claim, work, commit, resolution comment with its own
  `**Outstanding:**` line, criterion ticks, close, release the file claims.
  Each member's close triggers this section's recompute at once (mantahostels#533, the
  context-overrun ruling).
- **A member that blocks another open issue goes first in the bundle** (mantahostels#510,
  the barrier ruling).
- **The session stops at a member boundary** on either signal: the 200k context
  cap above, or its own judgement that it can no longer do the next member
  justice. At a boundary it releases the issue claims on the unstarted
  members (`node scripts/session-arbiter.js release-issue <n>` per member) and
  names them in its final report. They stay untouched open issues that
  re-enter the frontier at the next recompute; no umbrella issue, no handoff
  artefact (mantahostels#533).
- **The ceiling guard's notices send a bundle to a member boundary** (#1178),
  as above. At the 300,000 tripwire, compaction did not fire: commit, comment
  the member's unfinished state on its issue, and end the turn.
- **The session claims every member at dispatch, and recovery is a read, not an
  action**: an issue assigned to a session `claude agents --json` reports as
  not live is treated as unassigned. An oracle that cannot be read means the
  claim stands and the member is not re-dispatched (mantahostels#533; the liveness read
  is mantahostels#437's, its reach verified at mantahostels#594).
  **Claim each member with `node scripts/claim-issue.js <n>`**: it assigns
  you, writes the arbiter claim that makes the assignee readable as live
  (mantahostels#645), and takes `parked` off (#2703), which no bare `gh issue
  edit --add-assignee` does. The release at the member's close is made for you
  — `scripts/release-issue-claim.js` drops the claim off a `gh
  issue close <n>` run through the Bash tool (mantahostels#706); run `release-issue <n>`
  by hand on a close made from the web UI, by a script or through `gh api`,
  one carrying `--repo`, or one whose issue number is a shell variable.
  A member you assign but never record **stays in everyone's shortlist** — the
  script lists it under ASSIGNED BUT UNCLAIMED and treats it as takeable.

**What merging costs and buys, and never refuse a merge on cost**:
`references/measured-figures.md`, "Merging pays, and by how much".

**Retro-sweep findings bundle by rule, not by the merge test** (#1105, #1093
Q1 (D)). The run prints `RETRO TRIAGE BUNDLES` and carries `retroBundles` in
`--json`, entries `{issues, model, prompt}` (#1206): frontier `takes:triage`
issues bearing `retro-sweep`'s `Standalone: retro-sweep finding` line, in the
fewest bundles of at most 8, balanced (9 makes 5 + 4). Each bundle is one
session, one slot: one §6 line, `**<n>, <n>** - takes:triage · <model>`, and
one §7 prompt — copy both as printed, or take the entry's `model` and
`prompt` verbatim; never rebuild a prompt from `issues`. Only that prompt's
trailing clause tells the launched session each finding keeps its own
decision, round comment and brief (#1195). The run keeps members out of the
conflict graph: `/triage` writes no file. Other `takes:triage` issues launch
singly.

**Remove a candidate only for one of these:**

1. **It shares a substrate** with a running session or with a member already in
   the set. Read write-sets, not §3's collision pairs, which are the floor. Where
   two candidates share one, try the merge test above first; only where it
   fails, keep the better step-4 ordering.
2. **It is self-gated** — its own body holds it until a date or condition that
   has not happened. Quote that sentence, so the user can overrule it. The
   script excludes the issue itself for both written spellings — a date as
   `**Gated until:** YYYY-MM-DD — <why>` (mantahostels#85, no working channel to
   an outside partner), a data condition as `**Gated on:** <condition> — check:
   <command> — abandon if: <clause>` (mantahostels#1419) — so this step covers only a gate
   nobody has written either way yet. **A third spelling is printed for
   you** — §3's `NAMES NO ISSUE NUMBER`. Read that block every run and treat a
   hit as this disqualifier unless you can show the condition has happened;
   nothing excludes it mechanically. **Never judge takeability off a warm cache
   entry's `gist`** (mantahostels#927): the cache has no field for a gate.
   **A line on how the session must run is never a gate** (#851): a
   permission mode, "interactive", "founder approving each write". Dispatch
   it; an auto-mode refusal is handled per
   `docs/agents/rules/founder-handover.txt`.
3. **Admission has no slot left.**

**Report a hold — an empty set — with which of three caused it:**

- **Nothing new is unlocked.** The top candidate is the same issue that was top
  before the last close, and no closed issue cleared a blocker.
- **Every candidate shares a substrate**, with a running session or with each
  other.
- **Headroom below one slot.** The run's ADMISSION block says `HOLD`.

On a hold, say what would clear it — a close, a file released, memory freed.

**Admission is measured, not a slot count**: k more sessions fit while the aggregate
draw of the live sessions and k more, at p95 and less what the live ones already
hold, stays within free memory less the spare-pool reserve, earlyoom's 794 MB kill
line and a 300 MB margin (#2221; `docs/environment.md` §5), with one always
admitted when no session is running. The count is what
`claude agents --json` lists, less this run's own; the count reaches a session
driven interactively in a terminal (verified at mantahostels#594), and the memory figure
sees one either way (mantahostels#437). **Memory is rarely what binds**, so where a
substrate is the real ceiling, name that file rather than reporting the slot
count as the limit.

**Re-read the machine here, immediately before writing §6's lines** — run `node
scripts/admission.js --launch`, which reads `/proc/meminfo` and `claude agents --json`
and prints the slot count, each slot priced with the spare pair its launch
warms as the dispatcher's re-read prices it (#2568), instead of doing that arithmetic in prose off the
figures §2's run printed (mantahostels#1144). **Exit 2 is a
refusal — either figure unreadable — and it means start nothing**: an
over-admission freezes the machine. Exit 1 is the HOLD, exit 0 the admit, and
the `test suites` row applies the concurrency bands below to the memory it just
read.

**Take `min(the DISPATCHABLE FLOOR §2 printed, the slot count admission.js
just gave you)`, and compare it against the issues about to be dispatched.**
Where the set is smaller, dispatch the difference or let §6's `Not launched:`
name why. **The floor over-counts by construction** — conflict detection sees
only predicted write-sets, and an empty one clashes with nothing (mantahostels#1506) — so
a set below it is ordinary. **Nothing refuses a message on this figure, and nothing ever will.**

**Once per wave, not once per run.** A two-wave dispatch (§4, §6) writes §6's
lines twice, minutes apart, with the band read in between — the very interval
this re-read exists to cover. So the closing wave runs `node
scripts/admission.js --launch` again, against the machine as it now stands: wave 1's own
sessions are running by then and the figure has moved in both directions.

Why re-read at all: §4's band read is minutes long by design and sessions finish
during it. The error is one-directional — sessions finish while you wait, they do
not start — so a stale figure only ever under-dispatches, costing a session that
would have run. Costs about two seconds. Reaping idle sessions first is not a
substitute: it narrows the window, it cannot close it. How stale one reading
got: `references/measured-figures.md`.

**A `reclaimable` row in that block means the headroom is understated, not
spent** — the run counts the sessions the oracle reports finished and still
resident, whose memory `free -m` reads as used. **Reading `unknown (<reason>)`
it counted nothing** (mantahostels#1237): the pool could not be sized, so the understatement
could be any size, including none. **Do not reap here**: a reap fired at this point pays
an oracle spawn against the very figure it is measuring (mantahostels#1029, mantahostels#653). It has a
second trigger elsewhere — `npm run test`'s own `pretest` (mantahostels#1840) — so a session
start is not the only one. **Nor is it a way to un-stale §4's reading** —
at the 1-minute grace a band read outlasts the reaper's window
(`references/measured-figures.md`). Size the set on the figure as read — §6's
`Memory:` block carries it — and start it: each session the set starts reaps whatever is past grace on its way up.

**Concurrent test suites: one whole suite at a time (#2680), on a headroom ladder.** 1/2/3 suites
need **~2.15 / 3.25 / 3.65 GB resting** at launch (all three measured at
3 workers a suite, #1603; a lone whole suite runs 5 workers and is charged ~2.9 GB), extrapolated below ~7.7 GB. **There is no flat allowance above the ladder and
four is unmeasured** — 3 GB buys one. Builds and dev servers at one, unmeasured.
`docs/environment.md` §6 owns all three. **The ladder governs concurrent suite
*launches*, and caps the size of a dispatch set at nothing** (mantahostels#1476). It is a resting-headroom test applied per launch
inside an already-admitted session by `scripts/guard-suite-concurrency.js`, a
`PreToolUse` hook that sends a launch short of its rung to the queue (#2305).
Admission and the substrate test are the only things that cap the set.

**Done when** every issue on the frontier is either dispatched, carries one of
the three named disqualifiers, or sits in the band **no command opens** — and
the three counts add up to the frontier's size.
**State that sum, in §6's line, and do the accounting before you write it.**

**The third count is a band, not a fourth disqualifier** (mantahostels#1622). It is the
frontier issues no `/`-command can open: **`takes:human`**, plus a
**`takes:children` container whose last child has closed**. A `takes:human`
issue in it is **unblocked founder work sitting idle, not something wrong**, and
lumping it into `disqualified` hides a queue nobody is draining.
**`takes:children` is not a category here**: a container with
open children never reaches the frontier at all, the run excluding it as
`container — <n> open children`, so one that does reach it is mislabelled — the
run prints those by number under `no command` so the band gets **drained**, not
retagged mid-selection.

**Copy the figure, never count it.** §2's run prints it in its RUN SUMMARY as
`no command`, and the marker pins it, so an invented one is refused.

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **Enforced** (mantahostels#844, mantahostels#1321, mantahostels#1486, mantahostels#1626): `scripts/guard-selection-sum.js`, a `Stop` hook, blocks a dispatch or hold message that omits the line, whose numbers do not add up, or whose frontier or `no command` count is not the one the run measured — capped at **3 blocks a session per stake tier**, and silent thereafter: a `no command` term written after `pending` spends its own shape budget, never the one these checks rest on (mantahostels#3431). It examines only a session scripts/pick-next.js has actually run for — a `--no-log` run mints no marker and arms nothing. **A two-wave dispatch states the sum twice against that one marker** (§6): a partial sum naming what is pending, then the full one, with every turn in between owing a line of its own.
<!-- guard-registry:end -->

**Every disqualified issue is named in §6's `Not launched:` block**, by number
under its disqualifier (mantahostels#1321, the ticket that measured a cut candidate
going unnamed; #594).

### 6. Dispatch

Print only what changes what the user does next.

One line per session, in start order, with no preamble above them:

> **`<issue number(s)>`** - `takes:<value>` · `<model>`. More info only where
> absolutely essential.

**A merged bundle is one line — this contract's "member" counts sessions, not
issues** (mantahostels#507). The bundle's issues appear as comma-separated numbers in work
order, the blocking issue first (§5). The
`takes:` value prints once — a merge never crosses values. Titles, gists and
the merge rationale are never printed.

> **341, 353, 366** - takes:implement · opus. mantahostels#341 first: it blocks mantahostels#412.

**The model follows from the `takes:` value** (mantahostels#1093, which ruled which
session kinds launch on plain Opus rather than Sonnet; #354). Sonnet is allowed only where a check would catch its error
before it lands. A `sonnet`
line also gets an Opus advisor (mantahostels#1102) — print the bare model name, and §7's
script attaches it. Models come from `scripts/lib/launch-models.sh`, and a
test fails where this table disagrees with it (#361):

| `takes:` | Model | The check that catches a Sonnet error |
| --- | --- | --- |
| `implement` | `opus` | Not routed down: at Opus 5.5 prices Sonnet saves too little (`docs/effort-guide.md` §Model ids and prices) |
| `to-tickets` | `opus` | Not routed down (#1920): the founder check that justified Sonnet does not happen while the refill loop launches it |
| `triage` | `opus` | Not routed down (#1920): the founder check that justified Sonnet does not happen while the refill loop launches it |
| `wayfinder` | `opus` | **None exists** — the output is a decision, and no gate reads prose |
| `to-spec` | `opus` | **None exists** — same |

An unclassified session gets `opus`, not `sonnet` (mantahostels#1088).

Essential info is a blocker: a self-gate to check first, a file a running
session holds, a decision or measurement it needs, a sequencing constraint
against another member or a downstream issue, or a body stale enough to
mislead whoever opens it. Where a session has none, the line ends at its
`takes:` value.

Then §5's accounting, always, on a line of its own — the one line here that
prints whether or not it changes what the user does next, because it is what
stops the set being silently short:

> `Frontier 60: 5 dispatched + 51 disqualified + 4 no command.`

`Frontier` is every issue the run left unexcluded — not the shortlist `--limit`
printed, and not the goal set, which is a boost and never a filter. `dispatched`
counts issues, not sessions, so a merged bundle contributes each of its members.
`no command` is §5's third term, the RUN SUMMARY's `no command` row; mark its rotted containers for retagging.

**An issue the launcher has already launched is not in that count** (mantahostels#1528). The
run excludes anything launched inside the 1-hour window
`scripts/dispatch-sessions.sh` drops on, printing them under
`ALREADY DISPATCHED` with the age and prompt of each. The hold keys on issue
and command (#752): an entry excludes an issue only while its `/<skill>`
matches the issue's current `takes:` value. So an issue a `/triage` launch has since relabelled
`takes:wayfinder` is back on the frontier inside the window, and a prompt with
no readable command holds as before. Where the ledger will not
read, the run prints `DISPATCH LEDGER DEGRADED` and excludes
nothing — this denominator is then back to over-counting, and the set may lose
members at launch.

**Two waves, one run: the message contract** (mantahostels#1486). Where §4 dispatched a
first wave before the band read returned, that turn's set is not the whole set,
so its sum cannot add up. It states a partial one instead, naming the count
still pending, and the closing wave states the full sum — same frontier, same
run, one marker:

> `Wave 1 of 2 — frontier 60: 3 dispatched + 37 disqualified + 4 no command + 16 pending band read.`
>
> `Wave 2 of 2 — frontier 60: 5 dispatched + 51 disqualified + 4 no command.`

Four things the guard holds you to, all of them clearing the same way:

- **The four counts add to the frontier** on wave 1, and the three counts add to
  it on the closing wave. Both state the frontier this run measured, and both
  state the same `no command` count — the band does not move between waves.
- **A pending count of 0, or a closing wave still carrying pending, is
  refused** — either is the full sum written in the partial's shape, or a set
  that accounts for nothing.
- **While a wave is open, every turn of this session owes an accounting line.**
  Still waiting on the band read? Re-state the wave-1 line as it stands. A first
  wave that is never topped up is a silently short set, which is what this check
  exists to refuse.
- **Wave 1 owes no `result:`/`needs input:`/`failed:` mark in a background job.**
  It ends waiting for the band read to wake it, so *Working* is the right
  filing. The **closing** wave owes one as any dispatch does.

The closing wave's lines are the wave-2 sessions only. A restated wave-1 line
is recognised and never counted twice, but §7's launcher exits 4 on a call whose
every member is already dispatched — so where the band read frees nothing new,
the closing wave states its sum with **no dispatch lines at all** and makes no
second launch call.

**Then three blocks on every dispatch or hold — on a two-wave dispatch's
closing wave only** (#594):

> **Not launched:**
> - no admission slot: #1317, #1320
> - gated in its body: #1332 — "<the gating sentence>"
>
> **Memory:**
> <the `memory` rows of the latest `admission.js` read, verbatim>
>
> **Open:** <the RUN SUMMARY's `open tally` row, verbatim>

`Not launched:` groups every frontier issue that did not start under the first
reason that applies: `no command`, `file held by a running session`, `shares a
file with #<n>`, `gated in its body`, `no admission slot`, `already
dispatched`, `allowance cap`, `memory refused at spawn`, `launch failed`. Start
from `--json`'s `notLaunched`, keeping its file and session details; confirm or
clear each provisional `shares a file` after the band read, quote disqualifier
2's sentence, re-set `no admission slot` on §5's re-read, and add §7's drops. A
merged issue counts as launched.

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **Say `none` rather than omitting the `Not launched:` block** — an omission is indistinguishable from the silence this exists to refuse. **Enforced** (mantahostels#1321, #592): the same `scripts/guard-selection-sum.js` `Stop` hook blocks a dispatch message with no such block where the sessions dispatched reach or exceed the free slots scripts/pick-next.js measured — on the same `.selection-sum-nagged-` counter as the rule above's consequential checks, so the two share one cap of **3 blocks a session** and are silent thereafter. It fires on `>=` because §5's re-read only ever finds *more* slots than the run did. **Across two waves it counts the whole set**, wave 1's sessions included, and never fires on wave 1's partial count on its own (mantahostels#1486). Under-dispatch below that figure is deliberately not checked: an exhausted frontier looks identical. **Its reasons, `Memory:` and `Open:` are Unenforced.**
<!-- guard-registry:end -->

Then only these, one line each, only where each applies:

- **Hold** — the set is empty: which of §5's three causes, and the single event
  that lifts it. A hold still ends at §8.
- **A window the set closes** — a candidate takeable only while nothing runs,
  which starting the set forecloses.
- **A defect in a frontier issue's labelling** — its `takes:` reading `none` or
  two values joined by `+`, pointing at `npm run check:labels`. Frontier-wide,
  not the dispatch set (mantahostels#3363).
- **DEGRADED** — where the run reported it, one clause: the shortlist is not the
  whole frontier.
- **Come back when an issue closes, not when the set drains** (§5).

### 7. Launch

**Start the set yourself — it needs no confirmation** (founder's ruling,
mantahostels#1153). One call, every session in it:

```
scripts/dispatch-sessions.sh <model> "/<skill> <issues>" [<model> "<prompt>" ...]
```

One `<model> <prompt>` pair per §6 line, same order. The prompt is the launch
command as it would be typed into the agents view — `"/implement 341 353 366"`
for the bundle above.

**A two-wave dispatch calls this twice** (§4, §6) — once for wave 1 while the
band read runs, once for the closing wave. Each call carries only its own wave's
lines, and each is bound by the allowance and duplicate-drop rules below on its
own; the second call sees wave 1's sessions in the running-session list, and
charges each of them against the cap below at a full session's spend — yet
still launches one while the bar reads under 100%, the floor applying per call.
**Report what each call printed**, not just the last.

**Why a script and not `claude --bg` directly.** Three things it does that a
hand-typed launch does not:

- **Caps the set once a rate-limit bar is past its threshold** — 90% of the
  5-hour bar, 97% of the week (#369, #371). It launches only the prefix of the
  set, in §6's order, projected to just reach 100% of that bar, counting what the
  sessions already running are expected to spend yet, and at least one while
  the bar reads under 100%. It prints
  `CAPPED: launching N of M on the <bar> bar` and names each dropped member.
  Of the cap's own verdicts, only a bar at 100% refuses, exit 3. The bars are read primarily off the
  `cachedUsageUtilization` JSON cache `claude -p "/usage"` refreshes, falling
  back to the printed bars only where that cached reading is stale or absent
  (#280, #294). **Fails closed** — no trustworthy reading from either source
  refuses the launch and says the absence is likely transient (re-run, or
  `--force`), distinguishing a broken check from a real limit.
- **Attaches `--advisor opus` to every `sonnet` line** (mantahostels#1102). Never type the
  advisor into a §6 line; never set `advisorModel` in settings, which would
  attach one to every session in the repo and to their subagents too.
- **Says whether the advisor is live on this machine.** It is behind an
  experimental feature flag, and off it reports nothing at all — so a Sonnet
  session would otherwise run bare, with no escalation path. It reads the flag,
  not the sessions it starts: a launched session reports its own advisor
  nowhere.
- **Drops any member whose issues are already dispatched** (mantahostels#1337) — off a
  ledger of past launches and off the running sessions, so a session that lost
  its own launch from context cannot launch the same set twice. It names each
  one it dropped on stderr, prints
  `Launching N of M set(s)`, and launches the rest. So **read that line before
  believing §6's dispatch list ran in full** — a partial launch exits 0 like any
  other. It exits 4 on two causes only: every member was already dispatched, or
  the drop list could not be read, where the whole set is refused rather than
  launched blind. It **fails open** otherwise: an unreadable ledger or session
  list warns and permits. The picker excludes ledger entries itself (mantahostels#1528),
  so a drop here means a launch this run could not see — one made outside the
  script, or one the picker's own ledger read missed.

`--force` skips the allowance cap and the duplicate drop, never the
advisor line and never the memory re-read before each member's spawn — an
over-admission freezes the machine. `--force-memory` skips that re-read and
nothing else (#299) — the CPU load ceiling still holds each member (#834).
`--no-advisor` launches Sonnet bare and silences that line — for when the flag
is off and the warning is noise. `--dry-run` prints the commands without
starting anything.

**Report what it printed** — its `Allowance OK: week N%, session N%` or
`CAPPED:` line, its `Advisor OK` line, any `WARNING:` or `NOTE:` in full, or its refusal in full.
A `NOTE:` says the run changed something about itself rather than about the
set. On a refusal
the set is not started, so §6's dispatch lines stand as the record of what to
launch once the bar refills. A **partial** launch is not a refusal: its dropped
members go in §6's `Not launched:` block under the launcher's reason, and stand
as that record — a `CAPPED:` cut included.

**A partial launch (`Launching N of M set(s)` with N < M) frees the slots the
dropped members would have used — top them up before the founder-facing
message goes out** (mantahostels#1529). **A `CAPPED:` cut frees nothing**: its
members were dropped for allowance, not slots, so they are never topped up. §6's dispatch lines are drafted content, not yet
sent — nothing stops here just because they exist. Re-read
`node scripts/admission.js --launch` for the free-slot count now, and launch the next
candidates by §4's ordering — the tail already read, next in line, not a
fresh `pick-next.js` run — until either the slots or the candidates run out.
Repeat this same launch call for the top-up set; it is bound by the same
allowance and duplicate-drop rules as the first, its own floor of one included. **The message you send
states the combined total**, first launch and top-up together, not just the
first call's count, and its `Not launched:` block loses each issue the top-up
started. **The top-up is a skill-level step, not part of
`scripts/dispatch-sessions.sh`**: that script knows N < M but not §4's
ordering for what replaces the drop.

**Never `claude agents --model`**: that sets a view-wide default and would move
every session launched from that view, not just this set.

### 8. Start the refill loop over this repo

**Every run ends here** — after §7's last launch call, and equally after a
hold, an admission refusal or a launcher refusal: run once

```bash
node scripts/refill-loop.js start [--repo <dir>]… [--goal <§1's set>]
```

It starts or renews, for 24 hours, the machine's one loop in **normal mode**:
this repo, plus each sibling checkout the founder's command named, passed by
its directory name. The goal is §1's set, if there is one (#2119). Never pass
`--away`: away mode, every included repo, starts only on the founder's explicit
ask. A running away mode is left as it is. Copy the lines `start` prints —
mode, repos, goal, stop time — and any `WARNING:`, into the message.
**Unenforced**: no hook checks the call was made.

---

## Measured figures

**`references/measured-figures.md`, alongside this file, holds them** — every
figure this loop rests on with what invalidates it: run cost and end-to-end
timings, the warm-fraction and `covered` readings either side of pre-warming,
write-set and `predictedSize` precision, band-read wall times and stall history,
what merging costs and buys, the assignee/claim-liveness measurements, the
substrate/stamp classification evidence, and the open triggers. It is
an evidence appendix: **read it only when a run needs a figure or its
condition.** Every number a step decides on is already inline in that step.
