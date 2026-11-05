# Resuming a ticket from a stuck session on another plan

Several `/implement` sessions on one of this machine's Claude plans hit that
plan's session limit mid-flight and were stopped. Their processes are dead, their
file claims are stranded and yours to retake, and each one's work sits
UNCOMMITTED in its own worktree.

You are taking one over. Your `<ticket>-brief.md` alongside this file carries
the ticket-specific facts, the dead session's worktree among them: your launch
started you in it, so work there. Where that worktree is the main checkout,
your launch cut you a fresh one instead: `cd` to the main checkout to reach the
dead session's uncommitted work.

## 1. Read the dead session's own account first

`<your snapshot dir>/<short-id>.narration.txt` is that session's complete
narration — every line of prose it wrote, and a one-line signature for every tool
call it made, in order. Read it whole. Its full transcript is at
`<short-id>.transcript.jsonl` beside it if you need a specific tool result back.

Then read the ticket yourself (`gh issue view <n> --comments`).

## 2. Verify, do not trust

The narration is a session's own claims about itself, and the last of them were
never followed by a green run anyone can see. Where it says a review finding was
applied, a mutation was reversed or a gate went clean, CHECK IT against the
working tree.

## 3. Test and commit only your ticket's work

- **Run only the tests you touched,** never the full suite: the bare
  `npm run test` with the `landing` module on, the lander running the full
  suite; `npm run test:changed` with it off.
- **Commit by pathspec** —
  `node scripts/commit-paths.js -m "..." -- <paths>` (Bash `timeout: 600000`).
  Never `git add`.

## 4. Finish properly

Reviews, mutation tests and the concision pass are still required. Where a surviving artefact means a step need not be
redone, say so and cite the artefact. Where the artefact is gone, redo the step.
Then push, and close the ticket per `docs/agents/issue-tracker.md` (or
`/card-close` if it is a roadmap card).


## 5. Do not blame a red without proving it

Where your brief names the session a failing test belongs to, that is a
hypothesis. Prove it in a detached worktree at clean HEAD before accepting it —
a brief has named the wrong ticket before, the test failing at the base commit
and owned by nobody.
