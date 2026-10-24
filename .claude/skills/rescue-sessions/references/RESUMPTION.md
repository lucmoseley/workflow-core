# Resuming a ticket from a stuck session on another plan

Several `/implement` sessions on one of this machine's Claude plans hit that
plan's session limit mid-flight and were stopped. Their processes are dead, their
file claims are stranded and yours to retake, and their work sits UNCOMMITTED in
the shared tree.

You are taking one over. Your `<ticket>-brief.md` alongside this file carries
the ticket-specific facts.

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

## 3. The tree is dirty with the other rescued sessions' work

Every session in this rescue died with its work uncommitted, and those edits are
interleaved in the shared tree until each ticket lands. Your own brief names the
tickets; `git status --porcelain` names the files.

- **A full-suite red is probably not yours.** Do not chase it and do not "fix"
  a failing file you do not own. To prove a red is a neighbour's, run the failing
  files in a detached worktree at clean HEAD (`git worktree add --detach`, symlink
  the canonical `node_modules` in).
- **Use `npm run test:changed`,** not the full suite.
- **Commit by pathspec, your files only** —
  `node scripts/commit-paths.js -m "..." -- <paths>` (Bash `timeout: 600000`).
  Never `git add`. Anything outside your ticket's files belongs to a dead
  neighbour: not yours to commit, and NOT yours to revert or clean up.

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
