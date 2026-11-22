#!/bin/sh
set -e
runner="$(cd "$(dirname "$0")/.." && pwd)/run-budgeted.js"
node "$runner" --hook pre-commit --pausable node "$(dirname "$0")/call-cost-child.js"
node "$runner" 60000 1000 git --version >/dev/null
