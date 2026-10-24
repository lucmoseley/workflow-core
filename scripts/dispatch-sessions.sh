#!/usr/bin/env bash
# Launch a /pick-next dispatch set, each session on the model its kind calls
# for, and only as many of them as allowance remains for (workflow-core#369).
#
# Three facts this rests on, on Claude Code 2.1.241:
#   - `claude --bg --model <alias> "<prompt>"` starts one background
#     agents-view session on that model and returns immediately. It is
#     per-session; `claude agents --model` by contrast sets a view-wide
#     default and would move every launch made from that view (mantahostels#1153).
#   - `--advisor <alias>` is a real flag, undocumented in `--help`. Why this
#     rather than the `advisorModel` setting or `/advisor`: mantahostels#1102, and
#     `docs/effort-guide.md` §Claude Code specifics.
#   - `claude -p "/usage"` refreshes `cachedUsageUtilization` in
#     `$CLAUDE_CONFIG_DIR/.claude.json` — the allowance gate's primary source
#     (workflow-core#280, workflow-core#294) — and also prints both rate-limit bars, read as a fallback
#     when that JSON reading is not fresh. It is a local command, so it spends
#     no model tokens and reads no credentials. Adding `--debug --debug-file`
#     to that same call reports whether the advisor is live here, at no extra
#     cost (mantahostels#1102). `scripts/usage-probe.js` makes the call, and
#     skips it while the cache is fresh (workflow-core#2306).
#
# AN OVERFLOW SEAT (workflow-core#2570) has no plan bars and no `claude --bg`: its
# Console credits cover `claude -p` alone. Under one, the `/usage` probe, the
# advisor check and the allowance cap are skipped; the key's budget gate
# (lib/overflow-budget.js) sizes the set instead, and each member launches
# through lib/headless-sessions.js, capped at the key's headroom at launch.
# Only Opus launches there (workflow-core#1920).
#
# Usage:
#   scripts/dispatch-sessions.sh [--dry-run] [--force] [--force-memory] \
#       [--no-advisor] <model> <prompt> [...]
#
# --force skips the duplicate drop and the allowance cap, but never the
# overflow budget gate (workflow-core#2570); --force-memory
# skips the per-member memory re-read, and nothing else; pass both to skip all
# three. Split at workflow-core#281: an allowance override must not disarm the memory gate,
# whose breach freezes the machine. Neither disarms the CPU load ceiling
# (workflow-core#830, workflow-core#834): --force-memory still re-reads the load before each spawn, and
# only WFC_LOAD_CEILING=0 turns it off.
#
# A prompt may be neither empty nor multi-line: the per-member drop list is
# indexed by line, so either one shifts every index after it and drops the
# wrong session.
#
# Example:
#   scripts/dispatch-sessions.sh \
#     sonnet "/implement 341 353" \
#     opus   "/wayfinder 1114"
#
# A set is recorded to `.pick-next/dispatched.jsonl` as it launches. A MEMBER
# whose issues are already running, or were launched moments ago, is dropped
# and named; the rest still launch (mantahostels#1337).
#
# The allowance CAP (workflow-core#371) drops the set's tail, once, before any spawn: past
# 90% of the 5-hour bar or 97% of the week, only the prefix projected to just
# reach 100% of that bar launches — at least one while the bar reads under
# 100% — and each cut member is named.
#
# A THIRD MEMBER-LEVEL DROP (mantahostels#2553): `node scripts/admission.js` re-reads
# memory immediately before EACH spawn — the allowance gate below reads it
# once, before the whole set, and cannot see what an earlier member in the
# SAME set has just warmed. A member the re-read refuses is named on stderr
# and skipped, same as a duplicate; the rest still launch. Staggered by
# WFC_DISPATCH_STAGGER_SECONDS between launches (default 2; mantahostels#2588)
# so the next member's re-read sees the previous one's bg-spare.
#
# WFC_UNION_WRAPPER names the multi-plan liveness wrapper this script falls back
# to when WFC_CLAUDE_BIN is unset (see that var's own comment below). Default
# $HOME/.local/bin/claude-agents-union; point it elsewhere, or at a path that
# does not exist, to keep a run off the machine's real one.
#
# Exit codes: 0 launched (or dry-run; a member dropped by either drop above
#             still exits 0, as does a set the allowance cap cut short),
#             2 usage error, a seat file that refuses, or a non-Opus member
#               on an overflow seat, 3 refused on allowance — a warned bar
#               reads 100%, the cap cannot be sized, no trustworthy reading,
#               or an overflow budget that fits none or cannot be read,
#             4 refused as dispatched — either because EVERY member was, or
#               because the drop list could not be read,
#             5 refused on a wedged WSL interop bridge (mantahostels#3111) or an RCU
#               stall this boot (workflow-core#867). A --dry-run can exit 5 too: both
#               checks run before the gates.
set -uo pipefail

# THE INTEROP PROBE (mantahostels#3111). A wedged WSL bridge makes `claude --bg` below never
# return. The guard that catches this interactively is a shell FUNCTION
# (scripts/claude-interop-guard.sh) and this script runs the bare binary from a
# non-interactive shell, so it sources the guard's probe library directly.
#
# Fails OPEN, unlike every other gate here: a missing library, a missing
# reg.exe or a non-WSL machine all launch as before.
# shellcheck source=scripts/lib/interop-probe.sh
source "$(dirname "$0")/lib/interop-probe.sh" 2>/dev/null
# shellcheck source=scripts/lib/script-path.sh
source "$(dirname "$0")/lib/script-path.sh"

# Every member launched so far, for the refusal below to name.
launched_prompts=()

# Names what was dispatched, then exits 5. The re-run remedy for members that
# did launch is passed one line per argument.
exit_refused_naming_launched() {
  if [[ ${#launched_prompts[@]} -eq 0 ]]; then
    printf '  Nothing was recorded as dispatched. Re-run this command after the shutdown.\n' >&2
  else
    printf '  %d member(s) HAD already launched and are recorded as dispatched:\n' \
      "${#launched_prompts[@]}" >&2
    printf '    %s\n' "${launched_prompts[@]}" >&2
    printf '  %s\n' "$@" >&2
  fi
  exit 5
}

# Refuses the WHOLE call on a wedged bridge: every member after this one would
# hang the same way, and a ledger entry for a session that never started refuses
# its real dispatch later.
refuse_if_interop_wedged() {
  command -v claude_interop_wedged >/dev/null 2>&1 || return 0
  claude_interop_wedged || return 0
  printf 'REFUSED: the WSL interop bridge is wedged, so `claude` would hang rather than launch.\n' >&2
  claude_interop_recovery_text
  exit_refused_naming_launched \
    'Re-run with the remaining members only, or --force: re-running the whole' \
    'command is refused by the duplicate gate on the ones above.'
}

# Refuses the WHOLE call on an RCU stall this boot (workflow-core#867). The checker exits 1
# on a stall alone; any other failure launches.
refuse_if_kernel_stalled() {
  local report status
  report=$(node "$(dirname "$0")/check-kernel-stall.js" 2>&1 >/dev/null) && return 0
  status=$?
  if [[ $status -ne 1 ]]; then
    printf 'note: the kernel-stall check could not run (exit %s), so this launch is unchecked for one.\n' \
      "$status" >&2
    return 0
  fi
  printf 'REFUSED: the WSL kernel has reported an RCU stall this boot, so the VM is dying.\n' >&2
  printf '%s\n' "$report" >&2
  exit_refused_naming_launched \
    'The shutdown ends them too, so re-run with --force: the duplicate gate' \
    'refuses the ones above otherwise.'
}

# At or above these percentages the set is CAPPED rather than launched whole
# (workflow-core#369, workflow-core#371): only as many members launch as are projected to just reach
# 100% of the warned bar, counting what the sessions already running are
# expected to spend yet. Override per-run with the env vars; the per-session
# figures live in `scripts/lib/allowance.js`.
WEEK_CEILING="${WFC_DISPATCH_WEEK_CEILING:-97}"
SESSION_CEILING="${WFC_DISPATCH_SESSION_CEILING:-90}"

# Seconds between one launch and the next in the loop below (mantahostels#2553). The
# allowance gate above reads memory ONCE, before the set launches, and cannot
# see the ~400 MB bg-spare the daemon warms per member AFTER admission has
# spoken. The per-member re-read below fixes the "once for the set" half of
# that gap; this interval gives each spare time to become resident before the
# NEXT member's re-read counts it.
#
# MEASURED (mantahostels#2588): 2 is a 0.68 s plateau with a 3x margin, and
# the margin is what the reading does not cover — ONE probe, on a warm page
# cache, on this machine. A cold start is the way it could be short.
#
# Being short is bounded rather than fatal: `--launch` below charges for the
# pair whether or not it is resident yet, so a member that arrives before the
# previous one's spare lands is charged twice, never zero.
#
# Re-measure with `node scripts/measure-spare-warm.js --probe --json` — a real
# background-session allowance, so a founder call, not this script's to make
# unasked. Several readings, not one.
STAGGER_SECONDS="${WFC_DISPATCH_STAGGER_SECONDS:-2}"

# Ceiling on a single `claude --bg` spawn (mantahostels#3111). A launch returns in well
# under a second, so 120 is margin rather than a budget; what it buys is that a
# launch which has not returned is killed and reported instead of awaited
# indefinitely. Empty where `timeout` is missing — the launcher fails open on
# this the same way the probe does.
#
# Tempted to drop it: its mutant HANGS the test rather than failing it, which is
# the fault itself. A hung run is the signal here, not a broken test (mantahostels#3111).
LAUNCH_TIMEOUT_SECONDS="${WFC_DISPATCH_LAUNCH_TIMEOUT:-120}"

# The ceiling runs `timeout` without `--foreground`, so it kills the whole
# process group: the launch is piped into `head -1`, and a surviving grandchild
# would hold that pipe open forever (mantahostels#3111). Residual: a `claude`
# that forked a session and only THEN hung loses that session. That is the
# remote case; a hung launcher is the certain one.
launch_ceiling=()
if command -v timeout >/dev/null 2>&1; then
  launch_ceiling=(timeout -k 5 "$LAUNCH_TIMEOUT_SECONDS")
fi

# The `claude` binary, injected at one named point rather than resolved off PATH
# (docs/code-standards-base.md §N7). WFC_CLAUDE_BIN is the var
# `scripts/lib/agent-liveness.js` already reads, not a name of this script's own.
# Exported, so every child reaches the same binary this does, the ledger check
# included. A test that cannot point it at a stub launches real background
# sessions (mantahostels#1374).
#
# The default below is the bare `claude` CLI, whose `agents --json` — read by
# the duplicate gate's live limb below, through agent-liveness.js — is scoped
# to one CLAUDE_CONFIG_DIR. On a machine running several Claude plans (this one:
# `.claude`, `.claude2` and `.claude3`), a session live under ANOTHER plan is
# invisible to it, and its issue can be dispatched a second time — the mantahostels#1337
# failure the gate exists to stop. `~/.local/bin/claude-agents-union` unions all
# plans' listings; `~/.bashrc`'s `ca1`/`ca2`/`ca3` aliases already point this var at
# it — but under MANTA_CLAUDE_BIN, which nothing in this repo reads (workflow-core#277).
#
# So: when the var is unset and that wrapper is a regular executable file on
# THIS machine, take it, and say on stderr which binary was picked. A checkout
# without the wrapper falls through to the bare CLI.
#
# THE RESIDUAL IS A DEGRADED GATE, not a wrong binary. A wrapper that is slow or
# broken leaves the duplicate gate WEAKER than bare `claude` would: it spawns
# three CLI starts against agent-liveness.js's 10s oracle cap, and exits
# non-zero on any non-array listing, so the live limb drops entirely rather than
# answering for one plan.
#
# WFC_UNION_WRAPPER overrides where the lookup points. HOME may legitimately be
# unset under cron or systemd, and dereferencing it bare under `set -u` (above)
# would abort the whole script before any gate — so the probe is skipped rather
# than risked.
wfc_claude_bin_was_unset=0
wfc_claude_bin_autopicked=0
if [[ -z "${WFC_UNION_WRAPPER:-}" && -n "${HOME:-}" ]]; then
  WFC_UNION_WRAPPER="$HOME/.local/bin/claude-agents-union"
fi
WFC_UNION_WRAPPER="${WFC_UNION_WRAPPER:-}"
if [[ -z "${WFC_CLAUDE_BIN:-}" ]]; then
  wfc_claude_bin_was_unset=1
  if [[ -n "$WFC_UNION_WRAPPER" && -f "$WFC_UNION_WRAPPER" && -x "$WFC_UNION_WRAPPER" ]]; then
    WFC_CLAUDE_BIN="$WFC_UNION_WRAPPER"
    wfc_claude_bin_autopicked=1
  fi
fi
export WFC_CLAUDE_BIN="${WFC_CLAUDE_BIN:-claude}"

# Announced here rather than with the unset-warning below, which `--force`
# skips: the selection above is unconditional, so a --force run would otherwise
# swap the launch binary and say nothing. `NOTE:` is a prefix
# .claude/skills/pick-next/SKILL.md §7 tells the calling session to relay.
if [[ $wfc_claude_bin_autopicked -eq 1 ]]; then
  printf 'NOTE: WFC_CLAUDE_BIN was unset; using the union wrapper found on this\n' >&2
  printf '  machine, so the duplicate gate sees every plan: %s\n' "$WFC_CLAUDE_BIN" >&2
fi

# The advisor a Sonnet session gets — the escalation path that makes mantahostels#1093's
# Sonnet arm acceptable between checks.
ADVISOR_MODEL="${WFC_DISPATCH_ADVISOR:-opus}"

# Burn mode (scripts/burn-mode.sh) moves Sonnet spellings to
# `claude-opus-5-5[1m]`; an Opus spelling stays, since the higher effort it
# runs at comes from settings.json, which burn mode has already set. The table
# and the marker's path are lib/burn-mode.js's; the per-member line below
# names each remap, and an unmapped spelling as unmapped, because the table is
# exact-match and `is_known_non_sonnet` above is a deny-list — a spelling
# neither knows launches as written. The advisor is NOT remapped: it attaches
# only to a spelling the remap left as Sonnet, which is none of the known ones.
BURN_LIB="$(dirname "$0")/lib/burn-mode.js"
burn=0
if BURN_MARKER="$(node "$BURN_LIB" marker 2>/dev/null)"; then
  [[ -f "$BURN_MARKER" ]] && burn=1
else
  printf 'WARNING: burn-mode marker path unresolved — launching as if burn mode were off\n' >&2
fi

dry_run=0
force=0
force_memory=0
advisor=1

# One EXIT trap for all three temp files: `trap ... EXIT` REPLACES the
# handler, so a second one would silently leak whichever file the first was
# cleaning up.
drop_file=""
debug_log=""
# Reused across every member of the loop below (mantahostels#3488): only one launch is
# ever in flight, so one file, truncated per member by the redirect that
# writes it, costs nothing extra over three.
launch_out_file=""
cleanup() {
  [[ -n "$drop_file" ]] && rm -f "$drop_file"
  [[ -n "$debug_log" ]] && rm -f "$debug_log"
  [[ -n "$launch_out_file" ]] && rm -f "$launch_out_file"
  return 0
}
trap cleanup EXIT

# The route that actually retires a job stuck in "working" (mantahostels#2588). Both
# refusals below have the same likeliest cause — a slot, or a ledger entry, held
# by a session that will never finish.
#
# HUNG-JOB (alive, listed, silent) is named INLINE, off `admission.js`'s own
# `claude agents --json` read (mantahostels#2598) — that oracle call is already paid for
# by the admission gate itself, so naming the job here spawns none of its own
# at the per-member call site, which already holds admission.js's text output
# in `$1`. GHOST-JOB (no live process at all) is a different test
# `admission.js` does not run, so that one case alone still points at a second
# command.
#
# Once per run: two refused members in one set describe the same machine.
remedy_printed=0
# $1 (optional): admission.js's own TEXT-mode output, already captured by the
# caller (the per-member admission refusal). Where absent (the
# already-dispatched refusal, which never calls admission.js), one bare
# `node admission.js` run supplies it — a SECOND spawn only there, never at
# the site that already paid for the first (mantahostels#2598).
roster_remedy() {
  [[ $remedy_printed -eq 1 ]] && return 0
  remedy_printed=1
  local admission_text="${1:-}"
  # Whether the caller already relayed $admission_text to the founder verbatim
  # (the per-member site does, right above its own call here) — the hung
  # section inside it is then already on screen, and re-printing it here would
  # say the same thing twice.
  local already_shown=1
  if [[ -z "$admission_text" ]]; then
    admission_text="$(node "$(dirname "$0")/admission.js" 2>&1)"
    already_shown=0
  fi
  local hung_lines
  hung_lines="$(printf '%s\n' "$admission_text" | sed -n '/^hung job(s)/,$p')"
  if [[ -n "$hung_lines" ]]; then
    if [[ $already_shown -eq 0 ]]; then
      printf '  A slot or a ledger entry may be held by a job that is alive, listed, and\n' >&2
      printf '  silent — seen on this machine right now:\n' >&2
      printf '%s\n' "$hung_lines" | sed 's/^/  /' >&2
    fi
  else
    printf '  No job currently reads as hung (alive, listed, and silent). A slot or\n' >&2
    printf '  ledger entry may instead be held by a GHOST-JOB — "working" with nothing\n' >&2
    printf '  behind it, or hung before its first turn. Name one:\n' >&2
    printf '    node %s\n' "$(script_path check-ghost-jobs.js)" >&2
  fi
  printf '  Retire one at its roster: workers["<short-id>"] carries pid (the\n' >&2
  printf '  bg-pty-host) and replPid (the bg-spare). Confirm each against\n' >&2
  printf '  /proc/<pid>/stat field 22 (procStart/replProcStart) to rule out pid\n' >&2
  printf '  reuse, then SIGTERM both — the entry leaves the roster and\n' >&2
  printf '  `claude agents --json` within seconds, with no daemon restart.\n' >&2
  # The plan dirs come from lib/plan-dirs.js, the one definition of them (workflow-core#2580),
  # at one `node` spawn per run: `remedy_printed` prints this block once.
  local found=0 scanned=0 plan_dirs
  local d
  if [[ -n "${HOME:-}" ]] && plan_dirs="$(node "$(dirname "$0")/lib/plan-dirs.js" "$HOME" 2>/dev/null | tr '\0' '\n')"; then
    scanned=1
    while IFS= read -r d; do
      [[ -f "$d/daemon/roster.json" ]] || continue
      printf '    roster: %s\n' "$d/daemon/roster.json" >&2
      found=1
    done <<<"$plan_dirs"
  fi
  # Named rather than silent: an empty list here is a machine whose daemon keeps
  # its roster somewhere else, not a machine with no roster.
  if [[ $scanned -eq 0 ]]; then
    printf '    roster: HOME unset or unreadable, so no plan dir was scanned — check:ghost-jobs prints the real path per ghost.\n' >&2
  elif [[ $found -eq 0 ]]; then
    printf '    roster: none under the plan dirs in %s — check:ghost-jobs prints the real path per ghost.\n' "$HOME" >&2
  fi
  return 0
}

# Refuse the whole dispatch as already-launched: exit 4, unless --dry-run, which
# reports and carries on.
refuse_dispatched() {
  printf 'REFUSED: %s\n' "$1" >&2
  [[ $dry_run -eq 1 ]] || exit 4
  printf '  (--dry-run: reporting only, a real run would have exited 4 here.)\n' >&2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    --force-memory)
      force_memory=1
      shift
      ;;
    --no-advisor)
      advisor=0
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
    *) break ;;
  esac
done

if [[ $# -eq 0 || $(($# % 2)) -ne 0 ]]; then
  printf 'usage: %s [--dry-run] [--force] [--force-memory] [--no-advisor] <model> <prompt> [<model> <prompt> ...]\n' "$0" >&2
  exit 2
fi

# Fills `keep` with the first $1 members of the model/prompt pairs after it,
# naming each one cut; the caller then runs `set -- "${keep[@]}"`. Both caps
# below cut the set's tail this way, with no skip-ahead.
keep_first() {
  local n="$1" i j
  shift
  keep=()
  for ((i = 1; i <= $#; i += 2)); do
    j=$((i + 1))
    if (((i + 1) / 2 <= n)); then
      keep+=("${!i}" "${!j}")
    else
      printf '  dropped: %s\n' "${!j}" >&2
    fi
  done
}

# Sonnet gets an advisor; plain Opus/Fable does not. Deny-list, not
# allow-list (mantahostels#1199): only a spelling KNOWN to run as Opus/Fable is skipped —
# `opusplan` and any unrecognised spelling default to getting an advisor.
# Residual: an Opus/Fable spelling missing from this list gets a redundant
# advisor rather than none — the opposite failure from mantahostels#1199, with a warning
# rather than a silent gap. Full-id entries are from `claude --help` and
# docs/effort-guide.md's model-id table.
is_known_non_sonnet() {
  case "$1" in
    opus | opus\[*\] | fable | fable\[*\] | \
      claude-opus-5 | claude-opus-5\[*\] | claude-opus-5-5 | claude-opus-5-5\[*\] | \
      claude-fable-5 | claude-fable-5\[*\] | claude-fable-5-1 | claude-fable-5-1\[*\])
      return 0
      ;;
    *) return 1 ;;
  esac
}

# Spellings known to run as Sonnet — used only to decide whether an
# unrecognised spelling is worth a WARNING, not to gate the advisor itself.
is_known_sonnet() {
  case "$1" in
    sonnet | sonnet\[*\] | claude-sonnet-5 | claude-sonnet-5\[*\] | claude-sonnet-5-5 | claude-sonnet-5-5\[*\] | opusplan | opusplan\[*\])
      return 0
      ;;
    *) return 1 ;;
  esac
}

wants_advisor() {
  [[ $advisor -eq 1 ]] || return 1
  is_known_non_sonnet "$1" && return 1
  return 0
}

# --- interop probe and kernel-stall check ---------------------------------
# BEFORE both gates below, not just before the launches (mantahostels#3111): each of them
# shells out to `claude` too — the duplicate gate for its live oracle, the
# allowance gate under a 120s ceiling — so a wedge caught only in the launch
# loop would be reported minutes late, or not at all.
refuse_if_interop_wedged
refuse_if_kernel_stalled

# --- seat kind -------------------------------------------------------------
# The seat this runs under, from the one reader of `~/.claude/refill-seats`
# (lib/refill-seats.js).
seat_dir="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"
if ! seat_kind="$(node "$(dirname "$0")/lib/refill-seats.js" kind "$seat_dir" 2>/dev/null)"; then
  printf 'REFUSED: the seat file refuses (seat %s):\n' "$seat_dir" >&2
  node "$(dirname "$0")/lib/refill-seats.js" kind "$seat_dir" 2>&1 >/dev/null | sed 's/^/  /' >&2
  exit 2
fi
overflow=0
case "$seat_kind" in
  plan) ;;
  overflow) overflow=1 ;;
  *)
    printf 'REFUSED: the seat %s read as %q, neither plan nor overflow.\n' "$seat_dir" "$seat_kind" >&2
    exit 2
    ;;
esac

# The headless launch passes no --model, so every member gets the seat's
# default, `claude-opus-5-5[1m]`: only that model's spellings are admitted,
# after burn mode's remap.
if [[ $overflow -eq 1 ]]; then
  for ((i = 1; i <= $#; i += 2)); do
    m="${!i}"
    [[ $burn -eq 1 ]] && m="$(node "$BURN_LIB" launch "$m")"
    case "$m" in
      opus | opus\[1m\] | claude-opus-5-5\[1m\]) ;;
      *)
        printf 'REFUSED: %s is an overflow seat, which launches Opus alone (workflow-core#1920); %q is not.\n' \
          "$seat_dir" "$m" >&2
        exit 2
        ;;
    esac
  done
fi

# --- duplicate gate --------------------------------------------------------
# Placed BEFORE the allowance gate on cost: the allowance read spends up to 120
# seconds in `claude -p "/usage"`, and a set that is already running should not
# pay it. Fails OPEN — see check-duplicate-dispatch.js's header for why this
# gate and the allowance gate below fail in opposite directions.
# --dry-run still RUNS the gate and still reports, but never exits on it. The
# check itself writes nothing.
#
# Refusal is per MEMBER, not per set.
#
# The WFC_CLAUDE_BIN-unset warning fires here rather than at the assignment:
# only inside the block that actually reads `agents --json`, so `--force` —
# which skips this gate outright — never gets a false alarm (mantahostels#1401).
if [[ $force -eq 0 ]]; then
  if [[ $wfc_claude_bin_was_unset -eq 1 && $wfc_claude_bin_autopicked -eq 0 ]]; then
    printf 'WARNING: WFC_CLAUDE_BIN is unset and no union wrapper was found at\n' >&2
    printf '  %s, so the duplicate gate'"'"'s live check will\n' \
      "${WFC_UNION_WRAPPER:-<no path: HOME unset>}" >&2
    printf '  only see sessions in this Claude plan'"'"'s config dir. On a machine\n' >&2
    printf '  running more than one plan, set it to the union wrapper or point\n' >&2
    printf '  WFC_UNION_WRAPPER at where that wrapper lives, or a same-issue\n' >&2
    printf '  duplicate under another plan will not be caught. Set\n' >&2
    printf '  WFC_CLAUDE_BIN=claude to silence this on a single-plan machine.\n' >&2
  fi

  prompts=""
  for ((i = 2; i <= $#; i += 2)); do
    if [[ -z "${!i//[[:space:]]/}" ]]; then
      printf 'usage: a launch prompt may not be empty.\n' >&2
      exit 2
    fi
    if [[ "${!i}" == *$'\n'* ]]; then
      printf 'usage: a launch prompt may not contain a newline: %q\n' "${!i}" >&2
      exit 2
    fi
    prompts+="${!i}"$'\n'
  done

  drop_file="$(mktemp -t dispatch-drop.XXXXXX 2>/dev/null)" || drop_file=""

  if ! node "$(dirname "$0")/check-duplicate-dispatch.js" \
    --issues "$prompts" --drop-index-out "$drop_file"; then
    # Fail CLOSED on an unreadable drop file, unlike the check itself: without
    # it there is no way to tell which member offended.
    if [[ -z "$drop_file" || ! -s "$drop_file" ]]; then
      refuse_dispatched "the whole set, because the per-member drop list is unreadable."
    else
      # Read with the shell, not `grep`: this branch exists to fail CLOSED, and
      # a machine with no grep would make it silently launch the whole set
      # (mantahostels#1337).
      declare -A drop_index=()
      while read -r line; do
        [[ -n "$line" ]] && drop_index[$line]=1
      done <"$drop_file"

      keep=()
      idx=0
      for ((i = 1; i <= $#; i += 2)); do
        j=$((i + 1))
        if [[ -n "${drop_index[$idx]:-}" ]]; then
          printf '  dropped: %s\n' "${!j}" >&2
        else
          keep+=("${!i}" "${!j}")
        fi
        idx=$((idx + 1))
      done

      if [[ ${#keep[@]} -eq 0 ]]; then
        # The remedy belongs HERE and not in refuse_dispatched itself: a job
        # stuck in "working" holds its ledger entry, so its issues read as
        # already running. The other caller — an unreadable drop list — has
        # nothing to do with a stuck job, and the recipe there is misdirection.
        # Before the call, not after: refuse_dispatched exits 4.
        roster_remedy
        refuse_dispatched "every member of this set is already dispatched."
      else
        printf 'Launching %d of %d set(s); the rest are already dispatched.\n' \
          "$((${#keep[@]} / 2))" "$(($# / 2))"
        set -- "${keep[@]}"
      fi
    fi
  fi
fi

# Computed AFTER the duplicate gate has dropped its members, so the advisor
# warning describes the sessions that will ACTUALLY launch.
set_wants_advisor=0
unknown_models=()
for ((i = 1; i <= $#; i += 2)); do
  m="${!i}"
  if wants_advisor "$m"; then set_wants_advisor=1; fi
  if [[ $advisor -eq 1 ]] && ! is_known_non_sonnet "$m" && ! is_known_sonnet "$m"; then
    unknown_models+=("$m")
  fi
done

# Printed before the allowance gate so a REFUSED run still reports an
# unrecognised spelling (mantahostels#1199, the ticket that added this warning).
if [[ ${#unknown_models[@]} -gt 0 ]]; then
  printf 'WARNING: unrecognised model spelling(s): %s\n' "${unknown_models[*]}" >&2
  printf '  Treating as Sonnet-equivalent and attaching an advisor. If this runs as\n' >&2
  printf '  Opus/Fable, add it to is_known_non_sonnet() in %s.\n' "$0" >&2
  printf '  If it runs as Sonnet, add it to is_known_sonnet() there to silence this —\n' >&2
  printf '  the advisor already attaches either way.\n' >&2
fi

# --- allowance gate, and the advisor check riding along with it -------------
# Fails CLOSED on allowance: an unparseable reading refuses the launch rather
# than assuming headroom, because the cost of a wrong "plenty left" is a set of
# half-finished sessions, and the cost of a wrong refusal is one --force.
# The advisor check only ever WARNS — a Sonnet session with no advisor still
# runs, just with no escalation path, and that is the founder's call to make.
# So --force silences the REFUSALS below and not the advisor line: --force is
# how you get past a near-full bar, and it would otherwise take the one report
# that the advisor is live with it.
debug_log="$(mktemp -t dispatch-sessions-debug.XXXXXX 2>/dev/null)" || debug_log=""

# The JSON read below is attempted regardless of whether this call ran — a
# failed mktemp above must not turn into an allowance refusal unrelated to
# allowance itself (workflow-core#294 "also in scope").
# Exit 3 is the probe's "none ran, the cache being fresh", which the advisor
# check below reads.
usage=""
probe_ran=0
if [[ $overflow -eq 0 && -n "$debug_log" ]]; then
  usage="$(node "$(dirname "$0")/usage-probe.js" -- --model sonnet \
    --advisor "$ADVISOR_MODEL" --debug --debug-file "$debug_log" 2>/dev/null)"
  [[ $? -ne 3 ]] && probe_ran=1
fi

# --- overflow budget gate --------------------------------------------------
# An overflow seat's set is sized by its key's budget (workflow-core#2609): `fit` is how
# many more sessions its headroom holds at one mean session each. Fails CLOSED
# like the allowance gate.
# $1: the budget JSON. Prints the fields the refusals below name, tab-separated.
budget_fields() {
  jq -r '[.fit, .headroomUsd, .qUsd, .running, .reservedUsd, .exhausted,
    (.nextCycleStart / 1000 | strflocaltime("%Y-%m-%d"))] | @tsv' <<<"$1"
}
# Why the seat fits no session, from the fields budget_fields last read.
no_fit_line() {
  printf 'overflow seat %s fits no session: headroom $%.2f against $%.2f a session ($%.2f held by %s running).' \
    "$seat_dir" "$headroom" "$q_usd" "$reserved" "$n_running"
}
# The seat's budget as JSON, or a REFUSED line naming why not and the reason
# indented under it, on stderr. $1: the REFUSED line's subject.
read_budget() {
  local out
  if ! out="$(node "$(dirname "$0")/lib/overflow-budget.js" --json "$seat_dir" 2>&1)" ||
    ! command -v jq >/dev/null 2>&1 || ! jq -e '.fit | numbers' <<<"$out" >/dev/null 2>&1; then
    printf 'REFUSED: %s: the overflow budget of %s cannot be read:\n' "$1" "$seat_dir" >&2
    printf '%s\n' "${out:-no output}" | sed 's/^/  /' >&2
    command -v jq >/dev/null 2>&1 || printf '  (jq is not installed.)\n' >&2
    return 1
  fi
  printf '%s' "$out"
}
if [[ $overflow -eq 1 ]]; then
  budget_json="$(read_budget "the whole set")" || exit 3
  IFS=$'\t' read -r fit headroom q_usd n_running reserved exhausted resets \
    <<<"$(budget_fields "$budget_json")"
  if ((fit == 0)); then
    if [[ "$exhausted" == "true" ]]; then
      printf 'REFUSED: overflow seat %s: its key is exhausted until %s, Anthropic having refused it for credit.\n' \
        "$seat_dir" "$resets" >&2
    else
      printf 'REFUSED: %s\n' "$(no_fit_line)" >&2
    fi
    printf '  --force does not lift the budget gate; the budget resets %s.\n' "$resets" >&2
    exit 3
  fi
  if ((fit < $# / 2)); then
    printf 'CAPPED: launching %d of %d on the overflow budget of %s (headroom $%.2f, $%.2f a session).\n' \
      "$fit" "$(($# / 2))" "$seat_dir" "$headroom" "$q_usd" >&2
    keep_first "$fit" "$@"
    set -- "${keep[@]}"
  else
    printf 'Budget OK: %s fits %d; headroom $%.2f.\n' "$seat_dir" "$fit" "$headroom"
  fi
fi

if [[ $overflow -eq 0 && $force -eq 0 ]]; then
  # stderr discarded on purpose: a crash here (or a missing jq, checked next)
  # collapses to the same "absent" both bars read on a clean but untrustworthy
  # run, and the refusal below already says that is likely transient — the
  # cases are not worth telling apart in the message the founder sees.
  allowance_json="$(printf '%s' "$usage" | node "$(dirname "$0")/allowance.js" --json \
    --cap "$(($# / 2))" --session-threshold "$SESSION_CEILING" \
    --week-threshold "$WEEK_CEILING" 2>/dev/null)"
  if [[ -z "$allowance_json" ]] || ! command -v jq >/dev/null 2>&1; then
    week_pct=""
    week_trust="absent"
    week_reset=""
    session_pct=""
    session_trust="absent"
    session_reset=""
  else
    week_pct="$(jq -r '.weekly_all.percent // empty' <<<"$allowance_json")"
    week_trust="$(jq -r '.weekly_all.trust' <<<"$allowance_json")"
    week_reset="$(jq -r '.weekly_all.resetsAt // empty' <<<"$allowance_json")"
    session_pct="$(jq -r '.session.percent // empty' <<<"$allowance_json")"
    session_trust="$(jq -r '.session.trust' <<<"$allowance_json")"
    session_reset="$(jq -r '.session.resetsAt // empty' <<<"$allowance_json")"
  fi

  # No trustworthy reading from either source (JSON cache or the printed
  # bars): still refuse, but say the absence is transient rather than
  # implying a real limit — the cache is already the second chance, and no
  # automatic retry follows (workflow-core#280 ruling 4).
  if [[ "$week_trust" != "fresh" || "$session_trust" != "fresh" ]]; then
    printf 'REFUSED: no trustworthy allowance reading (the usage cache is stale or\n' >&2
    printf '  absent, and the printed bars from `claude -p "/usage"` were unparseable).\n' >&2
    printf '  This is likely transient — re-run, or --force.\n' >&2
    exit 3
  fi

  # THE CAP (workflow-core#371). The tail of /pick-next §4's order goes, with no
  # skip-ahead. A cut member is not a freed slot: §7's top-up never refills
  # it. A second call counts the members launched here as running at once
  # (workflow-core#372 measured <=1 s), but still launches one while the bar reads under
  # 100% — the floor applies per call (workflow-core#371).
  cap_error="$(jq -r '.cap.error // empty' <<<"$allowance_json")"
  cap_launch="$(jq -r '.cap.launch // empty' <<<"$allowance_json")"
  [[ -z "$cap_launch" && -z "$cap_error" ]] && cap_error="the allowance reader returned no cap"
  if [[ -n "$cap_error" ]]; then
    printf 'REFUSED: the allowance cap cannot be sized (week %s%%, threshold %s%%;\n' \
      "$week_pct" "$WEEK_CEILING" >&2
    printf '  session %s%%, threshold %s%%): %s. --force to override.\n' \
      "$session_pct" "$SESSION_CEILING" "$cap_error" >&2
    exit 3
  fi
  if ((cap_launch < $# / 2)); then
    cap_bar="$(jq -r 'if .cap.binding.bar == "session" then "session" else "weekly" end' <<<"$allowance_json")"
    cap_reading="$(jq -r '.cap.binding.reading' <<<"$allowance_json")"
    cap_threshold="$(jq -r '.cap.binding.threshold' <<<"$allowance_json")"
    cap_running="$(jq -r '.cap.binding.runningPoints * 10 | round / 10' <<<"$allowance_json")"
    cap_figure="$(jq -r '.cap.binding.perSessionPoints * 100 | round / 100' <<<"$allowance_json")"
    cap_nrunning="$(jq -r '.cap.running | length' <<<"$allowance_json")"
    if [[ "$cap_bar" == "session" ]]; then cap_reset="$session_reset"; else cap_reset="$week_reset"; fi
    if ((cap_launch == 0)); then
      printf 'REFUSED: %s allowance %s%% used (threshold %s%%), resets %s — the bar is full.\n' \
        "$cap_bar" "$cap_reading" "$cap_threshold" "${cap_reset:-unknown}" >&2
      printf '  --force to override.\n' >&2
      exit 3
    fi
    printf 'CAPPED: launching %d of %d on the %s bar (%s%% used, %s running session(s)\n' \
      "$cap_launch" "$(($# / 2))" "$cap_bar" "$cap_reading" "$cap_nrunning" >&2
    printf '  projected at %s more points, ~%s a new session).\n' "$cap_running" "$cap_figure" >&2
    keep_first "$cap_launch" "$@"
    set -- "${keep[@]}"
    # The advisor line below describes the members that launch, not the cut.
    set_wants_advisor=0
    for ((i = 1; i <= $#; i += 2)); do
      if wants_advisor "${!i}"; then set_wants_advisor=1; fi
    done
  else
    printf 'Allowance OK: week %s%%, session %s%%.\n' "$week_pct" "$session_pct"
  fi
fi

# The advisor is behind an experimental feature flag, and off it reports nothing
# at all. What the probe proves is that the flag is live on THIS machine, not
# that any particular --bg session below got an advisor — a launched session
# reports its own advisor nowhere, so this is the closest reading available.
# Where no probe ran, as on a fresh cache, there is no debug log to read; the
# next launch on a stale cache checks again (workflow-core#2306).
if [[ $set_wants_advisor -eq 1 ]]; then
  if grep -qF '[AdvisorTool] Advisor model:' "$debug_log" 2>/dev/null; then
    printf 'Advisor available: %s is live on this machine.\n' "$ADVISOR_MODEL"
  elif [[ $probe_ran -eq 0 ]]; then
    printf 'Advisor not checked: no /usage probe ran to report it.\n'
  else
    printf 'WARNING: the advisor is not live here — the sessions below expecting one run\n' >&2
    printf '  bare, with no escalation path, and nothing in them will say so. Reason, if\n' >&2
    printf '  the CLI gave one:\n' >&2
    grep -F '[AdvisorTool]' "$debug_log" 2>/dev/null | sed 's/^/    /' >&2
    printf '  Launching anyway. --no-advisor to silence this, or launch opus instead.\n' >&2
  fi
fi

# `tee` truncates this file on each launch, so the id read back below is
# always the CURRENT member's, never a stale one from an earlier launch.
launch_out_file="$(mktemp -t dispatch-launch-out.XXXXXX 2>/dev/null)" || launch_out_file=""

# --- launch ----------------------------------------------------------------
# `admission.js` re-reads memory (and, through `poolReserve`, the
# bg-spare pool) immediately before EACH spawn (mantahostels#2553). FAILS CLOSED
# on memory and on a fresh allowance reading at 100% — a backstop, the
# thresholds being the cap's alone (workflow-core#371 item 5) — but only WARNS on a stale or
# absent allowance reading (workflow-core#293 ruling 3): the only refresh is the 11-25s
# `/usage` call, which this per-spawn path cannot afford, so refusing here on
# an untrustworthy reading would strand every remaining member with no path to
# a better one. `--force` passes `--skip-allowance`, dropping the allowance
# limb alone (workflow-core#299).
#
# `--launch` prices the pair THIS member is about to make the daemon warm
# (mantahostels#2588). Without it the re-read sees only what is already
# resident, so the first member of a set is admitted against a pool one pair
# smaller than the one it leaves behind. The refill loop counts its free slots
# with it too, so the two agree on a slot (workflow-core#2500).
while [[ $# -gt 0 ]]; do
  model="$1"
  prompt="$2"
  shift 2
  if [[ $burn -eq 1 ]]; then
    burned="$(node "$BURN_LIB" launch "$model")"
    if [[ "$burned" == "$model" ]]; then
      printf 'burn mode: %s unmapped, launching as written\n' "$model" >&2
    else
      printf 'burn mode: %s -> %s\n' "$model" "$burned" >&2
    fi
    model="$burned"
  fi

  if [[ $dry_run -eq 0 ]]; then
    if [[ $force_memory -eq 0 ]]; then
      admission_args=(--launch)
      # An overflow seat's allowance is its budget, gated above and below.
      [[ $force -eq 1 || $overflow -eq 1 ]] && admission_args+=(--skip-allowance)
    else
      admission_args=(--load-only)
    fi
    if ! admission_out="$(node "$(dirname "$0")/admission.js" "${admission_args[@]}" 2>&1)"; then
      printf 'REFUSED: %s — not launching this member.\n' "$prompt" >&2
      printf '%s\n' "$admission_out" | sed 's/^/  /' >&2
      printf '  Re-read immediately before this spawn (mantahostels#2553).\n' >&2
      # admission.js names a CPU hold on a `cpu load` or `cpu sessions` line,
      # the last ending `the only hold` where memory and allowance would admit
      # (workflow-core#834, workflow-core#2141).
      if printf '%s\n' "$admission_out" | grep -q '^cpu load '; then
        printf '  A CPU load hold: wait for load1 to fall under the ceiling, then re-run\n' >&2
        printf '  this member — `cat /proc/loadavg` reads it. Neither --force nor\n' >&2
        printf '  --force-memory lifts it; WFC_LOAD_CEILING=0 does, at the risk of\n' >&2
        printf '  freezing WSL (workflow-core#830).\n' >&2
      fi
      # `so 0 slot` keeps the unread-count warning line out of this remedy.
      if printf '%s\n' "$admission_out" | grep -q '^cpu sessions .*so 0 slot'; then
        printf '  A CPU session hold: wait for a live session to finish, then re-run this\n' >&2
        printf '  member. Neither --force nor --force-memory lifts it;\n' >&2
        printf '  WFC_SESSION_CEILING=0 does, at the cost of every session slowing (workflow-core#2141).\n' >&2
      fi
      if ! printf '%s\n' "$admission_out" | grep -qE '^cpu (load|sessions) .* the only hold$'; then
        if [[ $force -eq 1 ]]; then
          printf '  --force does not cover memory; --force-memory overrides it, at the risk\n' >&2
          printf '  of freezing the machine.\n' >&2
        else
          printf '  --force overrides an allowance refusal; --force-memory overrides a memory one.\n' >&2
        fi
        roster_remedy "$admission_out"
      fi
      continue
    fi
    # admission.js WARNS rather than refuses on a stale/absent allowance
    # reading (workflow-core#293 ruling 3), and on an unreadable load or session count
    # under --load-only (workflow-core#834, workflow-core#2141) — surface each here, the only place
    # $admission_out is read on the ADMIT path.
    if printf '%s\n' "$admission_out" | grep -qE '^(allowance |cpu (load|sessions) +unknown)'; then
      printf 'WARNING: %s\n' "$prompt" >&2
      printf '%s\n' "$admission_out" | grep -E '^(allowance |cpu (load|sessions) +unknown)' | sed 's/^/  /' >&2
    fi
  fi

  if [[ $overflow -eq 1 ]]; then
    # Re-read per member: each launch reserves its share of the headroom, so
    # the next one's cap is what the earlier ones left. Residual: the cap is
    # the whole headroom, as workflow-core#2570 rules, not one session's share, so a
    # runaway member can spend what a later member's fit was sized on; the
    # later member's own re-read then refuses or caps it lower.
    if ! member_budget="$(read_budget "$prompt — not launching this member")"; then
      continue
    fi
    IFS=$'\t' read -r fit headroom q_usd n_running reserved _ \
      <<<"$(budget_fields "$member_budget")"
    if ((fit == 0)); then
      printf 'REFUSED: %s — not launching this member.\n' "$prompt" >&2
      printf '  %s\n' "$(no_fit_line)" >&2
      continue
    fi
    launcher="the headless launcher"
    launch_cmd=(node "$(dirname "$0")/lib/headless-sessions.js" launch
    --seat "$seat_dir" --cwd "$PWD" --budget "$headroom" "$prompt")
  else
    args=(--bg)
    # A bare `opus` passes NO --model flag on purpose (mantahostels#1093, "everything else is
    # launched with no model flag"): the configured default is
    # `claude-opus-5-5[1m]`, and `--model opus` would silently drop the session
    # to the 200k context window. Residual: on a machine whose default is
    # something else, that is what the session gets. Any other spelling,
    # `opus[1m]` included, passes verbatim.
    [[ "$model" == "opus" ]] || args+=(--model "$model")
    wants_advisor "$model" && args+=(--advisor "$ADVISOR_MODEL")
    launcher="claude"
    launch_cmd=("$WFC_CLAUDE_BIN" "${args[@]}" "$prompt")
  fi
  if [[ $dry_run -eq 1 ]]; then
    printf 'would launch:'
    printf ' %q' "${launch_cmd[@]}"
    printf '\n'
    continue
  fi
  # Re-probed per member (mantahostels#3111, workflow-core#867): the bridge can wedge, or the kernel
  # stall, between one launch and the next, so both checks precede every spawn.
  refuse_if_interop_wedged
  refuse_if_kernel_stalled

  printf '%s  ' "$model"
  # SECOND LINE OF DEFENCE (mantahostels#3111): the probe reads the registry route alone, so
  # a `claude` that blocks for some other reason would still sit here forever.
  #
  # `tee` sits ahead of `head -1` so the job id the launch prints (its whole
  # first line, `claude --help`'s own words) is recoverable after the pipe has
  # truncated what reaches the terminal (mantahostels#3488) — PIPESTATUS[0] is still the
  # launch itself, `tee` and `head` being later pipeline stages. Where the temp
  # file could not be made, the launch still runs; it is only the ledger's
  # `jobId` that goes missing, same as any other unrecorded field.
  if [[ -n "$launch_out_file" ]]; then
    "${launch_ceiling[@]}" "${launch_cmd[@]}" 2>&1 |
      tee "$launch_out_file" | head -1
  else
    "${launch_ceiling[@]}" "${launch_cmd[@]}" 2>&1 | head -1
  fi
  launch_status=${PIPESTATUS[0]}
  # 124 is the ordinary expiry; 137 is 128+SIGKILL, what `-k` escalates to when
  # the target ignores the TERM (mantahostels#3111).
  if [[ $launch_status -eq 124 || $launch_status -eq 137 ]]; then
    printf '\n  REFUSED: %s did not return within %ss. Killed, and NOT recorded as\n' \
      "$launcher" "$LAUNCH_TIMEOUT_SECONDS" >&2
    printf '  launched. %s §9 has the recovery.\n' "$(doc_path environment.md)" >&2
    exit 5
  fi
  # Recorded only where the launch itself exited 0, so a launch that never started
  # is not logged as though it had — `| head -1` makes `$?` head's, which is
  # always 0. 141 is SIGPIPE from head closing the pipe after the first line: a
  # launch that succeeded and said more than one line, so it counts as a launch.
  if [[ $launch_status -eq 0 || $launch_status -eq 141 ]]; then
    # The job id the launch printed as its first line, or empty where the
    # temp file could not be made or came back blank — either way `--job-id`
    # is passed empty, and the ledger records `jobId: null`, the same
    # "unknown" a pre-mantahostels#3488 entry reads as downstream.
    job_id=""
    if [[ -n "$launch_out_file" ]]; then
      # The headless launcher prints a bare id; real `claude --bg` prints
      # `backgrounded·<ESC>[36m<id><ESC>[39m` (workflow-core#27) — a middle dot and a
      # colour escape around the id, not whitespace. Strip the escape
      # sequences, then take the id as the trailing run of 8 hex characters;
      # "backgrounded" itself never forms one (its longest hex-letter run is
      # 3, "bac" or "ded").
      job_id="$(head -1 "$launch_out_file" 2>/dev/null |
        sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -oE '[0-9a-f]{8}' | tail -1)"
    fi
    # Residual: the issue list is every integer in the prompt, so a prompt
    # carrying a non-issue number records a phantom issue and refuses an
    # unrelated dispatch of it, under the same command, for the ledger window
    # (workflow-core#752). `--force` is the way out.
    node "$(dirname "$0")/check-duplicate-dispatch.js" --record \
      --issues "$prompt" --model "$model" --prompt "$prompt" --job-id "$job_id" || true
    launched_prompts+=("$prompt")
    # AFTER this launch, before the NEXT member's re-read at the top of the
    # loop — not before this spawn, which would leave the very next re-read
    # running back-to-back with this launch and seeing none of its bg-spare
    # (mantahostels#2553 review). Only where another member remains, and never a launch
    # this member's own admission gate refused.
    if [[ $# -gt 0 ]]; then
      sleep "$STAGGER_SECONDS"
    fi
  else
    printf '  (%s exited %d; not recorded as launched.)\n' "$launcher" "$launch_status" >&2
  fi
done
