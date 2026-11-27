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
  local rc=0
  if [[ -f "$marker" ]]; then
    echo "burn mode: on"
  else
    echo "burn mode: off"
  fi
  node "$lib" report || rc=$?
  [[ $rc -le 1 ]] || exit 2
  return "$rc"
}

apply() {
  aw_write "$1" jq -e --argjson s "$2" '
    .model = $s.model
    | .modelSettings = ((.modelSettings // {}) * $s.modelSettings)' "$1"
}

write_settings() {
  local settings f
  settings="$(node "$table" settings)" || {
    echo "error: the routing file will not load — no settings file touched" >&2
    exit 2
  }
  while IFS= read -r -d '' f; do
    apply "$f" "$settings" || echo "error: could not write $(rel "$f")" >&2
  done < <(settings_files)
}

case "$1" in
  status)
    show_status || true
    exit 0
    ;;
  on)
    write_settings
    mkdir -p "$(dirname "$marker")"
    : >"$marker"
    ;;
  off)
    write_settings
    rm -f "$marker"
    ;;
  *) usage ;;
esac

if ! show_status; then
  echo "error: a plan above departs from the routing file's settings — rerun once it is writable" >&2
  exit 1
fi
echo "The dispatch routing applies from the next Agent call; no session needs a restart."
exit 0
