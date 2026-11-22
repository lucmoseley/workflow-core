#!/usr/bin/env bash
_rat_here="${BASH_SOURCE[0]%/*}"
[[ "$_rat_here" == "${BASH_SOURCE[0]}" ]] && _rat_here=.
if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$_rat_here/guard-root.sh"
fi
unset _rat_here

review_agent_type() {
  if [[ -f "$(gr_root)/.claude/agents/code-reviewer.md" ]]; then
    printf 'code-reviewer'
  else
    printf 'workflow-core:code-reviewer'
  fi
}
