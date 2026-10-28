---
name: rescue-sessions
description: Session stranded on another plan's usage limit? Adopt it here or move it to this plan. Frozen session? Kill it and take over.
---

# Rescuing stuck sessions

This machine runs several plans, each with its own config dir (`~/.claude`,
`~/.claude2`, `~/.claude3`) and allowance. Two paths, in the order to reach
for them:

- **Cross-plan** — the common case. A session on another plan hit its session
  or weekly limit mid-flight. Adopt one here, or dispatch several to fresh
  sessions on this plan (mantahostels#2605).
- **Takeover** — one session has frozen, not hit a limit; stop it and adopt
  its ticket (#617, the takeover spec).

## What makes this work

A dead session's transcript survives in its own config dir and is readable from
anywhere on the machine. **So point the successor at the dead session's narration
rather than summarising it.**

## Cross-plan: rate-limited sessions onto this plan

### 1. See what is stuck

    node scripts/rescue-sessions.js list --from ~/.claude3

It prints liveness per job, asking the source plan's own daemon. `process GONE`
means the file claims are stranded, and the next session to write each file
retakes it.

**What `list` will not tell you: whether the session is stuck on the rate limit
at all.** Read the `detail` field yourself ("You've hit your weekly limit" is
one). A session blocked on its own question needs that question answered, not a
rescue; a session whose work is finished needs nothing.

### 2. Snapshot before stopping anything

    node scripts/rescue-sessions.js snapshot --from ~/.claude3 --out .claude/tmp/rescue

Add `--ids` to take only the sessions you are rescuing. Copies each
`state.json` and transcript, extracts the narration, and writes
`index.json` (Reference: what the snapshot already worked out). **Do this first.**

### 3. Stop the source sessions

    node scripts/rescue-sessions.js stop --from ~/.claude3 --ids a1b2c3d4,e5f6a7b8

### 4a. One session: adopt it here

Claim its issue (`node scripts/claim-issue.js <n>`), read
`<short-id>.narration.txt` whole and its job's `commitsLanded` and `artefactsSurvived` in `index.json`, then continue
under the same command from where it died: a `/wayfinder` stays a `/wayfinder`.
`references/RESUMPTION.md` §2–§5 bind you as they would a dispatched successor,
its commit command run as `node scripts/commit-paths.js`.
Recover its in-flight subagents first (Reference: subagents that died with it).

### 4b. Several sessions: dispatch them

Sort the tickets by death point (Reference: death points, below). **The
destination plan is whichever config dir you launch from.** Check it has
allowance first: `node scripts/claude-child.js usage --config-dir <dir>` prints
both bars and spends no model tokens. Where it hangs or prints no bars, read the
last cached bars instead — `node scripts/allowance.js --config-dir <dir>
</dev/null` — and say in your report that the reading was cached.

Copy `references/RESUMPTION.md` into your snapshot directory, changing only
the script its commit command runs to `scripts/commit-paths.js`. Then
one short brief per ticket, `<ticket>-brief.md`, carrying only:

- a pointer to `RESUMPTION.md` and to `<short-id>.narration.txt`;
- **which of its own commits landed, and which of ITS artefacts survived** —
  read straight off `index.json`'s `commitsLanded` and `artefactsSurvived`
  for that job;
- **where it died**, in one or two sentences, and each in-flight subagent's
  `Artefact:` path;
- anything that has changed *under* the ticket since it died — a neighbour's
  commit touching its files, a blocker that has cleared.

Dispatch one ticket first and read its result:

    scripts/dispatch-sessions.sh \
      opus "/implement <n> — RESUMED from <plan> session <short-id>; read .claude/tmp/rescue/RESUMPTION.md then <n>-brief.md FIRST"

Add `--force` only on the exit-4 refusal, which means the source plan's dispatch
of that issue is still inside the ledger's one-hour window. `--force` also skips
the allowance gate, so read the allowance yourself first; never add
`--force-memory`, which skips the per-member memory re-read.

Then dispatch the rest in one call — `dispatch-sessions.sh` staggers them and
re-reads memory per member — tickets whose half-written files break *other*
sessions' tests first.

### 5. Watch, and expect the tree to be red

While the rescue runs, the shared tree holds several dead sessions' uncommitted
work at once, so **no full suite can go green for anyone** until each lands. Every
successor must be told to run only the tests it touched — the bare
`npm run test` with the `landing` module on, `npm run test:changed` with it
off — commit by pathspec, and
prove a red is a neighbour's by running the failing files in a detached worktree
at clean `HEAD` rather than trusting the `mantahostels#291` banner.

Watch with one backgrounded beat. A beat checks the issue states and
`git status --porcelain | grep -c '^ M'`; the dirty count falling is the
progress signal that matters. `claude agents --json` reads ONE plan, so scope it
to the destination dir.

## Takeover: one frozen session

The founder names it by ticket or session id. One call does the whole thing —
probe, snapshot, stop, confirm, claim, ticket comment — and refuses before any
write unless the verdict allows it:

    node scripts/rescue-sessions.js takeover --issue <n>        # or --session <id>

It samples the holder twice, 120 s apart, then allows up to 60 s for the stop
to confirm, so expect two to three minutes; a GHOST is named off the first
sample, in seconds. `--issue` finds a holder by its ticket claim, or, where
none is held, by an unfinished job whose intent names the ticket. Asked only "is it frozen?", run `probe` with the same
arguments: it stops nothing.

**On GHOST** (exit 9 from `probe`; exit 0 from `takeover`) — the job never
started: its record reads `working`, no plan lists a process for it, and it
wrote no transcript. `takeover` keeps its record under `.claude/tmp/rescue/`,
stops it, and prints the `dispatch-sessions.sh` command that re-launches its
intent. Run that command rather than continuing the work here.

**On LIMITED** (exit 10 from `probe`) — it is blocked at its seat's session or
weekly limit, and sits there until someone types to it after the reset.
`takeover` adopts it as it does a FROZEN one.

**On a refusal, act on the verdict it prints**, never around it:

- **ASKING** (exit 5) — it is waiting on an answer. Answer its question where
  you can, else put it to the founder; do not stop it.
- **SLOW** (exit 7) — it is still working. Leave it alone and say so.
- **DONE** (exit 6) — its work finished. Release its claim or close the ticket;
  there is nothing to adopt.
- **UNKNOWN** (exit 3) — an input would not read. Re-run once; if it holds, tell
  the founder which input.
- Where the founder asked for the kill and the verdict is ASKING or SLOW, put
  the verdict and its evidence lines to them as a priced round: stop it anyway,
  or leave it.

**`--despite SLOW|ASKING --reason "<their words>"` only on the founder's own
message, written after they saw that verdict, saying to stop that session
anyway.** Never pass it on your own judgement, and it never overrules
UNKNOWN or DONE. The reason and the overruled verdict go on the ticket.

**On success** (exit 0; exit 1 after `claimed:` means only the assignment or
comment failed, and says how to finish it) it prints, and writes to
`.claude/tmp/rescue/<n>-<short>/RESUMPTION.md`, the dead session's intent,
narration path, death point, commits landed, artefacts survived and file
claims. **Read `RESUMPTION.md` and the narration file yourself, then continue
that intent in this session**: an `/implement` stays an `/implement`, from
where it died. Its dirty files are now yours to finish: your next write to each
takes its claim, unless the takeover says its claims stay held — then free
one with `node scripts/session-arbiter.js release --force <path>`.

## Reference

### What the snapshot already worked out

`snapshot`'s `index.json` carries, per job, four fields beyond the state and
transcript copies:

- `deathPoint` — the session's own last few things said.
- `commitsAttempted` — every `git commit` or committing `commit-paths.js` call
  the job ran, read as the guards read commands: a `--tree` pin is none.
- `commitsLanded` — which of THOSE attempts actually landed, matched by
  message against `git log` in a lookback window around the job's death.
  Matched, not merely dated: several sessions commit to `main` concurrently
  here, and a bare time window would attribute a neighbour's commit to this
  job. `null` means git could not be asked at all; `[]` means it answered and
  nothing matched.
- `artefactsSurvived` — every `Write`/`Edit` path in the PARENT session's own
  narration that still exists on disk. **Does not see a subagent's own
  writes** (Reference: subagents that died with it).

### Subagents that died with it

A subagent dies with its parent and leaves its artefact part-written. The
narration marks each dispatch with an `[Agent]` line but carries neither its
full prompt nor its report, so read `<short-id>.transcript.jsonl`: a dispatch
whose tool-use id has no `tool_result` or `<task-notification>` after it was in
flight, and its prompt holds the `Artefact:` path. Diff that file against the
input the prompt gave it, and re-dispatch only the missing part to a **new**
artefact file.

### Death points, and what they mean

| Death point | What the successor inherits |
|---|---|
| `waiting: on the review agents` | reviews never reported; check `.claude/tmp/review-*-<id>.md` — if absent, redo them |
| `waiting:` on any other subagent | a partial artefact `artefactsSurvived` does not list; recover it as above |
| mid-application of findings | artefacts survive; some findings already applied, some not |
| mid-mutation-suite | **assume no mutation is verified and none reversed** — an unreversed mutation is a live bug |
| `waiting:` on a suite, work committed | only a result to read and a ticket to close |
| blocked on its own question | not a rate-limit casualty; answer the question instead |

### Getting it wrong

If a brief blames a failing test on a dead session's uncommitted work, prove in
a worktree first that the red is not pre-existing, or write it as a question
rather than a claim.
