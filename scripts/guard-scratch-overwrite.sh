#!/usr/bin/env bash
# PreToolUse guard: the first `Write` over a `.claude/tmp/` file this session
# did not write is REFUSED, naming a session-suffixed name; the same call
# re-sent goes through (workflow-core#1167; refuse-once, workflow-core#1728).
#
# `.claude/tmp/` is out of file claims on purpose (`scripts/lib/arbiter-core.js`
# EXEMPT, mantahostels#2089, mantahostels#2103), so a `Write` over a neighbour's scratch is
# neither refused nor versioned — the overwritten bytes are gone.
#
# WHAT IT DOES. Every `Write` whose path sits under a `.claude/tmp/` segment is
# appended to this session's record. A `Write` to such a path that ALREADY
# EXISTS, is not on the record, and does not already carry this session's id
# prefix in its name is refused, once per path: the refusal has already put the
# path on the record, so the re-send passes.
#
# A REFUSAL, NOT A WARN (workflow-core#1717 Q2 (A), re-ruling workflow-core#1167 Q1 (A)): a warn rides the
# write it warns about, so the neighbour's bytes were gone before the session
# read it. It denies on an inference — an unrecorded file may be this session's
# own Bash-made one — which departs from the warn-on-inference default; the
# re-send is the escape.
#
# KEYED ON THE SESSION ALONE, not `(agent, session)` as gp_latch_path keys: a
# parent rewriting its own subagent's artefact is not a neighbour's clobber.
# Its own marker prefix, so `clear-rule-latch.sh` at PreCompact leaves it be and
# a compacted session is not refused on its own files.
#
# IMPLICIT:  appends every `.claude/tmp/` path a session `Write`s to that session's record in `.claude/tmp/markers/`, unasked (workflow-core#1167).
# JUSTIFIED: convenience — the record is what tells a session's own rewrite from a neighbour's clobber; without it every rewrite of an existing scratch file would be refused.
# DEFEAT:    none for the record itself; the refusal is escaped by re-sending the same call, by design (workflow-core#1728).
#
# LIMITS
#  - `Write` only. A Bash-route write (`>`, `tee`, a heredoc) is neither seen nor
#    recorded, so a file a session made through Bash and then `Write`s over is
#    refused once unless its name carries the session's id prefix. `Edit` is
#    unwired: it needs the old text matched, so it never replaces a file blind.
#  - Recorded at PreToolUse, so a `Write` another hook or the permission prompt
#    then refuses is on the record anyway.
#  - The record is swept once it is older than `arbiter-markers.js`'s
#    MARKER_AGE_MS and its session is no longer live.
#  - Fail-open, recorded (mantahostels#103 §6): a payload with no path or session id,
#    or a record that cannot be read or written, lets the write through silently.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every write allowed unchecked"
  exit 0
}
# shellcheck source=scripts/lib/review-suffix.sh
source "$here/lib/review-suffix.sh" 2>/dev/null
declare -F review_suffix >/dev/null 2>&1 ||
  gl_open "lib/review-suffix.sh did not load — a scratch write allowed unchecked"

gp_begin '.tool_input.file_path' write "file path"
target="$(gp_subject)"

[[ "$target" == *.claude/tmp/* ]] || gp_allow

if [[ "$target" != /* ]]; then
  cwd="$(gp_payload_field '.cwd')" || cwd=""
  target="${cwd:-$PWD}/$target"
fi
target="$(gp_norm_abs "$target")"
[[ "$target" == */.claude/tmp/* ]] || gp_allow

sid="$(gp_payload_field '.session_id')" || sid=""
[[ -n "$sid" ]] || gl_open "no session id — a scratch write allowed unrecorded"
suffix="$(review_suffix "$sid")"
sid="${sid//[^A-Za-z0-9_-]/_}"

markers="$(gr_markers_dir)"
[[ -n "$markers" ]] || gl_open "repo root unresolved — a scratch write allowed unrecorded"
record="$markers/.scratch-written-$sid"

ours=0
if [[ -e "$record" ]]; then
  grep -Fxq -- "$target" "$record" 2>/dev/null
  case $? in
    0) ours=1 ;;
    1) ;;
    *) gl_open "scratch record $record unreadable — a scratch write allowed unchecked" ;;
  esac
fi

((ours)) && gp_allow
printf '%s\n' "$target" >>"$record" 2>/dev/null ||
  gl_open "scratch record $record unwritable — a scratch write allowed unrecorded"

[[ -e "$target" ]] || gp_allow

# `<stem>-<sid8>.<ext>`, split at the LAST dot; a name with none, or whose only
# dot leads it, takes the suffix at its end. A name already in that form is
# this session's by construction.
name="${target##*/}"
stem="${name%.*}"
[[ "$name" == *.* && -n "$stem" ]] || stem="$name"
[[ "$stem" == *"$suffix" ]] && gp_allow
if [[ "$stem" != "$name" ]]; then
  suggested="$stem$suffix.${name##*.}"
else
  suggested="$name$suffix"
fi

gp_deny "Refused once: this \`Write\` replaces \`$target\`, which already exists and which this session has not written. \`.claude/tmp/\` takes no file claims and keeps no versions, so if a neighbour wrote it, its bytes would be gone for good. Write \`${target%/*}/$suggested\` instead — scratch names carry the session's first eight id characters so two sessions on one issue never pick the same one (\`docs/agents/rules/job-dir-scratch.txt\`). If you know the file is yours, re-send this same call: it goes through, and this path is not refused again this session."
