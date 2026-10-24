#!/usr/bin/env bash
# The echo-chain store, shared by scripts/guard-echo-call.sh (which reads it and
# refuses) and scripts/record-tool-echo.sh (which writes it) — mantahostels#2570.
#
# SOURCED, NEVER RUN. It defines functions and reaches no verdict of its own.
# Source lib/guard-parse.sh first: every reader here goes through gp_payload_field,
# and ec_state_file through its gp_agent_key.
#
# WHAT A CHAIN IS. One record per (tool, tool_input) signature — and, for a
# Read, the file's on-disk state (ec_sig):
#
#   <signature>\t<response hash>\t<run length>\t<unix seconds>
#
# `run` is how many times IN A ROW that signature has returned that response
# hash. A differing response resets it to 1, except a Read's `file_unchanged`
# short circuit, which extends it (record-tool-echo.sh). The guard refuses at
# run >= 2 — i.e. the third call of a command that answered identically twice.
#
# NO FIELD IS EVER EMPTY, and `EC_CLEARED` is why. Tab is IFS whitespace, so
# bash's `read` collapses two adjacent tabs into one delimiter and every field
# after an empty one shifts left — a cleared chain written as an empty hash
# would read back as a valid record with the run count in the hash column.
#
# WHY THE RESPONSE AND NOT THE INPUT ALONE. Refusing on a repeated INPUT
# refuses the legitimate repeats — a timed `sleep`/check beat, a re-read after
# an edit, `free -m` — because they have exactly that shape. Requiring two
# identical RESPONSES first removes most of those wrong refusals. Requiring
# three is more accurate still but gives up far more true refusals than the
# wrong ones it avoids, which is the worse trade.
#
# NO PROXIMITY REQUIREMENT. A 5-turn window scores the same accuracy on fewer
# refusals — it discards true ones without buying accuracy, because the
# discriminator is response identity and not how recently the call ran. The age
# bound below is state hygiene, not part of the rule.
#
# The measured rows, and the population they were measured over, are on
# mantahostels#2616. `node scripts/measure-echo-chain.js` re-derives them and
# states its own six departures from the deployed guard.

# shellcheck source=scripts/lib/atomic-write.sh
source "$(dirname "${BASH_SOURCE[0]}")/atomic-write.sh" 2>/dev/null

EC_MAX_AGE=3600 # seconds — a record older than this is dropped, not judged
EC_MAX_LINES=200
# The hash column of a chain the guard has just refused on and reset, carried
# forward by a Read short circuit folded in after it. No real hash can collide
# with it: sha1sum's output is hex.
# shellcheck disable=SC2034  # read by guard-echo-call.sh, which sources this
EC_CLEARED="-"

# The raw hook payload, lib/guard-parse.sh's variable, assigned by gp_begin.
# Declared empty here so this file reads as self-contained to shellcheck, which
# cannot follow a `source` it never sees; gp_begin overwrites it before either
# reader below runs.
: "${_gp_payload:=}"

# ec_dir — where the per-agent chains live. Scratch, outside the repo, on the
# same footing as guard-agent-poll.sh's window state.
ec_dir() { printf '%s/wfc-echo-chain' "${TMPDIR:-/tmp}"; }

# ec_state_file — the chain file for the payload's (session, agent) pair, as
# `<session>.<agent>`.
#
# PER AGENT, NOT PER SESSION (#1004). A subagent's payload carries its parent's
# session_id, so a session key would pool every agent's calls. The agent half is
# gp_agent_key's — `main` for the parent, `a<agent_id>` for a subagent — so
# the guard and the recorder, both calling this, cannot derive different keys.
# Both halves come back sanitised to [A-Za-z0-9_-], so the dot joining them
# cannot collide two pairs into one file.
ec_state_file() {
  local key
  key="$(gp_agent_key)" || return 1
  printf '%s/%s.%s' "$(ec_dir)" "${key#* }" "${key%% *}"
}

# ec_skip <tool> <command> — true where this call belongs to a NEIGHBOURING
# guard rather than to this one.
#
# guard-agent-poll.sh owns two shapes on cadence: a command opening `sleep <n>`
# (the timed artefact check and the timed job beat, both prescribed by CLAUDE.md
# §Subagent dispatch) and a command that is nothing but a no-op. Both are
# byte-identical on every beat by construction, so judging them on repetition
# would refuse the practice the repo asks for, on the third beat, at a cadence
# the poll guard deliberately allows.
ec_skip() {
  [[ "$1" == "Bash" ]] || return 1
  [[ "$2" =~ ^[[:space:]]*sleep[[:space:]]+[0-9] ]] && return 0
  [[ "$2" =~ ^[[:space:]]*(true|:|exit([[:space:]]+0)?)[[:space:]]*\;?[[:space:]]*(\#.*)?$ ]] && return 0
  return 1
}

# ec_sig — the signature of the call in the payload, or empty if it cannot be
# built. Sorted keys (-S) so two payloads differing only in field order hash
# alike, and the tool name is joined with a unit separator so a Bash command
# cannot be crafted to collide with a Read of the same bytes.
#
# A READ ALSO SIGNS THE FILE ON DISK — inode, size and nanosecond mtime and
# ctime, through any symlink (#1058). A file rewritten since its last reads is
# then a new signature with no chain, so its re-read is not refused, whatever
# route rewrote it: a Bash-route write, a generator, a neighbouring session.
# ctime is there for the rewrite that restores mtime (`cp -p`, `rsync -a`).
# A missing file signs on the input alone; so, logged, does an existing one
# `stat` cannot read — every Read, where `stat` lacks GNU's `-c`. RESIDUALS: a
# same-size rewrite in place within the filesystem's timestamp granularity keeps
# its chain; a `touch`, a `chmod` or an identical-bytes rewrite breaks one the
# input alone would have kept.
ec_sig() {
  local tool input
  tool="$(gp_payload_field '.tool_name')" || return 1
  input="$(printf '%s' "$_gp_payload" | jq -jcS '.tool_input // {}' 2>/dev/null)" || return 1
  [[ -n "$tool" && -n "$input" ]] || return 1
  if [[ "$tool" == "Read" ]]; then
    local file_path file_state
    file_path="$(gp_payload_field '.tool_input.file_path')"
    if [[ -e "$file_path" ]]; then
      if file_state="$(stat -L -c '%i:%s:%.9Y:%.9Z' -- "$file_path" 2>/dev/null)"; then
        input+=$'\x1f'"$file_state"
      else
        gl_log "could not stat a Read's file — signed on its input alone"
      fi
    fi
  fi
  printf '%s\x1f%s' "$tool" "$input" | sha1sum 2>/dev/null | cut -c1-24
}

# ec_response_hash — the hash of what the tool ANSWERED, or nothing (non-zero)
# where the payload carried no response at all.
#
# A MISSING RESPONSE IS NOT AN EMPTY ONE. Hashing an absent field would give
# every such call the same hash, and two of them in a row would arm a refusal on
# no evidence — so this returns 2 and the caller leaves the chain alone. A FAULT
# — jq or sha1sum broken — returns 1, and its caller records that instead of
# treating it as an absent response.
#
# The projection ends in `tojson`, which is what keeps an EMPTY response
# distinct from an absent one: raw output of the JSON string "" is zero bytes,
# so without it a command that printed nothing read as a payload with no
# response at all.
#
# Volatile keys are dropped first. A duration or a timestamp in the response
# would differ on every call, every chain would reset at length 1, and the guard
# would never fire at all.
# Dropping by name pattern is cruder than naming the fields, and deliberately:
# the payload shape is the harness's, not this repo's, and a field added
# upstream would otherwise disarm this quietly.
ec_response_hash() {
  local projected
  projected="$(printf '%s' "$_gp_payload" | jq -jcS '
    if has("tool_response") and .tool_response != null
    then (.tool_response as $r
      | if ($r | type) == "object"
        then ($r | with_entries(select(.key
          | test("duration|elapsed|timestamp|startTime|endTime|_ms$|Millis"; "i")
          | not)))
        else $r end)
    else empty end
    | tojson
  ' 2>/dev/null)" || return 1
  [[ -n "$projected" ]] || return 2
  printf '%s' "$projected" | sha1sum 2>/dev/null | cut -c1-24
}

# ec_lookup <state file> <sig> — print "<hash>\t<run>\t<denies>" for that
# signature, or nothing. A record past EC_MAX_AGE reads as absent.
ec_lookup() {
  local file="$1" sig="$2" now s h r t d
  [[ -f "$file" ]] || return 0
  now="$(date +%s 2>/dev/null)"
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  while IFS=$'\t' read -r s h r t d; do
    [[ "$s" == "$sig" ]] || continue
    [[ "$t" =~ ^[0-9]+$ && "$r" =~ ^[0-9]+$ && "$d" =~ ^[0-9]+$ ]] || continue
    ((now - t < EC_MAX_AGE)) || continue
    printf '%s\t%s\t%s' "$h" "$r" "$d"
    return 0
  done <"$file"
  return 0
}

# ec_store <state file> <sig> <hash> <run> <denies> — replace that signature's
# record, dropping expired ones and anything past EC_MAX_LINES.
#
# TWO SEPARATE HAZARDS, two mechanisms. aw_write stops a
# concurrent READER seeing a half-written chain. They do nothing about a lost
# UPDATE — one session's tool calls can overlap, and two rebuilds racing leave
# only the later one's record — so the whole read-rebuild-write is taken under
# `flock`. Where flock is missing the write goes ahead unserialised: losing a
# record undercounts a chain, which delays a refusal and never causes one.
ec_store() {
  local file="$1" sig="$2" hash="$3" run="$4" denies="$5" now kept=() s h r t d
  now="$(date +%s 2>/dev/null)"
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 1
  if command -v flock >/dev/null 2>&1; then
    # A descriptor of its own on a lock file beside the chain: locking the chain
    # itself would be locking a file `mv` is about to replace, and the next
    # caller would hold a lock on an inode nobody reads.
    exec {_ec_lock}>>"$file.lock" 2>/dev/null &&
      flock -w 2 "$_ec_lock" 2>/dev/null
  fi
  if [[ -f "$file" ]]; then
    while IFS=$'\t' read -r s h r t d; do
      [[ "$s" == "$sig" ]] && continue
      [[ "$t" =~ ^[0-9]+$ && "$d" =~ ^[0-9]+$ ]] || continue
      ((now - t < EC_MAX_AGE)) || continue
      kept+=("$s"$'\t'"$h"$'\t'"$r"$'\t'"$t"$'\t'"$d")
    done <"$file"
  fi
  kept+=("$sig"$'\t'"$hash"$'\t'"$run"$'\t'"$now"$'\t'"$denies")
  ((${#kept[@]} <= EC_MAX_LINES)) ||
    kept=("${kept[@]: -EC_MAX_LINES}")
  local rc=0
  aw_write "$file" printf '%s\n' "${kept[@]}" 2>/dev/null || rc=1
  # The lock is released by closing the descriptor, not by the function
  # returning: it was opened on the shell, and both callers go on to exit.
  [[ -n "${_ec_lock:-}" ]] && exec {_ec_lock}>&- 2>/dev/null
  return "$rc"
}

# ec_sweep — one file per agent would otherwise accumulate for the life of the
# host. Bounded work: only ever this store's own directory.
ec_sweep() {
  find "$(ec_dir)" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null
  return 0
}
