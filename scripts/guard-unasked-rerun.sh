#!/usr/bin/env bash
# PreToolUse guard: refuse a session's first unasked re-run of the suite (workflow-core#815,
# ruled at workflow-core#790 Q3 and Q7, spec workflow-core#810).
#
# THE WASTE IT ANSWERS (workflow-core#787). Once greens from several sessions compose (workflow-core#811,
# ADR-0009), a bare `npm run test` reads HEAD plus the session's own
# uncommitted files (workflow-core#812), and where greens already cover what it would test
# there it can only repeat their verdict — a neighbour's untested commit on top
# included, which the run leaves out (workflow-core#1216, workflow-core#1218).
#
# ONCE A SESSION, AND RE-TYPING RUNS IT (workflow-core#790 Q7). The refusal names the runs
# that cover the session's own work; the same command again goes through, as
# does every later one.
#
# SCOPE: a bare `npm run test`, `npm run test:changed` or `npm test`, read per
# segment after `gp_unwrap`'s wrapper strip and recognised by
# lib/suite-launch.sh, with nothing after the script name
# but `--`, `--queue` and redirections — `--queue` changes when a run starts,
# not what it tests (workflow-core#1153 Q1). Never a run naming files or a filter, `--full=`
# or any other flag — each is a run asked for.
#
# THE JUDGEMENT is `scripts/lib/unasked-rerun.js`, which owns the cover, the
# ledger read, the latch and the refusal log; see its header. This file finds
# the segment and spends the verdict.
#
# FAILS OPEN (mantahostels#103 §6), recorded via lib/guard-log.sh: no session
# id allows silently, there being no session to refuse once; no node, a judge
# that answers no JSON, or one that says it could not judge — an unreadable
# ledger, marker store or git — allows and logs why. No pre-emptive `gp_rule`
# limb: the rule reaches a session on the deny alone.
#
# LIMITS
#  - Fails closed on the rule fragment's wording only (`gp_rule_text`).
#  - A file this session wrote through Bash is absent from its write ledger, so
#    a session whose only uncommitted edits went that way is refused (workflow-core#816).
#    The judge reads the run's own `attributeDirty` (workflow-core#1218), so workflow-core#1220's credit
#    for inline python and node writes reaches it; `sed -i` and redirects are
#    credited only on a code path no live neighbour holds (mantahostels#2778).
#    Elsewhere they stay uncredited.
#  - A neighbour's commit in no commit ledger counts as the session's own
#    (workflow-core#1154), so an untested one lets a pure repeat through.
#  - `npm run -s test` is unread: its flag sits before the script name.
#
# Its `if: Bash(*npm *)` narrowing is best-effort, so the scope test below
# re-reads the command itself.
#
# IMPLICIT: it refuses the first bare test run in a session whose own work —
#   its commits and its uncommitted files — green runs already cover. It
#   writes an unreferenced commit object of that tree on every judged run, and
#   on a refusal a per-session latch and one line to
#   `.unasked-rerun-refusals.jsonl` under .claude/tmp/markers.
# JUSTIFIED: fail-safe — a refused run costs one re-typed command, and the
#   run it stops is one the push and `result:` gates already do not need.
# DEFEAT: re-typing the command; any flag but `--queue`, or a file filter; `bash -c`, a script
#   or a heredoc wrapping the launch; deleting the registration.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
# shellcheck source=scripts/lib/suite-launch.sh
source "$here/lib/suite-launch.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every test run allowed unchecked"
  exit 0
}
declare -F suite_launch_kind >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/suite-launch.sh did not load — every test run allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

UNASKED_RULE_FALLBACK="An unasked re-run is refused once a session; the rule could not be read from docs/agents/rules/unasked-rerun.txt. Read that file before re-running."
JUDGE_JS="$here/lib/unasked-rerun.js"

is_bare_test() {
  suite_launch_kind "$@" && [[ "$_sl_kind" == npm-vitest ]] || return 1
  shift "$_sl_taken"
  local word
  for word in "$@"; do
    [[ "$word" == -- || "$(gp_literal "$word" 2>/dev/null)" == --queue ]] && continue
    return 1
  done
  return 0
}

bare_segment=""
bare_cwd=""
find_bare() {
  [[ -n "$bare_segment" ]] && return 0
  local segment="$1"
  shift
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  (($#)) || return 0
  is_bare_test "$@" || return 0
  bare_segment="$segment"
  bare_cwd="$(gp_cwd)"
}

gp_walk_commands find_bare
[[ -n "$bare_segment" ]] || gp_allow

session="$(gp_payload_field '.session_id')"
[[ -n "$session" ]] || gp_allow

command -v node >/dev/null 2>&1 && [[ -r "$JUDGE_JS" ]] ||
  gl_open "node or lib/unasked-rerun.js unavailable — a bare test run allowed unjudged"

out="$(node "$JUDGE_JS" "$session" "$bare_cwd" "$(gp_unmask "$bare_segment")" 2>/dev/null)"
# gl_log, not gl_open: only gl_log carries the detail field.
deny="$(printf '%s' "$out" | jq -er 'if type == "object" then (.deny // "") else error end' 2>/dev/null)" || {
  gl_log "lib/unasked-rerun.js gave no verdict — a bare test run allowed unjudged" "$out"
  gp_allow
}
unread="$(printf '%s' "$out" | jq -r '.unread // ""' 2>/dev/null)"
[[ -n "$unread" ]] &&
  gl_log "own work unreadable — the re-run judged on all of HEAD (workflow-core#1218)" "$unread"
why="$(printf '%s' "$out" | jq -r '.why // ""' 2>/dev/null)"
[[ -n "$why" ]] && {
  gl_log "could not judge whether HEAD is covered — a bare test run allowed unjudged" "$why"
  gp_allow
}
[[ -n "$deny" ]] || gp_allow
note="$(printf '%s' "$out" | jq -r '.note // ""' 2>/dev/null)"
[[ -n "$note" ]] &&
  gl_log "a refusal went unrecorded — the post-change count (workflow-core#810) undercounts" "$note"

gp_deny "$deny

$(gp_rule_text unasked-rerun "$UNASKED_RULE_FALLBACK")"
