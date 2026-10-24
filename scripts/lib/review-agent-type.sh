#!/usr/bin/env bash
# The subagent type the two review axes are dispatched on (workflow-core#741).
#
# SOURCED, NEVER RUN. Needs gr_root (lib/guard-root.sh), sourced here if absent.
#
# A PLUGIN AGENT IS NAMESPACED: an adopter, which has only the plugin's copy,
# is offered `workflow-core:code-reviewer`, and a bare `code-reviewer` is
# refused as not found. The core runs from its own `.claude/agents/`, where the
# bare name is the only one. So the host's own definition, where present, wins.
#
# Three routes name the type — guard-review-rules.sh, inject-tracker-docs.sh
# and concision-backstop.sh — and lib/review-suffix.test.ts holds them to this
# answer on both kinds of host.
if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$(dirname "${BASH_SOURCE[0]}")/guard-root.sh"
fi

review_agent_type() {
  if [[ -f "$(gr_root)/.claude/agents/code-reviewer.md" ]]; then
    printf 'code-reviewer'
  else
    printf 'workflow-core:code-reviewer'
  fi
}
