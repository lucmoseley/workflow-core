#!/usr/bin/env bash
# lib/gh-issue-ref.sh — gi_repo_of, gi_origin, gi_issue_word, gi_local_issue_word:
# which repo a `gh issue` call names and which issue its bare words are, read
# off the command.
#
# The one reader for record-acts.sh, record-issue-claim.sh and
# release-issue-claim.sh (workflow-core#2367), so they never disagree about what a word
# names. Their repo rules differ on purpose: record-acts.sh records under the
# repo the call names, while the claim hooks act only on this repository's
# issues (gi_local_issue_word).
#
# Sourced, never run, after lib/guard-parse.sh, whose gp_literal it calls.

# `owner/name` from a --repo value, `[HOST/]OWNER/REPO` or a remote URL; empty
# where it is neither.
gi_repo_of() {
  [[ "${1%.git}" =~ ([^/:]+)/([^/]+)$ ]] && printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  return 0
}

# The origin remote of directory $1, as `owner/name`; empty where git cannot
# answer.
gi_origin() {
  gi_repo_of "$(git -C "$1" config --get remote.origin.url 2>/dev/null)"
}

# One bare word, which gh takes as an issue number or an issue URL. Sets the
# caller's locals $gi_number to the number and $gi_repo to a URL's own repo
# (empty for a bare number); returns 1 for a word that is neither — a leftover
# expansion, a stray path, a pull-request URL.
gi_issue_word() {
  local text
  # shellcheck disable=SC2034 # the caller's answer, read after this returns.
  gi_repo=""
  text="$(gp_literal "$1")" || return 1
  text="${text#\#}"
  case "$text" in
    */issues/*)
      [[ "$text" =~ ([^/]+)/([^/]+)/issues/([0-9]+) ]] || return 1
      # shellcheck disable=SC2034 # the caller's answer, read after this returns.
      gi_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
      text="${BASH_REMATCH[3]}"
      ;;
  esac
  [[ "$text" =~ ^[0-9]{1,9}$ ]] || return 1
  # shellcheck disable=SC2034 # the caller's answer, read after this returns.
  gi_number="$text"
}

# gi_issue_word for an issue of the repository at root $1 alone: a URL naming
# any other repo returns 1, as does every URL where $1 has no origin remote.
# Sets the caller's local $gi_number.
gi_local_issue_word() {
  local gi_repo
  gi_issue_word "$2" || return 1
  [[ -z "$gi_repo" || "$gi_repo" == "$(gi_origin "$1")" ]]
}
