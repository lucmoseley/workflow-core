#!/usr/bin/env bash
# subagent-payload.sh — whether a hook payload came from a subagent: the shell
# face of lib/subagent-payload.js, which its test holds to the same answers
# (workflow-core#1785).

# is_subagent_payload <payload> — status 0 for a subagent's payload. A payload
# jq cannot read, or no jq, reads as the parent's.
is_subagent_payload() {
  local id
  id="$(printf '%s' "$1" | jq -r '.agent_id // "" | tostring' 2>/dev/null)" || return 1
  [[ -n "$id" ]]
}
