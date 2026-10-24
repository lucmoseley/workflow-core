#!/usr/bin/env bash
# PreToolUse guard: a process pattern run through the Bash tool matches the
# shell running it.
#
# Why: the Bash tool executes every command as `/bin/bash -c '<command>'`, so
# the pattern is inside the calling shell's OWN argv. `pgrep -f X` and
# `pkill -f X` match against full command lines, so both find that shell
# wherever X matches the command's own text — which it does unless written not
# to: `'[n]ode'` searches for `node`, and the shell's argv holds `[n]ode`.
# Without `-f` the pattern is tested against process names, and that shell's
# is `bash`, so `pkill ba` finds it too (workflow-core#1842).
#
# UNDER `-v` THE HAZARD INVERTS (workflow-core#1847): an inverted pattern selects every
# process it misses — the harness and nearly everything else, and the shell
# wherever the pattern misses it — so the bracket recipe, which makes a
# pattern miss the shell, puts the shell in. Its text offers the pid recipe
# alone.
#
# A SECOND LIMB ON THE SAME HAZARD (mantahostels#2014): `ps ... | grep <pattern>`
# checking whether a background job is still alive. It self-matches its own
# searching shell exactly as `pgrep -f` does, and two more failures make a
# liveness check this way report a live job as gone:
#   - a `run_in_background` job's HARNESS TASK ID (the short id the tool
#     result names, e.g. `berl18qst`) is bookkeeping the harness keeps outside
#     the process — it appears in no process's own argv, so grepping for IT
#     specifically finds nothing even while the job runs; grepping for text
#     that genuinely is in the job's own command line still self-matches as
#     described above;
#   - the `grep -v grep` idiom, meant to hide the searching grep's own
#     self-match, silently drops a TRUE positive too whenever the target
#     process's own command line happens to contain the word "grep" — which a
#     liveness-polling loop's does, since it is usually built on `grep -q`.
# `docs/agents/verification.md`'s "Asserting that nothing of yours is still
# running" names `ps | grep` as the wrong check.
#
# A THIRD LIMB, ON A DIFFERENT HAZARD (workflow-core#2027): a Claude process count matched
# on `comm`, which for a backgrounded session is its version number, so it
# finds no session. Read where the command names `claude`: a `pgrep` without
# `-f` whose pattern selects `claude`, a `ps -C` naming it, a `ps` format
# listing a `comm` field and no `args` one, a plain `ps` whose default last
# column is `comm`, or a `/proc/*/comm` read. It hands
# over `rule:claude-process-count`, once a session.
#
# THE VERDICTS, split on mantahostels#103's rule — deny on a structured fact where the
# action has no legitimate use, warn where the guard is inferring:
#   - `pkill -f` is DENIED. It can kill the session, and killing by pid instead
#     is always available.
#   - `pgrep -f` is WARNED. Reading is harmless in itself; what it costs is a
#     wrong answer, and only the caller knows whether a self-match would
#     change the verdict it is about to draw.
#   - `ps | grep` is WARNED: one for something other than a liveness check is
#     ordinary and has no other tell.
#
# All three pass when the command carries `$$` or `$PPID`, which is a caller
# who has already thought about the self-match and excluded it — except an
# inverted pgrep/pkill, which naming the shell never spares — and where every
# pattern misses the command's own text (workflow-core#1782, workflow-core#1805). `pgrep`/`pkill` also
# pass under `-A`, which spares the calling shell as an ancestor.
#
# LIMITS
#  - `pgrep`/`pkill` reading matches the parsed command form — a segment whose
#    first word is `pgrep` or `pkill` — never a substring, so an echo or a
#    heredoc mentioning them passes. `killall` matches process NAMES rather
#    than command lines, so it does not self-match and is deliberately absent.
#  - A `-f` pattern is still judged a self-match under `-v`, which
#    lib/paste-self-match.sh tests inverted (workflow-core#1814), and when it is absent or
#    carries an expansion, and when it will not compile, and `-x` is read as a
#    substring match — each but the first erring towards a verdict where that
#    helper, which refuses a turn, errs towards passing. One
#    that misses the shell may still match its ancestors — the harness among
#    them — as a bare `pkill node` may; only `-A` spares those, and this guard
#    reads no hazard but the self-match.
#  - Without `-f`, a pattern is tested against `bash` alone, the Bash tool's
#    shell, so `pkill -v bash` passes though it kills the harness. One carrying
#    an expansion is judged selecting under `-v`, which nearly every pattern
#    is, and passing without; one that will not compile passes, as pgrep then
#    kills nothing. Selection by other criteria alone (`pkill -u lucmo`) is not
#    read.
#  - The `ps | grep` check is a RAW REGEX over the whole command text, not the
#    shared parser — it has no `-f`-shaped flag to key off, so there is no
#    structured fact to walk. It looks for `ps` (optionally flagged) piped
#    directly into `grep`, `egrep` or `fgrep`, immediately or after a shell
#    keyword (while/until/if/elif/then/else/do), `!`, `{`, a command
#    separator, or a newline. It does NOT see `ps` piped through an
#    intermediate command before `grep` (`ps -ef | awk '{print $2}' | grep x`).
#  - It stays SILENT where the shared walk finds each grep a `ps` feeds and
#    every pattern it reads misses the command's own text — as typed after
#    `/bin/bash -c`, and as `ps` prints each command's words — so the bracket
#    recipe (`grep '[n]ode'`, workflow-core#1782) passes. It still warns on a pattern from a
#    variable or a file, under `-v` or `-P`, a basic regex using a character an
#    extended one reads differently, and any grep it cannot find — a
#    `ps | grep` inside a quoted span among them.
#  - That subject, for both limbs, is the command, not the shell's whole argv:
#    the harness wraps it in a snapshot `source`, an `eval '…'` re-quoting each
#    `'`, and a cwd redirect, and `ps -ef` prints user and time columns beside
#    it. A pattern aimed at those words (`grep '[e]xtglob'`, `grep '[l]ucmo'`)
#    passes silently yet matches the searching shell. Accepted: the wrapper is the
#    harness's to change, and a pattern aimed at it is no liveness check.
#  - It reads the RAW subject, not the quote-masked text the shared parser
#    builds for `pgrep`/`pkill` — unlike that limb, a `ps | grep` shape written
#    inside a quoted string or heredoc body still warns here
#    (`echo "run: ps -ef | grep node"`). Accepted: a false positive on this
#    check costs a warn nobody has to act on, and masking would mean reaching
#    into the parser's private `_gp_mask_*` functions from outside their
#    module.
#  - A pattern reached through a wrapper (`xargs pkill`, `sudo pkill`) is not
#    seen: only a segment's own first word is read.
#  - The `$$`/`$PPID` exception is lexical and whole-command, so it clears every
#    uninverted pgrep/pkill in a compound command once any part of it names
#    one. Accepted: a caller naming the shell has thought about the self-match.
#  - The `comm` limb FAILS CLOSED on a rule-store fault — a missing, empty or
#    oversized claude-process-count fragment refuses the command, gp_rule's
#    ruling (mantahostels#1762).
#  - It FAILS OPEN on anything it cannot resolve — a missing jq, an unparseable
#    command, or the shared parser being unreadable. Every fail-open is
#    RECORDED (mantahostels#147) via lib/guard-log.sh and reported by
#    check-guard-errors.js under `npm run status`.
#  - The `comm` limb reads `claude` anywhere in the command for the `ps` and
#    `/proc` shapes, and any `/comm` path in a command naming `/proc/`. A
#    count built on `pidof`, `killall` or `awk` over `/proc/*/stat`, or a
#    `Name:` read from `/proc/*/status`, is not seen.
#  - It guards the Bash tool only.

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, `gp_begin` — never
# `source`'s own exit status (mantahostels#157). lib/guard-log.sh is sourced first and
# separately, so the fault that disarms this guard entirely is itself
# recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
# shellcheck source=scripts/lib/pgrep-args.sh
source "$here/lib/pgrep-args.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}
declare -F pga_read >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/pgrep-args.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

whole="$(gp_subject)"

# A caller who has named the calling shell has already reckoned with the
# self-match; nothing below but an inverted pgrep/pkill is worth saying to them.
names_shell=0
case "$whole" in
  *'$$'* | *'$PPID'*) names_shell=1 ;;
esac

warning=""

# `laude`, so a bracketed `'[c]laude'` still names claude.
claude_named=0
[[ "${whole,,}" == *laude* ]] && claude_named=1
comm_count=0

# Every pgrep/pkill the walk finds selecting by pattern: its segment, its
# command, its kind — `line` for `-f`, `name` without, `inverted` for either
# under `-v` — and its pattern with the grep mode could_match reads it in, `?`
# where it is not tested. Judged after the walk, once $argv_text holds every
# command; a `name` or `inverted` one is counted untested.
declare -a pp_segments=() pp_cmds=() pp_kinds=() pp_patterns=() pp_modes=()

# The `ps | grep` limb's facts, gathered by the walk below: every grep that
# follows a `ps`, and whether any of them could match the command's own text.
# The walk flattens a pipe like any other separator, so "follows" means the
# next command, which the raw regex further down pairs with a real pipe.
after_ps=0
ps_greps=0
ps_grep_unsure=0
declare -a grep_patterns=() grep_modes=()
# Every walked command's words with their quotes taken off, one per line —
# the argv `ps` prints for each of them, which a pattern may match where the
# command as typed does not (`grep 'nex''t'` searches for `next`). Gathered
# only where a limb will read it, as each word costs a fork.
argv_text=""
want_argv=0

# One argument of a grep fed by `ps`. Sets judge_grep's locals.
match_grep_arg() {
  case "$1:$2" in
    opt:-e | opt:--regexp) e_patterns+=("$3") ;;
    opt:-f | opt:--file | dangling:* | flag:-v | flag:--invert-match) unsure=1 ;;
    flag:-E | flag:--extended-regexp) mode=E ;;
    flag:-F | flag:--fixed-strings) mode=F ;;
    flag:-G | flag:--basic-regexp) mode=B ;;
    flag:-P | flag:--perl-regexp) unsure=1 ;;
    flag:-i | flag:-y | flag:--ignore-case) icase=1 ;;
    arg:*) [[ -z "$first" ]] && first="$3" ;;
  esac
  return 0
}

# Record one grep that a `ps` feeds: its patterns as grep reads them, or
# $ps_grep_unsure where it reads one this guard cannot test — inverted, from a
# file, Perl-flavoured, or carrying an expansion.
judge_grep() {
  local cmd="$1"
  shift
  local mode=B icase=0 unsure=0 first="" p lit
  local -a e_patterns=()
  case "$cmd" in
    egrep) mode=E ;;
    fgrep) mode=F ;;
  esac
  # GNU grep's value-taking flags (`grep --help`), so a value is never read as
  # the pattern: `grep -m 1 node` searches for node, not 1.
  gp_scan_flags "-e -f -m -A -B -C -d -D --regexp --file --max-count --after-context --before-context --context --label --binary-files --devices --directories --exclude --include --exclude-dir --exclude-from --group-separator" match_grep_arg -- "$@"
  ((${#e_patterns[@]})) || e_patterns=("$first")
  ((ps_greps++))
  for p in "${e_patterns[@]}"; do
    if ((unsure)) || [[ -z "$p" ]] || ! lit="$(gp_literal "$p")"; then
      ps_grep_unsure=1
      return 0
    fi
    grep_patterns+=("$lit")
    grep_modes+=("$mode$icase")
  done
}

# Whether pattern $1, read in grep mode $2 (B, E or F, then 1 for -i), could
# match $3. Errs towards yes: a basic regex using a character whose meaning
# differs from an extended one is never translated, only answered yes, and so
# is a pattern that will not compile.
could_match() {
  local pattern="$1" mode="${2:0:1}" icase="${2:1}" subject="$3" line rc
  # grep reads each line of a pattern as a pattern of its own.
  while IFS= read -r line; do
    [[ -n "$line" ]] || return 0
    if [[ "$mode" == F ]]; then
      ((icase)) && { line="${line,,}" && subject="${subject,,}"; }
      [[ "$subject" == *"$line"* ]] && return 0
      continue
    fi
    if [[ "$mode" == B ]]; then
      [[ "$line" == *[\\+?\|\(\)\{\}]* || "$line" == \** ||
        "${line:1}" == *^* || "${line%$}" == *\$* ]] && return 0
    fi
    ((icase)) && shopt -s nocasematch
    [[ "$subject" =~ $line ]]
    rc=$?
    shopt -u nocasematch
    ((rc == 1)) || return 0
  done <<<"$pattern"
  return 1
}

# Whether a `ps`'s arguments select or print processes by `comm`: `-C` naming
# claude, an output format listing a `comm` field without an `args` one, or
# no format at all where the default's last column is `comm` — UNIX-style
# options only, without `-f` or `-F`. `-O` and BSD words print args by default.
judge_ps_comm() {
  local word lit prev="" fields="" field formatted=0
  for word in "$@"; do
    lit="$(gp_literal "$word")" || {
      prev=""
      continue
    }
    case "$prev:$lit" in
      -C:*) [[ "${lit,,}" == *claude* ]] && comm_count=1 ;;
      -p:* | -u:* | -U:* | -g:* | -G:* | -t:* | -s:* | -q:* | --sort:* | --pid:* | --ppid:* | --user:* | --tty:*) ;;
      -o:* | o:* | --format:* | -*o:* | [a-zA-Z]*o:*) fields+=",$lit" ;;
      *:-C?*) [[ "${lit,,}" == *claude* ]] && comm_count=1 ;;
      *:--format=*) fields+=",${lit#--format=}" formatted=1 ;;
      *:-o?*) fields+=",${lit:2}" formatted=1 ;;
      *:-O* | *:O* | *:-[!-]*[fF]* | *:[!-]*) formatted=1 ;;
    esac
    prev="$lit"
  done
  [[ -n "$fields" ]] && formatted=1
  ((formatted)) || comm_count=1
  local has_comm=0
  local IFS=$', \t'
  for field in $fields; do
    field="${field%%=*}"
    case "${field%%:*}" in
      comm | ucomm | ucmd | fname) has_comm=1 ;;
      args | cmd | command) return 0 ;;
    esac
  done
  ((has_comm)) && comm_count=1
  return 0
}

judge() {
  local segment="$1" cmd="$2"
  shift 2
  # shellcheck disable=SC2034 # exact: pga_read sets it; local so it never leaks
  local full=0 icase=0 exact=0 invert=0 ancestors=0 pattern="" fed=$after_ps word lit kind

  # A shell keyword is not a wrapper — the command follows it directly in the
  # same segment, so `while pgrep -f x; do …` reads as a command named `while`.
  # Handled here rather than in lib/guard-parse.sh, which six other guards
  # share and none of them asked for this.
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

  if ((want_argv)); then
    lit="${cmd##*/}"
    for word in "$@"; do
      lit+=" $(gp_literal "$word")"
    done
    argv_text+=$'\n'"$lit"
  fi

  if ((ps_piped)); then
    # A grep fed by a fed grep is judged too, so a trailing `grep -v grep`
    # still warns.
    after_ps=0
    case "${cmd##*/}" in
      ps) after_ps=1 ;;
      grep | egrep | fgrep) ((fed)) && after_ps=1 && judge_grep "${cmd##*/}" "$@" ;;
    esac
  fi

  ((claude_named)) && [[ "${cmd##*/}" == ps ]] && judge_ps_comm "$@"

  case "${cmd##*/}" in
    pgrep | pkill) ;;
    *) return 0 ;;
  esac

  pga_read "$@"
  local lit_ok=1
  lit="$(gp_literal "$pattern")" || lit_ok=0
  if ((claude_named && !full && !invert && lit_ok)) && [[ "${cmd##*/}" == pgrep && -n "$pattern" ]] &&
    pga_selects claude "$lit"; then
    comm_count=1
  fi
  ((ancestors)) && return 0
  if ((!full)); then
    [[ -n "$pattern" ]] || return 0
    if ((lit_ok)); then
      pga_selects_shell_name "$lit" || return 0
    else
      ((invert)) || return 0
    fi
    kind=name
  else
    kind=line
  fi
  ((invert)) && kind=inverted
  ((names_shell)) && [[ "$kind" != inverted ]] && return 0
  pp_segments+=("$segment")
  pp_cmds+=("${cmd##*/}")
  pp_kinds+=("$kind")
  if [[ "$kind" != line || -z "$pattern" ]] || ((!lit_ok)); then
    pp_patterns+=("")
    pp_modes+=("?")
  else
    pp_patterns+=("$lit")
    pp_modes+=("E$icase")
  fi
  return 0
}

# `ps ... | grep <pattern>` checking a background job's liveness. No `-f`-shaped
# flag to key off here, so whether one is present at all is a raw regex over the
# whole command rather than a walk over parsed words; see LIMITS above for what
# it does not see. Matched before the walk, which reads every word back only
# where it did.
ps_grep_sep=$'[;&|(!{\n]'
ps_grep_re="(^|${ps_grep_sep}|\\b(while|until|if|elif|then|else|do)[[:space:]])[[:space:]]*ps([[:space:]]+[A-Za-z0-9_.,:=+*/-]+)*[[:space:]]*\\|[[:space:]]*[ef]?grep\\b"
ps_piped=0
((!names_shell)) && [[ "$whole" =~ $ps_grep_re ]] && ps_piped=1 && want_argv=1
case "$whole" in
  *pgrep* | *pkill*) want_argv=1 ;;
esac

gp_walk_commands judge

# What a pattern self-matches against: the calling shell's argv, and every
# command's as `ps` prints it.
subject="/bin/bash -c $whole$argv_text"

pid_recipe="Match on a pid you captured instead: run the thing in the background, keep its pid (\`cmd & echo \$! > pidfile\`) or read it once from \`ps\`, then act on that number."
recipe="$pid_recipe Where a pattern is genuinely wanted, bracket its first character (\`'[n]ode'\`) so it cannot match its own text, pass \`-A\` to spare this shell and its ancestors, or exclude this shell — \$\$ or \$PPID — and the guard stays out of the way."
name_recipe="$pid_recipe Where a name is genuinely wanted, use one \`bash\` does not match, or pass \`-A\` to spare this shell and its ancestors."
inverted_hazard="selects every process its pattern misses: the harness and nearly everything else, and the shell running it wherever the pattern misses that shell's command line, or without \`-f\` its name, \`bash\`. Bracketing the pattern does not escape it — a pattern that misses its own text puts the shell in."

for i in "${!pp_cmds[@]}"; do
  if [[ "${pp_modes[i]}" != "?" ]] &&
    ! could_match "${pp_patterns[i]}" "${pp_modes[i]}" "$subject"; then
    continue
  fi
  if [[ "${pp_cmds[i]}" == pkill ]]; then
    case "${pp_kinds[i]}" in
      inverted) gp_deny "@CMD@ is inverted, so it $inverted_hazard It can kill the session itself.

$pid_recipe" "${pp_segments[i]}" ;;
      name) gp_deny "@CMD@ matches process names, and its pattern matches \`bash\`, the name of the shell running it, so this kills the session itself.

$name_recipe" "${pp_segments[i]}" ;;
    esac
    gp_deny "@CMD@ matches the command line of the shell running it, so this can kill the session itself — it did on 2026-08-23, where \`pkill -f 'node -c'\` took down the shell that issued it (exit 144).

The Bash tool runs every command as \`/bin/bash -c '<command>'\`, which puts the pattern inside the caller's own argv, and this pattern matches that text.

$recipe" "${pp_segments[i]}"
  fi
  # gp_warn takes finished prose and splices nothing, so the segment is
  # rendered here. First one wins: a compound command full of pgreps has one
  # thing wrong with it, not four. A later pkill still denies.
  [[ -n "$warning" ]] && continue
  case "${pp_kinds[i]}" in
    inverted) warning="$(gp_unmask "${pp_segments[i]}") is inverted, so it $inverted_hazard

$pid_recipe" ;;
    name) warning="$(gp_unmask "${pp_segments[i]}") matches process names, and its pattern matches \`bash\`, the name of the shell running it, so it finds that shell as well as whatever you are looking for.

$name_recipe" ;;
    *) warning="$(gp_unmask "${pp_segments[i]}") matches the command line of the shell running it, so it finds itself as well as whatever you are looking for. A loop built on it never exits.

$recipe" ;;
  esac
done

if [[ -z "$warning" ]] && ((ps_piped)); then
  ps_grep_safe=0
  if ((ps_greps && !ps_grep_unsure)); then
    ps_grep_safe=1
    for i in "${!grep_patterns[@]}"; do
      if could_match "${grep_patterns[i]}" "${grep_modes[i]}" "$subject"; then
        ps_grep_safe=0
        break
      fi
    done
  fi
  if ((!ps_grep_safe)); then
    warning="\`ps | grep\` self-matches the shell running it: the Bash tool runs this command line as that shell's own argv, so the pattern is in it — and checking a background job's liveness this way has an extra failure of its own: the harness's own task id for a \`run_in_background\` job (the short id its tool result names) is never in any process's actual command line, so grepping for THAT specific id finds nothing even while the job runs. \`grep -v grep\`, meant to hide the searching grep's self-match, makes it worse: it silently drops a real match too whenever the target's own command line contains the word \"grep\" — which a liveness-polling loop's usually does.

Check liveness off the job's own completion notification, its output file, or the session's own shell counter — a harness task id is not a process-search pattern. Where a process search is genuinely wanted, bracket the pattern's first character (\`grep '[n]ode'\`) so it cannot match its own text, and the guard stays out of the way. \`docs/agents/verification.md\`'s \"Asserting that nothing of yours is still running\" has the full rule."
  fi
fi

((claude_named)) && [[ "$whole" == */proc/* && "$whole" =~ /comm([^[:alnum:]_]|$) ]] && comm_count=1

# The rule rides with any warning above, in the one envelope the hook may
# print; once told, gp_rule sends the warning alone and exits.
if ((comm_count)); then
  gp_rule_prelude "$warning"
  gp_rule claude-process-count
fi

[[ -n "$warning" ]] && gp_warn "$warning"

gp_allow
