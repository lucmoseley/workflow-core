#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Human-in-the-loop reproduction loop.
Copy this file, edit the steps in your_steps(), and run it.
The agent runs the script; the user follows prompts in their terminal.

Usage:
  bash hitl-loop.template.sh

Two helpers:
  step "<instruction>"          -> show instruction, wait for Enter
  capture VAR "<question>"      -> show question, read response into VAR

At the end, captured values are printed as KEY=VALUE for the agent to parse.

`capture` prints its value back to the terminal, where the agent reads it,
so capture observations, and leave signing in to the user as a `step`.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

your_steps() {
  step "Open the app at http://localhost:3000 and sign in."

  capture ERRORED "Click the 'Export' button. Did it throw an error? (y/n)"

  capture ERROR_MSG "Paste the error message (or 'none'):"
}

your_steps

printf '\n--- Captured ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
