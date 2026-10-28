#!/usr/bin/env bash
#
# idle-maxworkers-bench.sh — wait for a genuinely quiet machine, then time the
# whole suite at several worker counts.
#
# WHY IT WAITS RATHER THAN JUST RUNNING (mantahostels#1906). maxWorkers has sat at 2 since
# mantahostels#1906 measured it and could not get a clean reading: a neighbour session's load
# swamped both benchmark arms, so no win was measurable and none was disproved
# either. The reading is only worth taking on an idle machine, and the machine is
# idle at times nobody is sitting at it.
#
# IT REAPS ON EVERY POLL, AND THAT IS LOAD-BEARING. A finished-but-resident
# Claude session holds 330-450 MB that it is about to give back, and `free` reads
# that as spent. Without a reap first, the waiter reads a busy machine that is
# actually idle and would never fire at all.
#
# IT NEVER RUNS TWO SUITES AT ONCE, and re-checks headroom between arms: the arms
# run sequentially, and one that starts below the floor is skipped rather than
# taking the machine down. docs/environment.md §6 is the authority on the
# rungs; this only ever runs ONE suite, so the one-suite rung is what binds.
#
# Usage:
#   nohup scripts/idle-maxworkers-bench.sh >/dev/null 2>&1 &
#
# Results, appended as each arm finishes so a killed run still leaves its data:
#   .maxworkers-bench.findings.md

set -uo pipefail

# This script's directory without a `dirname` fork; `.` where run by a bare name.
here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
cd "$(gr_root)" || exit 1

OUT=".maxworkers-bench.findings.md"
LOG=".maxworkers-bench.log"

# The rung a single suite needs (docs/environment.md §6), plus room for the
# extra workers this is here to test.
FLOOR_MB="${WFC_BENCH_FLOOR_MB:-4200}"
# 1-minute load average below which the machine counts as quiet, on 8 cores.
MAX_LOAD="${WFC_BENCH_MAX_LOAD:-2.0}"
# Consecutive quiet polls required. One quiet minute is a gap between two
# sessions; several in a row is an idle machine.
NEEDED="${WFC_BENCH_NEEDED:-5}"
POLL_S="${WFC_BENCH_POLL_S:-60}"
# Stop waiting eventually rather than polling for ever.
MAX_WAIT_S="${WFC_BENCH_MAX_WAIT_S:-28800}"
ARMS="${WFC_BENCH_ARMS:-2 4 6 2}"

say() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

available_mb() { free -m | awk 'NR==2{print $7}'; }
load1() { awk '{print $1}' /proc/loadavg; }
suite_running() { pgrep -f "vitest" >/dev/null 2>&1; }

say "waiting for idle: floor ${FLOOR_MB}MB, load<${MAX_LOAD}, ${NEEDED} consecutive polls"

quiet=0
waited=0
while :; do
  # Reap FIRST: the memory a finished session is holding is memory this check
  # would otherwise count against itself.
  node scripts/reap-finished-sessions.js >>"$LOG" 2>&1

  mb=$(available_mb)
  ld=$(load1)
  if suite_running; then
    quiet=0
    say "not idle: a suite is already running"
  elif [[ "$mb" -lt "$FLOOR_MB" ]]; then
    quiet=0
    say "not idle: ${mb}MB available, need ${FLOOR_MB}"
  elif awk -v a="$ld" -v b="$MAX_LOAD" 'BEGIN{exit !(a>=b)}'; then
    quiet=0
    say "not idle: load ${ld}, need below ${MAX_LOAD}"
  else
    quiet=$((quiet + 1))
    say "quiet ${quiet}/${NEEDED} (${mb}MB, load ${ld})"
  fi

  [[ "$quiet" -ge "$NEEDED" ]] && break

  if [[ "$waited" -ge "$MAX_WAIT_S" ]]; then
    say "gave up waiting after ${waited}s"
    printf '\n## Gave up\n\nNo idle window in %ss.\n' "$waited" >>"$OUT"
    exit 0
  fi
  sleep "$POLL_S"
  waited=$((waited + POLL_S))
done

say "idle reached; benchmarking arms: ${ARMS}"
{
  printf '\n## maxWorkers benchmark — %s\n\n' "$(date -Is)"
  printf 'Machine idle at start: %sMB available, load %s. One suite at a time.\n\n' \
    "$(available_mb)" "$(load1)"
  printf '| maxWorkers | wall (s) | files | tests | failed | avail before (MB) |\n'
  printf '|---|---|---|---|---|---|\n'
} >>"$OUT"

for w in $ARMS; do
  before=$(available_mb)
  if [[ "$before" -lt "$FLOOR_MB" ]]; then
    say "skipping maxWorkers=${w}: only ${before}MB available"
    printf '| %s | skipped — %sMB available | | | | |\n' "$w" "$before" >>"$OUT"
    continue
  fi
  say "arm maxWorkers=${w} starting (${before}MB available)"
  t0=$(date +%s)
  # The binary directly, not `npm run test`: this needs the worker count
  # overridden, and it must not trip the pre-test reap's own arithmetic.
  out=$(node_modules/.bin/vitest run --maxWorkers="$w" 2>&1)
  t1=$(date +%s)
  line=$(printf '%s\n' "$out" | grep -E "^ +Tests " | tail -1)
  files=$(printf '%s\n' "$out" | grep -E "^ +Test Files " | tail -1)
  tests=$(printf '%s' "$line" | grep -oE "[0-9]+ passed" | head -1 | cut -d' ' -f1)
  failed=$(printf '%s' "$line" | grep -oE "[0-9]+ failed" | head -1 | cut -d' ' -f1)
  nfiles=$(printf '%s' "$files" | grep -oE "[0-9]+ passed" | head -1 | cut -d' ' -f1)
  printf '| %s | %s | %s | %s | %s | %s |\n' \
    "$w" "$((t1 - t0))" "${nfiles:-?}" "${tests:-?}" "${failed:-0}" "$before" >>"$OUT"
  say "arm maxWorkers=${w} done in $((t1 - t0))s"
  # Let the page cache and any stragglers settle before the next arm, so arm
  # two is not measuring arm one's tail.
  sleep 30
done

{
  printf '\nRead this against docs/environment.md §6 before acting on it: a\n'
  printf 'faster arm that needed more headroom than the rungs allow is not a\n'
  printf 'usable setting. Raising `maxWorkers` in vitest.config.ts is the change\n'
  printf 'these numbers argue for or against (mantahostels#1906).\n'
} >>"$OUT"
say "finished"
