#!/usr/bin/env bash
gr_root() {
  local root real out ask=
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    root="$CLAUDE_PROJECT_DIR"
    [[ -f "$root/.git" ]] && ask="$root"
  else
    root="$PWD"
    ask=.
  fi
  if [[ -n "$ask" ]] && out="$(git -C "$ask" rev-parse --path-format=absolute --show-toplevel --git-common-dir 2>/dev/null)"; then
    root="${out%%$'\n'*}"
    out="${out#*$'\n'}"
    if [[ "${out##*/}" == .git ]]; then
      root="${out%/*}"
      [[ -n "$root" ]] || root=/
    fi
  fi
  [[ "$root" == / ]] || root="${root%/}"
  real="$(gr_physical "$root")" && root="$real"
  printf '%s' "$root"
}

gr_session_tree() {
  local dir="$PWD" top real
  [[ "${1-}" == /* ]] && dir="$1"
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" && [[ -n "$top" ]] || return 1
  real="$(gr_physical "$top")" && top="$real"
  printf '%s' "$top"
}

gr_worktree_root() {
  local host top mine theirs
  host="$(gr_root)"
  if top="$(gr_session_tree "$PWD")" && [[ "$top" != "$host" ]] &&
    mine="$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    theirs="$(git -C "$host" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    [[ -n "$mine" && "$mine" == "$theirs" ]]; then
    printf '%s' "$top"
  else
    printf '%s' "$host"
  fi
}

gr_physical() {
  CDPATH='' cd -P -- "$1" >/dev/null 2>&1 && printf '%s' "$PWD"
}

gr_config_dir() {
  if [[ -n "${CLAUDE_CONFIG_DIR+set}" ]]; then
    printf -v "$1" '%s' "${CLAUDE_CONFIG_DIR:-.}"
  elif [[ -n "${HOME+set}" ]]; then
    printf -v "$1" '%s' "${HOME:+$HOME/}.claude"
  else
    printf -v "$1" '%s' ~/.claude
  fi
}
