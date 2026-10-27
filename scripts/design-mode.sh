#!/usr/bin/env bash
# Toggle the frontend-design plugin (impeccable) on and off.
#
# It stays off by default: impeccable installs PostToolUse/Stop hooks that fire
# a Node process on every Edit/Write, which is dead weight on doc-only sessions.
# Turn it on for a design session, off when it ends.
#
# PROJECT SCOPE IS THE LIVE SWITCH. Enablement and installation resolve
# separately — the plugin must be INSTALLED at user scope (mantahostels#3233), but
# the boolean below is read project-first and wins outright. Both directions measured at mantahostels#3234, by in-repo `claude -p --debug
# hooks` probes:
#   project=false, user=true  -> `enabled=false; will NOT register`, skill absent
#   project=true,  user=false -> `enabled=true`, both hooks registered
# So `off` need not uninstall, and do not repoint this at `claude plugin
# enable/disable --scope user`: that would flip design mode for every project on
# the machine, which is a separate switch nothing here manages, and this repo
# would stop honouring it. THE HARNESS WILL PUSH YOU THE OTHER WAY — with the
# project key true and the user key false, which is what `on` leaves, it raises
# an `ineffective-disable` warning naming this precedence. That warning is the
# design working, not a fault to fix. `claude plugin list --json` is no use as a
# read either — its `enabled` field lagged the live state throughout the probes.
#
# `status` reads the project key alone. `.claude/settings.local.json`, a
# `--settings` file and managed policy all sit ABOVE it and would beat it; none
# carries this key today, so the report is accurate while that holds (mantahostels#3234).
#
# PLUGINS is an array of one since taste-skill was uninstalled (mantahostels#3001, executing
# mantahostels#2968); the loops stay so a second plugin is one element away, not a rewrite.
#
#   scripts/design-mode.sh on | off | status
#
# Flips booleans in .claude/settings.json (authority class `free-edit`, doc-map
# §A). Claude Code reads that file at startup — restart the session to apply.

set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh"
# gr_root() finds the HOST repo, never this file's own location — in a plugin
# install this script ships in the plugin cache, not the host repo (#1).
SETTINGS="$(gr_root)/.claude/settings.json"
PLUGINS=("impeccable@impeccable")

usage() {
  echo "usage: $(basename "$0") on|off|status" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage

# `.enabledPlugins[$p] // "absent"` would be wrong: jq's // treats false as
# empty, so a disabled plugin would report as absent. Test with has() instead.
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

# A fresh checkout (fantasy-books, first run: #125) has no enabledPlugins
# entry at all. Absent means off (SKILL.md's "off by default"), so `on`/`off`
# write the key rather than refusing — `off` on an absent key is now a no-op
# in effect (the settings file still gains an explicit `false`), and `on`
# creates the entry it needs. Neither checks user-scope install state — the
# removed refusal never did either — so `on` on a machine where impeccable
# isn't installed there writes `true` and reports success with nothing
# telling the operator the plugin itself is still missing (mantahostels#3233).
# One jq pass per array element, via a temp file. Do NOT use `jq --args ... "$SETTINGS"
# "${PLUGINS[@]}"`: --args makes every trailing argument positional, including
# the filename, so jq reads empty stdin and truncates the settings file.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$SETTINGS" "$tmp"
for p in "${PLUGINS[@]}"; do
  aw_write "$tmp" jq --arg p "$p" --argjson v "$value" '.enabledPlugins[$p] = $v' "$tmp"
done
# Every live session reads the settings file, so it is replaced whole, never
# copied over; -e never installs unparseable settings.
aw_write "$SETTINGS" jq -e . "$tmp"

echo "design mode: $1"
show_status
echo "Restart the Claude Code session to apply."
