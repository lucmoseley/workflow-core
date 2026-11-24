#!/usr/bin/env bash

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

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 3
}

gh_issue_comment() {
  local issue="$1" body="$2"
  "$GH" issue comment "$issue" --body "$body"
}

takes_labels() {
  local issue="$1"
  "$GH" issue view "$issue" --json labels --jq \
    '.labels[].name | select(startswith("takes:"))' 2>/dev/null
}

write_blocked_record() {
  local issue="$1" label="$2"
  local dir
  dir="$(gr_markers_dir)"
  if [[ -z "$dir" ]]; then
    printf 'WARNING: blocked record not written (no markers directory).\n' >&2
    return 0
  fi
  local file="$dir/.parked-blocked-${SID:-unknown}"
  if ! node -e '
    const [file, issue, sid, label] = process.argv.slice(1);
    require("node:fs").writeFileSync(file, JSON.stringify({
      outcome: "blocked", issue: Number(issue), session: sid,
      ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), label,
    }));
  ' "$file" "$issue" "${SID:-}" "$label" 2>/dev/null; then
    printf 'WARNING: blocked record write failed: %s\n' "$file" >&2
  fi
}

release_issue_claim() {
  local issue="$1"
  node "$ARBITER" release-issue "$issue"
}

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
  # workflow-core#4535
  write_blocked_record "$issue" "$label"
  release_issue_claim "$issue" ||
    printf 'WARNING: could not release the issue claim on #%s.\n' "$issue" >&2
  if [[ -n "$label" ]]; then
    printf 'blocked: #%s labelled %s.\n' "$issue" "$label"
  else
    printf 'blocked: #%s commented, takes: left as it was.\n' "$issue"
  fi
  printf '%s\n' \
    "Before you end: wait for your own background work to report (workflow-core#1179 Q1 (A))." \
    "Read and act on each result as it lands, start no new work, end on" \
    "waiting: while anything is still out, and on result: only when nothing is." \
    "Stop a watcher whose subject has already reported."
}

# workflow-core#1020
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
    refuse "#${issue} has nothing the shortlist skips on: no open blocked-by edge, no open **Blocked on** issue, no holding **Gated until:** or **Gated on:** line. Write the gate, then rerun: for work an issue will do, node $SELF_DIR/link-blocker.js ${issue} <blocker> (the blocker as a bare number or owner/name#n — the build unit that does the work, never a spec or map), filing that issue unassigned first through node $SELF_DIR/file-issue.js where none exists; for an event no issue does, node $SELF_DIR/issue-body.js append ${issue} --text \"**Gated on:** <condition> — check: <command> — abandon if: <clause>\" with a **Gate basis:** line beneath it."
  fi
  [[ $status -eq 0 ]] || refuse "could not read #${issue}'s gate (exit ${status}, see above)."
}

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
    "takes:human with its Outside line keeps it: pass keep (workflow-core#1020)." \
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
