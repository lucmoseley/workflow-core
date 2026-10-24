# shellcheck shell=sh
#
# shared-tree-skip.sh — the one definition of the stale-write-back family's
# stand-down checks (#123).
#
# Two callers, two shells: scripts/stale-write-back-gate.sh under bash, and
# .husky/post-commit's advance_committed_bases under `sh -e`. POSIX sh
# throughout, and no `local` — dash has none.
#
# The checks are the same on both sides because the thing they protect is:
# a per-(session, path) base recorded against the SHARED tree's HEAD. A linked
# worktree has a HEAD of its own, and another repo entirely has no relation to
# the bases at all, so neither may mint one or be judged against one.
#
# Sourced, never run: it defines a function and nothing else.

# Returns 0 to proceed, 1 to stand down, 2 where git would not answer at all —
# which the two callers treat differently, the gate reporting it as a commit
# that went unchecked and post-commit swallowing it like every other fault of
# its own.
#
# $1 is the repo's top level where the caller has already read it: post-commit
# must, to find this file at all, and passing it back saves the second fork.
# The gate has not, and passes nothing.
#
# wfc_sts_gitdir is left set for the caller — the gate goes on to test it for a
# rebase in progress, which would otherwise be a third `rev-parse`. sh has no
# locals, so wfc_sts_toplevel and wfc_sts_common leak too; they are this
# function's own and nothing reads them.
wfc_shared_tree_skip() {
  wfc_sts_toplevel="${1:-}"
  wfc_sts_gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) ||
    wfc_sts_gitdir=""
  wfc_sts_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    wfc_sts_common=""
  if [ -z "$wfc_sts_gitdir" ] || [ -z "$wfc_sts_common" ]; then
    return 2
  fi
  # The two are the same directory in the main worktree alone.
  [ "$wfc_sts_gitdir" = "$wfc_sts_common" ] || return 1

  if [ -z "$wfc_sts_toplevel" ]; then
    wfc_sts_toplevel=$(git rev-parse --show-toplevel 2>/dev/null) ||
      wfc_sts_toplevel=""
  fi
  # The arbiter runs git in CLAUDE_PROJECT_DIR, so a commit in any other repo
  # would be judged against that one's index and HEAD. Realpath both sides: a
  # symlinked checkout is the same tree under two spellings.
  #
  # With CLAUDE_PROJECT_DIR unset there is nothing to compare against, and an
  # unreadable toplevel is left to the caller — each already refuses to run
  # without one.
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] &&
    [ "$(realpath "$wfc_sts_toplevel" 2>/dev/null)" != "$(realpath "$CLAUDE_PROJECT_DIR" 2>/dev/null)" ]; then
    return 1
  fi
  return 0
}
