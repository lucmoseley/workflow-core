#!/usr/bin/env bash
# Usage: source scripts/lib/guard-log.sh, then call gl_log. Sourced, never run.
#
# Each record is one line, three or four tab-separated fields, append-only:
#
#   <ISO 8601 UTC>\t<guard script name>\t<what was allowed unchecked>[\t<detail>]
#
# Field 2 is derived from $0. Field 3 says what was allowed through and stays
# constant per fault; the varying part goes in field 4.

# shellcheck source=scripts/lib/guard-root.sh
source "${BASH_SOURCE[0]%/*}/guard-root.sh" 2>/dev/null
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }
# workflow-core#2095
declare -F gr_config_dir >/dev/null 2>&1 || gr_config_dir() {
  if [[ -n "${CLAUDE_CONFIG_DIR+set}" ]]; then
    printf -v "$1" '%s' "${CLAUDE_CONFIG_DIR:-.}"
  elif [[ -n "${HOME+set}" ]]; then
    printf -v "$1" '%s' "${HOME:+$HOME/}.claude"
  else
    printf -v "$1" '%s' ~/.claude
  fi
}

gl_where() {
  local name="${0##*/}"
  case "$name" in
    "" | bash | sh | -bash | -sh) printf 'guard' ;;
    *) printf '%s' "$name" ;;
  esac
}

gl_when() {
  local t=""
  TZ=UTC printf -v t '%(%Y-%m-%dT%H:%M:%S)T' -1 2>/dev/null
  case "$t" in
    [0-9][0-9][0-9][0-9]-*) printf '%s.000Z' "$t" ;;
    *) date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null ;;
  esac
}

# guess, workflow-core#1622
GL_DETAIL_MAX=300
: "$GL_DETAIL_MAX"

gl_project_dir() {
  local slug="$1"
  # lucmoseley/mantahostels#2096
  local LC_ALL=C.UTF-8
  slug="${slug//[^a-zA-Z0-9]/-}"
  printf '%s/projects/%s' "$(gl_store_config_dir)" "${slug:-unresolved-root}"
}

gl_store_config_dir() {
  local own parent a b c key
  gr_config_dir own
  own="${own%/}"
  parent="${own%/*}"
  [[ "$parent" == "$own" ]] && parent="."
  [[ -z "$parent" ]] && parent="/"
  a="${WFC_CLAUDE_CONFIG_A:-${parent%/}/.claude}"
  b="${WFC_CLAUDE_CONFIG_B:-${parent%/}/.claude2}"
  c="${WFC_CLAUDE_CONFIG_C:-${parent%/}/.claude3}"
  key="$(gl_dir_key "$own")"
  if [[ "$key" == "$(gl_dir_key "$a")" || "$key" == "$(gl_dir_key "$b")" ||
  "$key" == "$(gl_dir_key "$c")" ]]; then
    printf '%s' "$a"
  else
    printf '%s' "$own"
  fi
}

gl_dir_key() {
  (cd -P -- "$1" 2>/dev/null && pwd -P) || printf '%s' "${1%/}"
}

# gl_log <reason> [<detail>] — record a fail-open and RETURN, for a guard that
# carries on judging the rest of the command. Never fails the caller: a log that
# cannot be written must not turn a fail-open into a crash.
gl_log() {
  local dir what detail=""
  what="${1//[$'\t\r\n']/ }"
  [[ -n "${2-}" ]] && detail=$'\t'"${2//[$'\t\r\n']/ }"
  dir="$(gl_project_dir "$(gr_root)")"
  mkdir -p "$dir" 2>/dev/null
  printf '%s\t%s\t%s%s\n' "$(gl_when)" "$(gl_where)" "$what" "$detail" \
    >>"$dir/guard-errors.log" 2>/dev/null
  return 0
}
