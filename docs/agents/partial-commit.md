# Committing your own line out of a file a neighbour is editing

The shared working tree means a file can hold two sessions' uncommitted work at
once: yours and a live neighbour's. This is the more specific case under
`docs/agents/rules/commit-pathspec.txt`, which the guard prints on every commit.

## Why the ordinary form does not work here

`git commit -m "…" -- <path>` takes the **working-tree** copy of every path it
names, so a neighbour's unsaved edit lands under your message (mantahostels#1539). `git add`
first is worse: the index is repo-global, and a parallel commit sweeps your
staged files in under its own message (mantahostels#63) — the same window
`docs/agents/rules/commit-pathspec.txt` warns about for the ordinary `git add`.

## The recipe

Commit your hunks from a **private index** — HEAD's blobs with your hunks
applied — so nothing is staged where a neighbour's pathspec-less commit can
sweep it in, and nothing ever writes their lines out of the working tree and
back (#787). `scripts/commit-paths.js --patch` does every step (#801):

    git diff HEAD -U0 -- <path> > .claude/tmp/mine.patch   # then delete their hunks by hand
    node scripts/commit-paths.js -m "…" --patch .claude/tmp/mine.patch [-- <your whole paths>]

Diff against `HEAD`, not the shared index: the script refuses a patch whose
`index <old>..` line names a blob other than HEAD's, which is also what stops a
re-run after the commit landed from adding zero-context lines twice. Files
wholly your own — usually a new file or a sidecar — go after `--` and land in
the same commit; a file both in the patch and after `--` is refused, since a
whole path takes their lines too.

After the commit it resets the shared index to the new HEAD for every path
committed. That is not cleanup — skipped, the repo-global index still holds the
path's *old* blob, so it reads as staging the reverse of the commit just made,
and a neighbour's bare `git commit` sweeps that reversal in under their message
(mantahostels#63 again, from the fix meant to close it). `git reset` touches
only the index, so the neighbour's unstaged hunk is untouched (mantahostels#2523).
A staged copy the reset replaces — somebody's `git add`, against the commit
rule — is named first. Where the reset is refused, the script exits 4 and
prints the command to run by hand: exit 4 means the commit landed, so never
re-run the command.

The hooks run against the private index, the whole `.husky/pre-commit` stack
and the doc-map gate's own nested `GIT_INDEX_FILE` included
(mantahostels#2523).

Their unstaged hunk survives the commit and stays dirty in the working tree —
measured under the whole `.husky/pre-commit` stack at mantahostels#2384, re-confirmed for
the private-index form at mantahostels#2523.

Deleting their hunks is the step that costs judgement, and nothing automates it:
`-U0` gives you line numbers and no authorship. Work from what you know you
wrote, not from what looks unfamiliar.

## A third hazard: HEAD moving under you

A private index built by `git read-tree HEAD` freezes every path in the repo at
the sha it read, not just the paths you are about to touch. If a neighbour
commits anything at all between that `read-tree` and the commit, the private
index still holds the pre-commit blob for their file, and the commit writes it
back out over theirs — reverting their work under your message, with no
warning and no conflict.

On 2 Sep 2026, in mantahostels#2493, a session ran this recipe against
`docs/doc-map.md`; a neighbour landed `c9892482` inside the window; the
resulting commit `9a30a010` reverted 14 lines of their
`.claude/skills/concision-pass/SKILL.md` improvement, alongside its own
intended edits to two other files, while reporting success. Restored in
`c5818194` — caught only because the committing session read `git show
--stat` and saw a third file it had not named.

`scripts/commit-paths.js --patch` closes the window: it re-reads HEAD after
building the private index and rebuilds where it moved, and its ref update
names that HEAD as the one it replaces, so a HEAD moved at any point since
refuses the commit, nothing written. #113's
`scripts/stale-write-back-gate.sh`, in the `.husky/pre-commit` stack, also
refuses a staged path nearer this session's base than HEAD
(`rule:stale-write-back`; #112's escape for a deliberate revert:
`node scripts/session-arbiter.js accept-head <path>`).

A commit made from a private index by any other route has no such check: read its `git show --stat`, and if it names a path you did not touch, a neighbour landed inside the window and your commit reverted them.
Repair from a private index too — never a raw
`git show <their-sha>:<path> > <path>`, `git checkout` or `git restore`
against the working tree, any of which would overwrite whatever either of
you has written there since (mantahostels#250):

    GIT_INDEX_FILE=.claude/tmp/idx-repair git read-tree HEAD
    GIT_INDEX_FILE=.claude/tmp/idx-repair git update-index --add --cacheinfo \
      100644,$(git rev-parse <their-sha>:<path>),<path>
    GIT_INDEX_FILE=.claude/tmp/idx-repair git commit -m "Restore <path>, reverted by <this commit>"
    git reset -q -- <path>

## If the unstaged hunk vanishes anyway

It was a session, not machinery — but check one command first.
`node scripts/session-arbiter.js release --park <path>` writes `HEAD` over the
file, and the arbiter *recommends* it unprompted to a session whose commit is
blocked (`scripts/session-arbiter.js:1579`), so it is the reachable one. It
copies the bytes aside into the arbiter's `parked/` directory before it writes,
and it refuses while any other live session is a writer on the path — so a
vanished hunk with no `parked/` copy on disk did not come from there.

Nothing else in the repo restores committed content over a working-tree file
(mantahostels#2384).
