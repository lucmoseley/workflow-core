#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT=$PWD

D=$ROOT/.claude/tmp/census-$(date +%Y%m%d-%H%M%S)
if [[ $# -gt 0 ]] && [[ "$1" != "--" ]]; then
  case "$1" in
    /*) D=$1 ;;
    *) D=$ROOT/$1 ;;
  esac
  shift
fi
[[ "${1:-}" = "--" ]] && shift

mkdir -p "$D/bin" || exit 1
cp "$ROOT/scripts/census/git-path-shim.sh" "$D/bin/git" || exit 1
chmod +x "$D/bin/git" || exit 1
[[ -x "$D/bin/git" ]] || {
  echo "run.sh: shim not executable at $D/bin/git" >&2
  exit 1
}

: >"$D/wrapper.log"
export SPAWNLOG="$D/spawn.log"
export RIP_CENSUS_LOG="$D/wrapper.log"
export PATH="$D/bin:$PATH"

npm run test -- --queue --full=other --config "$ROOT/scripts/census/vitest.config.ts" "$@" \
  >"$D/run.log" 2>&1
code=$?
echo "vitest exit $code, logs in $D"
exit $code
