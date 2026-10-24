#!/usr/bin/env bash
# PreToolUse guard: a suite DETACHED INSIDE THE SHELL — `&`, `nohup`, `setsid`,
# `disown` — registers no job, so nothing will ever wake the session, and the
# `waiting:` turn that follows sits in `working` until the founder notices.
#
# AND (#1186) A SUITE WITH NO UPPER BOUND WRAPPED IN A SHELL `timeout N`,
# which kills it at its clock with no result (ruled at #1181 Q1–Q4 (A)).
#   Unbounded is an `npm test`/`npm run test`, `test:changed` or `run-vitest.js`
# naming no test-file-shaped word, or carrying a bare word that is no flag's
# value, as lib/suite-bounded.sh reads its argv — the reading
# guard-suite-concurrency.sh shares, there for `run-vitest.js` alone. A named
# file outranks `--full=<cause>`, run-vitest.js itself then running no whole
# suite. The watcher, `test:py` and a runner other than vitest are out. Any `N`, any `timeout`
# flags, queued or not, `run_in_background` or not, a compound command too.
#   Only a `timeout` among the wrappers `gp_unwrap` took off is read; one
# after the command word is an argument. Line one is the command with each such
# `timeout`, its flags and duration dropped (`strip_timeout`), and never adds
# `--queue`, which stays the count cap's to add. Its escape is
# `WFC_SUITE_TIMEOUT=<non-empty>`, read like `WFC_SUITE_DETACH` but per
# segment. A command both detached and timed gets one deny, both stripped.
#
# THE THREE LARGER CAUSES OF A STALL are out of this guard's reach, which is
# suites only; they are on mantahostels#2485 and in
# https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md, and the rates behind the deny
# below. A FOREGROUND SUITE IS NOT IN SCOPE and is
# deliberately allowed: a call that overruns its timeout is backgrounded by the
# harness and notifies (#535 §Further Notes). An undetached
# `run_in_background` suite is allowed too.
#
# THE DENY OPENS WITH THE COMMAND TO RUN INSTEAD (#519), on #482's ruling that
# the suite refusals buried their fix in ~2 KB of text. So line one is the
# command less its detachment, in the foreground with `timeout: 600000` (#545),
# and the rest
# keeps only what changes a later call. `strip_detachment` builds
# it: the whole command, not the suite segment alone, with `nohup`/`setsid`
# and their flags and `disown` and its arguments dropped, a trailing `&`
# dropped and a mid-command one turned into `;`. A heredoc's body and
# terminator are data (#2384), the lines lib/guard-parse.sh's heredoc pass
# drops, so `hold_heredocs` sets them aside before the detach test and both
# re-spellings read the command, and the deny puts them back as typed.
#
# THE FIGURES BEHIND IT LIVE HERE, NOT IN THE DENY. A queued suite job IS
# killed often — 192 of 427 notified `--queue` launches, against 123 of 1,286
# notified unqueued suite jobs and 238 of 5,589 notified non-suite jobs — but a
# kill still emits `<status>killed</status>`, where a detached run emits
# nothing, ever. That notification lies: 70% of the time `bg-run.sh check`
# still reads RUNNING (mantahostels#2517), so a blind relaunch starts a second suite.
# Emitting is mostly receiving: 97% of notifications enqueued with a tool
# call in flight are folded into the next tool result and read, ~92% of those
# enqueued idle (#845, overturning mantahostels#2516's 67.8% drop). The deny still
# asserts no wake — a kill or a lost notification stays possible.
#
# A DENY, NOT A WARN. The mantahostels#908/mantahostels#987 precedent for warning turns on the INPUT
# being a judgement call — a headroom snapshot that may be stale. This one's
# input is the command string in hand.
#
# SCOPE — both limbs must hold, on the same tool call:
#   1. some segment is a suite launch (`is_test`), and
#   2. the command detaches (`detaches`).
# `run_in_background` is NOT a third limb: setting it alongside a detachment
# registers a job for the WRAPPER, which exits at once and reports success while
# the suite runs on unattached.
#
# `is_test` is guard-suite-concurrency.sh's, plus `test:py`: both ask
# lib/suite-launch.sh (#1528), so `node --test`, `pytest`, a bare Python test
# file and a host's declared `suiteRunners` are refused detached too. A WRAPPER
# STANDING WHERE THE COMMAND WORD IS LOOKED FOR IS STRIPPED FIRST — `nohup`,
# `setsid`, `env`, `timeout`, `time`, `command`, `stdbuf`, `nice`, `ionice`,
# `xargs`, `sudo` and `bg-run.sh run <name>` — by lib/guard-parse.sh's
# `gp_unwrap` (mantahostels#2524, mantahostels#2552).
#
# ITS ESCAPE IS `WFC_SUITE_DETACH=<anything non-empty>` AS A PREFIX ON THE
# COMMAND — `=0` exempts too — read from the command string rather than from this
# hook's environment: a hook runs before the command, so an env prefix never
# reaches it (mantahostels#2486). The escape is read through an `env` prefix
# too (mantahostels#2524).
#
# LIMITS.
#  - `detaches` is LEXICAL. A detachment inside a script, behind `sh -c`, via
#    `at`, `systemd-run` or a multiplexer passes unseen — guard-bg-job.sh's own
#    blind spot. A `&` inside a quoted string reads as a detachment, unless
#    the string is a heredoc's body. The heredoc pass's own residuals hold:
#    a second heredoc opened on one line, and a `<<-` terminator indented
#    with tabs, which runs the body to the end of the command. An unquoted
#    delimiter's body is skipped too, so a `$(… &)` bash would run there is
#    unseen.
#  - It cannot see that it is in a SUBAGENT. Detaching is wrong there too.
#  - The `WFC_SUITE_DETACH` escape is OR-ed across segments, so a command
#    holding one escaped suite launch and one unescaped detached one is
#    exempted whole.
#  - `detaches` reads the WHOLE command string where `is_test` reads a segment, so
#    an unrelated detachment anywhere on a command carrying a suite launch denies
#    it: `sleep 1 & npm run test` is refused.
#  - THE WRAPPER CLASS IS NOT CLOSED, so `is_test` reads a word the strip left
#    standing and the launch goes unjudged. `sh` is not a wrapper `gp_unwrap`
#    strips, so `sh -c "…"` stands as itself with its payload blanked to a
#    $QUOTED sentinel; a heredoc's body is dropped as data by
#    lib/guard-parse.sh's heredoc pass, leaving only the opener line's own
#    segments. The rest of the residual is `gp_unwrap`'s own, listed in
#    its header (lib/guard-parse.sh).
#  - `strip_detachment` is as LEXICAL as `detaches`: a `&` inside a quoted
#    string outside a heredoc is rewritten too, and a detachment it cannot see
#    is left standing.
#  - The detachment limb carves out no bounded run. `node scripts/run-vitest.js
#    foo.test.ts &` is denied like any other; only the timeout limb exempts it.
#  - A runner other than vitest — `pytest &`, `node --test &` (#1528) — meets
#    the detachment limb alone. The timeout limb reads no bound on one, so
#    `timeout 60 pytest` passes.
#  - A `timeout` inside an `env -S` string is unseen by the timeout limb: the
#    words read are the segment's own, and the string's are one quoted span.
#    One outside it is seen and stripped, the wrappers ending at that span.
#  - The bounded reading carries lib/suite-bounded.sh's own residuals.
#  - `strip_timeout` re-joins the segment's words on single spaces, so a
#    timed segment's own spacing is not kept in line one.
#
# FAILS OPEN on an unreadable payload, recorded via lib/guard-log.sh — mantahostels#103 §6.
#
# IMPLICIT: it refuses a suite launch detached inside the shell, and an
#   unbounded one wrapped in a shell `timeout`, and emits nothing at all on the
#   pass path.
# JUSTIFIED: fail-safe — the launch is the last moment at which the wake can
#   still be arranged, and a session that stalls for want of one never learns it
#   did; a shell-timed suite killed at its clock leaves no result to read.
# DEFEAT:    `WFC_SUITE_DETACH=1` or `WFC_SUITE_TIMEOUT=1` as a prefix on the
#   command, one per limb; deleting the
#   registration from self-plugin/hooks/hooks.json silences it.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null

# shellcheck source=scripts/lib/suite-bounded.sh
source "$here/lib/suite-bounded.sh" 2>/dev/null
# A failed source reads every wrapper run as bounded: the timeout limb fails open.
declare -F launch_is_bounded >/dev/null || {
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "lib/suite-bounded.sh did not load — every run-vitest.js launch read as bounded"
  launch_is_bounded() { return 0; }
}
# shellcheck source=scripts/lib/suite-launch.sh
source "$here/lib/suite-launch.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every suite allowed detached"
  exit 0
}
declare -F suite_launch_kind >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/suite-launch.sh did not load — every suite allowed detached"
  exit 0
}

gp_begin '.tool_input.command' command

# `run_in_background` is deliberately never read — see SCOPE.
raw="$(gp_payload_field '.tool_input.command')" || raw=""

# Whether the command detaches the work from the tool call.
#
# The LEADING class admits `/` so `/usr/bin/nohup` is caught; the TRAILING class
# excludes `.` and `-` so `scripts/nohup-helper.test.ts` and `--grep nohup.json`
# are not.
#
# THE BARE `&` IS MATCHED BY SUBTRACTION rather than by parsing: every operator
# spelling an `&` without detaching anything is blanked first, and any `&` still
# standing detaches something.
detaches() {
  local s="$1"
  grep -qE '(^|[^[:alnum:]_-])(nohup|setsid|disown)([^[:alnum:]_.-]|$)' <<<"$s" && return 0
  s="${s//&&/  }"
  s="${s//&>/  }"
  s="${s//|&/  }"
  s="${s//>&/  }"
  s="${s//<&/  }"
  [[ "$s" == *"&"* ]]
}

# The command as the deny's first line re-issues it (header: THE DENY OPENS).
# The operators `detaches` blanks are shielded first and put back last, so only
# a detaching `&` is touched. Its word boundary is narrower than `detaches`':
# a word it deletes must follow a space, an operator or a `/`-path, where a
# test may afford to over-match. A subshell body, for the `shopt`: bash 5.2 reads
# an unquoted `&` in a `${s//…/…}` replacement as the match.
strip_detachment() (
  shopt -u patsub_replacement 2>/dev/null
  local s="$1"
  s="${s//&&/$'\x02'}"
  s="${s//&>/$'\x03'}"
  s="${s//|&/$'\x04'}"
  s="${s//>&/$'\x05'}"
  s="${s//<&/$'\x06'}"
  s="$(sed -E \
    -e 's#(^|[[:space:];|&(])(/[^[:space:]]*/)?(nohup|setsid)([[:space:]]+-[^[:space:]]+)*([[:space:]]+|$)#\1#g' \
    -e 's#(^|[[:space:];|&(])disown([[:space:]]+[^[:space:];|&]+)*[[:space:]]*#\1#g' \
    -e 's#&[[:space:]]*(;|$)#\1#g' \
    -e 's#&#;#g' \
    -e 's#[[:space:]]+$##' <<<"$s")"
  s="${s//$'\x02'/&&}"
  s="${s//$'\x03'/&>}"
  s="${s//$'\x04'/|&}"
  s="${s//$'\x05'/>&}"
  s="${s//$'\x06'/<&}"
  printf '%s' "${s#"${s%%[![:space:]]*}"}"
)

# $raw into $held_raw, each line gp_heredoc_lines names replaced by a
# sentinel holding its number, its text kept in $held. `put_back_heredocs`
# reverses it on any text the sentinels survived.
held=()
hold_heredocs() {
  local -a lines
  local n
  mapfile -t lines <<<"$raw"
  for n in ${_gp_heredoc_lines+"${_gp_heredoc_lines[@]}"}; do
    held[n]="${lines[n]}"
    lines[n]=$'\x07'"$n"$'\x07'
  done
  local IFS=$'\n'
  held_raw="${lines[*]}"
}

put_back_heredocs() {
  local s="$1" n
  for n in "${!held[@]}"; do
    s="${s/$'\x07'"$n"$'\x07'/"${held[n]}"}"
  done
  printf '%s' "$s"
}

# Every kind lib/suite-launch.sh knows, `npm-py` included — see SCOPE.
is_test() { suite_launch_kind "$@"; }

# Whether the launch has no upper bound on its selection: an `npm test`,
# `npm run test`, `test:changed` or `run-vitest.js` naming no test file.
# A `--full=<cause>` rides on one of those. Reads the kind the `is_test` just
# before it on the same words left set.
is_unbounded() {
  [[ "$_sl_kind" == wrapper || "$_sl_kind" == npm-vitest ]] || return 1
  # shellcheck disable=SC2251 # the negated status is the return value; no -e here.
  ! launch_is_bounded "$@"
}

# The masked segment with every `timeout`, its flags and its duration taken
# off the wrappers in front of the command word, or non-zero where those
# wrappers cannot be placed in the segment's text. The segment's outer
# whitespace and its redirections are kept.
strip_timeout() {
  local seg="$1" lead trail word nwrap i
  local -a seg_words kept=()
  shift
  read -ra seg_words <<<"$seg"
  # The wrappers end at the command word — or, where an `env -S` string was
  # split into the command, at the first quoted word, the string itself.
  for ((nwrap = 0; nwrap < ${#seg_words[@]}; nwrap++)); do
    [[ "${seg_words[nwrap]}" == "$1" || "${seg_words[nwrap]}" == *"$QUOTED"* ]] && break
  done
  ((nwrap < ${#seg_words[@]})) || return 1
  set -- "${seg_words[@]:nwrap}"
  for ((i = 0; i < nwrap; i++)); do
    word="${seg_words[i]}"
    if [[ "${word##*/}" != timeout ]]; then
      kept+=("$word")
      continue
    fi
    while ((i + 1 < nwrap)) && [[ "${seg_words[i + 1]}" == -* ]]; do
      case "${seg_words[i + 1]}" in
        -k | --kill-after | -s | --signal) i=$((i + 2)) ;;
        *) i=$((i + 1)) ;;
      esac
    done
    i=$((i + 1))
  done
  lead="${seg%%[![:space:]]*}"
  trail="${seg##*[![:space:]]}"
  kept+=("$@")
  printf '%s%s%s' "$lead" "${kept[*]}" "$trail"
}

# Not local: gp_walk_commands runs no subshell, so what a segment sets here is
# read after the walk.
found_suite=0
escaped=0
# Each timed segment as written, and the same less its `timeout`, paired.
timed_from=()
timed_to=()

note_suite() {
  local seg="$1" word stripped timed=0
  shift
  local -a words=("$@")
  gp_unwrap "$@"
  set -- "${_gp_unwrapped[@]}"
  # An `env -S` split can leave more words than it took, so none are read there.
  local nwrap=$((${#words[@]} - $#))
  ((nwrap > 0)) && for word in "${words[@]:0:nwrap}"; do
    [[ "${word##*/}" == timeout ]] && timed=1
  done
  (($#)) || return 0
  is_test "$@" || return 0
  gp_carries_var WFC_SUITE_DETACH "${words[@]}" && escaped=1
  found_suite=1
  ((timed)) || return 0
  is_unbounded "$@" || return 0
  gp_carries_var WFC_SUITE_TIMEOUT "${words[@]}" && return 0
  stripped="$(strip_timeout "$seg" "$@")" || {
    gl_log "strip_timeout could not place the wrappers — the deny re-issues the segment as typed"
    stripped="$seg"
  }
  timed_from+=("$(gp_as_written "$seg")")
  timed_to+=("$(gp_as_written "$stripped")")
  return 0
}

gp_walk_commands note_suite
gp_heredoc_lines
hold_heredocs

detached=0
((found_suite)) && ((!escaped)) && detaches "$held_raw" && detached=1
((detached || ${#timed_from[@]})) || gp_allow

fix="$held_raw"
for i in "${!timed_from[@]}"; do
  fix="${fix//"${timed_from[i]}"/"${timed_to[i]}"}"
done
((detached)) && fix="$(strip_detachment "$fix")"
fix="${fix#"${fix%%[![:space:]]*}"}"
fix="$(put_back_heredocs "$fix")"
[[ -n "$fix" ]] || {
  gl_log "the re-issue came out empty — the deny re-issues the command as typed"
  fix="$raw"
}

reason="Run instead, in the foreground with the Bash tool's \`timeout: 600000\`: ${fix}"
((detached)) && reason+="
This suite is DETACHED INSIDE THE SHELL — \`&\`, \`nohup\`, \`setsid\` or \`disown\` — so the call registers no job for the run and nothing will ever tell you it ended. \`run_in_background\` with a detachment does not help: the job is then the wrapper shell, which exits at once. An overrun is moved to the background and notifies: then end the turn with NO tool call — a notification arriving mid-call is almost never delivered. A \`--full=<cause>\` or \`--queue\` run may overrun, so wrap it in \`$(gp_script_path bg-run.sh) run <name>\` in the same call: a \`killed\` notification often lies, so before relaunching read \`$(gp_script_path bg-run.sh) check <name>\`, which tells KILLED from DONE. If guard-suite-concurrency.sh refuses the re-issue, no job exists: take its corrected command rather than reporting \`waiting:\`. Genuinely need the detachment? Prefix the command with \`WFC_SUITE_DETACH=1\`."
((${#timed_from[@]})) && reason+="
This suite is WRAPPED IN A SHELL \`timeout\`, which kills it with no result and no pass/fail marker when the clock runs out — and the clock counts time spent waiting in the \`--queue\` too. The Bash tool's own timeout does not kill it: an overrun is moved to the background and notifies, and you end the turn with NO tool call. If guard-suite-concurrency.sh refuses the re-issue, take its corrected command. A run naming its own test files is not refused. Genuinely need the shell timeout? Prefix the command with \`WFC_SUITE_TIMEOUT=1\`."
gp_deny "$reason"
