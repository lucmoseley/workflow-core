#!/usr/bin/env bash
#
# bg-run.sh — make a background job's KILL distinguishable from its COMPLETION.
#
# THE PROBLEM (mantahostels#1900, which measured it). The harness kills a job started with
# `run_in_background` intermittently: 2 of 13 instrumented arms on 29 Aug 2026,
# one of them a `sleep`-only job killed inside 10 s with 2993 MB available. No
# property of the job predicts it — not duration, not memory cost, not output
# volume, not turn boundaries — and it is not this machine's limits: earlyoom
# logged no kill, dmesg carried no OOM report, systemd-oomd is inactive.
#
# WHY THE NOTIFICATION IS NOT ENOUGH. A killed job wakes the session exactly as
# a finished one does. The status word differs, but the job's own output file
# does not: a suite killed at 24 minutes leaves 2055 green tests and no verdict,
# which reads as a result. So the session needs a signal the harness cannot
# forge on the job's behalf — one the job itself writes only on completion.
#
# THE INSTRUMENT. Two files per run, both written by the job:
#   beat    — touched every HEARTBEAT_S seconds while the command runs
#   status  — written ONCE, after the command returns, carrying its exit code
# Three more sit beside them: `started` and `mem` (below), and `token`, the
# watcher's identity for the run (mantahostels#3147, cmd_watch).
# A run with `status` finished. A run with no `status` and a stale `beat` was
# killed, and `beat`'s mtime is the second it died. A run with no `status` and a
# fresh `beat` is still going. That is the whole guarantee.
#
# IT NEVER CHANGES THE COMMAND'S EXIT CODE and never writes to stdout on the run
# path beyond the command's own output, so wrapping a command cannot alter what
# the caller reads.
#
# ONE RESIDUAL, DELIBERATELY LEFT. A SIGKILL to this wrapper alone orphans the
# command itself, which runs on unwatched; `check` reports the run KILLED and is
# right about the run, not about the process. The harness kills the whole tree,
# so this is the test harness's shape rather than production's — but a caller
# that must be sure nothing survived checks with ps, not with this script.
#
# WHY `check` PRINTS THE OUTPUT, NOT JUST ITS PATH (mantahostels#2572). `check` and `wait`
# print the file's bytes inline, bounded by WFC_BG_INLINE_CAP, so a caller
# needs no `cat` to see the result — one saved on each of the ~1.7 bg-run.sh
# calls per `/implement` session (mantahostels#2572); this script neither
# writes nor sees the harness's own separate `tasks/*.output` files. The path
# is still printed first, so a caller that wants the raw file — or that hit
# the cap — still can.
#
# WHY `wait` EXISTS. A poll loop (`sleep <n>; bg-run.sh check <name>`, run
# repeatedly by the caller) costs one turn per poll. `wait` blocks inside this
# script instead until the run finishes, goes stale, or a caller-given
# ceiling expires, then reports exactly what `check` would. Give it a ceiling
# under the Bash tool's own timeout (120 s default, 600 s max), or the call is
# killed before it can report anything.
#
# WHAT A KILL LEAVES BEHIND (mantahostels#2662, moved durable and made to fire on its own
# at mantahostels#2691). `run` now also writes `started` (launch time) and, every beat,
# `mem` (MemAvailable and the command's own RSS, sampled live since nothing
# can be read off the process once it is gone). The first of `check` or the
# run's own detached watcher (below) to see a run as KILLED appends one line
# to kill_log_path() — the git common dir's bg-kills.jsonl, not the job-scoped
# run_root(), since a job dir dies with its job and mantahostels#2691 measured that this
# left the record with nowhere to survive to. The line carries elapsed time,
# whether the out file shows the command still waiting on `--queue` or past
# it, the out file's size and whether it still exists, the last memory
# sample, and the signal (see record_kill for what that field can and can't
# tell you). It also carries the launch and death epochs (mantahostels#2694), neither of
# them an instant — death_epoch_source and heartbeat_s beside them say how wide
# the death window is, and record_kill has why. Dedup'd per run via
# `.kill-recorded`, so `check` and the watcher racing the same dead run do
# not double-append.
#
# THE WATCHER IS WHAT MAKES THIS FIRE WITHOUT A SESSION EVER CALLING `check`
# (mantahostels#2691, which measured that almost nothing did — 7 of 1,544 historical
# run dirs carried the `started` file the recorder needs, and zero
# kills.jsonl existed anywhere on the machine 19h after mantahostels#2662 landed). `run`
# launches a `setsid --fork`ed copy of itself on the internal `__watch` verb,
# which polls the launching process's liveness and records the kill itself
# the moment that process is gone with no `status` file — detached so that a
# SIGKILL to the whole tree, the shape this design has to survive even though
# it is not the only signal production sends (mantahostels#2749), which takes this
# script's own toucher subshell down in the same instant
# (measured: a process-group kill left nothing in the group; a setsid --fork
# child survived it, reparented to init), does not take the watcher with it.
#
# THE LOG MOVED; ITS INPUTS DID NOT (mantahostels#2691). record_kill()'s
# dedup lock and everything it reads — started, out, mem, .signal, beat —
# still live under the job-scoped $dir, which the harness deletes with the
# job. Durability holds only if that deletion doesn't land inside the
# HEARTBEAT_S window between the watcher noticing a kill and finishing its
# write; how long a job dir actually survives its own kill is not established
# anywhere in this repo. Unverified either way — moving the lock and the
# inputs it needs beside the durable log is the fix if it turns out to bite.
#
# AND WHAT A LAUNCH LEAVES BEHIND (mantahostels#2763). `run` also appends one line per
# launch to launch_log_path()'s bg-launches.jsonl, beside the kill log. Without
# it the kill log has no denominator: "no kills since the escape landed" reads
# identically to "no jobs ran".
#
# IT COUNTS LAUNCHES, NOT SURVIVALS, and the difference is the bias. A kill line
# is written by a later `check` or by the watcher inside its 2-hour ceiling, so a
# launch with no kill line means the kill was UNOBSERVED, not that the run lived
# — and every route by which a kill goes unrecorded makes the escape look more
# effective than it is. Read a rate off this as a LOWER bound on kills. A run
# killed before its publish is on neither log (#2276).
#
# Each line carries the arm it ran under. record_launch() has what those fields
# can and cannot prove; none of them is a reading of the harness's own state.
#
# THE SUITE CEILING'S BACKSTOP (#2704). A suite runner kills its own run at
# its ceiling (scripts/lib/suite-ceiling.js), but a wedged runner, or one
# SIGKILLed, cannot. So `run` names a deadline file in each run's directory,
# its token in the name so a republished run's runner cannot write the new
# run's, and the runner writes `<deadline s> <pgid>` there at spawn. Once that
# deadline plus CEILING_GRACE_S passes with no `status`, the watcher kills the
# named group and the wrapped command's tree, and records a `ceiling` kill.
# `check` then reads the run as DONE with a non-zero exit, marked a ceiling
# kill. This script holds no copy of the ceiling: it reads only the file.
# The deadline and the watcher's reading of it are on CLOCK_MONOTONIC, the
# runner's own timer's clock, which a host suspend does not advance; the wall
# clock steps forward on resume, and would kill a run for time it never spent
# (#2886).
#
# Usage:
#   scripts/bg-run.sh run <name> <command> [args...]
#   scripts/bg-run.sh check <name>
#   scripts/bg-run.sh wait <name> [ceiling-seconds]
#
# `check` and `wait` print one status line, the output inline, and exit:
# 0 DONE, 1 KILLED, 2 RUNNING (still going at `wait`'s ceiling), 3 UNKNOWN.

set -uo pipefail

# Resolved once, absolute — the watcher (mantahostels#2691) re-execs this file by path
# from a detached process whose cwd is inherited at fork time, not chosen. (The
# host repo root that kill_log_path()'s `git -C` asks against is a separate seam,
# gr_root, #1 — SCRIPT_DIR names only this file's own location, for re-exec and
# for sourcing the sibling lib/ it ships beside.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-root.sh
source "$SCRIPT_DIR/lib/guard-root.sh"
# shellcheck source=scripts/lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"

HEARTBEAT_S="${WFC_BG_HEARTBEAT_S:-5}"
# A beat older than this with no status file means the writer is gone. Three
# missed beats, so a machine briefly too loaded to schedule the toucher is not
# read as a kill.
STALE_S="${WFC_BG_STALE_S:-20}"
# How much of the output file `check`/`wait` inline. Above this, only the
# last INLINE_CAP bytes print — recent output is what a caller is waiting on,
# so the TAIL is kept and an earlier error at the head is lost; a caller that
# needs the head reads $dir/out directly, from the `out=` path this always
# prints first. 4000 is a guess, wide enough for a short stack trace.
INLINE_CAP="${WFC_BG_INLINE_CAP:-4000}"
# How often `wait` polls its own run directory. 2s is a guess: finer than
# HEARTBEAT_S's 5s default so a `wait` ceiling shorter than one heartbeat can
# still catch a DONE promptly, coarser than STALE_S's default so a run isn't
# polled many times within one staleness window for nothing.
WAIT_POLL_S="${WFC_BG_WAIT_POLL_S:-2}"
# How long `check`/`wait` retry a run directory that does not exist yet before
# concluding it was never launched (mantahostels#2609). 2 is a guess, not a measurement:
# short enough that a genuine miss still fails fast, wide enough to survive a
# machine too loaded to schedule `cmd_run` for a moment.
MISSING_S="${WFC_BG_MISSING_S:-2}"
# How often the above retries. 0.1 is a guess: fine enough that a directory
# created early in the window is caught promptly, coarse enough that a miss
# doesn't fork `sleep` and `date` dozens of times for nothing.
MISSING_POLL_S="${WFC_BG_MISSING_POLL_S:-0.1}"
# Where the toucher reads memory headroom from, overridable so a test can
# point it at a fixture instead of the real machine.
MEMINFO="${WFC_BG_MEMINFO:-/proc/meminfo}"
# How many descendants children_rss_kb() (below) visits and enqueues at most,
# so a fork bomb under the wrapped command costs this toucher a bounded
# number of cheap /proc/<pid>/status reads, not an unbounded walk (mantahostels#2683). A
# guess, not a measurement — wide enough to cover a real worker pool (single
# digits to low tens) with headroom.
MAX_DESCENDANTS="${WFC_BG_MAX_DESCENDANTS:-500}"
# How long the detached watcher (mantahostels#2691) polls before giving up on a run that
# neither finished nor was ever seen to die — a fixed ceiling, not a `while
# true`, per CLAUDE.md's wait-loop rule (mantahostels#2012): a run that outlives this
# just goes back to being recorded only if a session later calls `check`.
# 7200 (2h) is a guess: wide against the minutes-not-hours suite runs this
# machine sees, narrow enough that an abandoned watcher does not accumulate for
# a whole session's lifetime.
WATCH_CEILING_S="${WFC_BG_WATCH_CEILING_S:-7200}"
# How long past a suite runner's deadline the watcher waits before killing the
# run itself (#2704): the runner's 14-minute ceiling plus this is #2667's 15.
# Lower only, as the ceiling is, so no setting stretches the hold.
CEILING_GRACE_S=60
if [[ "${WFC_BG_CEILING_GRACE_S:-}" =~ ^[0-9]+$ ]] && [ "$WFC_BG_CEILING_GRACE_S" -lt "$CEILING_GRACE_S" ]; then
  CEILING_GRACE_S="$WFC_BG_CEILING_GRACE_S"
fi
# A test seam, unset in production (#1352): a path the watcher waits for
# between its run-token check and its record, so a test can republish the run
# inside that gap instead of racing it. Its `.waiting` sibling says the watcher
# has arrived. Bounded by GATE_S, per the wait-loop rule: 10 is a guess, well
# over any test's republish or rename inside a gate and well under its timeout.
WATCH_GATE="${WFC_BG_WATCH_GATE:-}"
GATE_S=10
# A test seam, unset in production (#3097): the same wait, held by `check` at
# `<path>.<try>` after each try's token read, and at `<path>.record` before its
# kill record, so a test can move the run directory away inside either gap.
CHECK_GATE="${WFC_BG_CHECK_GATE:-}"
# A test seam, unset in production (#1885): a file each `wait` poll appends its
# cmd_check exit code to, and each missing-directory retry a `missing` line, so
# a test counts the polls instead of timing them (base §X9).
POLL_LOG="${WFC_BG_POLL_LOG:-}"
# A test seam, unset in production (#2687): the whole-second clock, so a test
# chooses what `date +%s` would read (base §N7, §X9). `<epoch>` pins every
# read there; `<epoch>+` reads one later on each call within this process.
# Read only through clock_now.
NOW="${WFC_BG_NOW:-}"
# A test seam, unset in production (#2886): CLOCK_MONOTONIC in whole seconds,
# pinned; a non-numeric value reads as a clock that will not read (#3160).
# Read only through mono_now.
MONO="${WFC_BG_MONO:-}"
# How long cmd_run holds its publish for the watcher to start (#2110). 5 is a
# guess: an unloaded start takes tens of milliseconds, and a run held this long
# is one a loaded machine is already slowing, so the hold costs it little.
WATCH_READY_S="${WFC_BG_WATCH_READY_S:-5}"
# How often that hold looks for the watcher. 0.05 is a guess: it adds at most
# 50 ms to an unloaded publish, and forks `sleep` and `date` 20 times a second
# while a loaded machine is starting the watcher.
WATCH_READY_POLL_S="${WFC_BG_WATCH_READY_POLL_S:-0.05}"
# A test seam, unset in production (#2110): seconds the watcher's launch
# sleeps before it detaches, so a test can widen the window a loaded machine
# opens there.
WATCH_FORK_DELAY_S="${WFC_BG_WATCH_FORK_DELAY_S:-}"
# A test seam, unset in production (#2675): a file the toucher creates once it
# has re-armed the TERM trap it is forked holding, so a test holds open for the
# toucher's whole life the window a loaded machine opens only before bash
# resets that trap.
TOUCHER_KEEPS_TRAP="${WFC_BG_TOUCHER_KEEPS_TRAP:-}"

# Sets mono_s to CLOCK_MONOTONIC in whole seconds, the suite deadline's
# clock (#2886), through the WFC_BG_MONO seam. Bash and coreutils read no such
# clock and /proc/uptime counts suspended time, so node reads it: a deadline
# file exists only where a node runner wrote it, so node is there to read it.
mono_s=""
mono_now() {
  if [ -n "$MONO" ]; then
    mono_s="$MONO"
  else
    mono_s="$(node -e 'process.stdout.write(String(Math.floor(Number(process.hrtime.bigint()) / 1e9)))' 2>/dev/null)"
  fi
  [[ "$mono_s" =~ ^[0-9]+$ ]]
}

# Sets clock_s to the whole-second clock, through the WFC_BG_NOW seam. A
# variable rather than stdout, since a `$(...)` read would drop a ticking
# clock's count with its subshell.
clock_ticks=0
clock_now() {
  case "$NOW" in
    "") clock_s="$(date +%s)" ;;
    *+)
      clock_ticks=$((clock_ticks + 1))
      clock_s=$((${NOW%+} + clock_ticks))
      ;;
    *) clock_s="$NOW" ;;
  esac
}

# MemAvailable in MB, or nothing on a line it cannot parse. Mirrors
# lib/suite-concurrency-host.js's readAvailableMb — fails open, never fatal, since a
# kill record with an "unknown" figure beats a toucher that dies on a
# malformed /proc.
available_mb() {
  local line
  line="$(grep -m1 '^MemAvailable:' "$MEMINFO" 2>/dev/null)" || return 1
  [[ "$line" =~ ([0-9]+)\ kB ]] || return 1
  echo $((BASH_REMATCH[1] / 1024))
}

# Builds the WHOLE pid->children mapping in one pass over /proc/[0-9]*/stat,
# with bash's own file-read builtin (no per-file `cat`, no per-pid `pgrep`,
# whose per-call cost is a full /proc scan — mantahostels#2683's benchmarks against a
# per-visit `pgrep` walk are on the issue). One /proc scan here, however wide
# the tree, is what actually bounds the cost.
# Values are a space-separated pid list, deliberately unquoted everywhere
# they're read (`${CHILDREN_OF[$x]:-}` below) so the caller's `for` splits on
# them rather than treating the whole list as one word.
declare -A CHILDREN_OF
build_children_map() {
  CHILDREN_OF=()
  local stat_file pid line rest ppid
  local -a fields
  for stat_file in /proc/[0-9]*/stat; do
    pid="${stat_file#/proc/}"
    pid="${pid%/stat}"
    # A pid can exit between the glob expanding and this read — 2>/dev/null
    # must precede the `<` redirection, or bash reports that race's "No
    # such file" to the toucher's own stderr before the redirect applies.
    IFS= read -r line 2>/dev/null <"$stat_file" || continue
    # /proc/<pid>/stat is "pid (comm) state ppid ...". comm is
    # parenthesised and may itself contain spaces or ')', so split on the
    # LAST ')' rather than trying to parse comm at all — ppid is the
    # second field after it.
    rest="${line##*) }"
    read -ra fields <<<"$rest"
    ppid="${fields[1]:-}"
    [[ "$ppid" =~ ^[0-9]+$ ]] || continue
    CHILDREN_OF["$ppid"]+="$pid "
  done
}

# Fills `descendants` with $parent's WHOLE descendant tree except $exclude and
# everything it forks, none of which is ever enqueued. BFS over the map above,
# so a command that forks its own workers (`npm run test`'s vitest pool) has
# its whole pool reached rather than just its own launcher (mantahostels#2683).
# Bounded at MAX_DESCENDANTS; `descendants_truncated` says whether the cap cut
# the walk short.
descendants=()
descendants_truncated=false
collect_descendants() {
  local parent="$1" exclude="$2" pid kid
  descendants=()
  descendants_truncated=false
  build_children_map
  local -a queue=()
  # Bounded at enqueue time, not just at visit time — a single pid with a
  # huge fan-out (the shape a fork bomb actually takes) would otherwise
  # buffer its whole child list into $queue in one step, before the
  # visit-count check below ever gets a turn to cap anything.
  for kid in ${CHILDREN_OF[$parent]:-}; do
    [ "$kid" = "$exclude" ] && continue
    if [ "${#queue[@]}" -ge "$MAX_DESCENDANTS" ]; then
      descendants_truncated=true
      break
    fi
    queue+=("$kid")
  done
  while [ "${#queue[@]}" -gt 0 ]; do
    if [ "${#descendants[@]}" -ge "$MAX_DESCENDANTS" ]; then
      descendants_truncated=true
      break
    fi
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    descendants+=("$pid")
    for kid in ${CHILDREN_OF[$pid]:-}; do
      if [ "${#queue[@]}" -ge "$MAX_DESCENDANTS" ]; then
        descendants_truncated=true
        break
      fi
      queue+=("$kid")
    done
  done
}

# Sums VmRSS in kB across collect_descendants' tree; $exclude is the toucher's
# own subshell, found via $BASHPID at the call site. Echoes "<total>
# <truncated>" rather than just the total — a caller reads this through a
# `$(...)` subshell, so a truncation flag set as a plain variable inside this
# function would never survive back out — so a capped sum can be told from a
# complete one rather than reading as the whole truth in a kill record.
children_rss_kb() {
  local pid line total=0 found=false
  collect_descendants "$1" "$2"
  for pid in "${descendants[@]}"; do
    line="$(grep -m1 '^VmRSS:' "/proc/$pid/status" 2>/dev/null)" || continue
    if [[ "$line" =~ ([0-9]+)\ kB ]]; then
      total=$((total + BASH_REMATCH[1]))
      found=true
    fi
  done
  "$found" || return 1
  echo "$total $descendants_truncated"
}

# Overwrites $dir/mem with a fresh sample. Best-effort throughout: a failed sample — /proc gone
# mid-read, the command already exited — leaves the previous one in place
# rather than overwriting it with a blank or a guessed "unknown".
sample_mem() {
  local dir="$1" parent="$2" exclude="$3" avail rss_line rss truncated
  avail="$(available_mb)" || return 0
  rss_line="$(children_rss_kb "$parent" "$exclude")" || return 0
  read -r rss truncated <<<"$rss_line"
  aw_write "$dir/mem" printf 'mem_available_mb=%s rss_kb=%s rss_truncated=%s\n' \
    "$avail" "$rss" "$truncated" 2>/dev/null
}

run_root() {
  if [ -n "${WFC_BG_ROOT:-}" ]; then
    printf '%s\n' "$WFC_BG_ROOT"
  elif [ -n "${CLAUDE_JOB_DIR:-}" ]; then
    printf '%s\n' "$CLAUDE_JOB_DIR/tmp/bg"
  else
    printf '%s\n' "${TMPDIR:-/tmp}/wfc-bg"
  fi
}

# Where a durable record lives (mantahostels#2691). NOT under run_root(): a job dir dies with
# its job, so a record written there is gone by the time anything reads it back.
# The git common dir is the precedent (`.sweep-autofire`,
# scripts/lib/sweep-budget.js's markerPath(), :66-78) —
# untracked, shared across worktrees, outlives any one job or session. Asked of
# the HOST repo (gr_root, #1), never SCRIPT_DIR: in a plugin install SCRIPT_DIR
# is the plugin cache, which is no part of the host repo's worktree at all.
# Falls back to the old job-scoped path when git will not answer (no repo, no
# git binary) — the house fail-open discipline: a record nobody can place
# durably still gets written somewhere rather than dropped.
durable_log_path() {
  local base="$1" fallback="$2"
  local common
  common="$(git -C "$(gr_root)" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -n "$common" ]; then
    printf '%s\n' "$common/$base"
    return 0
  fi
  printf '%s\n' "$(run_root)/$fallback"
}

# WFC_BG_KILL_LOG overrides for a test. The watcher also sets it, to this
# function's answer, before leaving the repo cwd.
kill_log_path() {
  if [ -n "${WFC_BG_KILL_LOG:-}" ]; then
    printf '%s\n' "$WFC_BG_KILL_LOG"
    return 0
  fi
  durable_log_path bg-kills.jsonl kills.jsonl
}

# The kill log's denominator (mantahostels#2763). Same placement and fail-open rules as the
# kill log, and its own WFC_BG_LAUNCH_LOG test override.
launch_log_path() {
  if [ -n "${WFC_BG_LAUNCH_LOG:-}" ]; then
    printf '%s\n' "$WFC_BG_LAUNCH_LOG"
    return 0
  fi
  durable_log_path bg-launches.jsonl launches.jsonl
}

# The bytes a JSON string may not carry raw. `name` is caller-chosen and the
# environment is not this script's to constrain, so both go through here —
# a newline in either would otherwise split one record across two lines and
# break every line-oriented reader of these logs.
json_escape() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//$'\n'/\\n}"
  v="${v//$'\r'/\\r}"
  v="${v//$'\t'/\\t}"
  printf '%s' "$v"
}

# Appends one line per `run`, joinable to a kill line on name + started_epoch.
# THE JOIN IS ONE-SIDED: a kill line records started_epoch as "unknown" where
# its own `started` file was missing or malformed, and `run <name>` on a live
# name republishes the directory, so two runs can share a name. Neither is
# repaired here — a row that will not join is dropped from the rate rather than
# guessed at.
#
# job_dir_set IS A PROXY AND NOT A READING OF THE SESSION KIND, and the kind it
# proxies for is not exempt: mantahostels#2725 held the reaper armed only for an INTERACTIVE
# session, at 85% (75-92%), but mantahostels#2694's window 1 was a BACKGROUND-JOB session
# and two of its jobs were reaped — docs/environment.md §5 carries the
# adopt-path alternative. CLAUDE_JOB_DIR is set for a background job
# — measured, docs/environment.md:464 — and only PRESUMED absent in the
# founder's own terminal; nothing in this repo has checked that half. One
# launch has since been seen with it UNSET inside a background job (mantahostels#2916,
# `job_dir_set:false` on `trial1`), so the measurement is not universal and
# this proxy misreads that case; n=1, and the cause is unestablished.
#
# reap_escape IS THE ARM LABEL, NEVER THE VERDICT. The app DOES honour the
# variable — mantahostels#2694's window 2 ran two probes to a 4,500 s ceiling with zero
# kills against an exposure-matched control, retiring mantahostels#2763's second ground for
# doubt — but this process still cannot tell WHERE it came from, so a command
# prefix, which docs/environment.md §5 says is inert against the reaper, labels
# a run "1" exactly as a working settings.json placement would. `null` means
# the variable was absent; "" means it was set and empty — a third arm again.
#
# watcher_ready is false where the publish stopped waiting at WATCH_READY_S
# before the watcher had detached (#2276); that watcher may still start and
# record. null where no setsid launched one.
#
# Never fatal, but not silent: a launch that cannot be recorded still runs and
# still returns the command's own exit code, and the failing append prints to
# THIS wrapper's stderr — as record_kill()'s does. stdout on the run path stays
# the command's alone.
#
# The append is one printf of a short line, which the kernel does not interleave
# in practice; a pathological `name` could make it long enough to. Same residual
# as record_kill(), and no lock is taken for either.
#
# THE run_root FIELD IS WHERE THIS LAUNCH ACTUALLY WROTE (mantahostels#2916): run_root() reads
# environment this script does not own, so the resolution `run` makes and the
# one a later `check` makes can differ, and the run is then reported as never having existed. pinned_run_dir()
# reads this field back. Recorded even when it matches the obvious answer — the
# case that needs it is exactly the one where nothing looks wrong at check
# time. It is `run_root()`'s answer, not `$(dirname "$dir")` read back off the
# directory cmd_run published: the same value in this process, so the field is
# true by determinism rather than by observation.
record_launch() {
  local name="$1" started_at="$2" watcher_ready="$3"

  local avail
  avail="$(available_mb)" || avail=""
  [ -n "$avail" ] || avail="unknown"

  local job_dir_set=false
  [ -n "${CLAUDE_JOB_DIR:-}" ] && job_dir_set=true

  # `+x` rather than `:-`, so an absent variable and one set to the empty
  # string stay distinguishable — the second is its own arm, and the one a
  # rate split cannot afford to fold into the first. Emitted unquoted, so
  # absent reads as JSON null rather than as the four-letter string a reader
  # could not tell from a real value.
  local escape_field=null
  if [ -n "${CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP+x}" ]; then
    escape_field="\"$(json_escape "$CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP")\""
  fi

  local log
  log="$(launch_log_path)"
  mkdir -p "$(dirname "$log")" 2>/dev/null
  printf '{"name":"%s","started_epoch":"%s","run_root":"%s","job_dir_set":%s,"reap_escape":%s,"mem_available_mb":"%s","watcher_ready":%s}\n' \
    "$(json_escape "$name")" "$started_at" "$(json_escape "$(run_root)")" "$job_dir_set" "$escape_field" "$avail" "$watcher_ready" \
    >>"$log"
}

die() {
  printf 'bg-run: %s\n' "$1" >&2
  exit 3
}

# The `signal` field's one source of ground truth (mantahostels#2691). Set by cmd_run at
# publish time, so the window between process start and that point traps to a
# no-op below rather than writing into an unset path.
SIGNAL_DIR=""

# The handler does not itself decide the wrapper dies: on a genuine
# whole-tree kill it records, then restores the default disposition and
# re-raises, so whatever reads this process's wait status still sees a real
# signalled death rather than a swallowed one.
#
# Partly readable, not always. Bash defers a pending trap while blocked in
# the foreground wait() for `"$@"` below, running it only once that external
# command returns: a TERM sent to the wrapper ALONE, with the wrapped
# command still healthy, sits unrecorded for the command's ENTIRE REMAINING
# RUNTIME, and by the time it fires the command has already finished on its
# own — recording a kill at that point would be false, so this handler
# writes nothing and lets cmd_run's own line record the real status instead
# (mantahostels#2747). On a genuine kill, `.signal` is still written on a best-effort
# basis — its absence is not proof the kill didn't happen.
#
# The discriminator below is the wrapped command's exit code, not proof the
# signal ever reached it: a command that traps TERM/HUP itself and exits on
# its own terms, in the whole-tree shape, now reads as DONE with no
# `.signal` unless it happens to exit 128+signum (mantahostels#2747 comments). Nothing
# here can do better without backgrounding the command, which the toucher
# comment below already rules out for unrelated reasons (stdin,
# SIGINT/SIGQUIT).
#
# mantahostels#2749 asked whether this gap is reachable in this repo's own usage.
# Production's whole-tree kill is NOT established as SIGKILL-only: mantahostels#1900
# never observed a harness kill directly (it SIGKILLs the wrapper alone, to
# test the discriminator, and calls that "what the harness does" without
# having traced it), and mantahostels#2694's directly measured window 1 recorded a real
# whole-tree SIGTERM — `bg-kills.jsonl` carries `"signal":"TERM"` against an
# untrapped `bash -c 'while :; ...'` wrapped command, memory and PSI both
# clean, neither process surviving its wrapper. And the structural sweep
# needs `.js`, not just `.sh`: one more
# TERM/HUP-trapping script is on file beyond check-injector-margin.sh (which
# still only cleans up a scratch dir, and is never the wrapped command) —
# scripts/run-vitest.js's `armSignals`.
# check-stale-suite-queue.js's own header comment (line 11) DESCRIBES that
# cleanup happening on SIGTERM/SIGINT/SIGHUP, but traps nothing itself — it is
# a separate, standalone reporting script (`npm run check:suite-queue`,
# scripts/status-report.js), never a signal handler and never wrapped.
#
# `npm run test` IS a wrapped command (`bg-run.sh run <name> npm run test`),
# and its actual child, run-vitest.js, traps TERM/HUP/INT. npm's own
# run-script signal-manager relays SIGINT/SIGTERM to that child but not
# SIGHUP; irrelevant either way, since a whole-tree kill signals every
# process in the group at once, run-vitest.js included, regardless of what
# npm forwards. Still no live bug, measured end to end (a whole-group TERM
# through `bg-run.sh run … npm run t`, `check` reading KILLED with
# `"signal":"TERM"`): run-vitest.js re-exits at exactly 128+signum on all
# three signals, by the same shell convention this discriminator reads
# (run-vitest.js's armSignals, its own comment says so), and npm passes that exit
# code through as its own, so the discriminator sees 128+signum however many
# layers deep the actual trap sits.
#
# DONE-with-no-record is the right reading for a command that caught its own
# kill signal and chose to exit rather than die by it — it finished on
# notice, which is a real difference from being killed. The gap stays real
# only for a wrapped command that traps TERM/HUP but does NOT re-exit at
# 128+signum — an ad-hoc self-trapping snippet an agent backgrounds directly,
# which nothing here rules out — where the same reading is arguably still
# right, just unproven by a repo-wide convention. Regression tests cover the
# shapes this can be checked against — the three `it` cases tagged (mantahostels#2749)
# in bg-run.test.ts. This "no live bug" ruling holds only while run-vitest.js
# stays the one TERM/HUP-trapping script `bg-run.sh` itself wraps, and only
# while it keeps the 128+signum convention.
on_signal() {
  # MUST be the first statement: $? is the LAST FOREGROUND COMMAND's exit
  # code — the wrapped command's, since that is what this trap was
  # deferred behind — and even a bare `local` on the next line overwrites
  # it with ITS OWN (zero) exit status before `code=$?` could read it.
  local code=$?
  local sig="$1"
  local sig_num=""
  case "$sig" in
    TERM) sig_num=15 ;;
    HUP) sig_num=1 ;;
  esac
  if [ -n "$SIGNAL_DIR" ] && [ -n "$sig_num" ] && [ "$code" -eq "$((128 + sig_num))" ]; then
    # An exit code of 128+signum is what the wrapped command's own
    # death by this same signal looks like — the whole-tree kill shape
    # production actually sends (file header, above). Not proof (a
    # command exiting that code on its own, coincidentally, under a
    # wrapper-alone signal reads the same way): record it as a kill and
    # re-raise so the wrapper's own wait status still shows a signalled
    # death.
    printf '%s\n' "$sig" >"$SIGNAL_DIR/.signal" 2>/dev/null
    trap - TERM HUP
    kill -"$sig" "$$"
  fi
  # Any other exit code: the command did not die from $sig, whether
  # because it never reached it (the wrapper-alone shape) or because it
  # caught the signal and chose its own exit code (the whole-tree shape's
  # own residual, above). Disarm and fall through to cmd_run's own status
  # write either way.
  trap - TERM HUP
}
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

# The directory a run was LAUNCHED into, read back from its own launch line
# (mantahostels#2916).
#
# WHY THIS EXISTS. run_root() is resolved twice for every run — once by `run`,
# once by each later `check`/`wait` — from $WFC_BG_ROOT, else $CLAUDE_JOB_DIR,
# else $TMPDIR. Nothing ties the second resolution to the first, so a variable
# that changes between them sends `check` to a different root and the run is
# reported `no run named <x>`, which is the one answer this script exists to
# never give wrongly (mantahostels#2916).
#
# LAST MATCHING LINE WINS: `run <name>` on a live name republishes the
# directory, so one name can carry several launches, and the newest is the one
# a `check` means.
#
# TWO LIMITS, BOTH DELIBERATE. The field is read with a lexical match rather
# than a JSON parse, so a root holding a quote or a backslash — which
# json_escape() escaped on the way in — is EXTRACTED TRUNCATED at the escape
# rather than missed: `/x/q"r` comes back as `/x/q\`. Nothing here notices;
# resolve_run_dir()'s own `-d` test is what rejects it, and the caller falls
# through to the fresh resolution exactly as an absent log does. And a log
# this process cannot read is not an error either: that fallback is the
# behaviour that existed before this function.
pinned_run_dir() {
  local name="$1"
  local log
  log="$(launch_log_path)"
  [ -f "$log" ] || return 1
  local root
  root="$(grep -F "\"name\":\"$(json_escape "$name")\"" "$log" 2>/dev/null |
    sed -n 's/.*"run_root":"\([^"]*\)".*/\1/p' | tail -1)"
  [ -n "$root" ] || return 1
  printf '%s/%s\n' "$root" "$name"
}

# Where `check`, `wait` and anything else asking about an existing run should
# look. The fresh resolution wins when it hits — it is the cheap answer and the
# right one for every run whose environment did not move — and the pinned root
# is consulted only when it misses, which is also what keeps the launch log out
# of the hot path.
#
# ALWAYS PRINTS A PATH, VERIFIED OR NOT: on a total miss it prints the fresh
# one. Its only caller re-tests `-d` before doing anything with it, so nothing
# downstream ever receives a path this function did not confirm.
#
# FRESH-FIRST HAS ITS OWN RESIDUAL, and it predates this function: a stale
# directory left in the resolved root shadows a NEWER launch of the same name
# elsewhere, because cmd_run's `rm -rf` only ever clears the root it is
# publishing into.
resolve_run_dir() {
  local name="$1"
  local dir pinned
  dir="$(run_root)/$name"
  [ -d "$dir" ] && {
    printf '%s\n' "$dir"
    return 0
  }
  pinned="$(pinned_run_dir "$name")" || {
    printf '%s\n' "$dir"
    return 0
  }
  [ -d "$pinned" ] && {
    printf '%s\n' "$pinned"
    return 0
  }
  printf '%s\n' "$dir"
}

# Runs `$3...` every `$2` seconds until it succeeds or `$1` seconds have
# passed, sleeping before each try. Bounded on the wall clock (`date +%s%N`),
# not a fixed iteration count: a fork-and-schedule slowdown eats into the
# window instead of extending it.
poll_until() {
  local window="$1" interval="$2"
  shift 2
  local deadline_ns
  deadline_ns=$(($(date +%s%N) + $(awk "BEGIN{printf \"%.0f\", $window * 1000000000}")))
  while [ "$(date +%s%N)" -lt "$deadline_ns" ]; do
    sleep "$interval"
    "$@" && return 0
  done
  return 1
}

# require_run_dir's probe: leaves the directory it found in found_dir.
found_dir=""
run_dir_appeared() {
  [ -z "$POLL_LOG" ] || printf 'missing\n' >>"$POLL_LOG"
  found_dir="$(resolve_run_dir "$1")"
  [ -d "$found_dir" ]
}

# cmd_run builds a run in this scratch directory and publishes it by renaming.
# Dot-prefixed and inside the parent, not a `$dir.tmp` sibling: a run
# literally named `<x>.tmp` would otherwise share a scratch path with run
# `<x>`, so launching one could delete or publish over the other's live
# directory. A run named `.tmp-<x>` recreates the same collision — accepted,
# since nothing chooses names that shape today.
scratch_dir() {
  printf '%s\n' "$(dirname "$1")/.tmp-$(basename "$1")"
}

# Prints the scratch directory of a publish cmd_run is holding for `$1`, in the
# fresh root or the one its last launch line pins, as resolve_run_dir looks:
# a re-run from a moved environment holds its publish in the pinned root.
held_scratch_dir() {
  local tmp pinned
  tmp="$(scratch_dir "$(run_root)/$1")"
  [ -d "$tmp" ] && {
    printf '%s\n' "$tmp"
    return 0
  }
  pinned="$(pinned_run_dir "$1")" || return 1
  tmp="$(scratch_dir "$pinned")"
  [ -d "$tmp" ] && printf '%s\n' "$tmp"
}

# require_run_dir's probe while a publish is held: done once the run directory
# appears or the scratch directory `$2` is gone.
publish_settled() {
  run_dir_appeared "$1" || [ ! -d "$2" ]
}

# `check` and `wait` each open on this, independently, before either does
# anything else with the run. Retries the directory's existence for up to
# MISSING_S so a caller that reaches `check`/`wait` before `cmd_run`'s own
# `mv` has published it is not told the run never happened; a name that truly
# was never launched still dies here, just after the window rather than at once.
# PRINTS THE DIRECTORY IT SETTLED ON, so the caller uses the root that actually
# holds the run rather than re-deriving one. It re-resolves on every poll: the
# race this window is for is a directory appearing late, and a run published
# into the pinned root appears there and nowhere else.
#
# `die` here exits a command substitution, not the script, so a caller that
# WANTS the path must write `dir="$(require_run_dir "$name")" || exit $?` to
# propagate the refusal; the message reaches stderr either way and the exit
# code stays 3. cmd_wait, which wants only the refusal, calls it directly and
# lets `die` exit the shell.
#
# THE MISS PATH IS NOT FREE: each poll re-runs resolve_run_dir, and a miss there
# opens the launch log, which nothing rotates. At this repo's launch volume
# that is a few hundred lines read up to MISSING_S/MISSING_POLL_S times — 20 by
# default, 70 more while a held publish's scratch directory stands — and it is
# paid only by a name that is not where it should be.
require_run_dir() {
  local name="$1"
  local dir
  dir="$(resolve_run_dir "$name")"
  [ -d "$dir" ] && {
    printf '%s\n' "$dir"
    return 0
  }
  if poll_until "$MISSING_S" "$MISSING_POLL_S" run_dir_appeared "$name"; then
    printf '%s\n' "$found_dir"
    return 0
  fi
  # A scratch directory still on disk is a run whose publish cmd_run is holding
  # for its watcher, for up to WATCH_READY_S (#2688). THE BOUND:
  # MISSING_S for a name with no scratch directory; 2×MISSING_S + WATCH_READY_S
  # (9 s by default) where one is left by a run killed mid-hold, until the
  # name's next launch clears it. The extra MISSING_S, a guess like MISSING_S
  # itself, covers the launch record and rename that follow the hold. The wait
  # is sized by this process's WATCH_READY_S, not the launcher's: a launcher
  # holding longer than the checker's setting is released early.
  local tmp
  if tmp="$(held_scratch_dir "$name")" &&
    poll_until "$(awk "BEGIN{print $WATCH_READY_S + $MISSING_S}")" "$MISSING_POLL_S" publish_settled "$name" "$tmp" &&
    run_dir_appeared "$name"; then
    printf '%s\n' "$found_dir"
    return 0
  fi
  # A launch line naming a root that is no longer on disk is a different
  # story from a name never launched at all — mantahostels#2691 records that a job dir
  # dies with its job.
  local pinned
  if pinned="$(pinned_run_dir "$name")"; then
    die "no run named $name under $(run_root); its launch line points at $pinned, gone too"
  fi
  die "no run named $name under $(run_root)"
}

# Holds cmd_run's publish until the watcher has touched $1, for at most
# WATCH_READY_S.
await_watcher() {
  local ready="$1"
  [ -e "$ready" ] && return 0
  poll_until "$WATCH_READY_S" "$WATCH_READY_POLL_S" test -e "$ready"
}

cmd_run() {
  [ "$#" -ge 2 ] || die "run needs a name and a command"
  local name="$1"
  shift
  local dir tmp
  dir="$(run_root)/$name"
  tmp="$(scratch_dir "$dir")"
  # A re-run starts clean: a previous run's status file would otherwise report
  # this run finished the moment it began. The old directory is renamed aside
  # before it is deleted (#1355): its watcher may still record into it, and a
  # write landing mid-delete leaves it non-empty. Aside, that fails only the
  # unchecked delete, never the publish below. Nothing sweeps a grave left that
  # way; it stays until a person or the job dir's own cleanup removes it.
  local grave
  grave="$(dirname "$dir")/.grave-$(basename "$dir")-$$-$RANDOM"
  if [ -e "$dir" ]; then
    mv -T "$dir" "$grave" && rm -rf "$grave"
  fi
  rm -rf "$tmp"

  # A directory swap, so not aw_write's (#2251), which replaces a file's bytes.
  # `mv -T` within one filesystem is a single rename onto an absent path, so
  # `$dir` never appears to another process without `beat` and `out` already
  # in it (mantahostels#2666) — `-T` matters here: a plain `mv` would silently NEST
  # `$tmp` inside an already-existing `$dir` (a concurrent same-name `run`
  # recreating it between the rename aside above and this `mv`) rather than
  # failing, reopening the window unreported.
  mkdir -p "$tmp" || die "cannot create $tmp"
  : >"$tmp/out"
  local started_at
  clock_now
  started_at="$clock_s"
  printf '%s\n' "$started_at" >"$tmp/started"
  # The watcher's identity for this run, distinct from `started` because
  # `started` is whole seconds and two runs of one name can share a second
  # (mantahostels#3147). `started` stays what the kill and launch records join on.
  local token="$started_at-$$-$RANDOM"
  printf '%s\n' "$token" >"$tmp/token"

  # THE WATCHER (mantahostels#2691). The toucher below is not enough: a SIGKILL to this
  # process is, in production, a kill of the whole tree it heads (the file
  # header's residual note) — the toucher shares this shell's process group
  # and dies in the same instant, with nothing left to notice, let alone
  # record. `kill -9 -<pgid>` took wrapper, toucher and toucher's own
  # `sleep` in one pass; a `setsid --fork` child reparented to init and
  # survived the same kill untouched. `--fork` is what buys that: plain
  # `setsid` execs in place and stays this shell's child, still inside a
  # /proc descendant walk rooted here; `--fork` double-forks so the
  # watcher's PPID is 1. What it polls and how long it waits: cmd_watch, below.
  #
  # FORKED BEFORE THE PUBLISH, AND THE PUBLISH WAITS FOR IT (#2110, #2106).
  # Until the watcher has run, it is still inside this process group, and a
  # kill there leaves no one to record it. So the watcher touches
  # `.watching-<token>` once it is detached, and the directory is not published
  # until it has. A kill before that finds no run under `$dir`, and the
  # watcher, seeing no directory, records nothing. The residual is
  # await_watcher's ceiling: a watcher slower than WATCH_READY_S to start is
  # published without, and the window reopens for that run alone.
  #
  # The ready file carries the token because `$tmp` is the same path for every
  # run of a name: a late watcher from a run published without it would
  # otherwise release the next run's wait.
  #
  # The launch is recorded after the wait, carrying its outcome (#2276), and
  # before the publish: a kill line is only ever written into a published
  # directory, so none lacks its launch line. A kill during the wait leaves
  # neither line.
  local watcher_ready=null
  if command -v setsid >/dev/null 2>&1; then
    local ready="$tmp/.watching-$token"
    (
      [ -z "$WATCH_FORK_DELAY_S" ] || sleep "$WATCH_FORK_DELAY_S"
      exec setsid --fork "$SCRIPT_PATH" __watch "$dir" "$name" "$$" "$token" "$ready"
    ) </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
    watcher_ready=true
    await_watcher "$ready" || watcher_ready=false
  fi
  record_launch "$name" "$started_at" "$watcher_ready" || true

  # `beat` is made here, after `started` and the watcher wait, and stamped from
  # `date` (#2674): made before the wait it would be as old as the wait at
  # publish, and a kill before the first re-touch would date the death before
  # the launch, a negative elapsed_s. `touch -d` rather than a plain touch,
  # whose filesystem clock can trail `date`'s by a tick at a second boundary.
  clock_now
  touch -d "@$clock_s" "$tmp/beat" || die "cannot create $tmp/beat"
  mv -T "$tmp" "$dir" || die "cannot publish $dir"
  SIGNAL_DIR="$dir"

  # The toucher runs detached from the command so a command that closes its
  # own stdio cannot stop the heartbeat, and it WATCHES THIS SHELL'S PID
  # rather than trusting it will be signalled too. A subshell does not die
  # with a SIGKILLed parent — it is reparented and runs on, which made an
  # early version of this script report a killed run as RUNNING for as long
  # as the orphan lived. It samples memory by walking $parent's own
  # descendant tree rather than needing the command's pid handed in — which
  # in turn is why the command below still runs in the FOREGROUND rather
  # than backgrounded to capture `$!`: backgrounded, the command would
  # silently lose its own stdin (it reads from /dev/null) and stop seeing
  # SIGINT/SIGQUIT (backgrounded jobs ignore both in non-interactive bash),
  # which a wrapper must leave alone.
  local parent=$$
  (
    if [ -n "$TOUCHER_KEEPS_TRAP" ]; then
      trap 'on_signal TERM' TERM
      : >"$TOUCHER_KEEPS_TRAP"
    fi
    while kill -0 "$parent" 2>/dev/null; do
      sleep "$HEARTBEAT_S"
      touch "$dir/beat" 2>/dev/null || exit 0
      sample_mem "$dir" "$parent" "$BASHPID"
    done
  ) &
  local beater=$!
  # So the ceiling kill (cmd_watch) spares the toucher, and `check` keeps
  # reading RUNNING while a command the kill could not reach runs on.
  printf '%s\n' "$beater" >"$dir/.toucher"

  # The variable is suite-ceiling.js's DEADLINE_ENV.
  WFC_SUITE_DEADLINE_FILE="$dir/deadline-$token" "$@" >>"$dir/out" 2>&1
  local code=$?

  # KILL, not TERM (#2674): the toucher is forked holding this shell's TERM
  # trap until it resets it, so a TERM landing in that window — a command that
  # returns at once, on a loaded machine — runs on_signal there, which disarms
  # and loops on, and the `wait` below never returns. A KILL mid-sample can
  # leave one aw_write aside in $dir; nothing reads it.
  kill -KILL "$beater" 2>/dev/null
  wait "$beater" 2>/dev/null

  # LAST, AND ONLY HERE. Everything above can be interrupted; a status file on
  # disk is the one thing that proves the command returned. Written whole by a
  # single redirect so a kill mid-write cannot leave a half-line that parses.
  printf 'exit=%s\n' "$code" >"$dir/status"
  return "$code"
}

# Prints the verdict's trailer — `out=<path> bytes=<n>`, truncated notice if
# capped — then the output read_run took, unindented, so a caller reading the
# whole line still gets a well-formed `out=` field to fall back on.
print_inline() {
  local path="$1"
  if [ "$out_size" -le "$INLINE_CAP" ]; then
    printf 'out=%s bytes=%s\n' "$path" "$out_size"
  else
    printf 'out=%s bytes=%s (last %s shown)\n' "$path" "$out_size" "$INLINE_CAP"
  fi
  printf '%s' "$out_tail"
}

# mantahostels#2662. Appends one line to $(kill_log_path) the first time `check`
# reads a given run as KILLED — dedup'd on the `mkdir` below, which is
# atomic, so two `check`s racing the same dead run cannot both pass it and
# double-append. Written from inside `check` itself (part of this wrapper,
# not the calling session) off data the toucher already laid down live,
# since nothing can run in the killed job's own process once it is gone
# (mantahostels#2517).
#
# elapsed_s is how long the run SURVIVED — death_epoch minus launch — not how
# long ago it died. $death_epoch, where given, is `beat`'s own mtime, the
# second the run actually died. `before-first-beat` has no such mark: the run
# died somewhere in [launch, first heartbeat), so its elapsed_s is
# launch-to-check instead, an upper bound rather than the true figure.
record_kill() {
  local dir="$1" name="$2" reason="$3" death_epoch="${4:-}"
  mkdir "$dir/.kill-recorded" 2>/dev/null || return 0

  local now started="" elapsed=""
  clock_now
  now="$clock_s"
  if [ -f "$dir/started" ]; then
    started="$(cat "$dir/started" 2>/dev/null)"
    [[ "$started" =~ ^[0-9]+$ ]] || started=""
  fi
  if [ -n "$death_epoch" ] && [ -n "$started" ]; then
    elapsed=$((death_epoch - started))
  elif [ -n "$started" ]; then
    elapsed=$((now - started))
  fi
  [ -n "${elapsed:-}" ] || elapsed="unknown"

  # WHEN it died, not only how long it lived (mantahostels#2694). elapsed_s carries no
  # clock, so a record here cannot be joined to anything else on the
  # machine — a signal trace, a journalctl extract, a PSI sample. The
  # epochs below are that join key, and they are recorded HERE because the
  # job dir that holds `started` and `beat` dies with the job.
  #
  # NEITHER EPOCH IS THE INSTANT OF DEATH, and death_epoch_source is what
  # says which approximation you got:
  #   beat   — `beat`'s mtime, the last heartbeat before the run died. The
  #            toucher sleeps heartbeat_s between touches, so the true
  #            instant is in [death_epoch, death_epoch + heartbeat_s].
  #   clock  — no beat to read, so this recorder's own clock stands in.
  #            An upper bound only, and an unbounded one: nothing says how
  #            long the run lay dead before a check or the watcher noticed.
  # heartbeat_s is emitted for the first of those, since a reader joining
  # this record to a trace needs the window's width and cannot get it from
  # anywhere else once the job dir is gone. It is `null`, rather than a
  # guessed 5, where WFC_BG_HEARTBEAT_S held something non-numeric. And
  # it is THIS process's heartbeat: the watcher inherits the launching run's, but
  # a `check` run from another session reports its own, which is the same
  # figure only because nothing here varies it per run.
  #
  # started_epoch is "unknown" on a run whose `started` file is missing or
  # malformed, matching elapsed_s.
  local death_out death_source=beat
  if [ -n "$death_epoch" ]; then
    death_out="$death_epoch"
  else
    death_out="$now"
    death_source=clock
  fi
  [ -n "$started" ] || started="unknown"

  local heartbeat="$HEARTBEAT_S"
  [[ "$heartbeat" =~ ^[0-9]+$ ]] || heartbeat=null

  local out_exists=false out_size=0
  if [ -f "$dir/out" ]; then
    out_exists=true
    out_size="$(wc -c <"$dir/out" 2>/dev/null | tr -d ' [:space:]')"
    [ -n "$out_size" ] || out_size=0
  fi

  # The wrapped command's own `--queue` chatter (run-vitest.js's
  # waitForGate) lands in this same out file, so the gate's state is read
  # off it rather than reimplemented here — bg-run.sh stays generic to any
  # command, not just a suite run. An immediate pass never announces a wait
  # at all (queue_state stays "n/a", same as a command that never used
  # --queue); "gate opened" and a part-suite's "gate still closed …
  # running anyway" both ran, so read "passed"; a wait still held at the
  # bound, "… — refused, not run", ran nothing, so reads "refused" (#2421,
  # #2714); a wait still announced and unended reads "waiting".
  local queue_state="n/a"
  if [ "$out_exists" = true ]; then
    if grep -qE -- '--queue: (gate opened|gate still closed after [0-9]+s — running anyway)' "$dir/out" 2>/dev/null; then
      queue_state="passed"
    elif grep -qE -- '--queue: .* — refused, not run' "$dir/out" 2>/dev/null; then
      queue_state="refused"
    elif grep -q -- '--queue: a suite is already running; waiting for it' "$dir/out" 2>/dev/null; then
      queue_state="waiting"
    fi
  fi

  local mem_avail rss rss_truncated
  if [ -f "$dir/mem" ]; then
    mem_avail="$(sed -n 's/.*mem_available_mb=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
    rss="$(sed -n 's/.*rss_kb=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
    rss_truncated="$(sed -n 's/.*rss_truncated=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
  fi
  [ -n "${mem_avail:-}" ] || mem_avail="unknown"
  [ -n "${rss:-}" ] || rss="unknown"
  [ -n "${rss_truncated:-}" ] || rss_truncated="unknown"

  # name is caller-chosen and reaches this JSON line unvalidated elsewhere
  # in the script, so it is escaped here rather than trusted.
  local name_esc
  name_esc="${name//\\/\\\\}"
  name_esc="${name_esc//\"/\\\"}"

  # Nothing on this machine reads the signal back off an already-reaped,
  # SIGKILLed process, so a run with no `.signal` marker is recorded as
  # "unknown" rather than guessed — a SIGKILL never gives on_signal() a
  # chance to run, so its absence is not evidence of anything beyond "not
  # SIGTERM/SIGHUP" (mantahostels#2691).
  local signal
  signal="unknown"
  if [ -f "$dir/.signal" ]; then
    signal="$(head -1 "$dir/.signal" 2>/dev/null)"
    [ -n "$signal" ] || signal="unknown"
  fi
  local signal_esc
  signal_esc="${signal//\\/\\\\}"
  signal_esc="${signal_esc//\"/\\\"}"

  local log
  log="$(kill_log_path)"
  mkdir -p "$(dirname "$log")" 2>/dev/null
  printf '{"name":"%s","reason":"%s","started_epoch":"%s","death_epoch":"%s","death_epoch_source":"%s","heartbeat_s":%s,"elapsed_s":"%s","queue_state":"%s","out_bytes":%s,"out_exists":%s,"mem_available_mb":"%s","rss_kb":"%s","rss_truncated":"%s","signal":"%s"}\n' \
    "$name_esc" "$reason" "$started" "$death_out" "$death_source" "$heartbeat" "$elapsed" "$queue_state" "$out_size" "$out_exists" "$mem_avail" "$rss" "$rss_truncated" "$signal_esc" \
    >>"$log"
}

# THE WATCHER (mantahostels#2691). Launched detached (setsid --fork) by cmd_run, one per
# run, so it survives whatever kills $parent. Polls $parent's liveness, not
# the beat file's staleness: checking `status` before `kill -0` on every pass
# means a run that finishes cleanly can never be seen as killed, however the
# two events interleave, since cmd_run always writes `status` before the
# process that would make `kill -0 "$parent"` fail. Bounded by WATCH_CEILING_S,
# or, while the run's suite deadline is pending, by that deadline's kill.
#
# CARRIES ITS OWN RUN TOKEN (mantahostels#2691; the token at mantahostels#3147): `run <name>` on a name
# already alive renames aside and republishes `$dir` (cmd_run), which the OLD
# watcher is still polling. Without this check, the old watcher outlives the
# republish, eventually sees the NEW run's `$parent` (actually its own, now-dead
# one) gone, and records a false kill in the NEW run's directory — taking
# the `.kill-recorded` dedup slot before the new run's real kill, if any,
# ever gets to. Comparing the token at record time against what was captured
# at launch tells a republished dir from the one this watcher was launched
# for; a mismatch means abandon quietly, not record.
#
# THE TOKEN, NOT `started` (mantahostels#3147): `started` is whole seconds, so a relaunch
# inside the same second read as the SAME run and the guard passed the old
# watcher straight through to a false kill on a live one.
#
# THE RECORD IS PINNED TO THE DIRECTORY THE TOKEN WAS READ IN (#1352). By path,
# a republish landing between the token check and record_kill's `mkdir` put the
# old run's kill in the new run's directory, against its `started`, and took its
# dedup slot. So the watcher `cd`s into `$dir` before reading the token and
# records against `.`: a republish after that `cd` replaces the directory under
# the path but not the one this process holds, so no record lands in the new run.
# A relaunch still deleting the old directory can let the old run's own kill
# through, `started` possibly gone; its `.kill-recorded` lands in the grave
# cmd_run renamed the directory to, never the published one (#1355). The kill
# log is resolved before the `cd`, since its default asks git from the cwd.
#
# ITS FIRST ACT IS TO TOUCH THE READY PATH, its fifth argument (#2110), which
# cmd_run's publish waits on.
cmd_watch() {
  [ "$#" -ge 5 ] || die "watch needs a dir, a name, a parent pid, a run token and a ready path"
  local dir="$1" name="$2" parent="$3" launched_for="$4" ready="$5"
  # First, before the git call below: cmd_run's publish is waiting on it. Past
  # WATCH_READY_S, `$tmp` is already published away and the touch fails, unread.
  : >"$ready" 2>/dev/null
  WFC_BG_KILL_LOG="$(kill_log_path)"
  local watch_until mono_unread_logged=""
  clock_now
  watch_until=$((clock_s + WATCH_CEILING_S))
  while :; do
    [ -f "$dir/status" ] && exit 0
    if ! kill -0 "$parent" 2>/dev/null; then
      # LOAD-BEARING, not belt and braces (mantahostels#2691):
      # the loop-top check above and this `kill -0` read are two
      # separate lines with nothing synchronising them, so `status`
      # can be written and the wrapper can exit in the gap between
      # them. A coarse mutation run (multi-second sleeps) never lands
      # in that gap and stays green either way, which is not evidence
      # the branch is unreachable — only that the test's timing never
      # hits it. Removing this would occasionally record a clean
      # finish as `stale-beat`.
      [ -f "$dir/status" ] && exit 0
      cd "$dir" 2>/dev/null || exit 0
      local now_token
      now_token="$(cat token 2>/dev/null)"
      [ "$now_token" = "$launched_for" ] || exit 0
      [ -n "$WATCH_GATE" ] && hold_at_gate "$WATCH_GATE"
      local beat
      beat="$(date -r beat +%s 2>/dev/null)" || beat=""
      record_kill . "$name" "stale-beat" "$beat"
      exit 0
    fi
    clock_now
    if read_deadline "$dir/deadline-$launched_for"; then
      if mono_now; then
        [ "$mono_s" -ge "$((deadline_s + CEILING_GRACE_S))" ] &&
          ceiling_kill "$dir" "$name" "$parent" "$launched_for"
      else
        [ -z "$POLL_LOG" ] || printf 'mono-unread\n' >>"$POLL_LOG"
        [ -n "$mono_unread_logged" ] || note_mono_unread "$dir" "$launched_for"
        mono_unread_logged=1
      fi
    elif [ "$clock_s" -ge "$watch_until" ]; then
      exit 0
    fi
    sleep "$HEARTBEAT_S"
  done
}

# The once-a-run line a poll that cannot read the monotonic clock leaves in
# run $1's output (#3160), pinned to the directory by token $2 as ceiling_kill
# is. No wall-clock fallback: the deadline is on CLOCK_MONOTONIC. Residual: a
# run whose clock never reads is left to its runner's own timer. The leading
# newline ends any partial line the command left.
note_mono_unread() {
  cd "$1" 2>/dev/null || return 0
  [ "$(cat token 2>/dev/null)" = "$2" ] &&
    printf '\n%s\n' "bg-run: the monotonic clock would not read (#2886), so the suite ceiling's backstop skips each poll it fails on (#3160)" >>out
  cd "$OLDPWD" 2>/dev/null || :
}

# Sets deadline_s and deadline_pgid from a runner's deadline file. Fails
# where there is none or it is malformed, so such a run is never killed.
deadline_s=""
deadline_pgid=""
read_deadline() {
  read -r deadline_s deadline_pgid 2>/dev/null <"$1" || return 1
  [[ "$deadline_s" =~ ^[0-9]+$ && "$deadline_pgid" =~ ^[0-9]+$ ]]
}

# Whether group $1 is this run's, for a run launched at epoch $2. A pgid of 0
# or 1 never is: `kill -- -1` reaches every process this user owns. A leader
# started before the launch is a recycled pid. A leader gone while its group
# lives keeps the pgid from reuse, so a missing leader still counts.
group_is_runs() {
  local pgid="$1" started="$2" stat btime
  [ "$pgid" -gt 1 ] || return 1
  [[ "$started" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat 2>/dev/null <"/proc/$pgid/stat" || return 0
  local -a fields
  read -ra fields <<<"${stat##*) }"
  btime="$(awk '/^btime/ {print $2}' /proc/stat)"
  # fields[19] is stat's 22nd, the start time in clock ticks since boot. btime
  # is truncated to the second, so a leader started in the launch's own
  # second can read one second early.
  [ "$((btime + fields[19] / $(getconf CLK_TCK)))" -ge "$((started - 1))" ]
}

# The backstop's kill (#2704), pinned to the run's directory by its token as
# the stale-beat record is (cmd_watch). `ceiling-kill` is written before the
# kill, so the `status` the dying command's return leaves is read as one.
ceiling_kill() {
  local dir="$1" name="$2" parent="$3" launched_for="$4"
  cd "$dir" 2>/dev/null || exit 0
  [ "$(cat token 2>/dev/null)" = "$launched_for" ] || exit 0
  read_deadline "deadline-$launched_for" || exit 0
  printf 'grace_s=%s\n' "$CEILING_GRACE_S" >ceiling-kill
  if [ -f status ]; then
    rm -f ceiling-kill
    exit 0
  fi
  group_is_runs "$deadline_pgid" "$(cat started 2>/dev/null)" &&
    kill -KILL -- "-$deadline_pgid" 2>/dev/null
  collect_descendants "$parent" "$(cat .toucher 2>/dev/null)"
  [ "${#descendants[@]}" -eq 0 ] || kill -KILL "${descendants[@]}" 2>/dev/null
  record_kill . "$name" "ceiling"
  exit 0
}

# WATCH_GATE's and CHECK_GATE's wait, above, on gate path $1. On its ceiling
# the caller goes on anyway.
hold_at_gate() {
  : >"$1.waiting"
  local i
  for ((i = 0; i < GATE_S * 10; i++)); do
    [ -e "$1" ] && return 0
    sleep 0.1
  done
}

# Whether run directory $1 still holds the run whose token was $2: present,
# carrying that token, and present after the token read too, so a directory
# renamed away between the two reads is not taken for a tokenless one.
holds_run() {
  [ -d "$1" ] || return 1
  [ "$(cat "$1/token" 2>/dev/null)" = "$2" ] && [ -d "$1" ]
}

# Sets verdict, verdict_code, kill_reason, kill_beat, read_fault, read_token,
# out_size and out_tail from run directory $1, writing nothing, and fails
# where the directory stopped holding the run it opened on before the read
# ended (#3097). A same-name re-run renames the old directory to its grave and
# deletes it (cmd_run), so a read overlapping that sees files vanish: an
# unreadable status, or no beat, which would read as a kill that never
# happened. Each run carries its own token, so one unchanged across the read
# means every file read was that run's. The output is read here too, for the
# same reason; a NUL byte in it does not survive the variable.
read_run() {
  local dir="$1" name="$2" try="$3"
  verdict="" verdict_code=3 kill_reason="" kill_beat="" read_fault=""
  read_token="$(cat "$dir/token" 2>/dev/null)"
  [ -z "$CHECK_GATE" ] || hold_at_gate "$CHECK_GATE.$try"

  if [ -f "$dir/status" ]; then
    local code
    code="$(sed -n 's/^exit=//p' "$dir/status" 2>/dev/null | head -1)"
    if [ -z "$code" ]; then
      read_fault="status file for $name is unreadable"
    # A zero exit finished on its own, the kill landing after it returned.
    elif [ -f "$dir/ceiling-kill" ] && [ "$code" != 0 ]; then
      local grace
      grace="$(sed -n 's/^grace_s=//p' "$dir/ceiling-kill" 2>/dev/null | head -1)"
      verdict="DONE exit=$code ceiling-kill: bg-run killed it ${grace:-?}s past its suite deadline"
      verdict_code=0
    else
      verdict="DONE exit=$code"
      verdict_code=0
    fi
  elif [ ! -f "$dir/beat" ]; then
    verdict="KILLED before the first beat"
    verdict_code=1
    kill_reason=before-first-beat
  else
    local beat age
    if beat="$(date -r "$dir/beat" +%s 2>/dev/null)"; then
      clock_now
      age=$((clock_s - beat))
      if [ "$age" -gt "$STALE_S" ]; then
        verdict="KILLED ${age}s ago"
        verdict_code=1
        kill_reason=stale-beat
        kill_beat="$beat"
      else
        verdict="RUNNING last beat ${age}s ago"
        verdict_code=2
      fi
    else
      read_fault="cannot stat $dir/beat"
    fi
  fi
  out_size="$(wc -c <"$dir/out" 2>/dev/null | tr -d ' [:space:]')"
  [ -n "$out_size" ] || out_size=0
  { out_tail="$(
    tail -c "$INLINE_CAP" "$dir/out" 2>/dev/null
    printf x
  )"; } 2>/dev/null
  out_tail="${out_tail%x}"
  holds_run "$dir" "$read_token"
}

# A read that loses its run to a re-run starts again on the directory that
# replaced it, once; a second loss is answered UNKNOWN. The kill is
# recorded from inside the directory, as the watcher's is, so a re-run
# publishing after the read still takes none of its record (#1352). A read
# that ends before a re-run's rename answers for the run being replaced: a
# caller re-running a name waits for its new `token` before trusting `check`.
cmd_check() {
  [ "$#" -ge 1 ] || die "check needs a name"
  local name="$1"
  local dir try
  for try in 1 2; do
    dir="$(require_run_dir "$name")" || exit $?
    read_run "$dir" "$name" "$try" && break
    [ "$try" -eq 2 ] && die "run $name was replaced twice while check read it"
  done
  [ -z "$read_fault" ] || die "$read_fault"

  printf '%s\n' "$verdict"
  if [ -n "$kill_reason" ]; then
    [ -z "$CHECK_GATE" ] || hold_at_gate "$CHECK_GATE.record"
    (
      WFC_BG_KILL_LOG="$(kill_log_path)"
      cd "$dir" 2>/dev/null || exit 0
      [ "$(cat token 2>/dev/null)" = "$read_token" ] || exit 0
      record_kill . "$name" "$kill_reason" "$kill_beat"
    )
  fi
  print_inline "$dir/out"
  return "$verdict_code"
}

cmd_wait() {
  [ "$#" -ge 1 ] || die "wait needs a name"
  local name="$1"
  # 60s is a guess: under the Bash tool's 120s default timeout with room for
  # the wrapping call's own overhead, long enough to be worth blocking for.
  local ceiling="${2:-60}"
  # `start` is taken BEFORE require_run_dir, not after: the caller's ceiling is
  # a promise about this whole call, and a directory that takes most of
  # MISSING_S to appear must not buy the poll loop below a fresh clock on
  # top of it (mantahostels#2609). The promise does not reach require_run_dir
  # itself: a held publish (#2688) can keep it past a ceiling under 9 s.
  local start
  clock_now
  start="$clock_s"
  require_run_dir "$name" >/dev/null || exit $?

  # The loop asks the one authority on DONE/KILLED/RUNNING — cmd_check — and
  # repeats only while it says RUNNING (exit 2). Only stdout is discarded on
  # a poll that isn't the last: a `die` in here (an unreadable status file,
  # an unstat-able beat) still exits the whole script at once, and its
  # stderr message must stay visible.
  local now code
  while :; do
    cmd_check "$name" >/dev/null
    code=$?
    [ -z "$POLL_LOG" ] || printf '%s\n' "$code" >>"$POLL_LOG"
    [ "$code" -ne 2 ] && break
    clock_now
    now="$clock_s"
    [ "$((now - start))" -ge "$ceiling" ] && break
    sleep "$WAIT_POLL_S"
  done
  cmd_check "$name"
}

main() {
  [ "$#" -ge 1 ] || die "usage: bg-run.sh run|check|wait <name> [command...]"
  local verb="$1"
  shift
  case "$verb" in
    run) cmd_run "$@" ;;
    check) cmd_check "$@" ;;
    wait) cmd_wait "$@" ;;
    # Internal — only cmd_run's own setsid spawn calls this (mantahostels#2691). Not
    # documented in the usage line above; a caller has no reason to run it
    # directly and nothing here validates it against being called any other way.
    __watch) cmd_watch "$@" ;;
    *) die "unknown verb $verb — expected run, check or wait" ;;
  esac
}

main "$@"
