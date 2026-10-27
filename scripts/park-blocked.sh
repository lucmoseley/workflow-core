#!/usr/bin/env bash
# park-blocked.sh — parks a ticket blocked on the founder or on an
# outside party.
#
# Usage:
#   park-blocked.sh <issue> takes:wayfinder|waiting:external|keep "<why>"
#
# Apply the label, post the comment, release the issue claim, leave a local
# `.parked-blocked-<sid>` record, then print the wait-for-your-own-work step
# (#1179 Q1 (A)).
# A `takes:*` value REPLACES the issue's existing one; `waiting:external` is
# ADDED alongside it (blocked on an outside party, the
# command still applies once unblocked) — the two labels are different
# categories, not two spellings of one (docs/agents/triage-labels.md §`takes:`
# vs `waiting:`).
#
# `waiting:external` refuses unless something the shortlist skips on already
# holds the issue (lib/issue-hold.js): an open blocked-by edge, an open
# `**Blocked on**` issue, or a holding `**Gated until:**` or `**Gated on:**`
# line (#3263, #3293). The comment this script posts goes through a child
# `gh` the tracker-rules hook never sees, so this refusal is where the rule
# binds.
#
# `keep` (#1020) is the founder's errand already filed: it writes no label,
# and refuses unless the issue carries `takes:human` alone and a non-empty
# `**Outside Claude Code:**` line.
#
# THIS SCRIPT REFUSES `takes:human` ITSELF (#140).
# `scripts/guard-dispatch.js` (its `guard-issue-create-label` core) (mantahostels#3555) denies a
# `gh issue edit --add-label takes:human` on an issue whose body carries no
# `**Outside Claude Code:**` line — but it is a `PreToolUse` hook on the Bash
# TOOL CALL, so it sees the command this session types
# (`scripts/park-blocked.sh …`) and never a `gh` call this script shells
# out to underneath it, so the refusal has to live here.
#
# INJECTION POINT: WFC_GH (the `gh` binary).
#
# EXIT CODES: 0 parked; 2 usage error; 3 a precondition refused, changing
# nothing.

set -uo pipefail

GH="${WFC_GH:-gh}"
SELF_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SELF_DIR" == "${BASH_SOURCE[0]}" ]] && SELF_DIR=.
SELF_DIR="$(cd "$SELF_DIR" && pwd)"
ARBITER="$SELF_DIR/session-arbiter.js"

# shellcheck source=scripts/lib/marker-root.sh
source "$SELF_DIR/lib/marker-root.sh" 2>/dev/null || true
declare -F gr_markers_dir >/dev/null 2>&1 || gr_markers_dir() { :; }

SID="${CLAUDE_CODE_SESSION_ID:-}"

usage() {
  cat >&2 <<'EOF'
usage: park-blocked.sh <issue> takes:wayfinder|waiting:external|keep "<why>"
EOF
}

# --- small helpers -----------------------------------------------------------

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 3
}

# Repo-relative issue references need no owner/repo flag: `gh` resolves the
# current repo from cwd.
gh_issue_comment() {
  local issue="$1" body="$2"
  "$GH" issue comment "$issue" --body "$body"
}

# The issue's takes: labels, one per line.
takes_labels() {
  local issue="$1"
  "$GH" issue view "$issue" --json labels --jq \
    '.labels[].name | select(startswith("takes:"))' 2>/dev/null
}

# Writes/overwrites this session's local blocked record, which
# guard-session-ceiling.js reads without gh (#53). Every soft
# failure warns to stderr, same as apply_label_and_stop's other best-effort
# steps: a parked session whose record is MISSING hears the ceiling guard's
# wind-up text, not silence — a real residual.
write_blocked_record() {
  local issue="$1" label="$2"
  local dir
  dir="$(gr_markers_dir)"
  if [[ -z "$dir" ]]; then
    printf 'WARNING: blocked record not written (no markers directory).\n' >&2
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    printf 'WARNING: blocked record not written (no jq).\n' >&2
    return 0
  fi
  local file="$dir/.parked-blocked-${SID:-unknown}"
  if ! jq -n --arg issue "$issue" --arg label "$label" \
    --arg sid "${SID:-}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{outcome: "blocked", issue: ($issue | tonumber), session: $sid, ts: $ts, label: $label}' \
    >"$file" 2>/dev/null; then
    printf 'WARNING: blocked record write failed: %s\n' "$file" >&2
  fi
}

release_issue_claim() {
  local issue="$1"
  node "$ARBITER" release-issue "$issue"
}

# --- parking ------------------------------------------------------------------
#
# $1 = issue, $2 = label (a takes: value | waiting:external | "" for keep),
# $3 = why (comment body). An empty $2 comments, releases and records without
# touching a label at all.
apply_label_and_stop() {
  local issue="$1" label="$2" why="$3"
  if [[ -z "$label" ]]; then
    :
  elif [[ "$label" == takes:* ]]; then
    local old
    old="$(takes_labels "$issue")"
    local edit_args=(issue edit "$issue" --add-label "$label")
    local l
    while IFS= read -r l; do
      [[ -n "$l" && "$l" != "$label" ]] && edit_args+=(--remove-label "$l")
    done <<<"$old"
    "$GH" "${edit_args[@]}"
  else
    "$GH" issue edit "$issue" --add-label "$label"
  fi
  local label_status=$?
  if [[ -n "$label" && $label_status -ne 0 ]]; then
    printf 'WARNING: could not apply %s to #%s (exit %d).\n' \
      "$label" "$issue" "$label_status" >&2
  fi
  gh_issue_comment "$issue" "$why" ||
    printf 'WARNING: could not comment on #%s.\n' "$issue" >&2
  release_issue_claim "$issue" ||
    printf 'WARNING: could not release the issue claim on #%s.\n' "$issue" >&2
  write_blocked_record "$issue" "$label"
  if [[ -n "$label" ]]; then
    printf 'blocked: #%s labelled %s.\n' "$issue" "$label"
  else
    printf 'blocked: #%s commented, takes: left as it was.\n' "$issue"
  fi
  printf '%s\n' \
    "Before you end: wait for your own background work to report (#1179 Q1 (A))." \
    "Read and act on each result as it lands, start no new work, end on" \
    "waiting: while anything is still out, and on result: only when nothing is." \
    "Stop a watcher whose subject has already reported."
}

# An unreadable issue refuses too (exit 3).
#
# PRESENCE ONLY (#1020): the other three Outside-line limbs postdate errands
# still open, and keep must not strand one of those onto takes:wayfinder.
# Residual: check-issue-labels.js reports them.
check_keep() {
  local issue="$1" takes body status
  takes="$(takes_labels "$issue")" ||
    refuse "could not read #${issue}'s labels — keep needs them."
  if [[ "$takes" != "takes:human" ]]; then
    local carried="${takes//$'\n'/, }"
    refuse "keep is for an issue already labelled takes:human alone; #${issue} carries ${carried:-no takes: label}. Pass takes:wayfinder or waiting:external instead."
  fi
  body="$("$GH" issue view "$issue" --json body --jq .body 2>/dev/null)" ||
    refuse "could not read #${issue}'s body — keep needs its Outside line."
  printf '%s' "$body" | node -e '
      try {
        const { outsideLineFault } = require(process.argv[1]);
        const body = require("node:fs").readFileSync(0, "utf8");
        process.exit(outsideLineFault(body)?.fault === "NO-OUTSIDE-ACT" ? 1 : 0);
      } catch (e) {
        console.error(e.message);
        process.exit(2);
      }
    ' "$SELF_DIR/lib/takes-label.js"
  status=$?
  if [[ $status -eq 1 ]]; then
    refuse "#${issue} is labelled takes:human but its body names no act outside Claude Code. Add the line — node $SELF_DIR/issue-body.js append ${issue} --text \"**Outside Claude Code:** <the act, in plain words>\" — then rerun; or, if the founder decides inside Claude Code, pass takes:wayfinder."
  fi
  [[ $status -eq 0 ]] || refuse "could not run the Outside-line test on #${issue} (exit ${status}, see above)."
}

check_gate() {
  local issue="$1" body status
  body="$("$GH" issue view "$issue" --json body --jq .body 2>/dev/null)" ||
    refuse "could not read #${issue}'s body — waiting:external needs its gate."
  printf '%s' "$body" | node -e '
      const { readOwnHold } = require(process.argv[1]);
      const body = require("node:fs").readFileSync(0, "utf8");
      readOwnHold({ number: Number(process.argv[2]), body }).then(
        (h) => {
          if (!h.ok) console.error(`#${process.argv[2]}: ${h.what}; ${h.fix}`);
          process.exit(h.ok ? (h.held ? 0 : 1) : 2);
        },
        (e) => {
          console.error(e.message);
          process.exit(2);
        },
      );
    ' "$SELF_DIR/lib/issue-hold.js" "$issue"
  status=$?
  if [[ $status -eq 1 ]]; then
    printf '%s\n' "$("$SELF_DIR/lib/rule-text.sh" blocked-ticket-gate 2>/dev/null)" >&2
    refuse "#${issue} has nothing the shortlist skips on: no open blocked-by edge, no open **Blocked on** issue, no holding **Gated until:** or **Gated on:** line. Write the gate, then rerun: for work an issue will do, gh api --method POST repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by -F issue_id=<blocker-db-id> (gh api repos/{owner}/{repo}/issues/<n> --jq .id), filing that issue unassigned first through node $SELF_DIR/file-issue.js where none exists; for an event no issue does, node $SELF_DIR/issue-body.js append ${issue} --text \"**Gated on:** <condition> — check: <command> — abandon if: <clause>\" with a **Gate basis:** line beneath it."
  fi
  [[ $status -eq 0 ]] || refuse "could not read #${issue}'s gate (exit ${status}, see above)."
}

# --- argument parsing ----------------------------------------------------------

issue="${1:-}"
label="${2:-}"
why="${3:-}"
[[ "$issue" =~ ^[0-9]+$ ]] || {
  usage
  exit 2
}
if [[ "$label" == "takes:human" ]]; then
  printf '%s\n' \
    "refusing takes:human: blocked on the founder is takes:wayfinder — the founder" \
    "decides inside Claude Code, in a /wayfinder session, so nothing happens outside" \
    "it (mantahostels#3439). takes:human names a concrete act performed OUTSIDE" \
    "Claude Code, and this script cannot name one. An issue already labelled" \
    "takes:human with its Outside line keeps it: pass keep (#1020)." \
    "Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block." >&2
  exit 2
fi
[[ "$label" == "takes:wayfinder" || "$label" == "waiting:external" || "$label" == "keep" ]] || {
  printf 'usage: the label is takes:wayfinder, waiting:external or keep, got %q\n' "$label" >&2
  exit 2
}
[[ -n "$why" ]] || {
  printf 'usage: a reason is needed.\n' >&2
  exit 2
}

[[ -n "$SID" ]] || refuse "CLAUDE_CODE_SESSION_ID is empty — this script cannot tell whose claim this is."

if [[ "$label" == keep ]]; then
  check_keep "$issue"
  label=""
elif [[ "$label" == waiting:external ]]; then
  check_gate "$issue"
fi
apply_label_and_stop "$issue" "$label" "$why"
exit 0
