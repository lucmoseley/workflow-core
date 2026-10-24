#!/usr/bin/env bash
# PreToolUse guard: a git-hook escape is the founder's to set, never an agent's
# (workflow-core#916, applying mantahostels#109's "an escape a session can spell for itself is
# not a deny" to the git-hook escapes).
#
# THE HOLE IT CLOSES. Two pre-commit gates each stand down for one commit on an
# environment variable — WFC_ALLOW_BRANCH (.husky/pre-commit's shared-tree branch
# check) and WFC_ALLOW_GATE_INPUT_DELETE (scripts/lib/precommit-gate.sh).
# `WFC_ALLOW_NEW_PACKAGE` is guard-npm-install.sh's and out of scope.
#
# A DENY, NOT A WARN: an assignment of a named variable is a structured fact
# (mantahostels#103).
#
# WHAT IT REFUSES, read off gp_walk_commands' segments:
#  - a leading assignment of one (`WFC_ALLOW_BRANCH=1 git commit …`, `+=` too),
#    whatever the command;
#  - one carried by `env`, or standing after `sudo` and the other launchers
#    gp_unwrap strips (`sudo WFC_ALLOW_BRANCH=1 git …`);
#  - `export` naming one, with or without a value, and `declare`/`typeset` doing
#    so under an `x` flag.
# A mention is not an assignment: `grep -n WFC_ALLOW_BRANCH scripts/` passes, and
# a command naming an escape only inside quotes, over one line or several, is
# never judged at all.
#
# Narrowed to `if: Bash(*WFC_ALLOW_*)`: a command not carrying the prefix never
# execs this guard.
#
# LIMITS — lexical, and a Bash PreToolUse hook sees one command string:
#  - an assignment-only segment (`WFC_ALLOW_BRANCH=1; git commit …`) is skipped
#    by the walker. Unexported, it reaches no hook — unless `set -a` is on, or
#    an `export` of it on a LATER call, which is refused;
#  - an export made on an earlier Bash call persists, if the harness keeps the
#    shell's environment, and a later bare `git commit` carries it unseen;
#  - `sh -c "…"`, `bash -c "…"`, `eval`, a heredoc and a wrapper script all hide
#    the assignment inside a quoted span or another file;
#  - an UNQUOTED command-substitution value, `NAME=$(…) git commit`: the
#    splitter cuts the substitution out, and the walker never reaches the
#    assignment. The quoted `NAME="$(…)"` is refused;
#  - a variable set by a script the command runs, and anything typed outside
#    Claude Code, which is the founder's route by design.
# It FAILS OPEN on anything it cannot resolve, recorded via lib/guard-log.sh
# (mantahostels#103 §6, mantahostels#147). An unreadable rule fragment still
# denies, naming the file.
#
# IMPLICIT: it refuses any Bash command assigning or exporting one of the two
#   escapes, whatever the command runs.
# JUSTIFIED: fail-safe — a commit past a stood-down gate lands on the shared
#   `main`, and the escape exists for a judgement the founder makes.
# DEFEAT: the limits above; deleting the registration from self-plugin/hooks/hooks.json
#   (or, in an adopter, the plugin's hooks/hooks.json) silences it.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# The subject with every quoted span blanked, read quote-aware across newlines.
# The splitter masks a quoted span per line, so a single-quoted mention running
# over a line break — the founder's command written into `gh … --body '…'` —
# would otherwise reach judge() as live words and be refused.
unquoted_text() {
  local s="$1" out="" c q="" i n=${#1}
  for ((i = 0; i < n; i++)); do
    c="${s:i:1}"
    if [[ -n "$q" ]]; then
      # shellcheck disable=SC1003 # '\' is a literal backslash.
      [[ "$c" == '\' && "$q" == '"' ]] && ((i++))
      [[ "$c" == "$q" ]] && q=""
      out+=" "
      continue
    fi
    # shellcheck disable=SC1003 # the '\' arm is a literal backslash.
    case "$c" in
      "'" | '"') q="$c" out+=" " ;;
      '\')
        ((i++))
        out+=" "
        ;;
      *) out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

ESCAPE_NAMES='WFC_ALLOW_BRANCH|WFC_ALLOW_GATE_INPUT_DELETE'

# No escape name outside a quote: nothing here can set one.
[[ "$(unquoted_text "$(gp_subject)")" =~ (^|[^A-Za-z0-9_])($ESCAPE_NAMES)([^A-Za-z0-9_]|$) ]] ||
  gp_allow

ESCAPE_RULE_FALLBACK="A git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (workflow-core#916); the rule could not be read from docs/agents/rules/hook-escape.txt. Read that file before doing anything else."

# Whether one word assigns an escape (`NAME=…`, `NAME+=…`).
is_escape_assignment() { [[ "$1" =~ ^($ESCAPE_NAMES)\+?= ]]; }

# Whether one argument of `export`/`declare` names an escape, value or none.
is_escape_name() { [[ "$1" =~ ^($ESCAPE_NAMES)(\+?=|$) ]]; }

deny_escape() {
  gp_deny "This command sets a git-hook escape: @CMD@

$(gp_rule_text hook-escape "$ESCAPE_RULE_FALLBACK")" "$1"
}

# deny_leading <segment> <word>... — deny where an assignment among the words'
# leading run sets an escape.
deny_leading() {
  local segment="$1" w
  shift
  for w in "$@"; do
    [[ "$w" == [A-Za-z_]*=* ]] || return 0
    is_escape_assignment "$w" && deny_escape "$segment"
  done
}

judge() {
  local segment="$1" w exporting
  shift

  # The segment's own leading assignments, which the walker strips from "$@".
  for w in "${_gp_words[@]:0:_gp_assign_end}"; do
    is_escape_assignment "$w" && deny_escape "$segment"
  done
  # A word after `exec` is the command to shell, but `exec NAME=1 git …` is
  # refused all the same.
  deny_leading "$segment" "$@"

  gp_unwrap "$@"
  deny_leading "$segment" ${_gp_wrapper_words+"${_gp_wrapper_words[@]}"}
  ((${#_gp_unwrapped[@]})) || return 0
  # gp_unwrap stops on an assignment after `sudo` (`sudo NAME=1 cmd`), and on
  # one inside `env` whose value holds a `/` (`env PATH=/usr/bin NAME=1 cmd`),
  # reading it by basename.
  deny_leading "$segment" "${_gp_unwrapped[@]}"

  case "${_gp_unwrapped[0]##*/}" in
    export) exporting=1 ;;
    declare | typeset) exporting=0 ;;
    *) return 0 ;;
  esac
  for w in "${_gp_unwrapped[@]:1}"; do
    if [[ "$w" == -* ]]; then
      # `export -n` takes the export away.
      [[ "$w" == -*n* ]] && exporting=0
      [[ "$w" == -*x* ]] && exporting=1
      continue
    fi
    ((exporting)) && is_escape_name "$w" && deny_escape "$segment"
  done
  return 0
}

gp_walk_commands judge

gp_allow
