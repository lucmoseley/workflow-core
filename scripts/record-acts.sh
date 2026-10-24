#!/usr/bin/env bash
# record-acts.sh — PostToolUse recorder on Bash: a session's raw `gh` close, question round,
# `takes:` relabel and blocked-by edge, each written to its acts ledger as one
# line (#2308, #2464, spec #2245), so the refill loop can tell what a launched
# session itself did.
#
# The scripted routes record their own acts: resolve-ticket.js its close and
# file-issue.js its filing (lib/tracker-ops.js's recordOwnAct). A commit is the
# post-commit hook's commit ledger, which the reader takes as an act.
#
# RUNS ONLY AFTER A CALL THAT EXITED 0 (#2308), so a call a sibling guard
# denies, or one gh refuses, records nothing.
#
# IT ONLY EVER RECORDS. Nothing is refused or injected, and every failure path
# exits 0 in silence.
#
# WHAT A LINE IS:
#   close <owner/name>#<n>             gh issue close
#   round <owner/name>#<n>             gh issue comment whose body opens a
#                                      `❓ **Qn**` round (lib/round-marker.js,
#                                      judged by session-arbiter.js record-act)
#   relabel <owner/name>#<n> takes:<x> gh issue edit adding a takes: label, one
#                                      line per label and issue
#   block <owner/name>#<n>             a blocked-by edge added to <n>: a gh api
#                                      POST to its dependencies/blocked_by, or
#                                      gh issue edit --add-blocked-by
#
# LIMITS
#  - The repo is the call's `--repo`, an issue URL's own, or else the origin
#    remote of the directory the call ran in. gh's own default may differ there
#    (`gh repo set-default`, an `upstream` remote); such a line names the
#    origin.
#  - THE COMMENT BODY IS READ in four spellings, through lib/gh-body.sh:
#    `--body <text>`, `--body-file <path>`, and `--body-file -` fed by a
#    single-quoted heredoc or by `cat <path> |`. NOT READ, so no round line: a
#    body in a `$VAR` or `$(…)`, stdin fed any other way, an unquoted heredoc
#    holding `$`, a backtick or a backslash, `--editor` and `--web`, and a
#    body file the same command writes before the call.
#  - `--edit-last` and `--delete-last` post no new comment, so record nothing.
#  - Only an ADDED `takes:` label is a relabel; a removal alone records nothing.
#    Adding one the issue already carries records a line too: gh exits 0 and
#    says nothing that tells the two apart.
#  - A close of an issue already closed records nothing.
#  - A raw `gh issue create` records no `file` line; file-issue.js writes it.
#  - A `gh api` blocked-by POST is read through lib/guard-gh-api.sh; one whose
#    method or endpoint is not a literal, or whose endpoint names one of
#    `{owner}`/`{repo}` without the other, records nothing.
#  - Every other `gh api` and GraphQL spelling, a script's own gh call, and the
#    web UI record nothing.
#  - An issue number in a shell variable records nothing.
#  - A compound command reads as a whole: one whose LAST step failed is a
#    PostToolUseFailure and records nothing, though its gh step landed.
#  - Wired with `if: Bash(gh *)`, so a path-spelled `/usr/bin/gh` is never
#    judged.
#
# IMPLICIT:  after a `gh issue close`, a round-opening `gh issue comment`, a `takes:` label added by `gh issue edit` or a blocked-by edge added, appends one line per act to the session's acts ledger.
# JUSTIFIED: convenience — the record is the session's own, into its own ledger, which only the refill loop's progress test reads; the act itself has already landed.
# DEFEAT:    evadable by spelling — any `gh api` call but a blocked-by POST, a shell variable, an unread body or the web UI all miss the seam — but there is no switch.

set -uo pipefail

# lib/guard-log.sh is sourced FIRST and separately, so the parser failing to
# load is itself recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — no act recorded"
  exit 0
}

# shellcheck source=scripts/lib/gh-body.sh
source "$here/lib/gh-body.sh" 2>/dev/null
GB_SUBCMD='issue[[:space:]]+comment'
GB_WHAT='gh issue comment'
declare -F gb_body >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/gh-body.sh did not load — no act recorded"
  exit 0
}

# shellcheck source=scripts/lib/gh-issue-ref.sh
source "$here/lib/gh-issue-ref.sh" 2>/dev/null
declare -F gi_issue_word >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/gh-issue-ref.sh did not load — no act recorded"
  exit 0
}

# Read only for a `gh api` blocked-by POST, so its failing to load costs that
# act alone.
# shellcheck source=scripts/lib/guard-gh-api.sh
source "$here/lib/guard-gh-api.sh" 2>/dev/null
api_loaded=1
declare -F ga_scan_api >/dev/null 2>&1 || {
  api_loaded=0
  declare -F gl_log >/dev/null 2>&1 && gl_log "lib/guard-gh-api.sh did not load — no gh api act recorded"
}

gp_begin '.tool_input.command' command

[[ "$(gp_payload_field '.tool_name // "Bash"')" == "Bash" ]] || exit 0

session="$(gp_payload_field '.session_id // ""')"
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || exit 0

command -v node >/dev/null 2>&1 || gl_open "node not found — no act recorded"

# What the call printed, for gh's "already closed" line on a no-op close.
output="$(gp_payload_field '(.tool_response.stdout // "") + "\n" + (.tool_response.stderr // "")')"

bounded=""
command -v timeout >/dev/null 2>&1 && bounded=1

# The flags each subcommand takes a value for, short and long together. Leave
# one out and its value is read as an issue number.
CLOSE_VALUE_FLAGS="-c --comment -r --reason --duplicate-of -R --repo"
COMMENT_VALUE_FLAGS="-b --body -F --body-file -R --repo"
EDIT_VALUE_FLAGS="-t --title -b --body -F --body-file -m --milestone -R --repo \
--add-assignee --remove-assignee --add-label --remove-label --add-project --remove-project \
--add-blocked-by --remove-blocked-by --add-blocking --remove-blocking \
--add-sub-issue --remove-sub-issue --parent --type"

# The origin remote of the directory the call runs in, as `owner/name`.
cwd_repo() {
  local dir
  dir="$(gp_cwd)"
  [[ -n "$dir" ]] || dir="$PWD"
  gi_origin "$dir"
}

# One argument of the call, as <kind> <name> <value>: collects $repo, $issues,
# $takes and the body, sets $blocked on an edit adding a blocked-by edge, and
# $no_post on a comment that posts nothing new.
scan_arg() {
  local text
  case "$1" in
    opt)
      case "$2" in
        -R | --repo)
          text="$(gp_literal "$3")" && repo="$(gi_repo_of "$text")"
          ;;
        --add-label)
          text="$(gp_literal "$3")" || return 0
          local IFS=, part
          for part in $text; do
            [[ "$part" == takes:?* ]] && takes+=("$part")
          done
          ;;
        --add-blocked-by) blocked=1 ;;
        -b | --body) [[ "$sub" == comment ]] && gb_body "$3" ;;
        -F | --body-file) [[ "$sub" == comment ]] && gb_body_file "$3" ;;
      esac
      ;;
    flag)
      case "$2" in
        --edit-last | --delete-last | -e | --editor | -w | --web) no_post=1 ;;
      esac
      ;;
    arg) push_issue "$3" ;;
  esac
  return 0
}

# One bare word, which gh takes as an issue number or a URL; a URL also names
# the repo.
push_issue() {
  local gi_number gi_repo
  gi_issue_word "$1" || return 0
  [[ -n "$gi_repo" ]] && url_repo="$gi_repo"
  issues+=("$gi_number")
}

# One act, handed to the arbiter with this session's id; $2 is fed on stdin.
# No call starts past 4 s, so 4 + its `timeout 5` stays inside the hook's
# 10 s budget.
record() {
  ((SECONDS < 4)) || return 0
  # shellcheck disable=SC2086 # $1 is the act, split into its words on purpose.
  printf '%s' "${2-}" | CLAUDE_CODE_SESSION_ID="$session" \
    ${bounded:+timeout 5} node "$here/session-arbiter.js" record-act $1 \
    >/dev/null 2>&1 || true
}

judge_api() {
  # shellcheck disable=SC2034 # api_opaque, api_fields: declared to keep lib/guard-gh-api.sh's writes local.
  local api_method="" api_endpoint="" api_opaque=0 api_input=0 method endpoint repo
  local -a api_fields=()
  ga_scan_api "$@"
  method="$(gp_literal "$api_method")" || return 0
  if [[ -z "$method" ]]; then
    ga_defaults_to_post || return 0
  elif [[ "${method^^}" != "POST" ]]; then
    return 0
  fi
  endpoint="$(gp_literal "$api_endpoint")" || return 0
  [[ "$(ga_path "$endpoint")" =~ ^repos/([^/]+)/([^/]+)/issues/([0-9]+)/dependencies/blocked_by$ ]] ||
    return 0
  local n="${BASH_REMATCH[3]}"
  repo="$(ga_endpoint_repo "$endpoint")" || return 0
  [[ -n "$repo" ]] || repo="$(cwd_repo)"
  [[ -n "$repo" ]] && record "block $repo#$n"
  return 0
}

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words as $2 onward.
judge() {
  shift
  [[ "$(basename "${1:-}")" == "gh" ]] || return 0
  [[ "${2-}" == "api" ]] && {
    ((api_loaded)) && judge_api "${@:3}"
    return 0
  }
  [[ "${2-}" == "issue" ]] || return 0
  local sub="${3-}" spec
  case "$sub" in
    close) spec="$CLOSE_VALUE_FLAGS" ;;
    comment) spec="$COMMENT_VALUE_FLAGS" ;;
    edit) spec="$EDIT_VALUE_FLAGS" ;;
    *) return 0 ;;
  esac

  local repo="" url_repo="" no_post=0 blocked=0 n
  local -a issues=() takes=()
  # shellcheck disable=SC2034 # body_missing: declared to keep lib/gh-body.sh's write local.
  local body="" body_hidden=0 body_given=0 body_missing="" body_fault=""
  gp_scan_flags "$spec" scan_arg -- "${@:4}"
  [[ -n "$body_fault" ]] && gl_log "$body_fault — no round recorded"
  [[ -n "$repo" ]] || repo="$url_repo"
  [[ -n "$repo" ]] || repo="$(cwd_repo)"
  [[ -n "$repo" ]] || return 0

  case "$sub" in
    close)
      for n in ${issues+"${issues[@]}"}; do
        [[ "$output" == *"$repo#$n "*"is already closed"* ]] || record "close $repo#$n"
      done
      ;;
    comment)
      ((no_post || body_hidden || !body_given)) && return 0
      for n in ${issues+"${issues[@]}"}; do record "round $repo#$n" "$body"; done
      ;;
    edit)
      local t
      for n in ${issues+"${issues[@]}"}; do
        for t in ${takes+"${takes[@]}"}; do record "relabel $repo#$n $t"; done
        ((blocked)) && record "block $repo#$n"
      done
      ;;
  esac
  return 0
}

gp_walk_commands judge

exit 0
