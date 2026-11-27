# Committing some of a file's changed lines

A session's own work in one file can belong in two commits: a fix it wants
landed now, beside an edit still in progress. This is the more specific case
under `docs/agents/rules/commit-pathspec.txt`, which the guard prints on every
commit.

## Why the ordinary form does not work here

`git commit -m "…" -- <path>` takes the **working-tree** copy of every path it
names, so the edit still in progress lands under the fix's message.

## The recipe

Commit the hunks you pick from a **private index** — HEAD's blobs with those
hunks applied — so nothing writes the rest of the file out of the working tree
and back (workflow-core#787). `scripts/commit-paths.js --patch` does every step (workflow-core#801):

    git diff HEAD -U0 -- <path> > .claude/tmp/mine.patch   # then delete the hunks this commit leaves out
    node scripts/commit-paths.js -m "…" --patch .claude/tmp/mine.patch [-- <whole paths>]

Add `--check` to that command to read the gates' verdict on the patch without
committing it.

Diff against `HEAD`, not the index: the script refuses a patch whose
`index <old>..` line names a blob other than HEAD's, which is also what stops a
re-run after the commit landed from adding zero-context lines twice. Files the
commit takes whole — usually a new file or a sidecar — go after `--` and land in
the same commit; a file both in the patch and after `--` is refused, since a
whole path takes the hunks the patch leaves out too.

After the commit it resets the worktree's index to the new HEAD for every path
committed. That is not cleanup — skipped, the index still holds the path's
*old* blob, so it reads as staging the reverse of the commit just made, and the
next bare `git commit` takes that reversal in. `git reset` touches only the
index, so the hunks left out stay in the working tree (mantahostels#2523);
anything staged in those paths is unstaged with it. Where the index update is
refused, the script exits 4 and prints the reset to run by hand: exit 4 means
the commit landed, so never re-run the command.

The hooks run against the private index, the whole `.husky/pre-commit` stack
and the doc-map gate's own nested `GIT_INDEX_FILE` included
(mantahostels#2523).

The hunks left out survive the commit and stay dirty in the working tree —
measured under the whole `.husky/pre-commit` stack at mantahostels#2384,
re-confirmed for the private-index form at mantahostels#2523.

## If an unstaged hunk vanishes anyway

It was a session, not machinery: nothing in the repo restores committed content
over a working-tree file (mantahostels#2384).
