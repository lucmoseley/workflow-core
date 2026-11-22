#!/usr/bin/env bash
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
grep -qE '^#!.*\b(bash|sh)\b' <<<"$(head -1 "$guard")" || {
  echo "measure-guard-forks: $guard's shebang is not bash/sh — this harness" >&2
  echo "  counts shell-guard forks; a node/python hook needs a different trace." >&2
  exit 1
}

# This script's directory without a `dirname` fork; `.` where run by a bare name.
here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
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
