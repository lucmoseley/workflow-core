#!/usr/bin/env bash
_sp_here="${BASH_SOURCE[0]%/*}"
[[ "$_sp_here" == "${BASH_SOURCE[0]}" ]] && _sp_here=.
_SP_CORE_ROOT="$(CDPATH='' cd -P -- "$_sp_here/../.." && pwd)"
unset _sp_here
_SP_HOST_OWNED=$'\n'"$(<"$_SP_CORE_ROOT/scripts/lib/host-owned-paths.txt")"$'\n'

_sp_root_into() {
  local -n _sp_root="$1"
  _sp_root="${WFC_SCRIPT_ROOT:-$_SP_CORE_ROOT}"
}

sp_core_root() {
  local root
  _sp_root_into root
  printf '%s' "$root"
}

_sp_read_stdin() {
  local -n _sp_into="$1"
  IFS= read -r -d '' _sp_into || true
  _sp_into="${_sp_into%"${_sp_into##*[!$'\n']}"}"
}

sp_shell_word() {
  local LC_ALL=C
  if [[ "$1" =~ ^[A-Za-z0-9_@%+=:,./~-]+$ && "$1" != "~"* && "$1" != *[=:]"~"* ]]; then
    printf '%s' "$1"
  else
    printf "'%s'" "${1//\'/\'\\\'\'}"
  fi
}

_sp_git_dir_common() {
  local git_dir="$1" common
  common="$git_dir"
  if [[ -f "$git_dir/commondir" ]]; then
    IFS= read -r common <"$git_dir/commondir" || [[ -n "$common" ]] || return 1
    [[ "$common" == /* ]] || common="$git_dir/$common"
  fi
  CDPATH='' cd -P -- "$common" 2>/dev/null && pwd
}

_sp_repo_common() {
  local dir="$1" line
  while :; do
    if [[ -d "$dir/.git" ]]; then
      printf '%s\n' "$dir"
      _sp_git_dir_common "$dir/.git"
      return
    fi
    if [[ -f "$dir/.git" ]]; then
      IFS= read -r line <"$dir/.git" || [[ -n "$line" ]] || return 1
      [[ "$line" == "gitdir: "* ]] || return 1
      line="${line#gitdir: }"
      [[ "$line" == /* ]] || line="$dir/$line"
      printf '%s\n' "$dir"
      _sp_git_dir_common "$line"
      return
    fi
    [[ -n "$dir" && "$dir" != / ]] || return 1
    dir="${dir%/*}"
  done
}

# workflow-core#5584
sp_in_core_repo() {
  local root own here git_dir
  _sp_root_into root
  [[ -f "$root/package.json" ]] || return 1
  own="$(_sp_repo_common "$root")" || return 1
  [[ "${own%%$'\n'*}" == "$root" ]] || return 1
  if [[ -n "${GIT_DIR:-}" ]]; then
    git_dir="$GIT_DIR"
    [[ "$git_dir" == /* ]] || git_dir="$PWD/$git_dir"
    here="$(_sp_git_dir_common "$git_dir")" || return 1
  else
    here="$(_sp_repo_common "$PWD")" || return 1
    here="${here#*$'\n'}"
  fi
  [[ "${own#*$'\n'}" == "$here" ]]
}

script_path() {
  local root
  _sp_root_into root
  if sp_in_core_repo; then
    printf 'scripts/%s' "$1"
  else
    sp_shell_word "$root/scripts/$1"
  fi
}

doc_path() {
  local root
  _sp_root_into root
  if sp_in_core_repo; then
    printf 'docs/%s' "$1"
  else
    sp_shell_word "$root/docs/$1"
  fi
}

resolve_script_paths() {
  local LC_ALL=C text root out='' pre edge dot dir rest name
  _sp_read_stdin text
  _sp_root_into root
  if sp_in_core_repo; then
    printf '%s' "$text"
    return 0
  fi
  local re='(^|[^A-Za-z0-9_./$}-])(\./)?(scripts|docs)/([A-Za-z0-9_*.-][A-Za-z0-9_*./-]*)'
  while [[ "$text" =~ $re ]]; do
    edge="${BASH_REMATCH[1]}"
    dot="${BASH_REMATCH[2]}"
    dir="${BASH_REMATCH[3]}"
    rest="${BASH_REMATCH[4]}"
    pre="${text%%"${BASH_REMATCH[0]}"*}"
    name="${rest%"${rest##*[!.]}"}"
    out+="$pre$edge"
    if [[ -n "$name" && "$_SP_HOST_OWNED" != *$'\n'"$dir/$name"$'\n'* && -e "$root/$dir/$name" ]]; then
      out+="$(sp_shell_word "$root/$dir/$name")${rest:${#name}}"
    else
      out+="${dot}$dir/$rest"
    fi
    text="${text:$((${#pre} + ${#BASH_REMATCH[0]}))}"
  done
  printf '%s' "$out$text"
}

expand_paste_paths() {
  local LC_ALL=C text out='' pre host root
  _sp_read_stdin text
  _sp_root_into root
  host="$(sp_shell_word "$1")"
  local re='\{(host-root|script:([A-Za-z0-9_./-]+))\}'
  while [[ "$text" =~ $re ]]; do
    pre="${text%%"${BASH_REMATCH[0]}"*}"
    if [[ "${BASH_REMATCH[1]}" == host-root ]]; then
      out+="$pre$host"
    else
      out+="$pre$(sp_shell_word "$root/scripts/${BASH_REMATCH[2]}")"
    fi
    text="${text:$((${#pre} + ${#BASH_REMATCH[0]}))}"
  done
  printf '%s' "$out$text"
}
