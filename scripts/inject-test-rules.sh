#!/usr/bin/env bash
# inject-test-rules.sh — PreToolUse hook: hand a session base §X8, §X9 and §X10
# the first time it writes a test file (#1887, spec #1869 §Delivery).
#
# A test file is any path base §X binds, by scripts/lib/test-kind.js's
# isTestKind, or a test a runner collects (its COLLECTED_TEST), which a local
# route row may send to §X, as design-vault's `*.test.py` (#1266).
#
# IMPLICIT: injects base §X8, §X9 and §X10, generated from docs/code-standards-base.md, into a session the first time it writes a test file, once per session and agent.
# JUSTIFIED: fail-safe — the base otherwise reaches a session only at /code-review, after a slow or unselectable test is written (#1869).
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are said again; listing this hook under the host's `disabled` silences it.
#
# LIMITS
#  - INJECTION ONLY: it never refuses (#1795).
#  - A test file written through Bash is never seen.
#  - Priority order is §X8, §X9, §X10: a deferral under GP_RULE_CAP carries the
#    later ids to the next test write, unlatched.
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — test rules not injected"
  exit 0
}

gp_begin '.tool_input.file_path // .tool_input.notebook_path' "write" "file path"
target="$(gp_subject)"

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
root="$(gr_root)"
# Repo-relative, so a `tests/` above the checkout is never read as one in it;
# a write outside the checkout is no test of this repo's.
rel="$(gp_repo_rel "$target" "$root")" || gp_allow

# Every path either predicate matches carries one of these words.
case "$rel" in
  *test* | *spec* | *fixture* | *stub* | *fake* | *harness*) ;;
  *) gp_allow ;;
esac

node -e 'const m = require(require("node:path").resolve(process.argv[1])); process.exit(m.isTestKind(process.argv[2]) || m.COLLECTED_TEST.test(process.argv[2]) ? 0 : 3)' \
  "$here/lib/test-kind.js" "$rel" 2>/dev/null
case $? in
  0) ;;
  3) gp_allow ;;
  *) gl_open "lib/test-kind.js's predicates did not run — test rules not injected" ;;
esac

gp_rule test-run-cost test-time-seam test-reads-visible
gp_allow
