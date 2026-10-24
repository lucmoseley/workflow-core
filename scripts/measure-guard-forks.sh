#!/usr/bin/env bash
# Exact per-guard child-process count via strace (mantahostels#1985). Read-only: runs the
# guard against a supplied hook-JSON payload and discards its verdict.
#
# strace traces the guard's own process tree directly, so unlike a /proc-walk
# sampler there is no capture rate to correct — every clone/clone3/vfork/fork
# the guard or its descendants make is counted. CLONE_THREAD is excluded (a
# `node` guard's libuv/V8 threads are not new processes).
#
# COUNTING DECISIONS (code-review mantahostels#1985, standards axis, §G1):
#  - The guard is exec'd directly (its own shebang), the way the real hook
#    launcher runs it — not `bash "$guard"`, which would add the harness's own
#    `bash` to the trace and mask a non-bash guard's real interpreter.
#  - A `<unfinished ...>`/`<resumed>` split line (a syscall that blocked, e.g.
#    on network I/O) still carries the same syscall name and exit value once
#    reassembled by strace, so no special-casing is needed for it.
#  - `= -1` excludes a refused syscall (EAGAIN under load, a `git`/`gh`
#    subprocess denied a resource): it never produced a process.
#
# A ONE-REP WARM-UP runs first, discarded, before the timed reps. Several
# guards (`guard-commit-form.sh` among them) print a rule once per session and
# latch a marker file on the first sight of that session_id — costing extra
# forks on rep 1 only. Without the warm-up, "all reps agreed" is evidence the
# latch had already burned, not evidence of a stable count (mantahostels#1985, spec axis,
# F1: 114 clones unlatched vs 110 latched, measured on `guard-commit-form`).
# Reported figures are steady-state, matching the common case in a real
# session where the latch fires once and stays quiet for the rest of it.
set -euo pipefail

usage() {
  echo "usage: measure-guard-forks.sh <guard-script> <payload.json> [reps]" >&2
  echo "  reps defaults to 5 — enough to catch the 2-value spread a guard" >&2
  echo "  touching live state (gh, the arbiter) can show; mantahostels#1980 used the same" >&2
  echo "  order of magnitude for its own per-guard timing pass." >&2
  exit 1
}

[[ $# -ge 2 ]] || usage
guard="$1"
payload_file="$2"
reps="${3:-5}"
[[ -f "$guard" && -f "$payload_file" ]] || usage
[[ -x "$guard" ]] || {
  echo "measure-guard-forks: $guard is not executable — chmod +x it first" >&2
  exit 1
}
head -1 "$guard" | grep -qE '^#!.*\b(bash|sh)\b' || {
  echo "measure-guard-forks: $guard's shebang is not bash/sh — this harness" >&2
  echo "  counts shell-guard forks; a node/python hook needs a different trace." >&2
  exit 1
}

# shellcheck source=scripts/lib/guard-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-root.sh"
root="$(gr_root)"
cd "$root" || exit 1
export CLAUDE_PROJECT_DIR="$root"

command -v strace >/dev/null 2>&1 || {
  echo "strace not found" >&2
  exit 1
}

trace_dir="$(mktemp -d)"
trap 'rm -rf "$trace_dir"' EXIT

run_once() {
  local out="$1"
  # timeout: a guard branching on a live `gh` call must not hang the sweep.
  timeout 30 strace -f -e trace=clone,clone3,vfork,fork,execve -o "$out" -- \
    "$guard" <"$payload_file" >/dev/null 2>"$out.stderr"
  local strace_status=$?
  if [[ $strace_status -ne 0 || ! -s "$out" ]]; then
    echo "measure-guard-forks: strace exited $strace_status or wrote no trace" \
      "for $guard — treating as a failed measurement, not a zero count" >&2
    [[ -s "$out.stderr" ]] && cat "$out.stderr" >&2
    return 1
  fi
  return 0
}

# Warm-up: burns any once-per-session latch this guard prints, discarded.
run_once "$trace_dir/warmup.out" || echo "measure-guard-forks: warm-up rep failed for $guard" >&2

clone_counts=()
execve_counts=()
for ((i = 1; i <= reps; i++)); do
  out="$trace_dir/rep-$i.out"
  if ! run_once "$out"; then
    echo "guard=$guard FAILED (see stderr above)"
    exit 1
  fi
  # grep -c prints 0 and exits 1 on no match, which -e would take as a fault.
  # Under pipefail an unreadable trace can also surface as 1, so run_once's
  # non-empty check is what rules that out.
  procs=$(grep -E '^\S+ +(clone|clone3|vfork|fork)\(' "$out" | grep -v 'CLONE_THREAD' | grep -vcE '= -1') || (($? == 1))
  execs=$(grep -E '^\S+ +execve\(' "$out" | grep -vcE '= -1') || (($? == 1))
  clone_counts+=("$procs")
  execve_counts+=("$execs")
done
echo "guard=$guard clones=${clone_counts[*]} execs=${execve_counts[*]}"
