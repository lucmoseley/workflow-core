#!/usr/bin/env bash

set -euo pipefail

lib="${0%/*}"
[[ "$lib" == "$0" ]] && lib=.
lib="$(cd "$lib" && pwd)/lib"
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
  if [[ -n "$p" ]] && [[ -f "$p" ]]; then paths+=("$p"); fi
done <<<"$shell"

if [[ "${#paths[@]}" -eq 0 ]]; then
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
  shellcheck -x --severity=style --exclude=SC2016 "${paths[@]}"
