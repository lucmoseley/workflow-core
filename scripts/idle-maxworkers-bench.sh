#!/usr/bin/env bash
set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
cd "$(gr_root)" || exit 1

OUT=".maxworkers-bench.findings.md"
LOG=".maxworkers-bench.log"

# guess: the one-suite rung plus room for the extra workers, lucmoseley/mantahostels#1906
FLOOR_MB="${WFC_BENCH_FLOOR_MB:-4200}"
# guess: a quiet 1-minute load on 8 cores, lucmoseley/mantahostels#1906
MAX_LOAD="${WFC_BENCH_MAX_LOAD:-2.0}"
# guess: one quiet minute is a gap between sessions, several are idle, lucmoseley/mantahostels#1906
QUIET_POLLS_NEEDED="${WFC_BENCH_NEEDED:-5}"
# guess, lucmoseley/mantahostels#1906
POLL_S="${WFC_BENCH_POLL_S:-60}"
# guess, lucmoseley/mantahostels#1906
MAX_WAIT_S="${WFC_BENCH_MAX_WAIT_S:-28800}"
ARMS="${WFC_BENCH_ARMS:-2 4 6 2}"

say() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

available_mb() { free -m | awk 'NR==2{print $7}'; }
# #3608
load1() { awk '{print $1}' /proc/loadavg; }
suite_running() { pgrep -f "vitest" >/dev/null 2>&1; }

say "waiting for idle: floor ${FLOOR_MB}MB, load<${MAX_LOAD}, ${QUIET_POLLS_NEEDED} consecutive polls"

quiet=0
waited=0
while :; do
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
    say "quiet ${quiet}/${QUIET_POLLS_NEEDED} (${mb}MB, load ${ld})"
  fi

  [[ "$quiet" -ge "$QUIET_POLLS_NEEDED" ]] && break

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
  sleep 30
done

{
  printf '\nRead this against docs/environment.md §6 before acting on it: a\n'
  printf 'faster arm that needed more headroom than the rungs allow is not a\n'
  printf 'usable setting. Raising WHOLE_SUITE_WORKERS in scripts/lib/suite-bounded.js is the change\n'
  printf 'these numbers argue for or against (mantahostels#1906).\n'
} >>"$OUT"
say "finished"
