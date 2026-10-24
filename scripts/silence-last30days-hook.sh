#!/usr/bin/env bash
#
# silence-last30days-hook.sh — blank the last30days plugin's SessionStart hook
# in every Claude config dir's plugin cache.
#
# Why it is off at all, and why disabling the plugin instead is the wrong act:
# `docs/agents/last30days.md`.
#
# Run it after any last30days update (mantahostels#3246).
#
#   scripts/silence-last30days-hook.sh          # blank every hooks.json found
#   scripts/silence-last30days-hook.sh --check   # report only, write nothing
#
# Exit: 0 clean; 1 either a live hook under --check or no cache found at all, so
# a caller cannot read a 1 as "still firing" without reading the message; 2 bad
# usage. A failed write aborts mid-loop under `set -e`, leaving later files
# unvisited and no summary line.
#
# The silenced test is TEXTUAL, against the exact bytes below: an equivalent
# `{"hooks":{}}` reads as live and is rewritten every run. The glob is `.claude*`
# rather than the three names, so `~/.bashrc`'s plan list stays the one place
# that owns it — a stale `~/.claude-backup` would be swept in too, and under
# --check would keep exit 1 alive for ever.

set -euo pipefail

[ "$#" -le 1 ] || {
  echo "usage: $(basename "$0") [--check]" >&2
  exit 2
}

check_only=false
case "${1-}" in
  --check) check_only=true ;;
  "") ;;
  *)
    echo "usage: $(basename "$0") [--check]" >&2
    exit 2
    ;;
esac

silenced='{"hooks": {}}'
found=0
live=0

for hooks in "$HOME"/.claude*/plugins/cache/last30days-skill/last30days/*/hooks/hooks.json; do
  [ -e "$hooks" ] || continue
  found=$((found + 1))
  if [ "$(cat "$hooks")" = "$silenced" ]; then
    continue
  fi
  live=$((live + 1))
  if [ "$check_only" = true ]; then
    echo "LIVE  $hooks"
  else
    printf '%s' "$silenced" >"$hooks"
    echo "silenced  $hooks"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "no last30days plugin cache found under ~/.claude*" >&2
  exit 1
fi

if [ "$check_only" = true ] && [ "$live" -gt 0 ]; then
  echo "$live of $found last30days hook file(s) still fire; run without --check" >&2
  exit 1
fi

echo "$found last30days hook file(s) checked, $live changed"
