#!/usr/bin/env bash
# guard-lost-verdict.sh — PostToolUse and PostToolUseFailure hook: after a
# suite run whose output lost its pass/fail line, hand the session that run's
# verdict and TEST LOG path, so it reads the log instead of re-running (#1575,
# ruled at #1379 Q1 (D)). It does not warn on the pipe itself, which nearly
# every bare run uses (#1379 Q1 (B)).
#
# BOTH EVENTS, because a call exiting non-zero — a red suite, or a `grep`
# whose pattern matched nothing — reaches PostToolUseFailure and never
# PostToolUse (#1575, probed live).
#
# SCOPE: a call any of whose segments, read after `gp_unwrap`'s wrapper strip,
# launches the suite through scripts/run-vitest.js — lib/suite-launch.sh's
# `npm-vitest` and `wrapper` kinds. A direct `npx vitest` writes no TEST LOG.
#
# THE JUDGEMENT is `scripts/lib/lost-verdict.js`: whether the output holds a
# `Test Files` or `Tests` line, which log is this call's, and what that log
# says. See its header.
#
# FAILS OPEN (mantahostels#103 §6), recorded via lib/guard-log.sh: no node, a judge
# that answers no JSON, or one that cannot find this call's log with
# certainty says nothing and logs why.
#
# LIMITS
#  - Two launches in one call say nothing, which launch lost its verdict
#    being uncertain.
#  - A `head` that closes the pipe early kills the run itself, so no log
#    holds a verdict and the record has no line for it.
#
# Its `if: Bash(*test*)` narrowing, which `npm run test`, `npm test` and
# `run-vitest` all hold, is unanchored, as `gp_unwrap` reads past a wrapper
# prefix the anchored form would not match. ONE registration per event, never
# two: two both fire on some calls, doubling the context (#1661). The narrowing
# is best-effort, so the scope test below re-reads the command.
#
# IMPLICIT: after a suite run whose output shows no pass/fail line, hands the
#   session that run's verdict lines and TEST LOG path.
# JUSTIFIED: fail-safe — it adds context and refuses nothing; the re-run it
#   heads off costs minutes of suite time.
# DEFEAT: `bash -c`, a script or a heredoc wrapping the launch; deleting the
#   registration.

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
    gl_open "lib/guard-parse.sh did not load — a suite run's lost verdict went unreported"
  exit 0
}
declare -F suite_launch_kind >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/suite-launch.sh did not load — a suite run's lost verdict went unreported"
  exit 0
}

gp_begin '.tool_input.command' command

JUDGE_JS="$here/lib/lost-verdict.js"

launches=0
count_launch() {
  shift
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  (($#)) || return 0
  suite_launch_kind "$@" || return 0
  [[ "$_sl_kind" == npm-vitest || "$_sl_kind" == wrapper ]] && ((++launches))
  return 0
}

gp_walk_commands count_launch
((launches)) || exit 0
((launches == 1)) ||
  gl_open "$launches suite launches in one call — which lost its verdict is uncertain"

command -v node >/dev/null 2>&1 && [[ -r "$JUDGE_JS" ]] ||
  gl_open "node or lib/lost-verdict.js unavailable — a suite run's lost verdict went unreported"

out="$(printf '%s' "$_gp_payload" | node "$JUDGE_JS" 2>/dev/null)"
context="$(printf '%s' "$out" | jq -er 'if type == "object" then (.context // "") else error end' 2>/dev/null)" || {
  gl_log "lib/lost-verdict.js gave no verdict — a suite run's lost verdict went unreported" "$out"
  exit 0
}
why="$(printf '%s' "$out" | jq -r '.why // ""' 2>/dev/null)"
[[ -n "$why" ]] && gl_log "a suite run's lost verdict went unreported" "$why"
[[ -n "$context" ]] || exit 0

event="$(gp_payload_field '.hook_event_name')"
[[ "$event" == PostToolUseFailure ]] || event=PostToolUse
gp_context "$context" "$event"
exit 0
