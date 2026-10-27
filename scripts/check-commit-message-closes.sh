#!/usr/bin/env bash
# check-commit-message-closes.sh — the path .husky/commit-msg and
# .husky/prepare-commit-msg run with `bash`, in this repo and every adopter's;
# the scanner is check-commit-message-closes.js. No node is a failed exec, a
# non-zero exit, so the hook refuses rather than passing the message unread.
set -uo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/check-commit-message-closes.js" "$@"
