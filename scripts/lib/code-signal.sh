#!/usr/bin/env bash
# code-signal.sh — the one definition of "this session changed enough code to
# owe a review" (#1163).
#
# Two callers: scripts/concision-backstop.sh at Stop, over the working tree,
# and scripts/push-review-owed.sh before a push, over HEAD, both through
# review_uncovered. A second copy of the paths, the floor, the attribution or
# the tier check would let the push stay silent on a change the Stop nag then
# bills, or the reverse. written_paths and its attribution have one Node twin,
# lib/review-tier.js with lib/review-tier-host.js at code-review's load; a
# change to either changes both, and review-tier.test.ts's "in both twins"
# cases hold the two to one answer (#2971).
#
# SOURCED, NEVER RUN, after scripts/lib/concision-marker.sh. bash: `local -a`,
# `local -n`, `mapfile`.

# Changed lines of code below which no review is demanded. A FIRST GUESS, never
# measured: it is set where a diff stops being readable at a glance (mantahostels#1071).
CODE_THRESHOLD=20
# A threshold any changed code file exceeds. NEGATIVE, not zero: the test below
# is `-gt`, and a changed file can report zero churn — a mode-only chmod, or a
# new empty file — which mantahostels#2769 asked to nag as much as any other.
ANY_CHANGE=-1
# /implement's closing steps make the two-axis review mandatory with no
# size floor, so for those sessions the churn heuristic is the wrong question
# (mantahostels#2769).
IMPLEMENT_THRESHOLD=$ANY_CHANGE
# concision-backstop.sh's PROSE is this list's complement by construction, so
# anything added here is excluded there or the same change is counted twice, on
# two different signals (mantahostels#2779).
CODE=(
  '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.jsx' '*.py' '*.sh'
  # The Husky hooks carry no extension (mantahostels#2779). A directory pathspec, not the
  # hook names, so an eighth hook is covered on the day it is added. `.husky/_` —
  # husky's own runtime stubs — is untracked and reaches neither limb: husky 9
  # writes `.husky/_/.gitignore` holding `*`, so `--exclude-standard` drops the
  # lot. RESIDUAL: a husky that stops writing that file puts ~14 stubs into the
  # churn of any session that wrote one hook.
  '.husky/'
)
# The one matcher of declared sensitive paths (#1617). Absolute, because both
# callers cd after sourcing this.
_cs_dir="${BASH_SOURCE[0]%/*}"
[[ "$_cs_dir" == "${BASH_SOURCE[0]}" ]] && _cs_dir=.
_cs_dir="$(cd "$_cs_dir" 2>/dev/null && pwd)"
CS_MATCHER="$_cs_dir/sensitive-paths.js"
CS_ARBITER="${_cs_dir%/*}/session-arbiter.js"
unset _cs_dir

# Did /implement run in this session? inject-tracker-docs.sh reserves one marker
# per session per command before it emits, under a uid-suffixed scratch
# directory. THE PATH IS SPELLED TWICE — here and at inject-tracker-docs.sh's
# state_dir and marker — and nothing but concision-backstop.test.ts's "reads the
# marker inject-tracker-docs.sh actually writes", which runs the injector for
# real, holds the two in step. A drift returns every /implement session to the
# CODE_THRESHOLD floor, silently.
#
# UNDER-DETECTION IS THE SAFE DIRECTION, and there are three: a SessionStart
# whose source is compact, clear or resume writes no marker at all; the sweep
# deletes one over 24 hours old; and the whole code signal is gated on this
# session's WRITE LEDGER, which the post-write core (scripts/lib/post-write.js)
# fills from the Write/Edit tools only — so a session editing through Bash was
# billed nothing to begin with, and no threshold was consulted (mantahostels#114, deliberate).
#
# THAT THIRD ONE IS NARROWED, NOT CLOSED (mantahostels#2778).
# scripts/lib/claimed-bash-write.js credits an uncontended Bash write target
# to the write ledger, which reaches the spellings its parser reads and no
# others; a destination no parser can resolve stays billed to nobody
# (mantahostels#296).
#
# OVER-DETECTION IS POSSIBLE ONCE: two session ids differing only in a character
# the sanitiser strips share one marker, so a neighbour's /implement lowers this
# session's floor (inject-tracker-docs.sh's residual (1)). Unobserved: the ids
# in this corpus are uuids.
#
# code_signal_floor <sid> — sets cs_threshold, and cs_implement to 1 where
# /implement ran, else empty.
code_signal_floor() {
  # shellcheck disable=SC2034  # the caller's to read
  cs_threshold="$CODE_THRESHOLD"
  cs_implement=""
  # shellcheck disable=SC2034  # both the caller's to read
  if [[ -f "${TMPDIR:-/tmp}/wfc-tracker-inject-${UID:-0}/${1//[^A-Za-z0-9_-]/_}.implement" ]]; then
    cs_implement=1
    cs_threshold="$IMPLEMENT_THRESHOLD"
  fi
}

# attributed_to <ledger file> — stdin's paths that the ledger holds, one a line
# (mantahostels#114).
#
# -F -x: whole line, literal. A substring match would let "docs/a.md" in the
# ledger claim credit for a parallel session's "docs/a.md.bak". Feed it from
# git with quotePath=false, or git renders a non-ASCII path as
# "docs/caf\303\251.md" while the ledger holds it raw, and the two never match.
# A path containing a literal quote or newline is still quoted and still misses.
attributed_to() { grep -Fxf "$1" - 2>/dev/null || true; }

# code_review_owed <base> <ledger file> <threshold> [<to>] — 0 where the code this
# session wrote changed by more than <threshold> lines since <base>, or where
# any path it wrote falls under a declared sensitive glob, else 1. Sets
# cs_files (up to NAMED_PATHS_MAX paths, space-separated), cs_churn, cs_tier
# (`standard` or `escalated`), cs_area_names (the matched areas' names, an
# array), cs_areas (the same, comma-separated) and cs_fault either way.
#
# A SENSITIVE GLOB OWES THE ESCALATED TIER IN ANY FILE TYPE, `.sql` included;
# CODE and <threshold> govern every other path (#1618). So a prose file under a
# glob can be billed on both signals at Stop, CODE's complement
# notwithstanding: the review and the concision pass each owe it. A matcher or
# jq that will not run reads as no match, the standard tier, under-detection
# being the safe direction above; cs_fault then says why, for the caller to log.
#
# <ledger file> holds the paths this session wrote, one a line (mantahostels#114): a
# changed path absent from it is a neighbour's and is not counted. <to> empty
# reads the WORKING TREE, untracked files counted whole; a commit reads that
# commit's tree, where nothing untracked is published.
#
# Runs against the repository in the current directory.
code_review_owed() {
  local base="$1" mine="$2" threshold="$3" to="${4:-}"
  local -a tracked_paths=() new_paths=()
  cs_files=""
  cs_churn=0
  mapfile -t tracked_paths < <(
    git -c core.quotePath=false diff --name-only "$base" ${to:+"$to"} -- "${CODE[@]}" 2>/dev/null |
      attributed_to "$mine"
  )
  # A brand-new file is untracked, so no diff carries it — count it whole.
  [[ -n "$to" ]] || mapfile -t new_paths < <(
    git -c core.quotePath=false ls-files --others --exclude-standard -- "${CODE[@]}" 2>/dev/null |
      attributed_to "$mine"
  )

  # Churn is added PLUS deleted lines, not net: a rewrite of the same length
  # is still a rewrite. A binary file reports "-" in --numstat, which awk
  # reads as 0 — it contributes nothing rather than aborting the sum.
  #
  # Guarded: `git diff $base --` with an empty pathspec list diffs the whole
  # tree, which would restore the misattribution the ledger removes.
  if [[ "${#tracked_paths[@]}" -gt 0 ]]; then
    cs_churn=$(git diff --numstat "$base" ${to:+"$to"} -- "${tracked_paths[@]}" 2>/dev/null |
      awk '{a += $1; d += $2} END {print a + d + 0}')
  fi
  if [[ "${#new_paths[@]}" -gt 0 ]]; then
    cs_churn=$((cs_churn + $(printf '%s\n' "${new_paths[@]}" |
      xargs -d'\n' -r cat 2>/dev/null | wc -l)))
  fi

  local -a sensitive=()
  cs_tier=standard
  cs_area_names=()
  cs_areas=""
  cs_fault=""
  sensitive_match sensitive "$base" "$mine" "$to"
  [[ "${#sensitive[@]}" -gt 0 ]] && cs_tier=escalated

  cs_files=$(
    printf '%s\n' "${sensitive[@]}" "${tracked_paths[@]}" "${new_paths[@]}" |
      grep -v '^$' | awk '!seen[$0]++' | head -"$NAMED_PATHS_MAX" | tr '\n' ' '
  )
  [[ "$cs_tier" = escalated ]] && return 0
  [[ -n "$cs_files" ]] && [[ "$cs_churn" -gt "$threshold" ]]
}

# written_paths <base> <ledger file> [<to>] — every path this session wrote
# that changed since <base>, one a line, any file type. <to> as
# code_review_owed's.
written_paths() {
  local base="$1" mine="$2" to="${3:-}"
  {
    git -c core.quotePath=false diff --name-only "$base" ${to:+"$to"} 2>/dev/null
    [[ -n "$to" ]] || git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null
  } | attributed_to "$mine"
}

# sensitive_match <array name> <base> <ledger file> [<to>] — fills the named
# array with the paths this session wrote that a declared glob matched, and
# sets cs_area_names, cs_areas and cs_fault. <to> as code_review_owed's.
sensitive_match() {
  local -n sm_paths="$1"
  local base="$2" mine="$3" to="${4:-}" written match
  written=$(written_paths "$base" "$mine" "$to")
  [[ -n "$written" ]] || return 0
  match=$(printf '%s\n' "$written" | node "$CS_MATCHER" --stdin 2>/dev/null) || {
    # shellcheck disable=SC2034  # the caller's to read
    cs_fault="lib/sensitive-paths.js failed — sensitive paths not checked, standard tier assumed"
    return 0
  }
  # First line the area count, then one area name a line, then one matched
  # path a line; nothing at `standard`.
  local filter='select(.tier == "escalated") | (.matched | length), .matched[].name, .matched[].paths[]'
  printf '%s' "$match" | jq -e . >/dev/null 2>&1 || {
    # shellcheck disable=SC2034  # the caller's to read
    cs_fault="jq could not read lib/sensitive-paths.js's output — sensitive paths not checked, standard tier assumed"
    return 0
  }
  local -a out=()
  mapfile -t out < <(printf '%s' "$match" | jq -r "$filter" 2>/dev/null)
  local n="${out[0]:-0}"
  [[ "${#out[@]}" -gt $((n + 1)) ]] || return 0
  cs_area_names=("${out[@]:1:n}")
  # shellcheck disable=SC2034  # a nameref: the caller's array
  sm_paths=("${out[@]:n+1}")
  # shellcheck disable=SC2034  # the caller's to read
  cs_areas="$(join_comma "${cs_area_names[@]}")"
}

# cs_log <line> — logs <line> where the caller loaded lib/guard-log.sh.
cs_log() { ! declare -F gl_log >/dev/null 2>&1 || gl_log "$1" 2>/dev/null; }

# own_commits_owed <base> <newer base> <ledger file> <sid> — code_review_owed
# at any size over <base>..<newer base>, billing only the ledger's paths that
# this session's own commits in that range touched, by lib/own-work.js's
# rule: a neighbour's commit there to a path the session also wrote is the
# neighbour's (#3099), and an unledgered one is the session's only where its
# patch matches one of the session's ledgered commits (#3108). Where the
# arbiter will not say, the whole ledger is billed, logged: a re-review is the
# cheaper error.
own_commits_owed() {
  local base="$1" newer="$2" mine="$3" sid="$4" own touched rc
  own="$(mktemp 2>/dev/null)" || {
    cs_log "could not make a temporary file — the whole ledger billed for the marker's newer base="
    code_review_owed "$base" "$mine" "$ANY_CHANGE" "$newer"
    return
  }
  if touched="$(node "$CS_ARBITER" own-paths "$base" "$newer" "$sid" 2>/dev/null)"; then
    printf '%s\n' "$touched" | attributed_to "$mine" >"$own"
  else
    cs_log "session-arbiter.js own-paths failed — the whole ledger billed for the marker's newer base="
    cp "$mine" "$own"
  fi
  code_review_owed "$base" "$own" "$ANY_CHANGE" "$newer"
  rc=$?
  rm -f "$own"
  return "$rc"
}

# review_uncovered <marker> <base> <ledger file> <threshold> <sid> [<to>] — 0 where
# code_review_owed says a review is owed and <marker> does not cover it, else 1.
# On an escalated change a marker pass_valid accepts covers it only where
# marker_tier_fault finds nothing (spec #1612 story 31). A marker whose base= is
# newer than <base>, as a staged review's HEAD is, covers it only where no
# commit of this session's between the two changed code or a sensitive path, at
# any size (#1745, #3099), and only where it names paths= (#1840). A marker
# naming paths= covers it only where this session changed no code and no
# sensitive path outside them since the marker's base=, at any size (#1769);
# one with no paths= line, no tree= line and a base= at or before <base>
# covers every path, and one with tree= and no paths= covers nothing (#1925).
# Sets code_review_owed's variables, cs_pass_fault (why an existing marker was
# rejected, else empty), cs_tier_line (the sentence naming the tier owed) and
# cs_marker_more (the sentence naming the marker lines an escalated change
# adds, else empty), and logs cs_fault.
review_uncovered() {
  local marker="$1" base="$2" mine="$3" threshold="$4" sid="$5" to="${6:-}" valid=1 rc newer_base unseen=""
  pass_valid "$marker" "$base"
  rc=$?
  # shellcheck disable=SC2154  # pass_valid's, in lib/concision-marker.sh
  cs_pass_fault="$pass_fault" newer_base="$pass_base"
  local whole_change_hint="one of the session's whole change sets base=$base, its start point, and names every path this session wrote in paths="
  # A staged review's tree= marks a review of one commit's paths, and its
  # base= is the start point on a session's first commit (#1925).
  if [[ "$rc" -eq 0 ]] && marker_has "$marker" tree && ! marker_has "$marker" paths; then
    cs_pass_fault="it has a tree= line and no paths= line, so it records a staged review and nothing bounds what it vouches for: a staged review names every path its diff named in paths=, and $whole_change_hint"
  elif [[ "$rc" -eq 0 ]]; then
    valid=0
  elif [[ "$rc" -eq 2 ]] && ! own_commits_owed "$base" "$newer_base" "$mine" "$sid"; then
    if marker_has "$marker" paths; then
      valid=0
      cs_pass_fault=""
    else
      cs_pass_fault="its base= is ahead of this session's start point and it has no paths= line, so nothing bounds what it vouches for: a review of only some paths names them in paths=, and $whole_change_hint"
    fi
  fi
  # A ledger of what this session wrote that the review never diffed, since
  # the marker's base=: before a newer one, only the session's own commits
  # count, and those were checked above. Where it cannot be built the marker
  # stands, logged (#1769).
  if [[ "$valid" -eq 0 ]] && marker_has "$marker" paths; then
    if ! unseen="$(mktemp 2>/dev/null)"; then
      cs_log "could not make a temporary file — the marker's paths= not checked"
    elif
      marker_unlisted "$marker" paths <"$mine" >"$unseen" 2>/dev/null
      [[ $? -eq 2 ]]
    then
      cs_log "could not filter the write ledger by the marker's paths= — not checked"
    elif code_review_owed "${newer_base:-$base}" "$unseen" "$ANY_CHANGE" "$to"; then
      valid=1
      cs_pass_fault="its paths= leaves out ${cs_files% }, which this session wrote and the review it records never saw: a review of them adds them to paths=, and $whole_change_hint"
    fi
    [[ -z "${unseen:-}" ]] || rm -f "$unseen"
  fi
  code_review_owed "$base" "$mine" "$threshold" "$to"
  rc=$?
  [[ -z "$cs_fault" ]] || cs_log "$cs_fault"
  [[ "$rc" -eq 0 ]] || return 1
  if [[ "$cs_tier" = escalated ]]; then
    # shellcheck disable=SC2034  # the caller's to read
    cs_tier_line="The \`escalated\` review tier is owed: this change touches declared sensitive paths (${cs_areas}), which owe it at any size and in any file type (#1618)."
    # shellcheck disable=SC2034  # the caller's to read
    cs_marker_more=" On this escalated change, record it with --tier escalated (or mission-critical) --areas '${cs_areas}' as well, or it counts as no review."
    if [[ "$valid" -eq 0 ]]; then
      cs_pass_fault="$(marker_tier_fault "$marker" "${cs_area_names[@]}")" ||
        cs_log "could not read the marker's areas= against the areas touched — not checked"
      [[ -n "$cs_pass_fault" ]] || return 1
    fi
    return 0
  fi
  # shellcheck disable=SC2034  # the caller's to read
  cs_tier_line="The \`standard\` review tier is owed."
  # shellcheck disable=SC2034  # the caller's to read
  cs_marker_more=""
  [[ "$valid" -ne 0 ]]
}
