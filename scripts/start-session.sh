#!/usr/bin/env bash
# Start a session by hand in its own worktree (#4241). It cuts the worktree
# through scripts/session-checkout.js, as every dispatched session's launcher
# does, and opens an interactive `claude` with that worktree as its cwd, so a
# hand-started session follows the one model with no exception in the guards
# (#4168 Q2).
#
# Usage, from anywhere inside the repo:
#   scripts/start-session.sh [<session-name>] [<claude args>...]
#
# <session-name> names the worktree, .claude/worktrees/<session-name>/, and
# the session; hand-<UTC timestamp> where none is given. The plan is the
# shell's CLAUDE_CONFIG_DIR: `CLAUDE_CONFIG_DIR=~/.claude2 scripts/start-session.sh`.
# Every later argument goes to `claude` unchanged.
#
# Exit codes: 1 the cut refused or failed (why on stderr), 5 refused on a
# wedged WSL interop bridge, before anything is cut; otherwise `claude`'s own.

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/interop-probe.sh
source "$here/lib/interop-probe.sh" 2>/dev/null

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
exec "${WFC_CLAUDE_BIN:-claude}" --name "$name" "$@"
