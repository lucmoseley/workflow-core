# shellcheck shell=bash

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

OUTLIVE_STRIPPED=(CLAUDE_CODE_SESSION_ID CLAUDE_JOB_DIR WFC_REPORT_OWNER)
OUTLIVE_CEILING_S=2700
: "${OUTLIVE_CEILING_S}"

outlive_probe() {
  OUTLIVE_MANAGER=no
  if timeout 5 "${WFC_SYSTEMD_RUN:-systemd-run}" --user --scope --quiet -- true >/dev/null 2>&1; then
    OUTLIVE_MANAGER=yes
  fi
}

outlive() {
  local owner="$1" ceiling="$2" key log=()
  shift 2
  if [[ "${1-}" == --log ]]; then
    log=(--log "$2")
    shift 2
  fi
  [[ -n "${OUTLIVE_MANAGER-}" ]] || outlive_probe
  local run=(env)
  for key in "${OUTLIVE_STRIPPED[@]}"; do run+=(-u "$key"); done
  [[ -z "$owner" ]] || run+=("WFC_REPORT_OWNER=$owner")
  if [[ "$OUTLIVE_MANAGER" == yes ]]; then
    [[ -z "${CLAUDE_PID-}" ]] || run+=("WFC_OUTLIVES=$CLAUDE_PID:$ceiling")
    run+=("${WFC_SYSTEMD_RUN:-systemd-run}" --user --scope --quiet)
    [[ -z "$ceiling" ]] || run+=(-p "RuntimeMaxSec=$ceiling")
    run+=(--)
  fi
  detach "${log[@]}" "${run[@]}" "$@"
}
