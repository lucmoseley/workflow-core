#!/usr/bin/env bash
# script-path.sh — the bash twin of scripts/lib/script-path.js (#343). Read
# that file's header for why a message names a core script through this rather
# than as a bare `scripts/x`; keep the two in step.
#
#   source "$here/lib/script-path.sh"
#   script_path session-arbiter.js          # → scripts/… or <plugin root>/scripts/…
#   doc_path agents/issue-tracker.md        # → docs/… or <plugin root>/docs/… (#1010)
#   printf '%s' "$text" | resolve_script_paths
#   printf '%s' "$text" | expand_paste_paths "$host"
#
# No dependencies, so rule-text.sh can source it.

# The core root this file sits in, resolved once at source (#653). `.` where
# sourced by a bare name, as dirname would answer. -P: physical, as Node's
# __dirname is.
_sp_here="${BASH_SOURCE[0]%/*}"
[[ "$_sp_here" == "${BASH_SOURCE[0]}" ]] && _sp_here=.
_SP_CORE_ROOT="$(CDPATH='' cd -P -- "$_sp_here/../.." && pwd)"
unset _sp_here

# The core root into the variable named $1 — WFC_SCRIPT_ROOT (tests only) over
# the resolved one, read per call so a test can set it per case. A nameref,
# not `$(sp_core_root)`, so no reader forks.
_sp_root_into() {
  local -n _sp_root="$1"
  _sp_root="${WFC_SCRIPT_ROOT:-$_SP_CORE_ROOT}"
}

# The core root — coreRoot() in the JS twin.
sp_core_root() {
  local root
  _sp_root_into root
  printf '%s' "$root"
}

# stdin into the variable named $1, trailing newlines dropped as `$(cat)` would
# drop them — without the fork. Unlike `$(cat)`, it stops at a NUL byte.
_sp_read_stdin() {
  local -n _sp_into="$1"
  IFS= read -r -d '' _sp_into || true
  _sp_into="${_sp_into%"${_sp_into##*[!$'\n']}"}"
}

# Quoted for a shell only where it needs it — sh-quote.js's shellQuote.
sp_shell_word() {
  local LC_ALL=C
  if [[ "$1" =~ ^[A-Za-z0-9_@%+=:,./~-]+$ && "$1" != "~"* && "$1" != *[=:]"~"* ]]; then
    printf '%s' "$1"
  else
    printf "'%s'" "${1//\'/\'\\\'\'}"
  fi
}

# The core runs from a source checkout rather than an install — inCheckout().
sp_in_checkout() {
  local root
  _sp_root_into root
  [[ -f "$root/package.json" ]]
}

script_path() {
  local root
  _sp_root_into root
  if sp_in_checkout; then
    printf 'scripts/%s' "$1"
  else
    sp_shell_word "$root/scripts/$1"
  fi
}

doc_path() {
  local root
  _sp_root_into root
  if sp_in_checkout; then
    printf 'docs/%s' "$1"
  else
    sp_shell_word "$root/docs/$1"
  fi
}

# stdin with every `scripts/x` and `docs/x` naming a file the core holds
# spelled at the plugin root in an install — resolveScriptPaths() in the JS
# twin, match for match: the same left edge, the same trailing full stops left
# outside the name. Trailing newlines are dropped, as the rule-text accessors
# do anyway.
resolve_script_paths() {
  local LC_ALL=C text root out='' pre edge dot dir rest name
  _sp_read_stdin text
  _sp_root_into root
  if sp_in_checkout; then
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
    if [[ -n "$name" && -e "$root/$dir/$name" ]]; then
      out+="$(sp_shell_word "$root/$dir/$name")${rest:${#name}}"
    else
      out+="${dot}$dir/$rest"
    fi
    text="${text:$((${#pre} + ${#BASH_REMATCH[0]}))}"
  done
  printf '%s' "$out$text"
}

# stdin with `{host-root}` and `{script:x}` spelt absolute — expandPastePaths()
# in the JS twin (#643). One pass, so a placeholder inside a root it expands to
# is never expanded again (#2613). Trailing newlines are dropped.
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
