#!/usr/bin/env bash
# check-commit-subject.sh — refuse a commit whose subject runs over 72 characters
# (workflow-core#2332, ruled at workflow-core#2172).
#
# Usage: check-commit-subject.sh <message-file> <context>
#   <context> names the seam for the refusal text, as in
#   scripts/check-commit-message-closes.sh.
#
# NOT IN THE `check-*` FAMILY, despite the name: those are node scripts reporting
# a survey, and this is shell that refuses one commit. It exits 0 or 1, not the
# family's alphabet.
#
# Run from .husky/commit-msg, the one hook that reads the finished message on
# every route: `-m`, `-F`, `-c`/`-C`, the editor, commit-paths.js and the
# founder's terminal. scripts/guard-commit-form.sh carries no copy: it sees
# `-m` values alone.
#
# THE SUBJECT is the first line that is neither a comment nor blank, read
# above the scissors line, with trailing whitespace dropped, as git's default
# cleanup drops both. A comment is git's own form, `#` then a space, a tab or
# the line's end: `-m` and `-F` keep a `#2332 …` line as the subject.
#
# LENGTH IS COUNTED IN CHARACTERS: bytes less UTF-8 continuation bytes, so
# no locale is needed.
#
# FAILS CLOSED on an unreadable message file: a commit nothing has measured
# would land a subject of any length.
#
# EXEMPT: git-generated subjects, which wrap a subject nobody typed —
# `Revert "…"`, `Reapply "…"`, git's `Merge branch|branches|tag|commit|
# remote-tracking branch|pull request …` forms, `fixup! …`, `squash! …` and
# `amend! …` (docs/practice/ci-and-repo-quality-gates.md).
set -uo pipefail

# GitHub cuts a subject at 72, and gitlint caps there by default
# (docs/practice/ci-and-repo-quality-gates.md).
LIMIT=72

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
msg_file="${1-}"
context="${2-commit}"

if [[ -z "$msg_file" || ! -r "$msg_file" ]]; then
  echo "$context: cannot read the commit message file ('${msg_file}')." >&2
  echo "  Refusing rather than passing a subject nothing has measured (workflow-core#2332)." >&2
  exit 1
fi

subject="$(awk '
	/^# -+ >8 -+/ { exit }
	/^#([ \t]|$)/ { next }
	/^[[:space:]]*$/ { next }
	{ sub(/[[:space:]]+$/, ""); print; exit }
' "$msg_file")"

case "$subject" in
  'Revert "'* | 'Reapply "'* | 'Merge branch '* | 'Merge branches '* | 'Merge tag '* | 'Merge commit '* | 'Merge remote-tracking branch '* | 'Merge pull request '* | 'fixup! '* | 'squash! '* | 'amend! '*) exit 0 ;;
esac

length="$(printf '%s' "$subject" | LC_ALL=C tr -d '\200-\277' | wc -c | tr -d ' ')"
((length > LIMIT)) || exit 0

# shellcheck source=scripts/lib/rule-text.sh
source "$here/lib/rule-text.sh" 2>/dev/null
if ! declare -F rule_text >/dev/null 2>&1 || ! rule="$(rule_text commit-message 2>/dev/null)"; then
  rule="A commit subject is at most $LIMIT characters. The rule itself could not be read from docs/agents/rules/commit-message.txt; read that file before committing again."
fi

{
  echo "$context: this commit's subject is $length characters, over the $LIMIT-character limit."
  echo
  echo "Subject: $subject"
  echo
  echo "$rule"
  echo
  echo "Shorten the subject, move the why into the body, and commit again."
} >&2
exit 1
