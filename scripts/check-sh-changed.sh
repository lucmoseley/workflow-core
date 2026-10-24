#!/usr/bin/env bash
#
# check-sh-changed.sh — check:sh over only the shell files that differ from
# HEAD, staged, unstaged or untracked and new (#1015). package.json's comments
# entry for check:sh:changed owns the scope and its limit.
#
# NOT IN THE `check-*` runCheck FAMILY: it passes shellcheck's own exit code
# through, and exits 127 — the shell's command-not-found code — when the binary
# is absent.
#
# The file set is check:sh's, picked by scripts/lib/formatters.js (#1828); the
# flags mirror check:sh's, whose comments entry owns their rationale, and
# check-sh-changed.test.ts fails when they drift. It waits on the shellcheck lock
# every other shellcheck run takes, lib/serialised.sh's (#2627).

set -euo pipefail

lib="$(cd "$(dirname "$0")" && pwd)/lib"
cd "$(git rev-parse --show-toplevel)"

changed="$(
  {
    git diff --name-only --diff-filter=ACMR HEAD
    git ls-files --others --exclude-standard
  } | sort -u
)"
shell="$(printf '%s\n' "$changed" | node "$lib/formatters.js" shell-files)"

paths=()
while IFS= read -r p; do
  # A path deleted from the worktree is gone, not changed; shellcheck would
  # fail on "does not exist" rather than on a finding.
  if [ -n "$p" ] && [ -f "$p" ]; then paths+=("$p"); fi
done <<<"$shell"

if [ "${#paths[@]}" -eq 0 ]; then
  echo "check:sh:changed: no shell file differs from HEAD — nothing to check."
  exit 0
fi

command -v shellcheck >/dev/null 2>&1 || {
  echo "check:sh:changed: shellcheck is not on PATH — nothing was checked." >&2
  echo "  npm install does not supply it; see docs/agents/rules/shellcheck-not-installed.txt for the aarch64 binary this machine uses." >&2
  exit 127
}

echo "check:sh:changed: ${#paths[@]} file(s): ${paths[*]}"
sh "$lib/serialised.sh" check:sh:changed shellcheck \
  shellcheck -x --severity=style --exclude=SC2329,SC2016 "${paths[@]}"
