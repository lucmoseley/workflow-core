#!/usr/bin/env bash
#
# check-injector-margin.sh — what each command's injected payload actually
# measures, against the harness's 10,000-character persistence threshold (mantahostels#1915).
#
# Usage:
#   bash scripts/check-injector-margin.sh            # the STAGED text module
#   bash scripts/check-injector-margin.sh --tree     # the working tree's copy
#
# WHY THIS EXISTS SEPARATELY FROM check-context-budget.js. That checker's
# INJECTION_CAP_BYTES is a union of every payload part the text module holds,
# larger than any real variant and comparable with none. So it cannot report
# the limit that binds, which is per command. This composes each command's
# payload out of the STAGED scripts/lib/tracker-inject-text.js through its own
# composers (scripts/lib/injector-margin.js), which is neither the working
# tree nor a parse: mantahostels#1915's option (A).
#
# CROSSING THE THRESHOLD IS SILENT. The harness persists a payload over 10,000
# characters to a file and hands the session a ~2 KB preview plus a link, which
# /implement opened 10.2% of the time (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md).
#
# NOT IN THE `check-*` FAMILY. That family gates through scripts/lib/check.js's
# `runCheck` and its five-outcome alphabet; this is shell, so it cannot reach
# either.
#
# EXIT ALPHABET: 0 every command fits · 1 one or more would be persisted ·
# 2 BROKEN, the text module could not be read, evaluated or composed.
#
# THE STAGED BLOB IS EVALUATED, NEVER RUN: lib/load-text-module.js gives it no
# `require`, so the same stack firing on `git merge`, `git revert` and
# `cherry-pick --continue`, where the staged bytes may be another session's,
# executes none of them with the session's credentials.

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# Absolute, as the measuring helper beside it is run after the `cd` below.
here="$(cd -- "$here" && pwd)" || {
  printf 'BROKEN: cannot resolve this script'"'"'s directory\n' >&2
  exit 2
}
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

# Advisory only, and never its own exit code: it rides on exit 0. Under this much
# headroom the NEXT rule of any size may not fit — the rule-size range it is
# derived from is on mantahostels#1915. inject-tracker-docs.test.ts reads this line.
TIGHT_HEADROOM_CHARS=1000

TEXT_MODULE="scripts/lib/tracker-inject-text.js"

# The fragments /code-review's rules read, staged like the module.
REVIEW_RULES=(review-dispatch-shape review-deviations-read review-finding-destination)

broken() {
  printf 'BROKEN: %s\n' "$1" >&2
  exit 2
}

# Every path below is repo-root-relative — `git show :<path>` always is, and the
# `--tree` branch's `cp` would otherwise disagree with it when run from a
# subdirectory.
root="$(gr_root)"
# gr_root always answers — it falls back to $PWD — so the repository check is
# made separately rather than read off its exit status (#1).
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 ||
  broken "not inside a git repository"
cd "$root" || broken "cannot enter $root"

tmp="$(mktemp -d)" || broken "cannot make a scratch directory"
# INT and TERM as well as EXIT: a Ctrl-C mid-run would otherwise leave the
# scratch directory behind.
trap 'rm -rf "$tmp"' EXIT INT TERM

# The index, not the working tree: git's pathspec-commit temporary index is
# honoured through GIT_INDEX_FILE, so this reads what the commit contains and
# never a half-saved copy. `--tree` is the by-hand form, for
# asking the question before staging anything.
#
# NO `HEAD:` FALLBACK (mantahostels#1915). The gate's grep names a STAGED DELETION too, where
# `git show :` fails and a fallback would quietly measure HEAD's copy of a file
# the commit removes, under a label asserting it came from the index. A deletion
# has no payload to measure, so it skips.
if [[ "${1:-}" = "--tree" ]]; then
  source_desc="the working tree"
  from_tree=1
  cp -- "$TEXT_MODULE" "$tmp/text.js" 2>"$tmp/err" ||
    broken "cannot read $TEXT_MODULE: $(cat "$tmp/err")"
else
  source_desc="the staged blob"
  from_tree=
  if ! git show ":$TEXT_MODULE" >"$tmp/text.js" 2>"$tmp/err"; then
    if grep -qxF -- "$TEXT_MODULE" <<<"$(git diff --cached --name-only --no-renames --diff-filter=D)"; then
      echo "$TEXT_MODULE is staged for deletion — nothing to measure, gate SKIPPED." >&2
      exit 0
    fi
    broken "cannot read $TEXT_MODULE from the index: $(cat "$tmp/err")"
  fi
fi

read_source() {
  if [[ -n "$from_tree" ]]; then cat -- "$1"; else git show ":$1"; fi
}
# The integer a `const <name> = <n>;` line at column zero of <file> assigns,
# the shape lib/hook-limits.js's limitIn() reads, numeric separators dropped.
lib_const() {
  read_source "$1" 2>/dev/null | sed -n "s/^const $2 = \([0-9][0-9_]*\);\$/\1/p" | tr -d _
}
LIMIT="$(lib_const scripts/lib/hook-limits.js HOOK_PERSIST_CHARS)"
[[ -n "$LIMIT" ]] || broken "no const HOOK_PERSIST_CHARS = <n>; line in scripts/lib/hook-limits.js"
CAP="$(lib_const scripts/lib/hook-limits.js RULE_CAP)"
[[ -n "$CAP" ]] || broken "no const RULE_CAP = <n>; line in scripts/lib/hook-limits.js"

# INCLUSIVE, AND THAT IS A CHOICE RATHER THAN A MEASUREMENT. mantahostels#1868 read the
# constant and not the comparison, so whether the harness persists at exactly
# the threshold or only above it is unmeasured. Refusing at the boundary costs
# at most one commit that would in fact have been delivered inline; the other way round
# costs a rule that silently stops arriving.
OVER_AT="$LIMIT"

# The rule fragments from the same source as the module. An absent one is
# composed as the hook composes it, from the module's own fallback.
mkdir -p "$tmp/rules" || broken "cannot make a scratch rules directory"
for id in "${REVIEW_RULES[@]}"; do
  rel="docs/agents/rules/$id.txt"
  read_source "$rel" >"$tmp/rules/$id.txt" 2>/dev/null || rm -f -- "$tmp/rules/$id.txt"
done

# Derived, never listed here: a command added to the module's COMMANDS is
# covered without anything being edited twice. What each figure holds, and the
# upper bound each input is set to, is lib/injector-margin.js's header.
node "$here/lib/injector-margin.js" "$tmp/text.js" "$tmp/rules" "$CAP" >"$tmp/sizes" 2>"$tmp/err" ||
  broken "$TEXT_MODULE could not be measured: $(cat "$tmp/err")"
[[ -s "$tmp/sizes" ]] || broken "$TEXT_MODULE names no command"

printf '%s payload per command, against the harness %s-character persistence threshold:\n' \
  "$source_desc" "$LIMIT"

status=0
while read -r cmd n; do
  case "$n" in
    '' | *[!0-9]*) broken "/$cmd emitted no measurable payload" ;;
  esac

  left=$((LIMIT - n))
  if [[ "$n" -ge "$OVER_AT" ]]; then
    note='  ← OVER: this payload is persisted to a file, not delivered inline'
    status=1
  elif [[ "$left" -lt "$TIGHT_HEADROOM_CHARS" ]]; then
    note='  ← tight: under one rule of headroom'
  else
    note=''
  fi
  printf '  /%-12s %5d chars, %5d left%s\n' "$cmd" "$n" "$left" "$note"
done <"$tmp/sizes"

if [[ "$status" -ne 0 ]]; then
  cat >&2 <<-'EOF'

		A payload at or over the threshold is written to a file and replaced inline by
		a ~2 KB preview plus a link, which a session follows about a tenth of the time.
		Shrink it — shorten a rule, or replace a paste with a pointer naming the file
		AND the section that answers, which is the shape mantahostels#1870 landed.
	EOF
fi

exit "$status"
