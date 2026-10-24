#!/usr/bin/env bash
# lib/commit-calls.sh — the commit calls a session's Bash commands made, read as
# the guards read them (#2383), for rescue-sessions.js's snapshot.
#
# COUNTED: a `git commit`, and a `commit-paths.js` call by any path that would
# commit — never a `--tree` pin, nor one commit-paths.js refuses unread: one
# with no message or two, or `--help`.
#
# INPUT: one hook-shaped payload per line, `{"tool_input":{"command":<cmd>}}`.
#
# OUTPUT: four NUL-terminated fields per call — the payload's line number from
# 0, the call as written, then `m` and the message word as written, `F` and the
# message file's path, or `-` and an empty field where neither was given or the
# path holds an expansion — and last the one field `end`. gp_begin exits 0
# where it cannot read a payload, as a guard must, so output without `end` is
# a run that stopped short.
#
# LIMITS: a commit inside a heredoc body or a `bash -c` string is not seen, as
# no guard sees one. Where the walk splits a command bash would not — a
# heredoc's terminator followed by `)`, a quote never closed — the message word
# is cut short and the caller reads it off the command itself, and a later
# commit in that command is not seen.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/guard-log.sh" 2>/dev/null
# shellcheck source=scripts/lib/guard-parse.sh
source "$here/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "lib/guard-parse.sh did not load — no commit call read"
  exit 1
}

flag=""
word=""

# gp_scan_flags's callback for a `git commit`: the first message flag wins, as
# git refuses `-m` beside `-F`.
message_arg() {
  [[ -z "$flag" ]] || return 0
  case "$1:$2" in
    opt:-m | opt:--message) flag=m word="$3" ;;
    opt:-F | opt:--file) flag=F word="$3" ;;
  esac
  return 0
}

read_call() {
  local segment="$1" path
  shift
  flag=""
  word=""
  if gp_commit_paths_args "$@"; then
    gp_commit_paths_parse && ((!_gp_cp_tree)) && [[ -n "$_gp_cp_message_flag" ]] || return 0
    flag="${_gp_cp_message_flag#-}"
    word="$_gp_cp_message"
  elif gp_git_words "$@" && [[ "$_gp_git_sub" == commit ]]; then
    gp_scan_flags "$(gp_git_value_flags commit)" message_arg -- ${_gp_git_args+"${_gp_git_args[@]}"}
  else
    return 0
  fi
  case "$flag" in
    m) word="$(gp_as_written "$word")" ;;
    F) path="$(gp_literal "$word")" && word="$path" || flag="" ;;
  esac
  [[ -n "$flag" ]] || {
    flag=-
    word=""
  }
  segment="$(gp_as_written "$segment")"
  segment="${segment#"${segment%%[![:space:]]*}"}"
  printf '%s\0%s\0%s\0%s\0' "$index" "${segment%"${segment##*[![:space:]]}"}" "$flag" "$word"
}

index=0
while IFS= read -r payload; do
  gp_begin '.tool_input.command' "commit call" <<<"$payload"
  gp_walk_commands read_call
  ((++index))
done
printf 'end\0'
exit 0
