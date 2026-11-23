#!/usr/bin/env bash
# Usage:
#
#   source "$here/lib/rule-text.sh"; rule_text <id>   # a guard, splicing the text
#   scripts/lib/rule-text.sh <id> [<id>…]             # a session, reading stdout
#   scripts/lib/rule-text.sh --ids                    # every id, bare
#
# `rule_text` takes one id and RETURNS 1 on an unknown id, never exiting the
# caller. The CLI form takes a list: one id prints the bare fragment; two or
# more print each under a "## <id>" heading, blank-line separated, after every
# id resolves, and one unknown id refuses the lot with exit 1. An id may be
# bare or carry a leading `rule:`. `--ids` enumerates only as the sole or first
# argument. Text goes to stdout, a refusal to stderr.

_RT_HERE="${BASH_SOURCE[0]%/*}"
[[ "$_RT_HERE" == "${BASH_SOURCE[0]}" ]] && _RT_HERE=.

# shellcheck source=scripts/lib/guard-root.sh
source "$_RT_HERE/guard-root.sh"
# shellcheck source=scripts/lib/script-path.sh
source "$_RT_HERE/script-path.sh" 2>/dev/null

# #653
_RT_CORE_DIR="$(cd "$_RT_HERE/../.." && pwd)/docs/agents/rules"

# #1
rt_root() {
  gr_root
}

# #5
rt_dir() {
  if [[ -n "${WFC_RULES_DIR:-}" ]]; then
    rt_resolve "$WFC_RULES_DIR"
  elif [[ -d "$(rt_root)/docs/agents/rules" ]]; then
    rt_resolve "$(rt_root)/docs/agents/rules"
  else
    rt_core_dir
  fi
}

rt_resolve() {
  local p="$1" part
  local -a parts rt_out=()
  [[ "$p" == /* ]] || p="$PWD/$p"
  IFS=/ read -ra parts <<<"$p"
  for part in "${parts[@]}"; do
    case "$part" in
      '' | .) ;;
      ..) [[ ${#rt_out[@]} -gt 0 ]] && unset 'rt_out[${#rt_out[@]}-1]' ;;
      *) rt_out+=("$part") ;;
    esac
  done
  local IFS=/
  printf '/%s' "${rt_out[*]}"
}

rt_core_dir() {
  printf '%s' "$_RT_CORE_DIR"
}

rt_core_layer() {
  if [[ -n "${WFC_RULES_DIR:-}" ]]; then
    [[ -n "${WFC_RULES_FALLBACK_DIR:-}" ]] || return 0
    rt_resolve "$WFC_RULES_FALLBACK_DIR"
  else
    rt_resolve "$_RT_CORE_DIR"
  fi
}

# #97
rt_dirs() {
  local primary core
  primary="$(rt_dir)"
  printf '%s\n' "$primary"
  core="$(rt_core_layer)"
  [[ -n "$core" && "$core" != "$primary" ]] && printf '%s\n' "$core"
  return 0
}

# lucmoseley/mantahostels#103
rule_ids() {
  local dir f id
  local -a ids=()
  while IFS= read -r dir; do
    [[ -e "$dir" ]] || continue
    if [[ ! -d "$dir" || ! -r "$dir" || ! -x "$dir" ]]; then
      printf 'rule-text: cannot read the store %s.\n' "$dir" >&2
      return 1
    fi
    for f in "$dir"/*.txt; do
      [[ -f "$f" ]] || continue
      id="$(basename "$f" .txt)"
      [[ "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || continue
      ids+=("$id")
    done
  done < <(rt_dirs)
  [[ ${#ids[@]} -gt 0 ]] || return 0
  printf '%s\n' "${ids[@]}" | LC_ALL=C sort -u
}

rt_bare_id() {
  printf '%s' "${1#rule:}"
}

_rt_read() {
  local given="${1:-}" id dir file known
  layer=
  id="$(rt_bare_id "$given")"
  if [[ ! "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    printf 'rule-text: "%s" is not a rule id — ids are lowercase kebab-case.\n' \
      "$given" >&2
    return 1
  fi
  file="$(rt_dir)/$id.txt"
  while IFS= read -r dir; do
    if [[ -f "$dir/$id.txt" ]]; then
      file="$dir/$id.txt"
      layer="$dir"
      break
    fi
  done < <(rt_dirs)
  if [[ ! -f "$file" ]]; then
    known="$(rule_ids | paste -sd, - 2>/dev/null | sed 's/,/, /g')"
    known="${known:+Known ids: $known.}"
    printf 'rule-text: no fragment for rule id "%s" (looked in %s). %s\n' \
      "$id" "$(rt_dirs | paste -sd, - | sed 's/,/, /g')" \
      "${known:-The store holds no fragments.}" >&2
    return 1
  fi
  body="$(<"$file")"
  if [[ -z "${body//[[:space:]]/}" ]]; then
    printf 'rule-text: the fragment for rule id "%s" (%s) is empty. A guard printing it would deny a session and state no rule.\n' \
      "$id" "$file" >&2
    return 1
  fi
}

_RT_INCLUDE_RE='\{rule:([a-z0-9]+(-[a-z0-9]+)*)\}'
_rt_expand_includes() {
  local rest="$1" out='' pre whole inc body layer
  while [[ "$rest" =~ $_RT_INCLUDE_RE ]]; do
    whole="${BASH_REMATCH[0]}"
    inc="${BASH_REMATCH[1]}"
    _rt_read "$inc" || return 1
    if [[ "$body" == *"{rule:"* ]]; then
      printf 'rule-text: the fragment for rule id "%s" is included by another and holds an include of its own.\n' \
        "$inc" >&2
      return 1
    fi
    pre="${rest%%"$whole"*}"
    out+="$pre$body"
    rest="${rest:$((${#pre} + ${#whole}))}"
  done
  printf '%s' "$out$rest"
}

# Print the operative text of rule $1.
rule_text() {
  local body layer
  _rt_read "${1:-}" || return 1
  if [[ "$body" == *"{rule:"* ]]; then
    body="$(_rt_expand_includes "$body")" || return 1
  fi
  # #343
  local text="$body"
  if declare -F resolve_script_paths >/dev/null; then
    text="$(printf '%s' "$body" | resolve_script_paths | expand_paste_paths "$(rt_root)")"
  fi
  # #416
  local qualified
  if declare -F sp_in_core_repo >/dev/null && ! sp_in_core_repo &&
    [[ "$layer" == "$(rt_core_layer)" ]] &&
    qualified="$(printf '%s' "$text" |
      node "$_RT_HERE/qualify-citations.js" 2>/dev/null)"; then
    text="$qualified"
  fi
  [[ "$text" != *"{command:"* ]] || text="$(_rt_expand_commands "$text")"
  printf '%s' "$text"
}

# #3439
rule_or_path() {
  local text where
  text="$(rule_text "$1" 2>/dev/null)"
  if [[ -n "$text" ]]; then
    printf '%s' "$text"
    return
  fi
  declare -F gl_log >/dev/null && gl_log "rule:$1 unreadable — nag printed its path instead"
  where="$(doc_path "agents/rules/$1.txt" 2>/dev/null)" || where="docs/agents/rules/$1.txt"
  printf '%s %s%s' "$2" "$where" "$3"
}

# #742
_RT_COMMAND_RE='\{command:([a-z_]+)\}'
_rt_expand_commands() {
  if ! declare -F wfc_command >/dev/null 2>&1; then
    # shellcheck source=scripts/lib/wfc-config.sh
    source "$_RT_HERE/wfc-config.sh" 2>/dev/null || true
  fi
  local line rest pre cmd done_part out='' sep=''
  while IFS= read -r line; do
    rest="$line"
    done_part=''
    while [[ "$rest" =~ $_RT_COMMAND_RE ]]; do
      pre="${rest%%"${BASH_REMATCH[0]}"*}"
      if ! cmd="$(wfc_command "${BASH_REMATCH[1]}")"; then
        continue 2
      fi
      done_part+="$pre$cmd"
      rest="${rest:$((${#pre} + ${#BASH_REMATCH[0]}))}"
    done
    out+="$sep$done_part$rest"
    sep=$'\n'
  done <<<"$1"
  printf '%s' "$out"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  if [[ "${1:-}" == "--ids" ]]; then
    rule_ids
    exit 0
  fi
  if [[ $# -eq 0 ]]; then
    printf 'usage: rule-text.sh <rule-id> [<rule-id>…] | --ids\n' >&2
    exit 2
  fi
  if [[ $# -eq 1 ]]; then
    rule_text "$1" || exit 1
    printf '\n'
    exit 0
  fi
  ids=("$@")
  bodies=()
  for id in "${ids[@]}"; do
    body="$(rule_text "$id")" || exit 1
    bodies+=("$body")
  done
  for i in "${!ids[@]}"; do
    [[ $i -eq 0 ]] || printf '\n'
    printf '## %s\n\n%s\n' "$(rt_bare_id "${ids[$i]}")" "${bodies[$i]}"
  done
fi
