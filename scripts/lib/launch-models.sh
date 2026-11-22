#!/usr/bin/env bash

LAUNCH_MODELS=(
  pick-next=haiku
  to-tickets=opus triage=opus implement=opus wayfinder=opus to-spec=opus code-review=opus manual-sync=opus
  concision-pass=opus research=opus card-close=opus roadmap-edit=opus
)

LAUNCH_MODEL_FALLBACK="opus"
: "$LAUNCH_MODEL_FALLBACK"

launch_model_for() {
  local pair
  for pair in "${LAUNCH_MODELS[@]}"; do
    if [[ "${pair%%=*}" == "$1" ]]; then
      printf '%s' "${pair#*=}"
      return 0
    fi
  done
  return 1
}
