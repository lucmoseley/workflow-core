#!/usr/bin/env bash

concision_base_file() { printf '%s' "$1/.concision-base-$2"; }

concision_session_base() {
  local base_file base
  base_file="$(concision_base_file "$1" "$2")"
  [[ -f "$base_file" ]] || return 1
  base=$(cat "$base_file" 2>/dev/null)
  [[ -n "$base" ]] || return 1
  if ! git merge-base --is-ancestor "$base" HEAD 2>/dev/null; then
    base=$(git merge-base "$base" HEAD 2>/dev/null) || return 2
    [[ -n "$base" ]] || return 2
  fi
  printf '%s' "$base"
}

pass_fault=""

short_quote() { printf "'%.40s'" "$1"; }

marker_field() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }

marker_has() { grep -q "^$2=" "$1" 2>/dev/null; }

# guess, workflow-core#5529
NAMED_PATHS_MAX=10
: "${pass_fault-}" "${pass_base-}" "${NAMED_PATHS_MAX-}"

marker_list() {
  local v
  local -a named=()
  IFS=, read -ra named <<<"$(marker_field "$1" "$2")"
  for v in "${named[@]}"; do
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    [[ -z "$v" ]] || printf '%s\n' "$v"
  done
}

marker_unlisted() {
  grep -vFx -f <(marker_list "$1" "$2")
  case $? in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

pass_valid() {
  local marker="$1" base="$2" recorded findings written
  pass_fault=""
  pass_base=""
  [[ -f "$marker" ]] || return 1
  recorded=$(marker_field "$marker" base | tr -d '[:space:]')
  written=$(marker_field "$marker" findings)
  findings=$(printf '%s' "$written" | tr -d '[:space:]')
  if ! [[ "$recorded" =~ ^[0-9a-f]{40}$ ]]; then
    if [[ -n "$recorded" ]]; then
      pass_fault="its base= is not a 40-hex sha, $(short_quote "$recorded")"
    else
      pass_fault="it has no readable base= line"
    fi
    return 1
  fi
  case "$findings" in '' | *[!0-9]*)
    if [[ -n "$findings" ]]; then
      pass_fault="its findings= is not a number, $(short_quote "$written") — the count of findings, digits only"
    else
      pass_fault="it has no readable findings= line"
    fi
    return 1
    ;;
  esac
  if ! git rev-parse --verify --quiet "$recorded^{commit}" >/dev/null 2>&1; then
    pass_fault="its base= names a commit this repo does not have"
    return 1
  fi
  [[ "$recorded" = "$base" ]] && return 0
  git merge-base --is-ancestor "$recorded" "$base" 2>/dev/null && return 0
  if git merge-base --is-ancestor "$base" "$recorded" 2>/dev/null; then
    pass_fault="its base= is ahead of this session's start point, so it covered less than the session changed"
    pass_base="$recorded"
    return 2
  fi
  pass_fault="its base= is not on this session's line of history, so it covered a range the session never changed"
  return 1
}

marker_tier_fault() {
  local marker="$1" tier unnamed
  shift
  local -a missing=()
  tier=$(marker_field "$marker" tier | tr -d '[:space:]')
  case "$tier" in
    escalated | mission-critical) ;;
    '')
      printf 'it has no tier= line'
      return 0
      ;;
    *)
      printf 'its tier= is %s, and only escalated or mission-critical covers a declared sensitive path' "$(short_quote "$tier")"
      return 0
      ;;
  esac
  [[ "$#" -gt 0 ]] || return 0
  unnamed="$(printf '%s\n' "$@" | marker_unlisted "$marker" areas)"
  [[ $? -ne 2 ]] || return 2
  [[ -n "$unnamed" ]] || return 0
  mapfile -t missing <<<"$unnamed"
  printf 'its areas= does not name %s' "$(join_comma "${missing[@]}")"
}

join_comma() {
  local IFS=,
  local joined="$*"
  printf '%s' "${joined//,/, }"
}
