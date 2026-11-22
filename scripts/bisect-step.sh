#!/usr/bin/env bash
set -euo pipefail

npm_bin="${WFC_NPM:-npm}"
node_bin="${WFC_NODE:-node}"
python_bin="${WFC_PYTHON:-python3}"

run_check() {
  local st=0
  "$@" || st=$?
  [[ "$st" -eq 125 ]] && st=1
  return "$st"
}

lint_and_tests() {
  if ! "$npm_bin" ci; then
    echo "bisect-step: npm ci failed — commit is untestable, skipping (125)" >&2
    return 125
  fi

  if [[ ! -x node_modules/.bin/biome ]]; then
    echo "bisect-step: node_modules/.bin/biome absent after a clean install — commit is untestable, skipping (125)" >&2
    return 125
  fi

  local st=0
  run_check node_modules/.bin/biome ci . || st=$?
  [[ "$st" -eq 0 ]] && { run_check "$npm_bin" run check:sh || st=$?; }
  [[ "$st" -eq 0 ]] && { run_check "$npm_bin" run test -- --full=coverage || st=$?; }
  return "$st"
}

python_job() {
  if ! "$python_bin" -m pip install --require-hashes --only-binary :all: -r requirements-dev.txt; then
    echo "bisect-step: pip install failed — commit is untestable, skipping (125)" >&2
    return 125
  fi

  local st=0
  run_check "$npm_bin" run test:py -- --full || st=$?
  return "$st"
}

documents() {
  local st=0
  run_check "$node_bin" scripts/check-doc-map.js || st=$?
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-doc-map-markers.js || st=$?; }
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-guard-registry.js || st=$?; }
  return "$st"
}

everything() {
  local st=0
  lint_and_tests || st=$?
  [[ "$st" -eq 0 ]] && { python_job || st=$?; }
  [[ "$st" -eq 0 ]] && { documents || st=$?; }
  return "$st"
}

check_set="${BISECT_CHECK_SET:-}"
[[ -n "$check_set" ]] || check_set="lint-and-tests"

status=0
case "$check_set" in
  lint-and-tests) lint_and_tests || status=$? ;;
  python) python_job || status=$? ;;
  documents) documents || status=$? ;;
  all) everything || status=$? ;;
  *)
    echo "bisect-step: unknown check set '$check_set' — aborting (128). Expected one of: lint-and-tests, python, documents, all." >&2
    exit 128
    ;;
esac

exit "$status"
