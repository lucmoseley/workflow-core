#!/bin/sh
# Starts checkers through run-budgeted.js, in its hook and budget forms, for
# call-cost-harness.test.ts: each must be recorded as one entry naming the
# wrapper's start and the checker it runs.
set -e
runner="$(cd "$(dirname "$0")/.." && pwd)/run-budgeted.js"
node "$runner" --hook pre-commit --pausable node "$(dirname "$0")/call-cost-child.js"
node "$runner" 60000 1000 git --version >/dev/null
