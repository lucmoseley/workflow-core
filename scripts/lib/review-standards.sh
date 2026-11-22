#!/usr/bin/env bash
_rs_here="${BASH_SOURCE[0]%/*}"
[[ "$_rs_here" == "${BASH_SOURCE[0]}" ]] && _rs_here=.
if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$_rs_here/guard-root.sh"
fi
if ! declare -F sp_core_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/script-path.sh
  source "$_rs_here/script-path.sh"
fi

review_standards_base() {
  local root
  root="$(sp_core_root 2>/dev/null)"
  [[ -n "$root" ]] || return 1
  printf '%s/docs/code-standards-base.md' "$root"
}

review_standards_glossary() {
  declare -F gr_root >/dev/null 2>&1 || return 1
  local glossary
  glossary="$(gr_root)/GLOSSARY.md"
  [[ -f "$glossary" ]] || return 1
  printf '%s' "$glossary"
}

review_standards_shown() {
  local root=""
  declare -F gr_root >/dev/null 2>&1 && root="$(gr_root)"
  if [[ -n "$root" && "$1" == "$root"/* ]]; then
    printf '%s' "${1#"$root"/}"
  else
    printf '%s' "$1"
  fi
}

review_standards_base_shown() {
  local base
  base="$(review_standards_base)" || return 1
  review_standards_shown "$base"
}

review_standards_glossary_line() {
  local glossary
  glossary="$(review_standards_glossary)" || return 1
  printf ' Hand the Standards axis `%s` too, for base §G8.' "$(review_standards_shown "$glossary")"
}

review_standards_state() {
  declare -F gr_root >/dev/null 2>&1 || return 1
  local base_path base=0 local_file=0
  base_path="$(review_standards_base)" || return 1
  [[ -f "$base_path" ]] && base=1
  [[ -f "$(gr_root)/docs/code-standards.md" ]] && local_file=1
  case "$base$local_file" in
    11) printf 'both' ;;
    10) printf 'base' ;;
    01) printf 'local' ;;
    *) printf 'neither' ;;
  esac
}

review_standards_log_missing_base() {
  local base_path what
  if ! base_path="$(review_standards_base)"; then
    what="standards core root unresolved — Standards axis handed both standards files unchecked"
  elif [[ ! -f "$base_path" ]]; then
    what="standards base absent — Standards axis reviewed without it"
  else
    return 0
  fi
  if ! declare -F gl_log >/dev/null 2>&1; then
    # shellcheck source=scripts/lib/guard-log.sh
    source "$_rs_here/guard-log.sh" 2>/dev/null || return 0
  fi
  gl_log "$what" "$base_path"
}
