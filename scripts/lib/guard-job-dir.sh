#!/usr/bin/env bash
# gjd_is_job_dir — is a path under the background job's scratch tree? And
# gjd_job_rel — where under it does that path sit?
#
# Extracted from scripts/guard-job-dir-scratch.sh at mantahostels#2592, where a second
# guard needed the same test: guard-tracker-rules.sh routes
# `rule:gh-job-dir-unreadable` on a `gh` call carrying such a path, and two
# copies of the predicate would let the two guards disagree about which tree is
# the job directory.
#
# Sourced, never run. It defines two functions and touches nothing else, so a
# guard may source it before or after lib/guard-parse.sh.

# Is $1 a path under the job directory? Purely textual: the file does not exist.
#
# ONLY A PATH-SHAPED WORD — one holding a `/` — IS RESOLVED against $PWD (#1731).
# A caller may hand over every word of a command, and `gh issue view 5` run
# from inside a job tree would otherwise put `view` and `5` there. The price: a
# bare relative filename (`x.md`) is never under the job directory, so a caller
# judging one resolves it first, as gp_redirects does.
gjd_is_job_dir() {
  local p="$1"
  # The unexpanded spelling. `$CLAUDE_JOB_DIR` survives gp_literal's failure as
  # text, so this limb answers for the form the preamble actually prints, with
  # no dependence on the variable reaching this process at all.
  case "$p" in
    *CLAUDE_JOB_DIR*) return 0 ;;
    */*) ;;
    *) return 1 ;;
  esac
  [[ "$p" == /* ]] || p="$PWD/${p#./}"
  # The variable as this process sees it. A trailing slash is appended to both
  # sides so that a sibling directory sharing the prefix is not swept in.
  if [[ -n "${CLAUDE_JOB_DIR:-}" && "$p/" == "${CLAUDE_JOB_DIR%/}/"* ]]; then
    return 0
  fi
  # The shape, for a hook environment that did not carry the variable. Anchored
  # on a dot-prefixed config directory so that an ordinary `jobs/` directory in
  # a repo — a queue fixture, a data folder — is not read as one.
  case "$p" in
    */.claude*/jobs/*/*) return 0 ;;
  esac
  return 1
}

# gjd_job_rel <path> — where $1 sits inside the job directory, as a path
# relative to its root (`tmp/a.md`), on gjd_is_job_dir's three limbs in the
# same order. guard-job-dir-scratch.sh refuses on the answer (#1139). Non-zero
# where $1 is not under a job directory, or names it with no path below it.
#
# NARROWER THAN gjd_is_job_dir, ON PURPOSE: its globs let `*` span a slash and
# take `CLAUDE_JOB_DIR` anywhere in the text, so a path such as
# `/h/.claude2/x/jobs/a/tmp/f` has no one place to cut. Such a path gets no
# answer here, so its caller warns where it would refuse — a deny only on the
# unambiguous shape (mantahostels#103).
gjd_job_rel() {
  local p="$1" re_var='\$\{?CLAUDE_JOB_DIR\}?/(.+)$' re_shape='/\.claude[^/]*/jobs/[^/]+/(.+)$'
  if [[ "$p" =~ $re_var ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  [[ "$p" == */* ]] || return 1
  [[ "$p" == /* ]] || p="$PWD/${p#./}"
  if [[ -n "${CLAUDE_JOB_DIR:-}" && "$p" == "${CLAUDE_JOB_DIR%/}/"?* ]]; then
    printf '%s' "${p#"${CLAUDE_JOB_DIR%/}/"}"
    return 0
  fi
  [[ "$p" =~ $re_shape ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}
