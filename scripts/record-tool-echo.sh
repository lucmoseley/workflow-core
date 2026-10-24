#!/usr/bin/env bash
# PostToolUse recorder: the half of mantahostels#2570 that watches what a call ANSWERED.
#
# IMPLICIT:  hashes every Bash and Read call's input and its response into a
#            per-agent scratch chain, so guard-echo-call.sh can refuse a third
#            identical call that has already given the same answer twice.
# JUSTIFIED: fail-safe — the guard cannot see a response at PreToolUse, and an
#            input-only rule refuses the wrong call 43.5% of the time (mantahostels#2570).
# DEFEAT:    WFC_NO_ECHO_CHAIN=1 — recording stops, so the guard sees no chain
#            and never fires. There is no partial setting.
#
# It writes only under ${TMPDIR:-/tmp}/wfc-echo-chain, never inside the repo,
# and never emits anything on stdout: a PostToolUse hook's output is context
# handed to the session, and this one has nothing to say.
#
# Wired on PostToolUse with matcher "Bash|Read", pinned in
# scripts/hook-registrations.test.ts. The matcher must equal
# guard-echo-call.sh's: a tool recorded but not guarded costs work for nothing,
# and one guarded but not recorded can never fire.
#
# lib/echo-chain.sh holds the store and the chain rule; the measurement behind
# the number two is on mantahostels#2616.

set -uo pipefail

[[ "${WFC_NO_ECHO_CHAIN:-}" == "1" ]] && exit 0

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — no echo chain recorded"
  exit 0
}

# shellcheck source=scripts/lib/echo-chain.sh
source "$here/lib/echo-chain.sh" 2>/dev/null
declare -F ec_sig >/dev/null 2>&1 ||
  gl_open "lib/echo-chain.sh did not load — no echo chain recorded"

gp_begin '.session_id' "echo record"

tool="$(gp_payload_field '.tool_name')"
case "$tool" in
  Bash | Read) ;;
  *) exit 0 ;;
esac

# The two shapes guard-agent-poll.sh owns are neither judged nor recorded: a
# chain nothing reads is work for nothing on every timed beat.
command_line="$(gp_payload_field '.tool_input.command')"
ec_skip "$tool" "$command_line" && exit 0

command -v sha1sum >/dev/null 2>&1 ||
  gl_open "sha1sum not found — no echo chain recorded"

sig="$(ec_sig)"
[[ -n "$sig" ]] ||
  gl_open "could not hash the call — no echo chain recorded"

# An unhashable response is not a match and must not extend a chain. Recording
# it as a fresh run of length 1 would be a lie about what was seen; the record
# is left alone and the chain re-forms from the next readable answer.
#
# 2 is a payload with no response, which is ordinary and silent. 1 is jq or
# sha1sum broken, which disarms the guard for the rest of the session and is
# recorded.
hash="$(ec_response_hash)"
case "$?" in
  0) ;;
  2) exit 0 ;;
  *) gl_open "could not hash the response — no echo chain recorded" ;;
esac

state_file="$(ec_state_file)" ||
  gl_open "could not key the chain store — no echo chain recorded"
first=""
[[ -f "$state_file" ]] || first=1
# A chain that cannot be READ is a broken clock, not an absent record: treating
# it as absent would restart every chain at 1 and silently disarm the guard.
record="$(ec_lookup "$state_file" "$sig")" ||
  gl_open "could not read the chain store — no echo chain recorded"

run=1
denies=0
if [[ -n "$record" ]]; then
  prev_hash="${record%%$'\t'*}"
  rest="${record#*$'\t'}"
  prev_run="${rest%%$'\t'*}"
  prev_denies="${rest#*$'\t'}"
  # Carried across the reset, never restarted with the run: the escalation in
  # guard-echo-call.sh counts refusals on this signature over the agent's life,
  # and a count reset by the reset it is meant to limit would never reach two.
  [[ "$prev_denies" =~ ^[0-9]+$ ]] && denies="$prev_denies"
  # THE READ SHORT CIRCUIT IS THE SAME ANSWER AGAIN, not a new one. The harness
  # answers a re-read of an unchanged file with `type: "file_unchanged"` rather
  # than the file, so it extends the chain and keeps the full read's hash for
  # the next comparison (workflow-core#1090, reversing mantahostels#2637's reset).
  if [[ "$tool" == "Read" && "$(gp_payload_field '.tool_response.type')" == "file_unchanged" ]]; then
    hash="$prev_hash"
  fi
  if [[ "$prev_hash" == "$hash" && "$prev_run" =~ ^[0-9]+$ ]]; then
    run=$((prev_run + 1))
  fi
fi

ec_store "$state_file" "$sig" "$hash" "$run" "$denies" ||
  gl_open "could not write the chain store — no echo chain recorded"

# Only on this agent's FIRST record. The sweep forks a `find`, and this script
# runs on every Bash and Read call — guard-agent-poll.sh:60-64's policy is that
# everything on that path stays cheap, and a once-an-agent sweep empties the
# directory just as surely as a once-a-call one.
[[ -n "$first" ]] && ec_sweep
exit 0
