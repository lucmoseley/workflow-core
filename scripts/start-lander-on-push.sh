#!/usr/bin/env bash
# start-lander-on-push.sh — PostToolUse hook: after a push to `landing`, start
# the lander detached, so
# the push's commits are tested and landed with no timer running anything
# (#2405, spec #2261).
#
# IMPLICIT:  after a Bash call that pushes to `landing`, runs
#            start-lander.js detached, which — where the `landing` module is
#            on, no lander runs and the remote's `landing` is ahead of `main`
#            — starts `lander.js run` in a session of its own.
# JUSTIFIED: fail-safe — a push to `landing` that starts no lander sits
#            untested until some later session starts, and every session
#            meanwhile builds on a `main` behind its own work.
# DEFEAT:    turning the `landing` module off; deleting the registration.
#
# PostToolUse fires only on a call that exited 0, a failed push reaching
# PostToolUseFailure instead, where this hook is not registered
# (hook-registrations.test.ts pins it). A push whose failure the call hides
# (`|| true`, a later `;`) still starts start-lander.js, which reads the remote
# and starts nothing where `landing` is not ahead of `main`.
#
# The module is read in bash first, so an adopter with `landing` off spawns no
# node on a push.
#
# Each destination is read by lib/push-dests.sh, as guard-branch-publish.sh
# reads it, so the two agree on which pushes reach `landing`.
#
# Wired on PostToolUse with matcher "Bash", narrowed `if: Bash(*push*)`,
# unanchored because the walker reads a push behind gp_unwrap's wrappers.
#
# LIMITS
#  - A push the walker cannot see — `sh -c`, a script, the founder's terminal
#    — starts nothing; the session-start launcher starts the lander instead.
#  - `--all`, `--branches` and `--mirror` start nothing, whatever they push.
#  - It never writes to stdout: a PostToolUse hook's output is context handed
#    to the session. start-lander.js's own
#    output, a failure included, goes to the lander's log.
#  - Every fault allows: a missing lib or node starts nothing, logged to
#    guard-errors.log where the log itself loads.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
# shellcheck source=scripts/lib/detach.sh
source "$here/lib/detach.sh" 2>/dev/null
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh" 2>/dev/null
# shellcheck source=scripts/lib/wfc-config.sh
source "$here/lib/wfc-config.sh" 2>/dev/null
# shellcheck source=scripts/lib/push-dests.sh
source "$here/lib/push-dests.sh" 2>/dev/null
if ! declare -F gp_begin >/dev/null 2>&1 || ! declare -F pd_read >/dev/null 2>&1 ||
  ! declare -F wfc_module_on >/dev/null 2>&1 || ! declare -F detach >/dev/null 2>&1 ||
  ! declare -F gr_markers_dir >/dev/null 2>&1; then
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "a lib this hook sources did not load — a push to landing started no lander"
  exit 0
fi

gp_begin '.tool_input.command' command

to_landing=0
judge_push() {
  local tree="$3" i
  shift 3
  pd_read "$tree" "$@"
  ((pd_inert || pd_delete || pd_all)) && return 0
  for i in ${pd_kind[@]+"${!pd_kind[@]}"}; do
    [[ "${pd_kind[i]}" == push && "${pd_ref[i]}" == refs/heads/landing ]] && to_landing=1
  done
  return 0
}

gp_walk_repo_git --unwrap judge_push "lander start" push

if ((to_landing)) && wfc_module_on landing; then
  if ! command -v node >/dev/null 2>&1; then
    gl_log "no node — a push to landing started no lander" "$_gp_subject"
  else
    detach --log "$(gr_markers_dir)/.lander.log" node "$here/start-lander.js"
  fi
fi
exit 0
