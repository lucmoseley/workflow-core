#!/usr/bin/env bash
# check-commit-message-closes.sh — the path .husky/commit-msg and
# .husky/prepare-commit-msg run with `bash`, in this repo and every adopter's;
# the scanner is check-commit-message-closes.js. No node is a failed exec, a
# non-zero exit, so the hook refuses rather than passing the message unread.
set -uo pipefail
# This script's directory without a `dirname` fork; `.` where run by a bare name.
here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
exec node "$here/check-commit-message-closes.js" "$@"
