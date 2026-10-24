#!/usr/bin/env bash
# guard-citation-tracker.sh — PreToolUse hook: a `Write` or `Edit` adding a
# `mantahostels#N` the inherited tracker never used is named as it lands, and the
# session handed the citation rule (workflow-core#2015, spec workflow-core#1996).
#
# The test is lib/citation-tracker.js's, the one the pre-commit gate
# (check-citation-tracker.js) refuses on.
#
# IMPLICIT: on a Write or Edit adding a mantahostels#N citation the inherited tracker never used, names each such number and injects rule:citation-tracker, the rule once per session and agent.
# JUSTIFIED: fail-safe — the rule left the always-loaded pool for this hook (workflow-core#1942), and the commit gate alone speaks only after the file is written.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rule is said again; a `citation-exempt: <why>` on the line passes it; listing this hook under the host's `disabled` silences it.
#
# LIMITS
#  - INJECTION ONLY: it never refuses.
#  - A citation written through Bash, or by NotebookEdit, is never seen.
#  - It judges the decidable half alone: a number BOTH trackers used passes.
#  - It is silent in an adopter, where `ec8654cd` does not resolve.
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
    gl_open "lib/guard-parse.sh did not load — citation rule not injected"
  exit 0
}

gp_begin '.tool_input.file_path' "write" "file path"
target="$(gp_subject)"

case "$(gp_payload_field '.tool_input.content // .tool_input.new_string')" in
  *mantahostels#*) ;;
  *) gp_allow ;;
esac

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
root="$(gr_root)"
rel="$(gp_repo_rel "$target" "$root")" || gp_allow

# One capture serves both: the CLI writes its notice only on exit 0 and its
# cause only on a failure.
said="$(gp_payload_field '.' | node "$here/lib/citation-tracker.js" "$root" "$rel" 2>&1)"
case $? in
  0) ;;
  3 | 4) gp_allow ;;
  *) gl_open "lib/citation-tracker.js did not judge $rel (${said:0:300}) — citation rule not injected" ;;
esac

gp_rule_prelude "$said"
gp_rule citation-tracker
gp_allow
