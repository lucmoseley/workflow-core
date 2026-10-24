#!/usr/bin/env bash
# guard-failed-call-rules.sh — after a call fails in one of two known ways,
# hand the session the rule for that failure (workflow-core#2026).
#
#   PostToolUseFailure, Bash, exit 137 or 143 — `rule:silent-kill`: a call
#     killed by a signal is probably earlyoom; run `memcheck` before debugging.
#   PostToolBatch, a `Skill` result refused for `disable-model-invocation` —
#     `rule:skill-refused`: never replicate the skill; do the work directly.
#
# WHY TWO EVENTS. A refused `Skill` never reaches PostToolUseFailure: the
# harness refuses it in the tool's input validation, which answers with a
# `<tool_use_error>` before any PreToolUse or PostToolUse* hook runs.
# PostToolBatch fires once per batch with every call's result text, the
# refusal included, and takes `additionalContext`.
#
# FAILS OPEN (mantahostels#103 §6), recorded via lib/guard-log.sh: no jq, an
# unparseable payload or an unreadable fragment says nothing and logs why.
#
# LIMITS
#  - Exit 137/143 is a signal, not a cause: a `kill` or `timeout -s KILL` in
#    the command lands here too.
#  - The Skill limb matches the harness's refusal wording,
#    "due to disable-model-invocation"; a reworded refusal goes unseen.
#  - It speaks on every hit, unlatched.
#
# IMPLICIT: after a Bash call killed by signal, or a Skill call refused as
#   slash-only, hands the session that rule's text as additionalContext.
# JUSTIFIED: fail-safe — it adds context and refuses nothing.
# DEFEAT: deleting either registration.

set -uo pipefail

REFUSAL='due to disable-model-invocation'

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — a failed call's rule went unsaid"
  exit 0
}

gp_begin '.hook_event_name' 'failed call' 'hook_event_name'
event="$(gp_subject)"

case "$event" in
  PostToolUseFailure)
    hit="$(gp_payload_field '
    (.tool_name == "Bash" and (.is_interrupt | not)
      and ((.error // "") | test("(^|\n)Exit code (137|143)(\n|$)")))')"
    [[ "$hit" == true ]] || exit 0
    text="$(gp_rule_text silent-kill '')"
    ;;
  PostToolBatch)
    hit="$(gp_payload_field '
    any(.tool_calls[]?; .tool_name == "Skill"
      and ((.tool_response // "") | tostring
        | contains("'"$REFUSAL"'")))')"
    [[ "$hit" == true ]] || exit 0
    text="$(gp_rule_text skill-refused '')"
    ;;
  *) exit 0 ;;
esac

[[ -n "$text" ]] || gl_open "rule fragment unreadable — a $event rule went unsaid"
gp_context "$text" "$event" ||
  gl_log "additionalContext did not render — a $event rule went unsaid"
exit 0
