# shellcheck shell=sh
# hook-root.sh — the host root a git hook hands its scripts: the repository the
# hook runs in, never one an inherited CLAUDE_PROJECT_DIR names (#3307).
#
# SOURCED, NEVER RUN, at the top of every .husky/<hook>, and POSIX sh.
#
# Where CLAUDE_PROJECT_DIR shares this repository's git common dir it is
# kept: the harness sets it to the shared tree for a commit in a linked
# worktree, and the arbiter's state is keyed on that tree. Anything else,
# unset or unreadable included, becomes this working tree's top level; where
# there is none, a bare repository's push, CLAUDE_PROJECT_DIR is unset.
#
# scripts/lib/host-root.js's worktreeRoot() makes the same common-dir
# comparison for a test run; change the two together.
#
# GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE are unset for the -C read: git
# exports them to a hook, and they would answer for this repository wherever
# -C pointed.
hr_mine=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || hr_mine=""
hr_theirs=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hr_theirs=$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || hr_theirs=""
fi
if [ -z "$hr_theirs" ] || [ "$hr_theirs" != "$hr_mine" ]; then
  if hr_top=$(git rev-parse --show-toplevel 2>/dev/null); then
    CLAUDE_PROJECT_DIR=$hr_top
    export CLAUDE_PROJECT_DIR
  else
    unset CLAUDE_PROJECT_DIR
  fi
fi
unset hr_top hr_mine hr_theirs
