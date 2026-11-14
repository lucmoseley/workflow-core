# shellcheck shell=sh
#
# commit-route.sh — which git operation made the commit a hook is asked about:
# its commit route (GLOSSARY.md), the route's abort command, and the replay
# secrets scan (#1476, #1503).
#
# Callers in two shells: the .husky hooks under `sh -e`, and the session gates
# .husky/pre-commit runs (scripts/*-gate.sh) under bash with `set -u`. POSIX sh throughout, no `local`, and every positional read
# defaulted. Each caller keeps its own list of the routes it stands down on,
# built on wfc_commit_route_replays, so a new replay route is one edit here
# and one in commit-route.js's REPLAY_ROUTES, and a row in commit-route.test.ts.
#
# Sourced, never run: it defines functions and nothing else.
#
# COMMIT A HOOK AND THIS FILE TOGETHER. A hook sources it through
# `$here/../scripts/lib/`, so a pathspec commit naming only one of them lands
# hook bytes that call what the other half does not yet define. A hook refuses
# every commit when this file is missing; the two gates fail open.
#
# THE MARKER TABLE, the order its checks run in and why, and the leftover
# `sequencer` (#3298): scripts/lib/commit-route.js's header.

# wfc_commit_route <hook> <gitdir> — prints the route. An empty <gitdir>, a git
# that would not answer, reads as no marker at all. Exits 2 on a hook with no
# row above, so a caller under `set -e` refuses rather than guessing.
#
# pre-commit is also what pre-merge-commit runs as `sh -e`, so pre-commit reads
# GIT_REFLOG_ACTION for the merge that has not written MERGE_HEAD yet.
wfc_commit_route() {
  wfc_cr_dir="${2:-/nonexistent}"
  case "${1-}" in
    applypatch-msg | pre-applypatch | post-applypatch)
      if [ -e "$wfc_cr_dir/rebase-apply/rebasing" ]; then
        echo rebase-apply
      else
        echo am
      fi
      return 0
      ;;
    pre-merge-commit)
      echo merge
      return 0
      ;;
    pre-commit | prepare-commit-msg | commit-msg | post-commit) ;;
    *)
      echo "commit-route.sh: no marker table for the hook '${1-}'" >&2
      return 2
      ;;
  esac
  if [ -e "$wfc_cr_dir/rebase-merge" ]; then
    echo rebase
  elif [ -e "$wfc_cr_dir/rebase-apply/rebasing" ]; then
    echo rebase-apply
  elif [ -e "$wfc_cr_dir/rebase-apply" ]; then
    echo am
  elif [ -e "$wfc_cr_dir/CHERRY_PICK_HEAD" ]; then
    echo cherry-pick
  elif [ -e "$wfc_cr_dir/REVERT_HEAD" ]; then
    echo revert-continue
  elif [ -e "$wfc_cr_dir/MERGE_HEAD" ]; then
    echo merge
  elif [ "${1-}" = pre-commit ] && wfc_cr_merging; then
    echo merge
  elif wfc_cr_sequencing "${1-}"; then
    echo revert-sequence
  elif [ -e "$wfc_cr_dir/BISECT_LOG" ]; then
    echo bisect
  else
    echo commit
  fi
}

# wfc_cr_merging — whether GIT_REFLOG_ACTION names a merge or a pull's merge.
wfc_cr_merging() {
  case "${GIT_REFLOG_ACTION-}" in
    merge* | pull*) return 0 ;;
  esac
  return 1
}

# wfc_cr_sequencing <hook> — whether `sequencer` is a live sequence: its
# `abort-safety` names the commit this one is made on, HEAD before post-commit;
# at post-commit HEAD's parent, with HEAD's last reflog entry the sequence's
# own. No `abort-safety` or reflog, or a git that would not answer, reads as a
# leftover.
wfc_cr_sequencing() {
  [ -e "$wfc_cr_dir/sequencer" ] || return 1
  wfc_cr_safety="$(cat "$wfc_cr_dir/sequencer/abort-safety" 2>/dev/null)" || return 1
  [ -n "$wfc_cr_safety" ] || return 1
  wfc_cr_made_on=HEAD
  if [ "${1-}" = post-commit ]; then
    case "$(tail -n 1 "$wfc_cr_dir/logs/HEAD" 2>/dev/null)" in
      *"	revert: "* | *"	cherry-pick: "*) ;;
      *) return 1 ;;
    esac
    wfc_cr_made_on=HEAD^
  fi
  [ "$(git --git-dir="$wfc_cr_dir" rev-parse -q --verify "$wfc_cr_made_on" 2>/dev/null)" = "$wfc_cr_safety" ]
}

# wfc_commit_route_replays <route> — 0 for the routes that replay commits
# already made, and that reach no pre-commit: the stack's narrow replay path
# (mantahostels#1706, mantahostels#1707).
wfc_commit_route_replays() {
  case "${1-}" in
    rebase | rebase-apply | am | cherry-pick) return 0 ;;
  esac
  return 1
}

# wfc_commit_route_abort <route> — prints the command that clears the route's
# operation, or nothing where there is none. Naming the wrong one strands the
# tree: `git am --abort` does not clear a rebase.
wfc_commit_route_abort() {
  case "${1-}" in
    rebase | rebase-apply) echo "git rebase --abort" ;;
    am) echo "git am --abort" ;;
    cherry-pick) echo "git cherry-pick --abort" ;;
    revert-sequence | revert-continue) echo "git revert --abort" ;;
    merge) echo "git merge --abort" ;;
  esac
}

# wfc_commit_route_name <route> — the operation as a reader typed it.
wfc_commit_route_name() {
  case "${1-}" in
    rebase) echo "git rebase" ;;
    rebase-apply) echo "git rebase --apply" ;;
    am) echo "git am" ;;
    cherry-pick) echo "git cherry-pick" ;;
    revert-sequence | revert-continue) echo "git revert" ;;
    merge) echo "git merge" ;;
    *) echo "commit" ;;
  esac
}

# wfc_replay_scan <hook> <route> — the secrets scan alone, for a replay that
# runs none of the stack (mantahostels#1706, mantahostels#1687). Returns 0 on a
# pass; on anything else prints the refusal, naming the abort, and returns 1.
# The command is the one .husky/pre-commit runs.
wfc_replay_scan() {
  "${WFC_GITLEAKS:-gitleaks}" git --staged --redact && return 0
  wfc_cr_name="$(wfc_commit_route_name "${2-}")"
  # "did not pass", not "found a secret": a missing gitleaks exits non-zero
  # too.
  echo "${1-}: the secrets scan did not pass on this $wfc_cr_name (mantahostels#1706)." >&2
  echo "  Its own output is above — a finding, or gitleaks itself is missing." >&2
  echo "  The $wfc_cr_name is left IN PROGRESS. Clear it with:  $(wfc_commit_route_abort "${2-}")" >&2
  return 1
}
