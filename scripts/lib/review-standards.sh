#!/usr/bin/env bash
# review-standards.sh — which of the two standards files a review's Standards
# axis can be handed: the base at the resolved core root, and the host's own
# local file (workflow-core#886, workflow-core#965) — plus the host's GLOSSARY.md, where it has one
# (workflow-core#1373).
#
# SOURCED, NEVER RUN. Needs gr_root (lib/guard-root.sh) and sp_core_root
# (lib/script-path.sh).
#
# A caller (`grep -rlE '^\s*(source|\.) .*review-standards\.sh' scripts`)
# whose source of this file fails keeps its default text.
#
# THE BASE IS FOUND THROUGH sp_core_root, NEVER $WFC_PLUGIN_ROOT, which only a
# husky hook sets. sp_core_root is resolved with `cd -P`, so in an adopter the
# path handed over is the physical plugin-cache path that workflow-core#711's machine-local
# Read rule names, never a ~/.claude2 or ~/.claude3 symlink spelling.
if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$(dirname "${BASH_SOURCE[0]}")/guard-root.sh"
fi
if ! declare -F sp_core_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/script-path.sh
  source "$(dirname "${BASH_SOURCE[0]}")/script-path.sh"
fi

# The base's absolute path, whether or not it exists. With the core root
# unresolved it prints nothing and fails, so a caller keeps its default path.
review_standards_base() {
  local root
  root="$(sp_core_root 2>/dev/null)"
  [[ -n "$root" ]] || return 1
  printf '%s/docs/code-standards-base.md' "$root"
}

# The host's GLOSSARY.md, whose terms base §G8 binds names to. Absent, or with
# the host root unresolved, it prints nothing and fails.
review_standards_glossary() {
  declare -F gr_root >/dev/null 2>&1 || return 1
  local glossary
  glossary="$(gr_root)/GLOSSARY.md"
  [[ -f "$glossary" ]] || return 1
  printf '%s' "$glossary"
}

# $1 as a session is handed it: relative to the host root where it sits under
# it, so the checkout's path costs no bytes against GP_RULE_CAP (workflow-core#1729), and
# whole where it does not, as an adopter's base in its plugin cache.
review_standards_shown() {
  local root=""
  declare -F gr_root >/dev/null 2>&1 && root="$(gr_root)"
  if [[ -n "$root" && "$1" == "$root"/* ]]; then
    printf '%s' "${1#"$root"/}"
  else
    printf '%s' "$1"
  fi
}

# The base as a session is handed it. With the core root unresolved it prints
# nothing and fails, so a caller keeps its own default.
review_standards_base_shown() {
  local base
  base="$(review_standards_base)" || return 1
  review_standards_shown "$base"
}

# The sentence handing the Standards axis that glossary, with a leading space,
# or nothing and a failure where the host has none. inject-tracker-docs.sh
# spells it out instead, so check-context-budget.js can measure it.
review_standards_glossary_line() {
  local glossary
  glossary="$(review_standards_glossary)" || return 1
  printf ' Hand the Standards axis `%s` too, for base §G8.' "$(review_standards_shown "$glossary")"
}

# One of `both`, `base`, `local` or `neither`: which files exist.
review_standards_state() {
  # Unresolved, the host root is empty and every host would read as lacking
  # the local file.
  declare -F gr_root >/dev/null 2>&1 || return 1
  # Unresolved, the core root is empty and the base would read as absent.
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

# Record a review run without the base, where it is absent or its root is
# unresolved. It fails open. Call it only where the standards text is actually
# handed over, not on every run of a route.
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
    source "$(dirname "${BASH_SOURCE[0]}")/guard-log.sh" 2>/dev/null || return 0
  fi
  gl_log "$what" "$base_path"
}
