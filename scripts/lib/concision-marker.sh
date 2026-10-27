#!/usr/bin/env bash
# concision-marker.sh — the one definition of a session's start point and of a
# valid pass marker (workflow-core#1005).
#
# Callers: scripts/concision-backstop.sh at Stop, which reads the
# `.concision-pass-<sid>` marker and, through lib/code-signal.sh's
# review_uncovered, the `.codereview-pass-<sid>` one, as
# scripts/push-review-owed.sh does before a push; at pre-commit,
# scripts/review-hold-gate.sh, which reads the second's tier=, areas=, tree=
# and paths=. A second copy of either rule would let one caller accept a
# marker another then nags about; the start point alone has one Node twin,
# lib/review-tier-host.js's sessionBase at code-review's load, and a change to
# either changes both; review-tier.test.ts's "in both twins" cases hold the two
# to one answer (workflow-core#2971). join_comma is here because every reader of a
# marker's areas= or paths= sources this file.
#
# SOURCED, NEVER RUN. bash: `[[ =~ ]]`, `local` and `mapfile`.

# shellcheck disable=SC2034  # pass_fault and pass_base are the callers' to read, not this file's

# Where concision-backstop.sh's `start` mode records the session's start point.
concision_base_file() { printf '%s' "$1/.concision-base-$2"; }

# The session's start point, printed. Returns 1, printing nothing, where none
# was recorded, and 2 where git cannot place the recorded one against HEAD.
#
# Existence is not validity (mantahostels#114). A parallel session's rebase leaves the
# recorded commit reachable as an object but no longer an ancestor of HEAD, so a
# diff against it measures against content rewritten off the branch. Fall back
# to the merge base rather than failing: failing would leave both callers
# silently disabled for the rest of any session that saw a rebase.
concision_session_base() {
  local base_file base
  base_file="$(concision_base_file "$1" "$2")"
  [ -f "$base_file" ] || return 1
  base=$(cat "$base_file" 2>/dev/null)
  [ -n "$base" ] || return 1
  if ! git merge-base --is-ancestor "$base" HEAD 2>/dev/null; then
    base=$(git merge-base "$base" HEAD 2>/dev/null) || return 2
    [ -n "$base" ] || return 2
  fi
  printf '%s' "$base"
}

# --- pass markers (mantahostels#139) ---
# A marker is a claim that a pass ran, and an empty one — the old form — asserted
# only that something created it. It carries the fixed point the pass used and
# what it found:
#
#   base=<sha>
#   findings=<n>
#   route=in-session                    (.concision-pass-<sid> only, mantahostels#1099)
#   tier= areas= tree= paths=           (.codereview-pass-<sid> on a sensitive
#                                       change: tier= and areas= read only
#                                       by marker_tier_fault; tree= and
#                                       paths= by review-hold-gate.sh and
#                                       by code-signal.sh's review_uncovered)
#
# Unreadable, malformed, or missing either of the first two keys means no pass:
# re-running a pass is the cheaper error. `route=` is NOT validated here — it is
# instrumentation for mantahostels#1099's findings-per-route comparison, and a pass that ran
# is not worth re-running because it recorded its route badly. `subagent` and
# `mixed` are historical spellings, written only while mantahostels#1097's routing stood
# (mantahostels#1143 ended it).
#
# A rejected marker that EXISTS is reported as such, in $pass_fault — mantahostels#402, the
# ticket for a nag that said no pass had run when one had.
pass_fault=""

# Truncated: a bad findings= may be a paragraph.
short_quote() { printf "'%.40s'" "$1"; }

# The value of the first `<key>=` line in a marker, verbatim, or nothing.
marker_field() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }

# marker_has <marker> <key> — 0 where the marker carries a `<key>=` line, empty
# or not, else 1.
marker_has() { grep -q "^$2=" "$1" 2>/dev/null; }

# The most paths a refusal or a nag names before it stops listing, so the
# sentence stays readable. A FIRST GUESS, never measured.
NAMED_PATHS_MAX=10

# marker_list <marker> <key> — the comma-separated values of its <key>= line,
# one a line, trimmed; nothing where it has no such line. Residual: a value
# holding a comma, an area name or a path, can never be named there.
marker_list() {
  local v
  local -a named=()
  IFS=, read -ra named <<<"$(marker_field "$1" "$2")"
  for v in "${named[@]}"; do
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    [ -z "$v" ] || printf '%s\n' "$v"
  done
}

# marker_unlisted <marker> <key> — stdin's lines that its <key>= does not
# name, all of them where it names none. 0 where it printed any, 1 where its
# <key>= names every one, 2 on a fault.
marker_unlisted() {
  grep -vFx -f <(marker_list "$1" "$2")
  case $? in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

# pass_valid <marker> <session base> — 0 where the marker vouches for a pass
# covering everything since the base, 2 where it is well-formed but its base=
# descends from the session base, else 1, with $pass_fault set on either
# failure (left empty where the marker does not exist) and $pass_base set to
# the base= read on 2.
pass_valid() {
  local marker="$1" base="$2" recorded findings written
  pass_fault=""
  pass_base=""
  [ -f "$marker" ] || return 1
  recorded=$(marker_field "$marker" base | tr -d '[:space:]')
  # Two forms: the stripped one is compared, the written one is quoted back.
  written=$(marker_field "$marker" findings)
  findings=$(printf '%s' "$written" | tr -d '[:space:]')
  # A full 40-hex sha, not any rev git would resolve. The skills write whatever
  # fixed point they were given, and `base=main` is a legal thing to be given —
  # it would resolve here to wherever main sits now, vouching for a pass that
  # never covered this range.
  if ! [[ "$recorded" =~ ^[0-9a-f]{40}$ ]]; then
    if [ -n "$recorded" ]; then
      pass_fault="its base= is not a 40-hex sha, $(short_quote "$recorded")"
    else
      pass_fault="it has no readable base= line"
    fi
    return 1
  fi
  case "$findings" in '' | *[!0-9]*)
    if [ -n "$findings" ]; then
      pass_fault="its findings= is not a number, $(short_quote "$written") — the count of findings, digits only"
    else
      pass_fault="it has no readable findings= line"
    fi
    return 1
    ;;
  esac
  if ! git rev-parse --verify --quiet "$recorded^{commit}" >/dev/null 2>&1; then
    pass_fault="its base= names a commit this repo does not have"
    return 1
  fi
  [ "$recorded" = "$base" ] && return 0
  # An OLDER fixed point covers a superset of what this session changed, so it
  # still vouches for it. A NEWER one reviewed less than the session wrote —
  # the miss this check exists to catch. A rebase moves the base out from under
  # a marker written before it and so re-nags, which is the safe direction.
  git merge-base --is-ancestor "$recorded" "$base" 2>/dev/null && return 0
  if git merge-base --is-ancestor "$base" "$recorded" 2>/dev/null; then
    pass_fault="its base= is ahead of this session's start point, so it covered less than the session changed"
    pass_base="$recorded"
    return 2
  fi
  pass_fault="its base= is not on this session's line of history, so it covered a range the session never changed"
  return 1
}

# marker_tier_fault <marker> <area>... — prints why the marker does not record
# an escalated review naming every <area>, or nothing where it does. Returns 2,
# printing nothing, where its areas= cannot be read against them: the caller's
# own fault, to fail open on as it does on the rest.
marker_tier_fault() {
  local marker="$1" tier unnamed
  shift
  local -a missing=()
  tier=$(marker_field "$marker" tier | tr -d '[:space:]')
  case "$tier" in
    escalated | mission-critical) ;;
    '')
      printf 'it has no tier= line'
      return 0
      ;;
    *)
      printf 'its tier= is %s, and only escalated or mission-critical covers a declared sensitive path' "$(short_quote "$tier")"
      return 0
      ;;
  esac
  [ "$#" -gt 0 ] || return 0
  unnamed="$(printf '%s\n' "$@" | marker_unlisted "$marker" areas)"
  [ $? -ne 2 ] || return 2
  [ -n "$unnamed" ] || return 0
  mapfile -t missing <<<"$unnamed"
  printf 'its areas= does not name %s' "$(join_comma "${missing[@]}")"
}

# join_comma <word>... — the words joined by ", ".
join_comma() {
  local IFS=,
  local joined="$*"
  printf '%s' "${joined//,/, }"
}
