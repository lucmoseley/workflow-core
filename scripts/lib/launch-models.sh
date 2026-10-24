#!/usr/bin/env bash
# The one session-kind -> model map (#360, which ruled this file the single
# source; #361 built it). scripts/launch.sh reads it;
# launch-models.test.ts fails where the Model column of
# docs/effort-guide.md §Which model to launch each session on, or of
# .claude/skills/pick-next/SKILL.md §6's `takes:` table, or
# scripts/lib/retro-bundles.js's RETRO_BUNDLE_MODEL, disagrees with it.
# Change a model here and in all three, or the test goes red.
#
# SOURCED, NEVER RUN. Plain bash, no jq.
#
# card-close and roadmap-edit normally run as skills inside a host session, at
# that host's model; their rows are the standalone launch (#360 Q2).

# kind=model. Rows ruled at mantahostels#1093, mantahostels#1334, #354 and #1920.
LAUNCH_MODELS=(
  pick-next=sonnet
  to-tickets=opus triage=opus implement=opus wayfinder=opus to-spec=opus code-review=opus manual-sync=opus
  concision-pass=opus research=opus card-close=opus roadmap-edit=opus
)

# What a kind absent from the map launches on (mantahostels#1088's tie-break) —
# the effort guide's `ad-hoc / untyped` row.
# shellcheck disable=SC2034  # read by launch.sh, which sources this
LAUNCH_MODEL_FALLBACK="opus"

# Prints <kind>'s model. Returns 1, printing nothing, where the kind is unmapped.
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
