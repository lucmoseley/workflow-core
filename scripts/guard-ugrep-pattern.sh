#!/usr/bin/env bash
# PreToolUse guard: warn a session whose `grep` pattern carries a bounded repeat
# that `grep` here is Claude Code's bundled ugrep, which can refuse such a
# pattern, and that exit status 2 then means a refused pattern, not "no match"
# (workflow-core#1021).
#
# WHY. `grep` in the Bash tool is a shell function that execs ugrep (`type
# grep`). Whether ugrep refuses depends on the repeat sizes (workflow-core#1021 carries the
# measurements), so any ranged repeat is warned on.
#
# WARN, NOT DENY (workflow-core#1021 Q1): the pattern often works, and only the exit status
# tells the session which happened.
#
# Its `if: Bash(grep *)` narrowing is anchored on purpose: only a bare `grep` is
# the function, and every wrapper the unanchored form would admit — `xargs
# grep`, `command grep`, `timeout 5 grep` — execs GNU grep instead. Not folded
# into guard-recursive-dot-read.sh, the one Bash guard already reading `grep`:
# that one is exec'd on every Bash call, and this narrowing is what spares the
# rest.
#
# IMPLICIT: on a matching `grep` it injects one note as additionalContext and
#   writes a `.rule-injected-warn.ugrep-pattern-*` latch under .claude/tmp/markers.
# JUSTIFIED: fail-safe — the refusal is silent under a discarded stderr, so a
#   doc line alone would have to have been read beforehand (workflow-core#1021 Q1).
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
#   deleting the registration from self-plugin/hooks/hooks.json silences it.
#
# LIMITS
#  - The command word must be exactly `grep`. `egrep` and `fgrep` are
#    /usr/bin's GNU scripts here, and a path spelling is GNU grep too.
#  - `VAR=x grep …` is ugrep, and is judged, but the anchored `if` may not exec
#    the guard for it.
#  - The function hands a call to GNU grep when an argument matches its own
#    list (`-z`, `-Z`, `--null`, `--null-data`, `--config`, `--filter`, …);
#    that list is copied below from Claude Code 2.1.295 and drifts with it.
#  - A pattern is the first bare word, or every `-e`/`--regexp` value. A `-f`
#    pattern file is unread, and a pattern holding an unexpanded variable is
#    unjudged.
#  - Repeats read: ERE `{N,M}`/`{,M}`/`{N,}` where `-E` came after any `-G`,
#    else BRE `\{N,M\}`, the function passing `-G` first. An exact `{N}` is not
#    warned on alone, and a brace inside a bracket expression (`[{1,3}]`) is
#    warned on wrongly.
#  - A discarded stderr is read from this grep's own redirects: `2>/dev/null`,
#    `2>&-`, `&>/dev/null`, and `>/dev/null 2>&1`. Any other route to
#    /dev/null — a wrapping `{ …; } 2>/dev/null`, an `exec 2>` — warns without
#    the stderr sentence.
#  - `-P` anywhere passes, whatever order it takes with `-E`. `-F` passes.
#  - It warns once per (agent, session), so a second refused pattern goes
#    unwarned; a compaction clears the latch.
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording
#    through lib/guard-log.sh (mantahostels#147).

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

LATCH="ugrep-pattern"
gp_rule_told "$LATCH" && gp_allow

# Flags taking a value, read off ugrep's own `--help`. Its optional-value
# flags (`--group-separator[=SEP]`, `--config[=FILE]`) are absent: listed, they
# would eat the pattern.
UGREP_VALUE_FLAGS="-A -B -C -D -J -K -M -N -O -d -e -f -g -m -t --regexp --file --max-count --after-context --before-context --context --directories --devices --jobs --range --file-magic --neg-regexp --file-extension --file-type --glob --iglob --include --exclude --exclude-dir --exclude-from --include-dir --include-from --binary-files --and --andnot --not"

ERE_REPEAT='(^|[^\\])\{([0-9]+,[0-9]*|,[0-9]+)\}'
BRE_REPEAT='\\\{([0-9]+,[0-9]*|,[0-9]+)\\\}'

fires=0
# Some firing grep's stderr goes to /dev/null or is closed.
silenced=0

judge_word() {
  case "$1" in
    flag)
      case "$2" in
        -P | --perl-regexp) _perl=1 ;;
        -F | --fixed-strings) _fixed=1 ;;
        # The last of the two wins; -P and -F win from anywhere.
        -E | --extended-regexp) _ere=1 ;;
        -G | --basic-regexp) _ere=0 ;;
      esac
      ;;
    opt)
      case "$2" in
        -e | --regexp | --and | --andnot | --not)
          _by_flag=1
          _patterns+=("$3")
          ;;
        -f | --file) _by_flag=1 ;;
      esac
      ;;
    arg) _bare+=("$3") ;;
  esac
  return 0
}

judge() {
  shift
  local w lit seg_fires=0 null_out=0 i

  [[ "$(gp_literal "${1-}")" == grep ]] || return 0
  shift

  for w in "$@"; do
    lit="$(gp_literal "$w")" || continue
    # The function's own hand-off to GNU grep, as loose as the function's.
    case "$lit" in
      -*-filter* | -*-pager* | -*-view* | -*-format-open* | -*-config* | ---* | -@* | -[Zz]* | -[!-]*[Zz]* | --null | --null-data)
        return 0
        ;;
    esac
  done

  _perl=0 _fixed=0 _ere=0 _by_flag=0
  _patterns=() _bare=()
  gp_scan_flags "$UGREP_VALUE_FLAGS" judge_word -- "$@"
  ((_perl || _fixed)) && return 0
  ((_by_flag)) || { ((${#_bare[@]})) && _patterns=("${_bare[0]}"); }

  local p re="$BRE_REPEAT"
  ((_ere)) && re="$ERE_REPEAT"
  for p in ${_patterns[@]+"${_patterns[@]}"}; do
    lit="$(gp_literal "$p")" || continue
    [[ "$lit" =~ $re ]] && seg_fires=1
  done
  ((seg_fires)) || return 0
  fires=1

  # Read in the order written, as bash applies them: `>/dev/null 2>&1` discards
  # stderr, `2>&1 >/dev/null` keeps it.
  gp_redirects
  for i in "${!_gp_redir_kind[@]}"; do
    case "${_gp_redir_fd[i]}:${_gp_redir_kind[i]}:${_gp_redir_path[i]}" in
      '&:truncate:/dev/null' | '&:append:/dev/null') silenced=1 ;;
      2:truncate:/dev/null | 2:append:/dev/null | 2:close:*) silenced=1 ;;
      1:truncate:/dev/null | 1:append:/dev/null) null_out=1 ;;
      1:truncate:* | 1:append:*) null_out=0 ;;
      2:copy:*) ((null_out)) && [[ "${_gp_redir_target[i]}" == 1 ]] && silenced=1 ;;
    esac
  done
  return 0
}

gp_walk_commands judge

((fires)) || gp_allow

note="\`grep\` here is Claude Code's bundled ugrep, and a bounded repeat in its pattern — \`.{0,80}\`, say — can make it refuse the pattern with \`exceeds complexity limits\` or stall on a long line (workflow-core#1021). A refused pattern exits 2, not 1: exit 2 is no verdict, never \"no match\"."
((silenced)) &&
  note+=" This command discards stderr, which is what hides the refusal."
note+="

Re-spell it as the same command with \`-P\` in place of \`-E\`, or added where there is neither, every other flag kept and the backslashes taken off a \`\\{N,M\\}\`. A pattern of literals, \`.\`, bracket classes and bounded repeats prints what the refused command would have; an alternation, or a basic-mode \`( ) | + ?\`, can match differently under \`-P\`. Or use \`rg\` or python. Warned once a session; docs/agents/tool-output.md."

# Emit, THEN latch (mantahostels#2261): a hook cancelled at its timeout has its
# stdout discarded, and a latch written first would never let it retry.
gp_context "$note" || {
  gl_log "the warning did not render — this call allowed unwarned"
  exit 0
}
gp_rule_mark_told "$LATCH"
exit 0
