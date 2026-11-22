#!/usr/bin/env bash
aw_write() {
  local file="$1" aside rc=0
  shift
  [[ -L "$file" ]] && { file="$(readlink -f -- "$file")" || return 1; }
  aside="$file.$BASHPID.$(printf '%04x%04x' "$RANDOM" "$RANDOM").tmp"
  (set -C && : >"$aside") 2>/dev/null || return 1
  if (($#)); then "$@" >"$aside"; else cat >"$aside"; fi || rc=1
  ((rc)) || [[ ! -e "$file" ]] || chmod --reference="$file" "$aside" || rc=1
  ((rc)) || mv -fT "$aside" "$file" || rc=1
  ((rc)) && rm -f "$aside"
  return "$rc"
}
