# shellcheck shell=bash
# detach.sh — start a command nothing waits on, for the hooks that launch
# background jobs (session-start-sweeps.sh).
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

# THE OUTLIVING LAUNCH (#4706), lib/user-scope.js's spawnOutliving's twin. A
# job a session start launches to outlive its session runs as no session's
# process — the keys forgetSession strips (lib/session-id.js) unset, so the
# ended-session sweep and the scope's attach passes pass it — naming its
# starter as its reports' owner, in a user scope of its own, outside the
# session's scope and its watcher's kill, stopped at a ceiling with
# everything it started. Where no user manager answers, it is the plain
# detach, still stripped and owner-tagged.
OUTLIVE_STRIPPED=(CLAUDE_CODE_SESSION_ID CLAUDE_JOB_DIR WFC_REPORT_OWNER)
# lib/user-scope.js's OUTLIVE_CEILING_S.
# shellcheck disable=SC2034 # read by the scripts that source this file
OUTLIVE_CEILING_S=2700

# outlive_probe — set OUTLIVE_MANAGER to yes where `systemd-run --user
# --scope` starts a command, else no; the 5 s bound is lib/systemd-bins.js's
# MANAGER_TIMEOUT_MS.
outlive_probe() {
  OUTLIVE_MANAGER=no
  if timeout 5 "${WFC_SYSTEMD_RUN:-systemd-run}" --user --scope --quiet -- true >/dev/null 2>&1; then
    OUTLIVE_MANAGER=yes
  fi
}

# outlive [--log <file>] <owner> <ceiling-s> <command> [<args>…] — detach
# <command> as an outliving job; an empty <owner> names none, an empty
# <ceiling-s> sets none.
outlive() {
  local log=()
  if [[ "${1-}" == --log ]]; then
    log=(--log "$2")
    shift 2
  fi
  local owner="$1" ceiling="$2" key
  shift 2
  [[ -n "${OUTLIVE_MANAGER-}" ]] || outlive_probe
  local run=(env)
  for key in "${OUTLIVE_STRIPPED[@]}"; do run+=(-u "$key"); done
  [[ -z "$owner" ]] || run+=("WFC_REPORT_OWNER=$owner")
  if [[ "$OUTLIVE_MANAGER" == yes ]]; then
    run+=("${WFC_SYSTEMD_RUN:-systemd-run}" --user --scope --quiet)
    [[ -z "$ceiling" ]] || run+=(-p "RuntimeMaxSec=$ceiling")
    run+=(--)
  fi
  detach "${log[@]}" "${run[@]}" "$@"
}
