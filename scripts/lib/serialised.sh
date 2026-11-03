#!/bin/sh
# serialised.sh <caller> <name> <command>… — runs <command> holding the
# machine-wide lock ${TMPDIR:-/tmp}/wfc-<name>.lock, so every run under the same
# <name> goes one at a time: the pre-commit shellcheck gate, check:sh and
# check:sh:changed share `shellcheck` (workflow-core#2579, workflow-core#2627). For a linter whose peak
# memory is worth more than the wait. <command>'s own exit status is returned.
# <caller> prefixes each line it prints.
#
# RUN, NOT SOURCED: precommit-gate.sh registers the hook's EXIT trap when it is
# sourced, so the lock lives here, where a script outside the hook can reach it.
#
# Says so before it waits. Past SERIAL_WAIT_S, or where the lock cannot be taken
# at all — no flock (macOS ships none), or a lock file that will not open — it
# runs <command> unserialised rather than refuse the caller.
#
# SERIAL_WAIT_S is two of the heaviest commit-gate runs queued ahead (a 3-file
# batch of the heaviest files took 86 s, workflow-core#2579), kept well under the Bash tool's
# 600 s ceiling so a session's commit reaches the fallback before the tool kills
# it.

set -u

SERIAL_WAIT_S=180
sl_caller="$1"
sl_lock="${TMPDIR:-/tmp}/wfc-$2.lock"
shift 2

# `command` keeps a failed redirection from exiting the script, as a special
# built-in's would. <command> inherits fd 9, so the lock is held until
# <command> exits.
if ! command -v flock >/dev/null 2>&1; then
  # Silent: a machine with no flock (macOS) would print this on every run.
  :
elif ! command exec 9>>"$sl_lock"; then
  echo "$sl_caller: cannot open $sl_lock — running $1 unserialised." >&2
elif ! flock -n 9; then
  echo "$sl_caller: another run holds $sl_lock — waiting up to ${SERIAL_WAIT_S} s to run $1 after it." >&2
  flock -w "$SERIAL_WAIT_S" 9 ||
    echo "$sl_caller: could not take $sl_lock within ${SERIAL_WAIT_S} s — running $1 unserialised." >&2
fi
exec "$@"
