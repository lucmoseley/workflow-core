#!/usr/bin/env bash
# link-sub-issue.sh <parent> <child> [--replace-parent] — make <child> a
# sub-issue of <parent>, refusing a link that would close a loop of open
# issues waiting on each other (#5070).
#
# The writer is scripts/lib/link-writer.js, whose header holds why each step
# is there and the exit codes: 0 linked, 3 refused with nothing changed (a
# self-link or a loop), 1 any other failure. --replace-parent re-roots a child
# that already has a parent.
#
# Test seams: WFC_LINK_RETRIES, WFC_LINK_SLEEP, WFC_LINK_REPO (owner/name,
# else the tracker), WFC_GH.

set -euo pipefail

# This script's directory without a `dirname` fork; `.` where run by a bare name.
here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
exec node "$here/lib/link-writer.js" sub-issue "$@"
