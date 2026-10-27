#!/usr/bin/env bash
#
# check-injector-margin.sh — what each command's injected payload actually
# measures, against the harness's 10,000-character persistence threshold (mantahostels#1915).
#
# Usage:
#   bash scripts/check-injector-margin.sh            # the STAGED injector
#   bash scripts/check-injector-margin.sh --tree     # the working tree's copy
#
# WHY THIS EXISTS SEPARATELY FROM check-context-budget.js. That checker's
# INJECTION_CAP_BYTES is a union of every payload string the injector can emit,
# larger than any real variant and comparable with none, and it PARSES the
# injector rather than running it — deliberately, since `--against` reads the
# script out of git and executing the working tree's copy would run whatever a
# neighbour had half-saved. So it cannot report the limit that binds, which is
# per command. mantahostels#1915 ruled option (A) — run the STAGED blob, which is neither the
# working tree nor a parse.
#
# CROSSING THE THRESHOLD IS SILENT. The harness persists a payload over 10,000
# characters to a file and hands the session a ~2 KB preview plus a link, which
# /implement opened 10.2% of the time (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md).
#
# NOT IN THE `check-*` FAMILY. That family gates through scripts/lib/check.js's
# `runCheck` and its five-outcome alphabet; this is shell, so it cannot reach
# either. Shell because the subject IS a shell script and running it is the whole
# method — a Node wrapper would buy `--json` and `--notify` at the price of a
# spawn per command and a second language between the reader and what is being
# measured.
#
# EXIT ALPHABET: 0 every command fits · 1 one or more would be persisted ·
# 2 BROKEN, the script could not be read, parsed or run.
#
# THIS HOOK NOW EXECUTES SHELL OUT OF THE INDEX (mantahostels#1915). The residual is that the
# same stack fires on `git merge`, `git revert` and `cherry-pick --continue`, where
# the staged bytes may be another session's; TMPDIR is redirected but contains
# nothing, so the blob runs with the session's own credentials. The injector
# sources no file and reads no sibling, which is what keeps that bounded.

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

# Advisory only, and never its own exit code: it rides on exit 0. Under this much
# headroom the NEXT rule of any size may not fit — the rule-size range it is
# derived from is on mantahostels#1915. inject-tracker-docs.test.ts reads this line.
TIGHT_HEADROOM_CHARS=1000

INJECTOR="scripts/inject-tracker-docs.sh"

broken() {
  printf 'BROKEN: %s\n' "$1" >&2
  exit 2
}

# SKIP loudly rather than refuse, as .husky/pre-commit's other binary-dependent
# gates do: jq is apparatus, and the injector itself fails open without it
# (inject-tracker-docs.sh's `command -v jq` line), so a hard dependency here
# would refuse the commit while naming a command as the offender.
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not on PATH — injector-margin gate SKIPPED, this commit is NOT blocked." >&2
  exit 0
fi

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
# never a parallel session's half-saved copy. `--tree` is the by-hand form, for
# asking the question before staging anything.
#
# NO `HEAD:` FALLBACK (mantahostels#1915). The gate's grep names a STAGED DELETION too, where
# `git show :` fails and a fallback would quietly measure HEAD's copy of a file
# the commit removes, under a label asserting it came from the index. A deletion
# has no payload to measure, so it skips.
if [ "${1:-}" = "--tree" ]; then
  source_desc="the working tree"
  from_tree=1
  cp -- "$INJECTOR" "$tmp/inj.sh" 2>"$tmp/err" ||
    broken "cannot read $INJECTOR: $(cat "$tmp/err")"
else
  source_desc="the staged blob"
  from_tree=
  if ! git show ":$INJECTOR" >"$tmp/inj.sh" 2>"$tmp/err"; then
    if git diff --cached --name-only --no-renames --diff-filter=D | grep -qx "$INJECTOR"; then
      echo "$INJECTOR is staged for deletion — nothing to measure, gate SKIPPED." >&2
      exit 0
    fi
    broken "cannot read $INJECTOR from the index: $(cat "$tmp/err")"
  fi
fi

read_source() {
  if [ -n "$from_tree" ]; then cat -- "$1"; else git show ":$1"; fi
}
# The integer a `<name>=<n>` line at column zero of <file> assigns.
lib_const() {
  read_source "$1" 2>/dev/null | sed -n "s/^$2=\([0-9]*\)\$/\1/p"
}
LIMIT="$(lib_const scripts/lib/hook-limits.sh HOOK_PERSIST_CHARS)"
[ -n "$LIMIT" ] || broken "no HOOK_PERSIST_CHARS=<n> line in scripts/lib/hook-limits.sh"

# INCLUSIVE, AND THAT IS A CHOICE RATHER THAN A MEASUREMENT. mantahostels#1868 read the
# constant and not the comparison, so whether the harness persists at exactly
# the threshold or only above it is unmeasured. Refusing at the boundary costs
# at most one commit that would in fact have been delivered inline; the other way round
# costs a rule that silently stops arriving.
OVER_AT="$LIMIT"

# Derived, never listed here: a command added to the injector is covered without
# anything being edited twice.
#
# THE SHAPE IT DEPENDS ON is a single-line, unquoted `COMMANDS=(a b c)` at column
# zero. A multi-line array, a trailing comment or quoted elements all break it —
# the first two into BROKEN, the third into a payload the injector cannot match.
# The suite asserts the live array's shape.
commands="$(sed -n 's/^COMMANDS=(\(.*\))$/\1/p' "$tmp/inj.sh")"
[ -n "$commands" ] || broken "no single-line COMMANDS=(...) array in $INJECTOR"

# The split below is deliberate — it is how the array's elements are separated —
# so the two things that make an unquoted expansion dangerous are pinned rather
# than inherited: globbing off, and a known IFS.
set -f
IFS=' '

# `length` counts codepoints; the harness slices with String.prototype.length,
# which counts UTF-16 units. They agree on everything in the payload today —
# `§`, `—`, `→`, `❓` are all BMP — and would not on an astral character.
UTF16_LEN='.hookSpecificOutput.additionalContext
	| explode | map(if . > 65535 then 2 else 1 end) | add // 0'

printf '%s payload per command, against the harness %s-character persistence threshold:\n' \
  "$source_desc" "$LIMIT"

status=0
# A real hook payload always carries a session_id, which is what triggers
# mantahostels#2220's 8-char Artefact-path suffix (scripts/lib/review-suffix.sh) — the
# WITH-session case is the longer, binding one, not the bare fallback. The
# probe below fixes a stub id so that case is measured deterministically
# regardless of the caller's own CLAUDE_CODE_SESSION_ID, which env -u still
# strips (mantahostels#2240).
# scripts/lib/rendered-injection.js runs the same probe; keep the two in step.
PROBE_SESSION_ID="check-injector-margin-probe-00000000"

# A stub `gh` answering every issue with the longest command name as its
# `takes:` value, an upper bound on the #1164 line, so that line is measured
# where it fires and no commit waits on the network. The command named itself
# is measured without the line.
longest=""
for c in $commands; do [ "${#c}" -gt "${#longest}" ] && longest="$c"; done
# shellcheck disable=SC2015 # broken is right whether printf or chmod fails.
printf '#!/bin/sh\necho takes:%s\n' "$longest" >"$tmp/gh" && chmod +x "$tmp/gh" ||
  broken "cannot write the stub gh"

# What /code-review adds at run time from files this probe has no copy of
# (#1697): the dispatch fragment, measured here as its short fallback, and the
# review-tier envelope. Its rules are capped at RULE_CAP and its areas
# prelude is not, so a host declaring many areas can still cross the threshold;
# the injector then puts the tier first, inside the preview. The `+ 2` is the
# blank line joining the tier to the rest.
review_reserve() {
  local cap shape len
  cap="$(lib_const scripts/lib/hook-limits.sh RULE_CAP)"
  [ -n "$cap" ] || broken "no RULE_CAP=<n> line in scripts/lib/hook-limits.sh"
  shape="$(read_source docs/agents/rules/review-dispatch-shape.txt 2>/dev/null)" ||
    broken "cannot read docs/agents/rules/review-dispatch-shape.txt"
  len="$(printf '%s' "$shape" | jq -Rs 'length')" || broken "jq could not measure review-dispatch-shape.txt"
  case "$len" in '' | *[!0-9]*) broken "review-dispatch-shape.txt measured as '$len'" ;; esac
  reserve=$((cap + 2 + len))
}
reserve=0
case " $commands " in *" code-review "*) review_reserve ;; esac

for cmd in $commands; do
  # TMPDIR is redirected regardless, to keep the sweep out of a real scratch
  # directory; the dedupe marker this session id mints lands there too.
  n="$(printf '{"prompt":"/%s 1","hook_event_name":"UserPromptSubmit","session_id":"%s"}' "$cmd" "$PROBE_SESSION_ID" |
    TMPDIR="$tmp" WFC_GH="$tmp/gh" env -u CLAUDE_CODE_SESSION_ID bash "$tmp/inj.sh" | jq -r "$UTF16_LEN")"
  case "$n" in
    '' | *[!0-9]*) broken "/$cmd emitted no measurable payload" ;;
  esac
  [ "$cmd" != code-review ] || n=$((n + reserve))

  left=$((LIMIT - n))
  if [ "$n" -ge "$OVER_AT" ]; then
    note='  ← OVER: this payload is persisted to a file, not delivered inline'
    status=1
  elif [ "$left" -lt "$TIGHT_HEADROOM_CHARS" ]; then
    note='  ← tight: under one rule of headroom'
  else
    note=''
  fi
  printf '  /%-12s %5d chars, %5d left%s\n' "$cmd" "$n" "$left" "$note"
done

if [ "$status" -ne 0 ]; then
  cat >&2 <<-'EOF'

		A payload at or over the threshold is written to a file and replaced inline by
		a ~2 KB preview plus a link, which a session follows about a tenth of the time.
		Shrink it — shorten a rule, or replace a paste with a pointer naming the file
		AND the section that answers, which is the shape mantahostels#1870 landed.
	EOF
fi

exit "$status"
