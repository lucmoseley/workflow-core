#!/usr/bin/env bash
# lib/paste-self-match.sh — the judging half of guard-paste-self-match.js (#921): given one `!` paste
# block the agent is handing the founder, name every `pgrep -f`/`pkill -f` in it
# whose pattern matches the block's own text — or, under `-v`, misses it (#1814)
# — and every `pgrep`/`pkill` without `-f` whose pattern matches the shell's
# name, `bash`, or under `-v` misses it (#1842).
#
# Why that is the whole condition: a `!` line runs as one shell whose command
# line is the pasted text, and `-f` matches full command lines — so a pattern
# that matches the paste matches the founder's own shell, and `-v`, selecting
# every process the pattern misses, selects that shell when it misses. Without
# `-f` the pattern is tested against process names instead, the same way.
#
# INPUT: a hook-shaped payload on stdin, `{"tool_input":{"command":<block>}}`,
# so the shared parser (lib/guard-parse.sh, mantahostels#123) reads it exactly as it reads
# a Bash tool call — the same segment split and flag reader guard-self-match.sh
# uses on the agent's own commands.
#
# OUTPUT: one line per finding, tab-separated — `kill` or `read`, the segment
# as written, the pattern, `matches` or `misses`, and what it was tested
# against: `paste` or `name`. Nothing at all where the block is clean.
#
# PASSES, as guard-self-match.sh does: a segment naming `$$` or `$PPID`, unless
# inverted, which naming the shell never spares. Per
# segment here, not per command, since a paste is longer than a tool call. Also
# `-A`, which spares pkill's ancestors — the founder's shell among them. Under
# `-x` the pattern must match the whole paste, so it is tested anchored.
#
# FAILS OPEN, logged through lib/guard-log.sh: an unreadable payload, a pattern
# carrying an expansion it cannot read, and a pattern that does not compile as
# an extended regex. Bash's `=~` compiles with the same POSIX regcomp pgrep
# uses, so a compile failure here is one there too.
#
# LIMITS
#  - The command line pgrep sees may differ from the paste by however the
#    harness wraps a `!` command; the paste text is the subject, as #921 rules.
#    A pattern aimed at the wrapper's words (`[b]ash`) therefore passes, and
#    under `-v` is refused though its match spares the shell. The shell's name
#    is taken to be `bash`, the Bash tool's, which a `!` command shares.
#  - A `-v` pattern that spares the shell still selects the harness and nearly
#    everything else; only the shell is judged.
#  - A pattern reached through a wrapper (`sudo pkill`, `xargs pkill`) is not
#    seen: only a segment's own command word is read, as in guard-self-match.sh.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/guard-log.sh" 2>/dev/null
# shellcheck source=scripts/lib/guard-parse.sh
source "$here/guard-parse.sh" 2>/dev/null
# shellcheck source=scripts/lib/pgrep-args.sh
source "$here/pgrep-args.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — paste allowed unchecked"
  exit 0
}
declare -F pga_read >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/pgrep-args.sh did not load — paste allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' paste
whole="$(gp_subject)"

judge() {
  local segment="$1" cmd="$2"
  shift 2
  # shellcheck disable=SC2034 # icase, exact: pga_read sets them, pga_selects reads them
  local full=0 icase=0 exact=0 invert=0 ancestors=0 pattern="" literal written verdict rc relation against

  # A shell keyword is not a wrapper, as in guard-self-match.sh.
  while :; do
    case "$cmd" in
      while | until | if | elif | then | else | do | '!' | '{' | '(')
        (($# == 0)) && return 0
        cmd="$1"
        shift
        ;;
      *) break ;;
    esac
  done
  case "${cmd##*/}" in
    pgrep) verdict="read" ;;
    pkill) verdict="kill" ;;
    *) return 0 ;;
  esac

  pga_read "$@"
  ((!ancestors)) && [[ -n "$pattern" ]] || return 0

  written="$(gp_as_written "$segment")"
  case "$written" in
    *'$$'* | *'$PPID'*) ((invert)) || return 0 ;;
  esac

  if ! literal="$(gp_literal "$pattern")"; then
    gl_log "pattern carries an expansion — not judged" "$written"
    return 0
  fi

  if ((full)); then
    against="paste"
    pga_selects "$whole" "$literal"
  else
    against="name"
    pga_selects_shell_name "$literal"
  fi
  rc=$?
  case "$rc" in
    0) ;;
    1) return 0 ;;
    *)
      gl_log "pattern did not compile as a regex — not judged" "$literal"
      return 0
      ;;
  esac
  relation=matches
  ((invert)) && relation=misses

  # Tabs and newlines are the output's own delimiters.
  written="${written//[$'\t\n']/ }"
  literal="${literal//[$'\t\n']/ }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$verdict" "$written" "$literal" "$relation" "$against"
  return 0
}

gp_walk_commands judge
exit 0
