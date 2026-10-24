#!/usr/bin/env bash
# PreToolUse guard: stop a session waiting by looking (mantahostels#627, widened at mantahostels#659).
#
# Why: a notification arriving while a tool call is in flight is folded into
# that call's result and read — 97% on the forensics window (workflow-core#845, which
# overturned mantahostels#2516's 0.7%; https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md).
# So a poll learns nothing the notification would not bring, and each look is
# a full-context turn: that cost is what the three-look cap below rests on. The rule: while something runs in the
# background, END THE TURN — a turn ends with text and NO tool call at all.
#
# FIVE ROUTES, one rolling 5-minute window per session — and per subagent, each
# its own (workflow-core#1169), since a subagent's payload carries its parent's session_id.
# Counted per key:
#   agents      a ListAgents call.                       Allowance 2.
#   read:<file> a Read of a background job's output file Allowance 2.
#               (a path under tasks/ ending .output).
#   check       a Bash call opening `sleep <n>` — the    Allowance 3.
#               timed ARTEFACT check, watching a subagent.
#   check:job   a Bash call opening `sleep <n>` whose     Allowance 3.
#               tail runs `bg-run.sh check` — the timed
#               JOB beat, watching a background job.
#   noop        a Bash call whose whole command is inert Allowance 1.
#               (`true`, `:`, `exit`, `exit 0`).
# The first N pass — a name lookup, a status check, one first read of a result.
# Past it, `agents`, `read:<file>` and `noop` are denied; `check` and `check:job`
# are allowed with a cadence warning. Keys never evict each other: reading two
# different output files twice each is four calls and no deny, because neither
# file was re-read a third time.
#
# `noop` gets 1 because, unlike the others, it has no legitimate first use:
# nothing is learned by running `true`. Its only caller is a session trying to
# end a turn by calling a tool, which is the thing that cannot work.
#
# THE TWO TIMED WATCHES NEVER DENY (workflow-core#482). `check` is the hand-timed artefact
# check, `sleep <n>; wc -c <artefact>`, which watch-artefact.js (workflow-core#539) replaces
# and its warning names; `check:job` is docs/agents/rules/killed-background-job.txt's
# `sleep <n>; scripts/bg-run.sh check <name>`, with an allowance of its own
# (mantahostels#2590). A refusal there punished the rule it enforced (workflow-core#482), so
# past the allowance each now warns through
# additionalContext that the cadence is under two minutes, and the call runs.
# The allowance is 3 so the prescribed cadence never meets it: at `sleep 120`
# only two checks start inside the five-minute window, and a third means a
# cadence under ~100 seconds. Backgrounding exempts neither: this guard leaves
# `run_in_background` unread — guard-bg-job.sh is the one that reads it — and
# judges on cadence alone.
#
# deny-timing: delayed — the deny arrives on the THIRD poll, so a session that
# never read the rule has already polled twice by the time this text reaches it.
# CLAUDE.md's copy is the only one that arrives in time: do not cut it (mantahostels#964,
# which settled that test).
#
# DENY on the other three routes. mantahostels#103 set the house rule for the Bash guards:
# deny on a structured fact where the action has no legitimate use, warn where
# the hook is inferring. The call count is a structured fact; the wait loop it
# implies is an inference. Deny wins anyway because a warn cannot stop the
# failure — the loop's cost is paid per call, and a session that has already
# ignored the rule in prose will ignore a warning too. Each refusal opens with
# the corrected command (workflow-core#482). The timed watches are the exception, above.
# This guard cannot tell a suite's output file from any other job's, so the
# `read:` refusal's first line names all three one-call waits (workflow-core#545): the
# watcher for a subagent, the foreground suite (docs/agents/guard-registry.md §Machine limits),
# and `bg-run.sh wait`.
#
# Split into two registrations (mantahostels#2811). The Read and ListAgents
# routes are unnarrowed, being cheap to classify and having no command to match
# on. The Bash routes carry `if: Bash(*sleep *)`, `if: Bash(true*)`,
# `if: Bash(:*)` and `if: Bash(exit*)`, which between them cover every ORDINARY
# spelling the three Bash routes above classify. The residual is leading
# whitespace: the route regexes below tolerate it, the three anchored patterns
# cannot, and whether the harness trims a segment before matching is unmeasured
# — so a command opening with a space or a tab may reach no guard at all. On the
# calls it does run on, everything before the state handling below exits 0
# without touching the clock or the filesystem.
#
# LIMITS — five, all deliberate:
#   * It counts calls, never intent. A session with a real reason to look three
#     times in five minutes is refused alongside the loop; the refusal costs it
#     a wait, not the work.
#   * A `sleep 1; wc -c` loop — the evasion the timed-watch count was built to
#     catch — is warned, not stopped.
#   * It cannot see whether other tools ran in between, so an interleaved call
#     counts the same as a back-to-back one.
#   * A poll spelled some other way — `cat`/`wc` on the output file with no
#     leading sleep, a `tail -f`, a script that reads it — is a route this hook
#     does not classify. CLAUDE.md covers it; nothing enforces it.
#   * A session that narrates "waiting" while calling no tool at all is
#     untouched — no hook observes silence.
#
# A SUBAGENT IS TOLD OTHERWISE (workflow-core#1169). Its turn ending is its work ending —
# nothing wakes it to resume — so where the parent is told to end the turn, a
# subagent is told to wait inside it, in gp_subagent_wait_text's words (workflow-core#1735).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh" 2>/dev/null

declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every poll allowed unchecked"
  exit 0
}

# The subject is the session, not a command: gp_begin wants a field present on
# every payload, and session_id is it. gp_begin itself fails open — and records
# it — on a payload that is empty, unparseable, or carries no session_id, so
# there is no empty-subject case left to test for here.
gp_begin '.session_id' "poll check"
session="$(gp_subject)"

# `main` for the parent's own calls, `a<agent_id>` for a subagent's, sanitised.
# A payload gp_agent_label cannot answer for reads as the parent, which at worst
# shares the parent's window.
agent="$(gp_agent_label "counted as the parent")"

# WHICH ROUTE. An unrecognised tool, an ordinary Read and an ordinary Bash call
# all leave here without recording anything. An absent tool_name reads as
# ListAgents: that is the payload shape this guard was built against, and a
# guard that classified it as "other" would silently stop guarding the tool it
# was written for.
tool="$(gp_payload_field '.tool_name')"
file="$(gp_payload_field '.tool_input.file_path')"
command_line="$(gp_payload_field '.tool_input.command')"

# An absent tool_name is read as ListAgents ONLY where the payload carries no
# tool input either. Reading it as ListAgents unconditionally would fold a real
# Bash or Read call into that bucket and eventually deny it, quoting a reason
# about polling ListAgents at a session that never called it.
[[ -n "$tool" ]] ||
  { [[ -z "$file$command_line" ]] && tool="ListAgents"; }

key=""
allowance=2
case "$tool" in
  ListAgents)
    key="agents"
    ;;
  Read)
    # A background job's output file, wherever the harness puts it.
    [[ "$file" == */tasks/*.output ]] || exit 0
    key="read:${file##*/}"
    ;;
  Bash)
    # The WHOLE command must be inert. `make || true` runs make; only a command
    # that is nothing but the no-op is a turn-end that is not one.
    if [[ "$command_line" =~ ^[[:space:]]*(true|:|exit([[:space:]]+0)?)[[:space:]]*\;?[[:space:]]*(\#.*)?$ ]]; then
      key="noop"
      allowance=1
    elif [[ "$command_line" =~ ^[[:space:]]*sleep[[:space:]]+[0-9] ]]; then
      # The job beat names bg-run.sh; anything else is the artefact check. A
      # watch spelled some third way lands in `check`.
      if [[ "$command_line" =~ bg-run\.sh[[:space:]]+check([[:space:]]|$) ]]; then
        key="check:job"
      else
        key="check"
      fi
      allowance=3
    else
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

# Keyed per session, outside the repo: this is scratch state, never an artefact.
# A session id reaches the filesystem here, so strip anything that is not a
# plain identifier rather than trusting it as a path segment. The key reaches
# only a field inside that file, but shares the sanitiser: a tab or a newline in
# it would split one record into two. A subagent's file is its session's plus
# `.a<agent_id>`; the sanitised session holds no `.`, so no session's file can
# be mistaken for one.
safe_session="${session//[^A-Za-z0-9_-]/_}"
key="${key//[^A-Za-z0-9_.:-]/_}"
state_dir="${TMPDIR:-/tmp}/wfc-agent-poll"
state_file="$state_dir/$safe_session"
[[ "$agent" == main ]] || state_file+=".$agent"

# Cannot record => cannot judge. Fail open, but on the record: an unwritable
# TMPDIR would otherwise leave a disarmed guard looking exactly like a guard
# that keeps finding nothing wrong (the mantahostels#147 contract in lib/guard-log.sh).
mkdir -p "$state_dir" 2>/dev/null ||
  gl_open "could not create $state_dir — poll allowed unchecked"

# A clock that will not answer must fail OPEN. Left unguarded an empty `now`
# arithmetically reads as 0, every stored stamp then counts as recent, and the
# guard starts denying from the second call — failing closed, which mantahostels#103 bars.
now="$(date +%s 2>/dev/null)"
[[ "$now" =~ ^[0-9]+$ ]] ||
  gl_open "could not read the clock — poll allowed unchecked"

window=300 # 5 minutes

# Keep every call still inside the window, whatever its key — one route's
# allowance must not be spent by another's. Count only this call's own key.
recent=()
# Not `seen`: lib/guard-parse.sh declares a `local -A seen`, and shellcheck's
# `-x` source-following ignores `local`, so that name reads here as an array.
hits=0
if [[ -f "$state_file" ]]; then
  while IFS=$'\t' read -r stamp line_key; do
    [[ "$stamp" =~ ^[0-9]+$ ]] || continue
    ((now - stamp < window)) || continue
    recent+=("$stamp"$'\t'"$line_key")
    [[ "$line_key" == "$key" ]] && ((hits++))
  done <"$state_file"
fi

warning=""
if ((hits >= allowance)); then
  case "$key" in
    check:job | check)
      if [[ "$key" == check:job ]]; then
        lead="Timed job beats under two minutes apart"
        next="space the next to \`sleep 120\` or more"
        ceiling="stop waiting only on a beat no newer than the last landing's, or on KILLED or UNKNOWN twice — then say the job is lost and proceed without it."
      else
        lead="Timed checks under two minutes apart"
        next="replace the next with one backgrounded \`node $(gp_script_path watch-artefact.js) <artefact> 120\`"
        ceiling="two consecutive checks with no growth means abandon that agent and proceed without it."
      fi
      warning="$lead: more than $allowance inside five minutes. This one runs; $next. Act on what it says: $ceiling Meanwhile end the turn — the backgrounded watch is what wakes this session, and it cannot while a tool call of yours is in flight."
      ;;
    noop)
      IFS= read -r -d '' reason <<'EOF' || :
Ending a turn is not a tool call. A no-op command like `true` re-invokes this session — which is why the loop it is meant to break keeps going. End the turn by emitting your final text with NO tool call at all, and stop: @NOTIFIED@, so each no-op is a full-context turn spent learning nothing.
EOF
      ;;
    read:*)
      reason="Instead: a subagent, one backgrounded \`node $(gp_script_path watch-artefact.js) <artefact> 120\`; your next suite, in the foreground with \`timeout: 600000\`; a bg-run.sh job, \`$(gp_script_path bg-run.sh) wait <name>\`. Then end the turn."$'\n'
      IFS= read -r -d '' rest <<'EOF' || :
Re-reading a background job's output file is a wait loop: @NOTIFIED@, so each re-read is a full-context turn spent for nothing.
EOF
      reason+="$rest"
      ;;
    *)
      reason="Instead: one backgrounded \`node $(gp_script_path watch-artefact.js) <artefact> 120\` on the subagent's artefact, then end the turn."$'\n'
      IFS= read -r -d '' rest <<'EOF' || :
Polling ListAgents. Two calls already in the last five minutes is the shape of a wait loop: @NOTIFIED@, so each poll is a full-context turn spent for nothing. Never narrate "waiting". The elapsed-time column is stale, so the poll does not read true either.
EOF
      reason+="$rest"
      ;;
  esac
  if [[ "$agent" != main ]]; then
    wait_in="$(gp_subagent_wait_text)"
    case "$key" in
      # The artefact check's ceiling abandons a watched subagent, which a
      # subagent never has; the job beat's still says when to stop waiting.
      check) warning="$lead: more than $allowance inside five minutes. This one runs; then $wait_in" ;;
      check:job) warning="$lead: more than $allowance inside five minutes. This one runs; then $wait_in Waiting on beats instead, $ceiling" ;;
      noop) why="A no-op like \`true\` waits on nothing. If your work is done, return your final report." ;;
      read:*) why="Re-reading a background job's output file is a wait loop, each re-read a full-context call spent for nothing." ;;
      *) why="Polling ListAgents is a wait loop, and its elapsed-time column is stale." ;;
    esac
    [[ -n "$warning" ]] || reason="Instead: $wait_in"$'\n'"$why"
  fi
  if [[ -z "$warning" ]]; then
    # The parent's heredocs are quoted, so they hold gp_parent_wait_text's
    # place rather than calling it (workflow-core#1779).
    reason="${reason//@NOTIFIED@/$(gp_parent_wait_text)}"
    # Deliberately do NOT record a denied call: a denied call is not a poll, and
    # recording it would keep the window alive forever under a retry loop.
    gp_deny "$reason"
  fi
fi

# One file per session would otherwise accumulate for the life of the host.
# Bounded work: the sweep only ever visits this guard's own directory.
find "$state_dir" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null

recent+=("$now"$'\t'"$key")
# A warned watch ran, so it is recorded too: the warning keeps firing for as
# long as the cadence stays under two minutes. A failed write loses the record,
# never the warning.
if ! aw_write "$state_file" printf '%s\n' "${recent[@]}" 2>/dev/null; then
  gl_log "could not write $state_file — this call went unrecorded"
fi
[[ -n "$warning" ]] && gp_warn "$warning"
exit 0
