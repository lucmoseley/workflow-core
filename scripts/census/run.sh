#!/usr/bin/env bash
# run.sh — the git-spawn census's own run script (mantahostels#2218). Runs both
# instruments together (git-path-shim.sh, git-spawn-wrapper.setup.ts, this
# directory): the wrapper alone undercounts idle to zero on any file with a
# destructured node:child_process import. Usage:
#
#   scripts/census/run.sh [output-dir] -- <vitest file args...>
#
# output-dir may be relative (resolved against the repo root, never the
# caller's cwd) or absolute; it defaults to .claude/tmp/census-<timestamp>.
# Pass one file or a small batch as the vitest args — a whole-suite run works
# too, but then spawn.log's totals need the worker-pid -> file join, which
# this script does not build.
#
# Writes into output-dir: spawn.log (PATH shim, every git spawn), wrapper.log
# (RIP_CENSUS_LOG, this file's ACTIVE/idle split — created empty up front, so
# its absence after the run would mean the wrapper never loaded rather than
# "logged nothing"), run.log (the suite's own output). Computing idle =
# spawn.log's total for a file − wrapper.log's ACTIVE count is analysis, left
# to the caller.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT=$PWD

D=$ROOT/.claude/tmp/census-$(date +%Y%m%d-%H%M%S)
if [ $# -gt 0 ] && [ "$1" != "--" ]; then
  case "$1" in
    /*) D=$1 ;;
    *) D=$ROOT/$1 ;;
  esac
  shift
fi
[ "${1:-}" = "--" ] && shift

mkdir -p "$D/bin" || exit 1
cp "$ROOT/scripts/census/git-path-shim.sh" "$D/bin/git" || exit 1
chmod +x "$D/bin/git" || exit 1
[ -x "$D/bin/git" ] || {
  echo "run.sh: shim not executable at $D/bin/git" >&2
  exit 1
}

: >"$D/wrapper.log"
export SPAWNLOG="$D/spawn.log"
export RIP_CENSUS_LOG="$D/wrapper.log"
export PATH="$D/bin:$PATH"

# --full=other: a no-op today, readying this caller for mantahostels#3154's narrowed
# default — it is stripped before vitest either way, so passing a file/batch
# via "$@" still narrows exactly as the header above describes (mantahostels#3206).
# `other` (#182): census instrumentation, not one of the five named buckets.
npm run test -- --queue --full=other --config "$ROOT/scripts/census/vitest.config.ts" "$@" \
  >"$D/run.log" 2>&1
code=$?
echo "vitest exit $code, logs in $D"
exit $code
