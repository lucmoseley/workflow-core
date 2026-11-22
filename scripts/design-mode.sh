#!/usr/bin/env bash

set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh"
# #5287
SETTINGS="$(gr_worktree_root)/.claude/settings.json"
PLUGINS=("impeccable@impeccable")

usage() {
  echo "usage: $(basename "$0") on|off|status" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage

show_status() {
  for p in "${PLUGINS[@]}"; do
    printf '  %-24s %s\n' "$p" \
      "$(jq -r --arg p "$p" 'if .enabledPlugins | has($p) then .enabledPlugins[$p] | tostring else "absent" end' "$SETTINGS")"
  done
}

case "$1" in
  status)
    show_status
    exit 0
    ;;
  on) value=true ;;
  off) value=false ;;
  *) usage ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$SETTINGS" "$tmp"
for p in "${PLUGINS[@]}"; do
  aw_write "$tmp" jq --arg p "$p" --argjson v "$value" '.enabledPlugins[$p] = $v' "$tmp"
done
aw_write "$SETTINGS" jq -e . "$tmp"

echo "design mode: $1"
show_status
echo "Restart the Claude Code session to apply."
