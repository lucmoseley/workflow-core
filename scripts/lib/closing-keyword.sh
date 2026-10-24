# shellcheck shell=bash
# closing-keyword.sh — the one copy of "does this commit message close an issue?"
#
# SOURCED, never run. Two callers (workflow-core#138):
#
#   scripts/guard-commit-form.sh          the PreToolUse deny, which sees
#                                         `-m`/`--message` values and nothing else
#   scripts/check-commit-message-closes.sh the git-hook scanner, which sees the
#                                         finished message file whatever route
#                                         wrote it
#
# ALL NINE OF GITHUB'S KEYWORDS: `close`, `closes`, `closed`, `fix`, `fixes`,
# `fixed`, `resolve`, `resolves`, `resolved`, each followed by a reference.
# GitHub honours all nine, case-insensitively. An optional `:` between the
# keyword and the reference is the trailer spelling of the same thing.
#
# ALL THREE SPELLINGS OF THE REFERENCE (mantahostels#2652): the bare `#12`, the cross-repo
# `owner/repo#12`, and the full issue URL. GitHub closes on any of them.
CLOSING_KEYWORD='(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*'
CLOSING_REPO='([a-z0-9._-]+/[a-z0-9._-]+)?'
CLOSING_URL='https?://github\.com/[a-z0-9._-]+/[a-z0-9._-]+/issues/[0-9]+([^0-9]|$)'

# The offending text, as it was typed, for the caller's refusal to quote back.
closing_match=""

# closes_keyword_match <text> — 0 on a hit, and sets $closing_match.
#
# MATCHED CASE-INSENSITIVELY THROUGH `nocasematch` RATHER THAN AGAINST A
# LOWERCASED COPY, so BASH_REMATCH keeps the caller's own capitalisation. The
# shell option is restored rather than unset: guard-commit-form.sh's other
# `[[ =~ ]]` tests are written for the default and a leaked `nocasematch` would
# change verdicts elsewhere.
closes_keyword_match() {
  local text="$1" restore m
  restore="$(shopt -p nocasematch)"
  shopt -s nocasematch
  if ! [[ "$text" =~ (^|[^a-z])${CLOSING_KEYWORD}(${CLOSING_REPO}\#[0-9]+|${CLOSING_URL}) ]]; then
    eval "$restore"
    return 1
  fi
  m="${BASH_REMATCH[0]}"
  eval "$restore"
  # The match carries its boundary characters — the word separator the leading
  # `(^|[^a-z])` consumed, and for the URL arm the non-digit that ends it.
  m="${m#"${m%%[[:alnum:]]*}"}"
  m="${m%"${m##*[[:alnum:]]}"}"
  # shellcheck disable=SC2034  # read by both callers' refusal text, not here
  closing_match="$m"
  return 0
}

# The refusal's rule text, resolved from docs/agents/rules/commit-closes-keyword.txt.
# HERE rather than in either caller (workflow-core#138): both print the same refusal.
#
# The `source` failure is swallowed deliberately: rule-text.sh is absent from a
# fixture that copied only this file, and a missing FRAGMENT must not turn a
# refusal into a crash.
# shellcheck source=scripts/lib/rule-text.sh
source "$(dirname "${BASH_SOURCE[0]}")/rule-text.sh" 2>/dev/null
closing_rule_text() {
  local text where
  if declare -F rule_text >/dev/null 2>&1 && text="$(rule_text commit-closes-keyword 2>/dev/null)"; then
    printf '%s' "$text"
    return 0
  fi
  # rule-text.sh brings doc_path with it; an adopter reads the plugin's copy (workflow-core#1010).
  where="$(doc_path agents/rules/commit-closes-keyword.txt 2>/dev/null)" || where=docs/agents/rules/commit-closes-keyword.txt
  printf '%s' "Never write a closing keyword before an issue reference in a commit message — write \`Refs #n\` instead. The rule itself could not be read from ${where}; read that file before doing anything else."
}
