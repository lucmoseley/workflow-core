#!/usr/bin/env bash
# start-session.sh — start a session by hand in its own worktree (#4241). It
# cuts the worktree through scripts/session-checkout.js, as every dispatched
# session's launcher does, starts a background job with that worktree as its
# cwd, and attaches this terminal to it, so a hand-started session follows the
# one model with no exception in the guards (#4168 Q2). The job is started as
# the agents view starts one (`--agent claude`), so the guards read it as his
# own (lib/background-start.js), and its record keeps the worktree for a
# resume. Neither `claude` call inherits the shell's root
# (lib/inherited-roots.js).
#
# Usage, from anywhere inside the repo:
#   scripts/start-session.sh [<session-name>] [<claude args>...]
#
# <session-name> names the worktree, .claude/worktrees/<session-name>/, and
# the session; hand-<UTC timestamp> where none is given. The plan is the
# shell's CLAUDE_CONFIG_DIR: `CLAUDE_CONFIG_DIR=~/.claude2 scripts/start-session.sh`.
# Every later argument goes to `claude --bg` unchanged; with no prompt among
# them the session waits idle for one. Leaving the attached view leaves the
# session running, as in `claude attach`.
#
# No `-e`: every step's failure is checked where it stands, and the probe
# library's absence must not end the script (BashFAQ/105,
# docs/practice/shell-scripting-and-hooks.md).
#
# Exit codes: 1 the cut or the launch refused or failed (why on stderr), 5
# refused on a wedged WSL interop bridge, before anything is cut; otherwise
# `claude attach`'s own.

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# Fails open where the library will not load, as dispatch-sessions.sh does:
# the probe may never be the reason Claude won't start (mantahostels#3111).
# shellcheck source=scripts/lib/interop-probe.sh
source "$here/lib/interop-probe.sh" 2>/dev/null
# shellcheck source=scripts/lib/bg-launch-id.sh
source "$here/lib/bg-launch-id.sh" || exit 1

if [[ $# -gt 0 && "$1" != -* ]]; then
  name="$1"
  shift
else
  name="hand-$(date -u +%Y%m%d-%H%M%S)"
fi

if command -v claude_interop_wedged >/dev/null 2>&1 && claude_interop_wedged; then
  printf 'REFUSED: the WSL interop bridge is wedged, so `claude` would hang rather than start.\n' >&2
  claude_interop_recovery_text
  exit 5
fi

dir="$(node "$here/session-checkout.js" cut "$name")" || exit 1
cd "$dir" || exit 1
# The roots the cut read are not the job's: a daemon this launch starts would
# hand them to every later job in any repository (#4595).
read -ra roots <<<"$(node "$here/lib/inherited-roots.js")"
unset "${roots[@]}"
launched="$("${WFC_CLAUDE_BIN:-claude}" --bg --agent claude --name "$name" "$@")" || {
  # claude-route-exempt: only text
  printf 'start session: `claude --bg` failed in %s, which stays cut for a retry:\n%s\n' "$dir" "$launched" >&2
  exit 1
}
id="$(printf '%s\n' "$launched" | bg_launch_id)"
if [[ -z "$id" ]]; then
  # claude-route-exempt: only text
  printf 'start session: no job id in what `claude --bg` printed; attach from `claude agents`:\n%s\n' "$launched" >&2
  exit 1
fi
exec "${WFC_CLAUDE_BIN:-claude}" attach "$id"
