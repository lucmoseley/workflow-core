#!/usr/bin/env bash
# PreToolUse guard: a hand-rolled wait loop with no ceiling is about to run
# (mantahostels#2042, spec mantahostels#2017, from the snapshot at mantahostels#2012).
#
# Why: an `until`/`while` loop around `sleep` inside one Bash call is one tool
# call, so nothing else here sees it. When its condition can never become true
# the shell loops for ever, outlives the session that made it, reparents to
# init, and keeps running after the founder has been told the session is
# Completed.
#
# THE UNBOUNDED LOOP ONLY WARNS (mantahostels#103, mantahostels#2017 §Out of Scope): an unbounded
# wait is sometimes the right call and only the caller knows.
#
# A WAIT OVER 15 MINUTES IS DENIED (workflow-core#1288, ruled at workflow-core#1286). Three shapes are a
# wait, foreground or backgrounded alike:
#  - the command's literal `sleep`s, summed past 900 s (GNU sums `sleep 1h
#    30m` too; `infinity` counts);
#  - a counted loop — a `for` over `seq` or `{a..b}`, or a cap with a counter —
#    whose count × summed literal sleeps passes it;
#  - `timeout` past 900 s around a wait whose own length is unread: a `sleep`
#    with no literal duration, or a `while`/`until` with no count, reached
#    through `bash -c` and any leading assignments.
# Long WORK is not a wait: `timeout 3600 npm run build` passes, and so do
# watch-artefact.js and session-arbiter.js wait, neither being a sleep. The
# deny still fires where docs/agents/rules/wait-length.txt will not read, its
# fallback naming the file.
#
# LIMITS
#  - It is a RAW REGEX over the command text, not a gp_walk_commands judge,
#    there being no `-f`-shaped flag to key off. Both verdicts read it with
#    every quoted span and heredoc body emptied but a shell's own script (see
#    THE DENY below), so a commit message or issue body mentioning `while`
#    passes and `bash -c 'until …'` is still read.
#  - A `for` loop never warns, being bounded by construction; the deny counts
#    one only where `seq` or `{a..b}` states its count.
#  - A loop's extent is read as the text from its keyword to the `done` that
#    closes a command, lexically. A nested loop ends the outer one early, so an
#    outer loop whose only `sleep` sits after the inner `done` is judged as
#    having none. A loop that never closes — `until …; do sleep 5` with the
#    `done` in a later tool call — runs to the end of the command text.
#  - `timeout` anywhere in the command clears every loop in it of the
#    warning — a `timeout` wrapping some other command, one inside a comment.
#    Deliberately loose; one inside a quoted span or heredoc body does not.
#  - THE DENY reads the command with every quoted span and heredoc body
#    emptied but a shell's own script (`bash -c '…'`, `bash <<EOF`), so a
#    commit message or a written file quoting a long sleep passes. A comment
#    and an `eval` string are still read; `grep -c "…"` is read
#    as a `-c` script. It is blind to `sleep "$n"` or `sleep $((60*60))`. A
#    `timeout`'s wrapped command is judged by its first word, so `timeout 3600
#    bash -c 'until npm test; do sleep 5; done'`, a retry loop, is refused as a
#    wait. A counted loop past the cap is refused even inside a shorter
#    `timeout`, and a backgrounded `sleep 600 & sleep 600` reads as 20 minutes.
#  - A `break` is not read as a ceiling, so `while :; do check && break;
#    sleep 5; done` warns.
#  - A ceiling is recognised lexically, and in TWO PARTS TOGETHER: a numeric
#    comparison in the condition (`-ge 36`, `< 36`) AND an increment idiom in
#    the body (`((n++))`, `n=$((n+1))`, `((n+=1))`). A comparison alone is
#    usually a data condition — `until [ "$(free -m …)" -ge 1850 ]` waits on
#    the machine and not on a count — and still warns. So does a ceiling
#    spelled any other way: a deadline against `date +%s`, a bound held in a
#    variable, a counter with no numeric literal.
#  - First fire wins: a compound command carrying four unbounded loops has one
#    thing wrong with it and is told once.
#  - It FAILS OPEN on anything it cannot resolve — a missing jq, an unparseable
#    payload, the shared parser being unreadable. House style (mantahostels#103 §6), and
#    every fail-open is RECORDED (mantahostels#147) via lib/guard-log.sh, reported by
#    check-guard-errors.js under `npm run status`.
#  - It guards the Bash tool. A loop started from the founder's own terminal
#    sees no hook; scripts/check-orphan-wait-loops.js is that backstop.

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
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

whole="$(gp_subject)"

# A word in command position: at the start, or after a separator, a shell
# keyword's trailing space, or a newline. `[:space:]` covers the newline, so
# `cmd; until …` and a loop on its own second line are the same case. Both
# quote characters are in the class, so `bash -c 'until …'` is seen.
sep='(^|['"'"'";&|(!{[:space:]])'

loop_re="${sep}(while|until|for)[[:space:]]"
# The loop's end: `done` closing a command, never `done` as an argument to one.
# It carries its own trailing delimiter, which is what the truncation below cuts
# on; a quote is one, closing a `bash -c '…; done'` script (workflow-core#1808).
done_re="[;&|)}"$'\n'"][[:space:]]*done[;&|)}[:space:]'\"]"
sleep_re="${sep}sleep[[:space:]]"
# `((n++))`, `((n += 1))` and `n=$((n+1))` — the increment idioms mantahostels#2017 names.
bump_re='\(\([[:space:]]*[[:alnum:]_]+[[:space:]]*(\+\+|\+=)|=\$\(\([[:space:]]*[[:alnum:]_]+[[:space:]]*\+'
# An explicit iteration cap: `[ $n -ge 36 ]`, `(( n < 36 ))`.
cap_re='(-(ge|gt|le|lt)[[:space:]]+[0-9]+|[<>]=?[[:space:]]*[0-9]+)'
# Where the condition ends, so the cap is read from the condition, not the body.
do_re="[;&|)}"$'\n'"][[:space:]]*do[[:space:]]"

# _loops <text> <judge> — run <judge> on each `while`/`until`/`for` loop in
# <text> that holds a `sleep`, with `kw`, `body` (keyword to closing `done`) and
# `condition` (the part before `do`) set. A judge returning 1 ends the walk.
_loops() {
  local rest="$1" lead after keyword text
  while [[ "$rest" =~ $loop_re ]]; do
    lead="${BASH_REMATCH[0]}" keyword="${BASH_REMATCH[2]}"
    after="${rest#*"$lead"}"
    rest="$after"

    # The trailing newline gives done_re its delimiter on a loop ending the
    # command. See LIMITS for what a nested loop does to that boundary.
    text="${lead}${after}"$'\n'
    [[ "$text" =~ $done_re ]] &&
      text="${text%%"${BASH_REMATCH[0]}"*}"

    # No sleep in it, so it is not a wait loop — its exit is not governed by an
    # external condition and nothing here applies (mantahostels#2017, user story 6).
    [[ "$text" =~ $sleep_re ]] || continue

    kw="$keyword" body="$text" condition="$text"
    [[ "$condition" =~ $do_re ]] &&
      condition="${condition%%"${BASH_REMATCH[0]}"*}"
    "$2" || return 0
  done
}

brace_re='\{([0-9]{1,9})\.\.([0-9]{1,9})\}'
seq_re='seq[[:space:]]+([0-9]{1,9})([[:space:]]+([0-9]{1,9}))?([[:space:]]+([0-9]{1,9}))?'

# _count — the loop's iteration count into `count`, where its text states one:
# a `for` over `seq` or `{a..b}`, or a cap in the condition with a counter in
# the body moving toward it. Returns 1 where it states none.
_count() {
  local a b c
  count=""
  if [[ "$kw" == for ]]; then
    if [[ "$condition" =~ $brace_re ]]; then
      a=$((10#${BASH_REMATCH[1]})) b=$((10#${BASH_REMATCH[2]}))
      count=$((a > b ? a - b + 1 : b - a + 1))
    elif [[ "$condition" =~ $seq_re ]]; then
      a=$((10#${BASH_REMATCH[1]})) b="${BASH_REMATCH[3]}" c="${BASH_REMATCH[5]}"
      if [[ -z "$b" ]]; then
        count=$a
      elif [[ -z "$c" ]]; then
        count=$((10#$b - a + 1))
      elif ((10#$b > 0)); then
        count=$(((10#$c - a) / 10#$b + 1))
      fi
    fi
  elif [[ "$condition" =~ $cap_re ]]; then
    # Held before the bump test, whose =~ overwrites BASH_REMATCH.
    a="${BASH_REMATCH[0]##*[!0-9]}"
    [[ "$body" =~ $bump_re ]] && count=$((${#a} < 10 ? 10#$a : 999999999))
  fi
  [[ -n "$count" ]]
}

# --- THE DENY: a wait over 15 minutes (workflow-core#1288) ---
WAIT_CAP_MS=900000
# What `sleep infinity`, or a duration too long for bash's arithmetic, reads as.
ENDLESS_MS=999999999999999
# A duration word ends at whitespace, a separator or a quote, so the `9984` in
# `bash -c "sleep 9984"` is read without its closing quote.
word_re='^([^[:space:];&|)'"'"'"]+)[[:space:]]*'

# _dur_ms <word> — GNU sleep/timeout's duration grammar (a decimal, then an
# optional s/m/h/d) into `_ms`, in milliseconds. Returns 1 on anything else.
_dur_ms() {
  local int frac mult=1
  [[ "$1" =~ ^inf(inity)?$ ]] && {
    _ms=$ENDLESS_MS
    return 0
  }
  [[ "$1" =~ ^([0-9]*)(\.([0-9]*))?([smhd]?)$ ]] || return 1
  int="${BASH_REMATCH[1]}" frac="${BASH_REMATCH[3]}000"
  [[ -n "$int${BASH_REMATCH[3]}" ]] || return 1
  ((${#int} > 11)) && {
    _ms=$ENDLESS_MS
    return 0
  }
  case "${BASH_REMATCH[4]}" in m) mult=60 ;; h) mult=3600 ;; d) mult=86400 ;; esac
  _ms=$(((10#${int:-0} * 1000 + 10#${frac:0:3}) * mult))
}

# _sleeps <text> — every `sleep` in <text>: `_sleep_sum` their literal lengths
# together, `_sleep_text` their spellings, `_sleep_unread` how many had no
# literal duration to read.
_sleeps() {
  local rest="$1" t n total words m
  _sleep_sum=0 _sleep_text="" _sleep_unread=0
  while [[ "$rest" =~ ${sleep_re}[[:space:]]* ]]; do
    rest="${rest#*"${BASH_REMATCH[0]}"}"
    t="$rest" n=0 total=0 words=""
    # The match is held before _dur_ms, whose own =~ overwrites BASH_REMATCH.
    while [[ "$t" =~ $word_re ]]; do
      m="${BASH_REMATCH[0]}"
      _dur_ms "${BASH_REMATCH[1]}" || break
      t="${t#"$m"}" words+=" ${m%%[[:space:]]*}"
      ((total += _ms, n++))
    done
    ((n)) || {
      ((_sleep_unread++))
      continue
    }
    ((_sleep_sum += total))
    _sleep_text+="${_sleep_text:+; }sleep$words"
  done
}

# _mask <text> — <text> into `_masked`, every quoted span emptied but a shell's
# `-c` script, which is kept with its own quoted spans emptied in turn. An
# unclosed quote empties the rest.
quote_re='^([^'"'"'"]*)(['"'"'"])'
dquoted_re='^(([^"\\]|\\.)*)"'
shell_c_re='(^|[[:space:]])-[[:alpha:]]*c[[:space:]]+$'
_mask() {
  local s="$1" out="" q span
  while [[ "$s" =~ $quote_re ]]; do
    out+="${BASH_REMATCH[1]}" q="${BASH_REMATCH[2]}"
    s="${s:${#BASH_REMATCH[0]}}"
    if [[ "$q" == "'" ]]; then
      [[ "$s" == *"'"* ]] || {
        s=""
        break
      }
      span="${s%%\'*}" s="${s#*\'}"
    else
      [[ "$s" =~ $dquoted_re ]] || {
        s=""
        break
      }
      span="${BASH_REMATCH[1]}" s="${s:${#BASH_REMATCH[0]}}"
    fi
    if [[ "$out" =~ $shell_c_re ]]; then
      _mask "$span"
      out+="$q$_masked$q"
    else
      out+="$q$q"
    fi
  done
  _masked="$out$s"
}

# _unheredoc <text> — <text> into `_unheredoced`, every heredoc body emptied but
# one fed to a shell (`bash <<EOF`), so a script written with `cat > f <<EOF`
# or piped to `python3 - <<EOF` is not read as the call's own wait.
heredoc_re='(^|[^<])<<-?[[:space:]]*['"'"'"]?([[:alpha:]_][[:alnum:]_]*)['"'"'"]?'
shell_fed_re='(^|[;&|({[:space:]])(/[^[:space:]]*/)?(ba|da|z)?sh([[:space:]]+-[[:alpha:]]+)*[[:space:]]*$'
_unheredoc() {
  local s="$1" out="" op delim line bare keep
  while [[ "$s" =~ $heredoc_re ]]; do
    op="${BASH_REMATCH[0]}" delim="${BASH_REMATCH[2]}"
    out+="${s%%"$op"*}"
    keep=0
    [[ "$out${BASH_REMATCH[1]}" =~ $shell_fed_re ]] && keep=1
    s="${s#*"$op"}"
    out+="$op"
    # The rest of the operator's line is still command; the body starts below it.
    [[ "$s" == *$'\n'* ]] || break
    out+="${s%%$'\n'*}"$'\n'
    s="${s#*$'\n'}"
    while [[ -n "$s" ]]; do
      line="${s%%$'\n'*}"
      if [[ "$s" == *$'\n'* ]]; then s="${s#*$'\n'}"; else s=""; fi
      bare="${line#"${line%%[!$'\t']*}"}"
      if [[ "$bare" == "$delim" ]]; then
        out+="$line"$'\n'
        break
      fi
      ((keep)) && out+="$line"$'\n'
    done
  done
  _unheredoced="$out$s"
}

# wait_deny <the wait, named for the session> <its length in ms>
wait_deny() {
  local length="$((($2 + 59999) / 60000)) minutes"
  (($2 >= ENDLESS_MS)) && length="without end"
  gp_deny "This waits ${length} — $1 — and the limit is 15 minutes.

$(gp_rule_text wait-length "A Bash wait of more than 15 minutes is banned; the rule could not be read from docs/agents/rules/wait-length.txt. Read that file before doing anything else: it says how to hand the work back instead.")"
}

_unheredoc "$whole"
_mask "$_unheredoced"
waits="$_masked"

# Every literal sleep in the command, summed.
_sleeps "$waits"
((_sleep_sum > WAIT_CAP_MS)) && wait_deny "\`$_sleep_text\`" "$_sleep_sum"

# A counted loop: its iteration count times every literal sleep in its body.
# Unread where any sleep in it is not a literal.
deny_counted() {
  _count || return 0
  _sleeps "$body"
  # No overflow: the body's sleeps are within the command's, already under the
  # cap, and the count is under 10^9.
  ((_sleep_unread == 0 && count * _sleep_sum > WAIT_CAP_MS)) || return 0
  local loop="${body#"${body%%[wuf]*}"}"
  wait_deny "\`${loop%$'\n'}\`" "$((count * _sleep_sum))"
}
_loops "$waits" deny_counted

# The `timeout` shape. Its own flags are skipped, `-s KILL` and `-k 5` taking
# a value; then `bash -c`, any flags of the shell's, an opening quote and
# leading `n=0;` assignments, to reach the wrapped command's first word.
shell_re='^(/[^[:space:]]*/)?(ba|da|z)?sh([[:space:]]+-[[:alpha:]]+)*[[:space:]]+['"'"'"]?'
assign_re='^[[:alpha:]_][[:alnum:]_]*=[^[:space:];&]*[[:space:]]*(;|&&)?[[:space:]]*'
first_loop() { return 1; }
rest="$waits"
while [[ "$rest" =~ ${sep}timeout[[:space:]]+ ]]; do
  rest="${rest#*"${BASH_REMATCH[0]}"}"
  t="$rest"
  while [[ "$t" =~ ^(-[sk]|--signal|--kill-after)[[:space:]]+[^[:space:]]+[[:space:]]+ ||
    "$t" =~ ^-[^[:space:]]*[[:space:]]+ ]]; do
    t="${t#"${BASH_REMATCH[0]}"}"
  done
  [[ "$t" =~ $word_re ]] || continue
  t="${t#"${BASH_REMATCH[0]}"}" wrapped="${BASH_REMATCH[1]}"
  # shellcheck disable=SC2015 # continue is right whether either test fails.
  _dur_ms "$wrapped" && ((_ms > WAIT_CAP_MS)) || continue
  limit=$_ms
  [[ "$t" =~ $shell_re ]] && t="${t#"${BASH_REMATCH[0]}"}"
  while [[ "$t" =~ $assign_re ]]; do
    t="${t#"${BASH_REMATCH[0]}"}"
  done
  if [[ "$t" =~ ^sleep[[:space:]]+([^[:space:]]*) ]]; then
    # A literal sleep was judged above, at its own length.
    [[ "${BASH_REMATCH[1]}" =~ $word_re ]] && _dur_ms "${BASH_REMATCH[1]}" && continue
    wrapped="\`timeout $wrapped\` around a \`sleep\` of no literal length"
  elif [[ "$t" =~ ^(while|until)[[:space:]] ]]; then
    kw=""
    _loops "$t" first_loop
    # shellcheck disable=SC2015 # continue is right whether either test fails.
    [[ -n "$kw" ]] && ! _count || continue
    wrapped="\`timeout $wrapped\` around an uncounted \`$kw\` loop"
  else
    continue
  fi
  wait_deny "$wrapped" "$limit"
done

# --- THE WARN: a wait loop with no ceiling (mantahostels#2042) ---
timed=0
[[ "$waits" =~ ${sep}timeout[[:space:]] ]] && timed=1

# Each loop in the command, judged on its own text, so a bounded loop and an
# unbounded one can share a command line and still be told apart. Bounded means
# an iteration cap in the CONDITION and a counter in the body that moves toward
# it; either alone is not a ceiling — LIMITS says why.
warning=""
warn_unbounded() {
  [[ "$kw" == for ]] && return 0
  _count && return 0
  ((timed)) && return 1

  # The loop is named back, so a compound command's first-fire-wins warning
  # says which of its loops was matched.
  local loop="${body#"${body%%[wu]*}"}"
  warning="This wait loop has no ceiling — \`${loop%$'\n'}\` — so if its condition never becomes true the shell runs for ever. It outlives the session that wrote it, reparents to init, and goes on holding a slot after the session reads as Completed — mantahostels#2012 found one still running 13 hours later, its session gone.

Bound it, either way:

  timeout 600 bash -c 'until <condition>; do sleep 10; done'

  n=0; until [ \$n -ge 36 ] || <condition>; do sleep 20; n=\$((n+1)); done

What this guard cannot see: it reads a ceiling as a \`timeout\`, or a numeric comparison in the condition with a counter in the body. One spelled any other way — a deadline against \`date +%s\`, a bound held in a variable — reads as no ceiling at all. If your loop is genuinely unbounded on purpose, run it: this warning never refuses (mantahostels#2042)."
  return 1
}
_loops "$waits" warn_unbounded

[[ -n "$warning" ]] && gp_warn "$warning"

gp_allow
