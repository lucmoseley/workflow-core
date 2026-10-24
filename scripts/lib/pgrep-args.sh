# shellcheck shell=bash
# lib/pgrep-args.sh — pga_read reads a pgrep/pkill's arguments as procps-ng
# does, into the caller's locals: full, icase, exact, invert and ancestors (0
# or 1), and pattern, the first bare word. The caller declares them.
# pga_selects then tests that pattern against a subject under those flags, and
# pga_selects_shell_name against the shell's name, for a call without -f.
#
# Sourced, never run, after lib/guard-parse.sh, whose gp_scan_flags it calls.

# The value-taking flags of procps-ng pgrep/pkill (`pkill --help`), so a value
# is never read as the pattern: `pkill -u lucmo -f x` has pattern x, not lucmo.
PGA_VALUE_FLAGS="-d -g -G -O -P -r -s -t -u -U -F -q --delimiter --pgroup --group --older --parent --runstates --session --terminal --euid --uid --pidfile --signal --ns --nslist --queue --cgroup --env"

# Whether a word is a signal spelled as an option — `-9`, `-STOP`, `-SIGTERM`
# — dropped before the flag read, as pkill drops it: walked letter by letter,
# `-STOP`'s P would read as `-P` swallowing the next word. `-F`, `-P` and the
# other capital flags name no signal in `kill -l`, so they are never dropped.
pga_is_signal_word() {
  [[ "$1" =~ ^-(SIG)?[A-Z][A-Z0-9+-]*$ || "$1" =~ ^-[0-9]+$ ]] &&
    kill -l "${1#-}" >/dev/null 2>&1
}

# shellcheck disable=SC2034 # every assignment is to a caller's local
_pga_match_arg() {
  case "$1:$2" in
    flag:-f | flag:--full) full=1 ;;
    flag:-i | flag:--ignore-case) icase=1 ;;
    flag:-x | flag:--exact) exact=1 ;;
    flag:-v | flag:--inverse) invert=1 ;;
    flag:-A | flag:--ignore-ancestors) ancestors=1 ;;
    arg:*) [[ -z "$pattern" ]] && pattern="$3" ;;
  esac
  return 0
}

pga_read() {
  local word
  local -a words=()
  for word in "$@"; do
    pga_is_signal_word "$word" || words+=("$word")
  done
  gp_scan_flags "$PGA_VALUE_FLAGS" _pga_match_arg -- ${words[@]+"${words[@]}"}
}

# The name a pgrep/pkill without -f tests its pattern against, for the shell
# running it: the Bash tool and a `!` paste both run under /bin/bash.
PGA_SHELL_NAME=bash

# Whether a pgrep/pkill reading $2 as its literal pattern, under the caller's
# exact, icase and invert, selects subject $1: 0 selected, 1 not, 2 where the
# pattern will not compile — so pgrep refuses it and kills nothing. Bash's `=~`
# compiles with the POSIX regcomp pgrep uses.
pga_selects() {
  local subject="$1" regex="$2" rc
  ((exact)) && regex="^($2)\$"
  ((icase)) && shopt -s nocasematch
  [[ "$subject" =~ $regex ]]
  rc=$?
  shopt -u nocasematch
  case "$rc:$invert" in
    0:0 | 1:1) return 0 ;;
    [01]:*) return 1 ;;
    *) return 2 ;;
  esac
}

# pga_selects for a pgrep/pkill without -f, whose subject is the shell's name.
pga_selects_shell_name() {
  pga_selects "$PGA_SHELL_NAME" "$1"
}
