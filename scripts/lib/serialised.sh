#!/bin/sh
set -u

# #2579 measured 86 s for the heaviest commit-gate batch; two queued, under the Bash tool's 600 s
SERIAL_WAIT_S=180
sl_caller="$1"
sl_lock="${TMPDIR:-/tmp}/wfc-$2.lock"
shift 2

# A special built-in's failed redirection exits a non-interactive shell; `command` stops that (https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html)
if ! command -v flock >/dev/null 2>&1; then
  :
elif ! command exec 9>>"$sl_lock"; then
  echo "$sl_caller: cannot open $sl_lock — running $1 unserialised." >&2
elif ! flock -n 9; then
  echo "$sl_caller: another run holds $sl_lock — waiting up to ${SERIAL_WAIT_S} s to run $1 after it." >&2
  flock -w "$SERIAL_WAIT_S" 9 ||
    echo "$sl_caller: could not take $sl_lock within ${SERIAL_WAIT_S} s — running $1 unserialised." >&2
fi
exec "$@"
