#!/usr/bin/env bash
# hook-limits.sh — the harness's limits on what a hook hands the session (#1746).
#
# Its own file, not a block of guard-parse.sh, so a caller wanting one number
# need not load the whole parser.
#
# SOURCED, NEVER RUN, and read by line too: scripts/check-injector-margin.sh,
# inject-tracker-docs.test.ts and lib/guard-parse.test.ts parse the `NAME=<n>`
# lines, so keep each a bare integer at column zero.

# additionalContext over this many characters is persisted to a file and the
# session handed a ~2 KB preview (mantahostels#1762). Read out of the shipped
# binary by mantahostels#1868 (`V5n=1e4`), so it models a consumer the repo does
# not own and can move unnoticed.
# shellcheck disable=SC2034  # read by inject-tracker-docs.sh, which sources this
HOOK_PERSIST_CHARS=10000
