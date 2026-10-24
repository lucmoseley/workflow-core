#!/usr/bin/env bash
# PreToolUse guard: session scratch does not go under $CLAUDE_JOB_DIR (mantahostels#2406,
# which took route (e) over buying pool bytes; mantahostels#2407, which found the pool was
# the wrong surface for this rule at all).
#
# WHY IT IS A GUARD AND NOT A LINE IN CLAUDE.md. The background-job preamble
# points every background session at `$CLAUDE_JOB_DIR/tmp`, and it is scoped to
# background jobs where a pool line countering it is general — so on
# `CLAUDE.md` §Ground truth's own first limb, "the more specific wins", the
# preamble won. That ranking opens with "a guard's deny text wins over any
# file", so moving the rule here settles the contest instead of trying to win it
# with qualifying bytes.
#
# ROUTE (e), NOT (f) (`docs/doc-map.md` §Capture and placement §3). The text is
# spliced into this guard's own warn through `gp_rule_text`, so it is retrieved at
# the moment it bites and costs neither the always-loaded pool nor route (f)'s
# union ratchet.
#
# WHAT IT JUDGES, two limbs and one predicate, then one split.
#
#   Bash    — a write by any spelling lib/guard-parse.sh's gp_write_targets
#             reads (workflow-core#1827) whose target resolves under the job directory.
#   Write   — the `file_path` (or NotebookEdit's `notebook_path`) itself, for
#   /Edit     the same predicate. The preamble hands every background job the
#             EXPANDED path, which is the spelling those tools can carry.
#
#   A write target is first resolved as the shell would land it (workflow-core#1030): its
#   `$VAR`s expanded from the command's own earlier assignments, then the
#   environment (`T=$CLAUDE_JOB_DIR/tmp; cat > $T/x`), and a relative result
#   joined to the directory a `cd` earlier in the command moved to
#   (`cd <job dir>/tmp && python3 - > x.py`).
#
#   A target is under the job directory when its text names `CLAUDE_JOB_DIR` at
#   all — the `$CLAUDE_JOB_DIR/tmp/x` spelling — or when the resolved path
#   sits under `$CLAUDE_JOB_DIR` as this process sees it, or under the
#   `<config>/jobs/<id>/` shape when that variable is unset. The third limb
#   exists because a hook's environment is the harness's to give, and a rule
#   that goes silent when one variable is missing is the fail-open the
#   doc-map's own placement test disqualifies.
#
#   THE SPLIT (workflow-core#1139): a target resolving to a file directly in `<job>/tmp/`,
#   no subfolder between, is REFUSED. Anything else under the job directory —
#   `<job>/tmp/<dir>/<file>`, or outside `tmp/` altogether — is WARNED. A command
#   holding one of each is refused.
#
# WHY A READ IS NOT A BREACH. `cat $CLAUDE_JOB_DIR/tasks/x.output` is how a
# session reads its own background job's output and is correct. Only a WRITE is
# read here, which is why the Bash limb walks write targets rather than the
# command string.
#
# WHY THE FLAT FOLDER IS REFUSED AND THE REST ONLY WARNED. The house order is
# warn first, deny once measured, as the sibling `guard-root-scratch.sh` went
# (mantahostels#2323, mantahostels#2436). workflow-core#1106 measured this one over seven days:
# 584 fires, 444 of them a file directly in `<job>/tmp/` — 438 genuine scratch,
# 6 a child session's prompt or output file. Every pick-next band artefact (67)
# and fixture-directory write (52) sat one folder deeper. So refusing the flat
# folder alone catches 438 of 459 breaches (95.4%) at a false-positive surface of
# 6 in 444 (1.4%), and the warn had not been stopping them: 81 of the 343 warned
# sessions wrote there again. A deeper write that must sit outside the repo has
# its escape in that subfolder shape, which the refusal names.
#
# THE WARN'S BOUND: ONE FULL WARNING PER (agent, session), THEN SILENCE — the shape
# mantahostels#2401 ruled for the sibling, on its own latch id. Terminal, not decaying.
#
# LIMITS
#  - A REFUSAL WHOSE STDOUT IS DISCARDED IS AN ALLOW, as at the sibling: a hook
#    cancelled at its 10 s ceiling lets the write land, unrefused and unreported.
#  - The Bash limb reads gp_write_targets' spellings and no others, so `dd of=`,
#    a heredoc body and a script that writes on the session's behalf are
#    unread, as at the sibling.
#  - A single-source `cp`/`mv` to `$CLAUDE_JOB_DIR/tmp` with no trailing `/` is
#    judged as a write to the folder itself, and warned rather than refused,
#    wherever the hook cannot see that folder on disk.
#  - Unread, so a target built on them is judged as written: a `pushd`, a `cd -`
#    or a `cd` to an unresolvable path (the directory becomes unknown), a `cd`
#    inside `{ … }` (the flattener does not scope braces), a variable from an
#    earlier Bash call or set by `export`/`read`/`for`, and every refusal of
#    lib/guard-parse.sh's gp_resolve_word (`$(…)`, `${VAR:-x}`, a name the
#    command assigns two different values or assigns after a `||`).
#  - It guards Claude Code's tools. A command run in a terminal sees no hook.
#  - A repo script writing its own job-dir path is COMPLIANT and is invisible
#    here by construction — it never appears in the session's own tool input
#    (`scripts/bg-run.sh`, `scripts/issue-body.js`). A path a skill hands its
#    subagents is not that: each subagent writes it through its own tool call,
#    which this hook sees (workflow-core#1140).
#

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

# shellcheck source=scripts/lib/guard-job-dir.sh
source "$here/lib/guard-job-dir.sh" 2>/dev/null
# Gated on both its names: a guard that cannot tell a job-dir path from any
# other would warn on everything or on nothing, and one that cannot place it in
# the tree would warn on every write it should refuse.
declare -F gjd_is_job_dir gjd_job_rel >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-job-dir.sh did not load — every write allowed unchecked"
  exit 0
}

# One alternation covers all three tool shapes, so the wiring needs no branch of
# its own; which limb runs is decided from `.tool_name` below.
gp_begin '.tool_input.command // .tool_input.file_path // .tool_input.notebook_path' \
  "write" "command or path"

TOOL="$(gp_payload_field '.tool_name')" || TOOL=""

# The offending target as the caller wrote it, which is what the verdict quotes:
# FLAT is the first file straight into the job's own `tmp/`, which is refused;
# STRAY the first other job-dir target, which is warned.
FLAT=""
FLAT_NAME=""
STRAY=""

JOB_DIR_STANDIN="/CLAUDE_JOB_DIR"

# Is $1, a job-dir path, a file directly in the job's `tmp/` — no subfolder
# between? Sets FLAT_NAME to the file's own name where it is.
is_flat() {
  local rel
  rel="$(gjd_job_rel "$1")" || return 1
  [[ "$rel" == tmp/?* && "${rel#tmp/}" != */* ]] || return 1
  FLAT_NAME="${rel#tmp/}"
}

# $1 a job-dir target as the verdict quotes it, $2 the path it resolved to.
classify_target() {
  if [[ -z "$FLAT" ]] && is_flat "$2"; then
    FLAT="$1"
  elif [[ -z "$STRAY" ]]; then
    STRAY="$1"
  fi
}

# One word the command writes, and its path as gp_write_targets resolved it.
# Where it will not resolve, the text `gp_literal` still yields is judged,
# which is all the first limb of gjd_is_job_dir needs.
consider_target() {
  local word="$1" path="$2" lit shown landed
  [[ -z "$FLAT" ]] || return 0
  lit="$(gp_literal "$word")" || :
  [[ -n "$lit" ]] || return 0
  [[ -n "$path" ]] || path="$lit"
  gjd_is_job_dir "$path" || return 0
  shown="$lit"
  landed="$path"
  [[ "$landed" == "$JOB_DIR_STANDIN"/* ]] && landed="\$CLAUDE_JOB_DIR${landed#"$JOB_DIR_STANDIN"}"
  [[ "$landed" == "$lit" ]] || shown+=" (lands at $landed)"
  classify_target "$shown" "$path"
  return 0
}

# One command the string runs, its writes read whatever word heads it, so a
# loop-wrapped redirect is seen. An `mv`'s source and a deletion take a file
# OUT of the job directory, so only a write is judged.
judge() {
  shift
  local i
  gp_write_targets "$@"
  for i in "${!_gp_wt_mode[@]}"; do
    [[ "${_gp_wt_mode[i]}" == write ]] && consider_target "${_gp_wt_target[i]}" "${_gp_wt_path[i]}"
  done
  return 0
}

if [[ "$TOOL" == "Bash" ]]; then
  # A hook whose environment lacks the variable would refuse every expansion
  # through it, `T=$CLAUDE_JOB_DIR/tmp; cat > $T/x` included. A stand-in path
  # keeps the name in the resolved text, where gjd_is_job_dir's first limb finds
  # it; unexported, so nothing this guard runs inherits it.
  [[ -n "${CLAUDE_JOB_DIR:-}" ]] || CLAUDE_JOB_DIR="$JOB_DIR_STANDIN"
  gp_walk_commands --bare-redirects judge
else
  # A file path is a whole target already; there is nothing to walk, only
  # `./` and `//` to fold, as the Bash limb's resolution does.
  subject="$(gp_subject)"
  path="$subject"
  [[ "$path" == /* ]] && path="$(gp_norm_abs "$path")"
  gjd_is_job_dir "$path" && classify_target "$subject" "$path"
fi

[[ -n "$FLAT$STRAY" ]] || gp_allow

# The rule is the store's; only the framing line is this guard's. An unreadable
# fragment is not a fail-open — the target is resolved and known bad, and an
# unreadable fragment is check-guard-registry.js's assertion, not this guard's.
SCRATCH_RULE_FALLBACK="Session scratch goes in .claude/tmp/, never under \$CLAUDE_JOB_DIR; the rule itself could not be read from docs/agents/rules/job-dir-scratch.txt. Read that file before doing anything else."

# NOT LATCHED, unlike the warn below: a latched deny would allow every stray
# after the first, which is why mantahostels#2436 dropped the sibling's latch.
if [[ -n "$FLAT" ]]; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$here/lib/guard-root.sh" 2>/dev/null
  sanctioned=".claude/tmp/$FLAT_NAME"
  if declare -F gr_root >/dev/null 2>&1; then
    sanctioned="$(gr_root)/$sanctioned"
  else
    gl_open "lib/guard-root.sh did not load — refusal names a repo-relative path"
  fi
  case "$TOOL" in
    Write) remedy="Same write, sanctioned path: $sanctioned" ;;
    # An edit needs the file to exist where it is aimed, so move it first.
    Edit | NotebookEdit) remedy="Move it to $sanctioned, then edit it there." ;;
    # The target alone: the command may write it by any spelling, not only `>`.
    *) remedy="Same command, sanctioned target: $sanctioned" ;;
  esac
  IFS= read -r -d '' refusal <<EOF || :
Refused: this writes a file straight into the job directory's own tmp folder — $FLAT

Session scratch goes in \`.claude/tmp/\`. $remedy

A fixture, or a child session's directory, that must sit outside the repo goes in a subfolder of its own under the job directory (\`<job dir>/tmp/<name>/<file>\`), which is warned once a session and never refused (workflow-core#1139).

$(gp_rule_text job-dir-scratch "$SCRATCH_RULE_FALLBACK")
EOF
  gp_deny "$refusal"
fi

IFS= read -r -d '' warning <<EOF || :
Warn only, nothing refused: this writes session scratch under the job directory — $STRAY

$(gp_rule_text job-dir-scratch "$SCRATCH_RULE_FALLBACK")
EOF

# EMIT, THEN LATCH. A hook cancelled at its 10 s ceiling has its stdout
# discarded, so marking first would leave a session latched and never told
# (mantahostels#2261). gp_warn exits, so it cannot be the emitting call with a
# mark after it.
if ! gp_rule_told job-dir-scratch; then
  gp_context "$warning" ||
    gl_open "the warning did not render — job-dir-scratch left unlatched"
  gp_rule_mark_told job-dir-scratch
fi

exit 0
