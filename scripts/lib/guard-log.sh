#!/usr/bin/env bash
# The shared fail-open record for the bash hooks and gates (mantahostels#147).
#
# SOURCED, NEVER RUN. It defines functions and reaches no verdict of its own.
#
# Why it exists: every hook here FAILS OPEN (mantahostels#103 §6) — a missing jq, a payload
# it cannot parse, a library it cannot read all ALLOW the action rather than
# wedge 10-12 concurrent sessions. A silently broken hook then looks exactly
# like a hook finding nothing wrong.
#
# THE RECORD, one line, three or four tab-separated fields, append-only:
#
#   <ISO 8601 UTC>\t<guard script name>\t<what was allowed unchecked>[\t<detail>]
#
# Field 2 is derived from $0, not written by hand, so a renamed guard cannot go
# on logging under its old name. Field 3 is prose for a human: say what was
# allowed through, not only what broke. KEEP IT CONSTANT per fault:
# check-guard-errors.js groups on it, so a path in it splits one burst into as
# many groups as it has records. The varying part goes in field 4, optional.
#
# WHERE IT LANDS must equal session-arbiter.js's errorLog() byte for byte —
# storeConfigDir()/projects/<repo root with every non-alphanumeric to a dash>, the
# first seat's config dir for a session on any seat (#383). That
# derivation happens in bash here and in node there, and drift puts every
# fail-open in a directory check-guard-errors.js never reads. WITH NO ROOT TO
# SLUG there is no project to file under, and those records go to a fixed
# `projects/unresolved-root/` that the same check reads separately (mantahostels#2438).
#
# EQUAL ON EVERY PATH THIS REPO PRODUCES, not unconditionally (mantahostels#2096): the two
# transforms still part on a character OUTSIDE THE BMP, where bash counts one
# character and project-slug.js's UTF-16 `String.replace` counts a surrogate
# pair and emits two hyphens. Accepted as residual rather than fixed — matching
# it needs a code-point walk in bash on the one path forbidden to fork node, for
# an input class no checkout here has.
#
# ITS OWN FAILURE IS SILENT: an unwritable log cannot report that it is
# unwritable, and logging never blocks the verdict. check-guard-errors.js probes
# that this file is readable at all.

# The repo root, in the one spelling the whole guard tier uses (mantahostels#1905). ITS OWN
# FILE, below this one: this library is itself a call site, so a copy here would
# be unreachable from anything that loads without it.
# Parameter expansion, NOT `$(dirname …)`: this file is reached on the
# fail-open path, where the PATH has typically lost the binary that provoked the
# fault and often its neighbours with it — a fork here would resolve to
# `/guard-root.sh` and silently take the error log's directory with it.
# shellcheck source=scripts/lib/guard-root.sh
source "${BASH_SOURCE[0]%/*}/guard-root.sh" 2>/dev/null
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }
# #2095
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

# guess, #1622
: "${GL_DETAIL_MAX:=300}"

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
