#!/usr/bin/env bash
# check-commit-message-closes.sh — refuse a commit message that closes an issue.
#
# NOT IN THE `check-*` FAMILY, despite the name: those are node scripts reporting
# a survey, and this is shell that refuses one commit. It exits 0 or 1, not the
# family's alphabet.
#
# Usage: check-commit-message-closes.sh <message-file> <context>
#   <context> names the seam for the refusal text: `commit-msg` or
#   `prepare-commit-msg`.
#
# WHY A SECOND DETECTOR (workflow-core#138). scripts/guard-commit-form.sh denies the same
# pattern, but it is a PreToolUse hook on the Bash tool and reads `-m`/
# `--message` values alone. Four routes reach GitHub past it: `git commit -F
# <file>`, a message reused with `-c`/`-C`, a message typed into $EDITOR, and
# any commit made from the founder's own terminal, which no PreToolUse hook
# sees. A git hook sees all four, because it reads the finished message file.
#
# The pattern itself is scripts/lib/closing-keyword.sh, shared with that guard
# so the two cannot drift.
#
# WHAT IS STRIPPED BEFORE MATCHING, and why each would otherwise fire:
#   - `#`-prefixed lines: git's own template block, which names the branch and
#     the staged paths. `#` is hard-coded, so a repository setting
#     `core.commentChar` elsewhere has its template block scanned as message
#     text.
#   - everything from the scissors line (`# ------------------------ >8 …`):
#     under `git commit --verbose` the diff sits below it UNPREFIXED, so a
#     commit editing this repo's own rule text would match its own diff.
#   - a `Revert "…"` line: `git revert` of a pre-workflow-core#129 commit generates `Revert
#     "Fixes #77 …"` verbatim, and refusing there strands a revert behind a
#     message nobody wrote (measured at workflow-core#138).
#
# THE RESIDUAL that last strip leaves: GitHub does honour a keyword inside the
# quoted subject, so reverting a pre-rule commit re-closes its issue silently.
#
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
msg_file="${1-}"
context="${2-commit}"

if [[ -z "$msg_file" || ! -r "$msg_file" ]]; then
  echo "$context: cannot read the commit message file ('${msg_file}')." >&2
  echo "  Refusing rather than passing a message nothing has read (workflow-core#138)." >&2
  exit 1
fi

# shellcheck source=scripts/lib/closing-keyword.sh
source "$here/lib/closing-keyword.sh"

message="$(awk '
	/^# -+ >8 -+/ { exit }
	/^#/          { next }
	/^Revert "/   { next }
	{ print }
' "$msg_file")"

closes_keyword_match "$message" || exit 0

rule="$(closing_rule_text)"

{
  echo "$context: this commit message closes an issue server-side the moment it is pushed."
  echo
  echo "What matched: $closing_match"
  echo
  echo "$rule"
  echo
  echo "Rewrite the message with a non-closing reference and commit again."
} >&2
exit 1
