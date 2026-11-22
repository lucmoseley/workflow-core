#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") on|off|status" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh"
lib="$here/lib/burn-mode.js"
table="$here/lib/model-table.js"
marker="$(node "$lib" marker)" ||
  {
    echo "error: cannot place the burn-mode marker — HOME is unset or relative" >&2
    exit 2
  }

home_real="$(realpath -- "$HOME")" || home_real="$HOME"
node "$lib" plans >/dev/null || exit 2
settings_files() { node "$lib" plans --quiet; }
rel() { printf '%s' "${1#"$home_real"/}"; }

show_status() {
  local flag=() rc=0
  if [[ -f "$marker" ]]; then
    echo "burn mode: on"
    flag=(--burn)
  else
    echo "burn mode: off"
  fi
  node "$lib" report "${flag[@]}" || rc=$?
  [[ $rc -le 1 ]] || exit 2
}

apply() {
  aw_write "$1" jq -e --argjson s "$2" '
    .model = $s.model
    | .modelSettings = ((.modelSettings // {}) * $s.modelSettings)' "$1"
}

writes() {
  node "$table" settings "$@" || {
    echo "error: the routing file will not load — no settings file touched" >&2
    exit 2
  }
}

case "$1" in
  status)
    show_status
    exit 0
    ;;
  on)
    settings="$(writes --burn)"
    mkdir -p "$(dirname "$marker")"
    : >"$marker"
    while IFS= read -r -d '' f; do
      apply "$f" "$settings" || {
        echo "error: could not write the burn settings into $(rel "$f")" >&2
        exit 1
      }
    done < <(settings_files)
    ;;
  off)
    settings="$(writes)"
    while IFS= read -r -d '' f; do
      apply "$f" "$settings" || echo "error: could not write $(rel "$f")" >&2
    done < <(settings_files)
    rc=0
    node "$lib" report >/dev/null || rc=$?
    if [[ $rc -ne 0 ]]; then
      show_status
      echo "error: a plan above still departs from the standard settings after off — burn mode stays on" >&2
      exit 1
    fi
    rm -f "$marker"
    node "$here/burn-off-sessions.js" || sessions_failed=1
    ;;
  *) usage ;;
esac

show_status
if [[ -n "${sessions_failed:-}" ]]; then
  echo "error: a live session is still on a model only burn mode uses — scripts/burn-off-sessions.js named it above; rerun that once it is free" >&2
  exit 1
fi
echo "Restart the Claude Code session to pick up the model — a session launched with no model flag runs it; the dispatch remap applies from the next Agent call."
echo "A warm spare (\`claude bg-spare\`) booted before this keeps the old model — kill or claim it first (docs/effort-guide.md §Which model to launch each session on)."
echo "So does the session the agents view already created for its launch line — launch one throwaway session from there first (/usage serves) so the next is created fresh."
exit 0
