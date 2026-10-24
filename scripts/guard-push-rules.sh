#!/usr/bin/env bash
# PreToolUse guard: hand a session the push rules BEFORE it pushes (mantahostels#1648,
# spec mantahostels#1762).
#
# INJECTION ONLY — it never denies a push, and exits 2 on one fault alone: a
# fragment it cannot read. No guard enforces any of the four rules it carries:
# the push cadence is **Advisory** (mantahostels#244, mantahostels#1098; workflow-core#766), stated
# by this guard and observed at Stop by scripts/guard-unpushed-commits.js, the
# green-suite warning is **Advisory** (mantahostels#987; workflow-core#185), and the Vercel
# build and the CI lag are gotchas.
#
# IMPLICIT: on an ALLOWED `git push` it injects the push rules as
#   additionalContext and writes a `.rule-injected-*` latch file per rule under
#   .claude/tmp/markers; where the session's pushed code owes a review (lib/code-signal.sh's
#   floor, or a declared sensitive path) that no valid `.codereview-pass` marker covers, it prefixes a warn to run code-review first, latched once a session
#   (workflow-core#1163), again on an escalated change and on each rejected marker written.
# JUSTIFIED: fail-safe — the moment before the push is the only one at which
#   its rules can still shape it (mantahostels#1648, spec mantahostels#1762); and a
#   review asked for only at Stop lands every finding on code already on `main`
#   (workflow-core#1163). The latch keeps that from costing a session bytes on every push.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are said
#   again; deleting this registration from self-plugin/hooks/hooks.json silences both.

#
# THE IDS ARE NAMED, NOT REQUESTED WHOLESALE. Four clusters share this
# trigger, and gp_rule's emission ceiling is per call: a blanket request would
# spend the cap on whatever the store happened to hold. Priority order is
# push-cadence first — it carries the run-these-then-push recipe — then
# push-green-suite, which qualifies it, then vercel-build-on-push, which names
# the only gate that fires on a push at all, and ci-status-lag, which says why
# the suite verdict either side of it is not about this sha.
#
# NO ID IS PATH-SCOPED, deliberately. A push names refs, not paths: Vercel
# builds and deploys every push to `main` whatever it touched, and the CI lag is
# a property of the schedule rather than of the range. Each is scoped to the
# HOST instead (workflow-core#742).
#
# LIMITS
#  - It walks any working tree of THIS repo, a linked worktree included
#    (gp_walk_repo_git_strict, mantahostels#1213), because a push from a worktree pushes
#    the same `main` and the green-suite warning fires there too.
#  - A push whose tree it CANNOT RESOLVE — `git -C "$W" push` with W unset — is
#    handed the rules too (workflow-core#319).
#  - Such a push may go to ANOTHER repo and still spend the session's latch,
#    leaving the real push to `main` untold. Never traced; one traced would
#    reopen workflow-core#319's rejected no-latch option.
#  - It fires on `git push` alone. A push reached by another spelling — `git
#    -C <dir> push` is seen, `xargs git push`, `env`, `sudo` and a script that
#    pushes for you are not — states nothing, because only a segment's own
#    first word is read. Nor are `timeout 5 git push origin main` and `sh -c
#    "git push origin main"` (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
#    The `if` field below does not exec the guard on either (mantahostels#2127),
#    and the walker would not see past them if it did.
#  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward running) —
#    not exec'd unless some segment of the command leads with `git`.
#  - `git push --help` and `git push --dry-run` push nothing, so both are
#    filtered: the cadence recipe is a non-sequitur on them, and the latch would
#    spend the injection the real push at the end of the session needed. A ref
#    deletion (`--delete`, `origin :refs/heads/x`) IS a push and is not
#    filtered — it publishes to the shared remote.
#  - It FAILS OPEN, RECORDED (mantahostels#147), on anything else it cannot resolve:
#    the parser or the payload, a resolved tree git cannot answer for (the
#    walker's record), and gp_rule's own latch and rendering faults. A config
#    lib/test-gate.js refuses, or a missing node, withholds push-green-suite on
#    the record (workflow-core#758). The one exception is gp_rule's store side, which exits 2
#    on a fragment it cannot read (mantahostels#1762): a rule that cannot be
#    stated is worth a refused tool call.
#  - The rules are stated ONCE PER SESSION, by gp_rule's latch. So is the
#    review warn, on latches of its own, save that an escalated change and
#    each rejected marker written after a warn are warned again.
#    clear-rule-latch.sh clears those latches too at compaction, and each is
#    keyed per agent, so a subagent's push is warned afresh (workflow-core#1163).
#  - It guards the Bash tool. A push run outside Claude Code sees no hook.

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, gp_begin, never
# `source`'s exit status (mantahostels#157). lib/guard-log.sh is sourced first and
# separately so the parser's own absence is recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# Called once per `git push` running against a working tree of this repo, or
# one the walker could not resolve (workflow-core#319) — $3 is then empty, and the review
# warn reads the repo root instead. It judges nothing; it records that the
# trigger fired, and the emission happens once at the foot of the file so a
# command carrying two pushes is not told twice.
judge() {
  local arg tree="$3"
  shift 3
  for arg in "$@"; do
    case "$arg" in
      # -n is git push's own spelling of --dry-run.
      -h | --help | -n | --dry-run) return 0 ;;
    esac
  done
  rule_subject=1
  [[ -n "$push_tree" ]] || push_tree="$tree"
}

# Not local; see judge. push_tree is the first resolved tree pushed from.
rule_subject=0
push_tree=""

gp_walk_repo_git_strict judge "push" push

# 0 where the host runs the sweep ci-status-lag describes: the one workflow
# check-ci-status.js reads, on a schedule.
has_sweep() {
  grep -qE '^[[:space:]]*schedule:' \
    "$(gr_root)/.github/workflows/scheduled-checks.yml" 2>/dev/null
}

# 0 where lib/test-gate.js says the push owns the host's tests — the answer
# check-test-marker.js warns on, so the rule goes where the warning fires (workflow-core#758).
has_push_gated_tests() {
  local err rc
  err="$(node "$here/lib/test-gate.js" push 2>&1 >/dev/null)"
  rc=$?
  if ((rc >= 2)) && declare -F gl_log >/dev/null 2>&1; then
    gl_log "test-gate.js exit $rc, push-green-suite withheld" "$err"
  fi
  return "$rc"
}

deploys_vercel() {
  [[ "$(wfc_deploy 2>/dev/null)" == vercel ]]
}

((rule_subject)) || gp_allow

# --- the review warn (workflow-core#1163) ---
# THE PUSH IT RIDES ON STILL RUNS — a PreToolUse context refuses nothing — so
# the warn protects the pushes after it. The test is the Stop backstop's own,
# lib/code-signal.sh's review_uncovered, read over HEAD rather than the working
# tree because only committed code is pushed.
#
# A WARN, NEVER A REFUSAL (Q2 (C) rejected on workflow-core#1163): the advisory push cadence
# pushes early to share greens.
#
# Printed, the tier owed on the first line — followed by ` rejected` where an
# existing marker was rejected — and the warn after it, or nothing. A subshell,
# so its `cd` and sourced globals stay in it.
# SILENT to the session on every fault — no recorded start point, an
# unavailable ledger, a library that will not load — for the backstop's reason:
# the Stop nag still fires, so silence here costs only the earlier ask. The
# faults that are this guard's own are logged for check-guard-errors.js.
review_warning() (
  local sid markers_dir base mine
  sid="$(gp_payload_field '.session_id')"
  [[ -n "$sid" ]] || exit 0
  unloaded() {
    gl_log "lib/$1 did not load — push not checked for review"
    exit 0
  }
  # shellcheck source=scripts/lib/marker-root.sh
  source "$here/lib/marker-root.sh" 2>/dev/null || unloaded marker-root.sh
  # shellcheck source=scripts/lib/concision-marker.sh
  source "$here/lib/concision-marker.sh" 2>/dev/null || unloaded concision-marker.sh
  # shellcheck source=scripts/lib/code-signal.sh
  source "$here/lib/code-signal.sh" 2>/dev/null || unloaded code-signal.sh
  markers_dir="$(gr_markers_dir)"
  [[ -n "$markers_dir" ]] || exit 0
  cd "${push_tree:-$(gr_root)}" 2>/dev/null || {
    gl_log "could not enter the pushed tree — push not checked for review"
    exit 0
  }
  base="$(concision_session_base "$markers_dir" "$sid")" || exit 0
  mine="$(mktemp 2>/dev/null)" || {
    gl_log "mktemp failed — push not checked for review"
    exit 0
  }
  trap 'rm -f "$mine"' EXIT
  # Non-zero is ATTRIBUTION UNAVAILABLE, logged by the arbiter (mantahostels#135).
  # --committed bills the session's own commits too, the backstop's reason (workflow-core#2390).
  node "$here/session-arbiter.js" writes "$sid" --committed >"$mine" 2>/dev/null || exit 0
  [[ -s "$mine" ]] || exit 0
  code_signal_floor "$sid"
  review_uncovered "$markers_dir/.codereview-pass-$sid" "$base" "$mine" "$cs_threshold" HEAD || exit 0
  printf '%s%s\n' "$cs_tier" "${cs_pass_fault:+ rejected}"
  [[ -z "$cs_pass_fault" ]] ||
    printf 'The marker .claude/tmp/markers/.codereview-pass-%s was rejected — %s — so it counts as no review. ' "$sid" "$cs_pass_fault"
  printf 'This push carries code this session changed (%s) that no code review covers (workflow-core#1163). %s Run the code-review skill with fixed point %s now, before pushing again; its closing step runs node %s, which writes .claude/tmp/markers/.codereview-pass-%s.%s This warn is said once a session, once more if the change turns escalated, and again for each marker written after a warn that is rejected.' \
    "${cs_files% }" "$cs_tier_line" "$base" "$(gp_script_path write-review-marker.js)" "$sid" "$cs_marker_more"
)

# One latch a tier, so a change that turns escalated after a standard warn is
# warned again (workflow-core#1696). Beside them, the checksum of the marker the last warn
# saw, so a marker written since and rejected is warned of again, as the Stop
# nag does (workflow-core#1772, workflow-core#1840).
REVIEW_LATCH=push-review-warn
REVIEW_LATCH_ESCALATED=push-review-warn-escalated
review_sum_file="$(gp_latch_path sum.push-review-warn)" || {
  review_sum_file=""
  gl_log "no review-warn checksum latch — a rejected marker may go unwarned at push"
}
review_marker_sum="" latched_sum=""
review_sid="$(gp_payload_field '.session_id')"
if [[ -n "$review_sid" ]]; then
  review_marker_sum="$(cksum 2>/dev/null <"$(gr_markers_dir)/.codereview-pass-$review_sid")"
fi
[[ -n "$review_sum_file" ]] && latched_sum="$(cat "$review_sum_file" 2>/dev/null)"
marker_changed=""
[[ "$latched_sum" != "$review_marker_sum" ]] && marker_changed=1
told_escalated=""
gp_rule_told "$REVIEW_LATCH_ESCALATED" && told_escalated=1
if [[ -z "$told_escalated" || -n "$marker_changed" ]]; then
  review_msg="$(review_warning)"
  read -r review_tier review_rejected <<<"${review_msg%%$'\n'*}"
  review_msg="${review_msg#*$'\n'}"
  rearm=""
  [[ -n "$review_rejected" && -n "$marker_changed" ]] && rearm=1
  review_latch=""
  if [[ -n "$review_msg" && "$review_tier" == escalated ]]; then
    [[ -z "$told_escalated" || -n "$rearm" ]] && review_latch="$REVIEW_LATCH_ESCALATED"
  elif [[ -n "$review_msg" ]] && { [[ -n "$rearm" ]] || ! gp_rule_told "$REVIEW_LATCH"; }; then
    review_latch="$REVIEW_LATCH"
  fi
  if [[ -n "$review_latch" ]]; then
    gp_rule_prelude "$review_msg"
    gp_rule_latch_after "$review_latch"
    [[ -z "$review_sum_file" ]] ||
      printf '%s' "$review_marker_sum" >"$review_sum_file" 2>/dev/null ||
      gl_log "review-warn marker checksum unwritable — a rejected marker may go unwarned at push"
  fi
fi

# Each rule goes only to a host meeting its premise (workflow-core#742): the pre-push
# green-suite warning fires only where test-gate.js gives the push the suite,
# which needs `suites` on, Vercel builds only where the host declares it, and
# only the sweep makes the CI verdict lag the push. The gp_rule_module line
# restates that `suites` premise because rule-emission.js budgets off it.
# With `landing` on, a push goes to `landing` and the lander tests it, so each
# of the three texts naming the route is its `-landing` twin (workflow-core#2409), the
# CI-status-lag twin owing no sweep.
gp_rule_module suites push-green-suite push-green-suite-landing
gp_rule_module landing push-cadence-landing push-green-suite-landing ci-status-lag-landing
gp_rule_unless_module landing push-cadence push-green-suite ci-status-lag
has_push_gated_tests || gp_rule_skip push-green-suite push-green-suite-landing
deploys_vercel || gp_rule_skip vercel-build-on-push
has_sweep || gp_rule_skip ci-status-lag
gp_rule push-cadence push-cadence-landing push-green-suite push-green-suite-landing vercel-build-on-push ci-status-lag ci-status-lag-landing

gp_allow
