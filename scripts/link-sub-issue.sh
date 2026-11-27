#!/usr/bin/env bash
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
exec node "$here/lib/link-writer.js" sub-issue "$@"
