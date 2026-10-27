# shellcheck shell=bash
# detach.sh — start a command nothing waits on, for the hooks that launch
# background jobs (sweep-debts-detached.sh).
#
# SOURCED, never run.
#
# WHY setsid. A plain `&` child stays in the hook shell's process group, so a
# harness that kills the group on timeout kills the job mid-call. `setsid`
# puts it in a session of its own, out of reach of a group signal; a machine
# without util-linux falls back to the plain background (mantahostels#1251).

# detach [--log <file>] <command> [<args>…] — stdin from /dev/null, stdout
# and stderr appended to <file>, or discarded.
detach() {
  local out=/dev/null
  if [[ "${1-}" == --log ]]; then
    out="$2"
    shift 2
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >>"$out" 2>&1 </dev/null &
  else
    "$@" >>"$out" 2>&1 </dev/null &
  fi
}
