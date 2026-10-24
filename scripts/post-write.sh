#!/usr/bin/env bash
# PostToolUse: the three things that must happen after a tool write, IN ORDER.
#
#   1. Format the file: Biome for JS and TS, shfmt and `ruff format` for shell
#      and Python (format-on-write.js, #1332).
#   2. Record the write — the ledger entry (mantahostels#114) and the content identity the
#      clobber detector compares against (mantahostels#295).
#   3. Scan it for a host-root or bare-citation fault (scan-on-write.js, #1151).
#
# Then it says what step 1 did, in one PostToolUse envelope with the scan's
# fault (#2019): that it reformatted the file, or that a JS, TS or JSON write
# went unformatted for want of Biome (a worktree), with `rule:write-reformatted`;
# and on a shell file `rule:shell-lint-blind`. Each fragment is printed once a
# session; the notice on every such write, as each reformat strands an
# `old_string` quoting the tool's bytes.
#
# It is a recorder, a formatter and an advisory scan, never a guard: every
# failure path exits 0.
#
# IMPLICIT:  after every Write/Edit/NotebookEdit, rewrites the file with Biome, shfmt or `ruff format` and then records its bytes as the session's write-ledger entry and clobber baseline; a reformat, a shell file's lint blind spot and a host-root or bare-citation fault in it are handed to the session as context.
# JUSTIFIED: fail-safe — the record is the clobber detector's only baseline; the formatter half is convenience, and rides here because it must run BEFORE the record, a separate registration having raced it and stored pre-format bytes (mantahostels#295).
# DEFEAT:    none — the formatters' own ignore rules (ruff's `ruffExclude` among them) and a file outside the repo root (#96) are the only exclusions, and every failure path exits 0.

set -uo pipefail

done_() { exit 0; }

payload="$(cat)"
[[ -n "$payload" ]] || done_
command -v jq >/dev/null 2>&1 || done_

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
root="$(gr_root)"

# file_path only, never notebook_path: Biome has nothing to say about a notebook.
file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""' 2>/dev/null)" || file=""

# The binary by path, not `npx`. In a worktree there is no node_modules, and npx
# then FETCHES an unrelated package called biome — v0.3.3, which prints nothing
# and exits 0, so the file silently goes unformatted.
#
# Only a file inside the root: one in another repo belongs to that repo's
# formatter or none (#96). The path is resolved as gr_root resolves the root —
# its directory physically, a symlinked leaf to its target, since Biome writes
# through the link — and a relative path against the root. Anything
# unresolvable fails closed.
in_root() {
  local dir
  dir="$(
    exec 2>/dev/null
    CDPATH='' cd -P -- "$root" || exit 1
    f="$1"
    if [[ -L "$f" ]]; then f="$(readlink -f -- "$f")" || exit 1; fi
    CDPATH='' cd -P -- "$(dirname -- "$f")" && printf '%s' "$PWD"
  )" || return 1
  [[ "$dir/" == "${root%/}/"* ]]
}

inside=0
[[ -n "$file" ]] && in_root "$file" && inside=1
before=""
((inside)) && before="$(cksum <"$file" 2>/dev/null)"

if ((inside)) && [[ -f "$root/node_modules/.bin/biome" ]]; then
  (cd "$root" && ./node_modules/.bin/biome format --write -- "$file") >/dev/null 2>&1
fi
# Shell and Python, which Biome does not read (#1332). It prints `shell` on a
# shell file, as lib/formatters.js picks them.
kind=""
if ((inside)) && command -v node >/dev/null 2>&1; then
  kind="$(cd "$root" && node "$here/format-on-write.js" "$file" 2>/dev/null)"
fi

# Step 2 gets the payload on stdin — it re-reads session_id and the notebook path
# for itself.
printf '%s' "$payload" | "$here/record-write.sh" >/dev/null 2>&1

# Step 3, after the record so a slow scan can never cost it.
scan=""
if ((inside)) && command -v node >/dev/null 2>&1; then
  scan="$(cd "$root" && node "$here/scan-on-write.js" "$file" 2>/dev/null)"
fi

# What is said goes out as ONE envelope: the harness parses stdout as a single
# JSON object, so the scan's own is unwrapped into it.
declare -F gp_context >/dev/null 2>&1 || {
  [[ -z "$scan" ]] || printf '%s\n' "$scan"
  done_
}
gp_adopt_payload "$payload"

# A fragment the store cannot answer for is left out and left unlatched, so a
# later trigger still tells it.
notice="" rule_wr="" rule_sh=""
if [[ -n "$before" && "$(cksum <"$file" 2>/dev/null)" != "$before" ]]; then
  notice="post-write.sh reformatted ${file#"$root"/}: re-read it before your next Edit to it."
elif ((inside)) && [[ ! -f "$root/node_modules/.bin/biome" && "$file" =~ \.(c|m)?[jt]sx?$|\.jsonc?$ ]]; then
  # A worktree.
  notice="post-write.sh ran no Biome on ${file#"$root"/}: this checkout has no node_modules, so the file stays as you wrote it."
fi
if [[ -n "$notice" ]]; then
  if ! gp_rule_told write-reformatted; then
    rule_wr="$(gp_rule_text write-reformatted '')"
    [[ -n "$rule_wr" ]] || gl_log "rule fragment unreadable — rule:write-reformatted went unsaid"
  fi
fi
# Its first line only: what follows is the formatter's to say.
if [[ "${kind%%$'\n'*}" == shell ]]; then
  if ! gp_rule_told shell-lint-blind; then
    rule_sh="$(gp_rule_text shell-lint-blind '')"
    [[ -n "$rule_sh" ]] || gl_log "rule fragment unreadable — rule:shell-lint-blind went unsaid"
  fi
fi
fault=""
[[ -z "$scan" ]] ||
  fault="$(printf '%s' "$scan" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)"

msg=""
for part in "$notice" "$rule_wr" "$rule_sh" "$fault"; do
  [[ -n "$part" ]] && msg+="${msg:+$'\n\n'}$part"
done
[[ -n "$msg" ]] || done_
gp_context "$msg" PostToolUse || {
  gl_log "additionalContext did not render — the post-write notice went unsaid"
  done_
}
if [[ -n "$rule_wr" ]]; then
  gp_rule_mark_told write-reformatted
fi
if [[ -n "$rule_sh" ]]; then
  gp_rule_mark_told shell-lint-blind
fi

done_
