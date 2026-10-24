# shellcheck shell=bash
# main-rewind.sh — the one refusal of a command that moves `main` backwards,
# printing docs/agents/rules/main-rewind.txt (workflow-core#765, workflow-core#1733, workflow-core#1777).
#
# SOURCED, never run, after lib/guard-parse.sh.
#
# guard-fire-needles.json keys the fallback below, and keys guard-branch-
# publish.sh's two framings ("force-pushes", "` on the remote") apart from the
# rest; reword either there too.

# The rule where the fragment is unreadable, which still refuses (workflow-core#772).
REWIND_RULE_FALLBACK="Never move \`main\` backwards; the rule could not be read from docs/agents/rules/main-rewind.txt. Read that file before doing anything else."

# rewind_deny <segment> <what the command does, completing "This …">
# guard-branch-publish.sh and guard-pull-form.sh each mirror it as a stub that
# still refuses, ruleless, when this file does not load.
rewind_deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2: @CMD@

$(gp_rule_text main-rewind "$REWIND_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}
