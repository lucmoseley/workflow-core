#!/usr/bin/env bash
# The shared fail-open record for every PreToolUse guard (mantahostels#147).
#
# SOURCED, NEVER RUN. It defines functions and reaches no verdict of its own.
#
# Why it exists: every guard here FAILS OPEN (mantahostels#103 §6) — a missing jq, a payload
# it cannot parse, a library it cannot read all ALLOW the action rather than
# wedge 10-12 concurrent sessions. A silently broken guard then looks exactly
# like a guard finding nothing wrong.
#
# THE RECORD, one line, three or four tab-separated fields, append-only:
#
#   <ISO 8601 UTC>\t<guard script name>\t<what was allowed unchecked>[\t<detail>]
#
# Field 2 is derived from $0, not written by hand, so a renamed guard cannot go
# on logging under its old name. Field 3 is prose for a human: say what was
# allowed through, not only what broke. KEEP IT CONSTANT per fault:
# check-guard-errors.js groups on it, so a path in it splits one burst into as
# many groups as it has records. The varying part goes in field 4, optional,
# for guard-parse.sh's unresolved-tree record (workflow-core#320).
#
# WHERE IT LANDS must equal session-arbiter.js's errorLog() byte for byte —
# storeConfigDir()/projects/<repo root with every non-alphanumeric to a dash>, the
# first seat's config dir for a session on any seat (workflow-core#383). That
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
# THE SAME LOG TAKES A GUARD'S ABORT (workflow-core#1818): gl_arm_exit below sets an EXIT
# trap for the whole guard process.
#
# ITS OWN FAILURE IS SILENT: an unwritable log cannot report that it is
# unwritable, and logging never blocks the verdict. check-guard-errors.js probes
# that this file and lib/guard-parse.sh are readable at all.

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
# A COPY of guard-root.sh's gr_config_dir (workflow-core#2095), the one exception to that
# file's no-second-copy rule: a detached guard-log.sh must still file under the
# config dir (guard-log.test.ts's rootless case), where gr_root's stub may be
# empty. config-dir.test.ts holds the two equal.
declare -F gr_config_dir >/dev/null 2>&1 || gr_config_dir() {
  if [[ -n "${CLAUDE_CONFIG_DIR+set}" ]]; then
    printf -v "$1" '%s' "${CLAUDE_CONFIG_DIR:-.}"
  elif [[ -n "${HOME+set}" ]]; then
    printf -v "$1" '%s' "${HOME:+$HOME/}.claude"
  else
    printf -v "$1" '%s' ~/.claude
  fi
}

# gl_where — the logging guard's own script name.
#
# Parameter expansion, NOT basename: the faults most worth recording are the
# missing-binary ones, and a guard whose PATH has lost jq has generally lost
# basename with it.
gl_where() {
  local name="${0##*/}"
  # A guard sourced rather than executed, or run through stdin, has no useful $0.
  case "$name" in
    "" | bash | sh | -bash | -sh) printf 'guard' ;;
    *) printf '%s' "$name" ;;
  esac
}

# gl_when — the record's timestamp, whole seconds, UTC.
#
# printf's %()T is a BUILTIN (bash 4.2+), so this forks nothing and needs no
# external `date`. `date -u` remains the fallback.
gl_when() {
  local t=""
  TZ=UTC printf -v t '%(%Y-%m-%dT%H:%M:%S)T' -1 2>/dev/null
  case "$t" in
    [0-9][0-9][0-9][0-9]-*) printf '%s.000Z' "$t" ;;
    *) date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null ;;
  esac
}

# The bytes a caller keeps as gl_log's detail — a child's stderr, or the
# command text an abort died on: enough to locate it, never a whole stack
# trace. A guess, never measured.
# shellcheck disable=SC2034 # read by the callers that source this file
GL_DETAIL_MAX=300

# gl_project_dir <repo root> — the Claude project directory for that root.
# SHELL'S ONE SITE for the slug transform, which lib/project-slug-scan.test.ts pins:
# every other shell caller routes through here rather than restating the class.
# project-slug.js and project_slug.py are the same derivation in their own
# languages, and the test holds all three equal.
gl_project_dir() {
  local slug="$1"
  # The class below matches per BYTE under LC_ALL=C, so one multi-byte UTF-8
  # character would slug to one hyphen per byte where project-slug.js, walking
  # UTF-16, gives one — and a hook inherits whatever locale the harness hands it
  # (mantahostels#2096). Pinned for this function only, and named outright rather than
  # borrowed from $LANG, which a hook's environment may leave unset or set to a
  # non-UTF-8 value. Where C.UTF-8 is absent bash keeps the CALLER's locale, so
  # the divergence returns exactly where it already was, and it warns on stderr:
  # unsuppressed, unlike everything else here.
  local LC_ALL=C.UTF-8
  slug="${slug//[^a-zA-Z0-9]/-}"
  # An unresolved root — the stub above, left when guard-root.sh cannot be
  # sourced — slugs to the empty string, and `$root/projects/$slug` would then be
  # `projects/` ITSELF, a file beside the project directories that
  # check-guard-errors.js never opens (mantahostels#2438). Named instead.
  # The literal is project-slug.js's UNRESOLVED_ROOT_SLUG, restated because this
  # path cannot fork a node; guard-log.test.ts runs gl_log and asserts the
  # directory it creates, which is what pins the two equal.
  printf '%s/projects/%s' "$(gl_store_config_dir)" "${slug:-unresolved-root}"
}

# gl_store_config_dir — arbiter-core.js's storeConfigDir(): the first seat,
# where this session's config dir is one of the three; the config dir itself
# where it is none. Seats compare by `pwd -P`, realpath's spelling, falling back
# to the literal path as deref.js's realKey() does. Subshells, no
# exec: `dirname` could be missing.
# The three names restate arbiter-core.js's DEFAULT_CONFIG_DIR_NAMES;
# guard-log.test.ts's seat cases pin the two equal, with WFC_CLAUDE_CONFIG_*
# unset only.
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
  # Tabs and newlines are the record's own delimiters, and a reason routinely
  # carries a path straight off the tool payload — so a file named with a newline
  # would append a second, forged record, and one with a tab would shift every
  # field. Collapsed to spaces, as arbiter-store.js's flat() does for the same log.
  what="${1//[$'\t\r\n']/ }"
  # Field 4 only when a caller passes a non-empty one, so every other record
  # stays three fields. Its \x01 is guard-parse.sh's quote sentinel, never
  # written out.
  [[ -n "${2-}" ]] && {
    detail="${2//[$'\t\r\n']/ }"
    detail=$'\t'"${detail//$'\x01'/}"
  }
  dir="$(gl_project_dir "$(gr_root)")"
  # Not `mkdir && printf`: the directory usually exists already, and chaining
  # them drops the record whenever mkdir is the binary that has gone missing.
  mkdir -p "$dir" 2>/dev/null
  printf '%s\t%s\t%s%s\n' "$(gl_when)" "$(gl_where)" "$what" "$detail" \
    >>"$dir/guard-errors.log" 2>/dev/null
  return 0
}

# gl_open <reason> — record a fail-open and ALLOW, for a fault that ends the
# guard's run. Exits 0: a hook's non-zero exit is read by Claude Code as the hook
# itself being broken, which is a different report from the one being made here.
gl_open() {
  gl_log "$1"
  exit 0
}

# gl_arm_exit — from here on, a non-zero exit by any path but gl_exit leaves a
# record (workflow-core#1818). The path it exists for is `set -u`'s abort on an unbound
# variable, which code-standards-base §S5 demands of every gate and which would
# otherwise reach stderr alone.
# guard-parse.sh's gp_adopt_payload arms it, so every guard reading its payload
# through gp_begin is covered.
#
# An EXIT trap the guard set before this call is kept and run after the record;
# one set after replaces the record, so a guard sets its own before gp_begin.
# One in a `$( … )` subshell is that subshell's alone and harmless.
gl_arm_exit() {
  [[ -z "${_gl_exit_armed-}" ]] || return 0
  _gl_exit_armed=1
  # `trap -p` prints `trap -- '<command>' EXIT`, quoted for eval.
  local prev
  local -a _gl_trap_words=()
  prev="$(trap -p EXIT)"
  _gl_prev_exit=""
  [[ -z "$prev" ]] || {
    eval "_gl_trap_words=($prev)"
    _gl_prev_exit="${_gl_trap_words[2]-}"
  }
  trap '_gl_on_exit "$?"' EXIT
}

# One reason for every status: exit 2 refuses the act and any other lets it
# through, but either way nothing judged it.
# BASH_COMMAND is the command text unexpanded, so no payload value reaches the log.
_gl_on_exit() {
  local rc="$1" at="${BASH_COMMAND-}"
  ((rc == 0)) || [[ -n "${_gl_own_exit-}" ]] ||
    gl_log "exited non-zero before a verdict — the act went unjudged" \
      "exit $rc at: ${at:0:GL_DETAIL_MAX}"
  [[ -n "${_gl_prev_exit-}" ]] || return 0
  # The guard's own status back in `$?`, without a fork, for a trap that reads it.
  _gl_status "$rc"
  eval "$_gl_prev_exit"
}

_gl_status() { return "$1"; }

# gl_exit <status> — exit non-zero as the guard's own verdict, which the record
# gl_arm_exit sets up then leaves alone. A guard refusing by exit 2 spells it
# `gl_exit 2`; a bare `exit 2` is recorded as an abort.
gl_exit() {
  _gl_own_exit=1
  exit "$1"
}
