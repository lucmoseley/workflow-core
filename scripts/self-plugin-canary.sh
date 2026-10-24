#!/usr/bin/env bash
# self-plugin-canary.sh — PreToolUse hook, the one hook `.claude/settings.json`
# keeps: refuses every tool call in a session the self-plugin did not load
# (#2438, spec #2295).
#
# The core's guards register from self-plugin/hooks/hooks.json, which loads
# only where the wfc-self marketplace is set up on the machine.
#
# ALLOWS a call when this input's session has a marker (lib/self-plugin-marker.sh),
# which scripts/write-self-plugin-marker.sh writes at the self-plugin's
# SessionStart. A subagent's calls carry its parent's session id, so it is
# covered.
#
# FAILS CLOSED, unlike every other guard here (mantahostels#103 §6): an
# unreadable input, an empty session id, a missing jq or an unresolved root
# denies, and so does any exit this script did not choose — the EXIT trap turns
# it into exit 2, which Claude Code treats as a refusal. The deny goes out on
# stderr, so it needs no jq; no guard-log line is kept.
#
# DENIES-BY: exit 2
#
# NO SessionStart LIMB: native and plugin hooks of one event run in parallel,
# so a SessionStart check would race the marker write; the first tool call
# comes after SessionStart has finished. NO CLOUD EXEMPTION: a cloud session
# cannot load a repo-declared plugin's hooks (#1892), so it is refused like any
# unguarded session.
#
# IMPLICIT: refuses every tool call of a session whose self-plugin marker is absent
# JUSTIFIED: fail-safe — a session the self-plugin did not load would otherwise run with no guards and nothing said
# DEFEAT: none

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
fault=""

refuse() {
  local root common main="" setup quote="'" quote_escaped="'\\''"
  # The main checkout, never a worktree: a marketplace registered at a
  # worktree breaks once the worktree is deleted (#2461). DUPLICATED BY HAND
  # from lib/main-checkout.js's mainCheckout, since this runs with no node.
  root="$(gr_root 2>/dev/null)" &&
    common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    [[ "$common" == */.git ]] && main="${common%/.git}"
  main="${main:-<absolute path to the main checkout>}"
  # DUPLICATED BY HAND as lib/core-hooks.js's selfPluginSetup.
  setup="claude plugin marketplace add '${main//"$quote"/"$quote_escaped"}/self-plugin' --scope user"
  [[ -n "$fault" ]] && printf 'The self-plugin canary could not check this session (%s), so it refuses as if the self-plugin had not loaded.\n\n' "$fault" >&2
  cat >&2 <<EOF
Refused: the wfc-self self-plugin did not load in this session, so none of workflow-core's guards are running here. They register from self-plugin/hooks/hooks.json, which loads only once its marketplace is set up on this machine.

Have the founder run this once per machine:

! $setup

Then restart the session: plugins load only at session start, so this session cannot pick it up.

A cloud session cannot load the self-plugin at all (#1892), so it is always refused here; work this repo from a local session.
EOF
  exit 2
}

trap refuse EXIT

# shellcheck source=scripts/lib/self-plugin-marker.sh
source "$here/lib/self-plugin-marker.sh" 2>/dev/null || {
  fault="lib/self-plugin-marker.sh did not load"
  exit
}
marker=""
spm_marker_path marker || {
  fault="$marker"
  exit
}
[[ -e "$marker" ]] || exit

trap - EXIT
exit 0
