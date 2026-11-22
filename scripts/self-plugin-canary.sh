#!/usr/bin/env bash

set -uo pipefail

REFUSE_EXIT=2

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
fault=""
loaded=""
unrooted=""

# #2461
main_checkout() {
  local at="${CLAUDE_PROJECT_DIR:-}" common
  [[ -n "$at" ]] || at="$(gr_root)"
  common="$(git -C "$at" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    [[ "$common" == */.git ]] && gr_physical "${common%/.git}"
}

refuse() {
  local main dir word setup quoter_fault=""
  main="$(main_checkout 2>/dev/null)"
  main="${main:-<absolute path to the main checkout>}"
  dir="$main/self-plugin"
  # shellcheck source=scripts/lib/script-path.sh
  if source "$here/lib/script-path.sh" 2>/dev/null && declare -F sp_shell_word >/dev/null; then
    word="$(sp_shell_word "$dir")"
  else
    # #3798
    word="'${dir//\'/\'\\\'\'}'"
    quoter_fault=$'\n\nlib/script-path.sh did not load, so this install is broken.'
  fi
  setup="claude plugin marketplace add $word --scope user"
  [[ -n "$fault" ]] && printf 'The self-plugin canary could not check this session (%s), so it refuses as if the self-plugin had not loaded.\n\n' "$fault" >&2
  if [[ -n "$unrooted" ]]; then
    cat >&2 <<EOF
Refused: this session's self-plugin marker records no plugin root, so the canary cannot tell which tree its hooks are running from.

Restart the session first. Where the new session is refused the same way, have the founder run this once per machine:
EOF
  elif [[ -n "$loaded" ]]; then
    cat >&2 <<EOF
Refused: the wfc-self self-plugin loaded in this session from $loaded, not from the main checkout's $dir, so this session's hooks are running another tree's scripts.

Have the founder run this once per machine, so the marketplace names the main checkout:
EOF
  else
    cat >&2 <<EOF
Refused: the wfc-self self-plugin did not load in this session, so none of workflow-core's guards are running here. They register from self-plugin/hooks/hooks.json, which loads only once its marketplace is set up on this machine.

Have the founder run this once per machine:
EOF
  fi
  cat >&2 <<EOF

! $setup

Then restart the session: plugins load only at session start, so this session cannot pick it up.

A cloud session cannot load the self-plugin at all (#1892), so it is always refused here; work this repo from a local session.$quoter_fault
EOF
  exit "$REFUSE_EXIT"
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
# #2626
{ body="$(<"$marker")"; } 2>/dev/null || {
  fault="$marker unreadable"
  exit
}
[[ -n "$body" ]] || {
  unrooted=1
  exit
}
main="$(main_checkout)"
[[ -n "$main" ]] || {
  fault="git named no main checkout for this session's project directory"
  exit
}
body="${body%/}"
if [[ "${body##*/}" != self-plugin || "$(gr_physical "${body%/*}")" != "$main" ]]; then
  loaded="$body"
  exit
fi

trap - EXIT
